import { createHash } from "node:crypto";
import { createServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { CairnError } from "../ast.js";
import type { State } from "../codebase.js";
import { typeEq } from "../types.js";
import { CodecError, decode, encode, isData } from "./json.js";
import type { Bound, Plugin, Runtime } from "./types.js";

/**
 * `@ws("/chat") def chat(msg: In): Out = ...`
 *
 * Each JSON text message on the socket is checked against `In`, passed to the def, and the result,
 * projected onto `Out`, is sent back. A connection lives across deploys: messages go to the def
 * now live, as long as its message types are unchanged. When a deploy changes them (or removes
 * the binding), the connection is closed with 1012 "service restart" so the client reconnects
 * and gets the new types — the same reasoning as the 503 for requests waiting in an `Await`.
 */

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OP = { text: 0x1, close: 0x8, ping: 0x9, pong: 0xa } as const;

/** Encode one unmasked, unfragmented frame (server to client). */
export function frame(opcode: number, payload: Buffer): Buffer {
  const n = payload.length;
  let head: Buffer;
  if (n < 126) head = Buffer.from([0x80 | opcode, n]);
  else if (n < 65536) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(n, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(n), 2);
  }
  head[0] = 0x80 | opcode;
  return Buffer.concat([head, payload]);
}

export type Frame = { fin: boolean; opcode: number; masked: boolean; payload: Buffer };

/** Parse as many complete frames as `buf` holds; the rest stays buffered for the next chunk. */
export function parseFrames(buf: Buffer): { frames: Frame[]; rest: Buffer } {
  const frames: Frame[] = [];
  for (;;) {
    if (buf.length < 2) break;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < 4) break;
      len = buf.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (buf.length < 10) break;
      len = Number(buf.readBigUInt64BE(2));
      off = 10;
    }
    const start = off + (masked ? 4 : 0);
    if (buf.length < start + len) break;
    const payload = Buffer.from(buf.subarray(start, start + len));
    if (masked) for (let i = 0; i < len; i++) payload[i] ^= buf[off + (i % 4)];
    frames.push({ fin: (buf[0] & 0x80) !== 0, opcode: buf[0] & 0x0f, masked, payload });
    buf = buf.subarray(start + len);
  }
  return { frames, rest: buf };
}

type Conn = { socket: Duplex; path: string; sig: Bound["sig"]; buf: Buffer; open: boolean };
const conns = new Set<Conn>();

const pathOf = (b: Bound) => b.args[0] as string;
const boundAt = (rt: Runtime, state: State, path: string) => rt.bound(state, "ws").find((b) => pathOf(b) === path);

function close(c: Conn, code: number, reason: string) {
  if (!c.open) return;
  c.open = false;
  conns.delete(c);
  const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
  payload.writeUInt16BE(code, 0);
  payload.write(reason, 2);
  c.socket.end(frame(OP.close, payload));
}

const send = (c: Conn, value: unknown) => c.socket.write(frame(OP.text, Buffer.from(JSON.stringify(value))));

function onMessage(rt: Runtime, c: Conn, text: string) {
  const state = rt.state();
  const b = boundAt(rt, state, c.path);
  if (!b) return close(c, 1012, "this endpoint was removed by a deploy");
  if (!typeEq(b.sig, c.sig)) return close(c, 1012, "message types changed by a deploy; reconnect");
  let input;
  try {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new CodecError("message is not valid JSON");
    }
    input = decode(json, b.sig.params[0], "message");
  } catch (e) {
    if (e instanceof CodecError) return send(c, { error: e.message });
    throw e;
  }
  try {
    send(c, encode(rt.invoke(state, b.hash, input), b.sig.ret));
  } catch (e) {
    send(c, { error: e instanceof RangeError ? "stack overflow (possible infinite recursion)" : e instanceof Error ? e.message : String(e) });
  }
}

function upgrade(rt: Runtime, req: IncomingMessage, socket: Duplex) {
  const state = rt.state();
  const path = new URL(req.url ?? "/", "http://cairn").pathname;
  const b = boundAt(rt, state, path);
  const key = req.headers["sec-websocket-key"];
  if (!b || typeof key !== "string") {
    socket.end(`HTTP/1.1 ${b ? "400 Bad Request" : "404 Not Found"}\r\nConnection: close\r\n\r\n`);
    return;
  }
  const accept = createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\nX-Cairn-Namespace: ${rt.label(state)}\r\n\r\n`,
  );
  const c: Conn = { socket, path, sig: b.sig, buf: Buffer.alloc(0), open: true };
  conns.add(c);
  socket.on("data", (chunk: Buffer) => {
    const { frames, rest } = parseFrames(Buffer.concat([c.buf, chunk]));
    c.buf = rest;
    for (const f of frames) {
      if (!c.open) return;
      if (!f.masked) return close(c, 1002, "client frames must be masked");
      if (f.opcode === OP.close) return close(c, 1000, "");
      if (f.opcode === OP.ping) socket.write(frame(OP.pong, f.payload));
      else if (f.opcode === OP.text && f.fin) onMessage(rt, c, f.payload.toString("utf8"));
      else if (f.opcode !== OP.pong) return close(c, 1003, "only unfragmented text messages are supported");
    }
  });
  socket.on("close", () => {
    c.open = false;
    conns.delete(c);
  });
  socket.on("error", () => socket.destroy());
}

export const ws: Plugin = {
  name: "ws",
  version: 1,

  checkBinding(args, sig, at) {
    if (args.length !== 1 || typeof args[0] !== "string" || !args[0].startsWith("/")) throw new CairnError(`${at}: expected @ws("/path")`);
    at = `${at} @ws("${args[0]}")`;
    if (sig.params.length !== 1) throw new CairnError(`${at} must take exactly one parameter, the incoming message`);
    if (!isData(sig.params[0]) || !isData(sig.ret)) throw new CairnError(`${at}: messages cannot contain functions`);
  },

  checkAll(bound) {
    const owner = new Map<string, string>();
    for (const b of bound) {
      if (owner.has(pathOf(b))) throw new CairnError(`'${owner.get(pathOf(b))}' and '${b.name}' are both bound to @ws("${pathOf(b)}")`);
      owner.set(pathOf(b), b.name);
    }
  },

  start(rt, { port }) {
    const server = createServer((_req, res) => {
      res.writeHead(426, { "content-type": "application/json", upgrade: "websocket" });
      res.end(JSON.stringify({ error: "this port serves WebSockets" }) + "\n");
    });
    server.on("upgrade", (req, socket) => upgrade(rt, req, socket));
    server.listen(port, () => rt.log(`[ws :${port}] serving ${rt.label(rt.state()) ?? "(nothing deployed)"}`));
    return {
      stop: () => {
        for (const c of [...conns]) close(c, 1001, "server stopping");
        server.close();
      },
    };
  },

  // Close connections a deploy made incompatible right away, rather than on their next message.
  onLive(rt, _prev, next) {
    for (const c of [...conns]) {
      const b = boundAt(rt, next, c.path);
      if (!b) close(c, 1012, "this endpoint was removed by a deploy");
      else if (!typeEq(b.sig, c.sig)) close(c, 1012, "message types changed by a deploy; reconnect");
    }
  },
};
