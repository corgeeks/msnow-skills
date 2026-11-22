export function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

export function formatTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '—';
}

const pad = (n: number) => String(n).padStart(2, '0');

export function formatDuration(start: string | null, end: string | null): string {
  if (!start) return '—';
  const s = Math.max(0, Math.floor(((end ? Date.parse(end) : Date.now()) - Date.parse(start)) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return `${h}h ${pad(m)}m`;
  if (m) return `${m}m ${pad(sec)}s`;
  return `${sec}s`;
}
