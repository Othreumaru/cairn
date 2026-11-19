import { CairnError, T, type Type } from "./ast.ts";
import { OPERATORS } from "./operators.ts";

export type BuiltinImpl = (...args: any[]) => any;

export type BuiltinVersion = { type: Type; impl: BuiltinImpl };

/**
 * Builtins are versioned and immutable, like every other piece of code in the store.
 * Hash-form code pins the version it was hashed against (`{ t: "builtin", name, v }`), so
 * a builtin's version is part of every hash that uses it. To change a builtin's behaviour,
 * add a new version and point `current` at it — never edit an existing version in place:
 * stored code (and cached test results) keep referring to the old one until they are
 * upgraded with `cairn upgrade`.
 */
export type Builtin = { current: number; versions: Record<number, BuiltinVersion> };

const v1 = (type: Type, impl: BuiltinImpl): Builtin => ({ current: 1, versions: { 1: { type, impl } } });

export const BUILTINS: Record<string, Builtin> = {
  str: v1(T.fn([T.number], T.string), (n: number) => String(n)),
  len: v1(T.fn([T.string], T.number), (s: string) => s.length),
  abs: v1(T.fn([T.number], T.number), Math.abs),
  floor: v1(T.fn([T.number], T.number), Math.floor),
  round2: v1(T.fn([T.number], T.number), (n: number) => Math.round(n * 100) / 100),
  max: v1(T.fn([T.number, T.number], T.number), Math.max),
  min: v1(T.fn([T.number, T.number], T.number), Math.min),
};

/** Current version of a builtin or an operator (see operators.ts): both are pinned the same way. */
export const currentVersion = (name: string): number => (BUILTINS[name] ?? OPERATORS[name]).current;

/**
 * Editions cover changes to the language's semantics that are not one operator or builtin, such as
 * evaluation order or subtyping rules. Every definition records the edition it was written for,
 * left out of its hash when it is 1. New code gets `current`; existing code keeps its edition until
 * `cairn upgrade --edition`. A runtime refuses code from an edition it does not support.
 */
export const EDITIONS = { current: 1, supported: new Set([1]) };

export function checkEdition(edition: number, what: string): void {
  if (!EDITIONS.supported.has(edition))
    throw new CairnError(`this runtime cannot run ${what}: it was written for edition ${edition} (supported: ${[...EDITIONS.supported].join(", ")})`);
}

export function builtin(name: string, v: number): BuiltinVersion {
  const b = BUILTINS[name]?.versions[v];
  if (!b) throw new CairnError(`unknown builtin ${name}@${v}`);
  return b;
}
