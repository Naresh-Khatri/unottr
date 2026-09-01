const version = "0.2.0";

export const release = {
  version,
  linux: import.meta.env.PUBLIC_LINUX_DOWNLOAD_URL,
  macos: import.meta.env.PUBLIC_MACOS_DOWNLOAD_URL,
} as const;
