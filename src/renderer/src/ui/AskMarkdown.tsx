import type { ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { askSpeechSentences, askSpeechWords } from "../lib/askSpeechText";
import { cn } from "../lib/utils";

const markdownComponents = {
  h1: ({ className, ...props }: ComponentPropsWithoutRef<"h1">) => (
    <h2 className={cn("mt-6 mb-2 text-lg font-semibold tracking-tight first:mt-0", className)} {...props} />
  ),
  h2: ({ className, ...props }: ComponentPropsWithoutRef<"h2">) => (
    <h3 className={cn("mt-5 mb-2 text-base font-semibold tracking-tight first:mt-0", className)} {...props} />
  ),
  h3: ({ className, ...props }: ComponentPropsWithoutRef<"h3">) => (
    <h4 className={cn("mt-4 mb-1.5 text-sm font-semibold first:mt-0", className)} {...props} />
  ),
  h4: ({ className, ...props }: ComponentPropsWithoutRef<"h4">) => (
    <h5 className={cn("mt-4 mb-1.5 text-sm font-medium first:mt-0", className)} {...props} />
  ),
  p: ({ className, ...props }: ComponentPropsWithoutRef<"p">) => (
    <p className={cn("my-2 leading-6 first:mt-0 last:mb-0", className)} {...props} />
  ),
  ul: ({ className, ...props }: ComponentPropsWithoutRef<"ul">) => (
    <ul className={cn("my-2 list-disc space-y-1 pl-5 marker:text-muted-foreground", className)} {...props} />
  ),
  ol: ({ className, ...props }: ComponentPropsWithoutRef<"ol">) => (
    <ol className={cn("my-2 list-decimal space-y-1 pl-5 marker:text-muted-foreground", className)} {...props} />
  ),
  li: ({ className, ...props }: ComponentPropsWithoutRef<"li">) => (
    <li className={cn("pl-1 leading-6 [&>p]:my-0", className)} {...props} />
  ),
  blockquote: ({ className, ...props }: ComponentPropsWithoutRef<"blockquote">) => (
    <blockquote
      className={cn("my-3 rounded-md bg-muted/60 px-3 py-2 text-muted-foreground [&>p]:my-0", className)}
      {...props}
    />
  ),
  a: ({ className, ...props }: ComponentPropsWithoutRef<"a">) => (
    <a
      className={cn("font-medium underline decoration-border underline-offset-3 hover:decoration-foreground", className)}
      target="_blank"
      rel="noreferrer"
      {...props}
    />
  ),
  img: ({ alt }: ComponentPropsWithoutRef<"img">) => (
    <span className="text-xs italic text-muted-foreground">
      {alt ? `[Image omitted: ${alt}]` : "[Image omitted]"}
    </span>
  ),
  strong: ({ className, ...props }: ComponentPropsWithoutRef<"strong">) => (
    <strong className={cn("font-semibold", className)} {...props} />
  ),
  code: ({ className, ...props }: ComponentPropsWithoutRef<"code">) => (
    <code
      className={cn("rounded bg-muted px-1 py-0.5 font-mono text-[0.82em] break-words", className)}
      {...props}
    />
  ),
  pre: ({ className, ...props }: ComponentPropsWithoutRef<"pre">) => (
    <pre
      className={cn(
        "my-3 overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs leading-5 [&>code]:bg-transparent [&>code]:p-0",
        className,
      )}
      {...props}
    />
  ),
  table: ({ className, ...props }: ComponentPropsWithoutRef<"table">) => (
    <div className="my-3 overflow-x-auto rounded-lg border">
      <table className={cn("w-full border-collapse text-left text-xs", className)} {...props} />
    </div>
  ),
  thead: ({ className, ...props }: ComponentPropsWithoutRef<"thead">) => (
    <thead className={cn("bg-muted/70", className)} {...props} />
  ),
  tr: ({ className, ...props }: ComponentPropsWithoutRef<"tr">) => (
    <tr className={cn("border-b last:border-b-0", className)} {...props} />
  ),
  th: ({ className, ...props }: ComponentPropsWithoutRef<"th">) => (
    <th className={cn("px-3 py-2 font-semibold", className)} {...props} />
  ),
  td: ({ className, ...props }: ComponentPropsWithoutRef<"td">) => (
    <td className={cn("px-3 py-2 align-top", className)} {...props} />
  ),
  hr: ({ className, ...props }: ComponentPropsWithoutRef<"hr">) => (
    <hr className={cn("my-5 border-border", className)} {...props} />
  ),
};

export function AskMarkdown({ children, activeSentenceIndex = null }: {
  children: string;
  activeSentenceIndex?: number | null;
}) {
  const sentences = activeSentenceIndex === null ? [] : askSpeechSentences(children);
  const sentenceWords = sentences.map((sentence) => askSpeechWords(sentence));
  const activeWordStart = sentenceWords
    .slice(0, activeSentenceIndex ?? 0)
    .reduce((total, words) => total + words.length, 0);
  const activeWordEnd = activeWordStart + (sentenceWords[activeSentenceIndex ?? -1]?.length ?? 0);
  const rehypePlugins = activeWordEnd <= activeWordStart
    ? []
    : [highlightSpokenSentence(sentenceWords.flat(), activeWordStart, activeWordEnd)];

  return (
    <div className="min-w-0 text-sm text-pretty">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={rehypePlugins}
        skipHtml
        components={markdownComponents}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

interface MarkdownNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: MarkdownNode[];
}

const UNSPOKEN_ELEMENTS = new Set(["code", "pre", "table"]);
const WORD_PATTERN = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

function highlightSpokenSentence(spokenWords: string[], activeWordStart: number, activeWordEnd: number) {
  return () => (tree: unknown) => {
    let spokenIndex = 0;

    const visit = (parent: MarkdownNode) => {
      if (!parent.children) return;
      for (let index = 0; index < parent.children.length; index += 1) {
        const node = parent.children[index];
        if (node.type === "element" && node.tagName && UNSPOKEN_ELEMENTS.has(node.tagName)) continue;
        if (node.type !== "text" || node.value === undefined) {
          visit(node);
          continue;
        }

        const activeMatches: RegExpMatchArray[] = [];
        for (const match of node.value.matchAll(WORD_PATTERN)) {
          const rendered = normalizeWord(match[0]);
          let matchedIndex = -1;
          for (let lookahead = spokenIndex; lookahead < Math.min(spokenWords.length, spokenIndex + 9); lookahead += 1) {
            if (normalizeWord(spokenWords[lookahead]) === rendered) {
              matchedIndex = lookahead;
              break;
            }
          }
          if (matchedIndex < 0) continue;
          spokenIndex = matchedIndex + 1;
          if (matchedIndex >= activeWordStart && matchedIndex < activeWordEnd) activeMatches.push(match);
        }

        const firstMatch = activeMatches[0];
        const lastMatch = activeMatches.at(-1);
        if (!firstMatch || firstMatch.index === undefined || !lastMatch || lastMatch.index === undefined) continue;
        const activeStart = firstMatch.index;
        const activeEnd = lastMatch.index + lastMatch[0].length;
        const before = node.value.slice(0, activeStart);
        const activeText = node.value.slice(activeStart, activeEnd);
        const after = node.value.slice(activeEnd);
        parent.children.splice(index, 1,
          ...(before ? [{ type: "text", value: before } satisfies MarkdownNode] : []),
          {
            type: "element",
            tagName: "mark",
            properties: {
              className: ["rounded-[0.2em]", "bg-foreground/10", "text-foreground"],
              "aria-current": "true",
              "data-spoken-sentence": "true",
            },
            children: [{ type: "text", value: activeText }],
          },
          ...(after ? [{ type: "text", value: after } satisfies MarkdownNode] : []),
        );
        index += before ? 1 : 0;
      }
    };

    visit(tree as MarkdownNode);
  };
}

function normalizeWord(word: string): string {
  return word.replace(/’/g, "'").toLocaleLowerCase();
}
