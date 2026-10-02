import { useId } from 'react';
import type { HourPoint } from '../lib/types';

/** 24h fee sparkline over /stats.series24h. Area + line + end dot, accent only (value moving toward holders). */
export function Sparkline({ points, label }: { points: Array<Pick<HourPoint, 'feesUsd'>>; label: string }) {
  const gid = useId().replace(/:/g, '');
  const W = 600;
  const H = 72;
  const pad = 4;
  if (points.length < 2) return null;
  const vals = points.map((p) => p.feesUsd);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const xs = points.map((_, i) => (i / (points.length - 1)) * W);
  const ys = vals.map((v) => H - pad - ((v - min) / span) * (H - pad * 2));
  const line = xs.map((x, i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${ys[i].toFixed(1)}`).join(' ');
  const area = `${line} L${W} ${H} L0 ${H} Z`;
  const first = vals[0];
  const lastV = vals[vals.length - 1];
  const trend = lastV > first ? 'rising' : lastV < first ? 'falling' : 'flat';

  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${label}, ${trend} toward the end`}>
      <defs>
        <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="var(--accent)" stopOpacity=".18" />
          <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      <circle cx={xs[xs.length - 1]} cy={ys[ys.length - 1]} r="3" fill="var(--accent)" />
    </svg>
  );
}
