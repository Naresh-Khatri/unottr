import { useEffect, useState } from "react";
import {
  ArrowLeft, ArrowRight, CheckCircle, FilmSlate, FolderOpen, Info,
} from "@phosphor-icons/react";
import { api, onModelDownloadProgress, os } from "@/ipc/client";
import type { BackfillEstimate, ModelInfo, SupportModels, WatchFolder } from "@/ipc/types";
import { SUPPORT_MODELS } from "@/ipc/types";
import { bytesLabel, durationLabel } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";

const TIERS: { tier: string; label: string }[] = [
  { tier: "small", label: "Small" },
  { tier: "medium", label: "Medium" },
  { tier: "turbo", label: "Turbo" },
];

const STEPS = ["Welcome", "Folder", "Model", "Backfill", "Tip"];

// gates the app behind this once — flips first_run_complete via onDone -> App.tsx
export function FirstRun({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [folder, setFolder] = useState<WatchFolder | null>(null);
  const [tier, setTier] = useState("small");
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
  const [finishing, setFinishing] = useState(false);

  useEffect(() => {
    api.listModels().then(setModels);
    api.supportModels().then(setSupport);
  }, []);

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
    if (step !== 3 || !folder || estimate || estimating) return;
    setEstimating(true);
    api.backfillEstimate(folder.id).then(setEstimate).finally(() => setEstimating(false));
    // only fires once per folder, guarded by estimate/estimating above
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, folder]);

  // small and mandatory, so it starts itself rather than asking — the button below is the
  // retry path, not the happy one
  useEffect(() => {
    if (step !== 2 || supportBusy || supportError || !support || support.ready) return;
    startSupport();
    // startSupport is stable enough; the guards above are what decide this
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, support, supportBusy, supportError]);

  const tierInfo = models.find((m) => m.tier === tier);
  // `downloaded` can lag one refetch behind the terminal event, so pct still counts
  const modelReady = tierInfo?.downloaded === true || pct >= 1;
  const supportReady = support?.ready === true || supportPct >= 1;

  async function pickFolder() {
    const picked = await os.pickFolder();
    if (!picked) return;
    setFolder(await api.addWatchFolder(picked));
  }

  function selectTier(t: string) {
    setTier(t);
    setPct(0);
    setDownloadError(null);
  }

  async function startDownload() {
    setDownloading(true);
    setPct(0);
    setDownloadError(null);
    try {
      // resolves as soon as the download is queued; the terminal signal is the event
      await api.downloadModel(tier);
    } catch (e) {
      setDownloading(false);
      setDownloadError(e instanceof Error ? e.message : String(e));
    }
  }

  async function startSupport() {
    setSupportBusy(true);
    setSupportPct(0);
    setSupportError(null);
    try {
      await api.downloadSupportModels();
    } catch (e) {
      setSupportBusy(false);
      setSupportError(e instanceof Error ? e.message : String(e));
    }
  }

  async function confirmBackfill() {
    if (!folder) return;
    await api.startBackfill(folder.id);
    setBackfillStarted(true);
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
            {STEPS.map((s, i) => (
              <div key={s} className={`h-1 flex-1 rounded-full ${i <= step ? "bg-primary" : "bg-muted"}`} />
            ))}
          </div>
          <CardTitle>{STEPS[step]}</CardTitle>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          {step === 0 && (
            <div className="flex flex-col items-center gap-3 py-4 text-center">
              <FilmSlate className="size-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                unottr watches folders for recordings, transcribes and diarizes them locally,
                and keeps everything searchable — no cloud, nothing leaves this machine.
              </p>
            </div>
          )}

          {step === 1 && (
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

          {step === 2 && (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">Download a transcription model.</p>
              <div className="flex gap-2">
                {TIERS.map(({ tier: t, label }) => (
                  <Button
                    key={t}
                    size="sm"
                    variant={tier === t ? "secondary" : "outline"}
                    disabled={downloading}
                    onClick={() => selectTier(t)}
                  >
                    {label}
                  </Button>
                ))}
              </div>
              {modelReady ? (
                <p className="flex items-center gap-1.5 text-sm text-primary">
                  <CheckCircle />Model ready
                </p>
              ) : downloading ? (
                <Progress value={pct * 100} />
              ) : (
                <Button onClick={startDownload}>
                  {downloadError ? "Retry download" : "Download"}
                </Button>
              )}
              {downloadError && !downloading && !modelReady && (
                <p className="text-sm text-destructive">{downloadError}</p>
              )}

              <div className="flex flex-col gap-2 border-t pt-3">
                <p className="text-xs text-muted-foreground">
                  Speaker models — telling voices apart. Needed for every recording.
                </p>
                {supportReady ? (
                  <p className="flex items-center gap-1.5 text-sm text-primary">
                    <CheckCircle />Speaker models ready
                  </p>
                ) : supportBusy ? (
                  <Progress value={supportPct * 100} />
                ) : (
                  <Button size="sm" variant="outline" onClick={startSupport}>
                    {supportError ? "Retry" : "Download"} speaker models
                    {support ? ` (${bytesLabel(support.missing_bytes)})` : ""}
                  </Button>
                )}
                {supportError && !supportBusy && (
                  <p className="text-sm text-destructive">{supportError}</p>
                )}
              </div>
            </div>
          )}

          {step === 3 && (
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
                  {estimate.count > 0 && <Button onClick={confirmBackfill}>Confirm and queue</Button>}
                </div>
              )}
              {backfillStarted && (
                <p className="flex items-center gap-1.5 text-sm text-primary">
                  <CheckCircle />Queued for processing
                </p>
              )}
            </div>
          )}

          {step === 4 && (
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
          {step < STEPS.length - 1 ? (
            <Button
              size="sm"
              disabled={(step === 1 && !folder) || (step === 2 && !(modelReady && supportReady))}
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
