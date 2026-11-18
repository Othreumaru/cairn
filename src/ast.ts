// Core data structures shared by every stage of the pipeline.
//
// Expressions exist in two forms:
//   * name-form  – what the parser produces; globals are referenced by `var` name.
//   * hash-form  – what the codebase stores; globals are `ref` (by hash), cycle peers
//                  are `cref` (by index in their group), builtins are `builtin`,
//                  and every local binder is renamed to its de Bruijn *level* (`_0`, `_1`, …)
//                  so that renaming a local never changes a hash.

export type Span = { line: number; col: number };

export type Type =
  | { k: "number" }
  | { k: "string" }
  | { k: "boolean" }
  | { k: "record"; fields: Record<string, Type> }
  | { k: "fn"; params: Type[]; ret: Type };

export const T = {
  number: { k: "number" } as Type,
  string: { k: "string" } as Type,
  boolean: { k: "boolean" } as Type,
  record: (fields: Record<string, Type>): Type => ({ k: "record", fields }),
  fn: (params: Type[], ret: Type): Type => ({ k: "fn", params, ret }),
};

export type Param = { name: string; type?: Type };

export type RecEntry =
  | { kind: "field"; name: string; value: Expr }
  | { kind: "spread"; value: Expr };

export type Expr =
  | { t: "num"; v: number; span?: Span }
  | { t: "str"; v: string; span?: Span }
  | { t: "bool"; v: boolean; span?: Span }
  | { t: "var"; name: string; span?: Span }
  | { t: "ref"; hash: string; span?: Span } // hash-form only
  | { t: "cref"; index: number; span?: Span } // hash-form only
  | { t: "builtin"; name: string; v: number; span?: Span } // hash-form only; `v` pins the builtin's version
  | { t: "lam"; params: Param[]; body: Expr; span?: Span }
  | { t: "call"; fn: Expr; args: Expr[]; span?: Span }
  | { t: "field"; obj: Expr; name: string; span?: Span }
  | { t: "rec"; entries: RecEntry[]; span?: Span }
  | { t: "bin"; op: string; l: Expr; r: Expr; span?: Span }
  | { t: "un"; op: "-" | "!"; e: Expr; span?: Span }
  | { t: "if"; c: Expr; a: Expr; b: Expr; span?: Span }
  | { t: "let"; name: string; type?: Type; value: Expr; body: Expr; span?: Span };

export type DeclKind = "def" | "test";

/** A literal argument to a binding: `@http("POST /quote")`. */
export type BindingArg = string | number | boolean;

/**
 * `@plugin(args) def f(...)` attaches a def to a plugin (an HTTP route, a WebSocket path, ...).
 * The plugin's version is stamped in when the def is staged, and is part of the hash.
 */
export type Binding = { plugin: string; version?: number; args: BindingArg[] };

/** A top-level declaration as written in a source file (name-form). */
export type Decl = {
  kind: DeclKind;
  name: string;
  sig: Type; // tests always have sig = boolean
  body: Expr;
  span: Span;
  builtins?: Record<string, number>; // pinned builtin versions (set when rebuilt from the store); absent = current
  binding?: Binding; // set for `@plugin(...) def`; part of the hash
};

export class CairnError extends Error {
  span?: Span;
  node?: Expr;
  constructor(message: string, span?: Span, node?: Expr) {
    super(message);
    this.span = span;
    this.node = node;
  }
}
