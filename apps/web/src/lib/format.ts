export function fmtUsd(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const sign = n < 0 ? '−' : '';
  return `${sign}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** Small amounts (per-request costs) need more precision than dollars do. */
export function fmtCost(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n === 0) return '$0';
  const abs = Math.abs(n);
  const digits = abs >= 1 ? 2 : abs >= 0.01 ? 3 : abs >= 0.0001 ? 4 : 6;
  return fmtUsd(n, digits);
}

export function fmtSignedUsd(n: number, digits = 3): string {
  if (!Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return `${sign}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function fmtInt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}

export function fmtCompact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 });
}

export function shortAddr(addr: string, head = 4, tail = 4): string {
  if (!addr) return '';
  if (addr.length <= head + tail + 1) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

export function fmtTime(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const localYmd = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** Local date + time (both in the viewer's timezone; previously mixed a UTC date with a local time). */
export function fmtDateTime(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  return `${localYmd(d)} ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

export function fmtDate(unixSec: number): string {
  return localYmd(new Date(unixSec * 1000));
}

export function fmtEpochRef(epochStart: number): string {
  return `epoch ${new Date(epochStart * 1000).toISOString().slice(0, 13)}Z`;
}

export function fmtAgo(unixSec: number | null): string {
  if (!unixSec) return 'never';
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unixSec);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

export function fmtLatency(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}
