import { CheckCircle, CircleNotch, WarningCircle } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

export function ActivityBar({ value, indeterminate = false, className }: {
  value?: number;
  indeterminate?: boolean;
  className?: string;
}) {
  const scale = Math.min(1, Math.max(0, value ?? 0));
  return (
    <span
      className={cn("block h-1 overflow-hidden rounded-full bg-muted", className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(scale * 100)}
      aria-valuetext={indeterminate ? "In progress" : undefined}
    >
      {indeterminate ? (
        <span className="progress-indeterminate block h-full w-1/3 rounded-full bg-primary" />
      ) : (
        <span
          className="block size-full origin-left bg-primary transition-transform duration-200 ease-out motion-reduce:transition-none"
          style={{ transform: `scaleX(${scale})` }}
        />
      )}
    </span>
  );
}

export function ActivityMark({ state = "running", className }: {
  state?: "running" | "done" | "error";
  className?: string;
}) {
  if (state === "done") {
    return <CheckCircle weight="fill" className={cn("size-4 shrink-0", className)} />;
  }
  if (state === "error") {
    return <WarningCircle weight="fill" className={cn("size-4 shrink-0 text-destructive", className)} />;
  }
  return (
    <CircleNotch
      className={cn("size-4 shrink-0 animate-spin motion-reduce:animate-none", className)}
      aria-hidden="true"
    />
  );
}

export function ActivityLine({ label, detail, value, indeterminate, state = "running", className }: {
  label: string;
  detail?: string | null;
  value?: number;
  indeterminate?: boolean;
  state?: "running" | "done" | "error";
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 items-start gap-2.5", className)} aria-live="polite">
      <ActivityMark state={state} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{label}</div>
        {detail && <div className="mt-0.5 text-xs leading-5 text-muted-foreground">{detail}</div>}
        {state === "running" && (
          <ActivityBar value={value} indeterminate={indeterminate} className="mt-2" />
        )}
      </div>
    </div>
  );
}
