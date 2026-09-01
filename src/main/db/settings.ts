// Typed accessors over the free-form kv `settings` table. Parsing and validation live here
// so no caller touches the table directly and they can't disagree on what a key means.

import { eq } from "drizzle-orm";
import { DEFAULT_TTS_VOICE_ID, TTS_VOICE_IDS, type Device, type Settings, type TtsVoiceId } from "../../shared/ipc";
import type { Db } from "./client";
import { settings } from "./schema";

export const keys = {
  MODEL_TIER: "model_tier", // "auto" | "turbo" | "medium" | "small"
  LANGUAGE: "language", // "auto" | a whisper language code
  DEVICE: "device", // "auto" | "gpu" | "cpu"
  DIARIZE_THRESHOLD: "diarize_threshold", // float, absent = engine default
  FFMPEG_PATH: "ffmpeg_path",
  FFPROBE_PATH: "ffprobe_path",
  CACHE_DIR: "cache_dir", // overrides the pcm/thumbs cache subdirs only
  AUTOSTART: "autostart", // "1" | "0"
  CLOSE_TO_TRAY: "close_to_tray", // "1" | "0", default "1"
  ASK_SPEAK_ANSWERS: "ask_speak_answers", // "1" | "0", default "1"
  TTS_VOICE_ID: "tts_voice_id",
  CLOSE_TO_TRAY_EXPLAINED: "close_to_tray_explained",
  FIRST_RUN_COMPLETE: "first_run_complete", // ui-only, gates the wizard
  AI_PSEUDONYMIZE: "ai_pseudonymize", // "1" | "0", default "0"
  // "" = none. Everything else about a connection — key, model, consent, spend — is a
  // column on `ai_connections`, not a setting.
  AI_ACTIVE_CONNECTION_ID: "ai_active_connection_id",
  AI_FALLBACK_CONNECTION_ID: "ai_fallback_connection_id",
} as const;

/** `base.en` stays cli-only, so it is not one of the three tiers settings offers. */
export function tierToModelName(tier: string): string | null {
  switch (tier) {
    case "turbo":
      return "large-v3-turbo";
    case "medium":
      return "medium";
    case "small":
      return "small";
    default:
      return null;
  }
}

export function modelNameToTier(name: string): string {
  switch (name) {
    case "large-v3-turbo":
      return "turbo";
    case "medium":
      return "medium";
    case "small":
      return "small";
    default:
      return "auto";
  }
}

export function getRaw(db: Db, key: string): string | null {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  return row?.value ?? null;
}

export function setRaw(db: Db, key: string, value: string): void {
  db.insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run();
}

/** What core honours. Runtime-only fields of the wire type are added in queries.ts. */
export type StoredSettings = Omit<
  Settings,
  "tray_available" | "autostart_available" | "first_run_complete" | "ffmpeg_ok"
>;

const nonEmpty = (v: string | null): string | null => (v ? v : null);

/** A missing key reads as its default, so a brand-new database is not an error. */
export function load(db: Db): StoredSettings {
  const language = getRaw(db, keys.LANGUAGE);
  // Number("") is 0, not NaN — an empty value has to mean "unset", same as a missing key
  const threshold = getRaw(db, keys.DIARIZE_THRESHOLD);
  const parsed = threshold ? Number(threshold) : Number.NaN;

  return {
    model_tier: getRaw(db, keys.MODEL_TIER) ?? "auto",
    language: language && language !== "auto" ? language : null,
    device: (getRaw(db, keys.DEVICE) ?? "auto") as Device,
    diarize_threshold: Number.isFinite(parsed) ? parsed : null,
    ffmpeg_path: nonEmpty(getRaw(db, keys.FFMPEG_PATH)),
    ffprobe_path: nonEmpty(getRaw(db, keys.FFPROBE_PATH)),
    cache_dir: nonEmpty(getRaw(db, keys.CACHE_DIR)),
    autostart: getRaw(db, keys.AUTOSTART) === "1",
    close_to_tray: (getRaw(db, keys.CLOSE_TO_TRAY) ?? "1") === "1",
    ask_speak_answers: (getRaw(db, keys.ASK_SPEAK_ANSWERS) ?? "1") === "1",
    tts_voice_id: (getRaw(db, keys.TTS_VOICE_ID) ?? DEFAULT_TTS_VOICE_ID) as TtsVoiceId,
  };
}

export function closeToTrayExplained(db: Db): boolean {
  return getRaw(db, keys.CLOSE_TO_TRAY_EXPLAINED) === "1";
}

export function markCloseToTrayExplained(db: Db): void {
  setRaw(db, keys.CLOSE_TO_TRAY_EXPLAINED, "1");
}

/**
 * Core stores values verbatim and never validates, so a bad one would persist silently and
 * only surface on the next job. That check belongs at the ipc boundary — here.
 * Returns an error message, or null when the pair is acceptable.
 */
export function validate(key: string, value: string): string | null {
  const ok = (cond: boolean) => (cond ? null : `invalid value ${JSON.stringify(value)} for setting ${key}`);
  const num = Number(value);

  switch (key) {
    case keys.MODEL_TIER:
      return ok(["auto", "turbo", "medium", "small"].includes(value));
    case keys.DEVICE:
      return ok(["auto", "gpu", "cpu"].includes(value));
    case keys.LANGUAGE:
      return ok(value.length > 0);
    case keys.DIARIZE_THRESHOLD:
      return ok(value.trim() !== "" && Number.isFinite(num) && num >= 0 && num <= 1);
    case keys.TTS_VOICE_ID:
      return ok(TTS_VOICE_IDS.includes(value as TtsVoiceId));
    // "" clears the override
    case keys.FFMPEG_PATH:
    case keys.FFPROBE_PATH:
    case keys.CACHE_DIR:
      return null;
    case keys.AUTOSTART:
    case keys.CLOSE_TO_TRAY:
    case keys.ASK_SPEAK_ANSWERS:
    case keys.FIRST_RUN_COMPLETE:
    case keys.AI_PSEUDONYMIZE:
      return ok(value === "0" || value === "1");
    // "" clears it; ai_connection_activate is the normal path
    case keys.AI_ACTIVE_CONNECTION_ID:
    case keys.AI_FALLBACK_CONNECTION_ID:
      return ok(value === "" || (Number.isInteger(num) && num > 0));
    default:
      return `unknown setting key ${key}`;
  }
}
