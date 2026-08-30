import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle, Download, FolderOpen, FolderSimplePlus, HardDrives, Plus, SpeakerHigh, StopCircle, Trash,
  Warning, X,
} from "@phosphor-icons/react";
import { api, os } from "@/ipc/client";
import type {
  BackfillEstimate, DiskUsage, ModelDownloadProgress, ModelInfo, Person, Resolved, Settings as SettingsT, SupportModels,
  TtsVoiceId, TtsVoiceStatus,
  WatchFolder,
} from "@/ipc/types";
import { SUPPORT_MODELS, ttsVoiceDownloadId } from "@/ipc/types";
import { bytesLabel, durationLabel } from "@/lib/format";
import { modelPhaseLabel } from "@/lib/activity";
import { askSpeech, type AskSpeechState } from "@/lib/askSpeech";
import { useActivities } from "@/lib/ActivityProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { ActivityBar, ActivityLine, ActivityMark } from "@/components/activity-indicator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { LoadingState } from "@/components/ui/loading-state";
import {
  Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle,
} from "@/components/ui/card";
import { AiCard } from "./AiConnections";
import { TerminologyCard } from "./Terminology";

// mirrors diarize::engine::DEFAULT_THRESHOLD — shown when settings.diarize_threshold is null
const DEFAULT_THRESHOLD = 0.6;

const TIERS: { tier: string; label: string }[] = [
  { tier: "turbo", label: "Turbo" },
  { tier: "medium", label: "Medium" },
  { tier: "small", label: "Small" },
];

const SPEECH_TEST_ID = -1;
const SPEECH_TEST_TEXT = "Hello. This is how Ask answers will sound.";

export function SettingsScreen({ onFfmpegChange }: { onFfmpegChange?: (ok: boolean) => void }) {
  const [settings, setSettings] = useState<SettingsT | null>(null);
  const [folders, setFolders] = useState<WatchFolder[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [disk, setDisk] = useState<DiskUsage | null>(null);
  const [detected, setDetected] = useState<Resolved | null>(null);
  const { modelDownloads, runAction } = useActivities();
  const [autostartOn, setAutostartOn] = useState(false);
  const [people, setPeople] = useState<Person[]>([]);
  const [support, setSupport] = useState<SupportModels | null>(null);
  const [voices, setVoices] = useState<TtsVoiceStatus[]>([]);

  const loadFolders = useCallback(() => { api.listWatchFolders().then(setFolders); }, []);
  const loadModels = useCallback(() => { api.listModels().then(setModels); }, []);
  const loadDisk = useCallback(() => { api.diskUsage().then(setDisk); }, []);
  const loadPeople = useCallback(() => { api.listPeople().then(setPeople); }, []);
  const loadSupport = useCallback(() => { api.supportModels().then(setSupport); }, []);
  const loadVoices = useCallback(() => { api.ttsVoiceCatalog().then(setVoices); }, []);

  useEffect(() => {
    api.getSettings().then((s) => { setSettings(s); onFfmpegChange?.(s.ffmpeg_ok); });
    loadFolders();
    loadModels();
    loadDisk();
    loadPeople();
    loadSupport();
    loadVoices();
    api.detectedDevice().then(setDetected);
    os.getAutostart().then(setAutostartOn).catch(() => {});
  }, [loadFolders, loadModels, loadDisk, loadPeople, loadSupport, loadVoices]);

  useEffect(() => {
    if (!Object.values(modelDownloads).some((item) => item.phase === "done" && !item.error)) return;
    loadModels();
    loadDisk();
    loadSupport();
    loadVoices();
  }, [modelDownloads, loadModels, loadDisk, loadSupport, loadVoices]);

  async function setSetting(key: string, value: string) {
    const s = await api.setSetting(key, value);
    setSettings(s);
    onFfmpegChange?.(s.ffmpeg_ok);
  }

  if (!settings) {
    return (
      <LoadingState
        label="Loading settings"
        description="Reading folders, models, and device preferences."
        className="h-full"
      />
    );
  }

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

        <SpeechCard
          enabled={settings.ask_speak_answers}
          voices={voices}
          selectedVoiceId={settings.tts_voice_id}
          download={modelDownloads[ttsVoiceDownloadId(settings.tts_voice_id)]}
          onVoiceChange={async (voiceId) => {
            askSpeech.stop();
            await setSetting("tts_voice_id", voiceId);
          }}
          onEnabledChange={(enabled) => {
            if (!enabled) askSpeech.stop();
            return setSetting("ask_speak_answers", enabled ? "1" : "0");
          }}
          onDownload={(voiceId) => api.downloadTtsVoice(voiceId)}
          onCancel={(voiceId) => api.cancelTtsVoiceDownload(voiceId)}
          onRemove={async (voiceId) => {
            askSpeech.stop();
            await api.removeTtsVoice(voiceId);
            setSettings(await api.getSettings());
            loadVoices();
            loadDisk();
          }}
        />

        <ModelCard
          models={models}
          activeTier={settings.model_tier}
          disk={disk}
          downloads={modelDownloads}
          support={support}
          onTierChange={(tier) => setSetting("model_tier", tier)}
          onDownload={(tier) => api.downloadModel(tier)}
          onCancel={(tier) => api.cancelModelDownload(tier)}
          onDownloadSupport={() => api.downloadSupportModels()}
        />

        <ComputeCard device={settings.device} detected={detected} onChange={(d) => setSetting("device", d)} />

        <TranscriptionCard language={settings.language} onChange={(v) => setSetting("language", v)} />

        <TerminologyCard />

        <DiarizationCard
          threshold={settings.diarize_threshold}
          onChange={(v) => setSetting("diarize_threshold", v.toFixed(2))}
        />

        <AdvancedCard
          settings={settings}
          onChange={setSetting}
          onClearCache={() => runAction(
            {
              id: "clear-cache",
              label: "Clearing audio cache",
              detail: "Removing temporary decoded audio.",
            },
            async () => {
              await api.clearCache();
              loadDisk();
            },
          )}
        />
      </div>
    </div>
  );
}

function SpeechCard({
  enabled, voices, selectedVoiceId, download, onVoiceChange, onEnabledChange, onDownload, onCancel, onRemove,
}: {
  enabled: boolean;
  voices: TtsVoiceStatus[];
  selectedVoiceId: TtsVoiceId;
  download: ModelDownloadProgress | undefined;
  onVoiceChange: (voiceId: TtsVoiceId) => void;
  onEnabledChange: (enabled: boolean) => void;
  onDownload: (voiceId: TtsVoiceId) => void;
  onCancel: (voiceId: TtsVoiceId) => void;
  onRemove: (voiceId: TtsVoiceId) => Promise<void>;
}) {
  const [removing, setRemoving] = useState(false);
  const [speech, setSpeech] = useState<AskSpeechState>(() => askSpeech.snapshot());
  const voice = voices.find((item) => item.voice_id === selectedVoiceId) ?? null;
  const installed = voice?.state === "installed";
  const downloading = download != null && download.phase !== "done" && !download.error;
  const testing = speech.activeMessageId === SPEECH_TEST_ID;
  const testError = speech.status === "error" && speech.lastMessageId === SPEECH_TEST_ID
    ? speech.error
    : null;

  useEffect(() => {
    const unsubscribe = askSpeech.subscribe(setSpeech);
    return () => {
      unsubscribe();
      if (askSpeech.snapshot().activeMessageId === SPEECH_TEST_ID) askSpeech.stop();
    };
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Speech</CardTitle>
        <CardDescription>Read completed Ask answers aloud on this device.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Select value={selectedVoiceId} onValueChange={(value) => onVoiceChange(value as TtsVoiceId)}>
          <SelectTrigger aria-label="Speech voice"><SelectValue /></SelectTrigger>
          <SelectContent>
            {voices.map((item) => (
              <SelectItem key={item.voice_id} value={item.voice_id}>
                <span>{item.display_name}</span>
                {item.state === "installed" && (
                  <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
                    <CheckCircle />Downloaded
                  </span>
                )}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium">
              {voice?.display_name ?? "English voice"}
              {installed && <Badge variant="outline"><CheckCircle />downloaded</Badge>}
            </div>
            <p className="text-xs text-muted-foreground">
              {voice?.language ?? "English (US)"}
              {voice ? ` · ${bytesLabel(installed ? voice.installed_bytes : voice.download_bytes)}` : ""}
              {" · CPU"}
            </p>
          </div>
          {downloading ? (
            <Button size="xs" variant="outline" onClick={() => onCancel(selectedVoiceId)}><StopCircle />Cancel</Button>
          ) : installed ? (
            <div className="flex items-center gap-2">
              <Button
                size="xs"
                variant="outline"
                disabled={removing}
                onClick={() => testing
                  ? askSpeech.stop()
                  : void askSpeech.speak(SPEECH_TEST_ID, SPEECH_TEST_TEXT)}
              >
                {testing ? <StopCircle /> : <SpeakerHigh />}
                {testing ? "Stop" : "Test voice"}
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={removing}
                onClick={async () => {
                  setRemoving(true);
                  try { await onRemove(selectedVoiceId); } finally { setRemoving(false); }
                }}
              >
                <Trash />{removing ? "Removing" : "Remove"}
              </Button>
            </div>
          ) : (
            <Button size="xs" variant="outline" onClick={() => onDownload(selectedVoiceId)} disabled={!voice}>
              <Download />Download
            </Button>
          )}
        </div>
        {downloading && download && (
          <div>
            <div className="mb-1 text-[11px] text-muted-foreground">{modelPhaseLabel(download.phase)}</div>
            <ActivityBar value={download.pct} indeterminate={download.phase !== "downloading"} />
          </div>
        )}
        {!downloading && download?.error && (
          <p className="text-xs text-destructive">
            {download.error === "cancelled" ? "Download cancelled." : download.error}
          </p>
        )}
        {testError && <p className="text-xs text-destructive">Voice test failed: {testError}</p>}
        <div className="flex items-center justify-between border-t pt-3">
          <Label htmlFor="ask-speak-answers">Read Ask answers aloud</Label>
          <Switch
            id="ask-speak-answers"
            checked={installed && enabled}
            disabled={!installed}
            onCheckedChange={onEnabledChange}
          />
        </div>
      </CardContent>
    </Card>
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
  const [confirming, setConfirming] = useState(false);
  const [backfillError, setBackfillError] = useState<string | null>(null);
  const { backfills } = useActivities();
  const backfill = backfills[folder.id];
  const backfillBusy = confirming || (backfill != null && backfill.phase !== "done" && !backfill.error);

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
    setConfirming(true);
    setBackfillError(null);
    try {
      await api.startBackfill(folder.id);
      setEstimate(null);
    } catch (reason) {
      setBackfillError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setConfirming(false);
    }
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
          {estimating ? <><ActivityMark />Scanning folder</> : <><FolderSimplePlus />Backfill</>}
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
            <Button size="xs" variant="ghost" disabled={backfillBusy} onClick={() => setEstimate(null)}>Cancel</Button>
            <Button size="xs" disabled={backfillBusy} onClick={confirmBackfill}>
              {backfillBusy && <ActivityMark />}
              {backfillBusy ? "Adding recordings" : "Confirm"}
            </Button>
          </div>
        </div>
      )}
      {backfillBusy && (
        <ActivityLine
          className="mt-2 rounded-md bg-muted/50 px-3 py-2"
          label={backfill?.phase === "queueing" ? "Adding recordings to the queue" : "Checking existing files"}
          detail={backfill && backfill.total > 0 ? `${backfill.done} of ${backfill.total}` : "Starting scan"}
          value={backfill && backfill.total > 0 ? backfill.done / backfill.total : 0}
          indeterminate={!backfill || backfill.total === 0}
        />
      )}
      {(backfillError || backfill?.error) && (
        <p className="mt-2 text-xs text-destructive" role="alert">
          {backfillError ?? backfill?.error}
        </p>
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
  models, activeTier, disk, downloads, support, onTierChange, onDownload,
  onCancel, onDownloadSupport,
}: {
  models: ModelInfo[];
  activeTier: string;
  disk: DiskUsage | null;
  downloads: Record<string, ModelDownloadProgress>;
  support: SupportModels | null;
  onTierChange: (tier: string) => void;
  onDownload: (tier: string) => void;
  onCancel: (tier: string) => void;
  onDownloadSupport: () => void;
}) {
  const supportDownload = downloads[SUPPORT_MODELS];
  const supportBusy = supportDownload != null
    && supportDownload.phase !== "done"
    && !supportDownload.error;
  const recovery = models.find((m) => m.recovery);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Model</CardTitle>
        <CardDescription>Bigger tiers are more accurate but slower and use more VRAM/disk.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {TIERS.map(({ tier, label }) => {
          const info = models.find((m) => m.tier === tier);
          const download = downloads[tier];
          const downloading = download != null && download.phase !== "done" && !download.error;
          return (
            <div key={tier} className="flex items-center gap-3 rounded-lg border p-3">
              <input
                type="radio" name="model-tier" checked={activeTier === tier}
                onChange={() => onTierChange(tier)} className="size-4 accent-primary"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-medium">
                  {label}
                  {info?.recommended && <Badge variant="secondary">recommended</Badge>}
                  {info?.recovery && <Badge variant="outline">offline recovery</Badge>}
                  {info?.downloaded && <Badge variant="outline"><CheckCircle />downloaded</Badge>}
                </div>
                {info && <div className="text-xs text-muted-foreground">{bytesLabel(info.size)}</div>}
                {downloading && (
                  <div className="mt-1.5">
                    <div className="mb-1 text-[11px] text-muted-foreground">
                      {modelPhaseLabel(download.phase)}
                    </div>
                    <ActivityBar
                      value={download.pct}
                      indeterminate={download.phase !== "downloading"}
                    />
                  </div>
                )}
                {!downloading && download?.error && (
                  <div className="mt-1 text-xs text-destructive">
                    {download.error === "cancelled" ? "Download cancelled." : download.error}
                  </div>
                )}
              </div>
              {downloading ? (
                <Button size="xs" variant="outline" onClick={() => onCancel(tier)}><StopCircle />Cancel</Button>
              ) : (
                <Button
                  size="xs" variant="outline" disabled={info?.downloaded || info?.recovery}
                  onClick={() => onDownload(tier)}
                >
                  <Download />
                  {info?.downloaded ? "Downloaded" : info?.recovery ? "Included below" : "Download"}
                </Button>
              )}
            </div>
          );
        })}

        <div className="flex items-center gap-3 rounded-lg border border-dashed p-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-sm font-medium">
              Support models
              {support?.ready && <Badge variant="outline"><CheckCircle />downloaded</Badge>}
            </div>
            <div className="text-xs text-muted-foreground">
              {recovery
                ? `Voice activity and speaker models, plus ${recovery.name} for offline recovery.`
                : "Voice activity, segmentation and embedding. Every recording needs all three."}
            </div>
            {supportBusy && supportDownload && (
              <div className="mt-1.5">
                <div className="mb-1 text-[11px] text-muted-foreground">
                  {modelPhaseLabel(supportDownload.phase)}
                </div>
                <ActivityBar
                  value={supportDownload.pct}
                  indeterminate={supportDownload.phase !== "downloading"}
                />
              </div>
            )}
            {!supportBusy && supportDownload?.error && (
              <div className="mt-1 text-xs text-destructive">
                {supportDownload.error === "cancelled" ? "Download cancelled." : supportDownload.error}
              </div>
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
          {clearing ? <><ActivityMark />Clearing cache</> : <><Trash />Clear cache</>}
        </Button>
        <Button size="xs" variant="outline" onClick={openLogFolder}>
          <FolderOpen />Open log folder
        </Button>
      </CardFooter>
    </Card>
  );
}
