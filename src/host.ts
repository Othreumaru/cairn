import { unwatchFile, watchFile } from "node:fs";
import { boundIn, nsId, type State } from "./codebase.ts";
import { Evaluator } from "./eval.ts";
import { short } from "./hash.ts";
import { PLUGINS } from "./plugins/index.ts";
import type { Runtime } from "./plugins/types.ts";
import { load } from "./store.ts";

/** Evaluation budget for one call into Cairn code from a plugin (a request, a message, ...). */
const FUEL = 200_000;

/** The runtime plugins see. `current` supplies the state being served. */
export function runtimeFor(current: () => State, log: (line: string) => void = console.log): Runtime {
  return {
    state: current,
    bound: (state, plugin) => (state.live ? boundIn(state, state.live, plugin) : []),
    invoke: (state, hash, input) => {
      const ev = new Evaluator((h) => state.entries[h], FUEL);
      return ev.apply(ev.global(hash), [input]);
    },
    label: (state) => (state.live ? `ns${short(nsId(state.live))}` : undefined),
    log,
  };
}

/**
 * Serve `live` from the state file through the entry-point plugins given ports, and switch to a
 * new `live` as soon as a deploy or rollback rewrites the file (saves are atomic renames, so a
 * read never sees a half-written state).
 */
export function host(file: string, ports: Record<string, number>, log: (line: string) => void = console.log) {
  let state = load(file);
  const rt = runtimeFor(() => state, log);
  const reload = () => {
    let next: State;
    try {
      next = load(file);
    } catch {
      return; // mid-write on a filesystem without atomic rename; the next poll will see it
    }
    const prev = state;
    state = next;
    const [was, now] = [rt.label(prev), rt.label(next)];
    if (was === now) return;
    const who = Object.entries(ports).map(([p, port]) => `${p} :${port}`).join(", ");
    log(`[${who}] now serving ${now ?? "(nothing deployed)"} (was ${was ?? "(nothing deployed)"})`);
    for (const p of Object.values(PLUGINS)) p.onLive?.(rt, prev, next);
  };
  watchFile(file, { interval: 50 }, reload);

  const running = Object.entries(ports).map(([name, port]) => {
    const plugin = PLUGINS[name];
    if (!plugin?.start) throw new Error(`'${name}' is not an entry-point plugin`);
    return plugin.start(rt, { port });
  });
  return {
    stop: () => {
      unwatchFile(file, reload);
      for (const r of running) r.stop();
    },
  };
}
