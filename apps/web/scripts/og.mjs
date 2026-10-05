// Generates the social images from the design system: public/og.png (1200x630) and
// public/apple-touch-icon.png (180x180). No browser needed: an SVG is rasterised with @resvg/resvg-js
// using the same Onest / Inter files (the @fontsource subsets name their families per
// weight, hence "Onest Light" / "Onest Medium" below) the site ships via @fontsource (WOFF -> TTF here,
// since the rasteriser reads sfnt fonts only).
// Usage: pnpm --filter web og
import { inflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '..');
const outDir = resolve(webRoot, 'public');
const tokenomics = JSON.parse(readFileSync(resolve(webRoot, '../../config/tokenomics.json'), 'utf8'));

// ---- design system tokens (docs/design-system.html) ----
const C = { bg: '#ffffff', fg: '#0b1220', fg2: '#4b5563', muted: '#7b8798', line: '#e6e9ee', accent: '#1f9d66', accentSoft: 'rgba(31,157,102,.10)', ink: '#050912' };

/** WOFF 1.0 -> TTF/OTF bytes (WOFF is zlib-compressed sfnt tables; no deps needed). */
function woffToSfnt(buf) {
  const u32 = (o) => buf.readUInt32BE(o);
  const u16 = (o) => buf.readUInt16BE(o);
  if (buf.toString('ascii', 0, 4) !== 'wOFF') throw new Error('not a WOFF 1.0 file');
  const flavor = u32(4);
  const numTables = u16(12);
  const tables = [];
  for (let i = 0; i < numTables; i++) {
    const o = 44 + i * 20;
    const tag = buf.subarray(o, o + 4);
    const offset = u32(o + 4);
    const compLength = u32(o + 8);
    const origLength = u32(o + 12);
    const checksum = u32(o + 16);
    const raw = buf.subarray(offset, offset + compLength);
    const data = compLength < origLength ? inflateSync(raw) : Buffer.from(raw);
    tables.push({ tag, checksum, data });
  }
  const pad4 = (n) => (n + 3) & ~3;
  let size = 12 + 16 * numTables;
  for (const t of tables) size += pad4(t.data.length);
  const out = Buffer.alloc(size);
  let entrySelector = 0;
  while (1 << (entrySelector + 1) <= numTables) entrySelector++;
  const searchRange = (1 << entrySelector) * 16;
  out.writeUInt32BE(flavor, 0);
  out.writeUInt16BE(numTables, 4);
  out.writeUInt16BE(searchRange, 6);
  out.writeUInt16BE(entrySelector, 8);
  out.writeUInt16BE(numTables * 16 - searchRange, 10);
  let dataOffset = 12 + 16 * numTables;
  tables.forEach((t, i) => {
    const e = 12 + i * 16;
    t.tag.copy(out, e);
    out.writeUInt32BE(t.checksum, e + 4);
    out.writeUInt32BE(dataOffset, e + 8);
    out.writeUInt32BE(t.data.length, e + 12);
    t.data.copy(out, dataOffset);
    dataOffset += pad4(t.data.length);
  });
  return out;
}

// resvg-js 2.x loads fonts from paths only, so the converted files go to a cache dir next to node_modules.
const fontDir = resolve(webRoot, 'node_modules/.cache/mesh-og-fonts');
mkdirSync(fontDir, { recursive: true });
function fontFile(pkg, file) {
  const out = resolve(fontDir, file.replace(/\.woff$/, '.ttf'));
  writeFileSync(out, woffToSfnt(readFileSync(require.resolve(`${pkg}/files/${file}`))));
  return out;
}
const fontFiles = [
  fontFile('@fontsource/onest', 'onest-latin-300-normal.woff'),
  fontFile('@fontsource/onest', 'onest-latin-500-normal.woff'),
  fontFile('@fontsource/inter', 'inter-latin-400-normal.woff'),
  fontFile('@fontsource/inter', 'inter-latin-500-normal.woff'),
];
// Labels are Inter 500, sentence case, no tracking (never a letter-spaced monospace face). Numbers use tabular figures.

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
const minHold = Number(tokenomics.minHoldTokens).toLocaleString('en-US');
const feePct = `${tokenomics.tradeFeeBps / 100}%`;
const holderPct = `${tokenomics.holderShareBps / 100}%`;
const netPrice = `$${Number(tokenomics.requestPricing?.networkPricePerMTokens ?? 0.02)}`;
const nodePay = `$${Number(tokenomics.nodeRewards?.usdPerMTokens ?? 0.06)}`;
const marketFee = `${Number(((tokenomics.marketplace?.feeBps ?? 250) / 100).toFixed(2))}%`;
const betaLabel = tokenomics.beta?.enabled === false ? '' : ` · ${tokenomics.beta?.label ?? 'Beta'}`;
const dots = (x, y, r, gap) =>
  [0, 1, 2, 3, 4].map((i) => `<circle cx="${x + i * (2 * r + gap)}" cy="${y}" r="${r}" fill="${i === 2 ? C.accent : C.fg}"/>`).join('');

/** 1200x630: white page, hero headline left, readout card right, eyebrow + footer line. Same layout concept as the landing. */
function ogSvg() {
  const W = 1200;
  const H = 630;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <radialGradient id="glow" cx="0.72" cy="0.45" r="0.55">
      <stop offset="0" stop-color="${C.accent}" stop-opacity="0.12"/>
      <stop offset="1" stop-color="${C.accent}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="${C.bg}"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>

  <!-- logo -->
  <g transform="translate(72 64)">${dots(6, 0, 5, 3)}<text x="76" y="7" font-family="Onest Medium" font-size="22" letter-spacing="-0.4" fill="${C.fg}">${esc(tokenomics.name)}</text></g>
  <text x="${W - 72}" y="70" text-anchor="end" font-family="Inter Medium" font-size="14" fill="${C.muted}">$${esc(tokenomics.ticker)}${esc(betaLabel)}</text>

  <!-- headline: the landing hero (pages/Landing.tsx) -->
  <g font-family="Onest Light" font-size="80" letter-spacing="-2.8" fill="${C.fg}">
    <text x="68" y="230">Trades fund it.</text>
    <text x="68" y="314">Macs serve it.</text>
    <text x="68" y="398" fill="${C.accent}">Holders use it.</text>
  </g>
  <text x="72" y="444" font-family="Inter Medium" font-size="14" fill="${C.muted}">Use it · Sell it · Run it · Hold it</text>
  <text x="72" y="486" font-family="Inter" font-size="21" fill="${C.fg2}">Hold ${esc(minHold)} $${esc(tokenomics.ticker)} and AI credits land every hour from the ${esc(feePct)} trading fee.</text>
  <text x="72" y="518" font-family="Inter" font-size="21" fill="${C.fg2}">Open models on Macs at ${esc(netPrice)}/M tokens, frontier models at list, unused credits sold on.</text>

  <!-- key figures card: the landing's "Key figures" tiles, every number from config -->
  <g transform="translate(820 150)">
    <rect x="0.5" y="0.5" width="307" height="300" rx="24" fill="${C.bg}" stroke="${C.line}"/>
    <text x="24" y="40" font-family="Inter Medium" font-size="13" fill="${C.muted}">Two engines, one hourly pool</text>
    <circle cx="258" cy="36" r="4" fill="${C.accent}"/>
    <text x="270" y="40" font-family="Inter" font-size="12" fill="${C.fg}">Live</text>
    <line x1="0.5" y1="60" x2="307.5" y2="60" stroke="${C.line}"/>
    <text x="24" y="118" font-family="Onest Light" font-size="56" letter-spacing="-2.2" fill="${C.fg}">${esc(holderPct)}</text>
    <text x="24" y="146" font-family="Inter" font-size="13" fill="${C.fg2}">of every ${esc(feePct)} trade fee, as credits for holders</text>
    <line x1="0.5" y1="170" x2="307.5" y2="170" stroke="${C.line}"/>
    <g font-family="Inter" font-size="13" fill="${C.fg2}">
      <text x="24" y="204">Network price</text>
      <text x="24" y="234">Node pay</text>
      <text x="24" y="264">Marketplace fee</text>
    </g>
    <g font-family="Inter Medium" font-size="13" fill="${C.fg}" text-anchor="end" font-variant-numeric="tabular-nums">
      <text x="283" y="204">${esc(netPrice)} / M tokens</text>
      <text x="283" y="234">${esc(nodePay)} / M tokens</text>
      <text x="283" y="264">${esc(marketFee)}, half to holders</text>
    </g>
  </g>

  <!-- footer line -->
  <line x1="72" y1="566" x2="${W - 72}" y2="566" stroke="${C.line}"/>
  <text x="72" y="594" font-family="Inter" font-size="13" fill="${C.muted}">Credits are a share of fees, not a promise.</text>
  <text x="${W - 72}" y="594" text-anchor="end" font-family="Inter" font-size="13" fill="${C.muted}">mesh-network.ai</text>
</svg>`;
}

/** 180x180 touch icon: ink square, five dots as a quincunx (same as favicon.svg). */
function touchIconSvg() {
  const d = (cx, cy, accent) => `<circle cx="${cx}" cy="${cy}" r="17" fill="${accent ? '#4fd394' : '#f3f5f7'}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" viewBox="0 0 180 180">
  <rect width="180" height="180" rx="40" fill="${C.ink}"/>
  ${d(50, 50)}${d(130, 50)}${d(90, 90, true)}${d(50, 130)}${d(130, 130)}
</svg>`;
}

function render(svg, width, file) {
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: width }, font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'Inter' } });
  const png = r.render().asPng();
  writeFileSync(file, png);
  console.log(`wrote ${file} (${(png.length / 1024).toFixed(1)} kB)`);
}

mkdirSync(outDir, { recursive: true });
render(ogSvg(), 1200, resolve(outDir, 'og.png'));
render(touchIconSvg(), 180, resolve(outDir, 'apple-touch-icon.png'));
