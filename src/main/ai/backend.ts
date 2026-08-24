import type { z } from "zod";
import type { Row } from "./connections";
import { keyOf } from "./connections";
import { askCli } from "./cli";
import { languageModel } from "./providers";
import { ask as askHttp, type Answer } from "./structured";

export interface BackendAnswer<T> extends Answer<T> {
  /** The model reported by the CLI, or the requested model for HTTP. */
  model: string | null;
}

interface AskBackend<T> {
  connection: Row;
  schema: z.ZodType<T>;
  system: string;
  prompt: string;
  example?: unknown;
  abortSignal?: AbortSignal;
}

export async function askBackend<T>(a: AskBackend<T>): Promise<BackendAnswer<T>> {
  const r = a.connection;
  if (r.kind === "cli") {
    if (!r.executablePath) throw new Error(`${r.label} has no executable selected`);
    return askCli({
      preset: r.preset,
      executablePath: r.executablePath,
      modelId: r.activeModel,
      schema: a.schema,
      system: a.system,
      prompt: a.prompt,
      abortSignal: a.abortSignal,
    });
  }

  if (!r.activeModel) throw new Error(`${r.label} has no model selected`);
  const answer = await askHttp({
    model: languageModel({
      wire: r.wire,
      preset: r.preset,
      baseUrl: r.baseUrl,
      modelId: r.activeModel,
      key: keyOf(r),
      strategy: r.strategy,
    }),
    strategy: r.strategy,
    schema: a.schema,
    system: a.system,
    prompt: a.prompt,
    example: a.example,
    abortSignal: a.abortSignal,
  });
  return { ...answer, model: r.activeModel };
}
