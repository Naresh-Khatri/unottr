const OOM_PATTERNS = [
  /out of (?:device )?memory/i,
  /vk_error_out_of_device_memory/i,
  /\boom\b/i,
  /insufficient memory/i,
  /failed to allocate (?:a )?(?:metal )?(?:buffer|heap|memory)/i,
  /(?:metal )?(?:buffer|heap|memory) allocation failed/i,
  /kiogpucommandbuffercallbackerroroutofmemory/i,
];

export function isOomMessage(message: string): boolean {
  return OOM_PATTERNS.some((pattern) => pattern.test(message));
}
