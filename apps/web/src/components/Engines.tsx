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
  /** Re-wrapped sub-lines for boxes that are narrower in this layout; same words, more lines. */
  wrap?: (copy: ReturnType<typeof engineCopy>) => Partial<Record<BoxId, string[]>>;
}

export function engineCopy(opts: { usageShareOn: boolean; upstreamDiscountBps: number; holderBps: number }) {
  const discount = opts.upstreamDiscountBps > 0 ? `list − ${opts.upstreamDiscountBps / 100}%` : 'list price';
  const share = `${opts.holderBps / 100}%`;
  return {
    trading: { title: 'Trading', sub: [`every $${T.ticker} swap`] },
    fee: { title: `${feePct} fee`, sub: ['per trade, swept hourly'] },
    pool: { title: 'Hourly credits', sub: ['to every wallet holding', `at least ${minHold}`] },
    treasury: { title: 'Treasury', sub: ['funds the network'] },
    requests: { title: 'Paid requests', sub: [`network ${netPrice}/M tokens`, `frontier at ${discount}`] },
    market: { title: 'Credit market', sub: [`${MARKET_FEE} of every sale`] },
    margin: { title: 'Margin', sub: ['price minus serving cost'] },
    macs: { title: 'Macs', sub: [`earn ${nodePay} per M tokens`] },
    shareLabel: opts.usageShareOn ? `${share} share` : `${share} share · coming`,
    shareLabelShort: opts.usageShareOn ? `${share} → credits` : `${share} → credits · coming`,
  } satisfies Record<BoxId, { title: string; sub: string[] }> & { shareLabel: string; shareLabelShort: string };
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
  // Phone: read top to bottom. Engine 1 first (trade → fee → credits | treasury → Macs), then Engine 2
  // with its own small column; where its margin goes is said in words under the margin box rather than
  // with arrows climbing back up the page (those crossed the labels at 360px).
  w: 360,
  h: 724,
  boxes: {
    trading: { x: 20, y: 24, w: 320, h: 60 },
    fee: { x: 20, y: 124, w: 320, h: 60 },
    pool: { x: 20, y: 244, w: 150, h: 72 },
    treasury: { x: 190, y: 244, w: 150, h: 72 },
    macs: { x: 190, y: 356, w: 150, h: 72 },
    requests: { x: 20, y: 476, w: 150, h: 90 },
    market: { x: 190, y: 476, w: 150, h: 72 },
    margin: { x: 20, y: 600, w: 320, h: 60 },
  },
  // The two narrow columns re-wrap three sub-lines so nothing runs past a box edge at 360 wide.
  wrap: (copy) => ({
    pool: ['to every wallet', `holding ${minHold}`],
    macs: [`paid ${nodePay}`, 'per M tokens'],
    requests: [`network ${netPrice}`, 'per M tokens', copy.requests.sub[1]],
  }),
  edges: (on) => [
    { d: 'M180 84 V124' },
    { d: 'M95 184 V244', accent: true, label: { text: holderPct, x: 103, y: 220, anchor: 'start' } },
    { d: 'M265 184 V244', label: { text: treasuryPct, x: 273, y: 220, anchor: 'start' } },
    { d: 'M265 316 V356' },
    { d: 'M95 566 V600' },
    { d: 'M265 548 V600' },
    { d: 'M95 660 V690', accent: true, dashed: !on, label: { text: '', x: 95, y: 712, anchor: 'middle' } },
    { d: 'M265 660 V690', label: { text: 'the rest → treasury', x: 265, y: 712, anchor: 'middle' } },
  ],
  tags: [
    { text: 'Engine 1 · Trading', x: 20, y: 14 },
    { text: 'Engine 2 · Usage', x: 20, y: 466 },
  ],
};

function Diagram({ layout, on, copy, className }: { layout: Layout; on: boolean; copy: ReturnType<typeof engineCopy>; className: string }) {
  const uid = useId().replace(/:/g, '');
  const mLine = `${uid}-line`;
  const mAccent = `${uid}-accent`;
  const share = className === 'stacked' ? copy.shareLabelShort : copy.shareLabel;
  const edges = layout.edges(on).map((e) => (e.label && e.label.text === '' ? { ...e, label: { ...e.label, text: share } } : e));
  const wrapped = layout.wrap?.(copy) ?? {};
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
          const c = { title: copy[id].title, sub: wrapped[id] ?? copy[id].sub };
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
