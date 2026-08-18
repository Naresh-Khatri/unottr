-- Seed data for the read-side IPC commands. Apply on top of a migrated db:
--   sqlite3 "$UNOTTR_DATA_DIR/unottr.db" < docs/fixtures/seed.sql
-- Idempotent: clears its own fixed-id rows first. Uses ids >= 9000 to avoid real rows.

DELETE FROM recordings WHERE id IN (9001, 9002, 9003)
   OR path LIKE '/home/naresh/fixtures/%';

-- 1: done, multi-speaker, has video, available
INSERT INTO recordings
  (id, path, fp_size, fp_head, fp_tail, container, duration_ms, recorded_at, status,
   stage_detail, error, attempts, last_chunk_idx, available, created_at, updated_at)
VALUES
  (9001, '/home/naresh/fixtures/2025-10-06 roadmap-review.mp4', 1200000000, x'aa', x'bb', 'mov,mp4,m4a',
   2130000, 1759754411, 'done', NULL, NULL, 0, 71, 1, 1759754411, 1759754411);

-- 2: transcribing in flight (progress bar), no speakers yet
INSERT INTO recordings
  (id, path, fp_size, fp_head, fp_tail, container, duration_ms, recorded_at, status,
   stage_detail, error, attempts, last_chunk_idx, available, created_at, updated_at)
VALUES
  (9002, '/home/naresh/fixtures/2026-08-18 standup.mp4', 900000000, x'cc', x'dd', 'mov,mp4,m4a',
   1980000, 1765000332, 'transcribing', 'chunk 12/44', NULL, 0, 12, 1, 1765000332, 1765000332);

-- 3: failed (truncated), and unavailable (source deleted) — text still searchable
INSERT INTO recordings
  (id, path, fp_size, fp_head, fp_tail, container, duration_ms, recorded_at, status,
   stage_detail, error, attempts, last_chunk_idx, available, created_at, updated_at)
VALUES
  (9003, '/home/naresh/fixtures/2025-10-12 interrupted.mp4', 50000000, x'ee', x'ff', 'mov,mp4,m4a',
   NULL, 1760276883, 'failed', NULL, 'Truncated', 2, NULL, 0, 1760276883, 1760276883);

-- speakers for recording 9001
DELETE FROM speakers WHERE recording_id IN (9001, 9002, 9003);
INSERT INTO speakers (id, recording_id, label, display_name, embedding) VALUES
  (9101, 9001, 'Speaker 1', 'Priya', NULL),
  (9102, 9001, 'Speaker 2', NULL, NULL);

-- segments (words is json: [{text,start_ms,end_ms,p}])
DELETE FROM segments WHERE recording_id IN (9001, 9002, 9003);
INSERT INTO segments (recording_id, chunk_idx, start_ms, end_ms, text, words, speaker_id, split_of) VALUES
  (9001, 0, 1360, 4200, 'Yeah, let''s start with the quarterly roadmap review.',
   '[{"text":"Yeah,","start_ms":1360,"end_ms":1900,"p":0.93},{"text":"let''s","start_ms":2100,"end_ms":2600,"p":0.9}]',
   9101, NULL),
  (9001, 0, 4200, 7800, 'Sounds good, I pulled the numbers this morning.',
   '[]', 9102, NULL),
  (9001, 1, 7800, 11200, 'Great, walk me through the search latency first.',
   '[]', 9101, NULL),
  -- unattributed segment (speaker_id null) to exercise that render path
  (9001, 1, 11200, 13000, '(crosstalk)', '[]', NULL, NULL),
  (9003, 0, 500, 3200, 'This recording was interrupted mid-call.', '[]', NULL, NULL);
