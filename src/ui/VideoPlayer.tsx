import { useEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

// Bidirectional currentMs sync: segment clicks / find-jumps set currentMs -> we seek the
// element; playback drives currentMs the other way via timeupdate. The threshold stops our
// own timeupdate echo from re-triggering a seek every frame.
const SEEK_EPSILON_MS = 350;

export function VideoPlayer({ path, currentMs, onTimeUpdate }: {
  path: string;
  currentMs: number;
  onTimeUpdate: (ms: number) => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (Math.abs(el.currentTime * 1000 - currentMs) > SEEK_EPSILON_MS) {
      el.currentTime = currentMs / 1000;
    }
  }, [currentMs]);

  return (
    <video
      ref={ref}
      controls
      className="aspect-video w-full rounded-xl border bg-black"
      src={convertFileSrc(path)}
      onTimeUpdate={(e) => onTimeUpdate(e.currentTarget.currentTime * 1000)}
    />
  );
}
