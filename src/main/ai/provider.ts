// Key custody and model choice. The renderer never receives a key, and nothing outside this
// file reads one out of settings.

import { createMistral } from "@ai-sdk/mistral";
import { safeStorage } from "electron";
import type { AiSettings } from "../../shared/ipc";
import type { Db } from "../db/client";
import * as settingsDb from "../db/settings";

/**
 * Pinned, never `-latest`: a floating alias would change the answer under a `prompt_version`
 * that says nothing changed, and silently invalidate every captured output.
 */
export const DEFAULT_MODEL = "mistral-large-2512";

/** USD per million tokens, from Mistral's pricing page — only used to estimate spend. */
export const MODELS: { id: string; name: string; inUsd: number; outUsd: number }[] = [
  { id: "mistral-large-2512", name: "Mistral Large 3", inUsd: 0.5, outUsd: 1.5 },
  { id: "mistral-small-2506", name: "Mistral Small 4", inUsd: 0.1, outUsd: 0.3 },
];

export class MissingKeyError extends Error {
  constructor() {
    super("no Mistral API key configured");
  }
}

// ------------------------------------------------------------------------------------ key

/**
 * `isEncryptionAvailable()` is false on a Linux box with no keyring, and quietly writing the
 * key in the clear there would be a lie by omission. Storing it plainly is allowed, but only
 * once the caller has passed `allowPlain` — the ui asks first.
 */
export function setKey(db: Db, key: string, allowPlain: boolean): void {
  const trimmed = key.trim();
  if (!trimmed) {
    settingsDb.setRaw(db, settingsDb.keys.MISTRAL_KEY_ENC, "");
    settingsDb.setRaw(db, settingsDb.keys.MISTRAL_KEY_PLAIN, "");
    return;
  }

  if (safeStorage.isEncryptionAvailable()) {
    settingsDb.setRaw(db, settingsDb.keys.MISTRAL_KEY_ENC, safeStorage.encryptString(trimmed).toString("base64"));
    settingsDb.setRaw(db, settingsDb.keys.MISTRAL_KEY_PLAIN, "");
    return;
  }
  if (!allowPlain) throw new Error("no OS keyring is available to encrypt the key with");
  settingsDb.setRaw(db, settingsDb.keys.MISTRAL_KEY_PLAIN, trimmed);
  settingsDb.setRaw(db, settingsDb.keys.MISTRAL_KEY_ENC, "");
}

export function getKey(db: Db): string | null {
  const enc = settingsDb.getRaw(db, settingsDb.keys.MISTRAL_KEY_ENC);
  if (enc) {
    try {
      return safeStorage.decryptString(Buffer.from(enc, "base64"));
    } catch {
      // keyring rotated or the profile moved — the ciphertext is now junk, say "no key"
      return null;
    }
  }
  return settingsDb.getRaw(db, settingsDb.keys.MISTRAL_KEY_PLAIN) || null;
}

// ------------------------------------------------------------------------------- settings

export function aiSettings(db: Db): AiSettings {
  return {
    model: settingsDb.getRaw(db, settingsDb.keys.AI_MODEL) ?? DEFAULT_MODEL,
    pseudonymize: settingsDb.getRaw(db, settingsDb.keys.AI_PSEUDONYMIZE) === "1",
    consented: settingsDb.getRaw(db, settingsDb.keys.AI_CONSENTED) === "1",
    key_set: getKey(db) !== null,
    key_storage: settingsDb.getRaw(db, settingsDb.keys.MISTRAL_KEY_PLAIN) ? "plain" : "encrypted",
    spend_cents: Number(settingsDb.getRaw(db, settingsDb.keys.AI_SPEND_CENTS) ?? "0") || 0,
  };
}

/** Fold one call's usage into the running total, so the figure in settings is this library's. */
export function addSpend(db: Db, modelId: string, tokensIn: number, tokensOut: number): void {
  const price = MODELS.find((m) => m.id === modelId);
  if (!price) return;
  const cents = ((tokensIn * price.inUsd + tokensOut * price.outUsd) / 1_000_000) * 100;
  const total = Number(settingsDb.getRaw(db, settingsDb.keys.AI_SPEND_CENTS) ?? "0") || 0;
  settingsDb.setRaw(db, settingsDb.keys.AI_SPEND_CENTS, String(total + cents));
}

// ---------------------------------------------------------------------------------- model

export function model(db: Db) {
  const key = getKey(db);
  if (!key) throw new MissingKeyError();
  const id = settingsDb.getRaw(db, settingsDb.keys.AI_MODEL) ?? DEFAULT_MODEL;
  return createMistral({ apiKey: key })(id);
}
