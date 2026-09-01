import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { VAD, findWhisper } from "../src/main/models/catalog";
import { ensure } from "../src/main/models/download";
import { modelsDir } from "../src/main/paths";

const JFK_URL = "https://raw.githubusercontent.com/ggerganov/whisper.cpp/master/samples/jfk.wav";
const JFK_BYTES = 352_078;
const JFK_SHA256 = "59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e";

const whisper = findWhisper("base.en");
if (!whisper) throw new Error("base.en is missing from the model catalog");

await Promise.all([ensure(VAD), ensure(whisper)]);

const response = await fetch(JFK_URL);
if (!response.ok) throw new Error(`JFK fixture download failed with HTTP ${response.status}`);
const audio = Buffer.from(await response.arrayBuffer());
const digest = createHash("sha256").update(audio).digest("hex");
if (audio.length !== JFK_BYTES || digest !== JFK_SHA256) {
  throw new Error(`JFK fixture verification failed: ${audio.length} bytes, sha256 ${digest}`);
}

await mkdir(modelsDir(), { recursive: true });
await writeFile(join(modelsDir(), "jfk.wav"), audio);
console.log(`Prepared native smoke models and audio under ${modelsDir()}`);
