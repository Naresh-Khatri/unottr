// Port of crates/unottr-core/src/logging.rs. The rust rotated daily; electron-log rotates on
// size, which is the same promise (a log dir that cannot grow without bound) by a different
// rule. `get_log_dir` hands the ui the directory this writes into.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import log from "electron-log/main";
import { logsDir } from "./paths";

const MAX_BYTES = 5 * 1024 * 1024;

export function initLogging(): void {
  const dir = logsDir();
  mkdirSync(dir, { recursive: true });

  log.transports.file.resolvePathFn = () => join(dir, "unottr.log");
  log.transports.file.maxSize = MAX_BYTES;
  log.transports.file.level = "info";
  // stderr in dev only — a packaged AppImage has nowhere for it to go
  log.transports.console.level = app.isPackaged ? false : "debug";

  log.initialize(); // routes the renderer's console through here too
  log.errorHandler.startCatching({ showDialog: false });

  // the ported modules log with console.*; point that at the file rather than rewrite them
  Object.assign(console, log.functions);
}

export { log };
