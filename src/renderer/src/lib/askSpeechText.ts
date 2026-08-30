export const MAX_SPEECH_CHARACTERS = 20_000;
export const MAX_SPEECH_SENTENCE_CHARACTERS = 480;
export const MAX_SPEECH_SENTENCES = 120;

const TERMINAL_PUNCTUATION = /[.!?]["']?$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{3,}/;
const REFERENCE_DEFINITION = /^\s*\[\^?[\w-]+\]:\s+\S+/;

/** Convert answer Markdown into prose suitable for local speech synthesis. */
export function askSpeechText(markdown: string): string {
  const paragraphs: string[] = [];
  let paragraph: string[] = [];
  let fence: "`" | "~" | null = null;

  const flush = () => {
    const text = paragraph.join(" ").replace(/\s+/g, " ").trim();
    if (text) paragraphs.push(text);
    paragraph = [];
  };

  for (const rawLine of markdown.slice(0, MAX_SPEECH_CHARACTERS).replace(/\r\n?/g, "\n").split("\n")) {
    const trimmed = rawLine.trim();
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as "`" | "~";
      if (fence === null) {
        flush();
        fence = marker;
      } else if (fence === marker) {
        fence = null;
      }
      continue;
    }
    if (fence !== null || /^ {4}\S/.test(rawLine)) continue;
    if (!trimmed) {
      flush();
      continue;
    }
    if (TABLE_DIVIDER.test(trimmed) || pipeCount(trimmed) >= 2 || REFERENCE_DEFINITION.test(trimmed)) {
      flush();
      continue;
    }

    const heading = /^#{1,6}\s+/.test(trimmed);
    const listItem = /^\s*(?:[-+*]|\d+[.)])\s+/.test(rawLine);
    const cleaned = cleanLine(rawLine);
    if (!cleaned) continue;

    if (heading || listItem) {
      flush();
      paragraphs.push(TERMINAL_PUNCTUATION.test(cleaned) ? cleaned : `${cleaned}.`);
    } else {
      paragraph.push(cleaned);
    }
  }
  flush();

  return paragraphs.join("\n");
}

/** Split cleaned Ask prose into bounded sentences for one-at-a-time synthesis. */
export function askSpeechSentences(markdown: string, locale = "en-US"): string[] {
  const text = askSpeechText(markdown);
  if (!text) return [];

  const sentences = text.split("\n").flatMap((paragraph) => segment(paragraph, locale));
  return sentences
    .flatMap((sentence) => boundSentence(sentence, MAX_SPEECH_SENTENCE_CHARACTERS))
    .filter(Boolean)
    .slice(0, MAX_SPEECH_SENTENCES);
}

function cleanLine(rawLine: string): string {
  return rawLine
    .replace(/^\s*#{1,6}\s+/, "")
    .replace(/^\s*>+\s?/, "")
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+/, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)]\((?:[^()]|\([^)]*\))*\)/g, "$1")
    .replace(/\[([^\]]+)]\[[^\]]*]/g, "$1")
    .replace(/`+[^`]*`+/g, "")
    .replace(/<(?:https?:\/\/|www\.)[^>]+>/gi, "")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "")
    .replace(/\[(?:\^?\d+|source\s+\d+)]/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/[*_~]+/g, "")
    .replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => ({
      "&amp;": "&",
      "&lt;": "<",
      "&gt;": ">",
      "&quot;": '"',
      "&apos;": "'",
    })[entity] ?? " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pipeCount(line: string): number {
  return [...line].filter((character) => character === "|").length;
}

function segment(text: string, locale: string): string[] {
  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(locale, { granularity: "sentence" });
    return [...segmenter.segment(text)].map(({ segment: sentence }) => sentence.trim()).filter(Boolean);
  }
  return text.match(/[^.!?]+(?:[.!?]+["']?|$)/g)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [];
}

function boundSentence(sentence: string, limit: number): string[] {
  if (sentence.length <= limit) return [sentence];

  const chunks: string[] = [];
  let current = "";
  for (const word of sentence.split(/\s+/)) {
    if (!current || current.length + word.length + 1 <= limit) {
      current = current ? `${current} ${word}` : word;
      continue;
    }
    chunks.push(withTerminalPunctuation(current));
    current = word;
  }
  if (current) chunks.push(withTerminalPunctuation(current));
  return chunks;
}

function withTerminalPunctuation(text: string): string {
  return TERMINAL_PUNCTUATION.test(text) ? text : `${text}.`;
}
