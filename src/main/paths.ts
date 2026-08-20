import { homedir } from "node:os";
import { join } from "node:path";

// Mirrors crates/unottr-core/src/paths.rs so both runtimes see the same install while the
// migration is in flight. UNOTTR_DATA_DIR relocates cache and state too — one env var
// fully isolates a test run.
const override = process.env.UNOTTR_DATA_DIR || undefined;

const xdg = (key: string, fallback: string): string =>
  process.env[key] || join(homedir(), fallback);

export const paths = {
  data: override ?? join(xdg("XDG_DATA_HOME", ".local/share"), "unottr"),
  cache:
    process.env.UNOTTR_CACHE_DIR ||
    (override ? join(override, "cache") : join(xdg("XDG_CACHE_HOME", ".cache"), "unottr")),
  state:
    process.env.UNOTTR_STATE_DIR ||
    (override ? join(override, "state") : join(xdg("XDG_STATE_HOME", ".local/state"), "unottr")),
};

export const dbFile = (): string => join(paths.data, "unottr.db");
export const modelsDir = (): string => join(paths.data, "models");
export const pcmCacheDir = (): string => join(paths.cache, "pcm");
export const logsDir = (): string => join(paths.state, "logs");
