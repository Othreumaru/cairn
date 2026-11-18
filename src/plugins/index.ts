import { http } from "./http.ts";
import type { Plugin } from "./types.ts";
import { ws } from "./ws.ts";

/** The plugins this build knows. A binding names one of these; its version is pinned in the hash. */
export const PLUGINS: Record<string, Plugin> = { http, ws };
