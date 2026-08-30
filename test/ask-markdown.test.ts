import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
// The renderer source is separately checked by tsconfig.web, which enables JSX.
// @ts-expect-error TS6142 -- this Node-side test executes the compiled TSX through Vitest.
import { AskMarkdown } from "../src/renderer/src/ui/AskMarkdown";

describe("Ask Markdown", () => {
  it("renders headings, emphasis, lists, and GFM tables", () => {
    const markdown = `## Next demo

Prioritize **expense analysis**:

- Analyze every account
- Show debit and credit separately

| Owner | Status |
| --- | --- |
| Delson | Ready |`;

    const html = renderToStaticMarkup(createElement(AskMarkdown, null, markdown));

    expect(html).toContain("<h3");
    expect(html).toContain("<strong");
    expect(html).toContain("<ul");
    expect(html).toContain("<table");
    expect(html).toContain("Next demo");
  });

  it("does not render raw HTML from model output", () => {
    const html = renderToStaticMarkup(createElement(
      AskMarkdown,
      null,
      "Keep this <script>alert('no')</script> safe.",
    ));

    expect(html).not.toContain("<script>");
    expect(html).not.toContain("alert('no')");
    expect(html).toContain("Keep this");
    expect(html).toContain("safe.");
  });

  it("does not fetch model-supplied images", () => {
    const html = renderToStaticMarkup(createElement(
      AskMarkdown,
      null,
      "![Private chart](https://example.com/tracking-pixel.png)",
    ));

    expect(html).not.toContain("<img");
    expect(html).not.toContain("tracking-pixel");
    expect(html).toContain("Image omitted: Private chart");
  });

  it("marks the active spoken sentence without flattening Markdown", () => {
    const html = renderToStaticMarkup(createElement(
      AskMarkdown,
      { activeSentenceIndex: 1 },
      "## Next step\n\nShip the **weekly report** now.",
    ));

    expect(html).toContain("<strong");
    expect(html).toContain('data-spoken-sentence="true"');
    expect(html).toContain(">weekly report</mark>");
  });

  it("does not count code as spoken words", () => {
    const html = renderToStaticMarkup(createElement(
      AskMarkdown,
      { activeSentenceIndex: 0 },
      "Read `privateCall()` before continuing.",
    ));

    expect(html).toContain("<code");
    expect(html).toContain(">before continuing</mark>");
  });
});
