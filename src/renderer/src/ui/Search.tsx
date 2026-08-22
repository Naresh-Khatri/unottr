import { useEffect, useRef, useState } from "react";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { api } from "@/ipc/client";
import type { SearchHit } from "@/ipc/types";
import { hms } from "@/lib/format";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export function Search({ onOpen }: {
  onOpen: (recordingId: number, ms: number, tab?: "transcript" | "overview") => void;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searched, setSearched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      if (!q.trim()) { setHits([]); setSearched(false); return; }
      api.search(q).then((h) => { setHits(h); setSearched(true); });
    }, 180);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <div className="mx-auto h-full w-full max-w-2xl overflow-y-auto px-6 py-8">
      <div className="relative">
        <MagnifyingGlass className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Search every transcript…" className="h-11 pl-9 text-base" />
      </div>

      <div className="mt-4 space-y-2">
        {hits.map((h) => (
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
        {searched && !hits.length && (
          <p className="px-1 py-4 text-sm text-muted-foreground">No matches.</p>
        )}
        {!searched && (
          <p className="px-1 py-4 text-sm text-muted-foreground">
            Try “roadmap”, “latency”, “numbers”.
          </p>
        )}
      </div>
    </div>
  );
}
