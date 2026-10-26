import { CairnError, Span } from "./ast.js";

export type TokKind = "num" | "str" | "ident" | "kw" | "op" | "eof";

export type Token = { kind: TokKind; text: string; value?: number | string; span: Span; offset: number };

const KEYWORDS = new Set(["def", "test", "let", "in", "if", "then", "else", "true", "false"]);

// Longest operators first so `...` wins over `.`, `==` over `=`, etc.
const OPS = ["...", "=>", "==", "!=", "<=", ">=", "++", "&&", "||", "(", ")", "{", "}", ",", ":", ".", "=", "<", ">", "+", "-", "*", "/", "%", "!"];

export function lex(src: string): Token[] {
  const toks: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const advance = (n: number) => {
    for (let k = 0; k < n; k++) {
      if (src[i] === "\n") {
        line++;
        col = 1;
      } else col++;
      i++;
    }
  };

  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      advance(1);
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") advance(1);
      continue;
    }
    const span = { line, col };
    const offset = i;

    if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(i))!;
      toks.push({ kind: "num", text: m[0], value: Number(m[0]), span, offset });
      advance(m[0].length);
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      const text = m[0];
      if (text.startsWith("_")) {
        throw new CairnError(`identifiers may not start with '_' (reserved for normalised locals): ${text}`, span);
      }
      toks.push({ kind: KEYWORDS.has(text) ? "kw" : "ident", text, span, offset });
      advance(text.length);
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\n") throw new CairnError("unterminated string literal", span);
        if (src[j] === "\\") {
          const e = src[j + 1];
          out += e === "n" ? "\n" : e === "t" ? "\t" : e;
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      if (j >= src.length) throw new CairnError("unterminated string literal", span);
      toks.push({ kind: "str", text: src.slice(i, j + 1), value: out, span, offset });
      advance(j + 1 - i);
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      toks.push({ kind: "op", text: op, span, offset });
      advance(op.length);
      continue;
    }
    throw new CairnError(`unexpected character '${c}'`, span);
  }
  toks.push({ kind: "eof", text: "<eof>", span: { line, col }, offset: i });
  return toks;
}
