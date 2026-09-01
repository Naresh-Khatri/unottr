import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export interface AppPaths {
  data: string;
  cache: string;
  state: string;
  logs: string;
}

/** Electron-free path policy for startup and tests */
export function resolvePaths(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): AppPaths {
  const join = platform === "win32" ? win32.join : posix.join;

  // one override isolates every mutable path
  const override = env.UNOTTR_DATA_DIR || undefined;
  const cacheOverride = env.UNOTTR_CACHE_DIR || undefined;
  const stateOverride = env.UNOTTR_STATE_DIR || undefined;

  if (platform === "win32") {
    const local = env.LOCALAPPDATA || join(home, "AppData", "Local");
    const root = override ?? join(local, "unottr");
    const cache = cacheOverride ?? join(root, "cache");
    const state = stateOverride ?? join(root, "state");
    return { data: root, cache, state, logs: join(state, "logs") };
  }

  if (platform === "darwin") {
    const data = override ?? join(home, "Library", "Application Support", "unottr");
    const cache =
      cacheOverride ??
      (override ? join(override, "cache") : join(home, "Library", "Caches", "unottr"));
    const state =
      stateOverride ??
      (override ? join(override, "state") : join(home, "Library", "Logs", "unottr"));
    return {
      data,
      cache,
      state,
      logs: stateOverride ? state : override ? join(state, "logs") : state,
    };
  }

  const xdg = (key: string, fallback: string): string => env[key] || join(home, fallback);
  const data = override ?? join(xdg("XDG_DATA_HOME", ".local/share"), "unottr");
  const cache =
    cacheOverride ??
    (override ? join(override, "cache") : join(xdg("XDG_CACHE_HOME", ".cache"), "unottr"));
  const state =
    stateOverride ??
    (override ? join(override, "state") : join(xdg("XDG_STATE_HOME", ".local/state"), "unottr"));
  return { data, cache, state, logs: join(state, "logs") };
}

export const paths = resolvePaths();

const nativeJoin = process.platform === "win32" ? win32.join : posix.join;

export const dbFile = (): string => nativeJoin(paths.data, "unottr.db");
export const modelsDir = (): string => nativeJoin(paths.data, "models");
export const pcmCacheDir = (): string => nativeJoin(paths.cache, "pcm");
export const thumbsCacheDir = (): string => nativeJoin(paths.cache, "thumbs");
export const logsDir = (): string => paths.logs;
