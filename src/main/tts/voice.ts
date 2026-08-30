import { createReadStream, createWriteStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { pipeline } from "node:stream/promises";
import tar, { type Header } from "tar-stream";
import unbzip2 from "unbzip2-stream";
import { DEFAULT_TTS_VOICE_ID, type ModelDownloadPhase, type TtsVoiceId, type TtsVoiceStatus } from "../../shared/ipc";
import { err } from "../errors";
import { modelsDir } from "../paths";
import type { ModelSpec } from "../models/catalog";
import { ensure, sha256File } from "../models/download";

const RELEASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models";

export interface TtsVoiceSpec {
  id: TtsVoiceId;
  displayName: string;
  language: string;
  archive: string;
  archiveRoot: string;
  archiveSize: number;
  archiveSha256: string;
  archiveEntries: number;
  archiveFiles: number;
  unpackedBytes: number;
  modelFile: string;
  modelSize: number;
  modelSha256: string;
  tokensFile: string;
  tokensSize: number;
  tokensSha256: string;
  sampleRate: number;
  speakerId: number;
  speed: number;
  silenceScale: number;
  threads: number;
  modelLicense: string;
  dataset: string;
}

export const TTS_VOICES = [
  {
    id: "en_US-norman-medium",
    displayName: "Norman",
    language: "English (US)",
    archive: "vits-piper-en_US-norman-medium.tar.bz2",
    archiveRoot: "vits-piper-en_US-norman-medium",
    archiveSize: 67_203_672,
    archiveSha256: "1f32065d480abe9abc7c7f91442125d0b34c1cc065d1e600466cac408eabf3b8",
    archiveEntries: 397,
    archiveFiles: 359,
    unpackedBytes: 81_529_594,
    modelFile: "en_US-norman-medium.onnx",
    modelSize: 63_531_507,
    modelSha256: "fa06b6b8b280e176b17f8424e05ca12d0223eeac9a31c87230937fe7120fbe2a",
    tokensFile: "tokens.txt",
    tokensSize: 940,
    tokensSha256: "ef3a7e4a8d1af0c9d4dc45aaae1a6242ebe24a7ed6f3d025a49eb29682784c6d",
    sampleRate: 22_050,
    speakerId: 0,
    speed: 1,
    silenceScale: 0.2,
    threads: 2,
    modelLicense: "MIT",
    dataset: "Public-domain LibriVox recordings",
  },
  {
    id: "en_US-ljspeech-medium",
    displayName: "LJSpeech",
    language: "English (US)",
    archive: "vits-piper-en_US-ljspeech-medium.tar.bz2",
    archiveRoot: "vits-piper-en_US-ljspeech-medium",
    archiveSize: 67_169_893,
    archiveSha256: "3dfb4b759d8be032a4903a9538d128b0fda2a06ab1de6cbc2d93a97e2dd83dba",
    archiveEntries: 397,
    archiveFiles: 359,
    unpackedBytes: 81_529_587,
    modelFile: "en_US-ljspeech-medium.onnx",
    modelSize: 63_531_507,
    modelSha256: "8ceba58a4b540d4e7e7e24ad079cf0d92762a4fd334e059f12940787c6c37b3d",
    tokensFile: "tokens.txt",
    tokensSize: 940,
    tokensSha256: "ef3a7e4a8d1af0c9d4dc45aaae1a6242ebe24a7ed6f3d025a49eb29682784c6d",
    sampleRate: 22_050,
    speakerId: 0,
    speed: 1,
    silenceScale: 0.2,
    threads: 2,
    modelLicense: "MIT",
    dataset: "Public-domain LJSpeech recordings",
  },
  {
    id: "en_US-lessac-medium",
    displayName: "Lessac",
    language: "English (US)",
    archive: "vits-piper-en_US-lessac-medium.tar.bz2",
    archiveRoot: "vits-piper-en_US-lessac-medium",
    archiveSize: 67_230_653,
    archiveSha256: "9e3febfacf0abf4270172d2958bcec246032b7e88efc2720840cc80c93de334e",
    archiveEntries: 397,
    archiveFiles: 359,
    unpackedBytes: 81_147_006,
    modelFile: "en_US-lessac-medium.onnx",
    modelSize: 63_149_198,
    modelSha256: "4ba07d8549906668ee855fd9abf9faf66c5db74742712ff026a159f7277fca9f",
    tokensFile: "tokens.txt",
    tokensSize: 921,
    tokensSha256: "87c8ef66eae5473ed0cc0366b3964c736ca6c5f676c979522ea31234e47430b9",
    sampleRate: 22_050,
    speakerId: 0,
    speed: 1,
    silenceScale: 0.2,
    threads: 2,
    modelLicense: "MIT",
    dataset: "Lessac Blizzard 2013 recordings",
  },
  {
    id: "en_US-kristin-medium",
    displayName: "Kristin",
    language: "English (US)",
    archive: "vits-piper-en_US-kristin-medium.tar.bz2",
    archiveRoot: "vits-piper-en_US-kristin-medium",
    archiveSize: 67_259_230,
    archiveSha256: "c2206f572df2956c50b1ae3367eebce3853c663e890cba8048cd62b1e4dbe6c7",
    archiveEntries: 397,
    archiveFiles: 359,
    unpackedBytes: 81_529_545,
    modelFile: "en_US-kristin-medium.onnx",
    modelSize: 63_531_507,
    modelSha256: "f9a5c375c70ddc33ccdb3969c76a4d7cc5255ac08119a312b0034a1d07041be6",
    tokensFile: "tokens.txt",
    tokensSize: 940,
    tokensSha256: "ef3a7e4a8d1af0c9d4dc45aaae1a6242ebe24a7ed6f3d025a49eb29682784c6d",
    sampleRate: 22_050,
    speakerId: 0,
    speed: 1,
    silenceScale: 0.2,
    threads: 2,
    modelLicense: "MIT",
    dataset: "Public-domain LibriVox recordings",
  },
  {
    id: "en_US-amy-medium",
    displayName: "Amy",
    language: "English (US)",
    archive: "vits-piper-en_US-amy-medium.tar.bz2",
    archiveRoot: "vits-piper-en_US-amy-medium",
    archiveSize: 67_223_746,
    archiveSha256: "9a5d1fc497f85e8022b785bff5f8105203b1e33099ee6265203efc70b0cb0264",
    archiveEntries: 397,
    archiveFiles: 359,
    unpackedBytes: 81_199_160,
    modelFile: "en_US-amy-medium.onnx",
    modelSize: 63_201_425,
    modelSha256: "fbaa8e36d8f26fe6f3ebb65cab461e629d8b37a5b7c5fb78fb64317db73e1c25",
    tokensFile: "tokens.txt",
    tokensSize: 921,
    tokensSha256: "87c8ef66eae5473ed0cc0366b3964c736ca6c5f676c979522ea31234e47430b9",
    sampleRate: 22_050,
    speakerId: 0,
    speed: 1,
    silenceScale: 0.2,
    threads: 2,
    modelLicense: "MIT",
    dataset: "Mycroft Mimic 3 recordings",
  },
  {
    id: "en_GB-cori-medium",
    displayName: "Cori",
    language: "English (UK)",
    archive: "vits-piper-en_GB-cori-medium.tar.bz2",
    archiveRoot: "vits-piper-en_GB-cori-medium",
    archiveSize: 67_257_412,
    archiveSha256: "49c9a5361bbdd95d7ca9687c4de11e5908481f65e7c7c368960df79949fdac2b",
    archiveEntries: 397,
    archiveFiles: 359,
    unpackedBytes: 81_529_538,
    modelFile: "en_GB-cori-medium.onnx",
    modelSize: 63_531_507,
    modelSha256: "8b0d3cdd77f2878e0aa2048103eabb4d01b334783f99629f042bcf703aeba487",
    tokensFile: "tokens.txt",
    tokensSize: 940,
    tokensSha256: "ef3a7e4a8d1af0c9d4dc45aaae1a6242ebe24a7ed6f3d025a49eb29682784c6d",
    sampleRate: 22_050,
    speakerId: 0,
    speed: 1,
    silenceScale: 0.2,
    threads: 2,
    modelLicense: "MIT",
    dataset: "Public-domain LibriVox recordings",
  },
  {
    id: "en_GB-alan-medium",
    displayName: "Alan",
    language: "English (UK)",
    archive: "vits-piper-en_GB-alan-medium.tar.bz2",
    archiveRoot: "vits-piper-en_GB-alan-medium",
    archiveSize: 67_220_121,
    archiveSha256: "a48d4017da0f77668b27bed63fe6e04dd64c6397e1fadad4f460efb0ef7c9012",
    archiveEntries: 397,
    archiveFiles: 359,
    unpackedBytes: 81_199_210,
    modelFile: "en_GB-alan-medium.onnx",
    modelSize: 63_201_430,
    modelSha256: "d907c48857000940104a9ad3248a94617df917d1a525c9495490fdbf87fd54b2",
    tokensFile: "tokens.txt",
    tokensSize: 921,
    tokensSha256: "87c8ef66eae5473ed0cc0366b3964c736ca6c5f676c979522ea31234e47430b9",
    sampleRate: 22_050,
    speakerId: 0,
    speed: 1,
    silenceScale: 0.2,
    threads: 2,
    modelLicense: "MIT",
    dataset: "Mycroft Mimic 3 recordings",
  },
] as const satisfies readonly TtsVoiceSpec[];

export const DEFAULT_TTS_VOICE = TTS_VOICES.find((voice) => voice.id === DEFAULT_TTS_VOICE_ID)!;

export function voiceById(voiceId: string): TtsVoiceSpec {
  const voice = TTS_VOICES.find((item) => item.id === voiceId);
  if (!voice) throw new Error(`unknown TTS voice ${voiceId}`);
  return voice;
}

const downloadSpec = (voice: TtsVoiceSpec): ModelSpec => ({
  name: voice.id,
  file: voice.archive,
  baseUrl: RELEASE,
  remote: voice.archive,
  size: voice.archiveSize,
  sha256: voice.archiveSha256,
});

export interface VoiceInstallOptions {
  dir?: string;
  signal?: AbortSignal;
  onProgress?: (pct: number) => void;
  onPhase?: (phase: ModelDownloadPhase) => void;
}

export interface InstalledVoicePaths {
  root: string;
  model: string;
  tokens: string;
  dataDir: string;
}

export function ttsRoot(dir: string = modelsDir()): string {
  return join(dir, "tts");
}

export function installedVoicePaths(voiceId: TtsVoiceId, dir: string = modelsDir()): InstalledVoicePaths {
  const voice = voiceById(voiceId);
  const root = join(ttsRoot(dir), voice.id);
  return {
    root,
    model: join(root, voice.modelFile),
    tokens: join(root, voice.tokensFile),
    dataDir: join(root, "espeak-ng-data"),
  };
}

export function voiceStatus(voiceId: TtsVoiceId, dir: string = modelsDir()): TtsVoiceStatus {
  const voice = voiceById(voiceId);
  const paths = installedVoicePaths(voice.id, dir);
  const installed = validInstalledVoice(voice, paths);
  return {
    voice_id: voice.id,
    display_name: voice.displayName,
    language: voice.language,
    state: installed ? "installed" : "missing",
    download_bytes: voice.archiveSize,
    installed_bytes: installed ? directorySize(paths.root) : 0,
  };
}

export function voiceStatuses(dir: string = modelsDir()): TtsVoiceStatus[] {
  return TTS_VOICES.map((voice) => voiceStatus(voice.id, dir));
}

export async function installVoice(
  voiceId: TtsVoiceId,
  options: VoiceInstallOptions = {},
): Promise<InstalledVoicePaths> {
  const voice = voiceById(voiceId);
  const dir = options.dir ?? modelsDir();
  const paths = installedVoicePaths(voice.id, dir);
  if (validInstalledVoice(voice, paths)) {
    options.onProgress?.(1);
    options.onPhase?.("done");
    return paths;
  }
  if (options.signal?.aborted) throw err.cancelled();

  const root = ttsRoot(dir);
  const staging = join(root, `.${voice.id}.staging`);
  const archive = await ensure(downloadSpec(voice), {
    dir: root,
    signal: options.signal,
    onProgress: (pct) => options.onProgress?.(Math.min(0.95, pct * 0.95)),
    onPhase: (phase) => {
      if (phase !== "done") options.onPhase?.(phase);
    },
  });

  options.onPhase?.("verifying");
  const archiveHash = await sha256File(archive);
  if (archiveHash !== voice.archiveSha256) {
    await rm(archive, { force: true });
    throw err.download(voice.id, `checksum mismatch (got ${archiveHash})`);
  }

  options.onPhase?.("installing");
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    const extracted = await extractVerifiedArchive(voice, archive, staging, options.signal);
    const stagedPaths = pathsFromRoot(voice, extracted);
    await verifyStagedVoice(voice, stagedPaths);
    await writeFile(join(extracted, "manifest.json"), `${JSON.stringify({
      version: 1,
      voice_id: voice.id,
      source_url: `${RELEASE}/${voice.archive}`,
      archive_sha256: voice.archiveSha256,
      archive_bytes: voice.archiveSize,
      files: voice.archiveFiles,
      sample_rate: voice.sampleRate,
    }, null, 2)}\n`, { flag: "wx" });

    await rm(paths.root, { recursive: true, force: true });
    await rename(extracted, paths.root);
    await rm(staging, { recursive: true, force: true });
    await rm(archive, { force: true });
    options.onProgress?.(1);
    options.onPhase?.("done");
    return paths;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (options.signal?.aborted) throw err.cancelled();
    throw error;
  }
}

export async function removeVoice(voiceId: TtsVoiceId, dir: string = modelsDir()): Promise<void> {
  const voice = voiceById(voiceId);
  const root = ttsRoot(dir);
  await Promise.all([
    rm(installedVoicePaths(voice.id, dir).root, { recursive: true, force: true }),
    rm(join(root, voice.archive), { force: true }),
    rm(join(root, `${voice.archive}.part`), { force: true }),
    rm(join(root, `.${voice.id}.staging`), { recursive: true, force: true }),
  ]);
}

export function validateArchiveEntry(
  voiceId: TtsVoiceId,
  header: Pick<Header, "name" | "type" | "size">,
): string {
  const voice = voiceById(voiceId);
  const name = header.name;
  const clean = name.endsWith("/") ? name.slice(0, -1) : name;
  if (!clean || clean.includes("\0") || clean.includes("\\") || posix.isAbsolute(clean)) {
    throw new Error(`unsafe TTS archive path ${JSON.stringify(name)}`);
  }
  if (posix.normalize(clean) !== clean || /^[A-Za-z]:/.test(clean)) {
    throw new Error(`unsafe TTS archive path ${JSON.stringify(name)}`);
  }
  if (header.type !== "file" && header.type !== "directory") {
    throw new Error(`unsupported TTS archive entry type ${header.type ?? "unknown"}`);
  }

  const [top, ...rest] = clean.split("/");
  if (top !== voice.archiveRoot) {
    throw new Error(`unexpected TTS archive root ${JSON.stringify(top)}`);
  }
  if (rest.length === 0) {
    if (header.type !== "directory") throw new Error("TTS archive root must be a directory");
    return clean;
  }

  const relative = rest.join("/");
  const rootFiles = new Set([
    "MODEL_CARD",
    voice.modelFile,
    `${voice.modelFile}.json`,
    voice.tokensFile,
  ]);
  if (!rootFiles.has(relative) && relative !== "espeak-ng-data" && !relative.startsWith("espeak-ng-data/")) {
    throw new Error(`unexpected TTS archive entry ${JSON.stringify(name)}`);
  }
  return clean;
}

async function extractVerifiedArchive(
  voice: TtsVoiceSpec,
  archive: string,
  staging: string,
  signal?: AbortSignal,
): Promise<string> {
  let entries = 0;
  let files = 0;
  let bytes = 0;
  const extract = tar.extract();

  extract.on("entry", (header, stream, next) => {
    void (async () => {
      if (signal?.aborted) throw err.cancelled();
      const safeName = validateArchiveEntry(voice.id, header);
      entries += 1;
      if (entries > voice.archiveEntries) throw new Error("TTS archive has too many entries");
      const destination = join(staging, ...safeName.split("/"));

      if (header.type === "directory") {
        await mkdir(destination, { recursive: true });
        stream.resume();
      } else {
        files += 1;
        bytes += header.size;
        if (files > voice.archiveFiles || bytes > voice.unpackedBytes) {
          throw new Error("TTS archive exceeds its pinned contents");
        }
        await mkdir(dirname(destination), { recursive: true });
        await pipeline(stream, createWriteStream(destination, { flags: "wx", mode: 0o600 }));
      }
      next();
    })().catch((error) => extract.destroy(error instanceof Error ? error : new Error(String(error))));
  });

  await pipeline(
    createReadStream(archive),
    unbzip2(),
    extract as unknown as NodeJS.WritableStream,
    { signal },
  );
  if (entries !== voice.archiveEntries || files !== voice.archiveFiles) {
    throw new Error(`TTS archive entry count mismatch: ${entries} entries and ${files} files`);
  }
  if (bytes !== voice.unpackedBytes) {
    throw new Error(`TTS archive size mismatch: ${bytes} unpacked bytes`);
  }
  return join(staging, voice.archiveRoot);
}

async function verifyStagedVoice(voice: TtsVoiceSpec, paths: InstalledVoicePaths): Promise<void> {
  if (statSync(paths.model).size !== voice.modelSize) throw new Error("TTS model size mismatch");
  if (statSync(paths.tokens).size !== voice.tokensSize) throw new Error("TTS tokens size mismatch");
  if (!statSync(paths.dataDir).isDirectory()) throw new Error("TTS espeak data is missing");

  const [modelHash, tokensHash] = await Promise.all([sha256File(paths.model), sha256File(paths.tokens)]);
  if (modelHash !== voice.modelSha256) throw new Error("TTS model checksum mismatch");
  if (tokensHash !== voice.tokensSha256) throw new Error("TTS tokens checksum mismatch");
}

function validInstalledVoice(voice: TtsVoiceSpec, paths: InstalledVoicePaths): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(paths.root, "manifest.json"), "utf8")) as Record<string, unknown>;
    return manifest.voice_id === voice.id
      && manifest.archive_sha256 === voice.archiveSha256
      && statSync(paths.model).size === voice.modelSize
      && statSync(paths.tokens).size === voice.tokensSize
      && statSync(paths.dataDir).isDirectory();
  } catch {
    return false;
  }
}

function pathsFromRoot(voice: TtsVoiceSpec, root: string): InstalledVoicePaths {
  return {
    root,
    model: join(root, voice.modelFile),
    tokens: join(root, voice.tokensFile),
    dataDir: join(root, "espeak-ng-data"),
  };
}

function directorySize(root: string): number {
  if (!existsSync(root)) return 0;
  let total = 0;
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    if (!current) continue;
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) pending.push(path);
      else if (stat.isFile()) total += stat.size;
    }
  }
  return total;
}
