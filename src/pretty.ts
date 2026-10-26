import { Decl, Expr, Type } from "./ast.js";
import { PREC } from "./parser.js";

export function showType(t: Type): string {
  switch (t.k) {
    case "number":
    case "string":
    case "boolean":
      return t.k;
    case "record": {
      const fs = Object.keys(t.fields)
        .sort()
        .map((f) => `${f}: ${showType(t.fields[f])}`);
      return fs.length ? `{ ${fs.join(", ")} }` : "{}";
    }
    case "fn":
      return `(${t.params.map(showType).join(", ")}) => ${showType(t.ret)}`;
  }
}

// Precedence levels for printing: lower = looser.
const LOOSE = 0; // let / if / lambda
const UNARY = 8;
const POSTFIX = 9;

function prec(e: Expr): number {
  switch (e.t) {
    case "let":
    case "if":
    case "lam":
      return LOOSE;
    case "bin":
      return PREC[e.op];
    case "un":
      return UNARY;
    default:
      return POSTFIX;
  }
}

/** Pretty-print a name-form expression. Hash-form nodes print as #hash for debugging. */
export function showExpr(e: Expr, ctx = LOOSE): string {
  const wrap = (s: string, p: number) => (p < ctx ? `(${s})` : s);
  switch (e.t) {
    case "num":
      return String(e.v);
    case "str":
      return JSON.stringify(e.v);
    case "bool":
      return String(e.v);
    case "var":
      return e.name;
    case "builtin":
      return e.name;
    case "ref":
      return `#${e.hash.slice(0, 8)}`;
    case "cref":
      return `#cycle.${e.index}`;
    case "lam": {
      const ps = e.params.map((p) => (p.type ? `${p.name}: ${showType(p.type)}` : p.name));
      const head = ps.length === 1 && !e.params[0].type ? ps[0] : `(${ps.join(", ")})`;
      return wrap(`${head} => ${showExpr(e.body)}`, LOOSE);
    }
    case "call":
      return `${showExpr(e.fn, POSTFIX)}(${e.args.map((a) => showExpr(a)).join(", ")})`;
    case "field":
      return `${showExpr(e.obj, POSTFIX)}.${e.name}`;
    case "rec": {
      const parts = e.entries.map((en) => (en.kind === "spread" ? `...${showExpr(en.value)}` : `${en.name}: ${showExpr(en.value)}`));
      return parts.length ? `{ ${parts.join(", ")} }` : "{}";
    }
    case "bin": {
      const p = PREC[e.op];
      // left-assoc: right operand needs strictly higher precedence
      return wrap(`${showExpr(e.l, p)} ${e.op} ${showExpr(e.r, p + 1)}`, p);
    }
    case "un":
      return wrap(`${e.op}${showExpr(e.e, UNARY)}`, UNARY);
    case "if":
      return wrap(`if ${showExpr(e.c)} then ${showExpr(e.a)} else ${showExpr(e.b)}`, LOOSE);
    case "let": {
      const ann = e.type ? `: ${showType(e.type)}` : "";
      return wrap(`let ${e.name}${ann} = ${showExpr(e.value)} in ${showExpr(e.body)}`, LOOSE);
    }
  }
}

export function showDecl(d: Decl): string {
  if (d.kind === "test") return `test ${d.name} = ${showExpr(d.body)}`;
  // Re-sugar `def f(a: A): R = body` when the body is a fully annotated lambda matching the sig.
  if (d.sig.k === "fn" && d.body.t === "lam" && d.body.params.every((p) => p.type)) {
    const ps = d.body.params.map((p) => `${p.name}: ${showType(p.type!)}`).join(", ");
    return `def ${d.name}(${ps}): ${showType(d.sig.ret)} = ${showExpr(d.body.body)}`;
  }
  return `def ${d.name}: ${showType(d.sig)} = ${showExpr(d.body)}`;
}
