import { Warning } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";

// 07-hardening-and-packaging.md #3: app-wide and persistent, not tucked into Settings —
// ffmpeg missing means every discovered file is about to park, so the user needs to see
// this from the library too.
export function FfmpegBanner({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">
      <div className="flex flex-wrap items-center gap-2">
        <Warning className="size-4 shrink-0" />
        <span>ffmpeg was not found. Reinstall the app or choose ffmpeg and ffprobe in Settings.</span>
      </div>
      <Button size="xs" variant="outline" onClick={onOpenSettings}>Open Settings</Button>
    </div>
  );
}
