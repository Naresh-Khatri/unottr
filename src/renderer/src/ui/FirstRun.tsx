import { useEffect, useState } from "react";
import {
  ArrowLeft, ArrowRight, CheckCircle, FilmSlate, FolderOpen, Info,
} from "@phosphor-icons/react";
import { api, onModelDownloadProgress, os } from "@/ipc/client";
import type { AiAgentDiscovery, AiConnection, BackfillEstimate, ModelInfo, SupportModels, WatchFolder } from "@/ipc/types";
import { SUPPORT_MODELS } from "@/ipc/types";
import { bytesLabel, durationLabel } from "@/lib/format";
import { modelPhaseLabel } from "@/lib/activity";
import { useActivities } from "@/lib/ActivityProvider";
import { Button } from "@/components/ui/button";
import { ActivityBar, ActivityLine, ActivityMark } from "@/components/activity-indicator";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { InstalledAgentSetup } from "./AiConnections";

const TIERS: { tier: ModelInfo["tier"]; label: string }[] = [
  { tier: "small", label: "Small" },
  { tier: "medium", label: "Medium" },
  { tier: "turbo", label: "Turbo" },
];

// gates the app behind this once — flips first_run_complete via onDone -> App.tsx
export function FirstRun({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [folder, setFolder] = useState<WatchFolder | null>(null);
  const [tier, setTier] = useState<ModelInfo["tier"]>("small");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [downloading, setDownloading] = useState(false);
  const [pct, setPct] = useState(0);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [support, setSupport] = useState<SupportModels | null>(null);
  const [supportPct, setSupportPct] = useState(0);
  const [supportBusy, setSupportBusy] = useState(false);
  const [supportError, setSupportError] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<BackfillEstimate | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [backfillStarted, setBackfillStarted] = useState(false);
  const [confirmingBackfill, setConfirmingBackfill] = useState(false);
  const [backfillError, setBackfillError] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [agents, setAgents] = useState<AiAgentDiscovery[] | null>(null);
  const [connections, setConnections] = useState<AiConnection[]>([]);
  const { modelDownloads, backfills } = useActivities();

  useEffect(() => {
    api.listModels().then((available) => {
      setModels(available);
      setTier(available.find((m) => m.recommended)?.tier ?? "small");
    });
    api.supportModels().then(setSupport);
    api.aiDetectAgents().then(setAgents, () => setAgents([]));
    api.aiConnections().then(setConnections, () => {});
  }, []);

  const showAgents = agents === null || agents.some((a) => a.installed);
  const steps = ["Welcome", "Folder", "Model", ...(showAgents ? ["AI"] : []), "Backfill", "Tip"];
  const current = steps[step] ?? "Tip";

  useEffect(
    () =>
      onModelDownloadProgress((p) => {
        if (p.model === SUPPORT_MODELS) {
          if (p.error) {
            setSupportBusy(false);
            setSupportError(p.error === "cancelled" ? "Download cancelled." : p.error);
            return;
          }
          setSupportPct(p.pct);
          if (p.pct >= 1) {
            setSupportBusy(false);
            api.supportModels().then(setSupport);
            api.listModels().then(setModels);
          }
          return;
        }
        if (p.model !== tier) return;
        if (p.error) {
          setDownloading(false);
          setDownloadError(p.error === "cancelled" ? "Download cancelled." : p.error);
          return;
        }
        setPct(p.pct);
        if (p.pct >= 1) {
          setDownloading(false);
          api.listModels().then(setModels);
        }
      }),
    [tier],
  );

  useEffect(() => {
    if (current !== "Backfill" || !folder || estimate || estimating) return;
    setEstimating(true);
    api.backfillEstimate(folder.id).then(setEstimate).finally(() => setEstimating(false));
    // only fires once per folder, guarded by estimate/estimating above
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, folder]);

  const tierInfo = models.find((m) => m.tier === tier);
  // `downloaded` can lag one refetch behind the terminal event, so pct still counts
  const modelReady = tierInfo?.downloaded === true || pct >= 1;
  const supportReady = support?.ready === true || supportPct >= 1;
  const selectedCoveredBySupport = tierInfo?.recovery === true;
  const selectedMissingBytes = modelReady || selectedCoveredBySupport ? 0 : (tierInfo?.size ?? 0);
  const setupMissingBytes = selectedMissingBytes + (support?.missing_bytes ?? 0);
  const setupBusy = downloading || supportBusy;
  const setupReady = modelReady && supportReady;
  const modelDownload = modelDownloads[tier];
  const supportDownload = modelDownloads[SUPPORT_MODELS];
  const backfill = folder ? backfills[folder.id] : undefined;

  async function pickFolder() {
    const picked = await os.pickFolder();
    if (!picked) return;
    setFolder(await api.addWatchFolder(picked));
  }

  function selectTier(t: ModelInfo["tier"]) {
    setTier(t);
    setPct(0);
    setDownloadError(null);
  }

  async function startModelSetup() {
    const fetchSelected = !modelReady && !selectedCoveredBySupport;
    const fetchSupport = !supportReady;
    setDownloading(fetchSelected);
    setSupportBusy(fetchSupport);
    if (fetchSelected) setPct(0);
    if (fetchSupport) setSupportPct(0);
    setDownloadError(null);
    setSupportError(null);
    try {
      // Both calls resolve once queued. Progress events own the busy state after that.
      await Promise.all([
        fetchSelected ? api.downloadModel(tier) : Promise.resolve(),
        fetchSupport ? api.downloadSupportModels() : Promise.resolve(),
      ]);
    } catch (e) {
      setDownloading(false);
      setSupportBusy(false);
      const message = e instanceof Error ? e.message : String(e);
      setDownloadError(message);
      setSupportError(message);
    }
  }

  async function confirmBackfill() {
    if (!folder) return;
    setConfirmingBackfill(true);
    setBackfillError(null);
    try {
      await api.startBackfill(folder.id);
      setBackfillStarted(true);
    } catch (reason) {
      setBackfillError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setConfirmingBackfill(false);
    }
  }

  async function finish() {
    setFinishing(true);
    try {
      await api.setSetting("model_tier", tier);
      await api.setSetting("first_run_complete", "1");
      onDone();
    } finally {
      setFinishing(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-background p-8">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="mb-1 flex gap-1">
            {steps.map((s, i) => (
              <div key={s} className={`h-1 flex-1 rounded-full ${i <= step ? "bg-primary" : "bg-muted"}`} />
            ))}
          </div>
          <CardTitle>{current}</CardTitle>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          {current === "Welcome" && (
            <div className="flex flex-col items-center gap-3 py-4 text-center">
              <FilmSlate className="size-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                unottr watches folders for recordings, transcribes and diarizes them locally,
                and keeps everything searchable on this machine. AI overview is optional and
                always shows what will be sent before the first request.
              </p>
            </div>
          )}

          {current === "Folder" && (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                Pick a folder to watch for new recordings.
              </p>
              <Button variant="outline" onClick={pickFolder}>
                <FolderOpen />{folder ? "Change folder" : "Choose folder"}
              </Button>
              {folder && <p className="truncate text-sm font-medium">{folder.path}</p>}
            </div>
          )}

          {current === "Model" && (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                Choose the transcription model to keep on this machine.
              </p>
              <div className="flex gap-2">
                {TIERS.map(({ tier: t, label }) => (
                  <Button
                    key={t}
                    size="sm"
                    variant={tier === t ? "secondary" : "outline"}
                    disabled={setupBusy}
                    onClick={() => selectTier(t)}
                  >
                    {label}{models.find((m) => m.tier === t)?.recommended ? " (Recommended)" : ""}
                  </Button>
                ))}
              </div>
              {tierInfo && (
                <p className="text-xs text-muted-foreground">
                  {bytesLabel(tierInfo.size)}
                  {tierInfo.recovery ? " · also used as the offline recovery model" : ""}
                </p>
              )}

              {setupReady ? (
                <p className="flex items-center gap-1.5 text-sm text-primary">
                  <CheckCircle />Models ready
                </p>
              ) : (
                <>
                  {downloading && (
                    <div className="flex flex-col gap-1">
                      <span className="text-xs text-muted-foreground">
                        {tierInfo?.name} · {modelPhaseLabel(modelDownload?.phase ?? "connecting")}
                      </span>
                      <ActivityBar
                        value={modelDownload?.pct ?? pct}
                        indeterminate={modelDownload?.phase !== "downloading"}
                      />
                    </div>
                  )}
                  {supportBusy && (
                    <div className="flex flex-col gap-1">
                      <span className="text-xs text-muted-foreground">
                        Support models · {modelPhaseLabel(supportDownload?.phase ?? "connecting")}
                      </span>
                      <ActivityBar
                        value={supportDownload?.pct ?? supportPct}
                        indeterminate={supportDownload?.phase !== "downloading"}
                      />
                    </div>
                  )}
                  {!setupBusy && (
                    <Button disabled={!tierInfo || !support} onClick={startModelSetup}>
                      {downloadError || supportError ? "Retry download" : "Download models"}
                      {setupMissingBytes > 0 ? ` (${bytesLabel(setupMissingBytes)})` : ""}
                    </Button>
                  )}
                </>
              )}
              {downloadError && !setupBusy && !setupReady && (
                <p className="text-sm text-destructive">{downloadError}</p>
              )}

              <div className="flex flex-col gap-2 border-t pt-3">
                <p className="text-xs text-muted-foreground">
                  {models.some((m) => m.recovery)
                    ? "Support files include speaker models and Small for offline recovery."
                    : "Speaker models tell voices apart. Every recording needs them."}
                </p>
                {supportReady ? (
                  <p className="flex items-center gap-1.5 text-sm text-primary">
                    <CheckCircle />Support models ready
                  </p>
                ) : !setupBusy && support ? (
                  <p className="text-xs text-muted-foreground">
                    {bytesLabel(support.missing_bytes)} included in the setup download
                  </p>
                ) : null}
                {supportError && !supportBusy && (
                  <p className="text-sm text-destructive">{supportError}</p>
                )}
              </div>
            </div>
          )}

          {current === "AI" && (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                Use an agent CLI you already signed into. This is optional and can be changed in Settings.
              </p>
              {agents === null ? (
                <p className="text-sm text-muted-foreground">Looking for installed agents…</p>
              ) : (
                <InstalledAgentSetup
                  agents={agents}
                  conns={connections}
                  onChanged={async () => setConnections(await api.aiConnections())}
                />
              )}
            </div>
          )}

          {current === "Backfill" && (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                Found existing recordings in this folder. Transcribe them now?
              </p>
              {estimating && <p className="text-sm text-muted-foreground">Scanning…</p>}
              {estimate && !backfillStarted && (
                <div className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
                  <span>
                    {estimate.count} file{estimate.count === 1 ? "" : "s"}
                    {" "}· {durationLabel(estimate.total_duration_ms)} total
                    {" "}· est. {durationLabel(estimate.estimated_processing_ms)} to process
                  </span>
                  {estimate.count > 0 && (
                    <Button disabled={confirmingBackfill} onClick={confirmBackfill}>
                      {confirmingBackfill && <ActivityMark />}
                      {confirmingBackfill ? "Adding recordings" : "Confirm and queue"}
                    </Button>
                  )}
                </div>
              )}
              {confirmingBackfill && (
                <ActivityLine
                  label={backfill?.phase === "queueing" ? "Adding recordings to the queue" : "Checking existing files"}
                  detail={backfill && backfill.total > 0 ? `${backfill.done} of ${backfill.total}` : "Starting scan"}
                  value={backfill && backfill.total > 0 ? backfill.done / backfill.total : 0}
                  indeterminate={!backfill || backfill.total === 0}
                />
              )}
              {(backfillError || backfill?.error) && (
                <p className="text-sm text-destructive" role="alert">
                  {backfillError ?? backfill?.error}
                </p>
              )}
              {backfillStarted && (
                <p className="flex items-center gap-1.5 text-sm text-primary">
                  <CheckCircle />Queued for processing
                </p>
              )}
            </div>
          )}

          {current === "Tip" && (
            <div className="flex flex-col gap-3 rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
              <p className="flex items-start gap-2">
                <Info className="mt-0.5 size-4 shrink-0" />
                <span>
                  Prefer recording to <b>.mkv</b> over .mp4 if your recorder supports it — a
                  crashed OBS leaves an .mp4 unrecoverable, while an .mkv survives. Just a
                  tip, unottr works with either.
                </span>
              </p>
            </div>
          )}
        </CardContent>

        <CardFooter className="justify-between">
          <Button variant="ghost" size="sm" disabled={step === 0} onClick={() => setStep((s) => s - 1)}>
            <ArrowLeft />Back
          </Button>
          {step < steps.length - 1 ? (
            <Button
              size="sm"
              disabled={(current === "Folder" && !folder)
                || (current === "Model" && !setupReady)
                || (current === "Backfill" && confirmingBackfill)}
              onClick={() => setStep((s) => s + 1)}
            >
              Next<ArrowRight />
            </Button>
          ) : (
            <Button size="sm" onClick={finish} disabled={finishing}>Finish</Button>
          )}
        </CardFooter>
      </Card>
    </div>
  );
}
