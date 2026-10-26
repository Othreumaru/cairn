import { createHash } from "node:crypto";
import { CairnError, Decl, DeclKind, Expr, Type } from "./ast.js";
import { BUILTINS } from "./builtins.js";

/**
 * Content addressing.
 *
 * A definition's hash is computed from its *normalised* AST:
 *   - references to other definitions are replaced by their hashes,
 *   - local binders are renamed to their de Bruijn level (`_0`, `_1`, …),
 *   - spans/whitespace/comments are gone, record literal fields are sorted.
 * So renaming a parameter, reformatting, or renaming a *dependency* never changes a hash,
 * while changing anything a definition transitively depends on always does.
 *
 * Mutually recursive definitions are hashed as a group (strongly connected component):
 * references inside the group become `cref(i)`, the group gets one hash, and each
 * member's hash is H(groupHash, i).
 */

export type Entry = {
  hash: string;
  kind: DeclKind;
  sig: Type;
  body: Expr; // hash-form
  deps: string[]; // hashes this entry references (incl. cycle peers)
  localNames: string[]; // original local binder names, in traversal order (metadata, not hashed)
  group?: { hash: string; index: number; members: string[] };
  origName: string; // metadata only
};

export const short = (h: string) => `#${h.slice(0, 8)}`;

export function canon(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => k !== "span" && o[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(",")}}`;
}

export const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// ---------------------------------------------------------------------------
// Free global names (for dependency graphs)

export function freeGlobals(e: Expr, bound: ReadonlySet<string> = new Set(), out = new Set<string>()): Set<string> {
  switch (e.t) {
    case "var":
      if (!bound.has(e.name)) out.add(e.name);
      break;
    case "lam": {
      const b = new Set(bound);
      e.params.forEach((p) => b.add(p.name));
      freeGlobals(e.body, b, out);
      break;
    }
    case "let": {
      freeGlobals(e.value, bound, out);
      const b = new Set(bound);
      b.add(e.name);
      freeGlobals(e.body, b, out);
      break;
    }
    case "call":
      freeGlobals(e.fn, bound, out);
      e.args.forEach((a) => freeGlobals(a, bound, out));
      break;
    case "field":
      freeGlobals(e.obj, bound, out);
      break;
    case "rec":
      e.entries.forEach((en) => freeGlobals(en.value, bound, out));
      break;
    case "bin":
      freeGlobals(e.l, bound, out);
      freeGlobals(e.r, bound, out);
      break;
    case "un":
      freeGlobals(e.e, bound, out);
      break;
    case "if":
      freeGlobals(e.c, bound, out);
      freeGlobals(e.a, bound, out);
      freeGlobals(e.b, bound, out);
      break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// name-form -> hash-form

type Resolve = (name: string) => Expr; // returns a ref / cref / builtin node

function sortRecord(e: Extract<Expr, { t: "rec" }>) {
  return e.entries.every((en) => en.kind === "field")
    ? [...e.entries].sort((a, b) => (a as { name: string }).name.localeCompare((b as { name: string }).name))
    : e.entries;
}

export function normalize(e: Expr, resolve: Resolve, scope: ReadonlyMap<string, string> = new Map(), depth = 0, names: string[] = []): Expr {
  const go = (x: Expr, s = scope, d = depth) => normalize(x, resolve, s, d, names);
  switch (e.t) {
    case "num":
    case "str":
    case "bool":
      return { t: e.t, v: e.v } as Expr;
    case "var": {
      const local = scope.get(e.name);
      return local ? { t: "var", name: local } : resolve(e.name);
    }
    case "ref":
    case "cref":
    case "builtin":
      return e;
    case "lam": {
      const s = new Map(scope);
      const params = e.params.map((p, i) => {
        const lvl = `_${depth + i}`;
        names.push(p.name);
        s.set(p.name, lvl);
        return { name: lvl, type: p.type };
      });
      return { t: "lam", params, body: go(e.body, s, depth + e.params.length) };
    }
    case "let": {
      const value = go(e.value);
      const lvl = `_${depth}`;
      names.push(e.name);
      const s = new Map(scope);
      s.set(e.name, lvl);
      return { t: "let", name: lvl, type: e.type, value, body: go(e.body, s, depth + 1) };
    }
    case "call":
      return { t: "call", fn: go(e.fn), args: e.args.map((a) => go(a)) };
    case "field":
      return { t: "field", obj: go(e.obj), name: e.name };
    case "rec":
      return {
        t: "rec",
        entries: sortRecord(e).map((en) => (en.kind === "spread" ? { kind: "spread", value: go(en.value) } : { kind: "field", name: en.name, value: go(en.value) })),
      };
    case "bin":
      return { t: "bin", op: e.op, l: go(e.l), r: go(e.r) };
    case "un":
      return { t: "un", op: e.op, e: go(e.e) };
    case "if":
      return { t: "if", c: go(e.c), a: go(e.a), b: go(e.b) };
  }
}

// ---------------------------------------------------------------------------
// hash-form -> name-form (for display and for re-checking dependents)

export function denormalize(entry: Entry, nameOf: (hash: string) => string | undefined): Decl {
  const globalsUsed = new Set<string>();
  const resolveRef = (h: string) => nameOf(h) ?? short(h);
  // first pass: which global display names appear (to avoid capture when restoring local names)
  (function collect(e: Expr) {
    if (e.t === "ref") globalsUsed.add(resolveRef(e.hash));
    else if (e.t === "cref") globalsUsed.add(resolveRef(entry.group!.members[e.index]));
    else if (e.t === "builtin") globalsUsed.add(e.name);
    for (const v of Object.values(e)) {
      if (v && typeof v === "object") {
        if (Array.isArray(v)) v.forEach((x) => x && typeof x === "object" && ("t" in x ? collect(x as Expr) : "value" in x ? collect((x as { value: Expr }).value) : 0));
        else if ("t" in v) collect(v as Expr);
      }
    }
  })(entry.body);

  let k = 0;
  const pick = (lvl: string) => {
    const orig = entry.localNames[k++] ?? lvl;
    return globalsUsed.has(orig) ? `${orig}${lvl}` : orig;
  };

  const go = (e: Expr, scope: ReadonlyMap<string, string>): Expr => {
    switch (e.t) {
      case "num":
      case "str":
      case "bool":
        return e;
      case "var":
        return { t: "var", name: scope.get(e.name) ?? e.name };
      case "ref":
        return { t: "var", name: resolveRef(e.hash) };
      case "cref":
        return { t: "var", name: resolveRef(entry.group!.members[e.index]) };
      case "builtin":
        return { t: "var", name: e.name };
      case "lam": {
        const s = new Map(scope);
        const params = e.params.map((p) => {
          const n = pick(p.name);
          s.set(p.name, n);
          return { name: n, type: p.type };
        });
        return { t: "lam", params, body: go(e.body, s) };
      }
      case "let": {
        const value = go(e.value, scope);
        const n = pick(e.name);
        const s = new Map(scope);
        s.set(e.name, n);
        return { t: "let", name: n, type: e.type, value, body: go(e.body, s) };
      }
      case "call":
        return { t: "call", fn: go(e.fn, scope), args: e.args.map((a) => go(a, scope)) };
      case "field":
        return { t: "field", obj: go(e.obj, scope), name: e.name };
      case "rec":
        return { t: "rec", entries: e.entries.map((en) => (en.kind === "spread" ? { kind: "spread", value: go(en.value, scope) } : { kind: "field", name: en.name, value: go(en.value, scope) })) };
      case "bin":
        return { t: "bin", op: e.op, l: go(e.l, scope), r: go(e.r, scope) };
      case "un":
        return { t: "un", op: e.op, e: go(e.e, scope) };
      case "if":
        return { t: "if", c: go(e.c, scope), a: go(e.a, scope), b: go(e.b, scope) };
    }
  };
  return { kind: entry.kind, name: nameOf(entry.hash) ?? entry.origName, sig: entry.sig, body: go(entry.body, new Map()), span: { line: 0, col: 0 } };
}

// ---------------------------------------------------------------------------
// Strongly connected components (Tarjan). Output order: dependencies before dependents.

export function scc(nodes: string[], edges: (n: string) => string[]): string[][] {
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  const visit = (v: string) => {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of edges(v)) {
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      out.push(comp.sort());
    }
  };
  for (const n of [...nodes].sort()) if (!idx.has(n)) visit(n);
  return out;
}

// ---------------------------------------------------------------------------
// Hash a set of (already type-checked) declarations.

/**
 * @param decls     the working set, in name-form
 * @param external  resolves names outside the working set to hashes (the current namespace)
 */
export function hashDecls(decls: Decl[], external: (name: string) => string | undefined): Map<string, Entry> {
  const byName = new Map(decls.map((d) => [d.name, d]));
  const free = new Map(decls.map((d) => [d.name, freeGlobals(d.body)]));
  const result = new Map<string, Entry>();

  const comps = scc(
    decls.map((d) => d.name),
    (n) => [...free.get(n)!].filter((m) => byName.has(m)),
  );

  for (const comp of comps) {
    const self = comp[0];
    const isCycle = comp.length > 1 || free.get(self)!.has(self);
    const resolve: Resolve = (name) => {
      if (isCycle && comp.includes(name)) return { t: "cref", index: comp.indexOf(name) };
      const local = result.get(name);
      if (local) return { t: "ref", hash: local.hash };
      const ext = byName.has(name) ? undefined : external(name);
      if (ext) return { t: "ref", hash: ext };
      if (name in BUILTINS) return { t: "builtin", name };
      throw new CairnError(`unknown name '${name}'`);
    };

    const normalised = comp.map((name) => {
      const d = byName.get(name)!;
      const localNames: string[] = [];
      const body = normalize(d.body, resolve, new Map(), 0, localNames);
      return { d, body, localNames, payload: { kind: d.kind, sig: d.sig, body } };
    });

    let hashes: string[];
    let groupHash: string | undefined;
    if (!isCycle) hashes = [sha(canon(normalised[0].payload))];
    else {
      groupHash = sha(canon({ cycle: normalised.map((n) => n.payload) }));
      hashes = normalised.map((_, i) => sha(canon({ group: groupHash, index: i })));
    }

    normalised.forEach((n, i) => {
      const deps = new Set<string>();
      (function walk(e: Expr) {
        if (e.t === "ref") deps.add(e.hash);
        for (const v of Object.values(e))
          if (v && typeof v === "object") {
            if (Array.isArray(v)) v.forEach((x) => x && typeof x === "object" && ("t" in x ? walk(x as Expr) : "value" in x ? walk((x as { value: Expr }).value) : 0));
            else if ("t" in v) walk(v as Expr);
          }
      })(n.body);
      if (isCycle) hashes.forEach((h, j) => j !== i && deps.add(h));
      result.set(n.d.name, {
        hash: hashes[i],
        kind: n.d.kind,
        sig: n.d.sig,
        body: n.body,
        deps: [...deps].sort(),
        localNames: n.localNames,
        group: isCycle ? { hash: groupHash!, index: i, members: hashes } : undefined,
        origName: n.d.name,
      });
    });
  }
  return result;
}
