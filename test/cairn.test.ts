import { test } from "node:test";
import assert from "node:assert/strict";
import { CairnError, T } from "../src/ast.ts";
import { BUILTINS, type BuiltinVersion } from "../src/builtins.ts";
import { Checker } from "../src/check.ts";
import { emptyState, staleBuiltins, update, upgrade, rename, remove, view } from "../src/codebase.ts";
import { parseExpr, parseProgram } from "../src/parser.ts";
import { showDecl, showExpr } from "../src/pretty.ts";
import { deploy, evaluate, rollback, runTests } from "../src/runtime.ts";
import { parseConfig } from "../src/config.ts";
import { coverage } from "../src/coverage.ts";
import { mutants, mutation } from "../src/mutation.ts";
import { runtimeFor } from "../src/host.ts";
import { risks } from "../src/risks.ts";
import { handle } from "../src/plugins/http.ts";
import { frame, parseFrames, ws } from "../src/plugins/ws.ts";
import { subtype } from "../src/types.ts";

const synth = (src: string) => new Checker(() => undefined).synth(parseExpr(src), new Map());
const fresh = (src: string) => {
  const s = emptyState();
  const r = update(s, src);
  assert.ok(r.ok, JSON.stringify(r.fileErrors));
  return s;
};

// ---------------- parser / printer ----------------

test("pretty-printer round-trips through the parser", () => {
  for (const src of ["(a + b) * c", "a - (b - c)", "f(x => x * 2, { a: 1, ...r })", "if a then b else c", "let x = 1 in x + 1", "-(a + b)", "(x => x)(3)"]) {
    const once = showExpr(parseExpr(src));
    assert.equal(showExpr(parseExpr(once)), once, src);
  }
});

test("showDecl re-sugars function definitions", () => {
  const [d] = parseProgram("def f(a: number, b: { x: string }): number = a");
  assert.equal(showDecl(d), "def f(a: number, b: { x: string }): number = a");
});

// ---------------- types ----------------

test("width and depth subtyping on records", () => {
  const point3 = T.record({ x: T.number, y: T.number, z: T.number });
  const point2 = T.record({ x: T.number, y: T.number });
  assert.ok(subtype(point3, point2));
  assert.ok(!subtype(point2, point3));
  assert.ok(subtype(T.record({ p: point3 }), T.record({ p: point2 })));
});

test("functions are contravariant in params, covariant in result", () => {
  const p2 = T.record({ x: T.number, y: T.number });
  const p1 = T.record({ x: T.number });
  assert.ok(subtype(T.fn([p1], p2), T.fn([p2], p1)));
  assert.ok(!subtype(T.fn([p2], p1), T.fn([p1], p2)));
});

test("lambda parameters need annotations in synth mode", () => {
  assert.throws(() => synth("x => x + 1"), /cannot infer the type of parameter 'x'/);
  assert.equal(synth("(x: number) => x + 1").k, "fn");
});

test("contextual typing flows expected types into lambdas", () => {
  const s = fresh(`
    def apply(f: (n: number) => number, x: number): number = f(x)
    test t = apply(x => x * 2, 21) == 42`);
  assert.ok(deploy(s).accepted);
});

test("if without expected type uses the least upper bound", () => {
  const t = synth('if true then { a: 1, b: "x" } else { a: 2, c: true }');
  assert.deepEqual(t, T.record({ a: T.number }));
});

test("record literal missing a required field is rejected with a precise message", () => {
  const s = emptyState();
  const r = update(s, `def f(o: { a: number, b: number }): number = o.a
    test t = f({ a: 1 }) == 1`);
  assert.equal(r.ok, false);
  assert.match(r.fileErrors[0].error, /missing field\(s\) 'b'/);
});

// ---------------- hashing ----------------

test("renaming locals, reformatting and reordering record fields keep hashes stable", () => {
  const s = fresh(`def f(o: { a: number, b: number }): number = let t = o.a + o.b in t * 2
                   test t1 = f({ a: 1, b: 2 }) == 6`);
  const r = update(s, `def f(rec: { b: number, a: number }): number =
                         let total = rec.a + rec.b
                         in total * 2
                       test t1 = f({ b: 2, a: 1 }) == 6`);
  assert.ok(r.changes.every((c) => c.kind.k === "unchanged"), JSON.stringify(r.changes.map((c) => c.kind.k)));
});

test("mutually recursive definitions are hashed as a group and evaluate", () => {
  const s = fresh(`
    partial def ev(n: number): boolean = if n == 0 then true else od(n - 1)
    partial def od(n: number): boolean = if n == 0 then false else ev(n - 1)
    test p = ev(10) && od(3)`);
  const e1 = s.entries[s.dev.ev];
  const e2 = s.entries[s.dev.od];
  assert.ok(e1.group && e2.group && e1.group.hash === e2.group.hash);
  assert.ok(deploy(s).accepted);
});

test("editing one member of a cycle rehashes its peer", () => {
  const s = fresh(`
    partial def ev(n: number): boolean = if n == 0 then true else od(n - 1)
    partial def od(n: number): boolean = if n == 0 then false else ev(n - 1)`);
  const before = s.dev.od;
  const r = update(s, `partial def ev(n: number): boolean = if n <= 0 then true else od(n - 1)`);
  assert.ok(r.ok);
  assert.notEqual(s.dev.od, before);
  assert.equal(evaluate(s, "ev(4)", "dev").value, "true");
});

test("rename is free: hash unchanged and dependents render with the new name", () => {
  const s = fresh(`def a(x: number): number = x + 1
                   def b(x: number): number = a(x) * 2`);
  const h = s.dev.a;
  rename(s, "a", "inc");
  assert.equal(s.dev.inc, h);
  assert.equal(view(s, s.dev, "b"), "def b(x: number): number = inc(x) * 2");
});

test("restored local names never capture a renamed global", () => {
  const s = fresh(`def g(x: number): number = x
                   def f(y: number): number = g(y)`);
  rename(s, "g", "y");
  assert.equal(view(s, s.dev, "f"), "def f(y_0: number): number = y(y_0)");
});

// ---------------- impact analysis ----------------

test("an edit propagates to transitive dependents only", () => {
  const s = fresh(`
    def a(x: number): number = x + 1
    def b(x: number): number = a(x) * 2
    def c(x: number): number = x - 1
    test tb = b(1) == 4
    test tc = c(1) == 0`);
  assert.ok(deploy(s).accepted); // populates the test cache
  const r = update(s, `def a(x: number): number = x + 2`);
  const byName = Object.fromEntries(r.changes.map((c) => [c.name, c.kind.k]));
  assert.deepEqual(byName, { a: "modified", b: "propagated", tb: "propagated" });
  assert.deepEqual(r.testsToRun, ["tb"]);
  assert.deepEqual(r.testsCached, ["tc"]);
});

test("an incompatible type change is rejected and names every broken dependent", () => {
  const s = fresh(`
    def a(x: number): number = x + 1
    def b(x: number): number = a(x) * 2
    def c(s: string): number = len(s)`);
  const before = { ...s.dev };
  const r = update(s, `def a(x: string): number = len(x)`);
  assert.equal(r.ok, false);
  assert.deepEqual(
    r.changes.filter((c) => c.kind.k === "broken").map((c) => c.name),
    ["b"],
  );
  assert.deepEqual(s.dev, before, "nothing applied");
});

test("a compatible type change (new <: old) is classified as such and dependents still check", () => {
  const s = fresh(`
    def f(o: { a: number, b: number }): number = o.a
    def g(o: { a: number, b: number }): number = f(o) + 1`);
  const r = update(s, `def f(o: { a: number }): number = o.a`);
  assert.ok(r.ok);
  const f = r.changes.find((c) => c.name === "f")!;
  assert.equal(f.kind.k, "modified");
  assert.equal((f.kind as { typeChange: string }).typeChange, "compatible");
});

test("delete is refused while something depends on the name", () => {
  const s = fresh(`def a(x: number): number = x
                   def b(x: number): number = a(x)`);
  assert.throws(() => remove(s, "a"), /still used by b/);
  remove(s, "b");
  remove(s, "a");
  assert.deepEqual(s.dev, {});
});

// ---------------- runtime / deploy gate ----------------

test("deploy gate: failing test rejects, live keeps serving the old code", () => {
  const s = fresh(`def fee(x: number): number = x * 0.01
                   test t = fee(100) == 1`);
  assert.ok(deploy(s).accepted);
  update(s, `def fee(x: number): number = x * 0.1`);
  const r = deploy(s);
  assert.equal(r.accepted, false);
  assert.equal(evaluate(s, "fee(100)").value, "1");
  assert.equal(evaluate(s, "fee(100)", "dev").value, "10");
});

test("only affected tests run; reverting to known code is fully cached", () => {
  const s = fresh(`
    def a(x: number): number = x + 1
    def c(x: number): number = x - 1
    test ta = a(1) == 2
    test tc = c(1) == 0`);
  deploy(s);
  update(s, `def a(x: number): number = 1 + x`);
  const r = deploy(s);
  assert.deepEqual(
    r.runs.filter((x) => !x.cached).map((x) => x.name),
    ["ta"],
  );
  update(s, `def a(x: number): number = x + 1`);
  const back = deploy(s);
  assert.ok(back.accepted);
  assert.ok(back.runs.every((x) => x.cached));
});

test("non-terminating tests fail the gate instead of hanging it", () => {
  const s = fresh(`partial def loop(n: number): number = loop(n + 1)
                   test t = loop(0) == 0`);
  const r = deploy(s);
  assert.equal(r.accepted, false);
  assert.match(r.runs[0].result.detail, /overflow|budget/);
});

test("rollback restores the previous live namespace", () => {
  const s = fresh(`def v: number = 1`);
  deploy(s);
  update(s, `def v: number = 2`);
  deploy(s);
  assert.equal(evaluate(s, "v").value, "2");
  rollback(s);
  assert.equal(evaluate(s, "v").value, "1");
  assert.throws(() => rollback(s), CairnError);
});

test("tests run when code is staged, so deploy only reads the cache", () => {
  const s = fresh(`def a(x: number): number = x + 1
                   def c(x: number): number = x - 1
                   test ta = a(1) == 2
                   test tc = c(1) == 0`);
  assert.ok(deploy(s).accepted);
  const prev = { ...s.dev };
  update(s, `def a(x: number): number = 1 + x`);
  const ran = runTests(s, s.dev, prev, new Set(["a", "ta"])).filter((r) => !r.cached);
  assert.deepEqual(
    ran.map((r) => [r.name, r.why]),
    [["ta", ["ta", "a"]]],
  );
  const d = deploy(s);
  assert.ok(d.accepted);
  assert.ok(d.runs.every((r) => r.cached), "nothing left to run at deploy time");
});

test("a test failing at staging time is still staged, and deploy refuses without re-running it", () => {
  const s = fresh(`def fee(x: number): number = x * 0.01
                   test t = fee(100) == 1`);
  assert.ok(deploy(s).accepted);
  const prev = { ...s.dev };
  const r = update(s, `def fee(x: number): number = x * 0.1`);
  assert.ok(r.applied);
  const [run] = runTests(s, s.dev, prev, new Set(["fee", "t"]));
  assert.equal(run.result.passed, false);
  const d = deploy(s);
  assert.equal(d.accepted, false);
  assert.ok(d.runs.every((x) => x.cached));
  assert.equal(evaluate(s, "fee(100)").value, "1", "live unchanged");
});

// ---------------- versioned builtins ----------------

/** Publish a new version of a builtin for the duration of `fn`. */
function withNewBuiltin(name: string, next: Partial<BuiltinVersion>, fn: () => void) {
  const b = BUILTINS[name];
  const prev = b.current;
  b.versions[prev + 1] = { ...b.versions[prev], ...next };
  b.current = prev + 1;
  try {
    fn();
  } finally {
    b.current = prev;
    delete b.versions[prev + 1];
  }
}
const floor2 = (n: number) => Math.floor(n * 100) / 100;

test("a builtin's version is part of the hash of code that uses it", () => {
  const src = `def r(x: number): number = round2(x)
               def p(x: number): number = x + 1`;
  const s1 = fresh(src);
  withNewBuiltin("round2", { impl: floor2 }, () => {
    const s2 = fresh(src);
    assert.notEqual(s2.dev.r, s1.dev.r);
    assert.equal(s2.dev.p, s1.dev.p);
  });
});

test("a new builtin version does not change stored code until it is upgraded", () => {
  const s = fresh(`def r(x: number): number = round2(x)
                   test t = r(1.236) == 1.24`);
  assert.ok(deploy(s).accepted);
  withNewBuiltin("round2", { impl: floor2 }, () => {
    assert.equal(evaluate(s, "r(1.236)").value, "1.24", "stored code keeps running round2@1");
    assert.equal(evaluate(s, "round2(1.236)").value, "1.23", "new code gets round2@2");
    assert.deepEqual(staleBuiltins(s.entries[s.dev.r]), ["round2@1→2"]);
  });
});

test("upgrade rehashes stale code and its dependents, so exactly the affected tests run", () => {
  const s = fresh(`
    def r(x: number): number = round2(x)
    def wrap(x: number): number = r(x) + 0
    def plain(x: number): number = x + 1
    test tr = wrap(1.236) == 1.24
    test tp = plain(1) == 2`);
  assert.ok(deploy(s).accepted);
  withNewBuiltin("round2", { impl: floor2 }, () => {
    const u = upgrade(s);
    assert.ok(u.ok);
    const byName = Object.fromEntries(u.changes.map((c) => [c.name, c.kind]));
    assert.deepEqual(byName.r, { k: "upgraded", builtins: ["round2@1→2"] });
    assert.deepEqual(byName.wrap, { k: "propagated", via: ["wrap", "r"] });
    assert.deepEqual(u.testsToRun, ["tr"]);
    assert.deepEqual(u.testsCached, ["tp"]);
    const d = deploy(s);
    assert.deepEqual(
      d.runs.filter((x) => !x.cached).map((x) => x.name),
      ["tr"],
    );
    assert.equal(d.accepted, false, "the behaviour change is caught by the gate");
    assert.equal(evaluate(s, "wrap(1.236)").value, "1.24", "live still serves round2@1");
  });
});

test("rehashing a dependent for an unrelated edit keeps its pinned builtin version", () => {
  const s = fresh(`def k(x: number): number = x
                   def u(x: number): number = round2(k(x))`);
  withNewBuiltin("round2", { impl: floor2 }, () => {
    const r = update(s, `def k(x: number): number = x + 0`);
    assert.ok(r.ok);
    assert.equal(r.changes.find((c) => c.name === "u")!.kind.k, "propagated");
    assert.deepEqual(staleBuiltins(s.entries[s.dev.u]), ["round2@1→2"]);
    assert.equal(evaluate(s, "u(1.236)", "dev").value, "1.24");
  });
});

test("upgrade is rejected when a new builtin type breaks a caller", () => {
  const s = fresh(`def r(x: number): number = round2(x)`);
  const before = { ...s.dev };
  withNewBuiltin("round2", { type: T.fn([T.string], T.number) }, () => {
    const u = upgrade(s);
    assert.equal(u.ok, false);
    assert.deepEqual(
      u.fileErrors.map((e) => e.name),
      ["r"],
    );
    assert.deepEqual(s.dev, before, "nothing applied");
  });
});

// ---------------- plugins: http ----------------

const api = () => {
  const s = fresh(`
    def account(id: string): { id: string, name: string, secret: string } = { id: id, name: "Ada", secret: "x" }
    @http("GET /accounts/:id") def getAccount(req: { params: { id: string } }): { id: string, name: string } = account(req.params.id)
    @http("POST /double") def double(req: { body: { n: number } }): { n: number } = { n: req.body.n * 2 }
    @http("GET /search") def search(req: { query: { q: string } }): { q: string } = { q: req.query.q }
    partial def loop(n: number): number = loop(n + 1)
    @http("GET /loop") partial def spin(req: {}): number = loop(0)
    test doubles = double({ body: { n: 2 } }).n == 4`);
  assert.ok(deploy(s).accepted);
  return s;
};
const quiet = () => {};
const httpCall = (s: ReturnType<typeof emptyState>, m: string, u: string, b = "") => handle(runtimeFor(() => s, quiet), s, m, u, b);

test("a binding is part of the hash, pins the plugin version, and the bound def stays callable from tests", () => {
  const s = api();
  const before = s.dev.double;
  assert.equal(s.entries[before].binding?.version, 1);
  update(s, `@http("PUT /double") def double(req: { body: { n: number } }): { n: number } = { n: req.body.n * 2 }`);
  assert.notEqual(s.dev.double, before);
  assert.equal(view(s, s.dev, "double"), '@http("PUT /double") def double(req: { body: { n: number } }): { n: number } = { n: req.body.n * 2 }');
});

test("bindings are checked by their plugin at update time", () => {
  const bad = (src: string, msg: RegExp) => assert.throws(() => update(emptyState(), src), msg);
  bad(`@http("GET /a/:id") def a(req: { params: { name: string } }): number = 1`, /must match the path's :segments/);
  bad(`@http("GET /a") def a(req: { headers: { x: string } }): number = 1`, /only have 'params', 'query' and 'body'/);
  bad(`@http("GET /a") def a(req: { query: { n: number } }): number = 1`, /'query' must be a record of strings/);
  bad(`@http("GET /a") def a(req: {}): (x: number) => number = x => x`, /cannot contain functions/);
  bad(`@http("FETCH /a") def a(req: {}): number = 1`, /expected @http\("METHOD \/path"\)/);
  bad(`@http("GET /a") def a(req: {}): number = 1
       @http("GET /a") def b(req: {}): number = 2`, /both bound to @http\("GET \/a"\)/);
  bad(`@smtp("x") def a(req: {}): number = 1`, /unknown plugin '@smtp'/);
  bad(`@ws("/a") def a(x: number, y: number): number = x`, /exactly one parameter/);
  assert.throws(() => parseProgram(`@http("GET /a") test t = true`), /must be followed by a def/);
});

test("http: params, query, body, response projection and the namespace header", () => {
  const s = api();
  const acc = httpCall(s, "GET", "/accounts/7");
  assert.equal(acc.status, 200);
  assert.deepEqual(acc.body, { id: "7", name: "Ada" }, "the undeclared 'secret' field is not sent");
  assert.match(acc.headers["x-cairn-namespace"], /^ns#[0-9a-f]{8}$/);
  assert.deepEqual(httpCall(s, "POST", "/double", '{"n": 21}').body, { n: 42 });
  assert.deepEqual(httpCall(s, "GET", "/search?q=cairn&extra=1").body, { q: "cairn" });
  update(s, `@http("GET /accounts/me") def me(req: {}): { id: string } = { id: "me" }`);
  assert.ok(deploy(s).accepted);
  assert.deepEqual(httpCall(s, "GET", "/accounts/me").body, { id: "me" }, "a literal segment wins over :id");
  assert.deepEqual(httpCall(s, "GET", "/accounts/7").body, { id: "7", name: "Ada" });
});

test("http: bad requests are rejected before any Cairn code runs, and runaway routes give 500", () => {
  const s = api();
  const r = (m: string, u: string, b = "") => {
    const x = httpCall(s, m, u, b);
    return [x.status, (x.body as { error?: string }).error];
  };
  assert.deepEqual(r("POST", "/double", '{"n": "2"}'), [400, "body.n must be a number"]);
  assert.deepEqual(r("POST", "/double", "{"), [400, "body is not valid JSON"]);
  assert.deepEqual(r("POST", "/double"), [400, "body is missing"]);
  assert.deepEqual(r("GET", "/search"), [400, "query.q is missing"]);
  assert.deepEqual(r("GET", "/nope"), [404, "no route for GET /nope"]);
  assert.equal(r("GET", "/loop")[0], 500);
  assert.equal(httpCall(emptyState(), "GET", "/").status, 503);
});

// ---------------- plugins: ws ----------------

test("ws frames round-trip, including the 16-bit length form and client masking", () => {
  for (const text of ["hi", "x".repeat(300)]) {
    const payload = Buffer.from(text);
    const mask = Buffer.from([1, 2, 3, 4]);
    const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
    const plain = frame(0x1, payload);
    const fromClient = Buffer.concat([plain.subarray(0, plain.length - payload.length), mask, masked]);
    fromClient[1] |= 0x80;
    const { frames, rest } = parseFrames(Buffer.concat([fromClient, Buffer.from([0x81])]));
    assert.equal(frames.length, 1);
    assert.equal(frames[0].payload.toString(), text);
    assert.equal(rest.length, 1, "an incomplete frame stays buffered");
  }
});

test("ws: a connection survives a deploy that keeps its message types, and is closed when they change", async () => {
  const s = fresh(`@ws("/greet") def greet(msg: { name: string }): { text: string } = { text: "hello " ++ msg.name }`);
  assert.ok(deploy(s).accepted);
  const rt = runtimeFor(() => s, quiet);
  const port = 40000 + Math.floor(Math.random() * 20000);
  const server = ws.start!(rt, { port });
  try {
    const sock = new WebSocket(`ws://localhost:${port}/greet`);
    const replies: unknown[] = [];
    let waiting: ((v: unknown) => void) | undefined;
    sock.onmessage = (e) => (waiting ? (waiting(JSON.parse(e.data)), (waiting = undefined)) : replies.push(JSON.parse(e.data)));
    const ask = (msg: string) => new Promise((res) => ((waiting = res), sock.send(msg)));
    await new Promise((res, rej) => ((sock.onopen = res), (sock.onerror = rej)));

    assert.deepEqual(await ask('{"name": "ada"}'), { text: "hello ada" });
    assert.deepEqual(await ask('{"name": 1}'), { error: "message.name must be a string" });
    assert.deepEqual(await ask("nope"), { error: "message is not valid JSON" });

    // Same types, new behaviour: the open connection now talks to the new code.
    update(s, `@ws("/greet") def greet(msg: { name: string }): { text: string } = { text: "hi " ++ msg.name }`);
    assert.ok(deploy(s).accepted);
    assert.deepEqual(await ask('{"name": "ada"}'), { text: "hi ada" });

    // New message type: the connection is closed so the client reconnects with the new types.
    const prev = structuredClone(s);
    const closed = new Promise<{ code: number; reason: string }>((res) => (sock.onclose = (e) => res({ code: e.code, reason: e.reason })));
    update(s, `@ws("/greet") def greet(msg: { first: string }): { text: string } = { text: "hi " ++ msg.first }`);
    assert.ok(deploy(s).accepted);
    ws.onLive!(rt, prev, s);
    assert.deepEqual(await closed, { code: 1012, reason: "message types changed by a deploy; reconnect" });
  } finally {
    server.stop();
  }
});

// ---------------- coverage ----------------

const feeSrc = `
  def fee(o: { qty: number, price: number }): number =
    if o.qty * o.price < 100 then 1 else o.qty * o.price * 0.01
  def label(n: number): string = "fee: " ++ str(n)
  test small = fee({ qty: 1, price: 1 }) == 1`;

test("coverage counts each definition once for running and once per branch of each if", () => {
  const s = fresh(feeSrc);
  runTests(s, s.dev, {}, new Set());
  const r = coverage(s, s.dev, "all", null);
  assert.deepEqual(
    r.defs.map((d) => [d.name, d.covered, d.total, d.missing]),
    [
      ["fee", 2, 3, ["'if o.qty * o.price < 100' never false"]],
      ["label", 0, 1, ["never run by any test"]],
    ],
  );
  assert.equal(r.percent, 50);
  assert.ok(s.testCache[s.dev.small].covers!.length > 0, "coverage is stored with the cached result");
});

test("the deploy gate enforces a minimum, scoped to what changed since live", () => {
  const s = fresh(feeSrc);
  const min = (minimum: number, of: "changed" | "all" = "changed") => deploy(s, { coverage: { minimum, of } });
  const refused = min(80);
  assert.equal(refused.accepted, false);
  assert.match(refused.reason!, /coverage is 50% of changed definitions \(2\/4 units\), below the minimum of 80%/);
  assert.ok(min(50).accepted);

  // Only the new definition counts now, and its test covers it fully.
  update(s, `def double(n: number): number = n * 2
             test doubles = double(2) == 4`);
  runTests(s, s.dev, s.live!, new Set());
  assert.equal(coverage(s, s.dev, "changed", s.live).percent, 100);
  assert.equal(coverage(s, s.dev, "all", s.live).percent, 60);
  assert.equal(min(80, "all").accepted, false);
  assert.ok(min(80).accepted);
});

test("a result cached before coverage was recorded is run once more to record it", () => {
  const s = fresh(feeSrc);
  runTests(s, s.dev, {}, new Set());
  delete s.testCache[s.dev.small].covers;
  const [run] = runTests(s, s.dev, {}, new Set());
  assert.equal(run.cached, false);
  assert.ok(s.testCache[s.dev.small].covers);
  assert.equal(runTests(s, s.dev, {}, new Set())[0].cached, true);
});

test("cairn.json: coverage settings are validated, with reporting only by default", () => {
  assert.deepEqual(parseConfig("{}").coverage, { minimum: 0, of: "changed" });
  assert.deepEqual(parseConfig('{ "coverage": { "minimum": 90, "of": "all" } }').coverage, { minimum: 90, of: "all" });
  assert.throws(() => parseConfig('{ "coverage": { "minimum": 120 } }'), /from 0 to 100/);
  assert.throws(() => parseConfig('{ "coverage": { "of": "some" } }'), /"changed" or "all"/);
  assert.throws(() => parseConfig("{"), /not valid JSON/);
});

// ---------------- mutation testing ----------------

const shippingSrc = `
  def shipping(total: number): number = if total < 100 then 5 else 0
  test small = shipping(20) == 5
  test big = shipping(250) == 0`;

test("mutation testing finds the untested boundary that full coverage misses", () => {
  const s = fresh(shippingSrc);
  runTests(s, s.dev, {}, new Set());
  assert.equal(coverage(s, s.dev, "all", null).percent, 100);
  const r = mutation(s, s.dev, "all", null);
  assert.deepEqual(r.defs[0].survivors, ["'<' → '<=' in 'total < 100': no test fails", "100 → 101 in '100': no test fails"]);
  assert.equal(r.score, 60);

  update(s, `test exactlyHundred = shipping(100) == 0`);
  runTests(s, s.dev, {}, new Set());
  assert.equal(mutation(s, s.dev, "all", null).score, 100);
});

test("mutants cover operators, conditions and literals, and repeated sites are numbered", () => {
  const s = fresh(`def f(a: number, b: number): boolean = !(a * b > 1) && a * b == 0`);
  const named = mutants(s.entries[s.dev.f], parseProgram(view(s, s.dev, "f"))[0].body).map((m) => m.label);
  assert.deepEqual(named, [
    "'&&' → '||' in '!(a * b > 1) && a * b == 0'",
    "'!' removed in '!(a * b > 1)'",
    "'>' → '>=' in 'a * b > 1'",
    "'*' → '/' in 'a * b'",
    "1 → 2 in '1'",
    "'==' → '!=' in 'a * b == 0'",
    "'*' → '/' in 'a * b' (occurrence 2)",
    "0 → 1 in '0'",
  ]);
});

test("mutation verdicts are cached per mutant and test, and unreached code is reported as such", () => {
  const s = fresh(shippingSrc + `\n def unused(n: number): number = n + 1`);
  runTests(s, s.dev, {}, new Set());
  mutation(s, s.dev, "all", null);
  const cached = Object.keys(s.mutationCache!).length;
  assert.ok(cached > 0);
  const again = mutation(s, s.dev, "all", null);
  assert.equal(Object.keys(s.mutationCache!).length, cached, "nothing new to compute");
  assert.deepEqual(again.defs.find((d) => d.name === "unused")!.survivors, [
    "'+' → '-' in 'n + 1': no test reaches unused",
    "1 → 2 in '1': no test reaches unused",
  ]);
});

test("the deploy gate enforces a mutation minimum only when one is set", () => {
  const s = fresh(shippingSrc);
  const gate = (minimum: number) => deploy(s, { mutation: { minimum, of: "changed" } });
  const refused = gate(80);
  assert.equal(refused.accepted, false);
  assert.match(refused.reason!, /mutation score is 60% of mutants killed in changed definitions \(3\/5\), below the minimum of 80%/);
  const off = gate(0);
  assert.ok(off.accepted);
  assert.equal(off.mutation, undefined, "with no minimum, deploy does not run mutation testing");
  assert.deepEqual(parseConfig('{ "mutation": { "minimum": 70 } }').mutation, { minimum: 70, of: "changed" });
});

// ---------------- partial def ----------------

test("recursion is only allowed in partial defs, and total code may not call partial code", () => {
  const errs = (src: string) => update(emptyState(), src).fileErrors.map((e) => e.error);
  assert.deepEqual(errs(`def fact(n: number): number = if n <= 1 then 1 else n * fact(n - 1)`), [
    "'fact' calls itself, so it may not terminate: declare it 'partial def fact'",
  ]);
  assert.deepEqual(errs(`def a(n: number): number = b(n)
                         def b(n: number): number = a(n)`), [
    "'a' is mutually recursive with 'b', so it may not terminate: declare it 'partial def a'",
    "'b' is mutually recursive with 'a', so it may not terminate: declare it 'partial def b'",
  ]);
  assert.deepEqual(errs(`partial def fact(n: number): number = if n <= 1 then 1 else n * fact(n - 1)
                         def twice(n: number): number = fact(n) * 2`), [
    "'twice' calls partial 'fact', and total code may not call partial code: declare it 'partial def twice'",
  ]);
  assert.deepEqual(errs(`partial def fact(n: number): number = if n <= 1 then 1 else n * fact(n - 1)
                         partial def twice(n: number): number = fact(n) * 2
                         test t = twice(3) == 12`), [], "tests may call partial code");
});

test("making a def partial is a change its total callers must follow, and nothing is applied until they do", () => {
  const s = fresh(`def step(n: number): number = n + 1
                   def twice(n: number): number = step(step(n))`);
  const before = { ...s.dev };
  const r = update(s, `partial def step(n: number): number = if n > 10 then n else step(n + 1)`);
  assert.equal(r.ok, false);
  assert.deepEqual(r.fileErrors.map((e) => e.name), ["twice"]);
  assert.deepEqual(s.dev, before);
  assert.ok(update(s, `partial def step(n: number): number = if n > 10 then n else step(n + 1)
                       partial def twice(n: number): number = step(step(n))`).ok);
  assert.equal(view(s, s.dev, "twice"), "partial def twice(n: number): number = step(step(n))");
  assert.ok(s.entries[s.dev.twice].partial);
});

test("risks lists partial code (and why), plugin boundaries and untested code, optionally only what changed", () => {
  const s = fresh(`
    partial def fact(n: number): number = if n <= 1 then 1 else n * fact(n - 1)
    @http("GET /fact/:n") partial def factRoute(req: { params: { n: string } }): number = fact(3)
    def double(n: number): number = n * 2
    test factOk = fact(3) == 6`);
  assert.equal(view(s, s.dev, "factRoute"), '@http("GET /fact/:n") partial def factRoute(req: { params: { n: string } }): number = fact(3)');
  runTests(s, s.dev, {}, new Set());
  const show = (rs: ReturnType<typeof risks>) => rs.map((r) => `${r.kind} ${r.name}: ${r.detail}`);
  assert.deepEqual(show(risks(s, s.dev)), [
    "partial fact: recursive",
    "partial factRoute: calls partial fact",
    'binding factRoute: @http("GET /fact/:n"): reached from trusted plugin code (http@1)',
    "untested double: never run by any test",
    "untested factRoute: never run by any test",
  ]);
  assert.ok(deploy(s).accepted);
  update(s, `def triple(n: number): number = n * 3`);
  assert.deepEqual(show(risks(s, s.dev, s.live)), ["untested triple: never run by any test"]);
});
