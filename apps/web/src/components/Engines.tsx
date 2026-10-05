import { useId } from 'react';
import { TOKENOMICS, pctFromBps } from '../config';
import { fmtCost, fmtInt } from '../lib/format';

/**
 * "How the money moves": the two engines that fund the hourly credit pool, as one inline SVG on the
 * design tokens. Engine 1 is the trading fee; engine 2 is the margin on paid usage plus marketplace
 * fees. The engine-2 arrow into the pool is drawn dashed with a "coming" label until the gateway says
 * `usageShareEnabled` (GET /stats), so the diagram never claims something that is not live.
 *
 * Two layouts share the same boxes and arrows: a wide one (desktop) and a stacked one (phone); CSS
 * shows one at a time, so the text stays legible at every width instead of scaling down.
 */

const T = TOKENOMICS;
const feePct = `${T.tradeFeeBps / 100}%`;
const holderPct = `${T.holderShareBps / 100}%`;
const treasuryPct = `${T.treasuryShareBps / 100}%`;
const netPrice = fmtCost(T.networkPricePerMTokens);
const nodePay = fmtCost(T.nodeRewardUsdPerMTokens);
const minHold = `${fmtInt(T.minHoldTokens)} ${T.ticker}`;
const MARKET_FEE = pctFromBps(T.marketplace.feeBps);

type BoxId = 'trading' | 'fee' | 'pool' | 'treasury' | 'requests' | 'market' | 'margin' | 'macs';
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Edge {
  d: string;
  /** holder-bound money: accent stroke */
  accent?: boolean;
  /** engine-2 share while usageShare is off */
  dashed?: boolean;
  label?: { text: string; x: number; y: number; anchor?: 'start' | 'middle' | 'end' };
}
interface Layout {
  w: number;
  h: number;
  boxes: Record<BoxId, Box>;
  edges: (on: boolean) => Edge[];
  /** "Engine 1 · Trading" / "Engine 2 · Usage" captions */
  tags: Array<{ text: string; x: number; y: number }>;
}

export function engineCopy(opts: { usageShareOn: boolean; upstreamDiscountBps: number; holderBps: number }) {
  const discount = opts.upstreamDiscountBps > 0 ? `list − ${opts.upstreamDiscountBps / 100}%` : 'list price';
  const share = `${opts.holderBps / 100}%`;
  return {
    trading: { title: 'Trading', sub: [`every $${T.ticker} swap`] },
    fee: { title: `${feePct} fee`, sub: ['on each trade, swept hourly'] },
    pool: { title: 'Hourly credits', sub: ['to every wallet holding', `at least ${minHold}`] },
    treasury: { title: 'Treasury', sub: ['funds the network'] },
    requests: { title: 'Paid requests', sub: [`network ${netPrice} / M tokens`, `frontier at ${discount}`] },
    market: { title: 'Credit market', sub: [`${MARKET_FEE} of every sale`] },
    margin: { title: 'Margin', sub: ['price minus serving cost'] },
    macs: { title: 'Macs', sub: [`earn ${nodePay} per M tokens`] },
    shareLabel: opts.usageShareOn ? `${share} share` : `${share} share · coming`,
  } satisfies Record<BoxId, { title: string; sub: string[] }> & { shareLabel: string };
}

const WIDE: Layout = {
  w: 1056,
  h: 392,
  boxes: {
    trading: { x: 0, y: 40, w: 200, h: 72 },
    fee: { x: 300, y: 40, w: 180, h: 72 },
    pool: { x: 640, y: 40, w: 200, h: 72 },
    treasury: { x: 640, y: 250, w: 200, h: 72 },
    requests: { x: 0, y: 190, w: 200, h: 84 },
    market: { x: 0, y: 300, w: 200, h: 72 },
    margin: { x: 300, y: 250, w: 180, h: 72 },
    macs: { x: 880, y: 250, w: 176, h: 72 },
  },
  edges: (on) => [
    { d: 'M200 76 H300' },
    { d: 'M480 66 H640', accent: true, label: { text: holderPct, x: 560, y: 56, anchor: 'middle' } },
    { d: 'M480 86 H592 V270 H640', label: { text: treasuryPct, x: 602, y: 184, anchor: 'start' } },
    { d: 'M200 232 H250 V276 H300' },
    { d: 'M200 336 H250 V296 H300' },
    { d: 'M480 282 H540 V96 H640', accent: true, dashed: !on, label: { text: '', x: 530, y: 184, anchor: 'end' } },
    { d: 'M480 302 H640', label: { text: 'the rest', x: 560, y: 322, anchor: 'middle' } },
    { d: 'M840 286 H880' },
  ],
  tags: [
    { text: 'Engine 1 · Trading', x: 0, y: 22 },
    { text: 'Engine 2 · Usage', x: 0, y: 172 },
  ],
};

const STACKED: Layout = {
  w: 360,
  h: 556,
  boxes: {
    trading: { x: 20, y: 4, w: 320, h: 60 },
    fee: { x: 20, y: 104, w: 320, h: 60 },
    pool: { x: 20, y: 224, w: 150, h: 72 },
    treasury: { x: 190, y: 224, w: 150, h: 72 },
    margin: { x: 20, y: 344, w: 150, h: 72 },
    macs: { x: 190, y: 344, w: 150, h: 72 },
    requests: { x: 20, y: 468, w: 150, h: 84 },
    market: { x: 190, y: 468, w: 150, h: 72 },
  },
  edges: (on) => [
    { d: 'M180 64 V104' },
    { d: 'M95 164 V224', accent: true, label: { text: holderPct, x: 103, y: 200, anchor: 'start' } },
    { d: 'M265 164 V224', label: { text: treasuryPct, x: 273, y: 200, anchor: 'start' } },
    { d: 'M60 344 V296', accent: true, dashed: !on, label: { text: '', x: 68, y: 326, anchor: 'start' } },
    { d: 'M150 344 V320 H230 V296', label: { text: 'the rest', x: 158, y: 316, anchor: 'start' } },
    { d: 'M300 296 V344' },
    { d: 'M95 468 V416' },
    { d: 'M265 468 V442 H130 V416' },
  ],
  tags: [{ text: 'Engine 2 · Usage, from below', x: 20, y: 458 }],
};

function Diagram({ layout, on, copy, className }: { layout: Layout; on: boolean; copy: ReturnType<typeof engineCopy>; className: string }) {
  const uid = useId().replace(/:/g, '');
  const mLine = `${uid}-line`;
  const mAccent = `${uid}-accent`;
  const edges = layout.edges(on).map((e) => (e.label && e.label.text === '' ? { ...e, label: { ...e.label, text: copy.shareLabel } } : e));
  return (
    <svg className={`engines-svg ${className}`} viewBox={`0 0 ${layout.w} ${layout.h}`} role="img" aria-labelledby={`${uid}-title`} focusable="false">
      <title id={`${uid}-title`}>
        Two engines fund the hourly credit pool: {feePct} of every trade split {holderPct} to holders and {treasuryPct} to the treasury, and the margin on paid requests plus marketplace fees
        {on ? ', shared with holders and the treasury' : ' (the holder share is not switched on yet)'}; the treasury pays the Macs {nodePay} per million tokens.
      </title>
      <defs>
        <marker id={mLine} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M1 1.5 L8.5 5 L1 8.5" fill="none" stroke="var(--line-2)" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </marker>
        <marker id={mAccent} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M1 1.5 L8.5 5 L1 8.5" fill="none" stroke="var(--accent)" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </marker>
      </defs>
      {layout.tags.map((t) => (
        <text key={t.text} x={t.x} y={t.y} className="engines-tag">
          {t.text}
        </text>
      ))}
      <g className="engines-edges" fill="none" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        {edges.map((e, i) => (
          <g key={i}>
            <path d={e.d} stroke={e.accent ? 'var(--accent)' : 'var(--line-2)'} strokeDasharray={e.dashed ? '4 5' : undefined} markerEnd={`url(#${e.accent ? mAccent : mLine})`} />
            {e.label ? (
              <text x={e.label.x} y={e.label.y} textAnchor={e.label.anchor ?? 'middle'} className={`engines-label${e.accent ? ' accent' : ''}${e.dashed ? ' off' : ''}`}>
                {e.label.text}
              </text>
            ) : null}
          </g>
        ))}
      </g>
      <g className="engines-boxes">
        {(Object.keys(layout.boxes) as BoxId[]).map((id) => {
          const b = layout.boxes[id];
          const c = copy[id];
          const holder = id === 'pool';
          return (
            <g key={id} className={`engines-box${holder ? ' holder' : ''}`}>
              <rect x={b.x + 0.5} y={b.y + 0.5} width={b.w - 1} height={b.h - 1} rx="10" />
              <text x={b.x + 16} y={b.y + 27} className="engines-title">
                {c.title}
              </text>
              {c.sub.map((line, i) => (
                <text key={i} x={b.x + 16} y={b.y + 46 + i * 15} className="engines-sub">
                  {line}
                </text>
              ))}
            </g>
          );
        })}
      </g>
    </svg>
  );
}

export function Engines({ usageShareOn, upstreamDiscountBps = T.upstreamDiscountBps, holderBps = T.usageShare.holderBps }: { usageShareOn: boolean; upstreamDiscountBps?: number; holderBps?: number }) {
  const copy = engineCopy({ usageShareOn, upstreamDiscountBps, holderBps });
  return (
    <div className="engines" data-usage-share={usageShareOn ? 'on' : 'off'}>
      <Diagram layout={WIDE} on={usageShareOn} copy={copy} className="wide" />
      <Diagram layout={STACKED} on={usageShareOn} copy={copy} className="stacked" />
    </div>
  );
}
