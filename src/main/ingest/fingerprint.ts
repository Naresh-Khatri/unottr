// Port of crates/unottr-core/src/ingest/fingerprint.rs. Identity for a file that may be
// renamed, moved between watched folders, or restored from a backup: size + a hash of the
// first and last MiB. Never the whole file — a 4 GiB mkv would be read twice per rescan.
//
// Rust hashed with blake3; here it is sha256 from node:crypto (zero dependencies, same 32
// bytes, and the greenfield database means no stored fingerprint has to survive the change).

import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { err } from "../errors";

const CHUNK = 1 << 20;

export interface Fingerprint {
  size: number;
  head: Buffer;
  tail: Buffer;
}

/** Head and tail are the same bytes for a file under 1 MiB; that is fine, size still varies. */
export async function compute(path: string): Promise<Fingerprint> {
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(path, "r");
  } catch (e) {
    throw err.io(path, e);
  }
  try {
    const { size } = await file.stat();
    const len = Math.min(CHUNK, size);
    const buf = Buffer.allocUnsafe(len);
    await readExact(file, buf, 0);
    const head = sha256(buf);
    await readExact(file, buf, size - len);
    const tail = sha256(buf);
    return { size, head, tail };
  } catch (e) {
    throw err.io(path, e);
  } finally {
    await file.close();
  }
}

export const equals = (a: Fingerprint, b: Fingerprint): boolean =>
  a.size === b.size && a.head.equals(b.head) && a.tail.equals(b.tail);

const sha256 = (b: Buffer): Buffer => createHash("sha256").update(b).digest();

/** A single read() may come up short even on a regular file. */
async function readExact(
  file: Awaited<ReturnType<typeof open>>,
  buf: Buffer,
  position: number,
): Promise<void> {
  let got = 0;
  while (got < buf.length) {
    const { bytesRead } = await file.read(buf, got, buf.length - got, position + got);
    if (bytesRead === 0) throw new Error("unexpected end of file");
    got += bytesRead;
  }
}
