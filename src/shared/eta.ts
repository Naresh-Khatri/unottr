/**
 * Deliberately coarse: the estimate jitters by tens of seconds between ticks, and a number
 * that visibly twitches reads as broken even when it is close. Shared because the tray shows
 * the same figure as the list, from the main process.
 */
export function etaLabel(ms: number | null): string {
  if (ms === null || ms < 0) return "";
  const min = Math.round(ms / 60000);
  if (min < 1) return "<1m left";
  if (min < 60) return `~${min}m left`;
  return `~${Math.floor(min / 60)}h ${min % 60}m left`;
}

/**
 * Turn an estimate received at `receivedAt` into a live countdown. The backend replaces the
 * estimate whenever measured progress changes; between those events, work is still moving.
 */
export function countdownEta(
  estimateMs: number | null,
  receivedAt: number,
  now = Date.now(),
): number | null {
  if (estimateMs === null || estimateMs < 0) return null;
  const elapsed = Math.max(0, now - receivedAt);
  return Math.max(0, estimateMs - elapsed);
}
