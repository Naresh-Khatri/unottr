// Shell bits that do not need a running electron app. The tray, the window and the close
// interception can only be judged in a dev run; the autostart entry is plain file io.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const config = mkdtempSync(join(tmpdir(), "unottr-xdg-"));
process.env.XDG_CONFIG_HOME = config;
afterAll(() => rmSync(config, { recursive: true, force: true }));

vi.mock("electron", () => ({ app: { getPath: () => "/opt/unottr/unottr" } }));

const { getAutostart, setAutostart } = await import("../src/main/autostart");
const entry = join(config, "autostart", "unottr.desktop");

describe("autostart", () => {
  it("writes and removes the desktop entry", () => {
    expect(getAutostart()).toBe(false);

    setAutostart(true);
    expect(getAutostart()).toBe(true);
    const text = readFileSync(entry, "utf8");
    // --hidden is what keeps a session login from popping the window open
    expect(text).toContain('Exec="/opt/unottr/unottr" --hidden');
    expect(text).toContain("Type=Application");

    setAutostart(false);
    expect(getAutostart()).toBe(false);
    expect(existsSync(entry)).toBe(false);
  });

  it("is idempotent in both directions", () => {
    setAutostart(false);
    setAutostart(true);
    setAutostart(true);
    expect(getAutostart()).toBe(true);
    setAutostart(false);
    expect(getAutostart()).toBe(false);
  });

  it("prefers APPIMAGE over the electron binary once packaged", () => {
    process.env.APPIMAGE = "/home/u/Apps/unottr.AppImage";
    setAutostart(true);
    expect(readFileSync(entry, "utf8")).toContain('Exec="/home/u/Apps/unottr.AppImage" --hidden');
    delete process.env.APPIMAGE;
    setAutostart(false);
  });
});
