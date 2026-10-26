import { Type } from "./ast.js";

/**
 * Structural subtyping over closed, immutable records.
 *
 *  - width:  { a, b, c } <: { a, b }        (extra fields are fine)
 *  - depth:  { pet: Dog } <: { pet: Animal } (sound because records are immutable)
 *  - functions: contravariant in parameters, covariant in result
 */
export function subtype(a: Type, b: Type): boolean {
  if (a.k !== b.k) return false;
  switch (a.k) {
    case "number":
    case "string":
    case "boolean":
      return true;
    case "record": {
      const bf = (b as Extract<Type, { k: "record" }>).fields;
      return Object.keys(bf).every((f) => f in a.fields && subtype(a.fields[f], bf[f]));
    }
    case "fn": {
      const bb = b as Extract<Type, { k: "fn" }>;
      return (
        a.params.length === bb.params.length &&
        a.params.every((p, i) => subtype(bb.params[i], p)) &&
        subtype(a.ret, bb.ret)
      );
    }
  }
}

export function typeEq(a: Type, b: Type): boolean {
  return subtype(a, b) && subtype(b, a);
}

/** Least upper bound, used when synthesising the type of `if` without an expected type. */
export function lub(a: Type, b: Type): Type | undefined {
  if (subtype(a, b)) return b;
  if (subtype(b, a)) return a;
  if (a.k === "record" && b.k === "record") {
    const fields: Record<string, Type> = {};
    for (const f of Object.keys(a.fields)) {
      if (!(f in b.fields)) continue;
      const j = lub(a.fields[f], b.fields[f]);
      if (j) fields[f] = j;
    }
    return { k: "record", fields };
  }
  return undefined;
}

export function isPrim(t: Type): boolean {
  return t.k === "number" || t.k === "string" || t.k === "boolean";
}
