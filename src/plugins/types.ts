import type { BindingArg, Type } from "../ast.ts";
import type { State } from "../codebase.ts";
import type { Value } from "../eval.ts";

/**
 * Plugins connect Cairn to the outside world (HTTP, WebSockets, ...). They are trusted host code,
 * and they only reach the codebase through the `Runtime` the host gives them, so plugins never
 * import the evaluator or the codebase themselves.
 */

/** A def bound to a plugin in some namespace. */
export type Bound = { name: string; hash: string; sig: Extract<Type, { k: "fn" }>; args: BindingArg[] };

export interface Runtime {
  /** The state currently served. A request should read it once and use that snapshot throughout. */
  state(): State;
  /** Defs in `live` of `state` bound to `plugin`. */
  bound(state: State, plugin: string): Bound[];
  /** Call a bound def, with the evaluation budget applied. Throws on a runtime error. */
  invoke(state: State, hash: string, input: Value): Value;
  /** `ns#1a2b3c4d` for the live namespace of `state`, or undefined when nothing is deployed. */
  label(state: State): string | undefined;
  log(line: string): void;
}

export interface Plugin {
  name: string;
  /** Recorded in the hash of every binding, so a new version is a code change (like builtins). */
  version: number;
  /** Check one binding at `update` time; throw a CairnError to refuse it. `sig` is the def's type. */
  checkBinding(args: BindingArg[], sig: Extract<Type, { k: "fn" }>, at: string): void;
  /** Check all of a namespace's bindings together (for example, that no two share a path). */
  checkAll?(bound: Bound[]): void;
  /** Entry-point plugins: start listening. Options come from the command line. */
  start?(rt: Runtime, options: { port: number }): { stop(): void };
  /** Called after the served state changed (a deploy or a rollback). */
  onLive?(rt: Runtime, prev: State, next: State): void;
}
