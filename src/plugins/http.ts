import { createServer } from "node:http";
import { type BindingArg, CairnError, type Type } from "../ast.ts";
import type { State } from "../codebase.ts";
import type { Value } from "../eval.ts";
import { CodecError, decode, encode, isData } from "./json.ts";
import type { Bound, Plugin, Runtime } from "./types.ts";

/**
 * `@http("POST /quote") def quote(req: { body: { ... } }): Out = ...`
 *
 * The def takes one request record with optional `params` (path parameters), `query` and `body`,
 * and returns the response body. Requests are checked against the request type before any Cairn
 * code runs; responses are projected onto the response type.
 */

export type HttpResult = { status: number; headers: Record<string, string>; body: unknown };

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function parseSpec(args: BindingArg[], at: string) {
  const spec = args.length === 1 && typeof args[0] === "string" ? /^([A-Z]+) (\/\S*)$/.exec(args[0]) : null;
  if (!spec || !METHODS.has(spec[1])) throw new CairnError(`${at}: expected @http("METHOD /path") with one of ${[...METHODS].join(", ")}`);
  return { method: spec[1], path: spec[2] };
}

const pathParams = (path: string) => path.split("/").filter((seg) => seg.startsWith(":")).map((seg) => seg.slice(1));

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

/** Handle one request against `state`, the snapshot taken when the request arrived. */
export function handle(rt: Runtime, state: State, method: string, url: string, rawBody: string): HttpResult {
  const ns = rt.label(state);
  const json = (status: number, body: unknown): HttpResult => ({
    status,
    headers: { "content-type": "application/json", ...(ns ? { "x-cairn-namespace": ns } : {}) },
    body,
  });
  if (!ns) return json(503, { error: "nothing is deployed yet" });

  // When several routes match, the one with the fewest parameters wins: "/users/me" over "/users/:id".
  const u = new URL(url, "http://cairn");
  let found: { b: Bound; params: Record<string, string> } | undefined;
  for (const b of rt.bound(state, "http")) {
    const r = parseSpec(b.args, b.name);
    const params = r.method === method ? match(r.path, u.pathname) : undefined;
    if (params && (!found || Object.keys(params).length < Object.keys(found.params).length)) found = { b, params };
  }
  if (!found) return json(404, { error: `no route for ${method} ${u.pathname}` });

  const reqType = found.b.sig.params[0] as Extract<Type, { k: "record" }>;
  let req: Value;
  try {
    const raw: Record<string, unknown> = {};
    if ("params" in reqType.fields) raw.params = found.params;
    if ("query" in reqType.fields) raw.query = Object.fromEntries(u.searchParams);
    if ("body" in reqType.fields) {
      try {
        raw.body = rawBody ? JSON.parse(rawBody) : undefined;
      } catch {
        throw new CodecError("body is not valid JSON");
      }
      if (raw.body === undefined) throw new CodecError("body is missing");
    }
    req = decode(raw, reqType, "request");
  } catch (e) {
    if (e instanceof CodecError) return json(400, { error: e.message.replace(/^request\./, "") });
    throw e;
  }

  try {
    return json(200, encode(rt.invoke(state, found.b.hash, req), found.b.sig.ret));
  } catch (e) {
    const msg = e instanceof RangeError ? "stack overflow (possible infinite recursion)" : e instanceof Error ? e.message : String(e);
    return json(500, { error: msg });
  }
}

export const http: Plugin = {
  name: "http",
  version: 1,

  checkBinding(args, sig, at) {
    const route = parseSpec(args, at);
    at = `${at} @http("${route.method} ${route.path}")`;
    if (sig.params.length !== 1 || sig.params[0].k !== "record")
      throw new CairnError(`${at} must take exactly one parameter, a request record such as (req: { body: { ... } })`);
    const req = sig.params[0];
    for (const [f, t] of Object.entries(req.fields)) {
      if (f !== "params" && f !== "query" && f !== "body") throw new CairnError(`${at}: the request record may only have 'params', 'query' and 'body', not '${f}'`);
      if (!isData(t)) throw new CairnError(`${at}: '${f}' cannot contain functions`);
      if ((f === "params" || f === "query") && (t.k !== "record" || Object.values(t.fields).some((ft) => ft.k !== "string")))
        throw new CairnError(`${at}: '${f}' must be a record of strings`);
    }
    const declared = req.fields.params?.k === "record" ? Object.keys(req.fields.params.fields).sort() : [];
    const inPath = pathParams(route.path).sort();
    if (declared.join() !== inPath.join())
      throw new CairnError(`${at}: params { ${declared.join(", ")} } must match the path's :segments { ${inPath.join(", ")} }`);
    if (!isData(sig.ret)) throw new CairnError(`${at}: the response type cannot contain functions`);
  },

  checkAll(bound) {
    const owner = new Map<string, string>();
    for (const b of bound) {
      const r = parseSpec(b.args, b.name);
      const key = `${r.method} ${r.path}`;
      if (owner.has(key)) throw new CairnError(`'${owner.get(key)}' and '${b.name}' are both bound to @http("${key}")`);
      owner.set(key, b.name);
    }
  },

  start(rt, { port }) {
    const server = createServer((req, res) => {
      const state = rt.state(); // the request runs against the namespace live when it arrived
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const r = handle(rt, state, req.method ?? "GET", req.url ?? "/", body);
        res.writeHead(r.status, r.headers);
        res.end(JSON.stringify(r.body) + "\n");
      });
    });
    server.listen(port, () => rt.log(`[http :${port}] serving ${rt.label(rt.state()) ?? "(nothing deployed)"}`));
    return { stop: () => server.close() };
  },
};
