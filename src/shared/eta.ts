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
