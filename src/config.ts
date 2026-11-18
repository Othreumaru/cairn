import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CairnError } from "./ast.ts";
import type { CoverageScope } from "./coverage.ts";

/**
 * Project settings, read from `cairn.json` in the current directory. Unlike the state in
 * `.cairn/`, this file belongs in version control.
 *
 *   { "coverage": { "minimum": 80, "of": "changed" },
 *     "mutation": { "minimum": 70, "of": "changed" } }
 *
 * `minimum` is a percentage the deploy gate enforces (0, the default, only reports coverage and
 * skips mutation testing at deploy); `of` is "changed" (definitions new or changed since live, the
 * default) or "all".
 */
export type Policy = { minimum: number; of: CoverageScope };
export type Config = { coverage: Policy; mutation: Policy };

export const defaultConfig = (): Config => ({ coverage: { minimum: 0, of: "changed" }, mutation: { minimum: 0, of: "changed" } });

export function parseConfig(text: string, where = "cairn.json"): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CairnError(`${where} is not valid JSON`);
  }
  const config = defaultConfig();
  for (const key of ["coverage", "mutation"] as const) {
    const section = (raw as Record<string, unknown> | null)?.[key];
    if (section === undefined) continue;
    if (typeof section !== "object" || section === null) throw new CairnError(`${where}: "${key}" must be an object`);
    const { minimum, of } = section as { minimum?: unknown; of?: unknown };
    if (minimum !== undefined) {
      if (typeof minimum !== "number" || !(minimum >= 0 && minimum <= 100)) throw new CairnError(`${where}: "${key}.minimum" must be a number from 0 to 100`);
      config[key].minimum = minimum;
    }
    if (of !== undefined) {
      if (of !== "changed" && of !== "all") throw new CairnError(`${where}: "${key}.of" must be "changed" or "all"`);
      config[key].of = of;
    }
  }
  return config;
}

export function loadConfig(dir = process.cwd()): Config {
  const file = join(dir, "cairn.json");
  return existsSync(file) ? parseConfig(readFileSync(file, "utf8"), file) : defaultConfig();
}
