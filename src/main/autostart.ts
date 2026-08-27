import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { app } from "electron";

// Freedesktop autostart, which is all tauri-plugin-autostart did on linux. Electron's own
// app.setLoginItemSettings is a no-op outside macos/windows.
const dir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "autostart");
const file = join(dir, "unottr.desktop");

export function getAutostart(platform: NodeJS.Platform = process.platform): boolean {
  if (!autostartAvailable(platform)) return false;
  return existsSync(file);
}

export function setAutostart(on: boolean, platform: NodeJS.Platform = process.platform): void {
  if (!autostartAvailable(platform)) return;
  if (!on) {
    rmSync(file, { force: true });
    return;
  }
  // packaged runs set APPIMAGE; a dev run points at the electron binary, which is enough
  // to exercise the toggle but not to actually launch the app
  const exec = process.env.APPIMAGE ?? app.getPath("exe");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    file,
    [
      "[Desktop Entry]",
      "Type=Application",
      "Name=unottr",
      "Comment=Local transcription of screen recordings",
      `Exec="${exec}" --hidden`,
      "Terminal=false",
      "X-GNOME-Autostart-enabled=true",
      "",
    ].join("\n"),
  );
}

/** mac login items deferred */
export function autostartAvailable(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "linux";
}
