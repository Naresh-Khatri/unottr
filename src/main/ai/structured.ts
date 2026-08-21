// Getting a schema-shaped answer out of a model that may not support schemas. Three rungs,
// cheapest first; probe.ts finds which one an endpoint reaches and generate.ts uses it.
//
//   native    the request carries a json_schema response_format — the server enforces it
//   json_mode the request asks for "some json"; the schema rides in the prompt
//   prompted  nothing but the prompt, and we parse whatever prose it comes wrapped in

import { NoObjectGeneratedError, Output, generateText } from "ai";
import type { LanguageModel } from "ai";
import { z } from "zod";
import type { Strategy } from "../../shared/ipc";

export interface Ask<T> {
  model: LanguageModel;
  strategy: Strategy;
  schema: z.ZodType<T>;
  system: string;
  prompt: string;
  /** a filled-in answer, shown verbatim on the rungs that have to describe the shape in words */
  example?: unknown;
  abortSignal?: AbortSignal;
}

export interface Answer<T> {
  object: T;
  usage: { inputTokens?: number; outputTokens?: number };
}

export async function ask<T>(a: Ask<T>): Promise<Answer<T>> {
  const system =
    a.strategy === "native" ? a.system : `${a.system}\n\n${instruction(a.schema, a.example)}`;

  if (a.strategy === "prompted") {
    const { text, usage } = await generateText({
      model: a.model,
      system,
      prompt: a.prompt,
      abortSignal: a.abortSignal,
    });
    return { object: a.schema.parse(loosely(text)), usage };
  }

  const { output, usage } = await generateText({
    model: a.model,
    output: Output.object({ schema: a.schema }),
    system,
    prompt: a.prompt,
    abortSignal: a.abortSignal,
  });
  return { object: output, usage };
}

/** Every rung below `native` has to be told the shape in words, since the request can't carry it. */
function instruction(schema: z.ZodType<unknown>, example?: unknown): string {
  const worked = example
    ? `\n\nA correctly shaped answer, for form only — the content is from another meeting:\n\n${JSON.stringify(example)}`
    : "";
  return `Answer with one JSON object and nothing else: no preamble, no explanation, no markdown
fence. It must validate against this JSON Schema, including every required field:

${JSON.stringify(z.toJSONSchema(schema))}${worked}`;
}

/**
 * Small models answer with a fence, or a sentence, or both. That is not a schema failure —
 * it is packaging, and unwrapping it here is the difference between "your model can't do
 * this" and one working setup.
 */
export function loosely(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text).trim();

  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("the model's answer contained no JSON object");

  const slice = body.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    // some models emit a trailing comma before the closing brace and nothing else wrong
    return JSON.parse(slice.replace(/,\s*([}\]])/g, "$1"));
  }
}

export const isShapeError = (err: unknown): boolean =>
  NoObjectGeneratedError.isInstance(err) ||
  (err instanceof Error && (err.name === "AI_TypeValidationError" || err.name === "ZodError")) ||
  (err instanceof Error && err.message.includes("no JSON object"));
