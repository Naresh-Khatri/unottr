import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  api,
  onBackfillProgress,
  onJobDone,
  onJobFailed,
  onJobProgress,
  onIncomingFileProgress,
  onModelDownloadProgress,
} from "@/ipc/client";
import type {
  BackfillProgress,
  IncomingFileProgress,
  JobProgress,
  ModelDownloadProgress,
} from "@/ipc/types";

export interface LiveJobProgress extends JobProgress {
  receivedAt: number;
}

export interface AppActivity {
  id: string;
  label: string;
  detail?: string;
  state: "running" | "done" | "error";
  error?: string;
  startedAt: number;
}

interface ActivityContextValue {
  jobs: Record<number, LiveJobProgress>;
  modelDownloads: Record<string, ModelDownloadProgress>;
  backfills: Record<number, BackfillProgress>;
  incomingFiles: Record<string, IncomingFileProgress>;
  actions: AppActivity[];
  runAction<T>(activity: Pick<AppActivity, "id" | "label" | "detail">, work: () => Promise<T>): Promise<T>;
  dismissAction(id: string): void;
}

const ActivityContext = createContext<ActivityContextValue | null>(null);

export function ActivityProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<Record<number, LiveJobProgress>>({});
  const [modelDownloads, setModelDownloads] = useState<Record<string, ModelDownloadProgress>>({});
  const [backfills, setBackfills] = useState<Record<number, BackfillProgress>>({});
  const [incomingFiles, setIncomingFiles] = useState<Record<string, IncomingFileProgress>>({});
  const [actions, setActions] = useState<AppActivity[]>([]);
  const removalTimers = useRef(new Map<string, number>());

  useEffect(() => {
    void api.modelDownloadStatus().then((active) => {
      setModelDownloads(Object.fromEntries(active.map((item) => [item.model, item])));
    }).catch(() => {});
    const forgetJob = ({ recording_id }: { recording_id: number }) => {
      setJobs((current) => {
        const next = { ...current };
        delete next[recording_id];
        return next;
      });
    };
    const offs = [
      onJobProgress((progress) => {
        setJobs((current) => ({
          ...current,
          [progress.recording_id]: { ...progress, receivedAt: Date.now() },
        }));
      }),
      onJobDone(forgetJob),
      onJobFailed(forgetJob),
      onModelDownloadProgress((progress) => {
        setModelDownloads((current) => ({ ...current, [progress.model]: progress }));
      }),
      onBackfillProgress((progress) => {
        setBackfills((current) => ({ ...current, [progress.folder_id]: progress }));
      }),
      onIncomingFileProgress((progress) => {
        setIncomingFiles((current) => {
          if (progress.phase !== "done") return { ...current, [progress.path]: progress };
          const next = { ...current };
          delete next[progress.path];
          return next;
        });
      }),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  useEffect(() => () => {
    for (const timer of removalTimers.current.values()) window.clearTimeout(timer);
  }, []);

  const dismissAction = useCallback((id: string) => {
    const timer = removalTimers.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    removalTimers.current.delete(id);
    setActions((current) => current.filter((item) => item.id !== id));
  }, []);

  const runAction = useCallback(async <T,>(
    activity: Pick<AppActivity, "id" | "label" | "detail">,
    work: () => Promise<T>,
  ): Promise<T> => {
    const priorTimer = removalTimers.current.get(activity.id);
    if (priorTimer !== undefined) window.clearTimeout(priorTimer);
    removalTimers.current.delete(activity.id);
    const started: AppActivity = { ...activity, state: "running", startedAt: Date.now() };
    setActions((current) => [...current.filter((item) => item.id !== activity.id), started]);
    try {
      const value = await work();
      setActions((current) => current.map((item) => (
        item.id === activity.id ? { ...item, state: "done" } : item
      )));
      const timer = window.setTimeout(() => dismissAction(activity.id), 3_000);
      removalTimers.current.set(activity.id, timer);
      return value;
    } catch (reason) {
      const error = reason instanceof Error ? reason.message : String(reason);
      setActions((current) => current.map((item) => (
        item.id === activity.id ? { ...item, state: "error", error } : item
      )));
      throw reason;
    }
  }, [dismissAction]);

  const value = useMemo<ActivityContextValue>(() => ({
    jobs,
    modelDownloads,
    backfills,
    incomingFiles,
    actions,
    runAction,
    dismissAction,
  }), [jobs, modelDownloads, backfills, incomingFiles, actions, runAction, dismissAction]);

  return <ActivityContext.Provider value={value}>{children}</ActivityContext.Provider>;
}

export function useActivities(): ActivityContextValue {
  const value = useContext(ActivityContext);
  if (!value) throw new Error("useActivities must be used inside ActivityProvider");
  return value;
}
