import { T, Type } from "./ast.js";

export type BuiltinImpl = (...args: any[]) => any;

export const BUILTINS: Record<string, { type: Type; impl: BuiltinImpl }> = {
  str: { type: T.fn([T.number], T.string), impl: (n: number) => String(n) },
  len: { type: T.fn([T.string], T.number), impl: (s: string) => s.length },
  abs: { type: T.fn([T.number], T.number), impl: Math.abs },
  floor: { type: T.fn([T.number], T.number), impl: Math.floor },
  round2: { type: T.fn([T.number], T.number), impl: (n: number) => Math.round(n * 100) / 100 },
  max: { type: T.fn([T.number, T.number], T.number), impl: Math.max },
  min: { type: T.fn([T.number, T.number], T.number), impl: Math.min },
};
