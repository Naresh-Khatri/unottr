// The Overview tab. Everything here is a read of what the main process already grounded —
// no citation is resolved in the renderer, so a bullet that renders is a bullet that lands.

import { useCallback, useEffect, useState } from "react";
import {
  ArrowClockwise, Check, CheckSquare, Copy, PencilSimple, Sparkle, Square, Trash, X,
} from "@phosphor-icons/react";
import { api, onOverviewChanged, onOverviewProgress } from "@/ipc/client";
import type {
  AiConnection, AiPreset, OverviewBullet, OverviewPayload, OverviewProgress, Person, Segment,
  Speaker, Task,
} from "@/ipc/types";
import { hms } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

interface Props {
  recordingId: number;
  segments: Segment[];
  speakers: Speaker[];
  ready: boolean; // transcript finished; nothing to summarize before that
  onSeek: (ms: number) => void;
  onOpenSettings: () => void;
}

export function OverviewPanel({ recordingId, segments, speakers, ready, onSeek, onOpenSettings }: Props) {
  const [payload, setPayload] = useState<OverviewPayload | null>(null);
  const [conn, setConn] = useState<AiConnection | null>(null);
  const [presets, setPresets] = useState<AiPreset[]>([]);
  const [connLoaded, setConnLoaded] = useState(false);
  const [people, setPeople] = useState<Person[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [consenting, setConsenting] = useState(false);
  const [copied, setCopied] = useState(false);

  const reload = useCallback(() => {
    api.overviewGet(recordingId).then(setPayload, (e) => setError(String(e)));
  }, [recordingId]);

  useEffect(() => {
    setPayload(null);
    setError(null);
    reload();
  }, [reload]);

  const reloadConnection = useCallback(async () => {
    const list = await api.aiConnections();
    setConn(list.find((c) => c.active) ?? null);
    setConnLoaded(true);
  }, []);

  useEffect(() => {
    reloadConnection().catch(() => setConnLoaded(true));
    api.aiPresets().then(setPresets, () => {});
    api.listPeople().then(setPeople, () => {});
  }, [reloadConnection]);

  useEffect(
    () => onOverviewChanged((p) => { if (p.recording_id === recordingId) reload(); }),
    [recordingId, reload],
  );

  // nothing stores which window is being read, so a reload mid-run shows no part until the
  // next one starts. Worth it: the alternative is a column that is meaningless the rest of
  // the time, and the clock alone already says the run is alive
  const [part, setPart] = useState<OverviewProgress | null>(null);
  useEffect(
    () => onOverviewProgress((p) => { if (p.recording_id === recordingId) setPart(p); }),
    [recordingId],
  );

  const overview = payload?.overview ?? null;
  const running = overview?.status === "running" || busy;
  useEffect(() => { if (!running) setPart(null); }, [running]);

  async function generate() {
    if (conn && !conn.consented) { setConsenting(true); return; }
    setError(null);
    setBusy(true);
    try {
      setPayload(await api.overviewGenerate(recordingId));
    } catch (e) {
      setError(String(e));
      reload();
    } finally {
      setBusy(false);
    }
  }

  /** Consent is per connection: saying yes to your own laptop is not saying yes to a cloud. */
  async function accept() {
    if (!conn) return;
    await api.aiConnectionSave({ id: conn.id, consented: true });
    await reloadConnection();
    setConsenting(false);
    void generate();
  }

  async function copyMarkdown() {
    if (!payload?.overview) return;
    await navigator.clipboard.writeText(toMarkdown(payload));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const mine = (payload?.tasks ?? []).filter((t) => t.is_mine);
  const theirs = (payload?.tasks ?? []).filter((t) => !t.is_mine);
  const anyoneIsMe = people.some((p) => p.is_me);

  if (!ready)
    return <Empty>The overview needs a finished transcript. It’ll be available once this one is done.</Empty>;

  if (connLoaded && !conn)
    return (
      <Empty>
        <p>No model is connected yet. Point unottr at a local server or a hosted API and this tab
          starts working.</p>
        <Button size="sm" variant="outline" onClick={onOpenSettings}>Connect a model</Button>
      </Empty>
    );

  if (conn && !conn.active_model)
    return (
      <Empty>
        <p>{conn.label} is connected, but no model is picked.</p>
        <Button size="sm" variant="outline" onClick={onOpenSettings}>Pick one in Settings</Button>
      </Empty>
    );

  if (conn && needsKey(conn, presets))
    return (
      <Empty>
        <p>{conn.label} needs an API key before it will answer.</p>
        <Button size="sm" variant="outline" onClick={onOpenSettings}>Add a key in Settings</Button>
      </Empty>
    );

  if (consenting)
    return (
      <Consent
        conn={conn}
        excerpt={excerpt(segments, speakers)}
        onAccept={accept}
        onCancel={() => setConsenting(false)}
      />
    );

  if (running)
    return (
      <Generating
        // running rows stamp updated_at when they start, so the clock survives leaving the tab
        startedAt={overview?.status === "running" ? overview.updated_at : null}
        lines={segments.length}
        part={part}
        onCancel={() => api.overviewCancel(recordingId)}
      />
    );

  if (!overview || overview.status !== "done")
    return (
      <Empty>
        {overview?.status === "failed" ? (
          <>
            <p className="font-medium text-destructive">{failureLabel(overview)}</p>
            {overview.error && <p className="text-xs">{overview.error}</p>}
            <div className="flex gap-2">
              <Button size="sm" onClick={generate}><ArrowClockwise />Retry</Button>
              {(overview.error_kind === "auth" ||
                overview.error_kind === "unreachable" ||
                overview.error_kind === "timeout" ||
                overview.error_kind === "too_long") && (
                <Button size="sm" variant="outline" onClick={onOpenSettings}>
                  {overview.error_kind === "auth" ? "Check the key" : "Check the connection"}
                </Button>
              )}
            </div>
          </>
        ) : (
          <>
            <p>
              No overview yet. Generating one sends this transcript to{" "}
              {conn ? `${conn.active_model} on ${conn.label}` : "the model"}.
            </p>
            <Button size="sm" onClick={generate}><Sparkle />Generate overview</Button>
          </>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </Empty>
    );

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex flex-col gap-5 p-4">
        {overview.stale && (
          <div className="flex items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
            <span className="flex-1">Speakers or your role changed since this was written.</span>
            <Button size="xs" variant="outline" onClick={generate}><ArrowClockwise />Regenerate</Button>
          </div>
        )}

        <header className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">{overview.title}</h2>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{overview.tldr}</p>
          </div>
          <Button size="xs" variant="ghost" onClick={copyMarkdown}>
            {copied ? <Check /> : <Copy />}{copied ? "Copied" : "Copy"}
          </Button>
        </header>

        {overview.sections.map((s, i) => (
          <section key={i} className="flex flex-col gap-2">
            <h3 className="flex items-baseline gap-2 text-sm font-medium">
              {s.heading}
              <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                {hms(s.start_ms)}–{hms(s.end_ms)}
              </span>
            </h3>
            {s.bullets.map((b) => <Bullet key={b.segment_id} bullet={b} onSeek={onSeek} />)}
          </section>
        ))}

        {overview.decisions.length > 0 && (
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Decisions</h3>
            {overview.decisions.map((d) => <Bullet key={d.segment_id} bullet={d} onSeek={onSeek} />)}
          </section>
        )}

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Your actions</h3>
          {!anyoneIsMe ? (
            <p className="text-xs text-muted-foreground">
              Nobody is marked as you yet. Name a speaker in the transcript, then pick yourself in
              {" "}
              <button className="underline" onClick={onOpenSettings}>Settings → People</button>.
            </p>
          ) : mine.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nothing landed on you in this meeting.</p>
          ) : (
            mine.map((t) => <TaskRow key={t.id} task={t} speakers={speakers} onSeek={onSeek} />)
          )}
        </section>

        {theirs.length > 0 && (
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Everyone else’s</h3>
            {theirs.map((t) => <TaskRow key={t.id} task={t} speakers={speakers} onSeek={onSeek} />)}
          </section>
        )}

        <footer className="flex items-center gap-2 pt-2 text-[11px] text-muted-foreground">
          <span>{overview.model}{overview.provider && ` via ${overview.provider}`}</span>
          {overview.role_used && <span>· as {overview.role_used}</span>}
          <Button size="xs" variant="ghost" className="ml-auto" onClick={generate}>
            <ArrowClockwise />Regenerate
          </Button>
        </footer>
      </div>
    </div>
  );
}

function Bullet({ bullet, onSeek }: { bullet: OverviewBullet; onSeek: (ms: number) => void }) {
  const [broken, setBroken] = useState(false);
  return (
    <button
      onClick={() => onSeek(bullet.start_ms)}
      className="flex w-full items-start gap-3 rounded-md px-2 py-1.5 text-left hover:bg-muted"
    >
      {bullet.frame_url && !broken && (
        <img
          src={bullet.frame_url}
          alt=""
          loading="lazy"
          onError={() => setBroken(true)}
          className="mt-0.5 aspect-video w-24 shrink-0 rounded bg-muted object-cover"
        />
      )}
      <span className="min-w-0 flex-1 text-sm leading-relaxed">{bullet.text}</span>
      <span className="mt-0.5 font-mono text-[11px] text-muted-foreground tabular-nums">
        {hms(bullet.start_ms)}
      </span>
    </button>
  );
}

function TaskRow({ task, speakers, onSeek }: {
  task: Task; speakers: Speaker[]; onSeek: (ms: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.text);
  useEffect(() => setDraft(task.text), [task.text]);

  const done = task.status === "done";
  const dismissed = task.status === "dismissed";

  async function save() {
    setEditing(false);
    if (draft.trim() && draft !== task.text) await api.taskUpdate(task.id, { text: draft.trim() });
    else setDraft(task.text);
  }

  return (
    <div className={cn("group flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted", dismissed && "opacity-50")}>
      <button
        className="mt-0.5 text-muted-foreground hover:text-foreground"
        onClick={() => api.taskSetStatus(task.id, done ? "open" : "done")}
      >
        {done ? <CheckSquare weight="fill" className="text-primary" /> : <Square />}
      </button>

      {editing ? (
        <Input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") { setDraft(task.text); setEditing(false); }
          }}
          className="h-7 flex-1 text-sm"
        />
      ) : (
        <div className="min-w-0 flex-1">
          <p className={cn("text-sm leading-relaxed", (done || dismissed) && "line-through")}>{task.text}</p>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            <select
              value={task.owner_speaker_id ?? 0}
              onChange={(e) => api.taskUpdate(task.id, { owner_speaker_id: Number(e.target.value) || null })}
              className="rounded border-none bg-transparent p-0 text-[11px] hover:underline"
            >
              <option value={0}>Unassigned</option>
              {speakers.map((s) => (
                <option key={s.id} value={s.id}>{s.display_name || s.label}</option>
              ))}
            </select>
            {task.due_date
              ? <Badge variant="secondary" className="px-1 py-0 text-[10px]">{task.due_date}</Badge>
              : task.due_raw && <span className="italic">“{task.due_raw}”</span>}
            <button className="font-mono tabular-nums hover:underline" onClick={() => onSeek(task.start_ms)}>
              {hms(task.start_ms)}
            </button>
            {task.user_edited && <span>· edited</span>}
          </div>
        </div>
      )}

      <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <Button size="icon-xs" variant="ghost" onClick={() => setEditing(true)}><PencilSimple /></Button>
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={() => api.taskSetStatus(task.id, dismissed ? "open" : "dismissed")}
        >
          {dismissed ? <ArrowClockwise /> : <Trash />}
        </Button>
      </div>
    </div>
  );
}

/**
 * The first generate shows what actually leaves the machine, in the format it leaves in.
 * A paragraph describing the payload is not the payload.
 */
function Consent({ conn, excerpt, onAccept, onCancel }: {
  conn: AiConnection | null; excerpt: string; onAccept: () => void; onCancel: () => void;
}) {
  const where = conn ? `${conn.active_model} on ${conn.label}` : "the model";
  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-4 text-sm">
      <h3 className="font-medium">
        {conn?.local ? `This sends the transcript to ${where}, on this machine` : `This sends the transcript to ${where}`}
      </h3>
      <p className="text-muted-foreground">
        {conn?.local
          ? "It goes to a server running on this computer — nothing leaves it. Text only, never the audio or the video. This is what goes, verbatim:"
          : "Text only — never the audio or the video. Nothing else in unottr talks to a network. This is what goes, verbatim:"}
      </p>
      <pre className="max-h-64 overflow-auto rounded-lg border bg-muted/50 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
        {excerpt}
      </pre>
      <div className="flex gap-2">
        <Button size="sm" onClick={onAccept}>Send it</Button>
        <Button size="sm" variant="ghost" onClick={onCancel}><X />Not now</Button>
      </div>
    </div>
  );
}

/**
 * The wait. There is no progress to report — the call returns whole or not at all — so the
 * spinner is indeterminate on purpose and the only real number shown is elapsed time.
 */
function Generating({ startedAt, lines, part, onCancel }: {
  startedAt: number | null; lines: number; part: OverviewProgress | null; onCancel: () => void;
}) {
  const [elapsed, setElapsed] = useState<number | null>(null);

  useEffect(() => {
    if (startedAt === null) return;
    const tick = () => setElapsed(Math.max(0, Math.floor(Date.now() / 1000 - startedAt)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [startedAt]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex flex-col items-center gap-3 px-8 pt-10 pb-6 text-center text-sm text-muted-foreground">
        <div className="relative grid size-12 place-items-center">
          <Spinner className="absolute size-12 text-primary/30" />
          <Sparkle weight="fill" className="size-5 animate-pulse text-primary" />
        </div>
        <div className="space-y-1">
          <p className="font-medium text-foreground">
            {part ? `Reading part ${part.part} of ${part.total}` : "Reading the transcript"}
          </p>
          <p className="text-xs">
            {part
              ? `${lines.toLocaleString()} lines · too long for this model in one go, so it goes through in parts`
              : `${lines.toLocaleString()} lines · arrives all at once`}
          </p>
        </div>
        <p className="font-mono text-xs tabular-nums" aria-live="off">
          {elapsed === null ? "starting…" : clock(elapsed)}
        </p>
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
      <GhostOverview />
    </div>
  );
}

const clock = (s: number): string => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`);

/** The shape the answer will take. Decorative — it never fills in, the real thing replaces it. */
function GhostOverview() {
  return (
    <div aria-hidden className="flex flex-col gap-5 p-4 opacity-40 [mask-image:linear-gradient(to_bottom,black,transparent)]">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-4/5" />
      </div>
      {[0, 1].map((i) => (
        <div key={i} className="flex flex-col gap-2">
          <Skeleton className="h-3.5 w-32" />
          {[0, 1, 2].map((j) => (
            <div key={j} className="flex gap-3">
              <Skeleton className="aspect-video w-24 shrink-0" />
              <div className="flex flex-1 flex-col gap-1.5 pt-0.5">
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

const EXCERPT_LINES = 8;

/** Mirrors prompt.ts's transcript serialization — if that changes, this has to. */
function excerpt(segments: Segment[], speakers: Speaker[]): string {
  const name = (sid: number | null) => {
    const s = speakers.find((x) => x.id === sid);
    return s?.display_name || s?.label || "Unknown";
  };
  const lines = segments.slice(0, EXCERPT_LINES).map((s) => `[${s.id}] ${name(s.speaker_id)}: ${s.text}`);
  if (segments.length > EXCERPT_LINES) lines.push(`… ${segments.length - EXCERPT_LINES} more lines`);
  return lines.join("\n");
}

function failureLabel(o: { error_kind: string | null }): string {
  switch (o.error_kind) {
    case "auth": return "The API key was rejected.";
    case "rate_limit": return "The provider is rate-limiting. Try again in a minute.";
    case "network": return "Couldn’t reach the provider.";
    case "unreachable": return "The endpoint never answered — the server may not be running.";
    case "validation": return "The model’s answer didn’t fit the expected shape.";
    case "too_long": return "This model’s context is too small for this meeting, even split up.";
    case "aborted": return "That run was interrupted.";
    case "timeout": return "The model ran out of time before it answered.";
    default: return "The overview failed.";
  }
}

function toMarkdown({ overview, tasks }: OverviewPayload): string {
  if (!overview) return "";
  const out = [`# ${overview.title}`, "", overview.tldr, ""];
  for (const s of overview.sections) {
    out.push(`## ${s.heading} (${hms(s.start_ms)}–${hms(s.end_ms)})`);
    for (const b of s.bullets) out.push(`- ${b.text} _(${hms(b.start_ms)})_`);
    out.push("");
  }
  if (overview.decisions.length) {
    out.push("## Decisions");
    for (const d of overview.decisions) out.push(`- ${d.text} _(${hms(d.start_ms)})_`);
    out.push("");
  }
  const live = tasks.filter((t) => t.status !== "dismissed");
  if (live.length) {
    out.push("## Actions");
    for (const t of live) {
      const who = t.owner_name ? `**${t.owner_name}** — ` : "";
      const due = t.due_date ? ` (due ${t.due_date})` : t.due_raw ? ` (${t.due_raw})` : "";
      out.push(`- [${t.status === "done" ? "x" : " "}] ${who}${t.text}${due}`);
    }
  }
  return out.join("\n");
}

/** Same rule as the main process: only a preset that says it needs one actually needs one. */
function needsKey(conn: AiConnection, presets: AiPreset[]): boolean {
  return !conn.key_set && presets.find((p) => p.id === conn.preset)?.key_required === true;
}
