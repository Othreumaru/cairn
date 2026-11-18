#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { CairnError } from "./ast.js";
import { declOf, describeChange, emptyState, invert, Namespace, nsId, remove, rename, staleBuiltins, State, transitiveDependents, update, UpdateReport, upgrade, view } from "./codebase.js";
import { short } from "./hash.js";
import { deploy, evaluate, rollback, runTests, TestRun } from "./runtime.js";
import { showType } from "./pretty.js";
import { host } from "./host.js";
import { PLUGINS } from "./plugins/index.js";
import { load, save, stateFile } from "./store.js";

const nsLabel = (id: string | null) => (id ? `ns${short(id)}` : "(empty)");

function printRun(r: TestRun) {
  const mark = r.result.passed ? "✓" : "✗";
  if (r.cached) console.log(`    ${mark} ${r.name.padEnd(20)} cached ${short(r.hash)}`);
  else {
    const why = r.why ? `  (affected via ${r.why.join(" → ")})` : "  (new test)";
    console.log(`    ${mark} ${r.name.padEnd(20)} RAN ${r.result.ms.toFixed(2)}ms${r.result.passed ? "" : ` — ${r.result.detail}`}${why}`);
  }
}

function printUpdate(state: State, prevDev: Namespace, r: UpdateReport, title: string, dryRun: boolean, skipTests: boolean): number {
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
  const rest = args.filter((a) => !a.startsWith("--"));

  switch (cmd) {
    case "update": {
      const file = rest[0];
      if (!file) throw new CairnError("usage: cairn update <file.cairn> [--dry-run] [--skip-tests]");
      return printUpdate(state, prevDev, update(state, readFileSync(file, "utf8"), { dryRun }), `impact of ${file}`, dryRun, skipTests);
    }

    case "upgrade":
      return printUpdate(state, prevDev, upgrade(state, { dryRun }), "upgrading definitions pinned to old builtin versions", dryRun, skipTests);

    case "deploy": {
      console.log(`deploy: dev ${nsLabel(nsId(state.dev))} → live (currently ${nsLabel(state.live ? nsId(state.live) : null)})`);
      if (state.live && nsId(state.live) === nsId(state.dev)) {
        console.log("  nothing to deploy: live already serves this exact namespace (same hash)");
        return 0;
      }
      console.log("  gate:");
      const r = deploy(state, {
        onRun: (run) => printRun(run),
      });
      if (r.reason && r.accepted && !r.runs.length) {
        console.log(`  ${r.reason}`);
        return 0;
      }
      const ran = r.runs.filter((x) => !x.cached).length;
      console.log(`  changes: +${r.added.length} added, ~${r.changed.length} changed, -${r.removed.length} removed`);
      console.log(`  tests: ${r.runs.length} total — ${ran} ran, ${r.runs.length - ran} served from cache`);
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
