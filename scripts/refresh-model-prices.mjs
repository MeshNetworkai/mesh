#!/usr/bin/env node
// Refresh config/model-prices.json from OpenRouter's public model list.
//
//   node scripts/refresh-model-prices.mjs            # fetch + rewrite
//   node scripts/refresh-model-prices.mjs --dry-run  # fetch, print the diff, write nothing
//
// Only the curated ids already in the file (entries with a `tier`) are touched: their promptUsdPerM /
// completionUsdPerM are replaced with what `GET https://openrouter.ai/api/v1/models` reports (OpenRouter
// prices are USD per token; we store USD per 1M). Everything else in the file is preserved. Offline-safe:
// when the fetch fails, the response is malformed, or none of the curated ids is present, the script exits
// 1 and the file is not written.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

const here = dirname(fileURLToPath(import.meta.url));
export const PRICES_PATH = resolve(here, '..', 'config', 'model-prices.json');

/** USD per token (OpenRouter string) -> USD per 1M tokens, rounded to 6 decimals. */
export function perMillion(perToken) {
  const n = Number(perToken);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 1_000_000 * 1e6) / 1e6;
}

/**
 * Apply an OpenRouter `/models` payload to a parsed model-prices.json. Returns the new document and the
 * list of ids whose price changed; never mutates its inputs. Throws when the payload has no `data` array.
 */
export function applyOpenRouterPrices(prices, payload, refreshedAt = new Date().toISOString().slice(0, 10)) {
  if (!payload || !Array.isArray(payload.data)) throw new Error('OpenRouter payload has no data[]');
  const byId = new Map();
  for (const m of payload.data) if (m && typeof m.id === 'string' && m.pricing) byId.set(m.id, m.pricing);
  const models = {};
  const changed = [];
  let matched = 0;
  for (const [id, entry] of Object.entries(prices.models)) {
    const next = { ...entry };
    const pricing = entry.tier ? byId.get(id) : undefined;
    if (pricing) {
      matched++;
      const prompt = perMillion(pricing.prompt);
      const completion = perMillion(pricing.completion);
      if (prompt !== null && completion !== null) {
        if (prompt !== entry.promptUsdPerM || completion !== entry.completionUsdPerM) changed.push({ id, from: [entry.promptUsdPerM, entry.completionUsdPerM], to: [prompt, completion] });
        next.promptUsdPerM = prompt;
        next.completionUsdPerM = completion;
      }
    }
    models[id] = next;
  }
  if (matched === 0) throw new Error('none of the curated ids is in the OpenRouter payload');
  const out = { ...prices, _source: OPENROUTER_MODELS_URL, _refreshedAt: refreshedAt, models };
  return { prices: out, changed, matched };
}

/** Serialise like the hand-written file: one model per line. */
export function formatPrices(prices) {
  const lines = [];
  lines.push('{');
  for (const k of Object.keys(prices)) {
    if (k === 'models') continue;
    lines.push(`  ${JSON.stringify(k)}: ${JSON.stringify(prices[k])},`);
  }
  lines.push('  "models": {');
  const ids = Object.keys(prices.models);
  ids.forEach((id, i) => {
    lines.push(`    ${JSON.stringify(id)}: ${JSON.stringify(prices.models[id]).replace(/,"/g, ', "').replace(/\{"/, '{ "').replace(/\}$/, ' }').replace(/":/g, '": ')}${i < ids.length - 1 ? ',' : ''}`);
  });
  lines.push('  }');
  lines.push('}');
  return lines.join('\n') + '\n';
}

async function main() {
  const dry = process.argv.includes('--dry-run');
  const current = JSON.parse(readFileSync(PRICES_PATH, 'utf8'));
  let payload;
  try {
    const res = await fetch(OPENROUTER_MODELS_URL, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    payload = await res.json();
  } catch (err) {
    console.error(`refresh-model-prices: could not fetch ${OPENROUTER_MODELS_URL}: ${err.message}. File untouched.`);
    process.exit(1);
  }
  let result;
  try {
    result = applyOpenRouterPrices(current, payload);
  } catch (err) {
    console.error(`refresh-model-prices: ${err.message}. File untouched.`);
    process.exit(1);
  }
  for (const c of result.changed) console.log(`${c.id}: ${c.from.join('/')} -> ${c.to.join('/')} USD/M`);
  console.log(`${result.matched} curated models matched, ${result.changed.length} changed${dry ? ' (dry run, nothing written)' : ''}`);
  if (!dry) writeFileSync(PRICES_PATH, formatPrices(result.prices));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
