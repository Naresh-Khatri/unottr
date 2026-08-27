import type { AskScope, Person, RecordingSummary } from "@/ipc/types";
import { dateLabel } from "./format";

export const blankScope = (): AskScope => ({
  recording_ids: [],
  person_ids: [],
  date_from: null,
  date_to: null,
});

export function recordingLabel(recording: RecordingSummary): string {
  return recording.title ?? recording.filename;
}

export function recordingsLabel(scope: AskScope, recordings: RecordingSummary[]): string {
  if (!scope.recording_ids.length) return "Library";
  if (scope.recording_ids.length > 1) return `${scope.recording_ids.length} recordings`;
  const recording = recordings.find((row) => row.id === scope.recording_ids[0]);
  return recording ? recordingLabel(recording) : "1 recording";
}

export function peopleLabel(scope: AskScope, people: Person[]): string {
  if (!scope.person_ids.length) return "Anyone";
  if (scope.person_ids.length > 1) return `${scope.person_ids.length} people`;
  return people.find((person) => person.id === scope.person_ids[0])?.name ?? "1 person";
}

export function datesLabel(scope: AskScope): string {
  const { date_from: from, date_to: to } = scope;
  if (!from && !to) return "Any date";
  if (from && to) return `${dateLabel(from)} – ${dateLabel(to)}`;
  return from ? `From ${dateLabel(from)}` : `Through ${dateLabel(to)}`;
}

/** One line for the header, the empty state and the "Searching …" progress note. */
export function describeScope(scope: AskScope, recordings: RecordingSummary[], people: Person[]): string {
  const parts = [recordingsLabel(scope, recordings)];
  if (scope.person_ids.length) parts.push(peopleLabel(scope, people));
  if (scope.date_from || scope.date_to) parts.push("date filtered");
  return parts.join(" · ");
}

export function toDateInput(unix: number | null): string {
  return unix ? new Date(unix * 1_000).toISOString().slice(0, 10) : "";
}

export function fromDateInput(value: string, through: boolean): number | null {
  if (!value) return null;
  const date = new Date(`${value}T${through ? "23:59:59" : "00:00:00"}`);
  return Math.floor(date.getTime() / 1_000);
}
