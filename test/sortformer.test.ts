import { describe, expect, it } from "vitest";
import { parseSortformerLine } from "../src/main/ingest/sortformer";

describe("Sortformer output", () => {
  it("turns streaming JSON seconds into the pipeline's millisecond turns", () => {
    expect(parseSortformerLine('{"speaker":2,"start":62.64,"end":63.52,"chunk":31}')).toEqual({
      turn: { speaker: 2, start_ms: 62_640, end_ms: 63_520 },
      chunk: 31,
    });
  });

  it("ignores native logs and malformed turns", () => {
    expect(parseSortformerLine("ggml_vulkan: Found 1 Vulkan devices:")).toBeNull();
    expect(parseSortformerLine('{"speaker":0,"start":2,"end":1,"chunk":0}')).toBeNull();
    expect(parseSortformerLine('{"speaker":"0","start":1,"end":2,"chunk":0}')).toBeNull();
  });
});
