import { useEffect, useRef, useState } from "react";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { api } from "@/ipc/client";
import type { SearchHit } from "@/ipc/types";
import { hms } from "@/lib/format";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";

export function Search({ onOpen }: { onOpen: (recordingId: number, ms: number) => void }) {
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
          <Card key={h.segment_id} onClick={() => onOpen(h.recording_id, h.start_ms)}
            className="cursor-pointer transition-colors hover:bg-muted/50">
            <CardContent className="flex flex-col gap-1">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="truncate">{h.filename}</span>
                <span className="font-mono tabular-nums">{hms(h.start_ms)}</span>
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
