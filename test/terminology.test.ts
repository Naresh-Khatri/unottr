import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { type Db, openDatabase } from "../src/main/db/client";
import { runMigrations } from "../src/main/db/migrate";
import * as overviews from "../src/main/db/overviews";
import * as queries from "../src/main/db/queries";
import { recordings, segments } from "../src/main/db/schema";
import * as terminology from "../src/main/db/terminology";
import { seed } from "./seed";

const rule = (
  id: number,
  source: string,
  replacement: string,
  options: Partial<{ case_sensitive: boolean; whole_word: boolean; enabled: boolean }> = {},
) => ({
  id,
  source,
  replacement,
  case_sensitive: options.case_sensitive ?? false,
  whole_word: options.whole_word ?? true,
  enabled: options.enabled ?? true,
});

describe("terminology replacement", () => {
  it("matches whole words without caring about case by default", () => {
    expect(apply("POST GRASS is not post grassy", [rule(1, "post grass", "Postgres")]))
      .toBe("Postgres is not post grassy");
  });

  it("handles unicode word boundaries", () => {
    expect(apply("Use café, not décaféiné.", [rule(1, "café", "coffee")]))
      .toBe("Use coffee, not décaféiné.");
  });

  it("prefers the longer phrase and never cascades replacement output", () => {
    const rules = [
      rule(1, "new", "old"),
      rule(2, "new york", "NYC"),
      rule(3, "old", "ancient"),
    ];
    expect(apply("new york and new", rules)).toBe("NYC and old");
  });

  it("honours case-sensitive, substring and disabled rules", () => {
    const rules = [
      rule(1, "API", "interface", { case_sensitive: true }),
      rule(2, "cat", "dog", { whole_word: false }),
      rule(3, "unused", "used", { enabled: false }),
    ];
    expect(apply("API api cat category unused", rules)).toBe("interface api dog dogegory unused");
  });
});

describe("terminology persistence", () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
    seed(db);
  });

  it("applies rules to finished recordings, preserves raw text and refreshes FTS", () => {
    terminology.create(db, {
      source: "quarterly roadmap",
      replacement: "Q4 plan",
      case_sensitive: false,
      whole_word: true,
      enabled: true,
    });

    expect(terminology.applyToLibrary(db)).toEqual({ recordingIds: [9001], segmentsChanged: 1 });
    const changed = db
      .select({ text: segments.text, rawText: segments.rawText })
      .from(segments)
      .where(eq(segments.recordingId, 9001))
      .all()
      .find((row) => row.rawText !== null);
    expect(changed).toEqual({
      text: "Yeah, let's start with the Q4 plan review.",
      rawText: "Yeah, let's start with the quarterly roadmap review.",
    });
    expect(queries.search(db, "quarterly roadmap", 10)).toEqual([]);
    expect(queries.search(db, "Q4 plan", 10)).toHaveLength(1);
    expect(db.select().from(recordings).where(eq(recordings.id, 9001)).get()?.transcriptVersion).toBe(1);
  });

  it("reverts from raw text after a rule is removed", () => {
    const saved = terminology.create(db, {
      source: "quarterly roadmap",
      replacement: "Q4 plan",
      case_sensitive: false,
      whole_word: true,
      enabled: true,
    });
    terminology.applyToLibrary(db);
    terminology.remove(db, saved.id);

    expect(terminology.applyToLibrary(db)).toEqual({ recordingIds: [9001], segmentsChanged: 1 });
    expect(queries.search(db, "quarterly roadmap", 10)).toHaveLength(1);
    expect(db.select().from(recordings).where(eq(recordings.id, 9001)).get()?.transcriptVersion).toBe(2);
  });

  it("marks an existing overview stale when displayed transcript text changes", () => {
    overviews.markRunning(db, 9001, "model", "provider", null);
    overviews.save(db, 9001, {
      model: "model",
      provider: "provider",
      roleUsed: null,
      title: "Roadmap",
      tldr: "A recap.",
      sections: [],
      decisions: [],
      tasks: [],
      tokensIn: null,
      tokensOut: null,
    });
    expect(overviews.get(db, 9001)?.stale).toBe(false);

    terminology.create(db, {
      source: "quarterly",
      replacement: "Q4",
      case_sensitive: false,
      whole_word: true,
      enabled: true,
    });
    terminology.applyToLibrary(db);
    expect(overviews.get(db, 9001)).toMatchObject({ stale: true, stale_reason: "transcript" });
  });

  it("round-trips exported rules and updates a matching imported rule", () => {
    terminology.create(db, {
      source: "post grass",
      replacement: "Postgres",
      case_sensitive: false,
      whole_word: true,
      enabled: true,
    });
    const exported = terminology.serialize(db);
    expect(JSON.parse(exported)).toMatchObject({ version: 1, rules: [{ replacement: "Postgres" }] });

    const imported = JSON.stringify({
      version: 1,
      rules: [{
        source: "post grass",
        replacement: "PostgreSQL",
        case_sensitive: false,
        whole_word: true,
        enabled: true,
      }],
    });
    expect(terminology.importJson(db, imported)).toBe(1);
    expect(terminology.list(db)).toHaveLength(1);
    expect(terminology.list(db)[0].replacement).toBe("PostgreSQL");
  });

  it("rejects duplicate case-insensitive rules with different source casing", () => {
    terminology.create(db, {
      source: "API",
      replacement: "interface",
      case_sensitive: false,
      whole_word: true,
      enabled: true,
    });
    expect(() => terminology.create(db, {
      source: "api",
      replacement: "interface",
      case_sensitive: false,
      whole_word: true,
      enabled: true,
    })).toThrow("already exists");
  });
});

const apply = (text: string, rules: ReturnType<typeof rule>[]): string =>
  terminology.applyRules(text, rules);
