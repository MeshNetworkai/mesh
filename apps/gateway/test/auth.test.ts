import { EvmAdapter, MockAdapter, SolanaAdapter, createAdapter, verifierFor } from '@mesh/chain-adapter';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import {
  API_KEY_PREFIX,
  createApiKey,
  hashApiKey,
  listApiKeys,
  lookupApiKey,
  revokeApiKey,
  signSession,
  verifySession,
} from '../src/auth.js';
import { ensureWallet } from '../src/ledger.js';
import { memDb } from './helpers.js';

describe('API keys', () => {
  it('stores only the sha256 hash and resolves the plaintext key once', () => {
    const db = memDb();
    ensureWallet(db, 'w1', 'solana');
    const { id, key, prefix } = createApiKey(db, 'w1', 'laptop');
    expect(key.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(key.length).toBeGreaterThan(30);
    expect(prefix).toBe(key.slice(0, API_KEY_PREFIX.length + 6));

    const rows = listApiKeys(db, 'w1');
    expect(rows).toHaveLength(1);
    expect(rows[0].key_hash).toBe(hashApiKey(key));
    expect(rows[0].key_hash).not.toContain(key.slice(API_KEY_PREFIX.length));
    expect(JSON.stringify(rows[0])).not.toContain(key);

    expect(lookupApiKey(db, key)?.id).toBe(id);
    expect(lookupApiKey(db, key + 'x')).toBeNull();
    expect(lookupApiKey(db, 'sk-not-a-mesh-key')).toBeNull();
  });

  it('revoked keys stop resolving and cannot be revoked by another wallet', () => {
    const db = memDb();
    ensureWallet(db, 'w1', 'solana');
    ensureWallet(db, 'w2', 'solana');
    const { id, key } = createApiKey(db, 'w1');
    expect(revokeApiKey(db, 'w2', id)).toBe(false);
    expect(lookupApiKey(db, key)).not.toBeNull();
    expect(revokeApiKey(db, 'w1', id)).toBe(true);
    expect(lookupApiKey(db, key)).toBeNull();
    expect(revokeApiKey(db, 'w1', id)).toBe(false);
  });
});

describe('session JWT', () => {
  it('round-trips and rejects a bad secret', async () => {
    const token = await signSession('secret-one-secret-one', 'wallet-x', 'solana');
    const session = await verifySession('secret-one-secret-one', token);
    expect(session).toMatchObject({ wallet: 'wallet-x', chain: 'solana' });
    // 7 day session
    expect(session!.exp! - Math.floor(Date.now() / 1000)).toBeGreaterThan(7 * 86_400 - 60);
    expect(session!.exp! - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(7 * 86_400);
    expect(await verifySession('secret-two-secret-two', token)).toBeNull();
    expect(await verifySession('secret-one-secret-one', 'garbage')).toBeNull();
  });
});

describe('wallet signature verification', () => {
  it('Solana: real ed25519 over bs58', () => {
    const kp = nacl.sign.keyPair();
    const wallet = bs58.encode(kp.publicKey);
    const message = 'Sign in to Mesh\n\nWallet: x\nNonce: 123';
    const sig = nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey);
    const a = new SolanaAdapter();
    expect(a.verifyWalletSignature(wallet, message, bs58.encode(sig))).toBe(true);
    expect(a.verifyWalletSignature(wallet, message, Buffer.from(sig).toString('base64'))).toBe(true);
    expect(a.verifyWalletSignature(wallet, message + '!', bs58.encode(sig))).toBe(false);
    const other = bs58.encode(nacl.sign.keyPair().publicKey);
    expect(a.verifyWalletSignature(other, message, bs58.encode(sig))).toBe(false);
    expect(a.verifyWalletSignature('not-base58-!!', message, bs58.encode(sig))).toBe(false);
  });

  it('EVM: real EIP-191 personal_sign recovery', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const message = 'Sign in to Mesh\n\nWallet: y\nNonce: 456';
    const sig = await account.signMessage({ message });
    const a = new EvmAdapter();
    expect(a.verifyWalletSignature(account.address, message, sig)).toBe(true);
    expect(a.verifyWalletSignature(account.address.toLowerCase(), message, sig)).toBe(true);
    expect(a.verifyWalletSignature(account.address, 'tampered', sig)).toBe(false);
    const other = privateKeyToAccount(generatePrivateKey()).address;
    expect(a.verifyWalletSignature(other, message, sig)).toBe(false);
    expect(a.verifyWalletSignature(account.address, message, '0xdeadbeef')).toBe(false);
  });

  it('Mock: deterministic signature; factory picks the right class', () => {
    const m = new MockAdapter();
    expect(m.verifyWalletSignature('w', 'm', MockAdapter.sign('w', 'm'))).toBe(true);
    expect(m.verifyWalletSignature('w', 'm', 'nope')).toBe(false);
    expect(createAdapter({ chain: 'solana' })).toBeInstanceOf(SolanaAdapter);
    expect(createAdapter({ chain: 'evm' })).toBeInstanceOf(EvmAdapter);
    expect(createAdapter({ chain: 'evm' }, { mock: true })).toBeInstanceOf(MockAdapter);
    expect(createAdapter({ chain: 'evm' }, { mock: true }).chain).toBe('evm');
    expect(typeof verifierFor('evm')).toBe('function');
  });

  it('network methods on real adapters fail loudly as not-yet-wired', async () => {
    await expect(new SolanaAdapter().collectFees()).rejects.toThrow(/not yet wired/);
    await expect(new EvmAdapter().getHolderBalances({ from: 0, to: 1 })).rejects.toThrow(/not yet wired/);
  });
});
