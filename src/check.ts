import { CairnError, Expr, T, Type } from "./ast.js";
import { BUILTINS } from "./builtins.js";
import { showExpr, showType } from "./pretty.js";
import { isPrim, lub, subtype } from "./types.js";

/**
 * Bidirectional type checking.
 *
 *   synth(e)     – "what type does e produce?"         (type flows up)
 *   check(e, T)  – "does e fit the expected type T?"    (type flows down)
 *
 * Annotations are required on top-level signatures; inside bodies, expected types
 * flow into lambdas and record literals (contextual typing), so `apply(x => x * 2, 21)`
 * needs no annotation on `x`.
 */

/** Resolves a global (top-level or builtin) name to its declared type. */
export type Globals = (name: string) => Type | undefined;

type Locals = ReadonlyMap<string, Type>;

const err = (msg: string, e: Expr) => new CairnError(msg, e.span, e);

export class Checker {
  constructor(private globals: Globals) {}

  lookup(name: string, locals: Locals, e: Expr): Type {
    const t = locals.get(name) ?? this.globals(name) ?? BUILTINS[name]?.type;
    if (!t) throw err(`unknown name '${name}'`, e);
    return t;
  }

  synth(e: Expr, locals: Locals): Type {
    switch (e.t) {
      case "num":
        return T.number;
      case "str":
        return T.string;
      case "bool":
        return T.boolean;
      case "var":
        return this.lookup(e.name, locals, e);
      case "ref":
      case "cref":
      case "builtin":
        throw err(`internal: hash-form node in checker`, e);

      case "lam": {
        const inner = new Map(locals);
        for (const p of e.params) {
          if (!p.type)
            throw err(
              `cannot infer the type of parameter '${p.name}' here — annotate it, or pass the lambda where a function type is expected`,
              e,
            );
          inner.set(p.name, p.type);
        }
        return T.fn(
          e.params.map((p) => p.type!),
          this.synth(e.body, inner),
        );
      }

      case "call": {
        const ft = this.synth(e.fn, locals);
        if (ft.k !== "fn") throw err(`'${showExpr(e.fn)}' is not a function (it has type ${showType(ft)})`, e);
        if (ft.params.length !== e.args.length)
          throw err(`'${showExpr(e.fn)}' expects ${ft.params.length} argument(s) but got ${e.args.length}`, e);
        e.args.forEach((a, i) => {
          try {
            this.check(a, ft.params[i], locals);
          } catch (x) {
            if (x instanceof CairnError && !x.message.startsWith("in call"))
              throw new CairnError(`in call ${showExpr(e)}, argument ${i + 1}: ${x.message}`, x.span ?? e.span, x.node ?? e);
            throw x;
          }
        });
        return ft.ret;
      }

      case "field": {
        const ot = this.synth(e.obj, locals);
        if (ot.k !== "record") throw err(`cannot read field '${e.name}' of non-record type ${showType(ot)}`, e);
        const ft = ot.fields[e.name];
        if (!ft) throw err(`no field '${e.name}' on ${showExpr(e.obj)} : ${showType(ot)}`, e);
        return ft;
      }

      case "rec": {
        const fields: Record<string, Type> = {};
        const explicit = new Set<string>();
        for (const en of e.entries) {
          if (en.kind === "spread") {
            const st = this.synth(en.value, locals);
            if (st.k !== "record") throw err(`can only spread a record, got ${showType(st)}`, en.value);
            Object.assign(fields, st.fields);
          } else {
            if (explicit.has(en.name)) throw err(`duplicate field '${en.name}' in record literal`, e);
            explicit.add(en.name);
            fields[en.name] = this.synth(en.value, locals);
          }
        }
        return T.record(fields);
      }

      case "bin":
        return this.synthBin(e as Extract<Expr, { t: "bin" }>, locals);

      case "un":
        if (e.op === "-") {
          this.check(e.e, T.number, locals);
          return T.number;
        }
        this.check(e.e, T.boolean, locals);
        return T.boolean;

      case "if": {
        this.check(e.c, T.boolean, locals);
        const a = this.synth(e.a, locals);
        const b = this.synth(e.b, locals);
        const j = lub(a, b);
        if (!j) throw err(`branches of 'if' have incompatible types ${showType(a)} and ${showType(b)}`, e);
        return j;
      }

      case "let": {
        const vt = e.type ? (this.check(e.value, e.type, locals), e.type) : this.synth(e.value, locals);
        const inner = new Map(locals);
        inner.set(e.name, vt);
        return this.synth(e.body, inner);
      }
    }
  }

  private synthBin(e: Extract<Expr, { t: "bin" }>, locals: Locals): Type {
    switch (e.op) {
      case "+":
      case "-":
      case "*":
      case "/":
      case "%":
        this.check(e.l, T.number, locals);
        this.check(e.r, T.number, locals);
        return T.number;
      case "++":
        this.check(e.l, T.string, locals);
        this.check(e.r, T.string, locals);
        return T.string;
      case "<":
      case ">":
      case "<=":
      case ">=":
        this.check(e.l, T.number, locals);
        this.check(e.r, T.number, locals);
        return T.boolean;
      case "&&":
      case "||":
        this.check(e.l, T.boolean, locals);
        this.check(e.r, T.boolean, locals);
        return T.boolean;
      case "==":
      case "!=": {
        const lt = this.synth(e.l, locals);
        if (!isPrim(lt)) throw err(`'${e.op}' compares number, string or boolean values, not ${showType(lt)}`, e);
        this.check(e.r, lt, locals);
        return T.boolean;
      }
    }
    throw err(`unknown operator '${e.op}'`, e);
  }

  check(e: Expr, expected: Type, locals: Locals): void {
    // Lambda against a function type: unannotated parameters take the expected types.
    if (e.t === "lam" && expected.k === "fn") {
      if (e.params.length !== expected.params.length)
        throw err(`expected a function of ${expected.params.length} parameter(s), got ${e.params.length}`, e);
      const inner = new Map(locals);
      e.params.forEach((p, i) => {
        const want = expected.params[i];
        if (p.type && !subtype(want, p.type))
          throw err(`parameter '${p.name}: ${showType(p.type)}' cannot accept ${showType(want)}`, e);
        inner.set(p.name, p.type ?? want);
      });
      this.check(e.body, expected.ret, inner);
      return;
    }

    // Record literal against a record type: push field types down into each field.
    if (e.t === "rec" && expected.k === "record" && e.entries.every((en) => en.kind === "field")) {
      const given = new Set<string>();
      for (const en of e.entries) {
        if (en.kind !== "field") continue;
        if (given.has(en.name)) throw err(`duplicate field '${en.name}' in record literal`, e);
        given.add(en.name);
        const want = expected.fields[en.name];
        if (want) this.check(en.value, want, locals);
        else this.synth(en.value, locals); // extra field: allowed by width subtyping
      }
      const missing = Object.keys(expected.fields).filter((f) => !given.has(f));
      if (missing.length) throw err(`record is missing field(s) ${missing.map((m) => `'${m}'`).join(", ")} required by ${showType(expected)}`, e);
      return;
    }

    if (e.t === "if") {
      this.check(e.c, T.boolean, locals);
      this.check(e.a, expected, locals);
      this.check(e.b, expected, locals);
      return;
    }

    if (e.t === "let") {
      const vt = e.type ? (this.check(e.value, e.type, locals), e.type) : this.synth(e.value, locals);
      const inner = new Map(locals);
      inner.set(e.name, vt);
      this.check(e.body, expected, inner);
      return;
    }

    // Mode switch: synthesise, then require the result to be a subtype.
    const got = this.synth(e, locals);
    if (!subtype(got, expected)) throw err(`expected ${showType(expected)} but got ${showType(got)}${describeGap(got, expected)}`, e);
  }
}

/** Explain *why* a record is not a subtype — the most useful bit of an error. */
function describeGap(got: Type, want: Type): string {
  if (got.k === "record" && want.k === "record") {
    const missing = Object.keys(want.fields).filter((f) => !(f in got.fields));
    if (missing.length) return ` (missing field${missing.length > 1 ? "s" : ""} ${missing.join(", ")})`;
    const bad = Object.keys(want.fields).filter((f) => !subtype(got.fields[f], want.fields[f]));
    if (bad.length) return ` (field ${bad[0]}: ${showType(got.fields[bad[0]])} is not ${showType(want.fields[bad[0]])})`;
  }
  return "";
}
