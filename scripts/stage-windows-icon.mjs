import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const sources = ["32x32.png", "128x128.png", "256x256.png"].map((name) => ({
  name,
  data: readFileSync(resolve(root, "resources", "icons", name)),
}));

const images = sources.map(({ name, data }) => {
  if (data.toString("hex", 0, 8) !== "89504e470d0a1a0a") {
    throw new Error(`${name} is not a PNG file`);
  }
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  if (width !== height || width > 256) throw new Error(`${name} must be a square PNG up to 256px`);
  return { name, data, size: width };
});

const headerSize = 6 + images.length * 16;
const header = Buffer.alloc(headerSize);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);

let offset = headerSize;
images.forEach((image, index) => {
  const entry = 6 + index * 16;
  header.writeUInt8(image.size >= 256 ? 0 : image.size, entry);
  header.writeUInt8(image.size >= 256 ? 0 : image.size, entry + 1);
  header.writeUInt8(0, entry + 2);
  header.writeUInt8(0, entry + 3);
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(image.data.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += image.data.length;
});

const output = resolve(root, "resources", "icons", "icon.ico");
writeFileSync(output, Buffer.concat([header, ...images.map((image) => image.data)]));
console.log(`Staged ${output} with ${images.map((image) => `${image.size}px`).join(", ")}`);
