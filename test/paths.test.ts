import { describe, expect, it } from "vitest";
import { resolvePaths } from "../src/main/paths";

describe("application paths", () => {
  it("uses native macOS Library directories", () => {
    expect(resolvePaths("darwin", "/Users/tester", {})).toEqual({
      data: "/Users/tester/Library/Application Support/unottr",
      cache: "/Users/tester/Library/Caches/unottr",
      state: "/Users/tester/Library/Logs/unottr",
      logs: "/Users/tester/Library/Logs/unottr",
    });
  });

  it("keeps Linux XDG paths", () => {
    expect(
      resolvePaths("linux", "/home/tester", {
        XDG_DATA_HOME: "/data",
        XDG_CACHE_HOME: "/cache",
        XDG_STATE_HOME: "/state",
      }),
    ).toEqual({
      data: "/data/unottr",
      cache: "/cache/unottr",
      state: "/state/unottr",
      logs: "/state/unottr/logs",
    });
  });

  it("lets one data override isolate every mutable Mac path", () => {
    expect(resolvePaths("darwin", "/Users/tester", { UNOTTR_DATA_DIR: "/tmp/unottr-test" })).toEqual({
      data: "/tmp/unottr-test",
      cache: "/tmp/unottr-test/cache",
      state: "/tmp/unottr-test/state",
      logs: "/tmp/unottr-test/state/logs",
    });
  });

  it("honors explicit cache and state overrides on macOS", () => {
    expect(
      resolvePaths("darwin", "/Users/tester", {
        UNOTTR_CACHE_DIR: "/tmp/cache",
        UNOTTR_STATE_DIR: "/tmp/logs",
      }),
    ).toMatchObject({ cache: "/tmp/cache", state: "/tmp/logs", logs: "/tmp/logs" });
  });
});
