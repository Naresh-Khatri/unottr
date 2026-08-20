import { useEffect, useRef } from "react";
import { mediaUrl } from "@/ipc/client";

// Bidirectional currentMs sync: segment clicks / find-jumps set currentMs -> we seek the
// element; playback drives currentMs the other way via timeupdate. The threshold stops our
// own timeupdate echo from re-triggering a seek every frame.
const SEEK_EPSILON_MS = 350;

export function VideoPlayer({ recordingId, currentMs, onTimeUpdate, onError }: {
  recordingId: number;
  currentMs: number;
  onTimeUpdate: (ms: number) => void;
  onError: () => void;
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
      // "none" = don't fetch until the user asks. seeking needs the 206 path in
      // media-protocol.ts; a 200-only handler makes a 1.8 GB file unseekable.
      preload="none"
      className="aspect-video w-full rounded-xl border bg-black"
      src={mediaUrl(recordingId)}
      onTimeUpdate={(e) => onTimeUpdate(e.currentTarget.currentTime * 1000)}
      onError={onError}
    />
  );
}
