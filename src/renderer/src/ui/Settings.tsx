import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle, Download, FolderOpen, FolderSimplePlus, HardDrives, Plus, StopCircle, Trash,
  Warning, X,
} from "@phosphor-icons/react";
import { api, onModelDownloadProgress, os } from "@/ipc/client";
import type {
  BackfillEstimate, DiskUsage, ModelInfo, Person, Resolved, Settings as SettingsT, SupportModels,
  WatchFolder,
} from "@/ipc/types";
import { SUPPORT_MODELS } from "@/ipc/types";
import { bytesLabel, durationLabel } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle,
} from "@/components/ui/card";
import { AiCard } from "./AiConnections";

// mirrors diarize::engine::DEFAULT_THRESHOLD — shown when settings.diarize_threshold is null
const DEFAULT_THRESHOLD = 0.6;

const TIERS: { tier: string; label: string }[] = [
  { tier: "turbo", label: "Turbo" },
  { tier: "medium", label: "Medium" },
  { tier: "small", label: "Small" },
];

const omit = <T,>(map: Record<string, T>, key: string): Record<string, T> =>
  Object.fromEntries(Object.entries(map).filter(([k]) => k !== key));

export function SettingsScreen({ onFfmpegChange }: { onFfmpegChange?: (ok: boolean) => void }) {
  const [settings, setSettings] = useState<SettingsT | null>(null);
  const [folders, setFolders] = useState<WatchFolder[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [disk, setDisk] = useState<DiskUsage | null>(null);
  const [detected, setDetected] = useState<Resolved | null>(null);
  const [progressByTier, setProgressByTier] = useState<Record<string, number>>({});
  const [errorByTier, setErrorByTier] = useState<Record<string, string>>({});
  const [autostartOn, setAutostartOn] = useState(false);
  const [people, setPeople] = useState<Person[]>([]);
  const [support, setSupport] = useState<SupportModels | null>(null);

  const loadFolders = useCallback(() => { api.listWatchFolders().then(setFolders); }, []);
  const loadModels = useCallback(() => { api.listModels().then(setModels); }, []);
  const loadDisk = useCallback(() => { api.diskUsage().then(setDisk); }, []);
  const loadPeople = useCallback(() => { api.listPeople().then(setPeople); }, []);
  const loadSupport = useCallback(() => { api.supportModels().then(setSupport); }, []);

  useEffect(() => {
    api.getSettings().then((s) => { setSettings(s); onFfmpegChange?.(s.ffmpeg_ok); });
    loadFolders();
    loadModels();
    loadDisk();
    loadPeople();
    loadSupport();
    api.detectedDevice().then(setDetected);
    os.getAutostart().then(setAutostartOn).catch(() => {});
  }, [loadFolders, loadModels, loadDisk, loadPeople, loadSupport]);

  useEffect(
    () =>
      onModelDownloadProgress((p) => {
        if (p.error) {
          // drop the progress entry or the row stays stuck offering Cancel
          setProgressByTier((prev) => omit(prev, p.model));
          const error = p.error;
          setErrorByTier((prev) => ({
            ...prev,
            [p.model]: error === "cancelled" ? "Download cancelled." : error,
          }));
          return;
        }
        setErrorByTier((prev) => omit(prev, p.model));
        setProgressByTier((prev) => ({ ...prev, [p.model]: p.pct }));
        if (p.pct >= 1) { loadModels(); loadDisk(); loadSupport(); }
      }),
    [loadModels, loadDisk, loadSupport],
  );

  async function setSetting(key: string, value: string) {
    const s = await api.setSetting(key, value);
    setSettings(s);
    onFfmpegChange?.(s.ffmpeg_ok);
  }

  if (!settings) return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;

  return (
    <div className="h-full overflow-y-auto px-4 py-6 sm:px-6 sm:py-8">
      <h1 className="mb-6 text-lg font-semibold tracking-tight">Settings</h1>
      <div className="mx-auto flex max-w-2xl flex-col gap-6 pb-8">
        {!settings.tray_available && (
          <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <Warning className="size-4 shrink-0" />
            No system tray in this session — closing the window quits the app instead of
            hiding it.
          </div>
        )}
        {!settings.ffmpeg_ok && (
          <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <Warning className="size-4 shrink-0" />
            ffmpeg/ffprobe not found — install it (<code>pacman -S ffmpeg</code>,{" "}
            <code>apt install ffmpeg</code>, or <code>dnf install ffmpeg</code>) or point at a
            binary below.
          </div>
        )}

        <GeneralCard
          settings={settings}
          autostartOn={autostartOn}
          onAutostartChange={async (on) => {
            await os.setAutostart(on);
            setAutostartOn(on);
            await setSetting("autostart", on ? "1" : "0");
          }}
          onCloseToTrayChange={(on) => setSetting("close_to_tray", on ? "1" : "0")}
        />

        <WatchFoldersCard folders={folders} onChange={loadFolders} />

        <PeopleCard people={people} onChange={loadPeople} />

        <AiCard />

        <ModelCard
          models={models}
          activeTier={settings.model_tier}
          disk={disk}
          progressByTier={progressByTier}
          errorByTier={errorByTier}
          support={support}
          onTierChange={(tier) => setSetting("model_tier", tier)}
          onDownload={(tier) => api.downloadModel(tier)}
          onCancel={(tier) => api.cancelModelDownload(tier)}
          onDownloadSupport={() => api.downloadSupportModels()}
        />

        <ComputeCard device={settings.device} detected={detected} onChange={(d) => setSetting("device", d)} />

        <TranscriptionCard language={settings.language} onChange={(v) => setSetting("language", v)} />

        <DiarizationCard
          threshold={settings.diarize_threshold}
          onChange={(v) => setSetting("diarize_threshold", v.toFixed(2))}
        />

        <AdvancedCard settings={settings} onChange={setSetting} onClearCache={() => api.clearCache()} />
      </div>
    </div>
  );
}

/**
 * The voices the app knows. Names typed on a transcript land here; forgetting one drops its
 * voiceprint, which is how a wrong auto-match gets undone.
 */
function PeopleCard({ people, onChange }: { people: Person[]; onChange: () => void }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>People</CardTitle>
        <CardDescription>
          Naming a speaker teaches the app that voice, and later recordings label them
          automatically.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {people.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nobody yet — name a speaker on a transcript to start.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {people.map((p) => <PersonRow key={p.id} person={p} onChange={onChange} />)}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PersonRow({ person, onChange }: { person: Person; onChange: () => void }) {
  const [draft, setDraft] = useState(person.name);
  const [role, setRole] = useState(person.role ?? "");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setDraft(person.name), [person.name]);
  useEffect(() => setRole(person.role ?? ""), [person.role]);

  async function commit() {
    const name = draft.trim();
    if (!name || name === person.name) { setDraft(person.name); return; }
    try { await api.renamePerson(person.id, name); setError(null); onChange(); }
    catch (e) { setError(String(e)); setDraft(person.name); }
  }

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") { setDraft(person.name); e.currentTarget.blur(); }
          }}
          className="h-8 w-full max-w-56"
        />
        <span className="flex-1 text-xs text-muted-foreground">
          {person.recordings === 1 ? "1 recording" : `${person.recordings} recordings`}
          {person.samples === 0 && " · no voiceprint yet"}
        </span>
        {error && <span className="text-xs text-destructive">{error}</span>}
        <Button
          size="xs"
          variant="ghost"
          title="Forget this voice — their speakers go back to unnamed"
          onClick={async () => { await api.forgetPerson(person.id); onChange(); }}
        >
          <Trash />Forget
        </Button>
      </div>

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <label className="flex items-center gap-1.5">
          <input
            type="radio" name="is-me" checked={person.is_me} className="size-3.5 accent-primary"
            onChange={async () => { await api.personSetMe(person.id); onChange(); }}
          />
          This is me
        </label>
        {person.is_me && (
          <>
            <span>·</span>
            <Input
              value={role}
              onChange={(e) => setRole(e.target.value)}
              onBlur={async () => {
                if (role.trim() !== (person.role ?? "")) {
                  await api.personSetRole(person.id, role.trim());
                  onChange();
                }
              }}
              onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
              placeholder="your role, e.g. engineering manager"
              className="h-6 w-full max-w-72 text-xs"
            />
          </>
        )}
      </div>
    </div>
  );
}

function GeneralCard({ settings, autostartOn, onAutostartChange, onCloseToTrayChange }: {
  settings: SettingsT;
  autostartOn: boolean;
  onAutostartChange: (on: boolean) => void;
  onCloseToTrayChange: (on: boolean) => void;
}) {
  return (
    <Card>
      <CardHeader><CardTitle>General</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <Label htmlFor="autostart">Start unottr on login</Label>
          <Switch id="autostart" checked={autostartOn} onCheckedChange={onAutostartChange} />
        </div>
        <div className="flex items-center justify-between">
          <Label htmlFor="close-to-tray">Keep running in tray when closed</Label>
          <Switch
            id="close-to-tray"
            checked={settings.close_to_tray}
            disabled={!settings.tray_available}
            onCheckedChange={onCloseToTrayChange}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function WatchFoldersCard({ folders, onChange }: { folders: WatchFolder[]; onChange: () => void }) {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);

  async function add() {
    const p = path.trim();
    if (!p) return;
    setBusy(true);
    try { await api.addWatchFolder(p); setPath(""); onChange(); }
    finally { setBusy(false); }
  }

  async function browse() {
    const picked = await os.pickFolder();
    if (picked) setPath(picked);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Watch folders</CardTitle>
        <CardDescription>Recordings dropped into these folders get transcribed automatically.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") add(); }}
            placeholder="/path/to/folder"
            className="h-8"
          />
          <Button size="xs" variant="outline" onClick={browse}><FolderOpen />Browse</Button>
          <Button size="xs" onClick={add} disabled={busy || !path.trim()}><Plus />Add</Button>
        </div>
        {folders.length === 0 ? (
          <p className="text-sm text-muted-foreground">No watch folders yet.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {folders.map((f) => <FolderRow key={f.id} folder={f} onChange={onChange} />)}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

type RuleMode = "auto" | "stream" | "mic_desktop";
type ParsedRule = { mode: RuleMode; stream: number; mic: number; desktop: number };

const TRACK_RULES: Record<RuleMode, string> = {
  auto: "Auto",
  stream: "Single stream",
  mic_desktop: "Mic + desktop",
};

const DEVICES: Record<string, string> = { auto: "Auto", gpu: "GPU", cpu: "CPU" };

// wire encoding is media::TrackRule's #[serde(tag = "kind")] json, or the literal "auto"
function parseTrackRule(raw: string): ParsedRule {
  if (raw !== "auto") {
    try {
      const parsed = JSON.parse(raw) as { kind: string; stream?: number; mic?: number; desktop?: number };
      if (parsed.kind === "stream") return { mode: "stream", stream: parsed.stream ?? 0, mic: 0, desktop: 1 };
      if (parsed.kind === "mic_desktop") {
        return { mode: "mic_desktop", stream: 0, mic: parsed.mic ?? 0, desktop: parsed.desktop ?? 1 };
      }
    } catch { /* garbage rule string -> fall through to auto, same as core's rule() */ }
  }
  return { mode: "auto", stream: 0, mic: 0, desktop: 1 };
}

function encodeTrackRule(r: ParsedRule): string {
  if (r.mode === "auto") return "auto";
  if (r.mode === "stream") return JSON.stringify({ kind: "stream", stream: r.stream });
  return JSON.stringify({ kind: "mic_desktop", mic: r.mic, desktop: r.desktop });
}

function FolderRow({ folder, onChange }: { folder: WatchFolder; onChange: () => void }) {
  const parsed = parseTrackRule(folder.track_rule);
  const [rule, setRule] = useState(parsed);
  const [estimate, setEstimate] = useState<BackfillEstimate | null>(null);
  const [estimating, setEstimating] = useState(false);

  useEffect(() => setRule(parseTrackRule(folder.track_rule)), [folder.track_rule]);

  const dirty = rule.mode !== parsed.mode || rule.stream !== parsed.stream
    || rule.mic !== parsed.mic || rule.desktop !== parsed.desktop;

  async function apply() {
    await api.setWatchFolderTrackRule(folder.id, encodeTrackRule(rule));
    onChange();
  }

  async function startEstimate() {
    setEstimating(true);
    try { setEstimate(await api.backfillEstimate(folder.id)); }
    finally { setEstimating(false); }
  }

  async function confirmBackfill() {
    await api.startBackfill(folder.id);
    setEstimate(null);
  }

  return (
    <div className="rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <Switch
          checked={folder.enabled}
          onCheckedChange={(v) => api.setWatchFolderEnabled(folder.id, v).then(onChange)}
        />
        <span className="min-w-0 flex-1 truncate text-sm">{folder.path}</span>
        <Button size="xs" variant="outline" onClick={startEstimate} disabled={estimating}>
          <FolderSimplePlus />Backfill
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={async () => { await api.removeWatchFolder(folder.id); onChange(); }}
        >
          <X />
        </Button>
      </div>

      {estimate && (
        <div className="mt-2 flex items-center justify-between gap-3 rounded-md bg-muted px-3 py-2 text-sm">
          <span>
            {estimate.count} file{estimate.count === 1 ? "" : "s"} · {durationLabel(estimate.total_duration_ms)}
            {" "}· est. {durationLabel(estimate.estimated_processing_ms)} to process
          </span>
          <div className="flex shrink-0 gap-2">
            <Button size="xs" variant="ghost" onClick={() => setEstimate(null)}>Cancel</Button>
            <Button size="xs" onClick={confirmBackfill}>Confirm</Button>
          </div>
        </div>
      )}

      <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
        <span>Tracks</span>
        <Select value={rule.mode} onValueChange={(v) => setRule({ ...rule, mode: v as RuleMode })}>
          <SelectTrigger size="sm" className="h-6 gap-1 rounded-md pr-1.5 pl-2 text-xs" aria-label="Tracks">
            <SelectValue>{(v) => TRACK_RULES[v as RuleMode]}</SelectValue>
          </SelectTrigger>
          <SelectContent align="start" alignItemWithTrigger={false} className="w-auto min-w-(--anchor-width)">
            {(Object.keys(TRACK_RULES) as RuleMode[]).map((m) => (
              <SelectItem key={m} value={m} className="text-xs">{TRACK_RULES[m]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {rule.mode === "stream" && (
          <Input
            type="number" min={0} value={rule.stream}
            onChange={(e) => setRule({ ...rule, stream: Number(e.target.value) })}
            className="h-6 w-14 text-xs"
          />
        )}
        {rule.mode === "mic_desktop" && (
          <>
            <span>mic</span>
            <Input
              type="number" min={0} value={rule.mic}
              onChange={(e) => setRule({ ...rule, mic: Number(e.target.value) })}
              className="h-6 w-14 text-xs"
            />
            <span>desktop</span>
            <Input
              type="number" min={0} value={rule.desktop}
              onChange={(e) => setRule({ ...rule, desktop: Number(e.target.value) })}
              className="h-6 w-14 text-xs"
            />
          </>
        )}
        {dirty && <Button size="xs" onClick={apply}>Apply</Button>}
      </div>
    </div>
  );
}

function ModelCard({
  models, activeTier, disk, progressByTier, errorByTier, support, onTierChange, onDownload,
  onCancel, onDownloadSupport,
}: {
  models: ModelInfo[];
  activeTier: string;
  disk: DiskUsage | null;
  progressByTier: Record<string, number>;
  errorByTier: Record<string, string>;
  support: SupportModels | null;
  onTierChange: (tier: string) => void;
  onDownload: (tier: string) => void;
  onCancel: (tier: string) => void;
  onDownloadSupport: () => void;
}) {
  const supportPct = progressByTier[SUPPORT_MODELS];
  const supportBusy = supportPct != null && supportPct < 1;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Model</CardTitle>
        <CardDescription>Bigger tiers are more accurate but slower and use more VRAM/disk.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {TIERS.map(({ tier, label }) => {
          const info = models.find((m) => m.tier === tier);
          const pct = progressByTier[tier];
          const downloading = pct != null && pct < 1;
          return (
            <div key={tier} className="flex items-center gap-3 rounded-lg border p-3">
              <input
                type="radio" name="model-tier" checked={activeTier === tier}
                onChange={() => onTierChange(tier)} className="size-4 accent-primary"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-medium">
                  {label}
                  {info?.downloaded && <Badge variant="outline"><CheckCircle />downloaded</Badge>}
                </div>
                {info && <div className="text-xs text-muted-foreground">{bytesLabel(info.size)}</div>}
                {downloading && <Progress value={pct * 100} className="mt-1.5" />}
                {!downloading && errorByTier[tier] && (
                  <div className="mt-1 text-xs text-destructive">{errorByTier[tier]}</div>
                )}
              </div>
              {downloading ? (
                <Button size="xs" variant="outline" onClick={() => onCancel(tier)}><StopCircle />Cancel</Button>
              ) : (
                <Button
                  size="xs" variant="outline" disabled={info?.downloaded}
                  onClick={() => onDownload(tier)}
                >
                  <Download />{info?.downloaded ? "Downloaded" : "Download"}
                </Button>
              )}
            </div>
          );
        })}

        <div className="flex items-center gap-3 rounded-lg border border-dashed p-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-sm font-medium">
              Speaker models
              {support?.ready && <Badge variant="outline"><CheckCircle />downloaded</Badge>}
            </div>
            <div className="text-xs text-muted-foreground">
              Voice activity, segmentation and embedding — every recording needs all three.
            </div>
            {supportBusy && <Progress value={supportPct * 100} className="mt-1.5" />}
            {!supportBusy && errorByTier[SUPPORT_MODELS] && (
              <div className="mt-1 text-xs text-destructive">{errorByTier[SUPPORT_MODELS]}</div>
            )}
          </div>
          <Button
            size="xs" variant="outline" disabled={supportBusy || support?.ready}
            onClick={onDownloadSupport}
          >
            <Download />
            {support?.ready ? "Downloaded" : `Download${support ? ` (${bytesLabel(support.missing_bytes)})` : ""}`}
          </Button>
        </div>
      </CardContent>
      <CardFooter className="justify-start text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <HardDrives />Models {bytesLabel(disk?.models_bytes ?? 0)} · Cache {bytesLabel(disk?.cache_bytes ?? 0)}
        </span>
      </CardFooter>
    </Card>
  );
}

function ComputeCard({ device, detected, onChange }: {
  device: string; detected: Resolved | null; onChange: (v: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Compute</CardTitle>
        <CardDescription>Runs on GPU when one has enough free VRAM; override if auto-detect picks wrong.</CardDescription>
      </CardHeader>
      <CardContent className="flex items-center gap-3">
        <Label htmlFor="device-select">Device</Label>
        <Select value={device} onValueChange={(v) => onChange(v ?? "auto")}>
          <SelectTrigger id="device-select">
            <SelectValue>{(v) => DEVICES[v as string]}</SelectValue>
          </SelectTrigger>
          <SelectContent align="start" alignItemWithTrigger={false} className="w-auto min-w-(--anchor-width)">
            {Object.entries(DEVICES).map(([v, label]) => (
              <SelectItem key={v} value={v}>{label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {device === "auto" && detected && (
          <span className="text-xs text-muted-foreground">currently resolves to {detected.toUpperCase()}</span>
        )}
      </CardContent>
    </Card>
  );
}

function TranscriptionCard({ language, onChange }: { language: string | null; onChange: (v: string) => void }) {
  const [draft, setDraft] = useState(language ?? "");
  useEffect(() => setDraft(language ?? ""), [language]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Transcription language</CardTitle>
        <CardDescription>
          Leave blank to auto-detect per recording, or set a whisper language code (e.g. "en").
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => onChange(draft.trim() || "auto")}
          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
          placeholder="auto"
          className="h-8 w-40"
        />
      </CardContent>
    </Card>
  );
}

function DiarizationCard({ threshold, onChange }: { threshold: number | null; onChange: (v: number) => void }) {
  const value = threshold ?? DEFAULT_THRESHOLD;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Diarization threshold</CardTitle>
        <CardDescription>Similarity cutoff for merging speaker clusters. Lower splits out more speakers.</CardDescription>
      </CardHeader>
      <CardContent className="flex items-center gap-3">
        <Slider
          className="max-w-xs"
          min={0}
          max={1}
          step={0.01}
          value={[value]}
          onValueChange={(v) => onChange(Array.isArray(v) ? v[0] : v)}
        />
        <span className="w-10 text-right text-sm text-muted-foreground tabular-nums">{value.toFixed(2)}</span>
      </CardContent>
    </Card>
  );
}

function PathRow({ label, value, placeholder, onPick, onClear }: {
  label: string; value: string | null; placeholder: string; onPick: () => void; onClear: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Label className="w-32 shrink-0">{label}</Label>
      <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{value || placeholder}</span>
      <Button size="xs" variant="outline" onClick={onPick}>Browse</Button>
      {value && <Button size="icon-xs" variant="ghost" onClick={onClear}><X /></Button>}
    </div>
  );
}

function AdvancedCard({ settings, onChange, onClearCache }: {
  settings: SettingsT;
  onChange: (key: string, value: string) => void;
  onClearCache: () => Promise<void>;
}) {
  const [clearing, setClearing] = useState(false);

  async function pickFile(setter: (p: string) => void) {
    const picked = await os.pickFile();
    if (picked) setter(picked);
  }
  async function pickDir(setter: (p: string) => void) {
    const picked = await os.pickFolder();
    if (picked) setter(picked);
  }
  async function openLogFolder() {
    await os.openPath(await api.getLogDir());
  }
  async function clearCache() {
    setClearing(true);
    try { await onClearCache(); } finally { setClearing(false); }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Advanced</CardTitle>
        <CardDescription>ffmpeg/ffprobe path and cache location need an app restart to apply.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <PathRow
          label="ffmpeg path" value={settings.ffmpeg_path} placeholder="auto-detected"
          onPick={() => pickFile((p) => onChange("ffmpeg_path", p))}
          onClear={() => onChange("ffmpeg_path", "")}
        />
        <PathRow
          label="ffprobe path" value={settings.ffprobe_path} placeholder="auto-detected"
          onPick={() => pickFile((p) => onChange("ffprobe_path", p))}
          onClear={() => onChange("ffprobe_path", "")}
        />
        <PathRow
          label="cache location" value={settings.cache_dir} placeholder="default"
          onPick={() => pickDir((p) => onChange("cache_dir", p))}
          onClear={() => onChange("cache_dir", "")}
        />
      </CardContent>
      <CardFooter className="justify-between">
        <Button size="xs" variant="outline" onClick={clearCache} disabled={clearing}>
          <Trash />Clear cache
        </Button>
        <Button size="xs" variant="outline" onClick={openLogFolder}>
          <FolderOpen />Open log folder
        </Button>
      </CardFooter>
    </Card>
  );
}
