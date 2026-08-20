// Chromium ships its own decoders, so an unsupported container is a clean failure rather
// than the webkitgtk crash this guard was written for. It stays because the answer is still
// no for Matroska, which chromium cannot demux at all and obs writes by default — better a
// "open in your player" card than a black <video> that never fires canplay.

const MIME_BY_EXT: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  webm: "video/webm",
  avi: "video/x-msvideo",
  ts: "video/mp2t",
  flv: "video/x-flv",
  wmv: "video/x-ms-wmv",
};

export function canPlayContainer(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const mime = MIME_BY_EXT[ext];
  // unknown extension -> let the element try; preload="none" + onError catch the rest
  if (!mime) return true;
  return document.createElement("video").canPlayType(mime) !== "";
}
