import { http } from "./http.js";
import type { Plugin } from "./types.js";
import { ws } from "./ws.js";

/** The plugins this build knows. A binding names one of these; its version is pinned in the hash. */
export const PLUGINS: Record<string, Plugin> = { http, ws };
