import type { Expr } from "./ast.ts";
import { declOf, type Namespace, type State } from "./codebase.ts";
import type { CoverageScope } from "./coverage.ts";
import { Evaluator } from "./eval.ts";
import { canon, type Entry, sha } from "./hash.ts";
import { showExpr } from "./pretty.ts";

/**
 * Mutation testing: make a small deliberate mistake in a definition (a *mutant*) and check that at
 * least one test fails. A mutant no test notices has *survived*: the tests cannot tell the real
 * code from a buggy version there, which usually means an edge case nobody checks.
 *
 * Mutants are never staged. While a test runs, the evaluator is handed the mutated entry in place
 * of the original's hash, so nothing is rehashed. Only tests whose recorded coverage reaches the
 * definition run, and each verdict ("test T fails on mutant M") is a permanent fact about the pair
 * of hashes, cached in `state.mutationCache` and never computed again.
 */

export type Mutant = { key: string; label: string; body: Expr };
export type DefMutation = { name: string; hash: string; killed: number; total: number; survivors: string[] };
export type MutationReport = { scope: CoverageScope; score: number; killed: number; total: number; defs: DefMutation[] };

const SWAP: Record<string, string> = { "<": "<=", "<=": "<", ">": ">=", ">=": ">", "==": "!=", "!=": "==", "+": "-", "-": "+", "*": "/", "&&": "||", "||": "&&" };

// Children in a fixed order, and a way to rebuild a node from new children. Hash form and name
// form have the same shape, so a path into one is the same place in the other.
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

function withChildren(e: Expr, k: Expr[]): Expr {
  switch (e.t) {
    case "lam":
      return { ...e, body: k[0] };
    case "let":
      return { ...e, value: k[0], body: k[1] };
    case "call":
      return { ...e, fn: k[0], args: k.slice(1) };
    case "field":
      return { ...e, obj: k[0] };
    case "rec":
      return { ...e, entries: e.entries.map((en, i) => ({ ...en, value: k[i] })) };
    case "bin":
      return { ...e, l: k[0], r: k[1] };
    case "un":
      return { ...e, e: k[0] };
    case "if":
      return { ...e, c: k[0], a: k[1], b: k[2] };
    default:
      return e;
  }
}

const at = (e: Expr, path: number[]): Expr => path.reduce((n, i) => children(n)[i], e);
const replaceAt = (e: Expr, path: number[], f: (n: Expr) => Expr): Expr =>
  path.length ? withChildren(e, children(e).map((c, i) => (i === path[0] ? replaceAt(c, path.slice(1), f) : c))) : f(e);

/** The mutations that apply to one node: [description, replacement]. */
function mutationsOf(e: Expr): [string, (n: Expr) => Expr][] {
  switch (e.t) {
    case "bin":
      return SWAP[e.op] ? [[`'${e.op}' → '${SWAP[e.op]}'`, (n) => ({ ...(n as typeof e), op: SWAP[e.op] })]] : [];
    case "un":
      return e.op === "!" ? [["'!' removed", (n) => (n as typeof e).e]] : [];
    case "if":
      return [["condition negated", (n) => ({ ...(n as typeof e), c: { t: "un", op: "!", e: (n as typeof e).c } })]];
    case "num":
      return [[`${e.v} → ${e.v + 1}`, (n) => ({ ...(n as typeof e), v: e.v + 1 })]];
    case "bool":
      return [[`${e.v} → ${!e.v}`, (n) => ({ ...(n as typeof e), v: !e.v })]];
    default:
      return [];
  }
}

/** Every mutant of a definition. `nameBody` (the rendered source) is only used to describe them. */
export function mutants(entry: Entry, nameBody: Expr): Mutant[] {
  const out: Mutant[] = [];
  (function walk(e: Expr, path: number[]) {
    for (const [what, f] of mutationsOf(e)) {
      const body = replaceAt(entry.body, path, f);
      out.push({ key: sha(canon({ of: entry.hash, body })), label: `${what} in '${showExpr(at(nameBody, path))}'`, body });
    }
    children(e).forEach((c, i) => walk(c, [...path, i]));
  })(entry.body, []);
  // The same expression can appear more than once ('a * b' twice): number the repeats.
  const seen = new Map<string, number>();
  for (const m of out) {
    const n = (seen.get(m.label) ?? 0) + 1;
    seen.set(m.label, n);
    if (n > 1) m.label += ` (occurrence ${n})`;
  }
  return out;
}

/** Does the test fail when the definition `entry` is replaced by `mutant`? Errors and runaway loops count as failing. */
function kills(state: State, entry: Entry, mutant: Mutant, test: string): boolean {
  const mutated: Entry = { ...entry, body: mutant.body };
  const ev = new Evaluator((h) => (h === entry.hash ? mutated : state.entries[h]), 200_000);
  try {
    return ev.global(test) !== true;
  } catch {
    return true;
  }
}

/**
 * Mutation score of the definitions in `ns` (those changed since `base`, or all), against the tests
 * in `ns`. Needs the tests' recorded coverage, so run the tests first.
 */
export function mutation(state: State, ns: Namespace, scope: CoverageScope, base: Namespace | null): MutationReport {
  const cache = (state.mutationCache ??= {});
  const tests = Object.values(ns).filter((h) => state.entries[h].kind === "test");
  const inBase = new Set(Object.values(base ?? {}));

  const defs: DefMutation[] = [];
  for (const name of Object.keys(ns).sort()) {
    const entry = state.entries[ns[name]];
    if (entry.kind !== "def" || (scope === "changed" && inBase.has(entry.hash))) continue;
    const reaching = tests.filter((t) => state.testCache[t]?.covers?.includes(entry.hash));
    const survivors: string[] = [];
    const all = mutants(entry, declOf(state, ns, name).body);
    for (const m of all) {
      const killed = reaching.some((t) => (cache[`${m.key}:${t}`] ??= kills(state, entry, m, t)));
      if (!killed) survivors.push(reaching.length ? `${m.label}: no test fails` : `${m.label}: no test reaches ${name}`);
    }
    defs.push({ name, hash: entry.hash, killed: all.length - survivors.length, total: all.length, survivors });
  }
  const killed = defs.reduce((n, d) => n + d.killed, 0);
  const total = defs.reduce((n, d) => n + d.total, 0);
  return { scope, score: total ? (100 * killed) / total : 100, killed, total, defs };
}

export const describeMutation = (r: MutationReport) =>
  `${r.score.toFixed(0)}% of mutants killed in ${r.scope === "changed" ? "changed" : "all"} definitions (${r.killed}/${r.total})`;
