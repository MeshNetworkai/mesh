import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { markAdminAudited, requireAdmin, requireSession, sessionOf, type AppContext } from '../context.js';
import { nowSec, recordAdminAction, recordError } from '../db.js';
import { creditDeposit, depositsInfo, rpcVerifier } from '../deposits.js';
import { expireWallet, nonTransferableMicros } from '../expiry.js';
import { balanceMicros } from '../ledger.js';
import {
  MIN_FILL_MICROS,
  MarketError,
  book,
  cancelListing,
  createListing,
  fillListing,
  fillsOf,
  getListing,
  listingsOf,
  markWithdrawalPaid,
  marketTotals,
  openListings,
  pendingWithdrawals,
  prepaidBalanceMicros,
  quote,
  reapMarket,
  recentPrepaid,
  requestWithdrawal,
  topUpPrepaid,
  withdrawalsOf,
  type FillRow,
  type ListingRow,
  type PrepaidRow,
  type WithdrawalRow,
} from '../market.js';
import { microsToUsd, usdToMicros } from '../money.js';
import { walletHold } from '../reserve.js';

const Amount = z.number().positive().max(1_000_000);
const ListBody = z.object({ amountUsd: Amount, discountBps: z.number().int().min(0).max(10_000) });
const FillBody = z.object({ listingId: z.string().min(1).max(64), amountUsd: Amount });
const WithdrawBody = z.object({ amountUsd: Amount });
const QuoteQuery = z.object({ amountUsd: z.coerce.number().positive().max(1_000_000), discountBps: z.coerce.number().int().min(0).max(10_000) });
const PageQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0), discountBps: z.coerce.number().int().min(0).max(10_000).optional() });
const PrepaidBody = z.object({ wallet: z.string().min(1).max(128), amountUsd: Amount, note: z.string().trim().min(1).max(500), ref: z.string().trim().min(1).max(200).optional() });
const PaidBody = z.object({ txRef: z.string().trim().min(1).max(200).optional(), note: z.string().trim().max(500).optional() }).optional();

const usd = (micros: number) => microsToUsd(micros);

export function listingView(l: ListingRow) {
  return {
    id: l.id,
    seller: l.seller_wallet,
    amountUsd: usd(l.amount_micros),
    remainingUsd: usd(l.remaining_micros),
    soldUsd: usd(l.amount_micros - l.remaining_micros),
    discountBps: l.discount_bps,
    /** What a buyer pays per $1 of credit at this discount. */
    pricePerUsd: usd(l.price_micros_per_usd),
    status: l.status,
    created_at: l.created_at,
    expires_at: l.expires_at,
    closed_at: l.closed_at,
  };
}

/** Public shape: no seller address on the open book. */
const publicListing = (l: ListingRow) => ({ ...listingView(l), seller: undefined });

export function fillView(f: FillRow) {
  return {
    id: f.id,
    listingId: f.listing_id,
    buyer: f.buyer_wallet,
    seller: f.seller_wallet,
    creditsUsd: usd(f.credits_micros),
    paidUsd: usd(f.paid_micros),
    feeUsd: usd(f.fee_micros),
    feeToHoldersUsd: usd(f.fee_to_holders_micros),
    feeToTreasuryUsd: usd(f.fee_to_treasury_micros),
    sellerReceivedUsd: usd(f.paid_micros - f.fee_micros),
    discountBps: f.discount_bps,
    settlement: f.settlement,
    settlementRef: f.settlement_ref,
    created_at: f.created_at,
  };
}

function withdrawalView(w: WithdrawalRow) {
  return { id: w.id, wallet: w.wallet, amountUsd: usd(w.amount_micros), status: w.status, note: w.note, txRef: w.tx_ref, created_at: w.created_at, paid_at: w.paid_at };
}

function prepaidView(p: PrepaidRow) {
  return { id: p.id, kind: p.kind, deltaUsd: usd(p.delta_micros), ref: p.ref, created_at: p.created_at };
}

function sendMarketError(reply: FastifyReply, err: unknown) {
  if (err instanceof MarketError) return reply.code(err.status).send({ error: err.code, message: err.message, statusCode: err.status });
  throw err;
}

export async function marketRoutes(app: FastifyInstance, ctx: AppContext) {
  const cfg = ctx.config.marketplace;
  const auth = requireSession(ctx);
  const admin = requireAdmin(ctx);
  const gate = async (_req: FastifyRequest, reply: FastifyReply) => {
    if (cfg.enabled) return;
    reply.code(404).send({ error: 'not_found', message: 'the credit marketplace is disabled', statusCode: 404 });
    return reply;
  };
  const writeLimit = { rateLimit: { max: 30, timeWindow: '1 minute' } };
  const readLimit = { rateLimit: { max: 120, timeWindow: '1 minute' } };
  const audit = (req: FastifyRequest, action: string, payload: unknown) => {
    markAdminAudited(req);
    return recordAdminAction(ctx.db, action, payload);
  };

  // Expired listings are swept once a minute in the background and lazily on reads of the book.
  const reap = () => {
    try {
      reapMarket(ctx.db);
    } catch (err) {
      recordError(ctx.db, { route: 'market reap', status: 500, code: 'market_reap_failed', message: (err as Error).message ?? String(err) });
    }
  };
  const timer = setInterval(reap, 60_000);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));

  const configView = () => ({
    enabled: cfg.enabled,
    feeBps: cfg.feeBps,
    feePercent: cfg.feeBps / 100,
    feeToHoldersBps: cfg.feeToHoldersBps,
    minListingUsd: cfg.minListingUsd,
    minFillUsd: usd(MIN_FILL_MICROS),
    maxDiscountBps: cfg.maxDiscountBps,
    listingTtlHours: cfg.listingTtlHours,
    settlement: 'prepaid' as const,
    deposits: depositsInfo(cfg.deposits),
    /** False: unused starter credit cannot be listed (starterCredits.transferable). */
    starterTransferable: ctx.config.starterCredits.transferable,
    /** Days after which credit lapses, or null when credits do not expire. Bought credit starts a fresh window. */
    creditExpiryDays: ctx.config.creditExpiry.enabled ? ctx.config.creditExpiry.days : null,
  });
  /** Lapse what is due, then how much of the balance may not be sold. */
  const settle = (wallet: string) => {
    expireWallet(ctx.db, wallet, ctx.config.creditExpiry, undefined, ctx.reservations.reserved(walletHold(wallet)));
    return ctx.config.starterCredits.transferable ? 0 : nonTransferableMicros(ctx.db, wallet);
  };
  const verifier = () => (ctx.depositVerifier ??= rpcVerifier({ chainId: cfg.deposits.chainId, rpcUrl: ctx.env.MESH_EVM_RPC_URL }));
  const DepositBody = z.object({ txHash: z.string().min(66).max(66) });

  // ---------- public ----------

  /** Fee schedule and limits the web app renders. */
  app.get('/market/config', { onRequest: gate, config: readLimit }, async () => configView());

  /** The liquidity book: open depth by discount tier, deepest discount first. */
  app.get('/market/book', { onRequest: gate, config: readLimit }, async () => {
    reap();
    const b = book(ctx.db);
    return {
      tiers: b.tiers.map((t) => ({ discountBps: t.discountBps, pricePerUsd: (10_000 - t.discountBps) / 10_000, availableUsd: usd(t.availableMicros), listings: t.listings })),
      bestDiscountBps: b.bestDiscountBps,
      totalAvailableUsd: usd(b.totalAvailableMicros),
      listings: b.listings,
      config: configView(),
      generatedAt: nowSec(),
    };
  });

  /** Open listings, paginated, deepest discount first. `?discountBps=` narrows to one tier. */
  app.get('/market/listings', { onRequest: gate, config: readLimit }, async (req, reply) => {
    const q = PageQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'bad_request', issues: q.error.issues });
    reap();
    const r = openListings(ctx.db, q.data);
    return { listings: r.rows.map(publicListing), total: r.total, limit: q.data.limit, offset: q.data.offset };
  });

  /** Public totals for the market page tiles. */
  app.get('/market/stats', { onRequest: gate, config: readLimit }, async () => {
    const t = marketTotals(ctx.db);
    const t24 = marketTotals(ctx.db, nowSec() - 86_400);
    return {
      openListings: t.openListings,
      openDepthUsd: usd(t.openDepthMicros),
      bestDiscountBps: t.bestDiscountBps,
      avgDiscountBps: t.avgDiscountBps,
      allTime: { filledUsd: usd(t.filledMicros), paidUsd: usd(t.paidMicros), feesUsd: usd(t.feesMicros), feesToHoldersUsd: usd(t.feesToHoldersMicros), fills: t.fills },
      last24h: { filledUsd: usd(t24.filledMicros), paidUsd: usd(t24.paidMicros), feesUsd: usd(t24.feesMicros), fills: t24.fills },
      feeBps: cfg.feeBps,
      generatedAt: nowSec(),
    };
  });

  /** Exact math for a hypothetical trade. */
  app.get('/market/quote', { onRequest: gate, config: readLimit }, async (req, reply) => {
    const q = QuoteQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'bad_request', issues: q.error.issues });
    const r = quote(cfg, usdToMicros(q.data.amountUsd), q.data.discountBps);
    return {
      creditsUsd: usd(r.creditsMicros),
      discountBps: r.discountBps,
      pricePerUsd: usd(r.priceMicrosPerUsd),
      buyerPaysUsd: usd(r.paidMicros),
      feeUsd: usd(r.feeMicros),
      feeToHoldersUsd: usd(r.feeToHoldersMicros),
      feeToTreasuryUsd: usd(r.feeToTreasuryMicros),
      sellerReceivesUsd: usd(r.sellerReceivesMicros),
    };
  });

  // ---------- sellers ----------

  app.post('/market/listings', { onRequest: gate, preHandler: auth, config: writeLimit }, async (req, reply) => {
    const parsed = ListBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    const { wallet, chain } = sessionOf(req);
    try {
      const lockedMicros = settle(wallet);
      const row = createListing(ctx.db, cfg, { seller: wallet, chain, amountMicros: usdToMicros(parsed.data.amountUsd), discountBps: parsed.data.discountBps, reservedMicros: ctx.reservations.reserved(walletHold(wallet)), lockedMicros });
      const q = quote(cfg, row.amount_micros, row.discount_bps);
      return reply.code(201).send({ ...listingView(row), ifFullySold: { buyerPaysUsd: usd(q.paidMicros), feeUsd: usd(q.feeMicros), youReceiveUsd: usd(q.sellerReceivesMicros) } });
    } catch (err) {
      return sendMarketError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>('/market/listings/:id', { onRequest: gate, preHandler: auth, config: writeLimit }, async (req, reply) => {
    try {
      return listingView(cancelListing(ctx.db, { seller: sessionOf(req).wallet, id: req.params.id }));
    } catch (err) {
      return sendMarketError(reply, err);
    }
  });

  // ---------- buyers ----------

  /** Fill (part of) a listing from the prepaid balance; credits land at once. */
  app.post('/market/fills', { onRequest: gate, preHandler: auth, config: writeLimit }, async (req, reply) => {
    const parsed = FillBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    const { wallet, chain } = sessionOf(req);
    reap();
    try {
      const row = fillListing(ctx.db, cfg, { buyer: wallet, chain, listingId: parsed.data.listingId, creditsMicros: usdToMicros(parsed.data.amountUsd) });
      return reply.code(201).send({
        ...fillView(row),
        creditBalanceUsd: usd(balanceMicros(ctx.db, wallet)),
        prepaidBalanceUsd: usd(prepaidBalanceMicros(ctx.db, wallet)),
      });
    } catch (err) {
      return sendMarketError(reply, err);
    }
  });

  // ---------- me ----------

  /** Everything about this wallet on the market: listings, fills both ways, prepaid balance and withdrawals. */
  app.get('/me/market', { onRequest: gate, preHandler: auth, config: readLimit }, async (req) => {
    const { wallet } = sessionOf(req);
    reap();
    const locked = settle(wallet);
    const fills = fillsOf(ctx.db, wallet);
    const prepaid = prepaidBalanceMicros(ctx.db, wallet);
    const credit = balanceMicros(ctx.db, wallet);
    return {
      wallet,
      creditBalanceUsd: usd(credit),
      /** Unused starter credit in the balance: spendable, not sellable. */
      nonTransferableUsd: usd(locked),
      /** What this wallet could list right now (balance − starter credit − credit held by requests in flight). */
      listableUsd: usd(Math.max(0, credit - locked - ctx.reservations.reserved(walletHold(wallet)))),
      prepaid: { usd: usd(prepaid), usdMicros: prepaid, ledger: recentPrepaid(ctx.db, wallet, 20).map(prepaidView) },
      listings: listingsOf(ctx.db, wallet).map(listingView),
      fills: { asBuyer: fills.asBuyer.map(fillView), asSeller: fills.asSeller.map(fillView) },
      withdrawals: withdrawalsOf(ctx.db, wallet).map(withdrawalView),
      config: configView(),
    };
  });

  /**
   * Self-serve top-up: the buyer sent a stablecoin to the deposit receiver and pastes the tx hash. The
   * gateway verifies the ERC-20 Transfer on chain (sender = session wallet, accepted token, confirmed)
   * and credits the prepaid balance once per hash.
   */
  app.post('/me/market/deposits', { onRequest: gate, preHandler: auth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = DepositBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    const { wallet } = sessionOf(req);
    const r = await creditDeposit(ctx.db, cfg.deposits, verifier(), { wallet, txHash: parsed.data.txHash });
    if (!r.ok) {
      const status = r.code === 'disabled' ? 404 : r.code === 'pending' || r.code === 'unconfirmed' || r.code === 'already_credited' ? 409 : 400;
      return reply.code(status).send({ error: r.code, message: r.message, ...(r.confirmations !== undefined ? { confirmations: r.confirmations } : {}), statusCode: status });
    }
    req.log.info({ wallet, txHash: parsed.data.txHash, creditedUsd: usd(r.creditedMicros), token: r.token }, 'prepaid deposit credited');
    return { ok: true, creditedUsd: usd(r.creditedMicros), token: r.token, blockNumber: r.blockNumber, prepaid: { usd: usd(prepaidBalanceMicros(ctx.db, wallet)) } };
  });

  app.post('/me/market/withdraw', { onRequest: gate, preHandler: auth, config: writeLimit }, async (req, reply) => {
    const parsed = WithdrawBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    const { wallet } = sessionOf(req);
    try {
      const row = requestWithdrawal(ctx.db, { wallet, amountMicros: usdToMicros(parsed.data.amountUsd) });
      return reply.code(201).send({ ...withdrawalView(row), prepaidBalanceUsd: usd(prepaidBalanceMicros(ctx.db, wallet)) });
    } catch (err) {
      return sendMarketError(reply, err);
    }
  });

  // ---------- admin ----------

  /**
   * Credit a wallet's prepaid balance for a payment received off-chain (bank, USDC sent by hand). Pass
   * the payment's own reference as `ref` so a re-post of the same payment is a no-op; without one a
   * fresh ref is minted. Audited with the note.
   */
  app.post('/admin/prepaid', { preHandler: admin }, async (req, reply) => {
    const parsed = PrepaidBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    const { wallet, amountUsd, note } = parsed.data;
    const ref = parsed.data.ref ?? `admin:${nowSec()}:${Math.random().toString(36).slice(2, 10)}`;
    try {
      const out = ctx.db.transaction(() => {
        const ledgerId = topUpPrepaid(ctx.db, { wallet, chain: ctx.adapter.chain, amountMicros: usdToMicros(amountUsd), ref });
        audit(req, 'prepaid-topup', { wallet, amountUsd, note, ref, ledgerId, duplicate: ledgerId === null });
        return { wallet, amountUsd, ref, ledgerId, duplicate: ledgerId === null, prepaidBalanceUsd: usd(prepaidBalanceMicros(ctx.db, wallet)) };
      })();
      return reply.code(out.duplicate ? 200 : 201).send(out);
    } catch (err) {
      return sendMarketError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>('/admin/market/withdrawals/:id/paid', { preHandler: admin }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'bad_request', message: 'id must be a positive integer' });
    const parsed = PaidBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    try {
      const out = ctx.db.transaction(() => {
        const row = markWithdrawalPaid(ctx.db, { id, txRef: parsed.data?.txRef ?? null, note: parsed.data?.note ?? null });
        audit(req, 'withdrawal-paid', { id, wallet: row.wallet, amountUsd: usd(row.amount_micros), txRef: parsed.data?.txRef ?? null, note: parsed.data?.note ?? null });
        return row;
      })();
      return withdrawalView(out);
    } catch (err) {
      return sendMarketError(reply, err);
    }
  });

  /** Operator overview: totals, open book, pending withdrawals, prepaid outstanding. */
  app.get('/admin/market', { preHandler: admin }, async () => {
    const t = marketTotals(ctx.db);
    const DAY = 86_400;
    const t24 = marketTotals(ctx.db, nowSec() - DAY);
    return {
      totals: {
        listedUsd: usd(t.listedMicros),
        filledUsd: usd(t.filledMicros),
        paidUsd: usd(t.paidMicros),
        feesUsd: usd(t.feesMicros),
        feesToHoldersUsd: usd(t.feesToHoldersMicros),
        feesToTreasuryUsd: usd(t.feesToTreasuryMicros),
        fills: t.fills,
        avgDiscountBps: t.avgDiscountBps,
      },
      last24h: { filledUsd: usd(t24.filledMicros), paidUsd: usd(t24.paidMicros), feesUsd: usd(t24.feesMicros), fills: t24.fills },
      book: { openListings: t.openListings, openDepthUsd: usd(t.openDepthMicros), bestDiscountBps: t.bestDiscountBps },
      prepaid: { outstandingUsd: usd(t.prepaidOutstandingMicros) },
      poolExtra: { pendingUsd: usd(t.poolExtraPendingMicros) },
      withdrawals: { pendingUsd: usd(t.withdrawalsPendingMicros), paidUsd: usd(t.withdrawalsPaidMicros), pending: pendingWithdrawals(ctx.db).map(withdrawalView) },
      config: configView(),
      generatedAt: nowSec(),
    };
  });

  app.get<{ Params: { id: string } }>('/admin/market/listings/:id', { preHandler: admin }, async (req, reply) => {
    const l = getListing(ctx.db, req.params.id);
    if (!l) return reply.code(404).send({ error: 'not_found' });
    const fills = ctx.db.prepare(`SELECT * FROM market_fills WHERE listing_id = ? ORDER BY created_at DESC`).all(l.id) as FillRow[];
    return { ...listingView(l), fills: fills.map(fillView) };
  });

  app.post('/admin/market/reap', { preHandler: admin }, async (req) => {
    const r = reapMarket(ctx.db);
    audit(req, 'market-reap', r);
    return r;
  });
}
