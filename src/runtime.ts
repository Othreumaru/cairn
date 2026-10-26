import { CairnError } from "./ast.js";
import { Checker } from "./check.js";
import { invert, Namespace, nsId, State, TestResult } from "./codebase.js";
import { Evaluator, showValue } from "./eval.js";
import { normalize, short } from "./hash.js";
import { BUILTINS } from "./builtins.js";
import { parseExpr } from "./parser.js";
import { showType } from "./pretty.js";

/**
 * The runtime owns the `live` namespace. Nothing reaches it except through `deploy`, and
 * `deploy` is a gate: every test in the candidate namespace must pass. Results are cached
 * by test hash, so only tests whose transitive code actually changed are executed.
 * Passing the gate is an atomic pointer swap; rollback swaps the previous pointer back.
 */

export type TestRun = { name: string; hash: string; result: TestResult; cached: boolean; why?: string[] };

export type DeployReport = {
  accepted: boolean;
  fromId: string | null;
  toId: string;
  added: string[];
  removed: string[];
  changed: string[];
  runs: TestRun[];
  reason?: string;
};

export function runTest(state: State, hash: string, fuel = 200_000): TestResult {
  const ev = new Evaluator((h) => state.entries[h], fuel);
  const t0 = performance.now();
  try {
    const v = ev.global(hash);
    const ms = performance.now() - t0;
    return v === true ? { passed: true, detail: "true", ms } : { passed: false, detail: `evaluated to ${showValue(v)}`, ms };
  } catch (e) {
    const ms = performance.now() - t0;
    const msg = e instanceof RangeError ? "stack overflow (possible infinite recursion)" : e instanceof Error ? e.message : String(e);
    return { passed: false, detail: msg, ms };
  }
}

/** Path from a test to the root of the change, explaining why it had to run. */
function whyAffected(state: State, ns: Namespace, test: string, touched: Set<string>): string[] | undefined {
  const names = invert(ns);
  const bfs = (targets: Set<string>): string[] | undefined => {
    const prev = new Map<string, string>();
    const queue = [test];
    const seen = new Set(queue);
    while (queue.length) {
      const cur = queue.shift()!;
      if (cur !== test && targets.has(cur)) {
        const path = [cur];
        let p = cur;
        while (prev.has(p)) path.push((p = prev.get(p)!));
        return path.reverse();
      }
      for (const d of state.entries[ns[cur]].deps) {
        const dn = names.get(d);
        if (dn && !seen.has(dn)) {
          seen.add(dn);
          prev.set(dn, cur);
          queue.push(dn);
        }
      }
    }
    return undefined;
  };
  // Prefer the *root* of the change: a touched definition none of whose deps were touched.
  const touchedHashes = new Set([...touched].map((n) => ns[n]));
  const roots = new Set([...touched].filter((n) => !state.entries[ns[n]].deps.some((d) => touchedHashes.has(d))));
  return bfs(roots) ?? bfs(touched);
}

export function deploy(state: State, opts: { onRun?: (r: TestRun) => void } = {}): DeployReport {
  const staged = state.dev;
  const live = state.live ?? {};
  const toId = nsId(staged);
  const fromId = state.live ? nsId(state.live) : null;
  const added = Object.keys(staged).filter((n) => !(n in live)).sort();
  const removed = Object.keys(live).filter((n) => !(n in staged)).sort();
  const changed = Object.keys(staged).filter((n) => n in live && live[n] !== staged[n]).sort();
  const report: DeployReport = { accepted: false, fromId, toId, added, removed, changed, runs: [] };

  if (fromId === toId) {
    report.accepted = true;
    report.reason = "nothing to deploy: live already serves this exact namespace";
    return report;
  }

  const touched = new Set([...added, ...changed]);
  const tests = Object.keys(staged)
    .filter((n) => state.entries[staged[n]].kind === "test")
    .sort();

  for (const name of tests) {
    const h = staged[name];
    const cachedResult = state.testCache[h];
    let run: TestRun;
    if (cachedResult) run = { name, hash: h, result: cachedResult, cached: true };
    else {
      const result = runTest(state, h);
      state.testCache[h] = result; // a result is a permanent fact about this hash
      const isNew = !(name in live);
      run = { name, hash: h, result, cached: false, why: isNew ? undefined : whyAffected(state, staged, name, touched) };
    }
    report.runs.push(run);
    opts.onRun?.(run);
  }

  const failed = report.runs.filter((r) => !r.result.passed);
  if (failed.length) {
    report.reason = `${failed.length} test(s) failed: ${failed.map((f) => f.name).join(", ")}`;
    return report;
  }

  // Atomic swap: one pointer assignment. The previous namespace stays addressable for rollback.
  if (state.live) state.history.push({ id: fromId!, ns: state.live, at: new Date().toISOString() });
  state.live = { ...staged };
  report.accepted = true;
  return report;
}

export function rollback(state: State): { from: string; to: string } {
  const prev = state.history.pop();
  if (!prev || !state.live) throw new CairnError("nothing to roll back to");
  const from = nsId(state.live);
  state.live = prev.ns;
  return { from, to: prev.id };
}

/** Type-check and evaluate an expression against a namespace (live by default). */
export function evaluate(state: State, src: string, which: "live" | "dev" = "live"): { value: string; type: string } {
  const ns = which === "live" ? state.live : state.dev;
  if (!ns) throw new CairnError("nothing is deployed yet — run `deploy` first (or use --dev)");
  const e = parseExpr(src);
  const checker = new Checker((n) => (n in ns ? state.entries[ns[n]].sig : undefined));
  const type = checker.synth(e, new Map());
  const hashForm = normalize(e, (n) => {
    if (n in ns) return { t: "ref", hash: ns[n] };
    if (n in BUILTINS) return { t: "builtin", name: n };
    throw new CairnError(`unknown name '${n}'`);
  });
  const ev = new Evaluator((h) => state.entries[h]);
  const dummyCtx = { hash: "", kind: "def" as const, sig: type, body: hashForm, deps: [], localNames: [], origName: "<eval>" };
  return { value: showValue(ev.eval(hashForm, new Map(), dummyCtx)), type: showType(type) };
}

export { short };
