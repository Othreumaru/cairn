import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emptyState, type State } from "./codebase.ts";

/** Where state lives: `$CAIRN_HOME/state.json`, defaulting to `./.cairn`. */
export const stateFile = () => join(process.env.CAIRN_HOME ?? join(process.cwd(), ".cairn"), "state.json");

export const load = (file = stateFile()): State => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : emptyState());

/**
 * Write the whole state atomically: to a temporary file, then rename over the old one. Instances
 * serving from this file (`cairn serve`) therefore only ever read a complete state, old or new.
 */
export function save(s: State, file = stateFile()) {
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(s));
  renameSync(tmp, file);
}
