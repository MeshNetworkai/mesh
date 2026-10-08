import { useEffect, useMemo, useState } from 'react';
import { TOKENOMICS, pctFromBps } from '../config';
import { getCatalogue } from '../lib/api';
import type { Catalogue, CatalogueModel } from '../lib/types';
import { ModelPicker } from './ModelPicker';

/**
 * "Same models. Open ones for less. Your Macs get paid." — the homepage price comparison, straight from GET /v1/models
 * (lib/api.ts getCatalogue): list price vs what Mesh bills per 1M tokens for the chosen model. The saving bar
 * appears only when meshPrice < listPrice. A frontier model is billed list plus the markup that covers what the
 * upstream charges Mesh, and the bar says exactly that; it never invents a saving.
 */

type Side = 'completion' | 'prompt';

/** The vendor row under the title: each vendor's flagship (highest list price), frontier vendors first, then open. */
export function vendorRow(models: CatalogueModel[], perTier = 4): string[] {
  const byVendor = new Map<string, CatalogueModel>();
  const price = (m: CatalogueModel) => m.listPrice.promptUsdPerM + m.listPrice.completionUsdPerM;
  for (const m of models) {
    const v = m.vendor || m.displayName;
    const cur = byVendor.get(v);
    if (!cur || price(m) > price(cur)) byVendor.set(v, m);
  }
  const rank = (m: CatalogueModel) => (m.tier === 'frontier' ? 0 : m.tier === 'fast' ? 1 : 2);
  const sorted = [...byVendor.values()].sort((a, b) => rank(a) - rank(b) || price(b) - price(a));
  // A few closed vendors, a few open ones: the row says "the same names you already use", not "the whole list".
  const closed = sorted.filter((m) => m.tier !== 'open').slice(0, perTier);
  const open = sorted.filter((m) => m.tier === 'open').slice(0, perTier);
  return [...closed, ...open].map((m) => m.displayName);
}

/** Default pick: the open-weights model with the largest saving (by share of list, then by dollars). */
export function bestSavingOpen(models: CatalogueModel[], side: Side = 'completion'): CatalogueModel | null {
  const key = side === 'completion' ? 'completionUsdPerM' : 'promptUsdPerM';
  let best: CatalogueModel | null = null;
  let bestPct = -1;
  let bestAbs = -1;
  for (const m of models) {
    if (m.tier !== 'open') continue;
    const list = m.listPrice[key];
    const mesh = m.meshPrice[key];
    if (!(list > 0) || mesh >= list) continue;
    const pct = 1 - mesh / list;
    const abs = list - mesh;
    if (pct > bestPct + 1e-9 || (Math.abs(pct - bestPct) < 1e-9 && abs > bestAbs)) {
      best = m;
      bestPct = pct;
      bestAbs = abs;
    }
  }
  return best ?? models.find((m) => m.tier === 'open') ?? models[0] ?? null;
}

/** "$0.10" / "$0.02" / "$2.40" / "$15": two decimals under $10 (three when the price needs them), none above. */
export function fmtBigPerM(n: number): string {
  if (n === 0) return '$0';
  if (n >= 10) return `$${Math.round(n)}`;
  const two = n.toFixed(2);
  return Number(two) === Number(n.toFixed(3)) ? `$${two}` : `$${n.toFixed(3)}`;
}

const SIDE_LABEL: Record<Side, string> = { completion: 'output', prompt: 'input' };

export function SpendCompare({ id = 'spend' }: { id?: string }) {
  const [cat, setCat] = useState<Catalogue | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [model, setModel] = useState('');
  const [side, setSide] = useState<Side>('completion');

  useEffect(() => {
    let alive = true;
    getCatalogue()
      .then((c) => {
        if (!alive) return;
        setCat(c);
        setModel((cur) => (cur && c.data.some((m) => m.id === cur) ? cur : (bestSavingOpen(c.data)?.id ?? '')));
      })
      .catch((e) => alive && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, []);

  const models = cat?.data ?? null;
  const current = models?.find((m) => m.id === model) ?? null;
  const vendors = useMemo(() => (models ? vendorRow(models) : []), [models]);

  const key = side === 'completion' ? 'completionUsdPerM' : 'promptUsdPerM';
  const list = current ? current.listPrice[key] : null;
  const mesh = current ? current.meshPrice[key] : null;
  const saving = list !== null && mesh !== null && list > 0 && mesh < list ? { usd: list - mesh, pct: Math.round((1 - mesh / list) * 100) } : null;
  const parity = list !== null && mesh !== null && !saving;
  // Above list: an upstream model carries the markup; a network model is on the flat price, which a few small models undercut upstream.
  const above = parity && list !== null && mesh !== null && mesh > list;
  const markup = cat?.pricing.upstreamMarkupBps ?? TOKENOMICS.upstreamMarkupBps;
  const fee = TOKENOMICS.upstreamFeeBps;
  const servedBy = current ? (current.served === 'upstream' ? 'upstream' : 'network') : null;
  const tierLabel = current ? (current.privacy === 'network' ? 'network' : 'upstream · zero data retention') : null;

  return (
    <section className="spend" id={id} aria-labelledby={`${id}-h`}>
      <div className="spend-head">
        <h2 className="display d-m" id={`${id}-h`}>
          Same models. Open ones for less. <span className="muted">Your Macs get paid.</span>
        </h2>
        {vendors.length ? (
          <p className="spend-vendors small muted" aria-label="Models in the catalogue">
            {vendors.map((v, i) => (
              <span key={v}>
                {i > 0 ? <span className="sep" aria-hidden="true">·</span> : null}
                {v}
              </span>
            ))}
          </p>
        ) : null}
      </div>

      <div className="spend-body">
        <div className="spend-pick">
          <label className="lbl small muted" htmlFor={`${id}-model`}>
            Model
          </label>
          <ModelPicker id={`${id}-model`} models={models} value={model} onChange={setModel} size="md" placeholder={err ? 'Could not load the catalogue' : 'Loading…'} />
          <div className="spend-side" role="group" aria-label="Price per 1M tokens">
            {(['completion', 'prompt'] as Side[]).map((s) => (
              <button key={s} type="button" className={`chip${side === s ? ' on' : ''}`} aria-pressed={side === s} onClick={() => setSide(s)}>
                {SIDE_LABEL[s][0].toUpperCase() + SIDE_LABEL[s].slice(1)} tokens
              </button>
            ))}
          </div>
          {current ? (
            <p className="small muted spend-served">
              Served by {servedBy}, privacy {tierLabel}
            </p>
          ) : null}
        </div>

        <div className="spend-nums" aria-live="polite">
          <div className="spend-col">
            <span className="l">List</span>
            <span className="n num">{list === null ? '—' : fmtBigPerM(list)}</span>
            <span className="d">per 1M {SIDE_LABEL[side]} tokens</span>
          </div>
          <div className="spend-col mesh">
            <span className="l">On {TOKENOMICS.name}</span>
            <span className="n num">{mesh === null ? '—' : fmtBigPerM(mesh)}</span>
            <span className="d">per 1M {SIDE_LABEL[side]} tokens</span>
          </div>
          {saving ? (
            <div className="spend-bar" data-state="saving">
              <span className="spend-bar-track" aria-hidden="true">
                <span className="spend-bar-fill" style={{ width: `${Math.max(2, 100 - saving.pct)}%` }} />
              </span>
              <span className="spend-bar-text num">
                You save {fmtBigPerM(saving.usd)} · {saving.pct}% less
              </span>
            </div>
          ) : parity ? (
            <div className="spend-bar" data-state="parity">
              {above && current?.served === 'upstream' ? (
                <>
                  <span className="spend-bar-text">List plus {pctFromBps(markup)} — served privately with zero data retention</span>
                  <span className="small muted">
                    {fee > 0 ? `The upstream charges us ${pctFromBps(fee)} on top of list; the markup covers it. ` : ''}The saving is on open models answered by Macs
                  </span>
                </>
              ) : above ? (
                <>
                  <span className="spend-bar-text">Flat network price — answered by a Mac, the prompt never leaves the network</span>
                  <span className="small muted">For this small model the flat price is above upstream list; larger open models are where the saving is</span>
                </>
              ) : (
                <span className="spend-bar-text">At list price — served privately with zero data retention</span>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
