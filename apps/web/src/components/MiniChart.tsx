import { useId, useState, type ReactNode } from 'react';

/**
 * Two small charts for the public report. Both are plain SVG on the design tokens:
 * series colours come from --chart-1 / --chart-2 (validated for CVD in light and dark),
 * all text wears text tokens, a legend is always present, and hovering a column shows a tooltip.
 */

export interface ChartSeries {
  label: string;
  values: number[];
}

function Legend({ items }: { items: Array<{ label: string; cls: string }> }) {
  return (
    <div className="chart-legend" aria-hidden="true">
      {items.map((it) => (
        <span key={it.label}>
          <i className={it.cls} /> {it.label}
        </span>
      ))}
    </div>
  );
}

function Frame({
  title,
  legend,
  table,
  children,
  tooltip,
}: {
  title: string;
  legend: Array<{ label: string; cls: string }>;
  table: ReactNode;
  children: ReactNode;
  tooltip: ReactNode;
}) {
  return (
    <figure className="chart">
      <figcaption className="row between">
        <span className="eyebrow">{title}</span>
        <Legend items={legend} />
      </figcaption>
      <div className="chart-plot">
        {children}
        {tooltip}
      </div>
      <details className="chart-table">
        <summary className="small muted">Table view</summary>
        {table}
      </details>
    </figure>
  );
}

const W = 600;
const H = 150;
const PAD = { l: 2, r: 2, t: 10, b: 20 };

/** Grouped columns, two series side by side per category (fees in vs credits out, per week). */
export function PairedColumns({
  title,
  categories,
  series,
  format,
}: {
  title: string;
  categories: string[];
  series: [ChartSeries, ChartSeries];
  format: (v: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const gid = useId().replace(/:/g, '');
  const n = categories.length;
  const max = Math.max(1e-9, ...series.flatMap((s) => s.values));
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;
  const slot = plotW / Math.max(1, n);
  const gap = 2;
  const barW = Math.max(2, (slot - 10) / 2 - gap / 2);
  const y = (v: number) => PAD.t + plotH - (v / max) * plotH;
  const tick = (v: number) => y(v);
  const ticks = [0, max / 2, max];

  return (
    <Frame
      title={title}
      legend={[
        { label: series[0].label, cls: 'c1' },
        { label: series[1].label, cls: 'c2' },
      ]}
      tooltip={
        hover !== null ? (
          <div className="chart-tip" style={{ left: `${((hover + 0.5) / n) * 100}%` }} role="status">
            <b>{categories[hover]}</b>
            <span>
              {series[0].label} <em>{format(series[0].values[hover])}</em>
            </span>
            <span>
              {series[1].label} <em>{format(series[1].values[hover])}</em>
            </span>
          </div>
        ) : null
      }
      table={
        <table className="tbl small">
          <thead>
            <tr>
              <th>Week</th>
              <th className="num">{series[0].label}</th>
              <th className="num">{series[1].label}</th>
            </tr>
          </thead>
          <tbody>
            {categories.map((c, i) => (
              <tr key={c}>
                <td className="date">{c}</td>
                <td className="num">{format(series[0].values[i])}</td>
                <td className="num">{format(series[1].values[i])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      }
    >
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-labelledby={`${gid}-t`} onMouseLeave={() => setHover(null)}>
        <title id={`${gid}-t`}>
          {title}: {series[0].label} and {series[1].label} per week, last {n} weeks
        </title>
        {ticks.map((t, i) => (
          <line key={i} x1={PAD.l} x2={W - PAD.r} y1={tick(t)} y2={tick(t)} className="chart-grid" vectorEffect="non-scaling-stroke" />
        ))}
        {categories.map((c, i) => {
          const x0 = PAD.l + i * slot + 5;
          const v1 = series[0].values[i];
          const v2 = series[1].values[i];
          const hot = hover === i;
          return (
            <g key={c} className={hot ? 'hot' : undefined}>
              <rect x={PAD.l + i * slot} y={0} width={slot} height={H} fill="transparent" onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={0} aria-label={`${c}: ${series[0].label} ${format(v1)}, ${series[1].label} ${format(v2)}`} />
              <rect className="bar c1" x={x0} y={y(v1)} width={barW} height={Math.max(0, PAD.t + plotH - y(v1))} rx={2} />
              <rect className="bar c2" x={x0 + barW + gap} y={y(v2)} width={barW} height={Math.max(0, PAD.t + plotH - y(v2))} rx={2} />
            </g>
          );
        })}
        <line x1={PAD.l} x2={W - PAD.r} y1={PAD.t + plotH} y2={PAD.t + plotH} className="chart-axis" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="chart-x" aria-hidden="true">
        <span>{categories[0]}</span>
        <span>{categories[n - 1]}</span>
      </div>
    </Frame>
  );
}

/** 100 % stacked columns: share of requests served by Mesh nodes vs OpenRouter, per week. */
export function ShareColumns({
  title,
  categories,
  a,
  b,
}: {
  title: string;
  categories: string[];
  a: ChartSeries;
  b: ChartSeries;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const gid = useId().replace(/:/g, '');
  const n = categories.length;
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;
  const slot = plotW / Math.max(1, n);
  const barW = Math.max(2, slot - 10);
  const pct = (i: number) => {
    const t = a.values[i] + b.values[i];
    return t === 0 ? null : a.values[i] / t;
  };
  const fmtPct = (p: number | null) => (p === null ? '—' : `${Math.round(p * 1000) / 10}%`);

  return (
    <Frame
      title={title}
      legend={[
        { label: a.label, cls: 'c1' },
        { label: b.label, cls: 'c2' },
      ]}
      tooltip={
        hover !== null ? (
          <div className="chart-tip" style={{ left: `${((hover + 0.5) / n) * 100}%` }} role="status">
            <b>{categories[hover]}</b>
            <span>
              {a.label} <em>{fmtPct(pct(hover))}</em> · {a.values[hover].toLocaleString('en-US')} req
            </span>
            <span>
              {b.label} <em>{fmtPct(pct(hover) === null ? null : 1 - (pct(hover) as number))}</em> · {b.values[hover].toLocaleString('en-US')} req
            </span>
          </div>
        ) : null
      }
      table={
        <table className="tbl small">
          <thead>
            <tr>
              <th>Week</th>
              <th className="num">{a.label}</th>
              <th className="num">{b.label}</th>
              <th className="num">Node share</th>
            </tr>
          </thead>
          <tbody>
            {categories.map((c, i) => (
              <tr key={c}>
                <td className="date">{c}</td>
                <td className="num">{a.values[i].toLocaleString('en-US')}</td>
                <td className="num">{b.values[i].toLocaleString('en-US')}</td>
                <td className="num">{fmtPct(pct(i))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      }
    >
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-labelledby={`${gid}-t`} onMouseLeave={() => setHover(null)}>
        <title id={`${gid}-t`}>
          {title}: share of requests served by {a.label} vs {b.label} per week
        </title>
        {[0, 0.5, 1].map((t, i) => (
          <line key={i} x1={PAD.l} x2={W - PAD.r} y1={PAD.t + plotH * (1 - t)} y2={PAD.t + plotH * (1 - t)} className="chart-grid" vectorEffect="non-scaling-stroke" />
        ))}
        {categories.map((c, i) => {
          const p = pct(i);
          const x = PAD.l + i * slot + 5;
          const hA = p === null ? 0 : plotH * p;
          const hB = p === null ? 0 : plotH * (1 - p);
          const hot = hover === i;
          return (
            <g key={c} className={hot ? 'hot' : undefined}>
              <rect x={PAD.l + i * slot} y={0} width={slot} height={H} fill="transparent" onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={0} aria-label={`${c}: ${a.label} ${fmtPct(p)}`} />
              {p === null ? (
                <rect className="bar empty" x={x} y={PAD.t} width={barW} height={plotH} rx={2} />
              ) : (
                <>
                  <rect className="bar c2" x={x} y={PAD.t} width={barW} height={Math.max(0, hB - 1)} rx={2} />
                  <rect className="bar c1" x={x} y={PAD.t + hB + 1} width={barW} height={Math.max(0, hA - 1)} rx={2} />
                </>
              )}
            </g>
          );
        })}
      </svg>
      <div className="chart-x" aria-hidden="true">
        <span>{categories[0]}</span>
        <span>{categories[n - 1]}</span>
      </div>
    </Frame>
  );
}
