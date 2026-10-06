import type { TokenomicsConfig } from '@mesh/config';
import { afterEach, describe, expect, it } from 'vitest';
import type { DepositVerifier, VerifiedTx } from '../src/deposits.js';
import { ADMIN, testConfig, testServer } from './helpers.js';

const RECEIVER = '0x00000000000000000000000000000000000000Fe';
const USDC = '0x1111111111111111111111111111111111111111';
const ALICE = '0x00000000000000000000000000000000000000a1';
const TX = '0x' + 'ab'.repeat(32);

const cfg: TokenomicsConfig = {
  ...testConfig,
  marketplace: { ...testConfig.marketplace, deposits: { enabled: true, chainId: 4663, receiver: RECEIVER, tokens: [{ symbol: 'USDC', address: USDC, decimals: 6 }], minUsd: 5, confirmations: 3 } },
};

function fakeVerifier(tx: VerifiedTx | null): DepositVerifier {
  return { getTransaction: async () => tx };
}
const transfer = (from: string, amount: bigint, token = USDC, to = RECEIVER): VerifiedTx => ({
  status: 'success',
  blockNumber: 100n,
  headBlock: 110n,
  transfers: [{ token: token as `0x${string}`, from: from as `0x${string}`, to: to as `0x${string}`, amount }],
});

type App = Awaited<ReturnType<typeof testServer>>['app'];
const apps: App[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

async function boot(tx: VerifiedTx | null, config = cfg) {
  const { app } = await testServer({ config, context: { depositVerifier: fakeVerifier(tx) } });
  apps.push(app);
  const jwt = (await app.inject({ method: 'POST', url: '/admin/dev-login', headers: ADMIN, payload: { wallet: ALICE } })).json().token as string;
  const h = { authorization: `Bearer ${jwt}` };
  const deposit = (txHash = TX) => app.inject({ method: 'POST', url: '/me/market/deposits', headers: h, payload: { txHash } });
  const prepaid = async () => (await app.inject({ method: 'GET', url: '/me/market', headers: h })).json().prepaid.usd as number;
  return { app, h, deposit, prepaid };
}

describe('prepaid deposits (POST /me/market/deposits)', () => {
  it('credits a confirmed USDC transfer from the signed-in wallet once, and never twice', async () => {
    const { deposit, prepaid, app } = await boot(transfer(ALICE, 25_000_000n));
    expect(await prepaid()).toBe(0);
    const r = await deposit();
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, creditedUsd: 25, token: 'USDC', blockNumber: 100 });
    expect(await prepaid()).toBe(25);
    const again = await deposit();
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('already_credited');
    expect(await prepaid()).toBe(25);
    // the hash is normalised: upper-case hex is the same deposit
    expect((await deposit(TX.toUpperCase().replace('0X', '0x'))).json().error).toBe('already_credited');
    expect((await app.inject({ method: 'GET', url: '/market/config' })).json().deposits).toMatchObject({ enabled: true, receiver: RECEIVER, chainName: 'Robinhood Chain' });
  });

  it('refuses the wrong sender, the wrong token, the wrong receiver, a reverted tx, and tiny amounts', async () => {
    expect((await (await boot(transfer('0x00000000000000000000000000000000000000b2', 25_000_000n))).deposit()).json().error).toBe('wrong_sender');
    expect((await (await boot(transfer(ALICE, 25_000_000n, '0x2222222222222222222222222222222222222222'))).deposit()).json().error).toBe('no_transfer');
    expect((await (await boot(transfer(ALICE, 25_000_000n, USDC, '0x00000000000000000000000000000000000000c3'))).deposit()).json().error).toBe('no_transfer');
    expect((await (await boot({ ...transfer(ALICE, 25_000_000n), status: 'reverted' })).deposit()).json().error).toBe('reverted');
    expect((await (await boot(transfer(ALICE, 4_990_000n))).deposit()).json().error).toBe('too_small');
  });

  it('waits for the chain: unknown tx → 409 pending, too few confirmations → 409 with the count', async () => {
    const pending = await (await boot(null)).deposit();
    expect(pending.statusCode).toBe(409);
    expect(pending.json().error).toBe('pending');
    const fresh = await (await boot({ ...transfer(ALICE, 25_000_000n), headBlock: 101n })).deposit();
    expect(fresh.statusCode).toBe(409);
    expect(fresh.json()).toMatchObject({ error: 'unconfirmed', confirmations: 1 });
  });

  it('converts 18-decimal stablecoins and rejects malformed hashes', async () => {
    const usdg = { ...cfg, marketplace: { ...cfg.marketplace, deposits: { ...cfg.marketplace.deposits, tokens: [{ symbol: 'USDG', address: USDC, decimals: 18 }] } } };
    const { deposit } = await boot(transfer(ALICE, 12_500_000_000_000_000_000n), usdg);
    expect((await deposit()).json()).toMatchObject({ ok: true, creditedUsd: 12.5, token: 'USDG' });
    expect((await deposit('0x1234')).statusCode).toBe(400);
  });

  it('is off (404) until receiver and tokens are configured', async () => {
    const off = { ...cfg, marketplace: { ...cfg.marketplace, deposits: { ...cfg.marketplace.deposits, receiver: null } } };
    const { deposit, app } = await boot(transfer(ALICE, 25_000_000n), off);
    expect((await deposit()).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/market/config' })).json().deposits.enabled).toBe(false);
  });
});
