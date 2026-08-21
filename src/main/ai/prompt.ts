// What actually leaves the machine. The transcript is serialized one line per segment with
// its id in front, because the model cites ids and never timestamps — see ground.ts for the
// other half of that bargain.

/**
 * Bump on any change to the wording below. It is what makes an existing overview knowably
 * stale, so a prompt tweak that would produce a better answer is visible in the ui instead
 * of only applying to recordings summarized after the release.
 */
export const PROMPT_VERSION = 1;

export interface CastMember {
  id: number;
  label: string; // "Speaker 1"
  name: string | null;
  isMe: boolean;
}

export interface PromptSegment {
  id: number;
  text: string;
  speakerId: number | null;
}

export interface PromptInput {
  cast: CastMember[];
  segments: PromptSegment[];
  /** the "me" person's role, verbatim; framing only, never a filter */
  role: string | null;
  recordedAt: number | null; // unix seconds
  /** send `Speaker A/B/C` instead of real names; ids still carry attribution home */
  pseudonymize: boolean;
}

export interface BuiltPrompt {
  system: string;
  prompt: string;
  /** every id the model is allowed to cite */
  segmentIds: Set<number>;
  speakerIds: Set<number>;
}

const SYSTEM = `You read a meeting transcript and produce a structured overview of it.

Rules you never break:
- Every claim you make cites the segment_id of the transcript line it came from. Copy the id
  exactly as it appears in brackets. Never invent one, never guess, never cite a range.
- Write in English even when the transcript is not. The one exception is a direct quote:
  quote it verbatim in the language it was spoken in. A translated quote is a fabricated one.
- Report only what was said. If the meeting settled nothing, return no decisions. An empty
  list is a correct answer; an invented entry is not.
- Extract every task anyone committed to, no matter who owns it. Do not filter by who the
  reader is.
- A task is something a person will do after this meeting. "We should think about pricing"
  is not a task. "Priya sends the pricing deck by Friday" is.
- Sections follow the meeting's own order. Do not reorganize it into a report.`;

export function build(input: PromptInput): BuiltPrompt {
  const names = new Map<number, string>();
  input.cast.forEach((c, i) => {
    names.set(c.id, input.pseudonymize ? `Speaker ${letter(i)}` : (c.name ?? c.label));
  });

  const roster = input.cast
    .map((c) => `  speaker_id ${c.id} = ${names.get(c.id)}${c.isMe ? " (this is the reader)" : ""}`)
    .join("\n");

  const transcript = input.segments
    .map((s) => `[${s.id}] ${(s.speakerId !== null && names.get(s.speakerId)) || "Unknown"}: ${s.text}`)
    .join("\n");

  const date = input.recordedAt ? new Date(input.recordedAt * 1000).toISOString().slice(0, 10) : null;

  const framing = input.role
    ? `The reader's role is: ${input.role}. Use that to decide what matters to them and how to
phrase their items. It does not change what you extract — every task from every person is
still reported.`
    : `Nobody has said who the reader is, so treat every participant as equally important.`;

  const dating = date
    ? `The meeting took place on ${date}. Resolve relative deadlines against that date, and only
when they are unambiguous — "by Friday" from a Wednesday is Friday that week; "next quarter"
is not a date at all. Leave due_date empty rather than guessing.`
    : `The meeting's date is unknown, so leave every due_date empty and keep the phrase in
due_raw instead.`;

  const prompt = `${framing}

${dating}

Speakers in this recording:
${roster || "  (none identified)"}

Transcript, one line per segment, [segment_id] first:
${transcript}`;

  return {
    system: SYSTEM,
    prompt,
    segmentIds: new Set(input.segments.map((s) => s.id)),
    speakerIds: new Set(input.cast.map((c) => c.id)),
  };
}

/** A, B, … Z, AA — more speakers than letters is not a case worth a lookup table. */
function letter(i: number): string {
  let out = "";
  let n = i;
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}
