import { CairnError, Expr } from "./ast.js";
import { BUILTINS } from "./builtins.js";
import { Entry, short } from "./hash.js";

/**
 * Interpreter over hash-form code. Every global is fetched by hash, so a running program
 * can never pick up "the wrong version" of a dependency: the hash *is* the version.
 */

export type Value =
  | number
  | string
  | boolean
  | { tag: "rec"; fields: Readonly<Record<string, Value>> }
  | { tag: "clo"; params: string[]; body: Expr; env: Env; ctx: Entry }
  | { tag: "builtin"; name: string };

type Env = ReadonlyMap<string, Value>;

export class FuelExhausted extends CairnError {}

export class Evaluator {
  private cache = new Map<string, Value>();
  private evaluating = new Set<string>();
  fuel: number;

  constructor(
    private lookup: (hash: string) => Entry | undefined,
    fuel = 1_000_000,
  ) {
    this.fuel = fuel;
  }

  /** Value of a top-level definition, memoised per hash (definitions are pure). */
  global(hash: string): Value {
    const hit = this.cache.get(hash);
    if (hit !== undefined) return hit;
    const entry = this.lookup(hash);
    if (!entry) throw new CairnError(`missing definition ${short(hash)} in codebase`);
    if (this.evaluating.has(hash)) throw new CairnError(`definition ${entry.origName} depends on its own value (not via a function)`);
    this.evaluating.add(hash);
    try {
      const v = this.eval(entry.body, new Map(), entry);
      this.cache.set(hash, v);
      return v;
    } finally {
      this.evaluating.delete(hash);
    }
  }

  eval(e: Expr, env: Env, ctx: Entry): Value {
    switch (e.t) {
      case "num":
      case "str":
      case "bool":
        return e.v;
      case "var": {
        const v = env.get(e.name);
        if (v === undefined) throw new CairnError(`internal: unbound local ${e.name}`);
        return v;
      }
      case "ref":
        return this.global(e.hash);
      case "cref":
        return this.global(ctx.group!.members[e.index]);
      case "builtin":
        return { tag: "builtin", name: e.name };
      case "lam":
        return { tag: "clo", params: e.params.map((p) => p.name), body: e.body, env, ctx };
      case "call": {
        const f = this.eval(e.fn, env, ctx);
        const args = e.args.map((a) => this.eval(a, env, ctx));
        return this.apply(f, args);
      }
      case "field": {
        const o = this.eval(e.obj, env, ctx) as Extract<Value, { tag: "rec" }>;
        return o.fields[e.name];
      }
      case "rec": {
        const fields: Record<string, Value> = {};
        for (const en of e.entries) {
          if (en.kind === "spread") Object.assign(fields, (this.eval(en.value, env, ctx) as Extract<Value, { tag: "rec" }>).fields);
          else fields[en.name] = this.eval(en.value, env, ctx);
        }
        return { tag: "rec", fields: Object.freeze(fields) };
      }
      case "bin": {
        // short-circuit boolean operators
        if (e.op === "&&") return (this.eval(e.l, env, ctx) as boolean) && (this.eval(e.r, env, ctx) as boolean);
        if (e.op === "||") return (this.eval(e.l, env, ctx) as boolean) || (this.eval(e.r, env, ctx) as boolean);
        const l = this.eval(e.l, env, ctx) as any;
        const r = this.eval(e.r, env, ctx) as any;
        switch (e.op) {
          case "+": return l + r;
          case "-": return l - r;
          case "*": return l * r;
          case "/": return l / r;
          case "%": return l % r;
          case "++": return l + r;
          case "<": return l < r;
          case ">": return l > r;
          case "<=": return l <= r;
          case ">=": return l >= r;
          case "==": return l === r;
          case "!=": return l !== r;
        }
        throw new CairnError(`unknown operator ${e.op}`);
      }
      case "un": {
        const v = this.eval(e.e, env, ctx);
        return e.op === "-" ? -(v as number) : !(v as boolean);
      }
      case "if":
        return this.eval(e.c, env, ctx) ? this.eval(e.a, env, ctx) : this.eval(e.b, env, ctx);
      case "let": {
        const v = this.eval(e.value, env, ctx);
        const inner = new Map(env);
        inner.set(e.name, v);
        return this.eval(e.body, inner, ctx);
      }
    }
  }

  apply(f: Value, args: Value[]): Value {
    if (--this.fuel < 0) throw new FuelExhausted("evaluation budget exhausted (possible infinite recursion)");
    if (typeof f === "object" && f.tag === "builtin") return BUILTINS[f.name].impl(...args);
    if (typeof f === "object" && f.tag === "clo") {
      const inner = new Map(f.env);
      f.params.forEach((p, i) => inner.set(p, args[i]));
      return this.eval(f.body, inner, f.ctx);
    }
    throw new CairnError("internal: calling a non-function");
  }
}

export function showValue(v: Value): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v !== "object") return String(v);
  if (v.tag === "rec")
    return `{ ${Object.keys(v.fields)
      .sort()
      .map((k) => `${k}: ${showValue(v.fields[k])}`)
      .join(", ")} }`;
  if (v.tag === "builtin") return `<builtin ${v.name}>`;
  return `<function/${v.params.length}>`;
}
