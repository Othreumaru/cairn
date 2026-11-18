import { CairnError, Type } from "../ast.js";
import type { Value } from "../eval.js";

/**
 * The JSON mapping of Cairn types, shared by the plugins that speak JSON (http, ws).
 * Decoding checks a value against its type and drops fields the type does not mention;
 * encoding keeps only what the type declares, so a value carrying extra fields (width
 * subtyping) never leaks them.
 */

export class CodecError extends Error {}

/** Only data can cross a plugin boundary: no function types anywhere. */
export const isData = (t: Type): boolean => (t.k === "fn" ? false : t.k === "record" ? Object.values(t.fields).every(isData) : true);

export function decode(j: unknown, t: Type, where: string): Value {
  switch (t.k) {
    case "number":
      if (typeof j !== "number" || !Number.isFinite(j)) throw new CodecError(`${where} must be a number`);
      return j;
    case "string":
      if (typeof j !== "string") throw new CodecError(`${where} must be a string`);
      return j;
    case "boolean":
      if (typeof j !== "boolean") throw new CodecError(`${where} must be a boolean`);
      return j;
    case "record": {
      if (typeof j !== "object" || j === null || Array.isArray(j)) throw new CodecError(`${where} must be an object`);
      const fields: Record<string, Value> = {};
      for (const [f, ft] of Object.entries(t.fields)) {
        if (!(f in j)) throw new CodecError(`${where}.${f} is missing`);
        fields[f] = decode((j as Record<string, unknown>)[f], ft, `${where}.${f}`);
      }
      return { tag: "rec", fields: Object.freeze(fields) };
    }
    case "fn":
      throw new CairnError("internal: function type at a plugin boundary");
  }
}

export function encode(v: Value, t: Type): unknown {
  if (t.k !== "record") return v;
  const rec = v as Extract<Value, { tag: "rec" }>;
  return Object.fromEntries(Object.entries(t.fields).map(([f, ft]) => [f, encode(rec.fields[f], ft)]));
}
