import { CairnError, type Expr, T, type Type } from "./ast.ts";
import { showType } from "./pretty.ts";
import { isPrim } from "./types.ts";

/**
 * Operators are versioned builtins. A version holds the operator's typing rule and its behaviour,
 * so a change to either is a new version, and code keeps the version it was hashed against
 * until `cairn upgrade` moves it. Like builtins, versions are never edited or removed.
 *
 * Hash-form `bin` and `un` nodes record the version as `v`, left out when it is 1, so code
 * written before operators were versioned keeps its hash.
 */

/** What an operator's typing rule may ask of the checker. */
export type OperandTyping = {
  check(e: Expr, t: Type): void;
  synth(e: Expr): Type;
  fail(message: string): never;
};

export type OperatorVersion = {
  synth: (t: OperandTyping, operands: Expr[]) => Type;
  /** Operand values, or thunks that evaluate them when `lazy` (for short-circuiting). */
  impl: (...operands: any[]) => any;
  lazy?: true;
};

export type Operator = { current: number; versions: Record<number, OperatorVersion> };

/** The name a unary operator is pinned and reported under; binary operators use their symbol. */
export const unaryKey = (op: "-" | "!") => (op === "-" ? "unary -" : op);

const fixed =
  (params: Type[], ret: Type) =>
  (t: OperandTyping, operands: Expr[]): Type => {
    operands.forEach((o, i) => t.check(o, params[i]));
    return ret;
  };

const arith = (impl: (l: number, r: number) => number) => v1({ synth: fixed([T.number, T.number], T.number), impl });
const compare = (impl: (l: number, r: number) => boolean) => v1({ synth: fixed([T.number, T.number], T.boolean), impl });
const logic = (impl: (l: () => boolean, r: () => boolean) => boolean) => v1({ synth: fixed([T.boolean, T.boolean], T.boolean), impl, lazy: true });

/** `==` and `!=` compare two values of the same primitive type. */
const equality = (op: string, impl: (l: unknown, r: unknown) => boolean) =>
  v1({
    synth: (t, [l, r]) => {
      const lt = t.synth(l);
      if (!isPrim(lt)) t.fail(`'${op}' compares number, string or boolean values, not ${showType(lt)}`);
      t.check(r, lt);
      return T.boolean;
    },
    impl,
  });

function v1(version: OperatorVersion): Operator {
  return { current: 1, versions: { 1: version } };
}

export const OPERATORS: Record<string, Operator> = {
  "+": arith((l, r) => l + r),
  "-": arith((l, r) => l - r),
  "*": arith((l, r) => l * r),
  "/": arith((l, r) => l / r),
  "%": arith((l, r) => l % r),
  "++": v1({ synth: fixed([T.string, T.string], T.string), impl: (l: string, r: string) => l + r }),
  "<": compare((l, r) => l < r),
  ">": compare((l, r) => l > r),
  "<=": compare((l, r) => l <= r),
  ">=": compare((l, r) => l >= r),
  "==": equality("==", (l, r) => l === r),
  "!=": equality("!=", (l, r) => l !== r),
  "&&": logic((l, r) => l() && r()),
  "||": logic((l, r) => l() || r()),
  "unary -": v1({ synth: fixed([T.number], T.number), impl: (n: number) => -n }),
  "!": v1({ synth: fixed([T.boolean], T.boolean), impl: (b: boolean) => !b }),
};

/** One version of an operator; refuses a version this runtime does not have. */
export function operator(name: string, v: number): OperatorVersion {
  const o = OPERATORS[name];
  if (!o) throw new CairnError(`unknown operator '${name}'`);
  const version = o.versions[v];
  if (!version) throw new CairnError(`this runtime cannot run '${name}'@${v} (it supports ${Object.keys(o.versions).map((n) => `@${n}`).join(", ")})`);
  return version;
}
