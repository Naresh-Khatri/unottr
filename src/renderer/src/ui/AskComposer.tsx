import { useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  CalendarBlank,
  CaretDown,
  Check,
  FilmSlate,
  Gear,
  MagnifyingGlass,
  PaperPlaneTilt,
  Plus,
  Stop,
  Users,
  WarningCircle,
  Waveform,
} from "@phosphor-icons/react";
import { PREVIEW_COUNT, previewUrl, thumbUrl } from "@/ipc/client";
import type { AiConnection, AskScope, Person, RecordingSummary } from "@/ipc/types";
import { dateLabel, durationLabel, hms, timeLabel } from "@/lib/format";
import { datesLabel, fromDateInput, peopleLabel, recordingLabel, recordingsLabel, toDateInput } from "@/lib/askScope";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { ProviderIcon } from "./icons/providers";

// Reserve room for each picker's fixed header/footer when Base UI reports the popup's
// available height. ScrollArea inherits these caps on its viewport.
const PICKER = "flex max-h-[min(24rem,var(--available-height,24rem))] flex-col overflow-hidden bg-popover";
const PICKER_SM = "flex max-h-[min(20rem,var(--available-height,20rem))] flex-col overflow-hidden bg-popover";
const RECORDING_SCROLL = "min-h-0 flex-1 max-h-[min(19.25rem,max(4rem,calc(var(--available-height,24rem)-4.75rem)))] border-t";
const PEOPLE_SCROLL = "min-h-0 flex-1 max-h-[min(18rem,max(4rem,calc(var(--available-height,20rem)-2rem)))]";
const PROVIDER_SCROLL = "min-h-0 flex-1 max-h-[min(17.25rem,max(4rem,calc(var(--available-height,20rem)-2.75rem)))]";

/**
 * Everything the question needs lives on the composer: scope chips on the left, provider next
 * to them, send on the right. `locked` = the thread already ran, so its corpus is frozen (a
 * change would let one thread's context leak into another corpus) — each chip then offers a
 * new question carrying the same filters instead of editing in place.
 */
export function AskComposer({
  scope,
  onScopeChange,
  locked,
  recordings,
  people,
  connections,
  onActivateConnection,
  onOpenSettings,
  onNewThread,
  draft,
  onDraftChange,
  onSend,
  onStop,
  busy,
  textareaRef,
}: {
  scope: AskScope;
  onScopeChange: (scope: AskScope) => void;
  locked: boolean;
  recordings: RecordingSummary[];
  people: Person[];
  connections: AiConnection[];
  onActivateConnection: (id: number) => void;
  onOpenSettings: () => void;
  onNewThread: () => void;
  draft: string;
  onDraftChange: (draft: string) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const active = connections.find((connection) => connection.active) ?? null;

  return (
    <Card className="gap-0 py-2">
      <CardContent className="px-2">
        <Textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSend();
            }
          }}
          placeholder="Ask about a decision, person, or topic"
          disabled={busy}
          className="max-h-40 min-h-16 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
        />

        <div className="flex flex-wrap items-center gap-1.5 px-1 pt-2">
          <ScopeChip
            icon={<FilmSlate />}
            label={recordingsLabel(scope, recordings)}
            on={!!scope.recording_ids.length}
            locked={locked}
            onNewThread={onNewThread}
            className="w-80 p-0"
          >
            <RecordingPicker scope={scope} recordings={recordings} onChange={onScopeChange} />
          </ScopeChip>

          {!!people.length && (
            <ScopeChip
              icon={<Users />}
              label={peopleLabel(scope, people)}
              on={!!scope.person_ids.length}
              locked={locked}
              onNewThread={onNewThread}
              className="w-64 p-0"
            >
              <PeoplePicker scope={scope} people={people} onChange={onScopeChange} />
            </ScopeChip>
          )}

          <ScopeChip
            icon={<CalendarBlank />}
            label={datesLabel(scope)}
            on={!!(scope.date_from || scope.date_to)}
            locked={locked}
            onNewThread={onNewThread}
          >
            <DatePicker scope={scope} onChange={onScopeChange} />
          </ScopeChip>

          <ScopeChip
            icon={active ? <ProviderIcon preset={active.preset} className="size-3.5" /> : <WarningCircle className="text-amber-600" />}
            label={active?.label ?? "Choose a provider"}
            on={false}
            locked={false}
            onNewThread={onNewThread}
            className="w-64 p-0"
          >
            <ProviderPicker
              connections={connections}
              onActivate={onActivateConnection}
              onOpenSettings={onOpenSettings}
            />
          </ScopeChip>

          <div className="ml-auto">
            {busy ? (
              <Button variant="outline" size="sm" onClick={onStop}>
                <Stop weight="fill" /> Stop
              </Button>
            ) : (
              <Button size="sm" disabled={!draft.trim()} onClick={onSend}>
                Ask <PaperPlaneTilt weight="fill" />
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ScopeChip({ icon, label, on, locked, onNewThread, className, children }: {
  icon: ReactNode;
  label: string;
  on: boolean;
  locked: boolean;
  onNewThread: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger render={<Button variant={on ? "secondary" : "outline"} size="sm" className="max-w-52" />}>
        {icon}
        <span className="truncate">{label}</span>
        <CaretDown className="size-3 opacity-60" />
      </PopoverTrigger>
      <PopoverContent className={cn(!locked && className)}>
        {locked ? <LockedNote onNewThread={onNewThread} /> : children}
      </PopoverContent>
    </Popover>
  );
}

function LockedNote({ onNewThread }: { onNewThread: () => void }) {
  return (
    <div className="space-y-2.5 p-3">
      <p className="text-xs leading-5 text-muted-foreground">
        This conversation keeps the scope it started with, so its answers stay tied to one corpus.
      </p>
      <PopoverClose render={<Button size="sm" className="w-full" />} onClick={onNewThread}>
        <Plus /> New question, same filters
      </PopoverClose>
    </div>
  );
}

function RecordingPicker({ scope, recordings, onChange }: {
  scope: AskScope;
  recordings: RecordingSummary[];
  onChange: (scope: AskScope) => void;
}) {
  const [query, setQuery] = useState("");
  const selected = new Set(scope.recording_ids);
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return recordings;
    return recordings.filter((recording) => recordingLabel(recording).toLowerCase().includes(needle));
  }, [recordings, query]);

  const toggle = (id: number, checked: boolean) => {
    const next = new Set(scope.recording_ids);
    if (checked) next.add(id);
    else next.delete(id);
    onChange({ ...scope, recording_ids: [...next] });
  };

  return (
    <div className={PICKER}>
      <div className="relative z-10 shrink-0 bg-popover p-2">
        <div className="relative">
          <MagnifyingGlass className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter recordings"
            className="h-7 pl-7 text-sm"
          />
        </div>
      </div>
      <ScrollArea className={RECORDING_SCROLL}>
        <div className="p-1">
          <PickerRow
            checked={!scope.recording_ids.length}
            onClick={() => onChange({ ...scope, recording_ids: [] })}
          >
            Entire library
          </PickerRow>
          {shown.map((recording) => {
            const id = `ask-recording-${recording.id}`;
            return (
              <HoverCard key={recording.id}>
                <HoverCardTrigger
                  render={<label htmlFor={id} />}
                  className="flex select-none items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Checkbox
                      id={id}
                      checked={selected.has(recording.id)}
                      onCheckedChange={(checked) => toggle(recording.id, checked === true)}
                    />
                    <span className="truncate">{recordingLabel(recording)}</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {dateLabel(recording.recorded_at ?? recording.created_at)}
                  </span>
                </HoverCardTrigger>
                <HoverCardContent className="p-0">
                  <RecordingPreview recording={recording} />
                </HoverCardContent>
              </HoverCard>
            );
          })}
          {!shown.length && <p className="px-2 py-3 text-xs text-muted-foreground">No recordings match.</p>}
        </div>
      </ScrollArea>
      <p className="relative z-10 shrink-0 border-t bg-popover px-3 py-1.5 text-[11px] text-muted-foreground">
        {scope.recording_ids.length
          ? `${scope.recording_ids.length} selected`
          : `Searching all ${recordings.length} completed recordings`}
      </p>
    </div>
  );
}

/** thumbnails land during probing, so an audio-only or not-yet-thumbed row falls back to the icon */
function RecordingPreview({ recording }: { recording: RecordingSummary }) {
  const [broken, setBroken] = useState(false);
  const [frame, setFrame] = useState<number | null>(null);
  const warmed = useRef(false);
  const at = recording.recorded_at ?? recording.created_at;
  const frameAt = frame === null || recording.duration_ms === null
    ? null
    : (recording.duration_ms * (frame + 1)) / (PREVIEW_COUNT + 1);

  return (
    <div>
      <div
        className={cn(
          "relative flex aspect-video w-full items-center justify-center border-b bg-muted",
          recording.has_video && !broken && "cursor-ew-resize",
        )}
        onPointerEnter={() => {
          if (warmed.current || !recording.has_video || broken) return;
          warmed.current = true;
          for (let i = 0; i < PREVIEW_COUNT; i++) new Image().src = previewUrl(recording.id, i);
        }}
        onPointerMove={(event) => {
          if (!recording.has_video || broken) return;
          const box = event.currentTarget.getBoundingClientRect();
          if (box.width === 0) return;
          const i = Math.floor(((event.clientX - box.left) / box.width) * PREVIEW_COUNT);
          setFrame(Math.min(PREVIEW_COUNT - 1, Math.max(0, i)));
        }}
        onPointerLeave={() => setFrame(null)}
      >
        {recording.has_video && !broken ? (
          <img
            src={frame === null ? thumbUrl(recording.id) : previewUrl(recording.id, frame)}
            alt=""
            draggable={false}
            className="size-full object-cover"
            onError={() => {
              if (frame === null) setBroken(true);
              else setFrame(null);
            }}
          />
        ) : (
          <Waveform className="size-7 text-muted-foreground" />
        )}
        {frameAt !== null && frame !== null ? (
          <>
            <span className="pointer-events-none absolute right-1 bottom-2 rounded bg-black/70 px-1 text-[10px] font-medium tabular-nums text-white">
              {hms(frameAt)}
            </span>
            <div className="pointer-events-none absolute inset-x-1 bottom-1 flex gap-px">
              {Array.from({ length: PREVIEW_COUNT }, (_, i) => (
                <span
                  key={i}
                  className={cn("h-0.5 flex-1 rounded-full", i <= frame ? "bg-white" : "bg-white/35")}
                />
              ))}
            </div>
          </>
        ) : recording.duration_ms !== null ? (
          <span className="absolute right-1 bottom-1 rounded bg-black/70 px-1 text-[10px] font-medium tabular-nums text-white">
            {durationLabel(recording.duration_ms)}
          </span>
        ) : null}
      </div>
      <div className="space-y-1 p-2.5">
        <p className="line-clamp-2 text-sm leading-snug font-medium">{recordingLabel(recording)}</p>
        <p className="text-xs text-muted-foreground">
          {dateLabel(at)} {timeLabel(at) && `· ${timeLabel(at)}`}
        </p>
        {recording.speaker_count > 0 && (
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <Users className="size-3" /> {recording.speaker_count} speaker{recording.speaker_count === 1 ? "" : "s"}
          </p>
        )}
      </div>
    </div>
  );
}

function PeoplePicker({ scope, people, onChange }: {
  scope: AskScope;
  people: Person[];
  onChange: (scope: AskScope) => void;
}) {
  const selected = new Set(scope.person_ids);
  const toggle = (id: number, checked: boolean) => {
    const next = new Set(scope.person_ids);
    if (checked) next.add(id);
    else next.delete(id);
    onChange({ ...scope, person_ids: [...next] });
  };

  return (
    <div className={PICKER_SM}>
      <ScrollArea className={PEOPLE_SCROLL}>
        <div className="p-1">
          <PickerRow checked={!scope.person_ids.length} onClick={() => onChange({ ...scope, person_ids: [] })}>
            Anyone
          </PickerRow>
          {people.map((person) => {
            const id = `ask-person-${person.id}`;
            return (
              <Label key={person.id} htmlFor={id} className="gap-2 rounded-md px-2 py-1.5 font-normal hover:bg-muted">
                <Checkbox
                  id={id}
                  checked={selected.has(person.id)}
                  onCheckedChange={(checked) => toggle(person.id, checked === true)}
                />
                <span className="truncate">{person.name}</span>
              </Label>
            );
          })}
        </div>
      </ScrollArea>
      <p className="relative z-10 shrink-0 border-t bg-popover px-3 py-1.5 text-[11px] text-muted-foreground">
        Recordings where the chosen people spoke.
      </p>
    </div>
  );
}

function DatePicker({ scope, onChange }: { scope: AskScope; onChange: (scope: AskScope) => void }) {
  return (
    <div className="space-y-3 p-3">
      <Label className="block text-xs font-normal text-muted-foreground">
        From
        <Input
          type="date"
          value={toDateInput(scope.date_from)}
          onChange={(event) => onChange({ ...scope, date_from: fromDateInput(event.target.value, false) })}
          className="mt-1"
        />
      </Label>
      <Label className="block text-xs font-normal text-muted-foreground">
        Through
        <Input
          type="date"
          value={toDateInput(scope.date_to)}
          onChange={(event) => onChange({ ...scope, date_to: fromDateInput(event.target.value, true) })}
          className="mt-1"
        />
      </Label>
      <Button
        variant="ghost"
        size="xs"
        disabled={!scope.date_from && !scope.date_to}
        onClick={() => onChange({ ...scope, date_from: null, date_to: null })}
      >
        Clear dates
      </Button>
    </div>
  );
}

function ProviderPicker({ connections, onActivate, onOpenSettings }: {
  connections: AiConnection[];
  onActivate: (id: number) => void;
  onOpenSettings: () => void;
}) {
  return (
    <div className={PICKER_SM}>
      <ScrollArea className={PROVIDER_SCROLL}>
        <div className="p-1">
          {connections.map((connection) => (
            <PopoverClose
              key={connection.id}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
              onClick={() => onActivate(connection.id)}
            >
              <ProviderIcon preset={connection.preset} className="size-4" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{connection.label}</span>
                <span className={cn(
                  "block truncate text-[11px]",
                  connection.active_model || connection.kind === "cli" ? "text-muted-foreground" : "text-amber-600",
                )}>
                  {connection.active_model ?? (connection.kind === "cli" ? "CLI default" : "no model picked")}
                </span>
              </span>
              {connection.active && <Check className="size-3.5 shrink-0" />}
            </PopoverClose>
          ))}
          {!connections.length && (
            <p className="px-2 py-3 text-xs text-muted-foreground">No AI provider is set up yet.</p>
          )}
        </div>
      </ScrollArea>
      <div className="relative z-10 shrink-0 border-t bg-popover p-1">
        <PopoverClose
          render={<Button variant="ghost" size="sm" className="w-full justify-start" />}
          onClick={onOpenSettings}
        >
          <Gear /> Manage providers
        </PopoverClose>
      </div>
    </div>
  );
}

function PickerRow({ checked, onClick, children }: {
  checked: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        {checked && <Check className="size-3.5" />}
      </span>
      <span className="truncate">{children}</span>
    </button>
  );
}
