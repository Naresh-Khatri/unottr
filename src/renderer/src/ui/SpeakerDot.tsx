import { cn } from "@/lib/utils";

/** The speaker's colour, wherever their name is written. Decorative — the name carries it. */
export function SpeakerDot({ color, className }: { color: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("size-2 shrink-0 rounded-full", className)}
      style={{ background: color }}
    />
  );
}
