import type { Expr } from "./ast.ts";
import { declOf, type Namespace, type State } from "./codebase.ts";
import type { Entry } from "./hash.ts";
import { showExpr } from "./pretty.ts";

/**
 * Test coverage, measured exactly and cached like test results.
 *
 * A definition has one *unit* for running at all, plus two for each `if` in its body (the `then`
 * and the `else` branch). While a test runs, the evaluator records the units it reaches; that set
 * is a permanent fact about the test's hash, so it is stored with the test's cached result and
 * never measured again. Coverage of a namespace is the share of its definitions' units that at
 * least one of its tests reached.
 */

export type CoverageScope = "changed" | "all";

export type DefCoverage = { name: string; hash: string; covered: number; total: number; missing: string[] };
export type CoverageReport = { scope: CoverageScope; percent: number; covered: number; total: number; defs: DefCoverage[] };

function children(e: Expr): Expr[] {
  switch (e.t) {
    case "lam":
      return [e.body];
    case "let":
      return [e.value, e.body];
    case "call":
      return [e.fn, ...e.args];
    case "field":
      return [e.obj];
    case "rec":
      return e.entries.map((en) => en.value);
    case "bin":
      return [e.l, e.r];
    case "un":
      return [e.e];
    case "if":
      return [e.c, e.a, e.b];
    default:
      return [];
  }
}

/** The `if` nodes of a body, in a fixed order. Hash form and name form have the same shape, so
 *  the i-th `if` of a stored entry is the i-th `if` of its rendered source. */
export function ifNodes(body: Expr): Extract<Expr, { t: "if" }>[] {
  const out: Extract<Expr, { t: "if" }>[] = [];
  (function walk(e: Expr) {
    if (e.t === "if") out.push(e);
    children(e).forEach(walk);
  })(body);
  return out;
}

export const branchUnit = (hash: string, i: number, taken: boolean) => `${hash}#if${i}:${taken ? "then" : "else"}`;

export function units(entry: Entry): string[] {
  return [entry.hash, ...ifNodes(entry.body).flatMap((_, i) => [branchUnit(entry.hash, i, true), branchUnit(entry.hash, i, false)])];
}

/**
 * Coverage of the definitions in `ns` by the tests in `ns`. With scope "changed", only definitions
 * whose hash is not in `base` (normally live) count: new code, and code a change rehashed.
 * Tests without recorded coverage count as covering nothing.
 */
export function coverage(state: State, ns: Namespace, scope: CoverageScope, base: Namespace | null): CoverageReport {
  const reached = new Set<string>();
  for (const h of Object.values(ns)) if (state.entries[h].kind === "test") for (const u of state.testCache[h]?.covers ?? []) reached.add(u);
  const inBase = new Set(Object.values(base ?? {}));

  const defs: DefCoverage[] = [];
  for (const name of Object.keys(ns).sort()) {
    const entry = state.entries[ns[name]];
    if (entry.kind !== "def" || (scope === "changed" && inBase.has(entry.hash))) continue;
    const conds = ifNodes(declOf(state, ns, name).body).map((e) => showExpr(e.c));
    const missing: string[] = [];
    if (!reached.has(entry.hash)) missing.push("never run by any test");
    conds.forEach((c, i) => {
      for (const taken of [true, false]) if (!reached.has(branchUnit(entry.hash, i, taken))) missing.push(`'if ${c}' never ${taken}`);
    });
    const total = 1 + 2 * conds.length;
    defs.push({ name, hash: entry.hash, covered: total - missing.length, total, missing });
  }
  const covered = defs.reduce((n, d) => n + d.covered, 0);
  const total = defs.reduce((n, d) => n + d.total, 0);
  return { scope, percent: total ? (100 * covered) / total : 100, covered, total, defs };
}

export const describeCoverage = (r: CoverageReport) =>
  `${r.percent.toFixed(0)}% of ${r.scope === "changed" ? "changed" : "all"} definitions (${r.covered}/${r.total} units)`;
