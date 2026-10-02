/** Minimal terminal output: no emoji, dim labels, aligned key/value tables. */

const tty = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const esc = (code: string, s: string) => (tty ? `\u001b[${code}m${s}\u001b[0m` : s);

export const c = {
  dim: (s: string) => esc('2', s),
  bold: (s: string) => esc('1', s),
  green: (s: string) => esc('32', s),
  yellow: (s: string) => esc('33', s),
  red: (s: string) => esc('31', s),
  cyan: (s: string) => esc('36', s),
};

export const out = {
  line: (s = '') => process.stdout.write(s + '\n'),
  title: (s: string) => process.stdout.write(`\n${c.bold(s)}\n`),
  step: (s: string) => process.stdout.write(`${c.dim('..')} ${s}\n`),
  ok: (s: string) => process.stdout.write(`${c.green('ok')} ${s}\n`),
  warn: (s: string) => process.stdout.write(`${c.yellow('!!')} ${s}\n`),
  fail: (s: string) => process.stderr.write(`${c.red('xx')} ${s}\n`),
  /** Rewrites the current line (progress). */
  progress: (s: string) => {
    if (tty) process.stdout.write(`\r\u001b[2K${c.dim('..')} ${s}`);
  },
  progressEnd: () => {
    if (tty) process.stdout.write('\r\u001b[2K');
  },
};

export function table(rows: Array<[string, string]>): string {
  const w = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `  ${c.dim(k.padEnd(w))}  ${v}`).join('\n');
}

export const fmt = {
  usd: (n: number | null | undefined, digits = 2) => (typeof n === 'number' && Number.isFinite(n) ? `$${n.toFixed(digits)}` : '-'),
  int: (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '-'),
  pct: (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) ? `${n.toFixed(1)}%` : '-'),
  ago: (unixSec: number | null | undefined) => {
    if (!unixSec) return 'never';
    // Accept seconds or milliseconds.
    const sec = unixSec > 1e12 ? Math.floor(unixSec / 1000) : unixSec;
    const s = Math.max(0, Math.floor(Date.now() / 1000) - sec);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  },
};
