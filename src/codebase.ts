import { CairnError, Decl, Type } from "./ast.js";
import { BUILTINS } from "./builtins.js";
import { Checker } from "./check.js";
import { canon, denormalize, Entry, hashDecls, normalize, sha, short } from "./hash.js";
import { parseProgram } from "./parser.js";
import { showDecl, showType } from "./pretty.js";
import { subtype, typeEq } from "./types.js";

/** name -> hash. A namespace is just a pointer table; code itself is immutable. */
export type Namespace = Record<string, string>;

export type TestResult = { passed: boolean; detail: string; ms: number };

export type State = {
  entries: Record<string, Entry>; // append-only store, keyed by hash
  dev: Namespace; // what `update` writes to
  live: Namespace | null; // what the runtime serves; only `deploy` writes here
  history: { id: string; ns: Namespace; at: string }[];
  testCache: Record<string, TestResult>; // a test result is a permanent fact about a hash
};

export const emptyState = (): State => ({ entries: {}, dev: {}, live: null, history: [], testCache: {} });

export const nsId = (ns: Namespace) => sha(canon(ns));

export function invert(ns: Namespace): Map<string, string> {
  const m = new Map<string, string>();
  for (const [n, h] of Object.entries(ns).sort()) if (!m.has(h)) m.set(h, n);
  return m;
}

/** Reverse dependency index restricted to one namespace: hash -> names that reference it. */
export function dependentsIndex(state: State, ns: Namespace): Map<string, Set<string>> {
  const idx = new Map<string, Set<string>>();
  for (const [name, h] of Object.entries(ns)) {
    for (const d of state.entries[h].deps) {
      if (!idx.has(d)) idx.set(d, new Set());
      idx.get(d)!.add(name);
    }
  }
  return idx;
}

/** All names in `ns` that transitively depend on any of `roots` (hashes). */
export function transitiveDependents(state: State, ns: Namespace, roots: Iterable<string>): Set<string> {
  const idx = dependentsIndex(state, ns);
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const h = queue.shift()!;
    for (const n of idx.get(h) ?? []) {
      if (seen.has(n)) continue;
      seen.add(n);
      queue.push(ns[n]);
    }
  }
  return seen;
}

export function declOf(state: State, ns: Namespace, name: string): Decl {
  const names = invert(ns);
  return denormalize(state.entries[ns[name]], (h) => names.get(h));
}

export function view(state: State, ns: Namespace, name: string): string {
  if (!(name in ns)) throw new CairnError(`no definition named '${name}'`);
  return showDecl(declOf(state, ns, name));
}

// ---------------------------------------------------------------------------
// The update pipeline: parse -> check -> hash -> find dependents -> re-check -> report

export type ChangeKind =
  | { k: "new" }
  | { k: "alias"; of: string }
  | { k: "unchanged" }
  | { k: "modified"; typeChange: "none" | "compatible" | "incompatible"; oldType: Type; newType: Type }
  | { k: "propagated"; via: string[] }
  | { k: "broken"; error: string; via: string[] };

export type Change = { name: string; kind: ChangeKind; oldHash?: string; newHash?: string; isTest: boolean; known?: boolean };

export type UpdateReport = {
  ok: boolean;
  changes: Change[];
  fileErrors: { name: string; error: string; line?: number; col?: number }[];
  testsToRun: string[]; // tests whose hash is new and has no cached result
  testsCached: string[]; // tests in the namespace with a cached result
  applied: boolean;
};

export function update(state: State, source: string, opts: { dryRun?: boolean } = {}): UpdateReport {
  const decls = parseProgram(source);
  const report: UpdateReport = { ok: true, changes: [], fileErrors: [], testsToRun: [], testsCached: [], applied: false };

  const seen = new Set<string>();
  for (const d of decls) {
    if (seen.has(d.name)) throw new CairnError(`'${d.name}' is defined twice in this file`, d.span);
    if (d.name in BUILTINS) throw new CairnError(`'${d.name}' is a builtin and cannot be redefined`, d.span);
    seen.add(d.name);
  }

  const dev = state.dev;
  const fileNames = new Set(decls.map((d) => d.name));

  // --- Pass A: check & hash the file on its own, to learn which names really changed.
  const checkAll = (ws: Decl[]) => {
    const wsSigs = new Map(ws.map((d) => [d.name, d.sig]));
    const checker = new Checker((n) => wsSigs.get(n) ?? (n in dev ? state.entries[dev[n]].sig : undefined));
    const errors = new Map<string, CairnError>();
    for (const d of ws) {
      try {
        checker.check(d.body, d.sig, new Map());
      } catch (e) {
        if (e instanceof CairnError) errors.set(d.name, e);
        else throw e;
      }
    }
    return errors;
  };
  const external = (n: string) => dev[n];

  const fileErrs = checkAll(decls);
  if (fileErrs.size) {
    report.ok = false;
    for (const [name, e] of fileErrs) report.fileErrors.push({ name, error: e.message, line: e.span?.line, col: e.span?.col });
    return report;
  }
  const names = invert(dev);
  // Members of a mutual-recursion group are hashed together, so if the file touches one member,
  // the others must ride along in every hashing pass.
  const groupsTouched = new Set(decls.filter((d) => d.name in dev).map((d) => state.entries[dev[d.name]].group?.hash).filter(Boolean));
  const cycleMates = Object.keys(dev).filter((n) => !fileNames.has(n) && groupsTouched.has(state.entries[dev[n]].group?.hash));
  const cycleMateDecls = cycleMates.map((n) => denormalize(state.entries[dev[n]], (h) => names.get(h)));

  const passA = hashDecls([...decls, ...cycleMateDecls], external);
  const modifiedExisting = [...fileNames].filter((n) => n in dev && dev[n] !== passA.get(n)!.hash);

  // A file decl whose hash changed may be *textually* identical — it just depends on something
  // else in the file that changed. Distinguish "edited" from "rehashed because a dependency moved".
  const nameLevelKey = (d: Decl) => canon({ kind: d.kind, sig: d.sig, body: normalize(d.body, (n) => ({ t: "var", name: `@${n}` })) });
  const edited = new Set(
    modifiedExisting.filter((n) => nameLevelKey(decls.find((d) => d.name === n)!) !== nameLevelKey(denormalize(state.entries[dev[n]], (h) => names.get(h)))),
  );

  // --- Find every existing definition that (transitively) depends on a modified one.
  const affected = [...new Set([...transitiveDependents(state, dev, modifiedExisting.map((n) => dev[n])), ...cycleMates])].filter((n) => !fileNames.has(n));
  const dependentDecls = affected.map((n) => denormalize(state.entries[dev[n]], (h) => names.get(h)));

  // why is each dependent affected? (shortest path back to an edited name)
  const via = (name: string): string[] => {
    const modified = edited;
    const prev = new Map<string, string>();
    const queue = [name];
    const visited = new Set([name]);
    while (queue.length) {
      const cur = queue.shift()!;
      if (modified.has(cur)) {
        const path = [cur];
        let p = cur;
        while (prev.has(p)) path.push((p = prev.get(p)!));
        return path.reverse();
      }
      for (const dep of state.entries[dev[cur]].deps) {
        const dn = names.get(dep);
        if (dn && !visited.has(dn)) {
          visited.add(dn);
          prev.set(dn, cur);
          queue.push(dn);
        }
      }
    }
    return [name];
  };

  // --- Pass B: re-check and re-hash the whole working set (file + affected dependents).
  const workingSet = [...decls, ...dependentDecls];
  const errs = checkAll(workingSet);
  const hashed = errs.size ? undefined : hashDecls(workingSet, external);

  // reverse lookup of existing hashes (to detect aliases)
  for (const d of decls) {
    const isTest = d.kind === "test";
    const oldHash = dev[d.name];
    const newHash = (hashed ?? passA).get(d.name)!.hash;
    let kind: ChangeKind;
    if (oldHash === undefined) {
      const existing = names.get(newHash);
      kind = existing ? { k: "alias", of: existing } : { k: "new" };
    } else if (oldHash === passA.get(d.name)!.hash) kind = { k: "unchanged" };
    else if (!edited.has(d.name)) kind = { k: "propagated", via: via(d.name) };
    else {
      const oldType = state.entries[oldHash].sig;
      const tc = typeEq(oldType, d.sig) ? "none" : subtype(d.sig, oldType) ? "compatible" : "incompatible";
      kind = { k: "modified", typeChange: tc, oldType, newType: d.sig };
    }
    report.changes.push({ name: d.name, kind, oldHash, newHash, isTest });
  }
  for (const d of dependentDecls) {
    const e = errs.get(d.name);
    const isTest = d.kind === "test";
    if (e) {
      report.ok = false;
      report.changes.push({ name: d.name, kind: { k: "broken", error: e.message, via: via(d.name) }, oldHash: dev[d.name], isTest });
    } else if (hashed?.get(d.name)?.hash !== dev[d.name])
      report.changes.push({ name: d.name, kind: { k: "propagated", via: via(d.name) }, oldHash: dev[d.name], newHash: hashed?.get(d.name)?.hash, isTest });
  }

  for (const c of report.changes) if (c.newHash && c.newHash !== c.oldHash && state.entries[c.newHash]) c.known = true;
  if (!report.ok || !hashed) return report;

  // --- Commit: new entries are appended; the dev namespace pointers move.
  const nextDev: Namespace = { ...dev };
  for (const [name, entry] of hashed) nextDev[name] = entry.hash;
  for (const [name, h] of Object.entries(nextDev)) {
    const entry = hashed.get(name) ?? state.entries[h];
    if (entry.kind !== "test") continue;
    if (state.testCache[h]) report.testsCached.push(name);
    else report.testsToRun.push(name);
  }
  if (!opts.dryRun) {
    for (const entry of hashed.values()) state.entries[entry.hash] = entry;
    state.dev = nextDev;
    report.applied = true;
  }
  return report;
}

// ---------------------------------------------------------------------------
// Namespace-only operations: free, because no code changes.

export function rename(state: State, from: string, to: string) {
  if (!(from in state.dev)) throw new CairnError(`no definition named '${from}'`);
  if (to in state.dev) throw new CairnError(`'${to}' already exists`);
  if (to in BUILTINS) throw new CairnError(`'${to}' is a builtin`);
  const next = { ...state.dev, [to]: state.dev[from] };
  delete next[from];
  state.dev = next;
}

export function remove(state: State, name: string) {
  if (!(name in state.dev)) throw new CairnError(`no definition named '${name}'`);
  const users = transitiveDependents(state, state.dev, [state.dev[name]]);
  users.delete(name);
  if (users.size) throw new CairnError(`cannot delete '${name}': still used by ${[...users].sort().join(", ")}`);
  const next = { ...state.dev };
  delete next[name];
  state.dev = next;
}

export function describeChange(c: Change): string {
  const line = describeChangeKind(c);
  return c.known ? `${line}  [known hash]` : line;
}

function describeChangeKind(c: Change): string {
  const arrow = c.oldHash && c.newHash && c.oldHash !== c.newHash ? `${short(c.oldHash)} → ${short(c.newHash)}` : c.newHash ? short(c.newHash) : c.oldHash ? short(c.oldHash) : "";
  const k = c.kind;
  switch (k.k) {
    case "new":
      return `+ ${c.name}  ${arrow}  new`;
    case "alias":
      return `+ ${c.name}  ${arrow}  new name for existing code (same hash as '${k.of}')`;
    case "unchanged":
      return `= ${c.name}  ${arrow}  unchanged`;
    case "modified": {
      const t =
        k.typeChange === "none"
          ? "body changed, type unchanged"
          : k.typeChange === "compatible"
            ? `type changed compatibly: ${showType(k.oldType)}  ⟶  ${showType(k.newType)} (new <: old)`
            : `type changed INCOMPATIBLY: ${showType(k.oldType)}  ⟶  ${showType(k.newType)}`;
      return `~ ${c.name}  ${arrow}  ${t}`;
    }
    case "propagated":
      return c.newHash
        ? `↻ ${c.name}  ${arrow}  re-checked OK, rehashed (via ${k.via.join(" ← ")})`
        : `↻ ${c.name}  ${arrow}  still type-checks (via ${k.via.join(" ← ")})`;
    case "broken":
      return `✗ ${c.name}  ${arrow}  BROKEN (via ${k.via.join(" ← ")}): ${k.error}`;
  }
}
