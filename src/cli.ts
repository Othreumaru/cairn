#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CairnError } from "./ast.js";
import { declOf, describeChange, emptyState, invert, nsId, remove, rename, State, transitiveDependents, update, view } from "./codebase.js";
import { short } from "./hash.js";
import { deploy, evaluate, rollback, TestRun } from "./runtime.js";
import { showType } from "./pretty.js";

const HOME = process.env.CAIRN_HOME ?? join(process.cwd(), ".cairn");
const FILE = join(HOME, "state.json");

const load = (): State => (existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : emptyState());
const save = (s: State) => {
  mkdirSync(HOME, { recursive: true });
  writeFileSync(FILE, JSON.stringify(s));
};

const nsLabel = (id: string | null) => (id ? `ns${short(id)}` : "(empty)");

function printRun(r: TestRun) {
  const mark = r.result.passed ? "✓" : "✗";
  if (r.cached) console.log(`    ${mark} ${r.name.padEnd(20)} cached ${short(r.hash)}`);
  else {
    const why = r.why ? `  (affected via ${r.why.join(" → ")})` : "  (new test)";
    console.log(`    ${mark} ${r.name.padEnd(20)} RAN ${r.result.ms.toFixed(2)}ms${r.result.passed ? "" : ` — ${r.result.detail}`}${why}`);
  }
}

function main(argv: string[]) {
  const [cmd, ...args] = argv;
  const state = load();
  const dryRun = args.includes("--dry-run");
  const rest = args.filter((a) => !a.startsWith("--"));

  switch (cmd) {
    case "update": {
      const file = rest[0];
      if (!file) throw new CairnError("usage: cairn update <file.cairn> [--dry-run]");
      const r = update(state, readFileSync(file, "utf8"), { dryRun });
      console.log(`impact of ${file}${dryRun ? " (dry run)" : ""}:`);
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
      console.log(`\ntests: ${r.testsToRun.length} will run on next deploy${r.testsToRun.length ? ` (${r.testsToRun.join(", ")})` : ""}, ${r.testsCached.length} cached`);
      if (r.applied) save(state);
      console.log(r.applied ? `dev is now ${nsLabel(nsId(state.dev))}` : "dry run — nothing applied");
      return 0;
    }

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
      for (const n of rest.length ? rest : Object.keys(ns).sort()) console.log(`${short(ns[n])}  ${view(state, ns, n)}`);
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
      return 0;
    }

    case "reset":
      save(emptyState());
      console.log("state reset");
      return 0;

    default:
      console.log(`cairn — a toy content-addressed language with a gated deploy runtime

  update <file> [--dry-run]   type-check a source file, show change impact, stage into dev
  deploy                      gate: run affected tests (cached by hash), then atomically swap live
  rollback                    point live back at the previous namespace
  eval <expr> [--dev]         evaluate an expression against live (or dev)
  view [name...] [--live]     print definitions (rendered from the hashed AST)
  deps <name>                 direct dependencies of a definition
  dependents <name>           everything a change to <name> would affect
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
