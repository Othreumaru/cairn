import { CairnError, Decl, Expr, Param, RecEntry, T, Type } from "./ast.js";
import { lex, Token } from "./lexer.js";

// Binary operator precedence (higher binds tighter).
export const PREC: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "==": 3,
  "!=": 3,
  "<": 4,
  ">": 4,
  "<=": 4,
  ">=": 4,
  "++": 5,
  "+": 6,
  "-": 6,
  "*": 7,
  "/": 7,
  "%": 7,
};

class Parser {
  private pos = 0;
  constructor(private toks: Token[]) {}

  peek(o = 0): Token {
    return this.toks[Math.min(this.pos + o, this.toks.length - 1)];
  }
  next(): Token {
    return this.toks[this.pos++];
  }
  is(text: string, o = 0): boolean {
    const t = this.peek(o);
    return (t.kind === "op" || t.kind === "kw") && t.text === text;
  }
  expect(text: string): Token {
    const t = this.peek();
    if (!this.is(text)) throw new CairnError(`expected '${text}' but found '${t.text}'`, t.span);
    return this.next();
  }
  ident(): Token {
    const t = this.peek();
    if (t.kind !== "ident") throw new CairnError(`expected an identifier but found '${t.text}'`, t.span);
    return this.next();
  }

  // ---------- declarations ----------

  program(): Decl[] {
    const decls: Decl[] = [];
    while (this.peek().kind !== "eof") decls.push(this.decl());
    return decls;
  }

  decl(): Decl {
    const start = this.peek();
    if (this.is("test")) {
      this.next();
      const name = this.ident().text;
      this.expect("=");
      const body = this.expr();
      this.endOfDecl();
      return { kind: "test", name, sig: T.boolean, body, span: start.span };
    }
    if (this.is("def")) {
      this.next();
      const name = this.ident().text;
      if (this.is("(")) {
        // def f(a: A, b: B): R = body   ==>   f : (A, B) => R = (a: A, b: B) => body
        const lp = this.next();
        const params = this.params(true);
        this.expect(")");
        this.expect(":");
        const ret = this.type();
        this.expect("=");
        const inner = this.expr();
        this.endOfDecl();
        const sig = T.fn(
          params.map((p) => p.type!),
          ret,
        );
        return { kind: "def", name, sig, body: { t: "lam", params, body: inner, span: lp.span }, span: start.span };
      }
      this.expect(":");
      const sig = this.type();
      this.expect("=");
      const body = this.expr();
      this.endOfDecl();
      return { kind: "def", name, sig, body, span: start.span };
    }
    throw new CairnError(`expected 'def' or 'test' but found '${start.text}'`, start.span);
  }

  endOfDecl() {
    const t = this.peek();
    if (t.kind === "eof" || this.is("def") || this.is("test")) return;
    throw new CairnError(`unexpected '${t.text}' after end of declaration`, t.span);
  }

  params(requireTypes: boolean): Param[] {
    const ps: Param[] = [];
    if (this.is(")")) return ps;
    for (;;) {
      const nameTok = this.ident();
      let type: Type | undefined;
      if (this.is(":")) {
        this.next();
        type = this.type();
      } else if (requireTypes) {
        throw new CairnError(`parameter '${nameTok.text}' of a top-level def needs a type annotation`, nameTok.span);
      }
      ps.push({ name: nameTok.text, type });
      if (!this.is(",")) break;
      this.next();
    }
    return ps;
  }

  // ---------- types ----------

  type(): Type {
    const t = this.peek();
    if (t.kind === "ident" && (t.text === "number" || t.text === "string" || t.text === "boolean")) {
      this.next();
      return { k: t.text } as Type;
    }
    if (this.is("{")) {
      this.next();
      const fields: Record<string, Type> = {};
      while (!this.is("}")) {
        const f = this.ident();
        if (f.text in fields) throw new CairnError(`duplicate field '${f.text}' in record type`, f.span);
        this.expect(":");
        fields[f.text] = this.type();
        if (!this.is(",")) break;
        this.next();
      }
      this.expect("}");
      return T.record(fields);
    }
    if (this.is("(")) {
      this.next();
      const params: Type[] = [];
      while (!this.is(")")) {
        // Parameter names in function types are optional documentation: (x: number) => number
        if (this.peek().kind === "ident" && this.is(":", 1)) {
          this.next();
          this.next();
        }
        params.push(this.type());
        if (!this.is(",")) break;
        this.next();
      }
      this.expect(")");
      this.expect("=>");
      return T.fn(params, this.type());
    }
    throw new CairnError(`expected a type but found '${t.text}'`, t.span);
  }

  // ---------- expressions ----------

  expr(): Expr {
    const t = this.peek();
    if (this.is("let")) {
      this.next();
      const name = this.ident().text;
      let type: Type | undefined;
      if (this.is(":")) {
        this.next();
        type = this.type();
      }
      this.expect("=");
      const value = this.expr();
      this.expect("in");
      const body = this.expr();
      return { t: "let", name, type, value, body, span: t.span };
    }
    if (this.is("if")) {
      this.next();
      const c = this.expr();
      this.expect("then");
      const a = this.expr();
      this.expect("else");
      const b = this.expr();
      return { t: "if", c, a, b, span: t.span };
    }
    if (this.isLambdaStart()) return this.lambda();
    return this.binary(0);
  }

  isLambdaStart(): boolean {
    if (this.peek().kind === "ident" && this.is("=>", 1)) return true;
    if (!this.is("(")) return false;
    // scan to the matching ')' and check for '=>'
    let depth = 0;
    for (let k = 0; ; k++) {
      const tk = this.peek(k);
      if (tk.kind === "eof") return false;
      if (tk.kind === "op" && (tk.text === "(" || tk.text === "{")) depth++;
      if (tk.kind === "op" && (tk.text === ")" || tk.text === "}")) {
        depth--;
        if (depth === 0) return this.is("=>", k + 1);
      }
    }
  }

  lambda(): Expr {
    const start = this.peek();
    let params: Param[];
    if (start.kind === "ident") {
      params = [{ name: this.next().text }];
    } else {
      this.expect("(");
      params = this.params(false);
      this.expect(")");
    }
    this.expect("=>");
    const body = this.expr();
    return { t: "lam", params, body, span: start.span };
  }

  binary(minPrec: number): Expr {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      const p = t.kind === "op" ? PREC[t.text] : undefined;
      if (p === undefined || p <= minPrec) return left;
      this.next();
      const right = this.binary(p); // left-associative
      left = { t: "bin", op: t.text, l: left, r: right, span: t.span };
    }
  }

  unary(): Expr {
    const t = this.peek();
    if (this.is("-") || this.is("!")) {
      this.next();
      return { t: "un", op: t.text as "-" | "!", e: this.unary(), span: t.span };
    }
    return this.postfix();
  }

  postfix(): Expr {
    let e = this.primary();
    for (;;) {
      const t = this.peek();
      if (this.is(".")) {
        this.next();
        e = { t: "field", obj: e, name: this.ident().text, span: t.span };
      } else if (this.is("(")) {
        this.next();
        const args: Expr[] = [];
        while (!this.is(")")) {
          args.push(this.expr());
          if (!this.is(",")) break;
          this.next();
        }
        this.expect(")");
        e = { t: "call", fn: e, args, span: t.span };
      } else return e;
    }
  }

  primary(): Expr {
    const t = this.peek();
    if (t.kind === "num") {
      this.next();
      return { t: "num", v: t.value as number, span: t.span };
    }
    if (t.kind === "str") {
      this.next();
      return { t: "str", v: t.value as string, span: t.span };
    }
    if (this.is("true") || this.is("false")) {
      this.next();
      return { t: "bool", v: t.text === "true", span: t.span };
    }
    if (t.kind === "ident") {
      this.next();
      return { t: "var", name: t.text, span: t.span };
    }
    if (this.is("(")) {
      this.next();
      const e = this.expr();
      this.expect(")");
      return e;
    }
    if (this.is("{")) {
      this.next();
      const entries: RecEntry[] = [];
      while (!this.is("}")) {
        if (this.is("...")) {
          this.next();
          entries.push({ kind: "spread", value: this.expr() });
        } else {
          const f = this.ident();
          this.expect(":");
          entries.push({ kind: "field", name: f.text, value: this.expr() });
        }
        if (!this.is(",")) break;
        this.next();
      }
      this.expect("}");
      return { t: "rec", entries, span: t.span };
    }
    throw new CairnError(`unexpected '${t.text}'`, t.span);
  }
}

export function parseProgram(src: string): Decl[] {
  return new Parser(lex(src)).program();
}

export function parseExpr(src: string): Expr {
  const p = new Parser(lex(src));
  const e = p.expr();
  const t = p.peek();
  if (t.kind !== "eof") throw new CairnError(`unexpected '${t.text}' after expression`, t.span);
  return e;
}
