// Port of src-tauri/src/tray.rs: icon, menu, and the status line. `build` returns null when
// this session has no notification area to build onto — a degraded session, not a startup
// error. The window then never intercepts its close, so closing quits gracefully as usual,
// and Settings shows a permanent banner driven by `tray_available` in `get_settings`.

import { join } from "node:path";
import { Menu, Tray as ElectronTray, app, nativeImage } from "electron";
import { showMainWindow } from "./window";

/** "Idle" when nothing is running, else "Transcribing N of M". `active` is 0 or 1 today
 *  (queue concurrency is 1) but the format does not assume that. */
export const statusLine = (active: number, total: number): string =>
  active === 0 ? "Idle" : `Transcribing ${active} of ${total}`;

export class Tray {
  private active = 0;
  private total = 0;
  private explained = false;

  private constructor(private readonly icon: ElectronTray) {}

  static build(): Tray | null {
    const image = nativeImage.createFromPath(iconPath());
    if (image.isEmpty()) return null;

    try {
      const tray = new Tray(new ElectronTray(image));
      tray.icon.setToolTip("unottr");
      tray.icon.on("click", () => showMainWindow());
      tray.render();
      return tray;
    } catch (e) {
      console.warn("no tray icon this session:", e);
      return null;
    }
  }

  /** Cheap to call on every job event — electron rebuilds the menu, nothing repaints unless
   *  the text moved. */
  setStatus(active: number, total: number): void {
    if (active === this.active && total === this.total) return;
    this.active = active;
    this.total = total;
    this.render();
  }

  /** One-time "still running" tooltip on the first hide-to-tray, then left alone. The caller
   *  owns the persisted flag. */
  hintFirstHide(alreadyExplained: boolean): void {
    if (alreadyExplained || this.explained) return;
    this.explained = true;
    this.icon.setToolTip("unottr — still running here");
  }

  destroy(): void {
    this.icon.destroy();
  }

  private render(): void {
    this.icon.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Show unottr", click: () => showMainWindow() },
        { label: statusLine(this.active, this.total), enabled: false },
        { type: "separator" },
        { label: "Quit", click: () => app.quit() },
      ]),
    );
  }
}

/** Packaged, `resources/` lands next to the asar; in dev it sits in the project root. */
function iconPath(): string {
  const rel = join("resources", "icons", "32x32.png");
  return app.isPackaged ? join(process.resourcesPath, "icons", "32x32.png") : join(app.getAppPath(), rel);
}
