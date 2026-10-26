import { test } from "node:test";
import assert from "node:assert/strict";
import { CairnError, T } from "../src/ast.js";
import { Checker } from "../src/check.js";
import { emptyState, update, rename, remove, view } from "../src/codebase.js";
import { parseExpr, parseProgram } from "../src/parser.js";
import { showDecl, showExpr } from "../src/pretty.js";
import { deploy, evaluate, rollback } from "../src/runtime.js";
import { subtype } from "../src/types.js";

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
    def ev(n: number): boolean = if n == 0 then true else od(n - 1)
    def od(n: number): boolean = if n == 0 then false else ev(n - 1)
    test p = ev(10) && od(3)`);
  const e1 = s.entries[s.dev.ev];
  const e2 = s.entries[s.dev.od];
  assert.ok(e1.group && e2.group && e1.group.hash === e2.group.hash);
  assert.ok(deploy(s).accepted);
});

test("editing one member of a cycle rehashes its peer", () => {
  const s = fresh(`
    def ev(n: number): boolean = if n == 0 then true else od(n - 1)
    def od(n: number): boolean = if n == 0 then false else ev(n - 1)`);
  const before = s.dev.od;
  const r = update(s, `def ev(n: number): boolean = if n <= 0 then true else od(n - 1)`);
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
  const s = fresh(`def loop(n: number): number = loop(n + 1)
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
