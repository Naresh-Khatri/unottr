// Brand marks for provider controls. Colored variants come from theSVG; monochrome marks
// receive their brand color here so they remain legible in both themes.

import { Plugs } from "@phosphor-icons/react";
import anthropic from "./providers/anthropic.svg?raw";
import claudeCode from "./providers/claude-code.svg?raw";
import codex from "./providers/codex.svg?raw";
import lmStudio from "./providers/lm-studio.svg?raw";
import mistral from "./providers/mistral.svg?raw";
import ollama from "./providers/ollama.svg?raw";
import openai from "./providers/openai.svg?raw";
import { cn } from "@/lib/utils";

const MARKS: Record<string, { svg: string; color?: string }> = {
  anthropic: { svg: anthropic, color: "text-[#D4A27F]" },
  "claude-code": { svg: claudeCode },
  "codex-cli": { svg: codex, color: "text-[#10A37F]" },
  "lm-studio": { svg: lmStudio, color: "text-[#8178F2]" },
  mistral: { svg: mistral },
  ollama: { svg: ollama, color: "text-[#B8D7CE]" },
  openai: { svg: openai, color: "text-[#10A37F]" },
};

/** Anything with no mark of its own — "custom", mostly — gets the generic plug. */
export function ProviderIcon({ preset, className }: { preset: string; className?: string }) {
  const mark = MARKS[preset];
  if (!mark) return <Plugs className={cn("size-4 text-sky-500", className)} weight="duotone" />;
  return (
    <span
      aria-hidden
      className={cn("inline-flex size-4 shrink-0 [&>svg]:size-full", mark.color, className)}
      // trusted: these bundled files come from theSVG; no user input reaches this HTML
      dangerouslySetInnerHTML={{ __html: mark.svg }}
    />
  );
}
