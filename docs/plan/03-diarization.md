# Phase 03 — Diarization

**Goal:** work out who spoke when, and attach that to the transcript. The quality of the
whole product is decided here.

**Depends on:** phases 01 and 02 (needs PCM and word timestamps).

---

## Deliverables

- sherpa-onnx segmentation + speaker embedding, clustered without a known speaker count.
- Merge algorithm joining turns to transcript segments.
- Mic-track shortcut when phase 01 returned `MicDesktop`.
- Speaker rows with persisted embeddings.
- `unottr diarize` CLI subcommand.

## Tasks

### 1. Engine

`sherpa-rs` bindings (or the sherpa-onnx C API directly). Two models, both small enough to
**bundle in app resources** — decision #16 keeps the first-run download to one thing:

| Model | Purpose | Size |
|---|---|---|
| pyannote segmentation-3.0 (ONNX) | speech/overlap segmentation | ~6 MB |
| 3D-Speaker / NeMo speaker embedding (ONNX) | per-turn embeddings | ~28 MB |

Cluster with a **similarity threshold, not a fixed k** — the number of people in a meeting
is exactly what we do not know. Threshold goes in settings (phase 06) with a sane default,
because it is the one knob that fixes bad output in the field.

```rust
pub struct Turn { pub start_ms: u64, pub end_ms: u64, pub speaker: u32 }
pub struct Diarization { pub turns: Vec<Turn>, pub embeddings: Vec<Vec<f32>> }
```

Runs over the **whole** PCM in one pass — clustering is global, which is precisely why
live diarization is out of v1 (decision #13). It is fast relative to ASR; do not chunk it.

### 2. Mic-track shortcut

When phase 01 returned `MicDesktop`:

- Run VAD/energy detection on the **mic** PCM. Those regions are the local user, labelled
  `You`, with no ML and no ambiguity.
- Run full diarization on the **desktop** PCM only, for the remote participants.
- Merge the two label spaces, `You` plus `Speaker 1..N`.

This is strictly better than blind diarization and costs almost nothing. It will not fire
on the current corpus (all single-track), so it needs a purpose-made multi-track test file.

### 3. Merge algorithm

For each transcript segment from phase 02:

1. Compute overlap duration against every turn; assign `argmax`.
2. If the top two overlaps are within 20% of each other **and** a turn boundary falls
   strictly inside the segment, split the segment at the nearest **word** boundary
   (`segments.words` from phase 02) and assign each half independently.
3. No overlapping turn at all -> leave `speaker_id` NULL and render unattributed rather
   than guessing.

Then create `speakers` rows (`Speaker 1..N` by first appearance, so numbering is stable
and reads naturally) and store each cluster centroid in `speakers.embedding`.

Storing embeddings now is what makes cross-meeting recognition a future feature instead of
a full reprocess of the user's archive (decision #17).

## Acceptance criteria

- [x] `unottr diarize` runs end to end on at least 3 real corpus recordings.
- [x] Speaker count within +/- 1 of ground truth on those 3, counted by hand.
      Standup 4, audit review 6, 2-person call 2 -- see *Diarization* in DESIGN.md.
- [x] Spot-check 10 random turn boundaries per file; labels are right at speaker changes.
      Flips land on Q/A transitions; bare back-channels left unattributed, not forced.
- [x] Segment splitting only ever lands on word boundaries — assert in a unit test over
      synthetic turns and word lists.
- [~] `MicDesktop` path -- code path implemented (mic VAD -> `You`, desktop diarized,
      label spaces merged) but NOT verified: the corpus has no purpose-recorded multi-track
      OBS file. Blocked on a real two-track recording; deferred to when one exists.
- [x] Every speaker row has a non-null embedding.
- [x] Merge algorithm has unit tests with no models loaded (synthetic turns + segments).

## Risks

**This is the phase most likely to disappoint.** Meet and Zoom apply aggressive echo
cancellation and noise suppression, which is good for humans and bad for speaker
embeddings. Judge quality on the real corpus, never on clean podcast audio.

If sherpa's output is not good enough: fall back to **pyannote.audio via a Python sidecar**.
It is the accuracy leader, and because everything downstream consumes the `Diarization`
struct, it is a swap behind this one stage — not a redesign. It does cost the
zero-dependency property, so it is a deliberate trade, not a default.

Decide this on evidence at the end of the phase, and write the decision into DESIGN.md.

## Out of scope

Cross-meeting speaker identity. Embeddings are stored, not compared across recordings.
