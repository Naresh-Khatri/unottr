// Brand marks for the preset chips, inlined so they inherit `currentColor` — an <img src>
// cannot. Downloaded once from thesvg.org (see THIRD-PARTY.md); the marks stay their owners'
// trademarks, we only draw them.

import { Plugs } from "@phosphor-icons/react";
import anthropic from "./providers/anthropic.svg?raw";
import lmStudio from "./providers/lm-studio.svg?raw";
import mistral from "./providers/mistral.svg?raw";
import ollama from "./providers/ollama.svg?raw";
import openai from "./providers/openai.svg?raw";
import { cn } from "@/lib/utils";

const MARKS: Record<string, string> = {
  anthropic,
  "lm-studio": lmStudio,
  mistral,
  ollama,
  openai,
};

/** Anything with no mark of its own — "custom", mostly — gets the generic plug. */
export function ProviderIcon({ preset, className }: { preset: string; className?: string }) {
  const svg = MARKS[preset];
  if (!svg) return <Plugs className={cn("size-4", className)} weight="duotone" />;
  return (
    <span
      aria-hidden
      className={cn("inline-flex size-4 shrink-0 [&>svg]:size-full", className)}
      // trusted: these five files ship in the bundle, nothing user-supplied reaches here
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
