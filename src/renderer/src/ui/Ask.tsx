import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowSquareOut,
  ArrowCounterClockwise,
  Check,
  Copy,
  MagnifyingGlass,
  Plus,
  Quotes,
  SpeakerHigh,
  StopCircle,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react";
import { api, onAskProgress } from "@/ipc/client";
import type {
  AiConnection,
  AskCitation,
  AskMessage,
  AskScope,
  AskThread,
  AskThreadSummary,
  AskProgress,
  Person,
  RecordingSummary,
} from "@/ipc/types";
import { dateLabel, hms } from "@/lib/format";
import { blankScope, describeScope } from "@/lib/askScope";
import { askSpeech, type AskSpeechState } from "@/lib/askSpeech";
import { cn } from "@/lib/utils";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { AskComposer } from "./AskComposer";
import { AskMarkdown } from "./AskMarkdown";

const STARTERS = [
  "What decisions were made?",
  "What questions were left unresolved?",
  "How did this topic change over time?",
  "What should I follow up on?",
];

const ASK_PHASE_LABEL: Record<AskProgress["phase"], string> = {
  searching: "Searching {scope}",
  asking_model: "Asking the model",
  checking_answer: "Checking the answer",
  saving: "Saving the answer",
};

export function Ask({
  initialRecordingId,
  selectedThreadId,
  onThreadChange,
  onOpenCitation,
  onOpenSettings,
}: {
  initialRecordingId?: number;
  selectedThreadId: number | null;
  onThreadChange: (id: number | null) => void;
  onOpenCitation: (recordingId: number, ms: number) => void;
  onOpenSettings: () => void;
}) {
  const [threads, setThreads] = useState<AskThreadSummary[]>([]);
  const [thread, setThread] = useState<AskThread | null>(null);
  const [scope, setScope] = useState<AskScope>(() =>
    initialRecordingId ? { ...blankScope(), recording_ids: [initialRecordingId] } : blankScope(),
  );
  const [recordings, setRecordings] = useState<RecordingSummary[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [connections, setConnections] = useState<AiConnection[]>([]);
  const [threadSearch, setThreadSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [askPhase, setAskPhase] = useState<AskProgress["phase"]>("searching");
  const [error, setError] = useState<string | null>(null);
  const [sourceMessageId, setSourceMessageId] = useState<number | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [copied, setCopied] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AskThreadSummary | null>(null);
  const [speakAnswers, setSpeakAnswers] = useState(false);
  const [speech, setSpeech] = useState<AskSpeechState>(() => askSpeech.snapshot());
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const loadThreads = (search = threadSearch) => api.askThreads(search).then(setThreads);

  useEffect(() => {
    Promise.all([
      api.listRecordings({ status: "done" }, { by: "recorded_at", dir: "desc" }),
      api.listPeople(),
      api.aiConnections(),
    ]).then(([recordingRows, personRows, connectionRows]) => {
      setRecordings(recordingRows);
      setPeople(personRows);
      setConnections(connectionRows);
    });
    void loadThreads("");
    // Initial data belongs to the screen, not to later search changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => askSpeech.subscribe(setSpeech), []);

  useEffect(() => {
    void Promise.all([api.getSettings(), api.ttsVoiceStatus()]).then(([appSettings, voice]) => {
      setSpeakAnswers(appSettings.ask_speak_answers);
      if (appSettings.ask_speak_answers && voice.state === "installed") askSpeech.warm();
    });
    return () => askSpeech.stop();
  }, []);

  useEffect(() => {
    if (selectedThreadId === null) {
      setThread(null);
      setSourceMessageId(null);
      setScope(initialRecordingId ? { ...blankScope(), recording_ids: [initialRecordingId] } : blankScope());
      return;
    }
    api.askThread(selectedThreadId).then((next) => {
      setThread(next);
      setScope(next.scope);
      setTitleDraft(next.title);
    }, (reason) => setError(cleanError(reason)));
  }, [selectedThreadId, initialRecordingId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadThreads(threadSearch), 160);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadSearch]);

  useEffect(() => onAskProgress((progress) => {
    if (progress.request_id === requestId) setAskPhase(progress.phase);
  }), [requestId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [thread?.messages.length, pendingQuestion]);

  const activeConnection = connections.find((connection) => connection.active) ?? null;
  const sourceMessage = thread?.messages.find((message) => message.id === sourceMessageId) ?? null;
  const sourceList = sourceMessage ? uniqueCitations(sourceMessage) : [];
  const scopeLabel = useMemo(() => describeScope(scope, recordings, people), [scope, recordings, people]);

  async function send(question = draft) {
    const text = question.trim();
    if (!text || requestId) return;
    askSpeech.stop();
    const id = crypto.randomUUID();
    setRequestId(id);
    setAskPhase("searching");
    setPendingQuestion(text);
    setDraft("");
    setError(null);
    try {
      const next = await api.askSend({
        request_id: id,
        thread_id: thread?.id ?? null,
        scope,
        question: text,
      });
      setThread(next);
      setScope(next.scope);
      setTitleDraft(next.title);
      onThreadChange(next.id);
      const answer = next.messages.at(-1);
      if (speakAnswers && answer?.role === "assistant") {
        const voice = await api.ttsVoiceStatus();
        if (voice.state === "installed") {
          window.requestAnimationFrame(() => void askSpeech.speak(answer.id, answer.text));
        }
      }
      await loadThreads("");
    } catch (reason) {
      setDraft(text);
      setError(cleanError(reason));
    } finally {
      setPendingQuestion(null);
      setRequestId(null);
      window.setTimeout(() => textareaRef.current?.focus(), 0);
    }
  }

  function newThread(nextScope = blankScope()) {
    askSpeech.stop();
    onThreadChange(null);
    setThread(null);
    setScope(nextScope);
    setDraft("");
    setError(null);
    setSourceMessageId(null);
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  }

  async function deleteThread() {
    if (!deleteTarget) return;
    await api.askDelete(deleteTarget.id);
    if (thread?.id === deleteTarget.id) newThread();
    setDeleteTarget(null);
    await loadThreads("");
  }

  async function commitTitle() {
    if (!thread) return;
    const title = titleDraft.trim();
    setEditingTitle(false);
    if (!title || title === thread.title) {
      setTitleDraft(thread.title);
      return;
    }
    await api.askRename(thread.id, title);
    setThread({ ...thread, title });
    await loadThreads("");
  }

  async function copyMessage(message: AskMessage, withSources: boolean) {
    const body = message.blocks.map((block) => block.text).join("\n\n");
    const sources = withSources
      ? `\n\nSources\n${uniqueCitations(message)
          .map((citation, index) => `${index + 1}. ${citation.recording_title}, ${hms(citation.start_ms)}`)
          .join("\n")}`
      : "";
    await navigator.clipboard.writeText(`${body}${sources}`);
    setCopied(message.id);
    window.setTimeout(() => setCopied(null), 1_500);
  }

  async function readMessage(message: AskMessage) {
    const voice = await api.ttsVoiceStatus();
    if (voice.state !== "installed") {
      onOpenSettings();
      return;
    }
    await askSpeech.speak(message.id, message.text);
  }

  return (
    <div className="flex h-full min-h-0 bg-background">
      <aside className="flex w-60 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
        <div className="p-3">
          <Button className="w-full justify-start" onClick={() => newThread()}>
            <Plus /> New question
          </Button>
        </div>
        <Separator />
        <div className="p-3 pb-2">
          <div className="relative">
            <MagnifyingGlass className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={threadSearch}
              onChange={(event) => setThreadSearch(event.target.value)}
              placeholder="Search conversations"
              className="pl-8"
            />
          </div>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-1 p-2">
            {threads.map((item) => (
              <div key={item.id} className="group flex items-center gap-1">
                <Button
                  variant={item.id === thread?.id ? "secondary" : "ghost"}
                  className="h-auto min-w-0 flex-1 justify-start px-2.5 py-2 text-left"
                  onClick={() => {
                    askSpeech.stop();
                    onThreadChange(item.id);
                  }}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium">{item.title}</span>
                    <span className="mt-0.5 block truncate text-[10px] font-normal text-muted-foreground">
                      {relativeDate(item.updated_at)} · {item.message_count} messages
                    </span>
                  </span>
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  aria-label={`Delete ${item.title}`}
                  onClick={() => setDeleteTarget(item)}
                >
                  <Trash />
                </Button>
              </div>
            ))}
            {!threads.length && (
              <p className="px-2 py-4 text-xs text-muted-foreground">
                {threadSearch ? "No conversations found." : "Your conversations will appear here."}
              </p>
            )}
          </div>
        </ScrollArea>
      </aside>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget ? `"${deleteTarget.title}" will be removed from this device.` : "This conversation will be removed."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void deleteThread()}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex min-h-14 items-center gap-2 border-b px-4 sm:px-6">
          <div className="min-w-0 flex-1">
            {editingTitle && thread ? (
              <Input
                autoFocus
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
                onBlur={() => void commitTitle()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape") {
                    setTitleDraft(thread.title);
                    setEditingTitle(false);
                  }
                }}
                className="max-w-md"
              />
            ) : (
              <button
                type="button"
                className="block max-w-full truncate text-left text-sm font-semibold"
                onClick={() => thread && setEditingTitle(true)}
              >
                {thread?.title ?? (initialRecordingId ? "Ask this recording" : "Ask your library")}
              </button>
            )}
          </div>
        </header>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-4 py-8 sm:px-8 sm:py-12">
            {!thread?.messages.length && !pendingQuestion ? (
              <EmptyState scopeLabel={scopeLabel} onPick={setDraft} />
            ) : (
              <div className="space-y-8">
                {thread?.messages.map((message) => (
                  <Message
                    key={message.id}
                    message={message}
                    copied={copied === message.id}
                    onSources={() => setSourceMessageId(message.id)}
                    onCopy={(withSources) => void copyMessage(message, withSources)}
                    onCitation={(recordingId, ms) => {
                      askSpeech.stop();
                      onOpenCitation(recordingId, ms);
                    }}
                    onFollowUp={(question) => void send(question)}
                    speech={speech}
                    onRead={() => void readMessage(message)}
                    onStop={() => askSpeech.stop()}
                  />
                ))}
                {pendingQuestion && (
                  <>
                    <UserBubble text={pendingQuestion} />
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Spinner /> {ASK_PHASE_LABEL[askPhase].replace("{scope}", scopeLabel.toLocaleLowerCase())}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        <Sheet open={sourceMessage !== null} onOpenChange={(open) => !open && setSourceMessageId(null)}>
          <SheetContent>
            <SheetHeader className="border-b">
              <SheetTitle>Sources</SheetTitle>
              <SheetDescription>
                {sourceMessage
                  ? `${sourceMessage.used_recordings} of ${sourceMessage.searched_recordings} recordings used`
                  : "Evidence used for this answer"}
              </SheetDescription>
            </SheetHeader>
            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-3 p-4">
                {sourceList.map((citation, index) => (
                  <SourceCard
                    key={`${citation.kind}-${citation.recording_id}-${citation.segment_id ?? citation.task_id}`}
                    citation={citation}
                    index={index + 1}
                    onOpen={(recordingId, ms) => {
                      askSpeech.stop();
                      onOpenCitation(recordingId, ms);
                    }}
                  />
                ))}
              </div>
            </ScrollArea>
          </SheetContent>
        </Sheet>

        <div className="border-t bg-background px-4 py-3 sm:px-6 sm:py-4">
          <div className="mx-auto max-w-3xl space-y-2">
            {error && (
              <Alert variant="destructive">
                <WarningCircle />
                <AlertDescription>{error}</AlertDescription>
                {!activeConnection && (
                  <AlertAction>
                    <Button variant="ghost" size="xs" onClick={onOpenSettings}>Set up AI</Button>
                  </AlertAction>
                )}
              </Alert>
            )}
            <AskComposer
              scope={scope}
              onScopeChange={setScope}
              locked={thread !== null}
              recordings={recordings}
              people={people}
              connections={connections}
              onActivateConnection={(id) => void api.aiConnectionActivate(id).then(setConnections)}
              onOpenSettings={onOpenSettings}
              onNewThread={() => newThread(scope)}
              draft={draft}
              onDraftChange={setDraft}
              onSend={() => void send()}
              onStop={() => requestId && void api.askCancel(requestId)}
              busy={requestId !== null}
              textareaRef={textareaRef}
            />
          </div>
        </div>
      </section>
    </div>
  );
}

function EmptyState({ scopeLabel, onPick }: { scopeLabel: string; onPick: (prompt: string) => void }) {
  return (
    <div className="my-auto space-y-6 py-12">
      <div className="text-center">
        <div className="mx-auto mb-4 grid size-10 place-items-center rounded-lg bg-muted">
          <Quotes className="size-5 text-muted-foreground" />
        </div>
        <h2 className="text-xl font-semibold">Ask about your meetings</h2>
        <p className="mt-1 text-sm text-muted-foreground">Searching {scopeLabel.toLocaleLowerCase()}</p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {STARTERS.map((prompt) => (
          <Button
            type="button"
            key={prompt}
            variant="outline"
            className="h-auto justify-start whitespace-normal px-4 py-3 text-left"
            onClick={() => onPick(prompt)}
          >
            {prompt}
          </Button>
        ))}
      </div>
    </div>
  );
}

function Message({
  message,
  copied,
  onSources,
  onCopy,
  onCitation,
  onFollowUp,
  speech,
  onRead,
  onStop,
}: {
  message: AskMessage;
  copied: boolean;
  onSources: () => void;
  onCopy: (withSources: boolean) => void;
  onCitation: (recordingId: number, ms: number) => void;
  onFollowUp: (question: string) => void;
  speech: AskSpeechState;
  onRead: () => void;
  onStop: () => void;
}) {
  if (message.role === "user") return <UserBubble text={message.text} />;

  const sources = uniqueCitations(message);
  const speaking = speech.activeMessageId === message.id
    && (speech.status === "loading" || speech.status === "playing");
  return (
    <article className="space-y-3">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Quotes /> Ask
        {message.provider && <span className="font-normal">with {message.provider}</span>}
      </div>
      <div className="space-y-4">
        {message.blocks.map((block, index) => (
          <div key={index} className="space-y-2">
            <AskMarkdown>{block.text}</AskMarkdown>
            {!!block.citations.length && (
              <div className="flex flex-wrap items-center gap-1" aria-label="Sources for this part of the answer">
                {block.citations.map((citation) => {
                  const sourceNumber = Math.max(1, sources.findIndex((source) => sameCitation(source, citation)) + 1);
                  return (
                    <CitationMarker
                      key={`${citation.kind}-${citation.segment_id ?? citation.task_id}-${sourceNumber}`}
                      citation={citation}
                      number={sourceNumber}
                      onOpen={onCitation}
                    />
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {!!sources.length && (
          <Button variant="ghost" size="xs" onClick={onSources}>
            <Quotes /> {sources.length} {sources.length === 1 ? "source" : "sources"}
          </Button>
        )}
        <Button variant="ghost" size="xs" onClick={() => onCopy(false)}>
          {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy"}
        </Button>
        {speaking ? (
          <Button variant="ghost" size="xs" onClick={onStop}>
            <StopCircle />Stop
          </Button>
        ) : (
          <Button variant="ghost" size="xs" onClick={onRead} title={speech.error ?? undefined}>
            {speech.lastMessageId === message.id ? <ArrowCounterClockwise /> : <SpeakerHigh />}
            {speech.lastMessageId === message.id ? "Replay" : "Read"}
          </Button>
        )}
        {!!sources.length && (
          <Button variant="ghost" size="xs" onClick={() => onCopy(true)}>Copy with sources</Button>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          {message.used_recordings} of {message.searched_recordings} recordings used
        </span>
      </div>
      {!!message.follow_ups.length && (
        <div className="flex flex-wrap gap-2">
          {message.follow_ups.map((question) => (
            <Button key={question} variant="outline" size="sm" onClick={() => onFollowUp(question)}>
              {question}
            </Button>
          ))}
        </div>
      )}
    </article>
  );
}

function CitationMarker({ citation, number, onOpen }: {
  citation: AskCitation;
  number: number;
  onOpen: (recordingId: number, ms: number) => void;
}) {
  const label = citation.unavailable
    ? `Source ${number} unavailable`
    : `Source ${number}: ${citation.recording_title} at ${hms(citation.start_ms)}`;

  return (
    <HoverCard>
      <HoverCardTrigger
        render={<button type="button" />}
        className={cn(
          "inline-flex h-5 min-w-5 items-center justify-center rounded-full border bg-background px-1.5 text-[10px] font-semibold tabular-nums text-muted-foreground transition-colors",
          "hover:bg-muted hover:text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
          citation.unavailable && "cursor-not-allowed opacity-50",
        )}
        aria-label={label}
        aria-disabled={citation.unavailable}
        onClick={() => !citation.unavailable && onOpen(citation.recording_id, citation.start_ms)}
      >
        {number}
      </HoverCardTrigger>
      <HoverCardContent side="top" align="center" className="w-80 p-0">
        <div className="border-b px-3 py-2.5">
          <div className="flex items-start justify-between gap-3">
            <p className="min-w-0 truncate text-sm font-medium">{citation.recording_title}</p>
            <Badge variant="outline" className="shrink-0">Source {number}</Badge>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {citation.speaker ?? "Unattributed"} · {dateLabel(citation.meeting_date)} · {hms(citation.start_ms)}
          </p>
        </div>
        <div className="space-y-2 px-3 py-2.5">
          {citation.excerpt ? (
            <p className="line-clamp-4 text-xs leading-5">“{citation.excerpt}”</p>
          ) : (
            <p className="text-xs text-muted-foreground">This source is no longer available.</p>
          )}
          <div className="flex flex-wrap items-center gap-1">
            {citation.kind === "workspace" && <Badge variant="secondary">Workspace state</Badge>}
            {citation.source_changed && <Badge variant="outline">Source changed</Badge>}
            {citation.unavailable ? (
              <Badge variant="outline">Unavailable</Badge>
            ) : (
              <span className="ml-auto text-[11px] text-muted-foreground">Click to open at {hms(citation.start_ms)}</span>
            )}
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="ml-auto max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
      {text}
    </div>
  );
}

function SourceCard({ citation, index, onOpen }: {
  citation: AskCitation;
  index: number;
  onOpen: (recordingId: number, ms: number) => void;
}) {
  return (
    <Card size="sm" className={cn(citation.unavailable && "opacity-60")}>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          <span className="truncate">{citation.recording_title}</span>
          <Badge variant="outline">{index}</Badge>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          {citation.speaker ?? "Unattributed"} · {dateLabel(citation.meeting_date)} · {hms(citation.start_ms)}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {citation.excerpt && <p className="line-clamp-4 text-xs leading-5">"{citation.excerpt}"</p>}
        <div className="flex flex-wrap items-center gap-1">
          {citation.kind === "workspace" && <Badge variant="secondary">Workspace state</Badge>}
          {citation.source_changed && <Badge variant="outline">Source changed</Badge>}
          {citation.unavailable ? (
            <Badge variant="outline">Unavailable</Badge>
          ) : (
            <Button size="xs" variant="outline" className="ml-auto" onClick={() => onOpen(citation.recording_id, citation.start_ms)}>
              Open <ArrowSquareOut />
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function uniqueCitations(message: AskMessage): AskCitation[] {
  const seen = new Set<string>();
  return message.blocks.flatMap((block) => block.citations).filter((citation) => {
    const key = `${citation.kind}:${citation.recording_id}:${citation.segment_id ?? citation.task_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sameCitation(a: AskCitation, b: AskCitation): boolean {
  return a.kind === b.kind && a.recording_id === b.recording_id
    && a.segment_id === b.segment_id && a.task_id === b.task_id;
}

function relativeDate(unix: number): string {
  const days = Math.floor((Date.now() - unix * 1_000) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return dateLabel(unix);
}

function cleanError(reason: unknown): string {
  const raw = reason instanceof Error ? reason.message : String(reason);
  const message = raw.replace(/^Error invoking remote method '[^']+': Error:\s*/, "");
  if (message === "unknown command: ask_send") {
    return "Ask's backend has not loaded yet. Restart unottr once, then send the question again.";
  }
  return message;
}
