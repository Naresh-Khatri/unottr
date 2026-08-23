import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { TerminologyRule, TerminologyRuleInput } from "../../shared/ipc";
import type { Db } from "./client";
import { now } from "./recordings";
import { recordings, segments, terminologyRules } from "./schema";

const MAX_RULES = 500;
const MAX_TERM_LENGTH = 200;

type StoredRule = typeof terminologyRules.$inferSelect;
type RuleLike = Pick<TerminologyRule, "id" | "source" | "replacement" | "case_sensitive" | "whole_word" | "enabled">;

export interface ApplyReport {
  recordingIds: number[];
  segmentsChanged: number;
}

export function list(db: Db): TerminologyRule[] {
  return db.select().from(terminologyRules).orderBy(asc(terminologyRules.id)).all().map(toPublic);
}

export function create(db: Db, raw: TerminologyRuleInput): TerminologyRule {
  const input = validate(raw);
  const count = db.select({ n: sql<number>`count(*)` }).from(terminologyRules).get()?.n ?? 0;
  if (count >= MAX_RULES) throw new Error(`terminology is limited to ${MAX_RULES} rules`);
  rejectDuplicate(db, input);
  const ts = now();
  return toPublic(
    db.insert(terminologyRules)
      .values({ ...toStored(input), createdAt: ts, updatedAt: ts })
      .returning()
      .get(),
  );
}

export function update(db: Db, id: number, raw: TerminologyRuleInput): TerminologyRule {
  const input = validate(raw);
  rejectDuplicate(db, input, id);
  const row = db.update(terminologyRules)
    .set({ ...toStored(input), updatedAt: now() })
    .where(eq(terminologyRules.id, id))
    .returning()
    .get();
  if (!row) throw new Error(`terminology rule ${id} not found`);
  return toPublic(row);
}

export function remove(db: Db, id: number): void {
  const result = db.delete(terminologyRules).where(eq(terminologyRules.id, id)).run();
  if (result.changes === 0) throw new Error(`terminology rule ${id} not found`);
}

/**
 * Applies matches against the original input in one pass. Replacements cannot trigger other
 * rules, and a longer phrase wins when two rules begin at the same character.
 */
export function applyRules(text: string, rules: RuleLike[]): string {
  const candidates: { start: number; end: number; replacement: string; ruleId: number }[] = [];
  for (const rule of rules) {
    if (!rule.enabled || !rule.source) continue;
    const regex = new RegExp(escapeRegex(rule.source), rule.case_sensitive ? "gu" : "giu");
    for (const match of text.matchAll(regex)) {
      const start = match.index;
      const end = start + match[0].length;
      if (rule.whole_word && !hasWordBoundaries(text, start, end)) continue;
      candidates.push({ start, end, replacement: rule.replacement, ruleId: rule.id });
    }
  }

  candidates.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start) || a.ruleId - b.ruleId);
  if (candidates.length === 0) return text;

  const out: string[] = [];
  let cursor = 0;
  for (const match of candidates) {
    if (match.start < cursor) continue;
    out.push(text.slice(cursor, match.start), match.replacement);
    cursor = match.end;
  }
  out.push(text.slice(cursor));
  return out.join("");
}

/** Applies the current rules to one finished transcript. Used by the ingest job. */
export function applyToRecording(db: Db, recordingId: number): ApplyReport {
  return applyRecording(db, recordingId, list(db));
}

/** Replays every rule from raw text, including reverting corrections whose rule was removed. */
export function applyToLibrary(db: Db): ApplyReport {
  const rules = list(db);
  const ids = db
    .select({ id: recordings.id })
    .from(recordings)
    .where(eq(recordings.status, "done"))
    .orderBy(asc(recordings.id))
    .all();
  const report: ApplyReport = { recordingIds: [], segmentsChanged: 0 };
  for (const { id } of ids) {
    const one = applyRecording(db, id, rules);
    report.recordingIds.push(...one.recordingIds);
    report.segmentsChanged += one.segmentsChanged;
  }
  return report;
}

export function serialize(db: Db): string {
  const rules = list(db).map(({ source, replacement, case_sensitive, whole_word, enabled }) => ({
    source,
    replacement,
    case_sensitive,
    whole_word,
    enabled,
  }));
  return `${JSON.stringify({ version: 1, rules }, null, 2)}\n`;
}

/** Imports by matching source plus match options. Existing matches receive the imported value. */
export function importJson(db: Db, raw: string): number {
  const parsed = parseImport(raw);
  const keys = new Set(
    db.select({ sourceKey: terminologyRules.sourceKey, wholeWord: terminologyRules.wholeWord })
      .from(terminologyRules)
      .all()
      .map((rule) => `${rule.sourceKey}\u0000${rule.wholeWord}`),
  );
  for (const rule of parsed) keys.add(`${sourceKey(rule)}\u0000${rule.whole_word ? 1 : 0}`);
  if (keys.size > MAX_RULES) throw new Error(`terminology is limited to ${MAX_RULES} rules`);
  db.transaction((tx) => {
    for (const input of parsed) {
      const ts = now();
      const stored = toStored(input);
      tx.insert(terminologyRules)
        .values({ ...stored, createdAt: ts, updatedAt: ts })
        .onConflictDoUpdate({
          target: [terminologyRules.sourceKey, terminologyRules.wholeWord],
          set: {
            source: stored.source,
            replacement: stored.replacement,
            caseSensitive: stored.caseSensitive,
            enabled: stored.enabled,
            updatedAt: ts,
          },
        })
        .run();
    }
  });
  return parsed.length;
}

function applyRecording(db: Db, recordingId: number, rules: RuleLike[]): ApplyReport {
  let changed = 0;
  db.transaction((tx) => {
    const rows = tx
      .select({ id: segments.id, text: segments.text, rawText: segments.rawText })
      .from(segments)
      .where(eq(segments.recordingId, recordingId))
      .orderBy(asc(segments.id))
      .all();

    for (const row of rows) {
      const original = row.rawText ?? row.text;
      const corrected = applyRules(original, rules);
      if (corrected === row.text) continue;
      tx.update(segments)
        .set({ text: corrected, ...(row.rawText === null ? { rawText: original } : {}) })
        .where(eq(segments.id, row.id))
        .run();
      changed++;
    }

    if (changed > 0) {
      tx.update(recordings)
        .set({
          transcriptVersion: sql`${recordings.transcriptVersion} + 1`,
          updatedAt: now(),
        })
        .where(eq(recordings.id, recordingId))
        .run();
    }
  });
  return { recordingIds: changed > 0 ? [recordingId] : [], segmentsChanged: changed };
}

function parseImport(raw: string): TerminologyRuleInput[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("terminology file is not valid JSON");
  }
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.rules)) {
    throw new Error("terminology file must contain version 1 and a rules array");
  }
  if (value.rules.length > MAX_RULES) throw new Error(`a terminology file can contain at most ${MAX_RULES} rules`);
  return value.rules.map((rule, i) => {
    if (!isRecord(rule)) throw new Error(`terminology rule ${i + 1} is not an object`);
    return validate({
      source: typeof rule.source === "string" ? rule.source : "",
      replacement: typeof rule.replacement === "string" ? rule.replacement : "",
      case_sensitive: rule.case_sensitive === true,
      whole_word: rule.whole_word !== false,
      enabled: rule.enabled !== false,
    });
  });
}

function validate(input: TerminologyRuleInput): TerminologyRuleInput {
  const source = input.source.trim();
  const replacement = input.replacement.trim();
  if (!source) throw new Error("the text to replace cannot be empty");
  if (!replacement) throw new Error("the replacement cannot be empty");
  if (source.length > MAX_TERM_LENGTH || replacement.length > MAX_TERM_LENGTH) {
    throw new Error(`terminology entries cannot exceed ${MAX_TERM_LENGTH} characters`);
  }
  return { ...input, source, replacement };
}

function rejectDuplicate(db: Db, input: TerminologyRuleInput, exceptId?: number): void {
  const where = and(
    eq(terminologyRules.sourceKey, sourceKey(input)),
    eq(terminologyRules.wholeWord, input.whole_word ? 1 : 0),
    ...(exceptId === undefined ? [] : [ne(terminologyRules.id, exceptId)]),
  );
  if (db.select({ id: terminologyRules.id }).from(terminologyRules).where(where).get()) {
    throw new Error("that terminology rule already exists");
  }
}

const toStored = (input: TerminologyRuleInput) => ({
  source: input.source,
  sourceKey: sourceKey(input),
  replacement: input.replacement,
  caseSensitive: input.case_sensitive ? 1 : 0,
  wholeWord: input.whole_word ? 1 : 0,
  enabled: input.enabled ? 1 : 0,
});

const sourceKey = (input: Pick<TerminologyRuleInput, "source" | "case_sensitive">): string =>
  `${input.case_sensitive ? "s" : "i"}:${input.case_sensitive ? input.source : input.source.toLowerCase()}`;

const toPublic = (row: StoredRule): TerminologyRule => ({
  id: row.id,
  source: row.source,
  replacement: row.replacement,
  case_sensitive: row.caseSensitive !== 0,
  whole_word: row.wholeWord !== 0,
  enabled: row.enabled !== 0,
  created_at: row.createdAt,
  updated_at: row.updatedAt,
});

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isWord = (char: string): boolean => /[\p{L}\p{N}_]/u.test(char);
const charBefore = (text: string, index: number): string => text.slice(0, index).match(/.$/u)?.[0] ?? "";
const charAfter = (text: string, index: number): string => text.slice(index).match(/^./u)?.[0] ?? "";
const hasWordBoundaries = (text: string, start: number, end: number): boolean =>
  !isWord(charBefore(text, start)) && !isWord(charAfter(text, end));
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
