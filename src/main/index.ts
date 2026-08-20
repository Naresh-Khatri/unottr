import { app, protocol } from "electron";
import { closeDatabase } from "./db";
import { onJobCounts, startIngest, stopIngest } from "./ingest/runtime";
import { registerHandlers, setTrayAvailable } from "./ipc/handlers";
import { initLogging } from "./logging";
import { MEDIA_SCHEME, registerMediaProtocol } from "./media-protocol";
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
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on("second-instance", () => showMainWindow());

app.whenReady().then(() => {
  initLogging();
  registerMediaProtocol();
  registerHandlers();

  const tray = Tray.build();
  attachTray(tray);
  setTrayAvailable(tray !== null);
  if (tray) onJobCounts((active, total, eta) => tray.setStatus(active, total, eta));

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
  void stopIngest().finally(() => app.quit());
});

// checkpoints the wal, so a `-wal` file isn't left behind next to the database
app.on("will-quit", closeDatabase);
