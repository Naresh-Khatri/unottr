// The on-disk form of a speaker/person centroid: little-endian f32, the same bytes the rust
// wrote. Lives here rather than beside either writer — `speakers` and `people` both store one.

export function toBlob(v: Float32Array): Buffer {
  const out = Buffer.allocUnsafe(v.length * 4);
  for (let i = 0; i < v.length; i++) out.writeFloatLE(v[i], i * 4);
  return out;
}

export function fromBlob(bytes: Buffer): Float32Array {
  const n = bytes.length >> 2; // a trailing partial float is dropped, not misread
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = bytes.readFloatLE(i * 4);
  return out;
}
