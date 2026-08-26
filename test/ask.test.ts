import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { retrieve, send } from "../src/main/ai/ask";
import * as askDb from "../src/main/db/ask";
import { type Db, openDatabase } from "../src/main/db/client";
import { runMigrations } from "../src/main/db/migrate";
import { recordings } from "../src/main/db/schema";
import { seed } from "./seed";

let db: Db;

beforeEach(() => {
  db = openDatabase(":memory:");
  runMigrations(db);
  seed(db);
});

describe("Ask retrieval", () => {
  it("finds lexical evidence and adds nearby transcript context", () => {
    const result = retrieve(db, "What did Priya say about search latency?", askDb.emptyScope());

    expect(result.searchedRecordings).toBe(1);
    expect(result.sources[0]).toMatchObject({
      kind: "transcript",
      recordingId: 9001,
      speaker: "Priya",
      excerpt: "Great, walk me through the search latency first.",
    });
    expect(result.sources[0].context).toContain("pulled the numbers");
  });

  it("uses person and date scope without treating a mentioned name as attendance", () => {
    const inScope = retrieve(db, "roadmap", {
      ...askDb.emptyScope(),
      person_ids: [9201],
      date_from: 1759700000,
      date_to: 1759800000,
    });
    const outOfScope = retrieve(db, "roadmap", {
      ...askDb.emptyScope(),
      person_ids: [999999],
    });

    expect(inScope.sources).toHaveLength(1);
    expect(outOfScope).toMatchObject({ sources: [], searchedRecordings: 0 });
  });

  it("searches linked speaker metadata when a name is not spoken in the transcript", () => {
    const result = retrieve(db, "What did Priya say?", askDb.emptyScope());

    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.sources.every((source) => source.speaker === "Priya")).toBe(true);
  });

  it("excludes incomplete recordings and keeps FTS syntax inert", () => {
    expect(() => retrieve(db, 'interrupted OR "', askDb.emptyScope())).not.toThrow();
    expect(retrieve(db, "interrupted", askDb.emptyScope()).sources).toEqual([]);
  });
});

describe("Ask persistence", () => {
  it("does not leave an empty thread when the first provider call cannot start", async () => {
    await expect(send(db, {
      threadId: null,
      scope: askDb.emptyScope(),
      question: "What was said about latency?",
    })).rejects.toThrow("no AI connection");

    expect(askDb.list(db)).toEqual([]);
  });

  it("saves an exchange, resolves citations, and titles the thread", () => {
    const threadId = askDb.createThread(db, { ...askDb.emptyScope(), recording_ids: [9001] });
    askDb.saveExchange(
      db,
      threadId,
      "What did Priya say about latency?",
      {
        blocks: [{
          text: "Priya asked to review search latency first.",
          refs: [{
            kind: "transcript",
            recordingId: 9001,
            recordingTitle: "Roadmap review",
            meetingDate: 1759754411,
            segmentId: retrieve(db, "latency", askDb.emptyScope()).sources[0].segmentId,
            taskId: null,
            startMs: 7800,
            transcriptVersion: 0,
          }],
        }],
        followUps: ["What numbers followed?"],
        searchedRecordings: 1,
        usedRecordings: 1,
      },
      "Local model",
      "qwen",
    );

    const thread = askDb.get(db, threadId);
    expect(thread).toMatchObject({
      title: "What did Priya say about latency?",
      message_count: 2,
      messages: [
        { role: "user" },
        {
          role: "assistant",
          provider: "Local model",
          searched_recordings: 1,
          used_recordings: 1,
          blocks: [{ citations: [{ speaker: "Priya", unavailable: false, source_changed: false }] }],
        },
      ],
    });
  });

  it("marks a citation changed, then unavailable without retaining its excerpt", () => {
    const source = retrieve(db, "latency", askDb.emptyScope()).sources[0];
    const threadId = askDb.createThread(db, askDb.emptyScope());
    askDb.saveExchange(
      db,
      threadId,
      "Latency?",
      {
        blocks: [{ text: "Latency came first.", refs: [{
          kind: "transcript",
          recordingId: source.recordingId,
          recordingTitle: source.recordingTitle,
          meetingDate: source.meetingDate,
          segmentId: source.segmentId,
          taskId: null,
          startMs: source.startMs,
          transcriptVersion: source.transcriptVersion,
        }] }],
        followUps: [],
        searchedRecordings: 1,
        usedRecordings: 1,
      },
      null,
      null,
    );

    db.update(recordings).set({ transcriptVersion: 1 }).where(eq(recordings.id, 9001)).run();
    expect(askDb.get(db, threadId)?.messages[1].blocks[0].citations[0].source_changed).toBe(true);

    db.delete(recordings).where(eq(recordings.id, 9001)).run();
    expect(askDb.get(db, threadId)?.messages[1].blocks[0].citations[0]).toMatchObject({
      recording_title: source.recordingTitle,
      excerpt: null,
      unavailable: true,
    });
  });
});
