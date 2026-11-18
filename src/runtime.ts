import { CairnError } from "./ast.ts";
import { Checker } from "./check.ts";
import { invert, type Namespace, nsId, type State, type TestResult } from "./codebase.ts";
import { Evaluator, showValue } from "./eval.ts";
import { normalize, short } from "./hash.ts";
import { BUILTINS, currentVersion } from "./builtins.ts";
import { parseExpr } from "./parser.ts";
import { showType } from "./pretty.ts";
import { coverage, type CoverageReport, type CoverageScope, describeCoverage } from "./coverage.ts";

/**
 * The runtime owns the `live` namespace. Nothing reaches it except through `deploy`, and
 * `deploy` is a gate: every test in the candidate namespace must pass. Results are cached
 * by test hash, so only tests whose transitive code actually changed are executed.
 * `update` normally runs those tests as soon as code is staged (see `runTests`), so by the
 * time of a deploy every result is already cached and the gate only reads the cache.
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
  coverage?: CoverageReport;
  reason?: string;
};

export function runTest(state: State, hash: string, fuel = 200_000): TestResult {
  const ev = new Evaluator((h) => state.entries[h], fuel);
  ev.cover = new Set();
  const t0 = performance.now();
  const covers = () => [...ev.cover!].sort();
  try {
    const v = ev.global(hash);
    const ms = performance.now() - t0;
    return v === true ? { passed: true, detail: "true", ms, covers: covers() } : { passed: false, detail: `evaluated to ${showValue(v)}`, ms, covers: covers() };
  } catch (e) {
    const ms = performance.now() - t0;
    const msg = e instanceof RangeError ? "stack overflow (possible infinite recursion)" : e instanceof Error ? e.message : String(e);
    return { passed: false, detail: msg, ms, covers: covers() };
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

/**
 * Every test in `ns`, with its result: cached results are reused, the rest are run and cached.
 * A result is a permanent fact about a hash, so it does not matter whether it is computed
 * when code is staged or when it is deployed.
 *
 * @param prev     the namespace `ns` is replacing: tests not in it are reported as new
 * @param touched  names added or changed since `prev`, to explain why a test had to run
 */
export function runTests(
  state: State,
  ns: Namespace,
  prev: Namespace,
  touched: Set<string>,
  onRun?: (r: TestRun) => void,
): TestRun[] {
  const runs: TestRun[] = [];
  const tests = Object.keys(ns)
    .filter((n) => state.entries[ns[n]].kind === "test")
    .sort();
  for (const name of tests) {
    const h = ns[name];
    // A result cached before coverage was recorded is run once more to record it (tests are pure).
    const cachedResult = state.testCache[h]?.covers ? state.testCache[h] : undefined;
    let run: TestRun;
    if (cachedResult) run = { name, hash: h, result: cachedResult, cached: true };
    else {
      const result = runTest(state, h);
      state.testCache[h] = result; // a result is a permanent fact about this hash
      const isNew = !(name in prev);
      run = { name, hash: h, result, cached: false, why: isNew ? undefined : whyAffected(state, ns, name, touched) };
    }
    runs.push(run);
    onRun?.(run);
  }
  return runs;
}

export function deploy(
  state: State,
  opts: { onRun?: (r: TestRun) => void; coverage?: { minimum: number; of: CoverageScope } } = {},
): DeployReport {
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

  // Normally every result is already cached by `update`; anything staged with --skip-tests runs here.
  report.runs = runTests(state, staged, live, new Set([...added, ...changed]), opts.onRun);

  const failed = report.runs.filter((r) => !r.result.passed);
  if (failed.length) {
    report.reason = `${failed.length} test(s) failed: ${failed.map((f) => f.name).join(", ")}`;
    return report;
  }

  // Coverage of what this deploy changes (or of everything), against the project's minimum.
  if (opts.coverage) {
    report.coverage = coverage(state, staged, opts.coverage.of, state.live);
    if (report.coverage.percent < opts.coverage.minimum) {
      report.reason = `coverage is ${describeCoverage(report.coverage)}, below the minimum of ${opts.coverage.minimum}%`;
      return report;
    }
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
    if (n in BUILTINS) return { t: "builtin", name: n, v: currentVersion(n) };
    throw new CairnError(`unknown name '${n}'`);
  });
  const ev = new Evaluator((h) => state.entries[h]);
  const dummyCtx = { hash: "", kind: "def" as const, sig: type, body: hashForm, deps: [], localNames: [], origName: "<eval>" };
  return { value: showValue(ev.eval(hashForm, new Map(), dummyCtx)), type: showType(type) };
}

export { short };
