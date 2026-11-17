/**
 * Phase 7, A4: how a remaining time is shown. Display only.
 *
 * Both countdowns on the taking and result pages format through this one function so the two
 * screens read the same, and neither of them ever turns a remaining time into an expiry: the
 * server decides that, and the page only prints what the server last said.
 */
export function formatCountdown(totalSeconds: number): string {
  const bounded = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  const hours = Math.floor(bounded / 3600);
  const minutes = Math.floor((bounded % 3600) / 60);
  const seconds = bounded % 60;
  const two = (value: number): string => String(value).padStart(2, '0');

  return hours > 0 ? `${two(hours)}:${two(minutes)}:${two(seconds)}` : `${two(minutes)}:${two(seconds)}`;
}
