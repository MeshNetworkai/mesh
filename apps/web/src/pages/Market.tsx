import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Empty, Notice, Skeleton, Spinner, Tile } from '../components/ui';
import { useAuth } from '../lib/auth';
import { fmtAgo, fmtDate, fmtUsd, shortAddr } from '../lib/format';
import { useAsync, useMe, useSessionAsync } from '../lib/hooks';
import * as market from '../lib/market';
import { fmtDiscount, quoteLocal, type Book, type BookTier, type Fill, type Listing, type MarketConfig, type MyMarket } from '../lib/market';
import { errorMessage, useToast } from '../lib/toast';

/**
 * Credit market (docs/MARKETPLACE.md). Holders list credits they will not use at a discount; buyers pay
 * the discounted price from a prepaid USD balance and receive the credits at face value. Mesh keeps
 * 2.5% of the price: half joins the next hourly holder pool, half is treasury.
 */

const statusWord: Record<string, string> = { open: 'Open', filled: 'Sold out', cancelled: 'Cancelled', expired: 'Expired', pending: 'Pending', paid: 'Paid' };
const prepaidWord: Record<string, string> = { topup: 'Top-up', market_buy: 'Bought credits', market_sale: 'Sold credits', withdrawal: 'Withdrawal', withdrawal_refund: 'Withdrawal returned', adjustment: 'Adjustment' };
const BETA_TOPUP = 'During the beta the team tops up prepaid balances after a hand-sent USDC payment and pays withdrawals out by hand; USDC checkout replaces this after the token launch.';

/** Thin horizontal depth bar; `share` is 0..1 of the deepest tier. */
function DepthBar({ share, on }: { share: number; on: boolean }) {
  return (
    <span className="meter" style={{ margin: 0, width: '100%', minWidth: 60, height: 6, display: 'block' }} aria-hidden="true">
      <i style={{ width: `${Math.max(3, Math.round(share * 100))}%`, background: on ? 'var(--accent)' : 'var(--fg-2)', opacity: on ? 1 : 0.55 }} />
    </span>
  );
}

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="row between" style={{ gap: 12 }}>
      <span className="small" style={{ color: 'var(--fg-2)' }}>
        {label}
      </span>
      <span className="num" style={{ fontWeight: strong ? 600 : 400 }}>
        {value}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------- Liquidity book ----------------------------------------------------------------

function LiquidityBook({ book, tier, onPick }: { book: Book | null; tier: number | null; onPick: (bps: number) => void }) {
  const tiers = book?.tiers ?? [];
  const deepest = Math.max(1e-9, ...tiers.map((t) => t.availableUsd));
  return (
    <div className="panel">
      <div className="row between">
        <span className="eyebrow">Liquidity book</span>
        <span className="small muted num">{book ? `${fmtUsd(book.totalAvailableUsd, 0)} across ${book.listings} listing${book.listings === 1 ? '' : 's'}` : ''}</span>
      </div>
      {!book ? (
        <div className="stack sm">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} w="100%" h="36px" />
          ))}
        </div>
      ) : tiers.length === 0 ? (
        <Empty title="Nothing on the book">Sellers list credits at a discount; the first listing shows up here within seconds.</Empty>
      ) : (
        <div className="tblwrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Discount</th>
                <th className="num">You pay per $1</th>
                <th style={{ width: '40%' }}>Depth</th>
                <th className="num">Available</th>
              </tr>
            </thead>
            <tbody>
              {tiers.map((t) => {
                const on = tier === t.discountBps;
                return (
                  <tr key={t.discountBps} onClick={() => onPick(t.discountBps)} style={{ cursor: 'pointer', background: on ? 'var(--bg-2)' : undefined }} aria-selected={on}>
                    <td>
                      <b>{fmtDiscount(t.discountBps)} off</b>
                      <span className="small muted">
                        {' '}
                        · {t.listings} listing{t.listings === 1 ? '' : 's'}
                      </span>
                    </td>
                    <td className="num">{fmtUsd(t.pricePerUsd, 2)}</td>
                    <td>
                      <DepthBar share={t.availableUsd / deepest} on={on} />
                    </td>
                    <td className="num">{fmtUsd(t.availableUsd, 2)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="hint">Deepest discount first. Pick a row to buy at that discount; partial fills are fine.</p>
    </div>
  );
}

// ---------------------------------------------------------------- Buy ----------------------------------------------------------------

function BuyPanel({ cfg, book, tier, mine, onChanged }: { cfg: MarketConfig | null; book: Book | null; tier: number | null; mine: MyMarket | null; onChanged: () => void }) {
  const { token } = useAuth();
  const toast = useToast();
  const [amount, setAmount] = useState('20');
  const [listingId, setListingId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const chosen: BookTier | null = useMemo(() => (book?.tiers ?? []).find((t) => t.discountBps === tier) ?? null, [book, tier]);
  const open = useAsync(chosen ? () => market.getOpenListings({ discountBps: chosen.discountBps, limit: 50 }) : null, [chosen?.discountBps], 15_000);
  const listings = useMemo(() => (open.data?.listings ?? []).filter((l) => !mine || l.id !== mine.listings.find((m) => m.id === l.id)?.id), [open.data, mine]);
  useEffect(() => {
    if (!listings.some((l) => l.id === listingId)) setListingId(listings[0]?.id ?? '');
  }, [listings, listingId]);
  const listing = listings.find((l) => l.id === listingId) ?? null;

  const amt = Number(amount);
  const feeBps = cfg?.feeBps ?? 250;
  const q = chosen && Number.isFinite(amt) && amt > 0 ? quoteLocal(amt, chosen.discountBps, feeBps, cfg?.feeToHoldersBps) : null;
  const minFill = cfg?.minFillUsd ?? 0.01;
  const prepaid = mine?.prepaid.usd ?? null;
  const tooSmall = q !== null && amt < minFill && amt !== listing?.remainingUsd;
  const tooBig = q !== null && listing !== null && amt > listing.remainingUsd + 1e-9;
  const cantAfford = q !== null && prepaid !== null && q.buyerPaysUsd > prepaid + 1e-9;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!token || !listing || !q || tooSmall || tooBig || cantAfford) return;
    setBusy(true);
    try {
      const r = await market.fill(token, { listingId: listing.id, amountUsd: amt });
      toast.ok(`${fmtUsd(r.creditsUsd)} of credit landed in your balance for ${fmtUsd(r.paidUsd)}.`);
      onChanged();
      void open.reload();
    } catch (err) {
      toast.error(errorMessage(err));
      onChanged();
      void open.reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="panel" onSubmit={submit}>
      <div className="row between">
        <span className="eyebrow">Buy credits</span>
        <span className="small muted num">{token ? (prepaid === null ? <Skeleton w="8ch" /> : `${fmtUsd(prepaid)} prepaid`) : ''}</span>
      </div>
      {!token ? <Notice>Connect a wallet to buy. Credits land in the wallet you sign in with.</Notice> : null}
      {token && prepaid === 0 ? <Notice>{BETA_TOPUP}</Notice> : null}
      {!chosen ? (
        <span className="small muted">Pick a discount on the liquidity book to see the price.</span>
      ) : (
        <>
          <div className="field">
            <label htmlFor="buy-listing">Listing at {fmtDiscount(chosen.discountBps)} off</label>
            {open.loading && !open.data ? (
              <Skeleton w="100%" h="38px" />
            ) : listings.length === 0 ? (
              <span className="small muted">Nothing left at this discount that is not yours. Pick another row.</span>
            ) : (
              <select id="buy-listing" className="input" value={listingId} onChange={(e) => setListingId(e.target.value)}>
                {listings.map((l) => (
                  <option key={l.id} value={l.id}>
                    {fmtUsd(l.remainingUsd)} left · listed {fmtAgo(l.created_at)}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="field">
            <label htmlFor="buy-amount">Credit you want, USD face value</label>
            <div className="market-amount">
              <input id="buy-amount" className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="20" disabled={!listing} />
              <button type="button" className="btn ghost sm" onClick={() => listing && setAmount(String(listing.remainingUsd))} disabled={!listing}>
                All of it
              </button>
            </div>
          </div>
          {q && listing ? (
            <div className="stack sm">
              <Line label="Face value" value={fmtUsd(q.creditsUsd)} />
              <Line label={`Price at ${fmtDiscount(chosen.discountBps)} off`} value={`${fmtUsd(q.pricePerUsd, 2)} per $1`} />
              <Line label={`Fee ${feeBps / 100}% (paid by the seller)`} value={fmtUsd(q.feeUsd)} />
              <Line label="You pay, from prepaid" value={fmtUsd(q.buyerPaysUsd)} strong />
              <Line label="You receive, credits" value={fmtUsd(q.creditsUsd)} strong />
              {tooSmall ? <Notice kind="bad">Minimum buy is {fmtUsd(minFill)} unless you take the whole remainder.</Notice> : null}
              {tooBig ? <Notice kind="bad">Only {fmtUsd(listing.remainingUsd)} is left on this listing.</Notice> : null}
              {cantAfford && prepaid !== 0 ? <Notice kind="bad">That is more than your prepaid balance ({fmtUsd(prepaid ?? 0)}).</Notice> : null}
            </div>
          ) : null}
          <div className="row">
            <button type="submit" className="btn primary" disabled={!token || !listing || !q || tooSmall || tooBig || cantAfford || busy}>
              {busy ? <Spinner /> : 'Buy credits'}
            </button>
          </div>
        </>
      )}
      <p className="hint">Credits arrive the moment the buy goes through and spend like any other credit, on any model.</p>
    </form>
  );
}

// ---------------------------------------------------------------- Sell ----------------------------------------------------------------

function SellPanel({ cfg, onChanged }: { cfg: MarketConfig | null; onChanged: () => void }) {
  const { token } = useAuth();
  const toast = useToast();
  const me = useMe(20_000);
  const [amount, setAmount] = useState('');
  const [discount, setDiscount] = useState(30);
  const [busy, setBusy] = useState(false);

  const spendable = me.data?.balance.usd ?? null;
  const amt = Number(amount);
  const feeBps = cfg?.feeBps ?? 250;
  const maxDisc = (cfg?.maxDiscountBps ?? 7000) / 100;
  const minList = cfg?.minListingUsd ?? 1;
  const ttlDays = Math.round((cfg?.listingTtlHours ?? 168) / 24);
  const q = Number.isFinite(amt) && amt > 0 ? quoteLocal(amt, discount * 100, feeBps, cfg?.feeToHoldersBps) : null;
  const tooSmall = q !== null && amt < minList;
  const tooMuch = q !== null && spendable !== null && amt > spendable + 1e-9;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!token || !q || tooSmall || tooMuch) return;
    setBusy(true);
    try {
      const l = await market.createListing(token, { amountUsd: amt, discountBps: discount * 100 });
      toast.ok(`Listed ${fmtUsd(l.amountUsd)} at ${fmtDiscount(l.discountBps)} off. You receive ${fmtUsd(l.ifFullySold.youReceiveUsd)} when it all sells.`);
      setAmount('');
      void me.reload();
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="panel" onSubmit={submit}>
      <div className="row between">
        <span className="eyebrow">Sell credits</span>
        <span className="small muted num">{token ? spendable === null ? <Skeleton w="8ch" /> : `${fmtUsd(spendable, 2)} spendable` : ''}</span>
      </div>
      {!token ? <Notice>Connect a wallet to sell credits you will not use.</Notice> : null}
      <div className="field">
        <label htmlFor="sell-amount">Credit to sell, USD face value</label>
        <div className="market-amount">
          <input id="sell-amount" className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={`at least ${minList}`} />
          <button type="button" className="btn ghost sm" onClick={() => spendable !== null && setAmount((Math.floor(spendable * 100) / 100).toString())} disabled={spendable === null}>
            All
          </button>
        </div>
      </div>
      <div className="field">
        <label htmlFor="sell-discount">
          Discount: <b className="num">{discount}% off</b>
        </label>
        <input id="sell-discount" type="range" min={0} max={maxDisc} step={1} value={discount} onChange={(e) => setDiscount(Number(e.target.value))} style={{ width: '100%', accentColor: 'var(--accent)' }} />
        <div className="row between small muted">
          <span>0% · sells slowly</span>
          <span>{maxDisc}% · sells fast</span>
        </div>
      </div>
      {q ? (
        <div className="stack sm">
          <Line label="Face value listed" value={fmtUsd(q.creditsUsd)} />
          <Line label="Buyer pays" value={fmtUsd(q.buyerPaysUsd)} />
          <Line label={`Fee ${feeBps / 100}%`} value={`− ${fmtUsd(q.feeUsd)}`} />
          <Line label="You receive, prepaid USD" value={fmtUsd(q.sellerReceivesUsd)} strong />
          {tooSmall ? <Notice kind="bad">Listings start at {fmtUsd(minList, 0)}.</Notice> : null}
          {tooMuch ? <Notice kind="bad">That is more than your spendable balance.</Notice> : null}
        </div>
      ) : (
        <span className="small muted">Enter an amount to see what you would receive.</span>
      )}
      <div className="row">
        <button type="submit" className="btn primary" disabled={!token || !q || tooSmall || tooMuch || busy}>
          {busy ? <Spinner /> : 'List for sale'}
        </button>
      </div>
      <p className="hint">
        Listed credit is held in escrow until it sells, you cancel, or the listing expires after {ttlDays} days. Proceeds land in your prepaid balance and can be withdrawn below.
      </p>
    </form>
  );
}

// ---------------------------------------------------------------- Mine ----------------------------------------------------------------

function MyListings({ mine, loading, onChanged }: { mine: MyMarket | null; loading: boolean; onChanged: () => void }) {
  const { token } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const listings = mine?.listings ?? [];
  const cancel = async (l: Listing) => {
    if (!token) return;
    setBusy(l.id);
    try {
      await market.cancelListing(token, l.id);
      toast.info(`Cancelled. ${fmtUsd(l.remainingUsd)} is spendable again.`);
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="stack sm">
      <div className="row between">
        <span className="eyebrow">Your listings</span>
        <span className="small muted">{listings.filter((l) => l.status === 'open').length} open</span>
      </div>
      {loading && !mine ? (
        <Skeleton w="100%" h="72px" />
      ) : listings.length === 0 ? (
        <Empty title="No listings yet">List part of your balance above; it stays yours until someone buys it.</Empty>
      ) : (
        <div className="tblwrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Listed</th>
                <th>Status</th>
                <th className="num">Discount</th>
                <th className="num">Listed</th>
                <th className="num">Sold</th>
                <th className="num">Left</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {listings.map((l) => (
                <tr key={l.id}>
                  <td className="date">{fmtDate(l.created_at)}</td>
                  <td>
                    {statusWord[l.status] ?? l.status}
                    {l.status === 'open' ? <span className="small muted"> · until {fmtDate(l.expires_at)}</span> : null}
                  </td>
                  <td className="num">{fmtDiscount(l.discountBps)}</td>
                  <td className="num">{fmtUsd(l.amountUsd)}</td>
                  <td className={`num ${l.soldUsd > 0 ? 'pos' : ''}`}>{fmtUsd(l.soldUsd)}</td>
                  <td className="num">{fmtUsd(l.remainingUsd)}</td>
                  <td className="actions">
                    {l.status === 'open' ? (
                      <button type="button" className="btn ghost sm" onClick={() => cancel(l)} disabled={busy !== null}>
                        {busy === l.id ? <Spinner /> : 'Cancel'}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function MyFills({ mine, loading }: { mine: MyMarket | null; loading: boolean }) {
  const rows = useMemo(() => {
    if (!mine) return [] as Array<Fill & { side: 'bought' | 'sold' }>;
    return [...mine.fills.asBuyer.map((f) => ({ ...f, side: 'bought' as const })), ...mine.fills.asSeller.map((f) => ({ ...f, side: 'sold' as const }))].sort((a, b) => b.created_at - a.created_at).slice(0, 20);
  }, [mine]);
  return (
    <div className="stack sm">
      <span className="eyebrow">Your fills</span>
      {loading && !mine ? (
        <Skeleton w="100%" h="72px" />
      ) : rows.length === 0 ? (
        <Empty title="No fills yet">Every buy and every sale of yours shows up here with the exact fee.</Empty>
      ) : (
        <div className="tblwrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>When</th>
                <th>Side</th>
                <th>Counterparty</th>
                <th className="num">Credits</th>
                <th className="num">Discount</th>
                <th className="num">Price</th>
                <th className="num">Fee</th>
                <th className="num">Net to you</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((f) => (
                <tr key={`${f.side}-${f.id}`}>
                  <td className="date">{fmtAgo(f.created_at)}</td>
                  <td>{f.side === 'bought' ? 'Bought' : 'Sold'}</td>
                  <td className="small muted">{shortAddr(f.side === 'bought' ? f.seller : f.buyer, 6, 4)}</td>
                  <td className="num">{fmtUsd(f.creditsUsd)}</td>
                  <td className="num">{fmtDiscount(f.discountBps)}</td>
                  <td className="num">{fmtUsd(f.paidUsd)}</td>
                  <td className="num">{f.side === 'sold' ? fmtUsd(f.feeUsd) : '—'}</td>
                  <td className={`num ${f.side === 'sold' ? 'pos' : ''}`}>{f.side === 'sold' ? `+${fmtUsd(f.sellerReceivedUsd)}` : `−${fmtUsd(f.paidUsd)}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PrepaidPanel({ mine, loading, onChanged }: { mine: MyMarket | null; loading: boolean; onChanged: () => void }) {
  const { token } = useAuth();
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const bal = mine?.prepaid.usd ?? null;
  const amt = Number(amount);
  const ok = Number.isFinite(amt) && amt > 0 && bal !== null && amt <= bal + 1e-9;
  const pending = (mine?.withdrawals ?? []).filter((w) => w.status === 'pending');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!token || !ok) return;
    setBusy(true);
    try {
      const w = await market.withdraw(token, amt);
      toast.ok(`Withdrawal of ${fmtUsd(w.amountUsd)} requested. The team pays it out and marks it done.`);
      setAmount('');
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panels">
      <form className="panel" onSubmit={submit}>
        <span className="eyebrow">Prepaid balance</span>
        <span className="display d-m num">{loading && !mine ? <Skeleton w="6ch" h="1em" /> : fmtUsd(bal)}</span>
        <span className="small" style={{ color: 'var(--fg-2)' }}>
          Buys are paid from here; sales are paid into here. {BETA_TOPUP}
        </span>
        <div className="field">
          <label htmlFor="wd-amount">Withdraw, USD</label>
          <div className="market-amount">
            <input id="wd-amount" className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" disabled={bal === null || bal === 0} />
            <button type="button" className="btn ghost sm" onClick={() => bal !== null && setAmount((Math.floor(bal * 100) / 100).toString())} disabled={!bal}>
              All
            </button>
          </div>
        </div>
        <div className="row">
          <button type="submit" className="btn secondary" disabled={!token || !ok || busy}>
            {busy ? <Spinner /> : 'Request withdrawal'}
          </button>
          {pending.length > 0 ? <span className="small muted num">{fmtUsd(pending.reduce((a, w) => a + w.amountUsd, 0))} pending</span> : null}
        </div>
        <p className="hint">The amount leaves your balance at once. The team sends USDC to this wallet and marks the request paid; it shows on the right.</p>
      </form>

      <div className="panel">
        <span className="eyebrow">Prepaid activity</span>
        {loading && !mine ? (
          <Skeleton w="100%" h="72px" />
        ) : (mine?.withdrawals.length ?? 0) + (mine?.prepaid.ledger.length ?? 0) === 0 ? (
          <p className="hint">Top-ups, buys, sales and withdrawals show up here.</p>
        ) : (
          <div className="tblwrap">
            <table className="tbl">
              <tbody>
                {(mine?.withdrawals ?? []).slice(0, 4).map((w) => (
                  <tr key={`w${w.id}`}>
                    <td className="date">{fmtDate(w.created_at)}</td>
                    <td>
                      Withdrawal · {statusWord[w.status]}
                      {w.txRef ? <span className="small muted"> · {shortAddr(w.txRef, 6, 6)}</span> : null}
                    </td>
                    <td className="num">−{fmtUsd(w.amountUsd)}</td>
                  </tr>
                ))}
                {(mine?.prepaid.ledger ?? [])
                  .filter((p) => p.kind !== 'withdrawal')
                  .slice(0, 6)
                  .map((p) => (
                    <tr key={`p${p.id}`}>
                      <td className="date">{fmtDate(p.created_at)}</td>
                      <td>{prepaidWord[p.kind] ?? p.kind}</td>
                      <td className={`num ${p.deltaUsd > 0 ? 'pos' : ''}`}>
                        {p.deltaUsd > 0 ? '+' : '−'}
                        {fmtUsd(Math.abs(p.deltaUsd))}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Page ----------------------------------------------------------------

export function Market() {
  const { token } = useAuth();
  const cfgQ = useAsync(market.getMarketConfig, []);
  const book = useAsync(market.getBook, [], 15_000);
  const stats = useAsync(market.getMarketStats, [], 30_000);
  const mine = useSessionAsync(market.myMarket, [], 20_000);
  const [tier, setTier] = useState<number | null>(null);
  const cfg = cfgQ.data ?? book.data?.config ?? null;
  const s = stats.data;
  const skel = stats.loading && !s;
  const tiers = book.data?.tiers;
  useEffect(() => {
    if (tiers && tiers.length > 0 && !tiers.some((t) => t.discountBps === tier)) setTier(tiers[0].discountBps);
  }, [tiers, tier]);

  const changed = () => {
    void book.reload();
    void stats.reload();
    void mine.reload();
  };
  const mineData = token ? mine.data : null;

  return (
    <>
      <div className="row between">
        <span className="display d-s">Credit market</span>
        <span className="small muted">{cfg ? `${cfg.feePercent}% fee, paid by the seller · half of it back to holders` : ''}</span>
      </div>
      {cfgQ.error && !cfg ? <Notice kind="bad">Could not reach the market: {cfgQ.error}</Notice> : null}

      <div className="tiles dense">
        <Tile label="Best discount" loading={skel} value={s?.bestDiscountBps != null ? `${fmtDiscount(s.bestDiscountBps)} off` : '—'} delta={s ? `${fmtUsd(s.openDepthUsd, 0)} on the book · ${s.openListings} listings` : ' '} deltaKind={s?.bestDiscountBps ? 'up' : ''} />
        <Tile label="Traded, 24h" loading={skel} value={fmtUsd(s?.last24h.filledUsd ?? null, 0)} delta={s ? `${s.last24h.fills} fills · buyers paid ${fmtUsd(s.last24h.paidUsd, 0)}` : ' '} />
        <Tile label="Traded, all time" loading={skel} value={fmtUsd(s?.allTime.filledUsd ?? null, 0)} delta={s ? `${s.allTime.fills} fills${s.avgDiscountBps != null ? ` · ${fmtDiscount(s.avgDiscountBps)} average discount` : ''}` : ' '} />
        <Tile label="Fees to holders" loading={skel} value={fmtUsd(s?.allTime.feesToHoldersUsd ?? null)} delta={s ? `of ${fmtUsd(s.allTime.feesUsd)} in fees, all time` : ' '} deltaKind={s && s.allTime.feesToHoldersUsd > 0 ? 'up' : ''} />
      </div>

      <p className="small" style={{ color: 'var(--fg-2)', maxWidth: '72ch' }}>
        Holders sell credit they will not use; anyone buys it below face value and spends it on any model. Credits move at face value, buyers pay from a prepaid USD balance, sellers are paid
        into theirs, and Mesh keeps {cfg ? cfg.feePercent : 2.5}% of the price: half goes into the next hourly distribution, half to the treasury.
      </p>

      <LiquidityBook book={book.data} tier={tier} onPick={setTier} />

      <div className="panels">
        <BuyPanel cfg={cfg} book={book.data} tier={tier} mine={mineData} onChanged={changed} />
        <SellPanel cfg={cfg} onChanged={changed} />
      </div>

      {token ? (
        <>
          {mine.error && !mine.data ? <Notice kind="bad">Could not load your market activity: {mine.error}</Notice> : null}
          <MyListings mine={mineData} loading={mine.loading} onChanged={changed} />
          <MyFills mine={mineData} loading={mine.loading} />
          <PrepaidPanel mine={mineData} loading={mine.loading} onChanged={changed} />
        </>
      ) : (
        <Notice>Sign in to see your listings, fills and prepaid balance.</Notice>
      )}

      <p className="hint" style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
        How to sell, how to buy, the fee split and a worked example: <Link to="/docs#market">Docs → Marketplace</Link>; the ledger entries behind every trade are in docs/MARKETPLACE.md in the repo. Credits are a licence to
        use the gateway, not money: they only move between wallets here, and the fee is not refunded. Escrowed credit cannot be spent until the listing closes; a listing expires after{' '}
        {Math.round((cfg?.listingTtlHours ?? 168) / 24)} days and the remainder returns to the seller.
      </p>
    </>
  );
}
