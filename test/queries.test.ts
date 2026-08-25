import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { type Db, openDatabase } from "../src/main/db/client";
import { runMigrations } from "../src/main/db/migrate";
import * as peopleDb from "../src/main/db/people";
import * as overviewsDb from "../src/main/db/overviews";
import * as q from "../src/main/db/queries";
import { recordings, segments, speakers, tasks } from "../src/main/db/schema";
import * as speakersDb from "../src/main/db/speakers";
import * as settingsDb from "../src/main/db/settings";
import * as wf from "../src/main/db/watch-folders";
import { load as loadTranscript, parseFormat, render } from "../src/main/export";
import { seed } from "./seed";

const SORT = { by: "recorded_at", dir: "desc" } as const;

let db: Db;

beforeEach(() => {
  db = openDatabase(":memory:");
  runMigrations(db);
  seed(db);
});

describe("listRecordings", () => {
  it("filters by status and availability", () => {
    expect(q.listRecordings(db, { status: "done" }, SORT).map((r) => r.id)).toEqual([9001]);
    expect(q.listRecordings(db, { available: false }, SORT).map((r) => r.id)).toEqual([9003]);
  });

  it("sorts by duration, nulls first ascending", () => {
    const asc = q.listRecordings(db, {}, { by: "duration_ms", dir: "asc" });
    expect(asc.map((r) => r.id)).toEqual([9003, 9002, 9001]);
  });

  it("sorts by creation time in either direction", () => {
    db.update(recordings).set({ createdAt: 1 }).where(eq(recordings.id, 9001)).run();
    db.update(recordings).set({ createdAt: 3 }).where(eq(recordings.id, 9002)).run();
    db.update(recordings).set({ createdAt: 2 }).where(eq(recordings.id, 9003)).run();

    const descending = q.listRecordings(db, {}, { by: "created_at", dir: "desc" });
    const ascending = q.listRecordings(db, {}, { by: "created_at", dir: "asc" });
    expect(descending.map((r) => r.id)).toEqual([9002, 9003, 9001]);
    expect(descending.map((r) => r.created_at)).toEqual([3, 2, 1]);
    expect(ascending.map((r) => r.id)).toEqual([9001, 9003, 9002]);
  });

  it("puts the newest id first when recordings are created in the same second", () => {
    db.update(recordings).set({ createdAt: 1 }).run();

    const rows = q.listRecordings(db, {}, { by: "created_at", dir: "desc" });
    expect(rows.map((r) => r.id)).toEqual([9003, 9002, 9001]);
  });

  it("filters by a path substring", () => {
    expect(q.listRecordings(db, { query: "standup" }, SORT).map((r) => r.id)).toEqual([9002]);
  });

  it("surfaces the display title, user-set outranking the ai one", () => {
    const title = (id: number) => q.listRecordings(db, {}, SORT).find((x) => x.id === id)?.title;
    expect(title(9001)).toBeNull();

    db.update(recordings).set({ aiTitle: "Q4 roadmap trade-offs" }).where(eq(recordings.id, 9001)).run();
    expect(title(9001)).toBe("Q4 roadmap trade-offs");

    db.update(recordings).set({ title: "Roadmap, take two" }).where(eq(recordings.id, 9001)).run();
    expect(title(9001)).toBe("Roadmap, take two");
  });

  it("setTitle writes the user title and blank clears it", () => {
    const title = () => q.listRecordings(db, {}, SORT).find((x) => x.id === 9001)?.title;
    q.setTitle(db, 9001, "  Roadmap  ");
    expect(title()).toBe("Roadmap");
    expect(q.search(db, "roadmap", 10)[0]?.title).toBe("Roadmap");
    q.setTitle(db, 9001, "   ");
    expect(title()).toBeNull();
    expect(() => q.setTitle(db, 424242, "x")).toThrow();
  });

  it("computes speaker_count, filename and has_video", () => {
    const r = q.listRecordings(db, {}, SORT).find((x) => x.id === 9001);
    expect(r).toMatchObject({
      speaker_count: 2,
      has_video: true,
      filename: "2025-10-06 roadmap-review.mp4",
      available: true,
    });
  });
});

describe("getRecording", () => {
  it("returns parsed words and speakers", () => {
    const detail = q.getRecording(db, 9001);
    expect(detail).not.toBeNull();
    if (!detail) return;

    expect(detail.recording.container).toBe("mov,mp4,m4a");
    expect(detail.speakers).toHaveLength(2);
    expect(detail.segments).toHaveLength(4);
    expect(detail.segments[0].words[0].text).toBe("Yeah,");
    expect(detail.segments[0].speaker_id).toBe(9101);

    // unattributed segment renders null, not guessed
    const crosstalk = detail.segments.find((s) => s.text === "(crosstalk)");
    expect(crosstalk?.speaker_id).toBeNull();
    expect(crosstalk?.words).toEqual([]);
  });

  it("is null for a missing id", () => {
    expect(q.getRecording(db, 424242)).toBeNull();
  });
});

describe("search", () => {
  it("returns ranked hits with a marked snippet", () => {
    const hits = q.search(db, "roadmap", 10);
    expect(hits).toHaveLength(1);
    expect(hits[0].recording_id).toBe(9001);
    expect(hits[0].filename).toBe("2025-10-06 roadmap-review.mp4");
    expect(hits[0].snippet).toContain("<b>roadmap</b>");
  });

  it("treats the whole query as a phrase, so fts syntax is inert", () => {
    // would be a syntax error if it reached fts5 as an expression
    expect(() => q.search(db, 'roadmap OR "', 10)).not.toThrow();
  });

  it("loses the fts row when the segment is deleted (trigger survived migration)", () => {
    const [hit] = q.search(db, "roadmap", 10);
    db.delete(segments).where(eq(segments.id, hit.segment_id)).run();
    expect(q.search(db, "roadmap", 10)).toEqual([]);
  });

  it("follows an update through the trigger pair", () => {
    const [hit] = q.search(db, "quarterly", 10);
    db.update(segments).set({ text: "replaced entirely" }).where(eq(segments.id, hit.segment_id)).run();
    expect(q.search(db, "quarterly", 10)).toEqual([]);
    expect(q.search(db, "replaced", 10)).toHaveLength(1);
  });
});

describe("renameSpeaker", () => {
  const speaker = (id: number) => q.getRecording(db, 9001)?.speakers.find((s) => s.id === id);

  it("round trips and an empty name clears it", () => {
    q.renameSpeaker(db, 9102, "Dana");
    expect(speaker(9102)).toMatchObject({ display_name: "Dana", person_id: expect.any(Number) });

    q.renameSpeaker(db, 9101, "");
    expect(speaker(9101)).toMatchObject({ display_name: null, person_id: null });
  });

  it("reads the name off the linked person, so a global rename follows", () => {
    expect(speaker(9101)?.display_name).toBe("Priya");
    peopleDb.rename(db, speaker(9101)!.person_id!, "Priya R");
    expect(speaker(9101)?.display_name).toBe("Priya R");
  });

  it("throws on an unknown speaker id", () => {
    expect(() => q.renameSpeaker(db, 404, "Nobody")).toThrow();
  });
});

describe("speaker fixes", () => {
  const detail = () => q.getRecording(db, 9001)!;
  const segIds = () => detail().segments.map((s) => s.id);
  const version = () =>
    db.select({ v: recordings.speakersVersion }).from(recordings).where(eq(recordings.id, 9001)).get()?.v;

  const addTask = (ownerSpeakerId: number | null): number =>
    db
      .insert(tasks)
      .values({ recordingId: 9001, text: "Chase the numbers", ownerSpeakerId, startMs: 4200, createdAt: 0, updatedAt: 0 })
      .returning({ id: tasks.id })
      .get().id;

  it("merge moves segments and tasks, then drops the row", () => {
    const taskId = addTask(9102);
    expect(speakersDb.segmentCount(db, 9102)).toBe(1);

    speakersDb.mergeSpeakers(db, 9102, 9101);

    const d = detail();
    expect(d.speakers.map((s) => s.id)).toEqual([9101]);
    expect(d.segments.map((s) => s.speaker_id)).toEqual([9101, 9101, 9101, null]);
    expect(db.select().from(tasks).where(eq(tasks.id, taskId)).get()?.ownerSpeakerId).toBe(9101);
    expect(version()).toBe(1);
  });

  it("merge carries a person link onto an anonymous target, and never the other way", () => {
    speakersDb.mergeSpeakers(db, 9101, 9102);
    const kept = detail().speakers[0];
    expect(kept).toMatchObject({ id: 9102, person_id: 9201, display_name: "Priya" });

    // the named one survived that merge, so a second one has nothing to carry
    const fresh = speakersDb.assignToNewSpeaker(db, segIds()[0]);
    speakersDb.mergeSpeakers(db, fresh, 9102);
    expect(detail().speakers[0].person_id).toBe(9201);
  });

  it("merge refuses itself, an unknown id and a speaker from another recording", () => {
    expect(() => speakersDb.mergeSpeakers(db, 9101, 9101)).toThrow();
    expect(() => speakersDb.mergeSpeakers(db, 9101, 404)).toThrow();
    const other = db
      .insert(speakers)
      .values({ recordingId: 9003, label: "Speaker 1" })
      .returning({ id: speakers.id })
      .get().id;
    expect(() => speakersDb.mergeSpeakers(db, 9101, other)).toThrow();
    expect(version()).toBe(0);
  });

  it("reassigns one segment, including off every speaker", () => {
    const [first] = segIds();
    speakersDb.setSegmentSpeaker(db, first, 9102);
    expect(detail().segments[0].speaker_id).toBe(9102);

    speakersDb.setSegmentSpeaker(db, first, null);
    expect(detail().segments[0].speaker_id).toBeNull();
    expect(version()).toBe(2);

    expect(() => speakersDb.setSegmentSpeaker(db, 404, 9101)).toThrow();
    expect(() => speakersDb.setSegmentSpeaker(db, first, 404)).toThrow();
  });

  it("new speaker takes the next free label", () => {
    const crosstalk = detail().segments.find((s) => s.text === "(crosstalk)")!.id;
    const created = speakersDb.assignToNewSpeaker(db, crosstalk);
    expect(detail().speakers.find((s) => s.id === created)?.label).toBe("Speaker 3");
    expect(detail().segments[3].speaker_id).toBe(created);

    // merging it away frees the label again — nextLabel counts live rows, not history
    speakersDb.mergeSpeakers(db, created, 9101);
    const next = speakersDb.assignToNewSpeaker(db, crosstalk);
    expect(detail().speakers.find((s) => s.id === next)?.label).toBe("Speaker 3");
  });

  it("leaves the transcript text alone, so search still finds it", () => {
    speakersDb.mergeSpeakers(db, 9102, 9101);
    expect(q.search(db, "roadmap", 10)).toHaveLength(1);
  });

  it("flips the overview stale, naming speakers as the reason", () => {
    const write = {
      model: "m", provider: "p", roleUsed: null, title: "Roadmap", tldr: "We talked.",
      sections: [], decisions: [], tasks: [], tokensIn: null, tokensOut: null,
    };
    overviewsDb.markRunning(db, 9001, "m", "p", null);
    overviewsDb.save(db, 9001, write);
    expect(overviewsDb.get(db, 9001)).toMatchObject({ stale: false, stale_reason: null });

    speakersDb.setSegmentSpeaker(db, segIds()[0], 9102);
    expect(overviewsDb.get(db, 9001)).toMatchObject({ stale: true, stale_reason: "speakers" });

    // regenerating against the new cast settles it again
    overviewsDb.save(db, 9001, write);
    expect(overviewsDb.get(db, 9001)?.stale).toBe(false);
  });
});

describe("watch folders", () => {
  it("adds idempotently, lists by path and removes", () => {
    const a = wf.addOrEnable(db, "/home/naresh/meetings");
    expect(a).toMatchObject({ track_rule: "auto", enabled: true });

    expect(wf.addOrEnable(db, "/home/naresh/meetings").id).toBe(a.id);
    expect(wf.list(db)).toHaveLength(1);

    wf.remove(db, a.id);
    expect(wf.list(db)).toEqual([]);
  });

  it("re-adding a disabled folder turns it back on", () => {
    const a = wf.addOrEnable(db, "/home/naresh/meetings");
    wf.setEnabled(db, a.id, false);
    expect(wf.get(db, a.id)?.enabled).toBe(false);
    expect(wf.addOrEnable(db, "/home/naresh/meetings").enabled).toBe(true);
  });

  it("stores the track rule verbatim", () => {
    const a = wf.addOrEnable(db, "/home/naresh/meetings");
    wf.setTrackRule(db, a.id, '{"kind":"stream","stream":1}');
    expect(wf.get(db, a.id)?.track_rule).toBe('{"kind":"stream","stream":1}');
  });
});

describe("settings", () => {
  it("defaults on an empty table and persists a change", () => {
    expect(q.getSettings(db, true)).toMatchObject({
      model_tier: "auto",
      language: null,
      device: "auto",
      diarize_threshold: null,
      close_to_tray: true,
      tray_available: true,
      first_run_complete: false,
    });

    // tray_available reflects the caller's flag, not storage
    expect(q.setSetting(db, "model_tier", "medium", false)).toMatchObject({
      model_tier: "medium",
      tray_available: false,
    });
    expect(q.getSettings(db, false).model_tier).toBe("medium");
  });

  it("reads an empty diarize_threshold as unset, not zero", () => {
    settingsDb.setRaw(db, "diarize_threshold", "");
    expect(q.getSettings(db, false).diarize_threshold).toBeNull();
  });

  it("validates keys and values", () => {
    expect(settingsDb.validate("model_tier", "medium")).toBeNull();
    expect(settingsDb.validate("model_tier", "huge")).not.toBeNull();
    expect(settingsDb.validate("diarize_threshold", "0.5")).toBeNull();
    expect(settingsDb.validate("diarize_threshold", "1.5")).not.toBeNull();
    expect(settingsDb.validate("diarize_threshold", "")).not.toBeNull();
    expect(settingsDb.validate("ffmpeg_path", "")).toBeNull();
    expect(settingsDb.validate("nope", "1")).not.toBeNull();
  });
});

describe("export", () => {
  it("joins display_name, falls back to label and leaves unattributed null", () => {
    const t = loadTranscript(db, 9001);
    expect(t.filename).toBe("2025-10-06 roadmap-review.mp4");
    expect(t.segments.map((s) => s.speaker)).toEqual(["Priya", "Speaker 2", "Priya", null]);
  });

  it("renders srt with comma milliseconds and vtt with a period", () => {
    const t = loadTranscript(db, 9001);
    expect(render("srt", t)).toContain("00:00:01,360 --> 00:00:04,200");
    expect(render("vtt", t).startsWith("WEBVTT\n\n1\n00:00:01.360 --> 00:00:04.200\n")).toBe(true);
  });

  it("prefixes txt with a timestamp and skips the speaker when unattributed", () => {
    const out = render("txt", loadTranscript(db, 9001));
    expect(out).toContain("[00:00:01] Priya: Yeah, let's start");
    expect(out).toContain("[00:00:11] (crosstalk)");
  });

  it("round-trips json back to the same transcript", () => {
    const t = loadTranscript(db, 9001);
    expect(JSON.parse(render("json", t))).toEqual(t);
  });

  it("accepts exactly the four formats", () => {
    for (const f of ["txt", "json", "srt", "vtt"] as const) expect(parseFormat(f)).toBe(f);
    expect(parseFormat("docx")).toBeNull();
  });

  it("throws for a missing recording", () => {
    expect(() => loadTranscript(db, 404)).toThrow();
  });
});
