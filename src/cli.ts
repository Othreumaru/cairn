#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { CairnError } from "./ast.ts";
import { declOf, describeChange, emptyState, invert, type Namespace, nsId, remove, rename, staleBuiltins, type State, transitiveDependents, update, type UpdateReport, upgrade, view } from "./codebase.ts";
import { short } from "./hash.ts";
import { deploy, evaluate, rollback, runTests, type TestRun } from "./runtime.ts";
import { showType } from "./pretty.ts";
import { type Config, loadConfig } from "./config.ts";
import { coverage, type CoverageReport, describeCoverage } from "./coverage.ts";
import { describeMutation, mutation, type MutationReport } from "./mutation.ts";
import { host } from "./host.ts";
import { PLUGINS } from "./plugins/index.ts";
import { load, save, stateFile } from "./store.ts";

const nsLabel = (id: string | null) => (id ? `ns${short(id)}` : "(empty)");

function printRun(r: TestRun) {
  const mark = r.result.passed ? "✓" : "✗";
  if (r.cached) console.log(`    ${mark} ${r.name.padEnd(20)} cached ${short(r.hash)}`);
  else {
    const why = r.why ? `  (affected via ${r.why.join(" → ")})` : "  (new test)";
    console.log(`    ${mark} ${r.name.padEnd(20)} RAN ${r.result.ms.toFixed(2)}ms${r.result.passed ? "" : ` — ${r.result.detail}`}${why}`);
  }
}

/** One summary line, then the definitions that are not fully covered (at most `limit` of them). */
function printCoverage(r: CoverageReport, minimum: number, indent: string, limit = Infinity) {
  const below = r.percent < minimum;
  const min = minimum > 0 ? `, minimum ${minimum}%${below ? " — NOT MET" : ""}` : "";
  console.log(`${indent}coverage: ${describeCoverage(r)}${min}`);
  const gaps = r.defs.filter((d) => d.missing.length);
  for (const d of gaps.slice(0, limit)) console.log(`${indent}  ${d.name} (${d.covered}/${d.total}): ${d.missing.join("; ")}`);
  if (gaps.length > limit) console.log(`${indent}  … and ${gaps.length - limit} more (cairn coverage)`);
}

function printMutation(r: MutationReport, minimum: number, indent: string, limit = Infinity) {
  const min = minimum > 0 ? `, minimum ${minimum}%${r.score < minimum ? " — NOT MET" : ""}` : "";
  console.log(`${indent}mutation: ${describeMutation(r)}${min}`);
  const survivors = r.defs.flatMap((d) => d.survivors.map((s) => `${d.name}: ${s}`));
  for (const s of survivors.slice(0, limit)) console.log(`${indent}  survived — ${s}`);
  if (survivors.length > limit) console.log(`${indent}  … and ${survivors.length - limit} more (cairn mutate)`);
}

function printUpdate(state: State, prevDev: Namespace, r: UpdateReport, title: string, dryRun: boolean, skipTests: boolean, config: Config): number {
  console.log(`${title}${dryRun ? " (dry run)" : ""}:`);
  if (r.fileErrors.length) {
    for (const e of r.fileErrors) console.log(`  ✗ ${e.name}${e.line ? ` (line ${e.line}:${e.col})` : ""}: ${e.error}`);
    console.log("\nnothing applied — fix the type errors above.");
    return 1;
  }
  const interesting = r.changes.filter((c) => c.kind.k !== "unchanged");
  const unchanged = r.changes.length - interesting.length;
  for (const c of interesting) console.log(`  ${describeChange(c)}`);
  if (unchanged) console.log(`  = ${unchanged} definition(s) unchanged (identical hashes)`);
  if (!r.ok) {
    console.log("\nREJECTED — the change breaks the definitions marked ✗. Nothing applied.");
    console.log("Update them in the same file (or keep the old type) and try again.");
    return 1;
  }
  if (!interesting.length) {
    console.log("\nno changes — every definition hashes to what is already in the codebase.");
    return 0;
  }
  if (!r.applied || skipTests || !r.testsToRun.length) {
    console.log(`\ntests: ${r.testsToRun.length} will run on next deploy${r.testsToRun.length ? ` (${r.testsToRun.join(", ")})` : ""}, ${r.testsCached.length} cached`);
  } else {
    // Run the affected tests now: their results are cached by hash, so the next deploy only reads the cache.
    console.log(`\ntests: running ${r.testsToRun.length} now, ${r.testsCached.length} cached`);
    const touched = new Set(r.changes.filter((c) => c.newHash && c.newHash !== c.oldHash).map((c) => c.name));
    const failed = runTests(state, state.dev, prevDev, touched, (run) => !run.cached && printRun(run)).filter((x) => !x.result.passed);
    if (failed.length) console.log(`  ${failed.length} test(s) failing (${failed.map((f) => f.name).join(", ")}): staged, but deploy will refuse until they pass`);
    const cov = coverage(state, state.dev, config.coverage.of, state.live);
    if (cov.total) printCoverage(cov, config.coverage.minimum, "", 5);
    if (cov.percent < config.coverage.minimum) console.log(`  staged, but deploy will refuse until coverage reaches ${config.coverage.minimum}%`);
  }
  if (r.applied) save(state);
  console.log(r.applied ? `dev is now ${nsLabel(nsId(state.dev))}` : "dry run — nothing applied");
  return 0;
}

function main(argv: string[]) {
  const [cmd, ...args] = argv;
  const state = load();
  const dryRun = args.includes("--dry-run");
  const skipTests = args.includes("--skip-tests");
  const prevDev = { ...state.dev };
  // cairn.json sets the coverage policy; --min-coverage N overrides its minimum for this command.
  const config = loadConfig();
  // --min-coverage N and --min-mutation N override cairn.json's minimums for this command.
  const flagValues = new Set<number>();
  for (const [flag, key] of [["--min-coverage", "coverage"], ["--min-mutation", "mutation"]] as const) {
    const i = args.indexOf(flag);
    if (i < 0) continue;
    const n = i + 1 < args.length ? Number(args[i + 1]) : NaN;
    if (!(n >= 0 && n <= 100)) throw new CairnError(`${flag} needs a number from 0 to 100`);
    config[key].minimum = n;
    flagValues.add(i + 1);
  }
  const rest = args.filter((a, i) => !a.startsWith("--") && !flagValues.has(i));

  switch (cmd) {
    case "update": {
      const file = rest[0];
      if (!file) throw new CairnError("usage: cairn update <file.cairn> [--dry-run] [--skip-tests]");
      return printUpdate(state, prevDev, update(state, readFileSync(file, "utf8"), { dryRun }), `impact of ${file}`, dryRun, skipTests, config);
    }

    case "upgrade":
      return printUpdate(state, prevDev, upgrade(state, { dryRun }), "upgrading definitions pinned to old builtin versions", dryRun, skipTests, config);

    case "deploy": {
      console.log(`deploy: dev ${nsLabel(nsId(state.dev))} → live (currently ${nsLabel(state.live ? nsId(state.live) : null)})`);
      if (state.live && nsId(state.live) === nsId(state.dev)) {
        console.log("  nothing to deploy: live already serves this exact namespace (same hash)");
        return 0;
      }
      console.log("  gate:");
      const r = deploy(state, {
        onRun: (run) => printRun(run),
        coverage: config.coverage,
        mutation: config.mutation,
      });
      if (r.reason && r.accepted && !r.runs.length) {
        console.log(`  ${r.reason}`);
        return 0;
      }
      const ran = r.runs.filter((x) => !x.cached).length;
      console.log(`  changes: +${r.added.length} added, ~${r.changed.length} changed, -${r.removed.length} removed`);
      console.log(`  tests: ${r.runs.length} total — ${ran} ran, ${r.runs.length - ran} served from cache`);
      if (r.coverage?.total) printCoverage(r.coverage, config.coverage.minimum, "  ", 5);
      if (r.mutation?.total) printMutation(r.mutation, config.mutation.minimum, "  ", 5);
      save(state); // test results are cached even when the deploy is rejected
      if (!r.accepted) {
        console.log(`\nREJECTED — ${r.reason}. live unchanged at ${nsLabel(r.fromId)}.`);
        return 1;
      }
      console.log(`\nACCEPTED — atomic swap: live is now ${nsLabel(r.toId)}`);
      return 0;
    }

    case "rollback": {
      const r = rollback(state);
      save(state);
      console.log(`rolled back live: ${nsLabel(r.from)} → ${nsLabel(r.to)}`);
      return 0;
    }

    case "eval": {
      const which = args.includes("--dev") ? "dev" : "live";
      const r = evaluate(state, rest.join(" "), which);
      console.log(`${r.value} : ${r.type}`);
      return 0;
    }

    case "view": {
      const ns = args.includes("--live") ? state.live ?? {} : state.dev;
      for (const n of rest.length ? rest : Object.keys(ns).sort()) {
        const stale = n in ns ? staleBuiltins(state.entries[ns[n]]) : [];
        console.log(`${short(ns[n])}  ${view(state, ns, n)}${stale.length ? `  -- pinned to old builtins: ${stale.join(", ")}` : ""}`);
      }
      return 0;
    }

    case "dependents": {
      const name = rest[0];
      if (!(name in state.dev)) throw new CairnError(`no definition named '${name}'`);
      const ds = [...transitiveDependents(state, state.dev, [state.dev[name]])].filter((n) => n !== name).sort();
      const tests = ds.filter((n) => state.entries[state.dev[n]].kind === "test");
      console.log(`changing '${name}' would affect ${ds.length} definition(s), including ${tests.length} test(s):`);
      for (const d of ds) console.log(`  ${state.entries[state.dev[d]].kind === "test" ? "test" : "def "} ${d}`);
      return 0;
    }

    case "deps": {
      const name = rest[0];
      const names = invert(state.dev);
      const d = declOf(state, state.dev, name);
      console.log(`${name} : ${showType(d.sig)}`);
      for (const h of state.entries[state.dev[name]].deps) console.log(`  → ${names.get(h) ?? "(unnamed)"} ${short(h)}`);
      return 0;
    }

    case "rename":
      rename(state, rest[0], rest[1]);
      save(state);
      console.log(`renamed ${rest[0]} → ${rest[1]} (hash ${short(state.dev[rest[1]])} unchanged; no code was touched, no tests need to run)`);
      return 0;

    case "delete":
      remove(state, rest[0]);
      save(state);
      console.log(`removed name '${rest[0]}' from dev (the code itself stays in the store)`);
      return 0;

    case "status": {
      console.log(`definitions in store: ${Object.keys(state.entries).length}`);
      console.log(`dev:  ${nsLabel(nsId(state.dev))}  (${Object.keys(state.dev).length} names)`);
      console.log(`live: ${nsLabel(state.live ? nsId(state.live) : null)}${state.live ? `  (${Object.keys(state.live).length} names)` : ""}`);
      console.log(`deploy history: ${state.history.length} previous version(s); cached test results: ${Object.keys(state.testCache).length}`);
      const stale = Object.keys(state.dev).filter((n) => staleBuiltins(state.entries[state.dev[n]]).length);
      if (stale.length) console.log(`pinned to old builtin versions: ${stale.sort().join(", ")} (run \`cairn upgrade\`)`);
      return 0;
    }

    case "serve": {
      // --http N / --ws N start those entry-point plugins; --port is short for --http.
      const ports: Record<string, number> = {};
      for (const [flag, plugin] of [["--port", "http"], ...Object.keys(PLUGINS).map((p) => [`--${p}`, p])]) {
        const i = args.indexOf(flag);
        if (i < 0) continue;
        const port = Number(args[i + 1]);
        if (!Number.isInteger(port) || port <= 0) throw new CairnError(`usage: cairn serve [--http N] [--ws N]  (bad port after ${flag})`);
        ports[plugin] = port;
      }
      host(stateFile(), Object.keys(ports).length ? ports : { http: 3000 });
      return undefined; // keep running
    }

    case "coverage": {
      // Coverage of dev by its tests: of what is new or changed since live (default), or --all.
      const of = args.includes("--all") ? "all" : args.includes("--changed") ? "changed" : config.coverage.of;
      runTests(state, state.dev, state.live ?? {}, new Set()); // records coverage for results cached before it was measured
      save(state);
      const r = coverage(state, state.dev, of, state.live);
      printCoverage(r, config.coverage.minimum, "");
      for (const d of r.defs.filter((x) => !x.missing.length)) console.log(`  ${d.name} (${d.covered}/${d.total}): fully covered`);
      return r.percent < config.coverage.minimum ? 1 : 0;
    }

    case "mutate": {
      // Mutation testing of dev: of what changed since live (default) or --all.
      const of = args.includes("--all") ? "all" : args.includes("--changed") ? "changed" : config.mutation.of;
      runTests(state, state.dev, state.live ?? {}, new Set()); // coverage tells which tests can reach each definition
      const r = mutation(state, state.dev, of, state.live);
      save(state); // verdicts are cached, so the next run is free
      printMutation(r, config.mutation.minimum, "");
      for (const d of r.defs.filter((x) => x.total && !x.survivors.length)) console.log(`  ${d.name}: all ${d.total} mutants killed`);
      return r.score < config.mutation.minimum ? 1 : 0;
    }

    case "bindings": {
      const ns = args.includes("--dev") ? state.dev : state.live ?? {};
      const rows = Object.keys(ns)
        .sort()
        .map((n) => [n, state.entries[ns[n]]] as const)
        .filter(([, e]) => e.binding);
      if (!rows.length) console.log("no bindings");
      for (const [n, e] of rows) {
        const b = e.binding!;
        const at = `@${b.plugin}(${b.args.map((a) => JSON.stringify(a)).join(", ")})`;
        console.log(`${at.padEnd(28)} ${n.padEnd(14)} ${b.plugin}@${b.version}  ${short(ns[n])}`);
      }
      return 0;
    }

    case "reset":
      save(emptyState());
      console.log("state reset");
      return 0;

    default:
      console.log(`cairn — a toy content-addressed language with a gated deploy runtime

  update <file> [--dry-run] [--skip-tests]
                              type-check a source file, show change impact, stage into dev,
                              then run the affected tests now so deploy only reads the cache
  deploy                      gate: every test must have a passing result (cached by hash; any
                              not yet run, e.g. after --skip-tests, run now), then atomically swap live
  rollback                    point live back at the previous namespace
  eval <expr> [--dev]         evaluate an expression against live (or dev)
  view [name...] [--live]     print definitions (rendered from the hashed AST)
  deps <name>                 direct dependencies of a definition
  dependents <name>           everything a change to <name> would affect
  serve [--http N] [--ws N]   serve the bindings in live through the http and ws plugins (default:
                              --http 3000), switching to each new deploy as it happens
  bindings [--dev]            list the plugin bindings in live (or dev)
  coverage [--all|--changed]  test coverage of dev: of what changed since live (default) or of
                              everything; each definition counts once for running and once per
                              branch of each if. The minimum comes from cairn.json
                              ({ "coverage": { "minimum": 80, "of": "changed" } }) and is
                              enforced by deploy; --min-coverage N overrides it
  mutate [--all|--changed]    mutation testing: make small deliberate mistakes in each definition
                              ('<' to '<=', '+' to '-', negated conditions, n to n+1, ...) and
                              check a test fails for each. The deploy gate enforces cairn.json's
                              { "mutation": { "minimum": 70 } } when set; --min-mutation N
                              overrides it
  upgrade [--dry-run] [--skip-tests]
                              move code pinned to old builtin versions onto the current ones
  rename <old> <new>          rename (free: hashes don't change)
  delete <name>               remove a name (refused if anything depends on it)
  status | reset`);
      return cmd ? 1 : 0;
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  if (e instanceof CairnError) {
    console.error(`error${e.span ? ` (line ${e.span.line}:${e.span.col})` : ""}: ${e.message}`);
    process.exitCode = 1;
  } else throw e;
}
