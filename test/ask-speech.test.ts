import { describe, expect, it } from "vitest";
import {
  askSpeechSentences,
  askSpeechText,
  askSpeechWords,
  MAX_SPEECH_SENTENCE_CHARACTERS,
} from "../src/renderer/src/lib/askSpeechText";

describe("Ask speech text", () => {
  it("keeps prose, headings, and list items", () => {
    const input = `# Summary

The team approved the launch. It starts Monday.

- Notify support
- Publish the notes`;

    expect(askSpeechSentences(input)).toEqual([
      "Summary.",
      "The team approved the launch.",
      "It starts Monday.",
      "Notify support.",
      "Publish the notes.",
    ]);
  });

  it("skips code, tables, URLs, images, and citation markers", () => {
    const input = `Read the [release notes](https://example.com/notes) [1].

\`inlineCall()\` should not be spoken.

\`\`\`ts
const secret = "not speech";
\`\`\`

| Owner | Task |
| --- | --- |
| Priya | Ship |

Open https://example.com/private or ![chart](chart.png) when ready.

[^1]: https://example.com/source`;

    const text = askSpeechText(input);
    expect(text).toContain("Read the release notes .");
    expect(text).toContain("should not be spoken.");
    expect(text).toContain("Open or when ready.");
    expect(text).not.toMatch(/inlineCall|secret|Owner|Priya|https|chart|\[1]/);
  });

  it("bounds long synthesis requests", () => {
    const result = askSpeechSentences("word ".repeat(400));
    expect(result.length).toBeGreaterThan(1);
    expect(result.every((sentence) => sentence.length <= MAX_SPEECH_SENTENCE_CHARACTERS + 1)).toBe(true);
  });

  it("returns no work for answers containing only code", () => {
    expect(askSpeechSentences("```js\nalert('hello')\n```" )).toEqual([]);
  });

  it("returns spoken words in playback order", () => {
    expect(askSpeechWords("## Next step\n\nShip **today's report** [1].")).toEqual([
      "Next",
      "step",
      "Ship",
      "today's",
      "report",
    ]);
  });
});
