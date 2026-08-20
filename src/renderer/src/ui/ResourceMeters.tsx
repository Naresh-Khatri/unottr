// Ambient cpu/gpu meters for the sidebar footer. Collapsed = usage bar + percentage only;
// everything else (cores, ram, vram, thermals, what the next job will run on) is behind the caret.

import { useEffect, useState } from "react";
import { CaretDown } from "@phosphor-icons/react";
import type { SystemStats } from "@/ipc/types";
import { api } from "@/ipc/client";
import { bytesLabel } from "@/lib/format";
import { cn } from "@/lib/utils";

const POLL_MS = 1500;

const pct = (v: number | null): string => (v === null ? "—" : `${Math.round(v * 100)}%`);

export function ResourceMeters() {
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    // nothing to render while the window is hidden, and the main process shouldn't be
    // shelling out to nvidia-smi for a tray-only session
    const tick = () => {
      if (document.visibilityState === "hidden") return;
      api.systemStats().then((s) => {
        if (alive) setStats(s);
      }, () => {});
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      alive = false;
      clearInterval(t);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);

  if (!stats) return null;
  const { cpu, gpu } = stats;

  return (
    <div className="mt-3 border-t pt-3">
      <button
        type="button"
        aria-expanded={open}
        aria-label="System resource usage"
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
        onClick={() => setOpen((v) => !v)}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Meter label="CPU" value={cpu.usage} />
          <Meter label="GPU" value={gpu?.usage ?? null} />
        </div>
        <CaretDown
          className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
        />
      </button>

      {open && <Details stats={stats} />}
    </div>
  );
}

function Meter({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="grid grid-cols-[1.7rem_1fr_2.1rem] items-center gap-2 text-[11px] leading-none">
      <span className="text-muted-foreground">{label}</span>
      <Bar value={value} />
      <span className="text-right tabular-nums text-muted-foreground">{pct(value)}</span>
    </div>
  );
}

function Bar({ value, className }: { value: number | null; className?: string }) {
  return (
    <div className={cn("h-1 overflow-hidden rounded-full bg-muted", className)}>
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-500",
          value !== null && value >= 0.9 ? "bg-destructive" : "bg-primary",
        )}
        style={{ width: `${(value ?? 0) * 100}%` }}
      />
    </div>
  );
}

function Details({ stats }: { stats: SystemStats }) {
  const { cpu, gpu, device, jobs_active, jobs_queued } = stats;
  const queue =
    jobs_active === 0 && jobs_queued === 0
      ? "idle"
      : `${jobs_active} running${jobs_queued > 0 ? `, ${jobs_queued} queued` : ""}`;

  return (
    <div className="mt-2 space-y-2 px-2 pb-1 text-[11px] text-muted-foreground">
      {/* one sliver per logical core — the shape of the load matters more than any single number */}
      <div className="flex h-4 items-end gap-px">
        {cpu.cores.map((c, i) => (
          <div key={i} className="flex h-full flex-1 items-end rounded-[1px] bg-muted">
            <div className="w-full rounded-[1px] bg-primary" style={{ height: `${Math.max(4, c * 100)}%` }} />
          </div>
        ))}
      </div>
      <Row label="Load" value={cpu.load1.toFixed(2)} />
      <Row label="RAM" value={`${bytesLabel(cpu.mem_used)} / ${bytesLabel(cpu.mem_total)}`} />
      {/* != null, not !== null: an older main process omits these fields entirely */}
      {cpu.temp_c != null && <Row label="Temp" value={`${cpu.temp_c}°C`} />}
      {cpu.watts != null && <Row label="Power" value={`${cpu.watts} W`} />}

      <div className="border-t pt-2">
        {gpu ? (
          <>
            <div className="truncate pb-1 text-foreground" title={gpu.name}>{gpu.name}</div>
            {gpu.vram_total != null && (
              <Row label="VRAM" value={`${bytesLabel(gpu.vram_used ?? 0)} / ${bytesLabel(gpu.vram_total)}`} />
            )}
            {gpu.temp_c != null && <Row label="Temp" value={`${gpu.temp_c}°C`} />}
            {gpu.watts != null && <Row label="Power" value={`${gpu.watts} W`} />}
          </>
        ) : (
          <Row label="GPU" value="none detected" />
        )}
      </div>

      <div className="border-t pt-2">
        <Row label="Transcribes on" value={device.toUpperCase()} />
        <Row label="Queue" value={queue} />
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span>{label}</span>
      <span className="truncate tabular-nums text-foreground">{value}</span>
    </div>
  );
}
