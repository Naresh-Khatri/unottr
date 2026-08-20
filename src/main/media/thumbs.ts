// Cache layout shared by the ingest job (writes) and media-protocol.ts (serves): one cover
// frame plus PREVIEW_COUNT evenly spaced previews, named by recording id so a re-extraction
// under a different filename doesn't orphan them (unlike pcmPathFor's source-stem naming).

import { join } from "node:path";
import { thumbsCacheDir } from "../paths";

export const PREVIEW_COUNT = 10;

/** Settings' `cache_dir` override relocates this the same way it relocates the pcm cache. */
export const thumbsDirFor = (cacheDirSetting: string | null | undefined): string =>
  cacheDirSetting ? join(cacheDirSetting, "thumbs") : thumbsCacheDir();

export const thumbPathFor = (thumbsDir: string, id: number): string =>
  join(thumbsDir, `${id}.jpg`);

export const previewPathFor = (thumbsDir: string, id: number, index: number): string =>
  join(thumbsDir, `${id}.p${index}.jpg`);
