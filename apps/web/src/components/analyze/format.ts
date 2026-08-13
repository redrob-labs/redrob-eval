/** Small presentation helpers shared across the Analyze views. */

export function pct(v: number | null | undefined): string {
  return v == null ? '—' : `${(v * 100).toFixed(0)}%`;
}

export function ago(iso: string): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  // Each step divides by the number and adopts the next unit; getting this off
  // by one is how a two-minute-old run reads as "2s ago".
  const steps: Array<[number, string]> = [
    [60, 'm'],
    [60, 'h'],
    [24, 'd'],
  ];
  let value = seconds;
  let unit = 's';
  for (const [size, next] of steps) {
    if (value < size) break;
    value /= size;
    unit = next;
  }
  return `${Math.round(value)}${unit} ago`;
}

export function duration(startedAt?: string, finishedAt?: string): string {
  if (!startedAt) return '—';
  const end = finishedAt ? Date.parse(finishedAt) : Date.now();
  const seconds = Math.max(0, (end - Date.parse(startedAt)) / 1000);
  if (seconds < 90) return `${seconds.toFixed(0)}s`;
  if (seconds < 5400) return `${(seconds / 60).toFixed(0)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

export const STATUS_MARK: Record<string, string> = {
  queued: '·',
  running: '▸',
  done: 'ok',
  failed: '✕',
  cancelled: '×',
};
