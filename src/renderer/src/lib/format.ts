export { etaLabel } from "../../../shared/eta";

export function hms(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

export function durationLabel(ms: number | null): string {
  if (!ms) return "—";
  const min = Math.round(ms / 60000);
  return min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min}m`;
}

export function dateLabel(unixSeconds: number | null): string {
  if (!unixSeconds) return "—";
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
  });
}

/** Companion to dateLabel — the two together disambiguate same-day recordings. */
export function timeLabel(unixSeconds: number | null): string {
  if (!unixSeconds) return "";
  return new Date(unixSeconds * 1000).toLocaleTimeString(undefined, {
    hour: "numeric", minute: "2-digit",
  });
}

export function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}
