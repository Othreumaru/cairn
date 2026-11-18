import { invert, type Namespace, type State } from "./codebase.ts";
import { coverage } from "./coverage.ts";
import { short } from "./hash.ts";

/**
 * Every place Cairn's guarantees stop, as structured data: code that may not terminate
 * (`partial def`), code reached by trusted plugin code (bindings), and code no test fully exercises.
 * A reviewer, human or AI, can start here instead of reading every change equally.
 */

export type RiskKind = "partial" | "binding" | "untested";
export type Risk = { kind: RiskKind; name: string; hash: string; detail: string };

/** Risks in `ns`; with `onlyChangedSince`, only for definitions whose hash is not in that namespace. */
export function risks(state: State, ns: Namespace, onlyChangedSince?: Namespace | null): Risk[] {
  const names = invert(ns);
  const old = new Set(Object.values(onlyChangedSince ?? {}));
  const include = (h: string) => onlyChangedSince === undefined || !old.has(h);
  const out: Risk[] = [];

  for (const name of Object.keys(ns).sort()) {
    const e = state.entries[ns[name]];
    if (!include(e.hash)) continue;
    if (e.partial) {
      const calls = e.deps.filter((h) => state.entries[h]?.partial && !e.group?.members.includes(h)).map((h) => names.get(h) ?? short(h));
      const why = e.group ? (e.group.members.length > 1 ? "mutually recursive" : "recursive") : "";
      const detail = [why, calls.length ? `calls partial ${calls.join(", ")}` : ""].filter(Boolean).join("; ") || "declared partial";
      out.push({ kind: "partial", name, hash: e.hash, detail });
    }
    if (e.binding) {
      const args = e.binding.args.map((a) => JSON.stringify(a)).join(", ");
      out.push({ kind: "binding", name, hash: e.hash, detail: `@${e.binding.plugin}(${args}): reached from trusted plugin code (${e.binding.plugin}@${e.binding.version})` });
    }
  }
  for (const d of coverage(state, ns, "all", null).defs)
    if (d.missing.length && include(d.hash)) out.push({ kind: "untested", name: d.name, hash: d.hash, detail: d.missing.join("; ") });
  return out;
}
