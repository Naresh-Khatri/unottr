import { readlinkSync } from "node:fs";
import { join } from "node:path";
import { app, protocol } from "electron";
import { closeDatabase, db } from "./db";
import { sweepRunning } from "./db/overviews";
import { onJobCounts, startIngest, stopIngest } from "./ingest/runtime";
import { registerHandlers, setTrayAvailable } from "./ipc/handlers";
import { initLogging } from "./logging";
import { MEDIA_SCHEME, registerMediaProtocol } from "./media-protocol";
import { closeAppleHardware } from "./system/apple";
import { ttsManager } from "./tts/manager";
import { Tray } from "./tray";
import { attachTray, createWindow, markQuitting, showMainWindow } from "./window";

// must run before app.ready. `stream` is what lets protocol.handle answer a range request
// with a 206 body; without `standard` the <video> src is treated as opaque.
protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

// a second launch focuses the running window and exits — the watcher and the queue assume
// they are the only writer of this database
if (!app.requestSingleInstanceLock()) {
  // silent otherwise: `pnpm dev` against an open packaged build just raises the old window,
  // and the dev run looks like it started and did nothing
  const pid = lockHolderPid();
  console.error(
    pid == null
      ? "[unottr] another instance already holds the lock — quit it first. exiting."
      : `[unottr] another instance (pid ${pid}) already holds the lock — quit it first ` +
        `(\`kill ${pid}\`). exiting.`,
  );
  app.exit(0);
}
app.on("second-instance", () => showMainWindow());

app.whenReady().then(() => {
  initLogging();
  registerMediaProtocol();
  registerHandlers();

  const tray = Tray.build();
  attachTray(tray);
  setTrayAvailable(tray !== null);
  if (tray) onJobCounts((active, total, eta) => tray.setStatus(active, total, eta));

  // an overview generating when the app died has no resume: the call is not checkpointable
  // and it costs money, so it fails and the user decides whether to spend again
  const swept = sweepRunning(db());
  if (swept) console.warn(`marked ${swept} interrupted overview(s) failed`);

  startIngest();
  // autostart writes `--hidden`, so a session login does not pop the window open
  createWindow(process.argv.includes("--hidden"));

  app.on("activate", () => showMainWindow());
});

// close-to-tray hides the window rather than closing it, so reaching here means the user
// turned that off (or has no tray) and a close really is a quit
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// the worker finishes its current chunk and checkpoints before the app is allowed to go —
// deliberately blocks the exit path on that, as the rust build's RunEvent::Exit did
let stopping = false;
app.on("before-quit", (e) => {
  markQuitting();
  if (stopping) return;
  stopping = true;
  e.preventDefault();
  ttsManager.shutdown();
  void stopIngest().finally(() => app.quit());
});

// checkpoints the wal, so a `-wal` file isn't left behind next to the database
app.on("will-quit", () => {
  closeAppleHardware();
  closeDatabase();
});

/** Chromium's lock is a symlink to `<hostname>-<pid>`; a hostname may itself contain dashes. */
function lockHolderPid(): number | null {
  try {
    const target = readlinkSync(join(app.getPath("userData"), "SingletonLock"));
    const pid = Number(target.slice(target.lastIndexOf("-") + 1));
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}
