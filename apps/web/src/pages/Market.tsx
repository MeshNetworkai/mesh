import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Empty, Notice, Skeleton, Spinner } from '../components/ui';
import { WalletGate } from '../components/WalletGate';
import { CHAIN_LABEL, PUBLIC_API_URL, TOKENOMICS, addressExplorerUrl } from '../config';
import { useAuth } from '../lib/auth';
import { fmtAgo, fmtDate, fmtUsd, shortAddr } from '../lib/format';
import { useAsync, useCopy, useKeys, useSessionAsync } from '../lib/hooks';
import * as market from '../lib/market';
import { fmtDiscount, quoteLocal, type Book, type BookTier, type Fill, type Listing, type MarketConfig, type MyMarket } from '../lib/market';
import { errorMessage, useToast } from '../lib/toast';
import type { ApiKey } from '../lib/types';

/**
 * Credit market (docs/MARKETPLACE.md). Holders list credits they will not use at a discount; buyers pay
 * the discounted price from a prepaid USD balance and receive the credits at face value. Mesh keeps a
 * fee (config/tokenomics.json marketplace.feeBps; live value on GET /market/config): half joins the next
 * hourly holder pool, half is treasury.
 *
 * Layout: wallet strip → [balance + key card | order book card with the depth ladder and the sell/buy
 * forms] → claimable proceeds + history. Nothing renders without a wallet except the gate card.
 *
 * The balance card also sells credits directly (docs/PRICING.md §7, GET /credits/config): $1 of prepaid
 * balance buys $1 of credit from Mesh, for when nobody is selling. Starter credit cannot be listed
 * (GET /me/market `listableUsd`), and credits lapse `creditExpiryDays` after they land, listed or not.
 */

interface HistoryRow {
  key: string;
  at: number;
  kind: string;
  who: string;
  credits: number | null;
  price: number | null;
  fee: number | null;
  net: number;
  status?: string;
}

const statusWord: Record<string, string> = { open: 'Open', filled: 'Sold out', cancelled: 'Cancelled', expired: 'Expired', pending: 'Pending', paid: 'Paid' };
const BETA_TOPUP = 'During the beta the team tops up prepaid balances after a hand-sent USDG payment and pays withdrawals out by hand.';
const BASE_URL = `${PUBLIC_API_URL}/v1`;
const floor2 = (n: number) => Math.floor(n * 100) / 100;

// ---------------------------------------------------------------- Buy from Mesh at face value ----------------------------------------------------------------

/** Direct sales: $1 of prepaid balance buys $1 of credit. Renders nothing when the gateway has them off. */
function DirectBuy({ prepaid, onChanged }: { prepaid: number | null; onChanged: () => void }) {
  const { token } = useAuth();
  const toast = useToast();
  const cfg = useAsync(() => market.getCreditsConfig(), []);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const c = cfg.data;
  if (!c || !c.enabled) return null;
  const amt = Number(amount);
  const valid = Number.isFinite(amt) && amt > 0;
  const tooSmall = valid && amt < c.minUsd;
  const tooBig = valid && amt > c.maxUsd;
  const cantAfford = valid && prepaid !== null && amt > prepaid + 1e-9;
  const max = prepaid !== null ? Math.min(floor2(prepaid), c.maxUsd) : 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!token || !valid || tooSmall || tooBig || cantAfford) return;
    setBusy(true);
    try {
      const p = await market.buyCredits(token, amt);
      toast.ok(`${fmtUsd(p.creditsUsd)} of credit bought at face value.${p.expires_at ? ` It lasts until ${fmtDate(p.expires_at)}.` : ''}`);
      setAmount('');
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <hr className="mkt-div" />
      <form className="stack sm" onSubmit={submit} aria-label="Buy credits from Mesh">
        <div className="row between">
          <span className="eyebrow">Buy from {TOKENOMICS.name} at face value</span>
          <span className="small muted num">$1 buys $1</span>
        </div>
        <div className="market-amount">
          <input id="direct-amount" className="input sm" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={`from ${fmtUsd(c.minUsd, 0)}`} aria-label="Credits to buy from Mesh, USD" />
          <button type="button" className="btn ghost sm" onClick={() => setAmount(String(max))} disabled={max < c.minUsd}>
            Max
          </button>
          <button type="submit" className="btn primary sm" disabled={!token || !valid || tooSmall || tooBig || cantAfford || busy}>
            {busy ? <Spinner /> : 'Buy'}
          </button>
        </div>
        {tooSmall ? <Notice kind="bad">Purchases start at {fmtUsd(c.minUsd, 0)}.</Notice> : null}
        {tooBig ? <Notice kind="bad">One purchase is at most {fmtUsd(c.maxUsd, 0)}.</Notice> : null}
        {cantAfford ? <Notice kind="bad">That is more than your prepaid balance ({fmtUsd(prepaid ?? 0)}). Top it up first.</Notice> : null}
        <p className="hint">
          Paid from your prepaid balance, no fee, no token needed. A listing on the book is cheaper whenever one is open.
          {c.creditExpiryDays ? ` Bought credit lasts ${c.creditExpiryDays} days and is not refundable.` : ' Bought credit is not refundable.'}
        </p>
      </form>
    </>
  );
}

// ---------------------------------------------------------------- Wallet strip ----------------------------------------------------------------

function WalletStrip({ wallet, chain }: { wallet: string; chain: string }) {
  const [copied, copy] = useCopy();
  const explorer = addressExplorerUrl(wallet, chain);
  return (
    <div className="mkt-strip">
      <div className="stack" style={{ gap: 2 }}>
        <span className="display d-s">Credit market</span>
        <span className="small muted">Credits trade below face value and spend at face value, on any model.</span>
      </div>
      <div className="row mkt-wallet" aria-label="Connected wallet">
        <span className="pill mono" title={wallet}>
          <span className="dot dot-live" aria-hidden="true" />
          {shortAddr(wallet, 6, 4)}
        </span>
        <button type="button" className="btn ghost sm" onClick={() => void copy(wallet)} aria-label="Copy wallet address">
          {copied ? 'Copied' : 'Copy'}
        </button>
        {explorer ? (
          <a className="btn ghost sm" href={explorer} target="_blank" rel="noreferrer">
            Explorer
          </a>
        ) : null}
        <span className="pill">{CHAIN_LABEL}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Left: balance, prepaid, key ----------------------------------------------------------------

function KeyBlock({ keys, loading, creditsUsd }: { keys: ApiKey[] | null; loading: boolean; creditsUsd: number | null }) {
  const [copied, copy] = useCopy();
  const newest = useMemo(() => (keys ?? []).filter((k) => !k.revoked).sort((a, b) => b.created_at - a.created_at)[0] ?? null, [keys]);
  const used = newest?.spentUsd ?? 0;
  const available = newest?.spendLimitUsd !== null && newest?.spendLimitUsd !== undefined ? Math.max(0, Math.min(newest.spendLimitUsd - used, creditsUsd ?? Infinity)) : (creditsUsd ?? 0);
  const share = used + available > 0 ? used / (used + available) : 0;
  return (
    <div className="stack sm">
      <div className="row between">
        <span className="eyebrow">Your key</span>
        {newest ? <span className="small muted">{newest.name ?? 'untitled'}</span> : null}
      </div>
      {loading && !keys ? (
        <Skeleton w="100%" h="44px" />
      ) : newest ? (
        <>
          <div className="row between small">
            <span style={{ color: 'var(--fg-2)' }}>
              Used <b className="num">{fmtUsd(used, 2)}</b>
            </span>
            <span style={{ color: 'var(--fg-2)' }}>
              Available <b className="num">{creditsUsd === null ? '…' : fmtUsd(available, 2)}</b>
            </span>
          </div>
          <span className="meter mkt-meter" aria-hidden="true">
            <i style={{ width: `${Math.round(share * 100)}%` }} />
          </span>
        </>
      ) : (
        <p className="small muted">No key yet. One is created when you first chat, or make one now.</p>
      )}
      <div className="field">
        <span className="lbl">Base URL</span>
        <div className="keybox">
          <input className="input sm mono" value={BASE_URL} readOnly onFocus={(e) => e.currentTarget.select()} aria-label="API base URL" />
          <button type="button" className="btn secondary sm" onClick={() => void copy(BASE_URL)}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
      <div className="row">
        <Link className="btn ghost sm" to="/app/keys">
          {newest ? 'Manage keys' : 'Create a key'}
        </Link>
      </div>
    </div>
  );
}

function BalanceCard({ mine, loading, onBuy, onChanged }: { mine: MyMarket | null; loading: boolean; onBuy: () => void; onChanged: () => void }) {
  const { token } = useAuth();
  const toast = useToast();
  const keys = useKeys();
  const credits = mine?.creditBalanceUsd ?? null;
  const prepaid = mine?.prepaid.usd ?? null;
  const starterLeft = mine?.nonTransferableUsd ?? 0;
  const expiryDays = mine?.config.creditExpiryDays ?? null;
  const [wdOpen, setWdOpen] = useState(false);
  const [wd, setWd] = useState('');
  const [busy, setBusy] = useState(false);
  const deposits = mine?.config.deposits;
  const [depOpen, setDepOpen] = useState(false);
  const [txHash, setTxHash] = useState('');
  const [depBusy, setDepBusy] = useState(false);
  const [copiedAddr, copyAddr] = useCopy();
  const hashOk = /^0x[0-9a-fA-F]{64}$/.test(txHash.trim());

  const submitDeposit = async (e: FormEvent) => {
    e.preventDefault();
    if (!token || !hashOk) return;
    setDepBusy(true);
    try {
      const r = await market.deposit(token, txHash.trim());
      toast.ok(`${fmtUsd(r.creditedUsd)} ${r.token} credited to your prepaid balance.`);
      setTxHash('');
      setDepOpen(false);
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setDepBusy(false);
    }
  };
  const wdAmt = Number(wd);
  const wdOk = Number.isFinite(wdAmt) && wdAmt > 0 && prepaid !== null && wdAmt <= prepaid + 1e-9;
  const pending = (mine?.withdrawals ?? []).filter((w) => w.status === 'pending');

  const withdraw = async (e: FormEvent) => {
    e.preventDefault();
    if (!token || !wdOk) return;
    setBusy(true);
    try {
      const w = await market.withdraw(token, wdAmt);
      toast.ok(`Withdrawal of ${fmtUsd(w.amountUsd)} requested. The team pays it out and marks it done.`);
      setWd('');
      setWdOpen(false);
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel mkt-card" aria-label="Your balance">
      <span className="eyebrow">Available credit balance</span>
      <div className="row between" style={{ alignItems: 'flex-end' }}>
        <span className="mkt-big num" data-testid="credit-balance">
          {loading && !mine ? <Skeleton w="5ch" h="0.9em" /> : fmtUsd(credits, 2)}
        </span>
        <button type="button" className="btn primary" onClick={onBuy}>
          Buy
        </button>
      </div>
      <p className="small" style={{ color: 'var(--fg-2)' }}>
        Yours to spend through a key{starterLeft > 0 ? '' : ', list on the book, or keep'}.
        {starterLeft > 0 ? (
          <>
            {' '}
            <span data-testid="starter-note">
              {fmtUsd(starterLeft)} of it is starter credit: it spends first and cannot be listed. {fmtUsd(mine?.listableUsd ?? 0)} can be listed.
            </span>
          </>
        ) : null}
        {expiryDays ? (
          <>
            {' '}
            Credits last {expiryDays} days from the day they land. <Link to="/docs#expiry">How expiry works</Link>
          </>
        ) : null}
      </p>

      <hr className="mkt-div" />

      <div className="row between">
        <span className="eyebrow">Your prepaid balance</span>
        {pending.length > 0 ? <span className="small muted num">{fmtUsd(pending.reduce((a, w) => a + w.amountUsd, 0))} pending</span> : null}
      </div>
      <div className="row between">
        <span className="display d-s num">{loading && !mine ? <Skeleton w="5ch" h="0.9em" /> : fmtUsd(prepaid, 2)}</span>
        <span className="row" style={{ gap: 8 }}>
          {deposits?.enabled ? (
            <button type="button" className="btn primary sm" onClick={() => { setDepOpen((v) => !v); setWdOpen(false); }} aria-expanded={depOpen}>
              Top up
            </button>
          ) : null}
          <button type="button" className="btn secondary sm" onClick={() => { setWdOpen((v) => !v); setDepOpen(false); }} disabled={!prepaid} aria-expanded={wdOpen}>
            Withdraw
          </button>
        </span>
      </div>
      {depOpen && deposits?.enabled && deposits.receiver ? (
        <form className="stack sm deposit" onSubmit={submitDeposit} aria-label="Top up prepaid balance">
          <p className="hint" style={{ margin: 0 }}>
            Send <b>{deposits.tokens.map((t) => t.symbol).join(' or ')}</b> on <b>{deposits.chainName}</b> from the wallet you are signed in with to this address (minimum {fmtUsd(deposits.minUsd, 0)}):
          </p>
          <div className="market-amount">
            <code className="mono input sm deposit-addr" title={deposits.receiver}>
              {deposits.receiver}
            </code>
            <button type="button" className="btn secondary sm" onClick={() => void copyAddr(deposits.receiver!)}>
              {copiedAddr ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="hint" style={{ margin: 0 }}>Then paste the transaction hash. It is checked on chain and credited after {deposits.confirmations} confirmations.</p>
          <div className="market-amount">
            <input className="input sm mono" value={txHash} onChange={(e) => setTxHash(e.target.value)} placeholder="0x… transaction hash" aria-label="Transaction hash" spellCheck={false} autoFocus />
            <button type="submit" className="btn primary sm" disabled={!hashOk || depBusy}>
              {depBusy ? <Spinner /> : 'Credit'}
            </button>
          </div>
          {deposits.explorer ? (
            <p className="hint" style={{ margin: 0 }}>
              Find the hash in your wallet's activity or on the <a href={`${deposits.explorer}/address/${deposits.receiver}`} target="_blank" rel="noreferrer">explorer</a>. Sent from another wallet by mistake? Contact us with the hash.
            </p>
          ) : null}
        </form>
      ) : wdOpen ? (
        <form className="stack sm" onSubmit={withdraw} aria-label="Withdraw prepaid balance">
          <div className="market-amount">
            <input className="input sm" inputMode="decimal" value={wd} onChange={(e) => setWd(e.target.value)} placeholder="0.00" aria-label="Amount to withdraw, USD" autoFocus />
            <button type="button" className="btn ghost sm" onClick={() => prepaid !== null && setWd(String(floor2(prepaid)))}>
              Max
            </button>
            <button type="submit" className="btn primary sm" disabled={!wdOk || busy}>
              {busy ? <Spinner /> : 'Request'}
            </button>
          </div>
          <p className="hint">The amount leaves your balance now; the team sends USDG to this wallet and marks it paid.</p>
        </form>
      ) : (
        <p className="hint">Buys are paid from here, sales are paid into here. {deposits?.enabled ? `Top up with ${deposits.tokens.map((t) => t.symbol).join(' or ')} on ${deposits.chainName}; withdrawals are paid out by the team.` : BETA_TOPUP}</p>
      )}

      <DirectBuy prepaid={prepaid} onChanged={onChanged} />

      <hr className="mkt-div" />

      <KeyBlock keys={keys.data} loading={keys.loading} creditsUsd={credits} />
    </section>
  );
}

// ---------------------------------------------------------------- Right: order book ----------------------------------------------------------------

function DepthLadder({ book, tier, mineTiers, onPick }: { book: Book | null; tier: number | null; mineTiers: Set<number>; onPick: (bps: number) => void }) {
  const tiers = useMemo(() => [...(book?.tiers ?? [])].sort((a, b) => b.discountBps - a.discountBps), [book]);
  const deepest = Math.max(1e-9, ...tiers.map((t) => t.availableUsd));
  if (!book) {
    return (
      <div className="ladder" aria-busy="true">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} w="100%" h="42px" />
        ))}
      </div>
    );
  }
  if (tiers.length === 0) return <Empty title="Nothing on the book">Sellers list credits at a discount; the first listing shows up here within seconds.</Empty>;
  return (
    <div className="ladder" role="listbox" aria-label="Order book by discount">
      <div className="ladder-head small muted">
        <span>Discount</span>
        <span className="num">Available</span>
      </div>
      {tiers.map((t, i) => {
        const on = tier === t.discountBps;
        return (
          <button
            type="button"
            key={t.discountBps}
            role="option"
            aria-selected={on}
            className={`ladder-row${on ? ' on' : ''}${i === 0 ? ' best' : ''}`}
            style={{ ['--w' as string]: `${Math.max(2, Math.round((t.availableUsd / deepest) * 100))}%` }}
            onClick={() => onPick(t.discountBps)}
            title={`${t.listings} listing${t.listings === 1 ? '' : 's'} · ${fmtUsd(t.pricePerUsd, 2)} per $1 of credit`}
          >
            <span className="ladder-fill" aria-hidden="true" />
            <span className="ladder-disc">
              <b className="num">{fmtDiscount(t.discountBps)} off</b>
              <span className="small muted num">{fmtUsd(t.pricePerUsd, 2)} per $1</span>
              {mineTiers.has(t.discountBps) ? <span className="ladder-mine">yours</span> : null}
            </span>
            <span className="ladder-amt num">{fmtUsd(t.availableUsd, 2)}</span>
          </button>
        );
      })}
    </div>
  );
}

function Stepper({ value, onChange, min, max, step, id }: { value: number; onChange: (n: number) => void; min: number; max: number; step: number; id: string }) {
  const clamp = (n: number) => Math.min(max, Math.max(min, Math.round(n / step) * step));
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Number(text);
    if (Number.isFinite(n)) onChange(clamp(n));
    else setText(String(value));
  };
  return (
    <div className="stepper" role="group" aria-label="Discount">
      <button type="button" className="btn ghost sm" onClick={() => onChange(clamp(value - step))} disabled={value <= min} aria-label="Lower the discount">
        −
      </button>
      <span className="stepper-val num">
        <input id={id} inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} aria-label="Discount, percent" />
        <span aria-hidden="true">%</span>
      </span>
      <button type="button" className="btn ghost sm" onClick={() => onChange(clamp(value + step))} disabled={value >= max} aria-label="Raise the discount">
        +
      </button>
    </div>
  );
}

function SellForm({ cfg, mine, onChanged }: { cfg: MarketConfig; mine: MyMarket | null; onChanged: () => void }) {
  const { token } = useAuth();
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [discount, setDiscount] = useState(30);
  const [busy, setBusy] = useState(false);
  // What may be listed: the balance less any starter credit (older gateways do not send listableUsd).
  const spendable = mine ? (mine.listableUsd ?? mine.creditBalanceUsd) : null;
  const starterLeft = mine?.nonTransferableUsd ?? 0;
  const amt = Number(amount);
  const maxDisc = cfg.maxDiscountBps / 100;
  const q = Number.isFinite(amt) && amt > 0 ? quoteLocal(amt, Math.round(discount * 100), cfg.feeBps, cfg.feeToHoldersBps) : null;
  const tooSmall = q !== null && amt < cfg.minListingUsd;
  const tooMuch = q !== null && spendable !== null && amt > spendable + 1e-9;
  const ttlDays = Math.round(cfg.listingTtlHours / 24);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!token || !q || tooSmall || tooMuch) return;
    setBusy(true);
    try {
      const l = await market.createListing(token, { amountUsd: amt, discountBps: Math.round(discount * 100) });
      toast.ok(`Listed ${fmtUsd(l.amountUsd)} at ${fmtDiscount(l.discountBps)} off. You receive ${fmtUsd(l.ifFullySold.youReceiveUsd)} when it all sells.`);
      setAmount('');
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={submit} aria-label="Sell credits">
      <div className="mkt-form-grid">
        <div className="field">
          <label htmlFor="sell-amount">Amount to list, USD</label>
          <div className="market-amount">
            <input id="sell-amount" className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={`at least ${fmtUsd(cfg.minListingUsd, 0)}`} />
            <button type="button" className="btn ghost sm" onClick={() => spendable !== null && setAmount(String(floor2(spendable)))} disabled={!spendable}>
              Max
            </button>
          </div>
        </div>
        <div className="field">
          <label htmlFor="sell-discount">Discount</label>
          <Stepper id="sell-discount" value={discount} onChange={setDiscount} min={0} max={maxDisc} step={0.5} />
        </div>
      </div>
      <p className="small num mkt-preview" data-testid="sell-preview" aria-live="polite">
        {q ? (
          <>
            Buyer pays <b>{fmtUsd(q.buyerPaysUsd)}</b> · you receive <b>{fmtUsd(q.sellerReceivesUsd)}</b> after the {cfg.feePercent}% fee
          </>
        ) : (
          <span className="muted">Enter an amount to see what a buyer pays and what you receive.</span>
        )}
      </p>
      {tooSmall ? <Notice kind="bad">Listings start at {fmtUsd(cfg.minListingUsd, 0)}.</Notice> : null}
      {tooMuch ? (
        <Notice kind="bad">
          That is more than you can list ({fmtUsd(spendable ?? 0)}).{starterLeft > 0 ? ` ${fmtUsd(starterLeft)} of your balance is starter credit, which can be spent but not sold.` : ''}
        </Notice>
      ) : null}
      <div className="row between">
        <button type="submit" className="btn primary" disabled={!token || !q || tooSmall || tooMuch || busy}>
          {busy ? <Spinner /> : 'List on the book'}
        </button>
        <span className="hint">
          Held in escrow until it sells, you cancel, or {ttlDays} days pass.{cfg.creditExpiryDays ? ` Listing does not pause the ${cfg.creditExpiryDays}-day expiry.` : ''}
        </span>
      </div>
    </form>
  );
}

function BuyForm({ cfg, book, tier, mine, onChanged }: { cfg: MarketConfig; book: Book | null; tier: number | null; mine: MyMarket | null; onChanged: () => void }) {
  const { token } = useAuth();
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const chosen: BookTier | null = useMemo(() => (book?.tiers ?? []).find((t) => t.discountBps === tier) ?? null, [book, tier]);
  const open = useAsync(chosen ? () => market.getOpenListings({ discountBps: chosen.discountBps, limit: 50 }) : null, [chosen?.discountBps], 15_000);
  const myIds = useMemo(() => new Set((mine?.listings ?? []).map((l) => l.id)), [mine]);
  // Oldest first, never my own: a buy walks these in order until the amount is filled.
  const listings = useMemo(() => (open.data?.listings ?? []).filter((l) => !myIds.has(l.id) && (!l.seller || l.seller !== mine?.wallet)).sort((a, b) => a.created_at - b.created_at), [open.data, myIds, mine?.wallet]);
  const available = listings.reduce((a, l) => a + l.remainingUsd, 0);
  const prepaid = mine?.prepaid.usd ?? null;
  const amt = Number(amount);
  const q = chosen && Number.isFinite(amt) && amt > 0 ? quoteLocal(amt, chosen.discountBps, cfg.feeBps, cfg.feeToHoldersBps) : null;
  const tooSmall = q !== null && amt < cfg.minFillUsd && Math.abs(amt - available) > 1e-9;
  const tooBig = q !== null && amt > available + 1e-9;
  const cantAfford = q !== null && prepaid !== null && q.buyerPaysUsd > prepaid + 1e-9;
  const maxFace = chosen ? Math.min(available, prepaid !== null ? prepaid / chosen.pricePerUsd : available) : 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!token || !q || !chosen || tooSmall || tooBig || cantAfford) return;
    setBusy(true);
    let left = amt;
    let got = 0;
    let paid = 0;
    try {
      for (const l of listings) {
        if (left <= 1e-9) break;
        const take = Math.min(left, l.remainingUsd);
        const r = await market.fill(token, { listingId: l.id, amountUsd: Number(take.toFixed(6)) });
        got += r.creditsUsd;
        paid += r.paidUsd;
        left -= take;
      }
      toast.ok(`${fmtUsd(got)} of credit landed in your balance for ${fmtUsd(paid)}.`);
      setAmount('');
    } catch (err) {
      toast.error(got > 0 ? `${fmtUsd(got)} bought, then: ${errorMessage(err)}` : errorMessage(err));
    } finally {
      setBusy(false);
      onChanged();
      void open.reload();
    }
  };

  if (!chosen) return <p className="small muted">Pick a row on the book to buy at that discount.</p>;
  return (
    <form className="stack" onSubmit={submit} aria-label="Buy credits">
      <div className="mkt-form-grid">
        <div className="field">
          <span className="lbl">Tier</span>
          <div className="mkt-tier num">
            <b>{fmtDiscount(chosen.discountBps)} off</b>
            <span className="small muted">
              {fmtUsd(chosen.pricePerUsd, 2)} per $1 · {open.loading && !open.data ? '…' : `${fmtUsd(available, 2)} available`}
            </span>
          </div>
        </div>
        <div className="field">
          <label htmlFor="buy-amount">Credits to buy, USD</label>
          <div className="market-amount">
            <input id="buy-amount" className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="20" />
            <button type="button" className="btn ghost sm" onClick={() => setAmount(String(floor2(maxFace)))} disabled={maxFace <= 0}>
              Max
            </button>
          </div>
        </div>
      </div>
      <p className="small num mkt-preview" data-testid="buy-preview" aria-live="polite">
        {q ? (
          <>
            You pay <b>{fmtUsd(q.buyerPaysUsd)}</b> from prepaid · <b>{fmtUsd(q.creditsUsd)}</b> of credit lands in your balance
          </>
        ) : (
          <span className="muted">
            Enter an amount. Credits arrive the moment the buy goes through{cfg.creditExpiryDays ? ` and last ${cfg.creditExpiryDays} days from then` : ''}.
          </span>
        )}
      </p>
      {tooSmall ? <Notice kind="bad">Minimum buy is {fmtUsd(cfg.minFillUsd)} unless you take everything at this tier.</Notice> : null}
      {tooBig ? <Notice kind="bad">Only {fmtUsd(available)} is on the book at this discount from other wallets.</Notice> : null}
      {cantAfford ? <Notice kind="bad">That is more than your prepaid balance ({fmtUsd(prepaid ?? 0)}). {prepaid === 0 ? BETA_TOPUP : ''}</Notice> : null}
      <div className="row between">
        <button type="submit" className="btn primary" disabled={!token || !q || tooSmall || tooBig || cantAfford || busy || listings.length === 0}>
          {busy ? <Spinner /> : 'Buy'}
        </button>
        <span className="hint num">Prepaid {prepaid === null ? '…' : fmtUsd(prepaid)}</span>
      </div>
    </form>
  );
}

function MyOpenListings({ mine, onChanged }: { mine: MyMarket; onChanged: () => void }) {
  const { token } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const open = mine.listings.filter((l) => l.status === 'open');
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
  if (open.length === 0) return <p className="small muted mkt-yours">Nothing listed from this wallet.</p>;
  return (
    <div className="mkt-yours" aria-label="Your listings">
      <span className="small muted">
        Your listings · {open.length} open · <span className="num">{fmtUsd(open.reduce((a, l) => a + l.remainingUsd, 0))}</span> left
      </span>
      <ul className="mkt-yours-list">
        {open.map((l) => (
          <li key={l.id} className="num">
            <span>
              <b>{fmtDiscount(l.discountBps)} off</b> · {fmtUsd(l.remainingUsd)} of {fmtUsd(l.amountUsd)} left · until {fmtDate(l.expires_at)}
            </span>
            <button type="button" className="btn ghost sm" onClick={() => cancel(l)} disabled={busy !== null}>
              {busy === l.id ? <Spinner /> : 'Cancel'}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function OrderBookCard({ cfg, book, tier, mine, side, setSide, onPick, onChanged }: { cfg: MarketConfig | null; book: Book | null; tier: number | null; mine: MyMarket | null; side: 'sell' | 'buy'; setSide: (s: 'sell' | 'buy') => void; onPick: (bps: number) => void; onChanged: () => void }) {
  const mineTiers = useMemo(() => new Set((mine?.listings ?? []).filter((l) => l.status === 'open').map((l) => l.discountBps)), [mine]);
  return (
    <section className="panel mkt-card mkt-book" aria-label="Order book">
      <div className="row between">
        <span className="eyebrow">Order book</span>
        <span className="small num" style={{ color: 'var(--fg-2)' }} data-testid="book-total">
          {book ? (
            <>
              <b>{fmtUsd(book.totalAvailableUsd, 0)}</b> credits available
            </>
          ) : (
            <Skeleton w="12ch" />
          )}
        </span>
      </div>
      {mine ? <MyOpenListings mine={mine} onChanged={onChanged} /> : <Skeleton w="20ch" />}
      <DepthLadder book={book} tier={tier} mineTiers={mineTiers} onPick={onPick} />

      <div className="seg mkt-seg" role="tablist" aria-label="Side">
        <button type="button" role="tab" aria-selected={side === 'sell'} className={side === 'sell' ? 'on' : ''} onClick={() => setSide('sell')}>
          Sell credits
        </button>
        <button type="button" role="tab" aria-selected={side === 'buy'} className={side === 'buy' ? 'on' : ''} onClick={() => setSide('buy')}>
          Buy credits
        </button>
      </div>
      {!cfg ? <Skeleton w="100%" h="120px" /> : side === 'sell' ? <SellForm cfg={cfg} mine={mine} onChanged={onChanged} /> : <BuyForm cfg={cfg} book={book} tier={tier} mine={mine} onChanged={onChanged} />}
    </section>
  );
}

// ---------------------------------------------------------------- Bottom: proceeds + history ----------------------------------------------------------------

function ProceedsCard({ mine, loading, onChanged }: { mine: MyMarket | null; loading: boolean; onChanged: () => void }) {
  const { token } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const prepaid = mine?.prepaid.usd ?? null;
  const sold = mine?.fills.asSeller ?? [];
  const earned = sold.reduce((a, f) => a + f.sellerReceivedUsd, 0);
  const pending = (mine?.withdrawals ?? []).filter((w) => w.status === 'pending');

  const claim = async () => {
    if (!token || !prepaid) return;
    setBusy(true);
    try {
      const w = await market.withdraw(token, floor2(prepaid));
      toast.ok(`Claim of ${fmtUsd(w.amountUsd)} requested. The team sends USDG to this wallet and marks it paid.`);
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const rows = useMemo<HistoryRow[]>(() => {
    if (!mine) return [];
    const fills: HistoryRow[] = [...mine.fills.asBuyer.map((f) => ({ ...f, side: 'bought' as const })), ...mine.fills.asSeller.map((f) => ({ ...f, side: 'sold' as const }))].map((f: Fill & { side: 'bought' | 'sold' }) => ({
      key: `${f.side}-${f.id}`,
      at: f.created_at,
      kind: f.side === 'bought' ? 'Bought' : 'Sold',
      who: shortAddr(f.side === 'bought' ? f.seller : f.buyer, 6, 4),
      credits: f.creditsUsd,
      price: f.paidUsd,
      fee: f.side === 'sold' ? f.feeUsd : null,
      net: f.side === 'sold' ? f.sellerReceivedUsd : -f.paidUsd,
    }));
    const wds: HistoryRow[] = mine.withdrawals.map((w) => ({
      key: `w-${w.id}`,
      at: w.created_at,
      kind: 'Withdrawal',
      who: w.txRef ? shortAddr(w.txRef, 6, 6) : '—',
      credits: null,
      price: null,
      fee: null,
      net: -w.amountUsd,
      status: statusWord[w.status] ?? w.status,
    }));
    // Credits bought from Mesh at face value (prepaid ledger kind credit_purchase): no counterparty, no fee.
    const direct: HistoryRow[] = mine.prepaid.ledger
      .filter((p) => p.kind === 'credit_purchase')
      .map((p) => ({ key: `d-${p.id}`, at: p.created_at, kind: 'Bought from Mesh', who: TOKENOMICS.name, credits: -p.deltaUsd, price: -p.deltaUsd, fee: null, net: p.deltaUsd }));
    return [...fills, ...direct, ...wds].sort((a, b) => b.at - a.at).slice(0, 25);
  }, [mine]);

  return (
    <section className="panel mkt-card" aria-label="Claimable from sales">
      <div className="mkt-claim">
        <div className="stack" style={{ gap: 4 }}>
          <span className="eyebrow">Claimable from sales</span>
          <span className="display d-m num">{loading && !mine ? <Skeleton w="5ch" h="0.9em" /> : fmtUsd(prepaid, 2)}</span>
          <span className="small muted num">
            {sold.length > 0 ? `${fmtUsd(earned)} earned from ${sold.length} sale${sold.length === 1 ? '' : 's'}, all time` : 'Proceeds from your listings land here as prepaid USD.'}
            {pending.length > 0 ? ` · ${fmtUsd(pending.reduce((a, w) => a + w.amountUsd, 0))} being paid out` : ''}
          </span>
        </div>
        <button type="button" className="btn secondary" onClick={() => void claim()} disabled={!prepaid || busy}>
          {busy ? <Spinner /> : 'Claim'}
        </button>
      </div>

      <div className="row between" style={{ marginTop: 8 }}>
        <span className="eyebrow">History</span>
        <span className="small muted">{rows.length ? `${rows.length} most recent` : ''}</span>
      </div>
      {loading && !mine ? (
        <Skeleton w="100%" h="72px" />
      ) : rows.length === 0 ? (
        <p className="hint">Every buy, sale and withdrawal of yours shows up here with the exact fee.</p>
      ) : (
        <div className="tblwrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>When</th>
                <th>Type</th>
                <th>Counterparty</th>
                <th className="num">Credits</th>
                <th className="num">Price</th>
                <th className="num">Fee</th>
                <th className="num">Net to you</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td className="date">{fmtAgo(r.at)}</td>
                  <td>
                    {r.kind}
                    {r.status ? <span className="small muted"> · {r.status}</span> : null}
                  </td>
                  <td className="small muted">{r.who}</td>
                  <td className="num">{r.credits === null ? '—' : fmtUsd(r.credits)}</td>
                  <td className="num">{r.price === null ? '—' : fmtUsd(r.price)}</td>
                  <td className="num">{r.fee === null ? '—' : fmtUsd(r.fee)}</td>
                  <td className={`num ${r.net > 0 ? 'pos' : ''}`}>{r.net > 0 ? `+${fmtUsd(r.net)}` : `−${fmtUsd(Math.abs(r.net))}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- Page ----------------------------------------------------------------

/** Public teaser under the gate's button: the best discount and the depth, from GET /market/book. */
function BookTeaser() {
  const { data, loading } = useAsync(market.getBook, [], 60_000);
  if (loading && !data) return <Skeleton w="22ch" h="0.9em" />;
  if (!data || data.bestDiscountBps === null) return <>Nothing listed right now. Be the first to sell.</>;
  return (
    <span className="num">
      Best discount right now: <b>{fmtDiscount(data.bestDiscountBps)}</b> · {fmtUsd(data.totalAvailableUsd, 0)} available
    </span>
  );
}

export function Market() {
  const { session } = useAuth();
  if (!session) {
    return (
      <WalletGate eyebrow="Credit market" title="Connect a wallet to see the book" teaser={<BookTeaser />}>
        Holders sell credit they will not use; you buy it below face value and spend it on any model.
      </WalletGate>
    );
  }
  return <MarketInner wallet={session.wallet} chain={session.chain} />;
}

function MarketInner({ wallet, chain }: { wallet: string; chain: string }) {
  const cfgQ = useAsync(market.getMarketConfig, []);
  const book = useAsync(market.getBook, [], 15_000);
  const mine = useSessionAsync(market.myMarket, [], 20_000);
  const [tier, setTier] = useState<number | null>(null);
  const [side, setSide] = useState<'sell' | 'buy'>('sell');
  const cfg = cfgQ.data ?? book.data?.config ?? mine.data?.config ?? null;
  const tiers = book.data?.tiers;
  useEffect(() => {
    if (tiers && tiers.length > 0 && !tiers.some((t) => t.discountBps === tier)) setTier([...tiers].sort((a, b) => b.discountBps - a.discountBps)[0].discountBps);
  }, [tiers, tier]);

  const changed = () => {
    void book.reload();
    void mine.reload();
  };
  const pick = (bps: number) => {
    setTier(bps);
    setSide('buy');
  };

  return (
    <div className="mkt">
      <WalletStrip wallet={wallet} chain={chain} />
      {cfgQ.error && !cfg ? <Notice kind="bad">Could not reach the market: {cfgQ.error}</Notice> : null}
      {mine.error && !mine.data ? <Notice kind="bad">Could not load your market activity: {mine.error}</Notice> : null}
      <div className="mkt-grid">
        <BalanceCard mine={mine.data} loading={mine.loading} onBuy={() => setSide('buy')} onChanged={changed} />
        <OrderBookCard cfg={cfg} book={book.data} tier={tier} mine={mine.data} side={side} setSide={setSide} onPick={pick} onChanged={changed} />
      </div>
      <ProceedsCard mine={mine.data} loading={mine.loading} onChanged={changed} />
      <p className="hint">
        Mesh keeps {cfg ? cfg.feePercent : TOKENOMICS.marketplace.feeBps / 100}% of each sale, paid by the seller: half goes into the next hourly holder distribution, half to the treasury. Credits are a licence to use the
        gateway, not money; they only move between wallets here. <Link to="/docs#market">How the market works</Link>
      </p>
    </div>
  );
}
