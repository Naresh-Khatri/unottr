// The endpoints the user has added, and the only file in the app that reads an API key.
// `toWire` is deliberately the single way a row leaves here, so a key cannot escape by
// someone forgetting to strip a field.

import { eq } from "drizzle-orm";
import { safeStorage } from "electron";
import type { AiConnection, AiConnectionInput, AiSettings, ProbeResult, Strategy } from "../../shared/ipc";
import type { Db } from "../db/client";
import { aiConnections } from "../db/schema";
import * as settingsDb from "../db/settings";
import { isLocal, normalizeBaseUrl, preset, priceOf } from "./providers";

export type Row = typeof aiConnections.$inferSelect;

export class MissingConnectionError extends Error {
  constructor() {
    super("no AI connection is set up yet");
  }
}

export class MissingKeyError extends Error {
  constructor(label: string) {
    super(`${label} needs an API key`);
  }
}

export class ConsentError extends Error {
  constructor() {
    super("this connection has not been consented to yet");
  }
}

const now = () => Math.floor(Date.now() / 1000);

// ------------------------------------------------------------------------------------ read

export function rows(db: Db): Row[] {
  return db.select().from(aiConnections).orderBy(aiConnections.id).all();
}

export function row(db: Db, id: number): Row | null {
  return db.select().from(aiConnections).where(eq(aiConnections.id, id)).get() ?? null;
}

export function activeId(db: Db): number | null {
  const raw = settingsDb.getRaw(db, settingsDb.keys.AI_ACTIVE_CONNECTION_ID);
  const id = raw ? Number(raw) : Number.NaN;
  return Number.isInteger(id) ? id : null;
}

/** The connection a generation would use, or null. Falls back to the only row there is. */
export function active(db: Db): Row | null {
  const id = activeId(db);
  if (id !== null) {
    const found = row(db, id);
    if (found) return found;
  }
  const all = rows(db);
  return all.length === 1 ? all[0] : null;
}

export function list(db: Db): AiConnection[] {
  const activeRowId = active(db)?.id ?? null;
  return rows(db).map((r) => toWire(r, r.id === activeRowId));
}

export function settings(db: Db): AiSettings {
  return {
    active_connection_id: active(db)?.id ?? null,
    pseudonymize: settingsDb.getRaw(db, settingsDb.keys.AI_PSEUDONYMIZE) === "1",
  };
}

/** The only shape a connection crosses ipc in. Note what is absent: the key. */
export function toWire(r: Row, isActive: boolean): AiConnection {
  return {
    id: r.id,
    label: r.label,
    preset: r.preset,
    wire: r.wire,
    base_url: r.baseUrl,
    key_set: Boolean(r.keyEnc || r.keyPlain),
    key_storage: r.keyPlain ? "plain" : r.keyEnc ? "encrypted" : "none",
    active_model: r.activeModel,
    models: parse<string[]>(r.modelsJson) ?? [],
    models_fetched_at: r.modelsFetchedAt,
    strategy: r.strategy,
    context_tokens: r.contextTokens,
    timeout_ms: r.timeoutMs,
    price_in_usd: r.priceInUsd,
    price_out_usd: r.priceOutUsd,
    consented: r.consented === 1,
    spend_cents: r.spendCents,
    local: isLocal(r.baseUrl),
    probe: parse<ProbeResult>(r.probeJson),
    probed_at: r.probedAt,
    active: isActive,
  };
}

function parse<T>(json: string | null): T | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------------- write

export function save(db: Db, input: AiConnectionInput): AiConnection {
  const existing = input.id != null ? row(db, input.id) : null;
  if (input.id != null && !existing) throw new Error(`no AI connection with id ${input.id}`);

  const presetId = input.preset ?? existing?.preset ?? "custom";
  const spec = preset(presetId);
  const baseUrl = normalizeBaseUrl(input.base_url ?? existing?.baseUrl ?? spec?.base_url ?? "");
  if (!baseUrl) throw new Error("a base URL is required");

  const activeModel = input.active_model !== undefined ? input.active_model : (existing?.activeModel ?? null);
  const local = isLocal(baseUrl);
  // a changed model is a changed price; only fall back to the table when the user has not
  // typed a number of their own for this connection
  const fallback = priceOf(activeModel, local);
  const priceIn = input.price_in_usd !== undefined ? input.price_in_usd : (existing?.priceInUsd ?? fallback?.[0] ?? null);
  const priceOut =
    input.price_out_usd !== undefined ? input.price_out_usd : (existing?.priceOutUsd ?? fallback?.[1] ?? null);

  const values = {
    label: input.label ?? existing?.label ?? unique(db, spec?.label ?? hostOf(baseUrl), existing?.id ?? null),
    preset: presetId,
    wire: spec?.wire ?? existing?.wire ?? "openai",
    baseUrl,
    activeModel,
    contextTokens: input.context_tokens !== undefined ? input.context_tokens : (existing?.contextTokens ?? null),
    timeoutMs: input.timeout_ms !== undefined ? input.timeout_ms : (existing?.timeoutMs ?? null),
    priceInUsd: priceIn,
    priceOutUsd: priceOut,
    consented: (input.consented ?? existing?.consented === 1) ? 1 : 0,
    updatedAt: now(),
  };

  const id = existing
    ? (db.update(aiConnections).set(values).where(eq(aiConnections.id, existing.id)).returning({ id: aiConnections.id }).get()
        .id ?? existing.id)
    : db
        .insert(aiConnections)
        .values({ ...values, strategy: "native", createdAt: now() })
        .returning({ id: aiConnections.id })
        .get().id;

  if (input.key !== undefined) setKey(db, id, input.key, input.allow_plain === true);
  // the url or the key moved, so last run's verdict is about a different endpoint
  if (existing && (existing.baseUrl !== baseUrl || input.key !== undefined)) clearProbe(db, id);
  if (!existing && activeId(db) === null) activate(db, id);

  return toWire(row(db, id) as Row, active(db)?.id === id);
}

export function remove(db: Db, id: number): void {
  db.delete(aiConnections).where(eq(aiConnections.id, id)).run();
  if (activeId(db) === id) {
    const next = rows(db)[0];
    if (next) activate(db, next.id);
    else settingsDb.setRaw(db, settingsDb.keys.AI_ACTIVE_CONNECTION_ID, "");
  }
}

export function activate(db: Db, id: number): void {
  if (!row(db, id)) throw new Error(`no AI connection with id ${id}`);
  settingsDb.setRaw(db, settingsDb.keys.AI_ACTIVE_CONNECTION_ID, String(id));
}

/**
 * Two connections on the same preset both derive the bare preset label, and a list of
 * identical rows is a list you cannot choose from. Only for derived labels — a name the
 * user typed is theirs, duplicate or not.
 */
function unique(db: Db, label: string, selfId: number | null): string {
  const taken = new Set(
    db.select({ id: aiConnections.id, label: aiConnections.label }).from(aiConnections).all()
      .filter((r) => r.id !== selfId)
      .map((r) => r.label),
  );
  if (!taken.has(label)) return label;
  for (let n = 2; ; n++) {
    const candidate = `${label} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function setContextTokens(db: Db, id: number, tokens: number): void {
  db.update(aiConnections).set({ contextTokens: tokens, updatedAt: now() }).where(eq(aiConnections.id, id)).run();
}

export function setActiveModel(db: Db, id: number, modelId: string): void {
  db.update(aiConnections).set({ activeModel: modelId, updatedAt: now() }).where(eq(aiConnections.id, id)).run();
}

export function setModels(db: Db, id: number, models: string[]): void {
  db.update(aiConnections)
    .set({ modelsJson: JSON.stringify(models), modelsFetchedAt: now(), updatedAt: now() })
    .where(eq(aiConnections.id, id))
    .run();
}

export function setProbe(db: Db, id: number, probe: ProbeResult, strategy: Strategy | null): void {
  db.update(aiConnections)
    .set({
      probeJson: JSON.stringify(probe),
      probedAt: now(),
      ...(strategy ? { strategy } : {}),
      updatedAt: now(),
    })
    .where(eq(aiConnections.id, id))
    .run();
}

function clearProbe(db: Db, id: number): void {
  db.update(aiConnections).set({ probeJson: null, probedAt: null }).where(eq(aiConnections.id, id)).run();
}

/** Fold one call's usage into this connection's total. Priceless models keep a total of 0. */
export function addSpend(db: Db, r: Row, tokensIn: number, tokensOut: number): void {
  if (r.priceInUsd == null && r.priceOutUsd == null) return;
  const cents = ((tokensIn * (r.priceInUsd ?? 0) + tokensOut * (r.priceOutUsd ?? 0)) / 1_000_000) * 100;
  db.update(aiConnections)
    .set({ spendCents: r.spendCents + cents })
    .where(eq(aiConnections.id, r.id))
    .run();
}

// ------------------------------------------------------------------------------------- key

/**
 * `isEncryptionAvailable()` is false on a Linux box with no keyring, and quietly writing the
 * key in the clear there would be a lie by omission. Storing it plainly is allowed, but only
 * once the caller has passed `allowPlain` — the ui asks first.
 */
export function setKey(db: Db, id: number, key: string, allowPlain: boolean): void {
  const trimmed = key.trim();
  const set = (keyEnc: string | null, keyPlain: string | null) => {
    db.update(aiConnections).set({ keyEnc, keyPlain, updatedAt: now() }).where(eq(aiConnections.id, id)).run();
  };

  if (!trimmed) return set(null, null);
  if (safeStorage.isEncryptionAvailable()) return set(safeStorage.encryptString(trimmed).toString("base64"), null);
  if (!allowPlain) throw new Error("no OS keyring is available to encrypt the key with");
  set(null, trimmed);
}

export function keyOf(r: Row): string | null {
  if (r.keyEnc) {
    try {
      return safeStorage.decryptString(Buffer.from(r.keyEnc, "base64"));
    } catch {
      // keyring rotated or the profile moved — the ciphertext is now junk, say "no key"
      return null;
    }
  }
  return r.keyPlain || null;
}

/** True when this connection cannot possibly work: its preset demands a key and there is none. */
export function needsKey(r: Row): boolean {
  return preset(r.preset)?.key_required === true && !keyOf(r);
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
