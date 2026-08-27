import { useEffect, useRef, useState } from "react";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { api } from "@/ipc/client";
import type { SearchHit } from "@/ipc/types";
import { hms } from "@/lib/format";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LoadingState } from "@/components/ui/loading-state";

export function Search({ onOpen }: {
  onOpen: (recordingId: number, ms: number, tab?: "transcript" | "overview") => void;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searched, setSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestVersion = useRef(0);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    const version = ++requestVersion.current;
    const query = q.trim();
    if (!query) {
      setHits([]);
      setSearched(false);
      setSearching(false);
      setSearchError(false);
      return undefined;
    }
    setSearching(true);
    setSearchError(false);
    const t = setTimeout(() => {
      api.search(query).then(
        (next) => {
          if (version !== requestVersion.current) return;
          setHits(next);
          setSearched(true);
          setSearching(false);
        },
        () => {
          if (version !== requestVersion.current) return;
          setHits([]);
          setSearched(true);
          setSearching(false);
          setSearchError(true);
        },
      );
    }, 180);
    return () => {
      clearTimeout(t);
      if (requestVersion.current === version) requestVersion.current += 1;
    };
  }, [q]);

  return (
    <div className="mx-auto h-full w-full max-w-2xl overflow-y-auto px-4 py-6 sm:px-6 sm:py-8">
      <div className="relative">
        <MagnifyingGlass className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Search every transcript…" className="h-11 pl-9 text-base" />
      </div>

      <div className="mt-4 space-y-2">
        {searching ? (
          <LoadingState label="Searching transcripts" className="min-h-32" />
        ) : hits.map((h) => (
          // an overview hit has no moment of its own — it opens the tab, not 0:00
          <Card key={`${h.kind}-${h.recording_id}-${h.segment_id}`}
            onClick={() => onOpen(h.recording_id, h.start_ms, h.kind === "overview" ? "overview" : undefined)}
            className="cursor-pointer transition-colors hover:bg-muted/50">
            <CardContent className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span className="truncate">{h.title ?? h.filename}</span>
                {h.kind === "overview"
                  ? <Badge variant="secondary" className="shrink-0 px-1 py-0 text-[10px]">Overview</Badge>
                  : <span className="font-mono tabular-nums">{hms(h.start_ms)}</span>}
              </div>
              <p className="text-sm [&_b]:bg-primary/20 [&_b]:font-medium [&_b]:text-foreground"
                dangerouslySetInnerHTML={{ __html: h.snippet }} />
            </CardContent>
          </Card>
        ))}
        {searchError && (
          <p className="px-1 py-4 text-sm text-destructive">Search failed. Try again.</p>
        )}
        {searched && !searchError && !hits.length && (
          <p className="px-1 py-4 text-sm text-muted-foreground">No matches.</p>
        )}
        {!searching && !searched && (
          <p className="px-1 py-4 text-sm text-muted-foreground">
            Try “roadmap”, “latency”, “numbers”.
          </p>
        )}
      </div>
    </div>
  );
}
