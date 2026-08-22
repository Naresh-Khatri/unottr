// The main window: creation, remembered geometry, and the close-to-tray decision that was
// `handle_close_requested` in src-tauri/src/lib.rs.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserWindow, shell } from "electron";
import { db } from "./db";
import { closeToTrayExplained, load, markCloseToTrayExplained } from "./db/settings";
import { paths } from "./paths";
import type { Tray } from "./tray";

const DEFAULTS = { width: 1280, height: 840 };
const stateFile = (): string => join(paths.state, "window.json");

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

/** No tray -> the close is never intercepted, so it falls through to the normal graceful quit. */
export const attachTray = (t: Tray | null): void => {
  tray = t;
};

/** Set once the quit is really happening, so `close` stops meaning "hide". */
export const markQuitting = (): void => {
  quitting = true;
};

export function createWindow(hidden = false): BrowserWindow {
  const win_ = new BrowserWindow({
    ...restoreBounds(),
    // the ui folds down to an icon rail + stacked panes below this
    minWidth: 640,
    minHeight: 480,
    show: false,
    backgroundColor: "#0a0a0a",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win = win_;

  if (!hidden) win_.once("ready-to-show", () => win_.show());
  win_.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  win_.on("resized", () => saveBounds(win_));
  win_.on("moved", () => saveBounds(win_));
  win_.on("close", (e) => {
    saveBounds(win_);
    if (absorbClose()) {
      e.preventDefault();
      win_.hide();
    }
  });
  win_.on("closed", () => {
    if (win === win_) win = null;
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    // the page <title> wins otherwise, and a dev window is indistinguishable from a packaged
    // one sitting in the tray
    win_.on("page-title-updated", (e, title) => {
      e.preventDefault();
      win_.setTitle(`${title} — dev`);
    });
    void win_.loadURL(devUrl);
  } else {
    void win_.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return win_;
}

/** Tray click, "Show unottr", and a second launch all land here. */
export function showMainWindow(): void {
  const existing = win ?? createWindow();
  if (existing.isMinimized()) existing.restore();
  existing.show();
  existing.focus();
}

export const mainWindow = (): BrowserWindow | null => win;

const isDev = (): boolean => process.env.ELECTRON_RENDERER_URL != null;

/**
 * True when the close should hide to tray instead. Needs a tray to hide to, a quit that is
 * not already under way, a packaged run, and the setting left on. Marks the one-time hint
 * as it goes.
 */
function absorbClose(): boolean {
  // a dev run must never outlive its window: a hidden one keeps the single-instance lock and
  // the next `pnpm dev` dies against it
  if (quitting || !tray || isDev()) return false;
  let explained = false;
  try {
    const conn = db();
    if (!load(conn).close_to_tray) return false;
    explained = closeToTrayExplained(conn);
    if (!explained) markCloseToTrayExplained(conn);
  } catch (e) {
    console.warn("could not read close-to-tray setting; hiding anyway:", e);
  }
  tray.hintFirstHide(explained);
  return true;
}

interface Bounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
}

function restoreBounds(): Bounds {
  try {
    const saved = JSON.parse(readFileSync(stateFile(), "utf8")) as Partial<Bounds>;
    // a monitor that went away would put the window off-screen; electron clamps size but not
    // position, so only geometry that still looks sane is restored
    if (typeof saved.width === "number" && typeof saved.height === "number") {
      return { ...DEFAULTS, ...saved };
    }
  } catch {
    // no state file yet, or it is corrupt — either way the defaults are correct
  }
  return { ...DEFAULTS };
}

function saveBounds(w: BrowserWindow): void {
  if (w.isDestroyed() || w.isMinimized() || w.isFullScreen()) return;
  try {
    if (!existsSync(paths.state)) mkdirSync(paths.state, { recursive: true });
    writeFileSync(stateFile(), JSON.stringify(w.getNormalBounds()));
  } catch (e) {
    console.warn("could not persist window geometry:", e);
  }
}
