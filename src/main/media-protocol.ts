import { createReadStream, existsSync, statSync } from "node:fs";
import { extname } from "node:path";
import { Readable } from "node:stream";
import { protocol } from "electron";
import { db } from "./db";
import { recordingPath } from "./db/queries";
import { load } from "./db/settings";
import { PREVIEW_COUNT, previewPathFor, thumbPathFor, thumbsDirFor } from "./media/thumbs";

export const MEDIA_SCHEME = "unottr";

// Range support is not optional: a 1.8 GB file served as a single 200 cannot be seeked.
const RANGE_RE = /^bytes=(\d*)-(\d*)$/;

const MIME_BY_EXT: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
  ".ts": "video/mp2t",
  ".flv": "video/x-flv",
  ".wmv": "video/x-ms-wmv",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
};

/**
 * `unottr://media|thumb|preview/<recording_id>[/<index>]`. The renderer names an id, never a
 * path — which is what deletes the whole asset-scope problem: it can only ask for recordings
 * that exist.
 */
export function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, (request) => {
    const url = new URL(request.url);
    switch (url.hostname) {
      case "media":
        return mediaResponse(request, url);
      case "thumb":
        return imageResponse(thumbFile(url));
      case "preview":
        return imageResponse(previewFile(url));
      default:
        return plain(404, "not found");
    }
  });
}

function mediaResponse(request: Request, url: URL): Response {
  const id = Number(url.pathname.slice(1));
  if (!Number.isInteger(id) || id <= 0) return plain(400, "bad recording id");

  const path = recordingPath(db(), id);
  if (!path || !existsSync(path)) return plain(404, "not found");

  // deliberately not net.fetch(file://): that answers a range request with a whole-file
  // 200 and no Accept-Ranges, which chromium reads as "not seekable"
  return fileResponse(path, request.headers.get("Range"));
}

/** `unottr://thumb/<id>` — missing until the ingest job's probe stage reaches it. */
function thumbFile(url: URL): string | null {
  const id = Number(url.pathname.slice(1));
  return Number.isInteger(id) && id > 0 ? thumbPathFor(cacheThumbsDir(), id) : null;
}

/** `unottr://preview/<id>/<index>`, index in [0, PREVIEW_COUNT). */
function previewFile(url: URL): string | null {
  const [idStr, indexStr] = url.pathname.slice(1).split("/");
  const id = Number(idStr);
  const index = Number(indexStr);
  if (!Number.isInteger(id) || id <= 0) return null;
  if (!Number.isInteger(index) || index < 0 || index >= PREVIEW_COUNT) return null;
  return previewPathFor(cacheThumbsDir(), id, index);
}

const cacheThumbsDir = (): string => thumbsDirFor(load(db()).cache_dir);

function fileResponse(path: string, range: string | null): Response {
  const size = statSync(path).size;
  const type = MIME_BY_EXT[extname(path).toLowerCase()] ?? "application/octet-stream";

  if (!range) {
    return new Response(body(createReadStream(path)), {
      status: 200,
      headers: { "Content-Type": type, "Content-Length": String(size), "Accept-Ranges": "bytes" },
    });
  }

  const m = RANGE_RE.exec(range.trim());
  if (!m) return unsatisfiable(size);

  let start: number;
  let end: number;
  if (m[1] === "") {
    // suffix form: the last N bytes
    const n = Number(m[2]);
    if (!Number.isFinite(n) || n <= 0) return unsatisfiable(size);
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return unsatisfiable(size);
  }

  return new Response(body(createReadStream(path, { start, end })), {
    status: 206,
    headers: {
      "Content-Type": type,
      "Content-Length": String(end - start + 1),
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
    },
  });
}

/** Small jpegs, always read whole — no range support needed at this size. */
function imageResponse(path: string | null): Response {
  if (!path || !existsSync(path)) return plain(404, "not found");
  return new Response(body(createReadStream(path)), {
    status: 200,
    headers: { "Content-Type": "image/jpeg", "Content-Length": String(statSync(path).size) },
  });
}

const body = (stream: Readable): ReadableStream =>
  Readable.toWeb(stream) as unknown as ReadableStream;

const plain = (status: number, text: string): Response =>
  new Response(text, { status, headers: { "Content-Type": "text/plain" } });

const unsatisfiable = (size: number): Response =>
  new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
