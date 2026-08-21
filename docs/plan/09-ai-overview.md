# Phase 09 — AI overview

**Goal:** turn a finished transcript into something you read in thirty seconds instead of
forty minutes — a title, a summary, the decisions, and the tasks that are *yours*, every
line clickable back to the moment it came from.

**Depends on:** phase 08 (the TypeScript app). Does not depend on 08's open packaging
boxes.

**Decisions:** #25–#34 in `DESIGN.md`.

---

## The shape of it

```
[ Generate ]  ->  main/ai  ->  mistral-large-2512  ->  zod  ->  ground  ->  db  ->  Overview tab
                     ^                                            |
                 safeStorage                              segment_id -> start_ms
                                                          unknown id -> dropped
```

Three properties carry the whole design:

1. **The model never sees a timestamp and never emits one.** It is given segments with
   ids, and it cites ids. Ids are resolved locally. A citation the model invented does not
   resolve, so it is dropped rather than rendered as a confident link into the wrong minute
   of the video. This is the difference between a summary you can trust and one you have to
   spot-check.
2. **AI is a satellite, not a pipeline stage.** `recordings.status` is untouched. A dropped
   connection cannot mark a perfectly good transcript `failed`.
3. **It costs money, so it asks.** Transcription stays automatic; this never runs without a
   click.

## Deliverables

- `overviews` + `tasks` + `overview_fts`, migration `0004_ai.sql`.
- `src/main/ai/` — provider, prompt, schema, grounding, task merge.
- `unottr://frame/<id>/<ms>` — lazily extracted, cached still frames.
- Overview tab: summary, decisions, your actions vs everyone else's, thumbnails.
- Settings: key, model, pseudonymize, spend; "this is me" + role on a person.
- Overview text in search; overview in `.txt`/`.json` export; copy-as-Markdown.

## Tasks

### 1. Dependencies

`ai@^7`, `@ai-sdk/mistral@^4`, `zod@^4` — into **`dependencies`**, not dev. `main` is built
with `externalizeDepsPlugin()`, so these are resolved from `node_modules` at runtime and
must survive into the asar. All three are pure JS; nothing to rebuild, nothing to unpack.

### 2. Migration `drizzle/0004_ai.sql`

```sql
overviews(id, recording_id UNIQUE -> recordings ON DELETE CASCADE,
          status, error, error_kind, model, prompt_version, role_used,
          title, tldr, sections JSON, decisions JSON,
          tokens_in, tokens_out, created_at, updated_at)

tasks(id, recording_id -> recordings ON DELETE CASCADE,
      text, owner_speaker_id -> speakers ON DELETE SET NULL, start_ms,
      due_raw, due_date, status, user_edited, created_at, updated_at)

overview_fts             -- FTS5(recording_id UNINDEXED, title, body)
recordings.title         -- user-set, nullable
recordings.ai_title      -- model-set, nullable
people.is_me             -- integer, at most one row set
people.role              -- free text, nullable
```

- One overview row per recording, **updated in place**. Regeneration overwrites; there is
  no version history (decision #21 in the round — prose is 1.4¢ to remake, a checked-off
  task list is not).
- `overview_fts` is a **standalone** FTS5 table maintained by the one function that writes
  an overview — no triggers. `segments_fts`' triggers are bound to `segments`; keep the two
  independent.
- Display title is `coalesce(recordings.title, recordings.ai_title, basename(path))` —
  the same "more deliberate answer wins" precedence as
  `coalesce(people.name, speakers.display_name, speakers.label)`.
- `people.is_me` is enforced single-valued in the setter, not by a constraint (SQLite has
  no partial unique index worth the trouble here): setting it clears every other row first.

**Deviation from the settled round-2 answer, deliberate.** Task ownership references
`speakers.id`, not `people.id`. A `people` row only exists once someone has been *named*,
and in a fresh library nobody has been — so a `people`-keyed owner would be `NULL` on
essentially every task and the feature would be dead on arrival. Speakers always exist.
"Mine" is then a join, not a column: a task is mine when
`speakers.person_id = (select id from people where is_me = 1)`. The user-facing behaviour
is exactly what was agreed; only the foreign key moved.

### 3. `src/main/ai/` — the module

| File | Responsibility |
|---|---|
| `provider.ts` | `createMistral({ apiKey })`, model resolution, key read from `safeStorage` |
| `schema.ts` | the zod schema the model is held to — **snake_case, LLM-shaped** |
| `prompt.ts` | transcript serialization, roster, role injection, `PROMPT_VERSION` |
| `ground.ts` | LLM shape -> ipc shape; the only place a citation is validated |
| `generate.ts` | orchestration: build, call, validate, ground, persist, index, emit |

Task status/text mutation and the merge-on-regenerate rule live in `src/main/db/overviews.ts`,
next to the rows they touch, rather than in a separate `ai/tasks.ts` — nothing about them
involves the model.

The call itself, AI SDK v7 — `generateObject` still exists, but `generateText` with
`Output.object` is the shape that keeps one code path for the plain-text and structured cases:

```ts
const { output } = await generateText({
  model: mistral(modelId),
  output: Output.object({ schema: OverviewSchema }),
  abortSignal,
  prompt,
});
```

Runs in **main**, never the worker. The worker exists because native addons segfault; an
HTTPS call has no such failure mode and forking for it buys IPC plumbing for nothing.

### 4. Prompt and grounding

**Transcript** is serialized one line per segment:

```
[4711] Naresh: go back to your software and then close that floating
```

Speaker name is the usual coalesce. With `ai_pseudonymize` on, names become
`Speaker A/B/C` on the way out and are mapped back on the way in — attribution survives,
names never transit.

**Roster** is passed as a separate block, `[{ speaker_id, name, is_me }]`, and
`owner_speaker_id` is constrained to those ids.

**Role** is injected as framing, never as a filter: the model is told what the user does so
it ranks and phrases their items usefully, and told explicitly to extract *every* task
regardless of who owns it. Filtering by role would let one bad speaker attribution silently
delete a task the user owned — an invisible failure, the worst kind.

**Grounding rules** (`ground.ts`, and only there):

- Build the set of real segment ids once. Any bullet, decision, or task citing an id
  outside it is **dropped**. A section left with no bullets is dropped.
- `owner_speaker_id` not in the roster -> `null`.
- `due_date` that does not parse as `YYYY-MM-DD` -> `null`; `due_raw` is kept regardless.
  "By end of month" resolved wrongly is worse than not resolved.
- Cited ids become `start_ms` here. Nothing downstream of this file knows segment ids exist.

**Validation failure**: one retry with the validation error appended, then the overview row
goes `failed`. No partial saves, no patching broken JSON.

### 5. Task merge on regenerate

Regeneration replaces the prose outright. For tasks:

1. Delete tasks where `user_edited = 0 AND status = 'open'` — untouched suggestions.
2. Insert the new set, **skipping** any whose normalized text matches a surviving row.
3. Everything edited, done, or dismissed survives untouched.

A regenerate must never un-check a checked box or discard typed text.

### 6. `unottr://frame/<id>/<ms>`

The visual half, without a keyframe pipeline. On request, `ffmpeg -ss <ms> -frames:v 1` at
width 480 into the existing thumbs cache as `${id}.f${ms}.jpg`, served by
`media-protocol.ts` alongside `thumb` and `preview`. First hit costs one seek (~50 ms),
every hit after is a file read.

- Cached forever; purged with the rest of the thumbs cache.
- Audio-only or unavailable recording -> the same dashed placeholder the library rows use.
- Clicking seeks the player, which is the actual point — the picture is orientation, the
  seek is the payload.

### 7. IPC additions

Wire stays snake_case (`src/shared/ipc.ts` is frozen in style, not in size).

```ts
OverviewBullet  { text, start_ms }
OverviewSection { heading, start_ms, end_ms, bullets }
Task            { id, recording_id, text, owner_speaker_id, owner_name, is_mine,
                  start_ms, due_raw, due_date, status, user_edited }
Overview        { recording_id, status, error, error_kind, model, title, tldr,
                  sections, decisions, tasks, updated_at }
```

Methods: `overview_get`, `overview_generate`, `task_set_status`, `task_update`,
`ai_settings_get`/`ai_settings_set`, `ai_key_set`/`ai_key_status`, `person_set_me`,
`person_set_role`. One event, `overview:changed`, carrying a recording id.

The renderer never sees a key, a model id it did not ask for, or a segment id.

### 8. Key, consent, settings

- Key is encrypted with `safeStorage.encryptString` and the ciphertext stored base64 in
  `settings` under `mistral_api_key_enc`. `ai_key_status` reports presence and a masked
  tail, never the key.
- `safeStorage.isEncryptionAvailable()` is **false on a Linux box with no keyring**. Do not
  silently fall back to plaintext: say so, and require an explicit acknowledgement before
  storing it unencrypted under a differently-named key.
- First generate shows a consent dialog containing a **literal excerpt of the outgoing
  payload**, not a paragraph about it. `ai_consented` records the answer.
- Settings keys: `ai_model` (default `mistral-large-2512`), `ai_pseudonymize` (default
  off), `ai_consented`, `ai_spend_cents` (running total, incremented from the usage the SDK
  returns).
- **Pin the model.** `mistral-large-latest` is a floating alias; it would silently
  invalidate `prompt_version` staleness and any captured output. The dropdown is how the
  model changes.

### 9. Overview tab

A third tab beside the transcript. Four states: no key, empty (button), running (spinner —
**no streaming**; assembling JSON in public for eight seconds is worse than a well-behaved
wait), done, failed (typed error + Retry).

- Title, TL;DR, then sections — each with its time range and bullets, each bullet a
  thumbnail + timecode that seeks the player.
- Decisions as their own block.
- **Two task lists: "Your actions" and "Everyone else's."** Same extraction, split on
  `is_mine`. Checkbox, inline text edit, dismiss.
- Stale banner when speakers were renamed or the recording re-diarized since
  `overviews.updated_at`, with a Regenerate button. Never auto-spend.
- "Copy as Markdown" — the realistic destination of these summaries is a Slack message
  thirty seconds later.

### 10. Search and export

- Overview matches come back badged distinctly from transcript matches; a hit opens the
  Overview tab, not the transcript at 0:00.
- `.json` carries the overview in full; `.txt` gets it as a header block; **`.srt`/`.vtt`
  are untouched** — they are subtitle formats and prose in them breaks every consumer.

### 11. Documents that this makes wrong

Both are edited in the same change that ships the feature, not after:

- `README.md` — "No cloud, no accounts, no LLM" and the Privacy section. The honest
  replacement: *no network in the transcribe/diarize path; the AI overview is opt-in, names
  its provider, and sends transcript text only — never audio or video.*
- `DESIGN.md` — "Out of v1: summaries or any LLM".

## Testing

Deliberately lean. Two things, no more:

- One unit test over `ground.ts` with a canned `MockLanguageModelV3` payload: an invalid
  `segment_id` is dropped, an out-of-roster owner becomes `null`, an unparseable `due_date`
  becomes `null` while `due_raw` survives, and a section emptied by drops disappears.
- One mock overview in the renderer's mock ipc client, so the UI is buildable and
  reviewable with no key configured.

No golden fixture, no integration test against the live API.

## Acceptance criteria

- [ ] Generate on a real corpus recording produces a titled overview whose citations all
      land on the right moment in the video.
- [x] A fabricated `segment_id` in a mocked response is dropped, not rendered.
- [ ] Tasks split correctly into mine vs theirs once a person is marked "me".
- [ ] Regenerate keeps checked, dismissed, and edited tasks; replaces the rest.
- [ ] Quitting mid-generate leaves no `running` row after restart.
- [ ] No key configured: the app behaves exactly as it does today, everywhere.
- [ ] A failed call leaves `recordings.status = 'done'` and the transcript readable.
- [x] `pnpm typecheck` and `pnpm test` clean.

The unchecked boxes above all need a live app and a real key — they are in
`MANUAL-CHECKS.md` under *AI overview (phase 09)*.

## Risks

- **Task extraction quality is the whole feature.** A summary that is merely fine is
  tolerable; a task list that misses commitments or invents them is worse than no task
  list. This is what the corpus recordings are for, and the tuning surface is the prompt,
  not the schema.
- **Anonymous speakers.** Until someone is named, "your actions" cannot exist. The Overview
  tab has to say that plainly and point at the naming affordance rather than showing an
  empty list that looks like a bug.
- **Code-switched meetings.** The corpus mixes English and Malay mid-sentence. Output is
  English (decision #33), but quoted phrases must stay verbatim in their original language;
  a translated "quote" is a fabricated one.
- **Long meetings.** 256k context covers a six-hour recording, so there is no chunking —
  but no chunking also means no partial result if the call fails at the end. Accepted.
- **`safeStorage` on bare Linux.** See task 8. The failure is silent unless it is handled
  loudly.

## Out of scope

Vision and OCR of screen shares (decision #29 — the highest-value future addition, and the
`unottr://frame` route is the hook for it). Cross-recording rollups: tasks are first-class
rows precisely so "my open tasks across every meeting" is later a query, not a migration.
Local inference: the provider module is the seam, `Ministral 3 8B` the likely occupant.
