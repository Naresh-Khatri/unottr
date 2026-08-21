import { describe, expect, it } from "vitest";
import {
  canGoBack, canGoForward, currentView, goBack, goForward, initHistory, pushView,
} from "../src/renderer/src/lib/history";

const key = (v: string) => v;
const walk = (start: string, ...views: string[]) =>
  views.reduce((h, v) => pushView(h, v, key), initHistory(start));

describe("history", () => {
  it("starts with nowhere to go", () => {
    const h = initHistory("library");
    expect(currentView(h)).toBe("library");
    expect(canGoBack(h)).toBe(false);
    expect(canGoForward(h)).toBe(false);
  });

  it("walks back and forward over what was pushed", () => {
    const h = walk("library", "search", "transcript:7");
    expect(currentView(goBack(h))).toBe("search");
    expect(currentView(goBack(goBack(h)))).toBe("library");
    expect(currentView(goForward(goBack(h)))).toBe("transcript:7");
  });

  it("stops at both ends instead of falling off", () => {
    const h = walk("library", "search");
    expect(goBack(goBack(goBack(h)))).toEqual({ entries: ["library", "search"], index: 0 });
    expect(currentView(goForward(h))).toBe("search");
  });

  it("ignores a push that lands on the current view", () => {
    const h = walk("library", "search");
    expect(pushView(h, "search", key)).toBe(h);
  });

  it("drops the forward entries once a new push lands", () => {
    const h = pushView(goBack(walk("library", "search", "settings")), "transcript:2", key);
    expect(h.entries).toEqual(["library", "search", "transcript:2"]);
    expect(canGoForward(h)).toBe(false);
  });

  it("caps the stack, keeping the newest entries", () => {
    const h = walk("v0", ...Array.from({ length: 80 }, (_, i) => `v${i + 1}`));
    expect(h.entries.length).toBe(50);
    expect(currentView(h)).toBe("v80");
    expect(h.entries[0]).toBe("v31");
    expect(h.index).toBe(49);
  });
});
