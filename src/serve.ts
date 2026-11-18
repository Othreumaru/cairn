import { createServer } from "node:http";
import { unwatchFile, watchFile } from "node:fs";
import { CairnError, Type } from "./ast.js";
import { nsId, State } from "./codebase.js";
import { Evaluator, Value } from "./eval.js";
import { short } from "./hash.js";
import { load } from "./store.js";

/**
 * HTTP serving of the `route` declarations in `live`.
 *
 * Requests are checked against the route's request type before any Cairn code runs, and responses
 * are projected onto the declared response type, so a value carrying extra fields (width subtyping)
 * never leaks them. Each request is evaluated against the namespace that was live when it started.
 */

export type HttpResult = { status: number; headers: Record<string, string>; body: unknown };

const FUEL = 200_000;

class BadRequest extends Error {}

/** JSON -> Cairn value, checked against `t`. Fields the type does not mention are dropped. */
function fromJson(j: unknown, t: Type, where: string): Value {
  switch (t.k) {
    case "number":
      if (typeof j !== "number" || !Number.isFinite(j)) throw new BadRequest(`${where} must be a number`);
      return j;
    case "string":
      if (typeof j !== "string") throw new BadRequest(`${where} must be a string`);
      return j;
    case "boolean":
      if (typeof j !== "boolean") throw new BadRequest(`${where} must be a boolean`);
      return j;
    case "record": {
      if (typeof j !== "object" || j === null || Array.isArray(j)) throw new BadRequest(`${where} must be an object`);
      const fields: Record<string, Value> = {};
      for (const [f, ft] of Object.entries(t.fields)) {
        if (!(f in j)) throw new BadRequest(`${where}.${f} is missing`);
        fields[f] = fromJson((j as Record<string, unknown>)[f], ft, `${where}.${f}`);
      }
      return { tag: "rec", fields: Object.freeze(fields) };
    }
    case "fn":
      throw new CairnError("internal: function type at the HTTP boundary");
  }
}

/** Cairn value -> JSON, keeping only what `t` declares. */
function toJson(v: Value, t: Type): unknown {
  if (t.k !== "record") return v;
  const rec = v as Extract<Value, { tag: "rec" }>;
  return Object.fromEntries(Object.entries(t.fields).map(([f, ft]) => [f, toJson(rec.fields[f], ft)]));
}

/** Match `/users/42` against `/users/:id`; returns the path parameters, or undefined. */
function match(pattern: string, path: string): Record<string, string> | undefined {
  const ps = pattern.split("/");
  const xs = path.split("/");
  if (ps.length !== xs.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < ps.length; i++) {
    if (ps[i].startsWith(":")) params[ps[i].slice(1)] = decodeURIComponent(xs[i]);
    else if (ps[i] !== xs[i]) return undefined;
  }
  return params;
}

/** Handle one request against the live namespace of `state`. Pure apart from reading `state`. */
export function handle(state: State, method: string, url: string, rawBody: string): HttpResult {
  const json = (status: number, body: unknown, ns?: string): HttpResult => ({
    status,
    headers: { "content-type": "application/json", ...(ns ? { "x-cairn-namespace": ns } : {}) },
    body,
  });
  const live = state.live;
  if (!live) return json(503, { error: "nothing is deployed yet" });
  const ns = `ns${short(nsId(live))}`;

  const u = new URL(url, "http://cairn");
  // When several routes match, the one with the fewest parameters wins: "/users/me" over "/users/:id".
  let found: { name: string; params: Record<string, string> } | undefined;
  for (const name of Object.keys(live).sort()) {
    const r = state.entries[live[name]].route;
    const params = r && r.method === method ? match(r.path, u.pathname) : undefined;
    if (params && (!found || Object.keys(params).length < Object.keys(found.params).length)) found = { name, params };
  }
  if (!found) return json(404, { error: `no route for ${method} ${u.pathname}` }, ns);

  const entry = state.entries[live[found.name]];
  if (entry.sig.k !== "fn" || entry.sig.params[0].k !== "record") throw new CairnError("internal: malformed route");
  const reqType = entry.sig.params[0];

  let req: Value;
  try {
    const raw: Record<string, unknown> = {};
    if ("params" in reqType.fields) raw.params = found.params;
    if ("query" in reqType.fields) raw.query = Object.fromEntries(u.searchParams);
    if ("body" in reqType.fields) {
      try {
        raw.body = rawBody ? JSON.parse(rawBody) : undefined;
      } catch {
        throw new BadRequest("body is not valid JSON");
      }
      if (raw.body === undefined) throw new BadRequest("body is missing");
    }
    req = fromJson(raw, reqType, "request");
  } catch (e) {
    if (e instanceof BadRequest) return json(400, { error: e.message.replace(/^request\./, "") }, ns);
    throw e;
  }

  try {
    const ev = new Evaluator((h) => state.entries[h], FUEL);
    const out = ev.apply(ev.global(live[found.name]), [req]);
    return json(200, toJson(out, entry.sig.ret), ns);
  } catch (e) {
    const msg = e instanceof RangeError ? "stack overflow (possible infinite recursion)" : e instanceof Error ? e.message : String(e);
    return json(500, { error: msg }, ns);
  }
}

/**
 * Serve `live` from the state file on `port`, and switch to a new `live` as soon as a deploy
 * rewrites the file (saves are atomic renames, so a read never sees a half-written state).
 */
export function serve(file: string, port: number, log: (line: string) => void = console.log) {
  let state = load(file);
  const label = (s: State) => (s.live ? `ns${short(nsId(s.live))}` : "(nothing deployed)");
  const reload = () => {
    let next: State;
    try {
      next = load(file);
    } catch {
      return; // mid-write on a filesystem without atomic rename; the next poll will see it
    }
    const before = label(state);
    state = next;
    if (label(next) !== before) log(`[:${port}] now serving ${label(next)} (was ${before})`);
  };
  watchFile(file, { interval: 50 }, reload);

  const server = createServer((req, res) => {
    const current = state; // the request runs against the namespace live when it started
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const r = handle(current, req.method ?? "GET", req.url ?? "/", body);
      res.writeHead(r.status, r.headers);
      res.end(JSON.stringify(r.body) + "\n");
    });
  });
  server.listen(port, () => log(`[:${port}] serving ${label(state)}`));
  return {
    server,
    close: () => {
      unwatchFile(file, reload);
      server.close();
    },
  };
}
