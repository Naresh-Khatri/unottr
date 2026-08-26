import { useEffect, useState } from "react";
import { ChatCircleDots, FilmSlate, Gear, MagnifyingGlass } from "@phosphor-icons/react";
import { RecordingsList } from "@/ui/RecordingsList";
import { TranscriptView } from "@/ui/TranscriptView";
import { Search } from "@/ui/Search";
import { Ask } from "@/ui/Ask";
import { SettingsScreen } from "@/ui/Settings";
import { FirstRun } from "@/ui/FirstRun";
import { FfmpegBanner } from "@/ui/FfmpegBanner";
import { ResourceMeters } from "@/ui/ResourceMeters";
import { api } from "@/ipc/client";
import { useHistory } from "@/lib/useHistory";
import { Button } from "@/components/ui/button";

type View =
  | { screen: "library" }
  | { screen: "search" }
  | { screen: "ask"; recordingId?: number }
  | { screen: "settings" }
  | { screen: "transcript"; id: number; ms: number; tab?: "transcript" | "overview" };

// what counts as the same place in history — a fresh timestamp on the open recording isn't a move
const viewKey = (v: View): string =>
  v.screen === "transcript" ? `transcript:${v.id}:${v.tab ?? "transcript"}` : v.screen;

export default function App() {
  const nav = useHistory<View>({ screen: "library" }, viewKey);
  const { view, go: setView } = nav;
  const [firstRunDone, setFirstRunDone] = useState<boolean | null>(null);
  const [ffmpegOk, setFfmpegOk] = useState(true);
  const [askThreadId, setAskThreadId] = useState<number | null>(null);

  useEffect(() => {
    api.getSettings().then((s) => {
      setFirstRunDone(s.first_run_complete);
      setFfmpegOk(s.ffmpeg_ok);
    });
  }, []);

  if (firstRunDone === null) return null; // avoid a flash of the main shell before the check lands
  if (!firstRunDone) return <FirstRun onDone={() => setFirstRunDone(true)} />;

  if (view.screen === "transcript")
    return (
      <TranscriptView
        id={view.id}
        initialMs={view.ms}
        initialTab={view.tab}
        onBack={() => (nav.canBack ? nav.back() : setView({ screen: "library" }))}
        onOpenSettings={() => setView({ screen: "settings" })}
        onAsk={() => {
          setAskThreadId(null);
          setView({ screen: "ask", recordingId: view.id });
        }}
      />
    );

  return (
    <div className="flex h-full flex-col bg-background">
      {!ffmpegOk && <FfmpegBanner onOpenSettings={() => setView({ screen: "settings" })} />}
      <div className="flex min-h-0 flex-1">
        {/* below lg the rail drops to icons only — labels and meters would crowd the content */}
        <nav className="flex w-14 shrink-0 flex-col gap-1 border-r bg-sidebar px-2 py-4 lg:w-48 lg:px-3">
          <div className="mb-4 truncate px-2 text-sm font-semibold tracking-tight">
            <span className="lg:hidden">un</span>
            <span className="hidden lg:inline">unottr</span>
          </div>
          <Button variant={view.screen === "library" ? "secondary" : "ghost"} title="Library"
            className="justify-center lg:justify-start" onClick={() => setView({ screen: "library" })}>
            <FilmSlate /><span className="hidden lg:inline">Library</span>
          </Button>
          <Button variant={view.screen === "search" ? "secondary" : "ghost"} title="Search"
            className="justify-center lg:justify-start" onClick={() => setView({ screen: "search" })}>
            <MagnifyingGlass /><span className="hidden lg:inline">Search</span>
          </Button>
          <Button variant={view.screen === "ask" ? "secondary" : "ghost"} title="Ask"
            className="justify-center lg:justify-start" onClick={() => setView({ screen: "ask" })}>
            <ChatCircleDots /><span className="hidden lg:inline">Ask</span>
          </Button>
          <Button variant={view.screen === "settings" ? "secondary" : "ghost"} title="Settings"
            className="mt-auto justify-center lg:justify-start" onClick={() => setView({ screen: "settings" })}>
            <Gear /><span className="hidden lg:inline">Settings</span>
          </Button>
          <div className="hidden lg:block"><ResourceMeters /></div>
        </nav>

        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {view.screen === "library" && (
            <RecordingsList
              onOpen={(id, ms) => setView({ screen: "transcript", id, ms: ms ?? 0 })}
              onOpenSettings={() => setView({ screen: "settings" })}
            />
          )}
          {view.screen === "search" && (
            <Search onOpen={(id, ms, tab) => setView({ screen: "transcript", id, ms, tab })} />
          )}
          {view.screen === "ask" && (
            <Ask
              initialRecordingId={view.recordingId}
              selectedThreadId={askThreadId}
              onThreadChange={setAskThreadId}
              onOpenCitation={(id, ms) => setView({ screen: "transcript", id, ms })}
              onOpenSettings={() => setView({ screen: "settings" })}
            />
          )}
          {view.screen === "settings" && <SettingsScreen onFfmpegChange={setFfmpegOk} />}
        </main>
      </div>
    </div>
  );
}
