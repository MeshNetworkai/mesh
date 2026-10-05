import { describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { privateKeyToAccount } from 'viem/accounts';
import { EvmAdapter, normalizeEvmAddress, normalizeEvmSignature } from '../src/evm.js';
import { MockAdapter } from '../src/mock.js';
import { SolanaAdapter, decodeSignatureCandidates } from '../src/solana.js';
import { assertBps, toRaw, toUnits } from '../src/rpc.js';

const message = 'localhost wants to register a Mesh node paid to:\n0xabc\n\nNonce: 123';

describe('EVM signature verification edge cases', () => {
  const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
  const a = new EvmAdapter();

  it('accepts the wallet address in any case: checksummed, lowercase, UPPERCASE, 0X prefix, padded', async () => {
    const sig = await account.signMessage({ message });
    const addr = account.address; // checksummed
    expect(addr).not.toBe(addr.toLowerCase());
    expect(a.verifyWalletSignature(addr, message, sig)).toBe(true);
    expect(a.verifyWalletSignature(addr.toLowerCase(), message, sig)).toBe(true);
    expect(a.verifyWalletSignature(addr.toUpperCase(), message, sig)).toBe(true); // "0X…" all caps: viem's strict isAddress rejects this
    expect(a.verifyWalletSignature(`0X${addr.slice(2)}`, message, sig)).toBe(true);
    expect(a.verifyWalletSignature(`  ${addr}  `, message, sig)).toBe(true);
    // A wrongly-checksummed mixed-case spelling of the right address is still the right address.
    const badChecksum = `0x${addr
      .slice(2)
      .split('')
      .map((ch, i) => (i % 2 ? ch.toUpperCase() : ch.toLowerCase()))
      .join('')}`;
    expect(a.verifyWalletSignature(badChecksum, message, sig)).toBe(true);
  });

  it('rejects a different wallet, a changed message, junk, and a non-address', async () => {
    const sig = await account.signMessage({ message });
    const other = privateKeyToAccount('0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba');
    expect(a.verifyWalletSignature(other.address, message, sig)).toBe(false);
    expect(a.verifyWalletSignature(account.address, message + ' ', sig)).toBe(false);
    expect(a.verifyWalletSignature(account.address, message, '0xdeadbeef')).toBe(false);
    expect(a.verifyWalletSignature(account.address, message, '')).toBe(false);
    expect(a.verifyWalletSignature('0x123', message, sig)).toBe(false);
    expect(a.verifyWalletSignature('not-an-address', message, sig)).toBe(false);
    expect(a.verifyWalletSignature(`0x${'g'.repeat(40)}`, message, sig)).toBe(false);
  });

  it('accepts signature variants: no 0x, uppercase hex, v as 0/1, v with chain id folded in, EIP-2098 compact', async () => {
    const sig = await account.signMessage({ message });
    const hex = sig.slice(2);
    const rs = hex.slice(0, 128);
    const v = Number.parseInt(hex.slice(128), 16); // 27 or 28
    expect(a.verifyWalletSignature(account.address, message, hex)).toBe(true);
    expect(a.verifyWalletSignature(account.address, message, `0x${hex.toUpperCase()}`)).toBe(true);
    expect(a.verifyWalletSignature(account.address, message, `0x${rs}0${v - 27}`)).toBe(true); // Ledger-style 00/01
    expect(a.verifyWalletSignature(account.address, message, `0x${rs}${(v - 27 + 35 + 2 * 8453).toString(16)}`)).toBe(true); // EIP-155 style
    // EIP-2098: 64 bytes, yParity in the top bit of s.
    const yParity = v - 27;
    const s = BigInt(`0x${rs.slice(64)}`) | (BigInt(yParity) << 255n);
    const compact = `0x${rs.slice(0, 64)}${s.toString(16).padStart(64, '0')}`;
    expect(compact.length).toBe(2 + 128);
    expect(a.verifyWalletSignature(account.address, message, compact)).toBe(true);
    // the wrong recovery bit recovers a different address
    expect(a.verifyWalletSignature(account.address, message, `0x${rs}${v === 27 ? '1c' : '1b'}`)).toBe(false);
  });

  it('normalizers reject malformed input instead of guessing', () => {
    expect(normalizeEvmAddress('0xABCDEF0123456789abcdef0123456789ABCDEF01')).toBe('0xabcdef0123456789abcdef0123456789abcdef01');
    expect(normalizeEvmAddress('0xabc')).toBeNull();
    expect(normalizeEvmAddress('')).toBeNull();
    expect(() => normalizeEvmSignature('0xzz')).toThrow(/not hex/);
    expect(() => normalizeEvmSignature('0x' + 'ab'.repeat(63))).toThrow(/64 or 65 bytes/);
    expect(() => normalizeEvmSignature('0x' + 'ab'.repeat(64) + '05')).toThrow(/recovery byte/);
    expect(normalizeEvmSignature('ab'.repeat(64) + '00')).toBe('0x' + 'ab'.repeat(64) + '1b');
    expect(normalizeEvmSignature('ab'.repeat(64) + '01')).toBe('0x' + 'ab'.repeat(64) + '1c');
    expect(normalizeEvmSignature('ab'.repeat(64) + '1c')).toBe('0x' + 'ab'.repeat(64) + '1c');
  });
});

describe('Solana signature verification edge cases', () => {
  const kp = nacl.sign.keyPair();
  const wallet = bs58.encode(kp.publicKey);
  const sigBytes = nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey);
  const a = new SolanaAdapter();

  it('accepts base58 (Phantom), base64 and base64url (Uint8Array wallets), hex and JSON byte arrays', () => {
    expect(a.verifyWalletSignature(wallet, message, bs58.encode(sigBytes))).toBe(true);
    expect(a.verifyWalletSignature(wallet, message, Buffer.from(sigBytes).toString('base64'))).toBe(true);
    expect(a.verifyWalletSignature(wallet, message, Buffer.from(sigBytes).toString('base64url'))).toBe(true);
    expect(a.verifyWalletSignature(wallet, message, Buffer.from(sigBytes).toString('hex'))).toBe(true);
    expect(a.verifyWalletSignature(wallet, message, `0x${Buffer.from(sigBytes).toString('hex')}`)).toBe(true);
    expect(a.verifyWalletSignature(wallet, message, JSON.stringify(Array.from(sigBytes)))).toBe(true);
    // Uint8Array through JSON.stringify becomes {"0":12,"1":200,...}; Buffer.toJSON() becomes {type:'Buffer',data:[...]}
    expect(a.verifyWalletSignature(wallet, message, JSON.stringify(sigBytes))).toBe(true);
    expect(a.verifyWalletSignature(wallet, message, JSON.stringify(Buffer.from(sigBytes)))).toBe(true);
    expect(a.verifyWalletSignature(wallet, message, JSON.stringify({ signature: Array.from(sigBytes) }))).toBe(true);
    expect(a.verifyWalletSignature(` ${wallet} `, message, ` ${bs58.encode(sigBytes)} `)).toBe(true);
  });

  it('every 64-byte decoding is tried, so the alphabet guess can never reject a good signature', () => {
    const b58 = bs58.encode(sigBytes);
    const b64 = Buffer.from(sigBytes).toString('base64');
    const hex = Buffer.from(sigBytes).toString('hex');
    for (const form of [b58, b64, hex]) {
      const cands = decodeSignatureCandidates(form);
      expect(cands.length).toBeGreaterThanOrEqual(1);
      expect(cands.some((c) => Buffer.from(c).equals(Buffer.from(sigBytes)))).toBe(true);
    }
    // A 64-byte base58 string (88 chars, multiple of 4) is also syntactically valid base64 that decodes
    // to 66 bytes: that candidate is dropped by length, the base58 one is kept, and the result is unique.
    if (b58.length % 4 === 0) expect(decodeSignatureCandidates(b58)).toHaveLength(1);
  });

  it('rejects wrong lengths, wrong keys, tampered bytes and garbage', () => {
    expect(a.verifyWalletSignature(wallet, message, bs58.encode(sigBytes.subarray(0, 63)))).toBe(false);
    expect(a.verifyWalletSignature(wallet, message, Buffer.from([...sigBytes, 0]).toString('base64'))).toBe(false);
    const tampered = Uint8Array.from(sigBytes);
    tampered[5] ^= 0xff;
    expect(a.verifyWalletSignature(wallet, message, bs58.encode(tampered))).toBe(false);
    expect(a.verifyWalletSignature(wallet, message + 'x', bs58.encode(sigBytes))).toBe(false);
    expect(a.verifyWalletSignature(bs58.encode(nacl.sign.keyPair().publicKey), message, bs58.encode(sigBytes))).toBe(false);
    expect(a.verifyWalletSignature(wallet, message, '')).toBe(false);
    expect(a.verifyWalletSignature(wallet, message, '!!!not a signature!!!')).toBe(false);
    expect(a.verifyWalletSignature(wallet, message, '[1,2,3]')).toBe(false);
    expect(a.verifyWalletSignature(wallet, message, '{"nope":1}')).toBe(false);
    expect(a.verifyWalletSignature('0' + wallet, message, bs58.encode(sigBytes))).toBe(false); // invalid base58 pubkey
    expect(a.verifyWalletSignature(bs58.encode(kp.publicKey.subarray(0, 31)), message, bs58.encode(sigBytes))).toBe(false);
    expect(decodeSignatureCandidates('')).toEqual([]);
  });

  it('MockAdapter routes by wallet shape case-insensitively (0X… is EVM, not Solana)', async () => {
    const acct = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
    const sig = await acct.signMessage({ message });
    const m = new MockAdapter();
    expect(m.verifyWalletSignature(acct.address.toUpperCase(), message, sig)).toBe(true);
    expect(m.verifyWalletSignature(wallet, message, Buffer.from(sigBytes).toString('base64'))).toBe(true);
  });
});

describe('fee / indexer math', () => {
  it('toUnits keeps the integer part exact far above 2^53 base units', () => {
    const E18 = 10n ** 18n;
    expect(toUnits(1_234_567_890_123n * E18, 18)).toBe(1_234_567_890_123); // 1.2e30 raw: Number(raw)/1e18 would drift
    expect(toUnits(E18 + E18 / 2n, 18)).toBe(1.5);
    expect(toUnits(123_456n, 6)).toBe(0.123456);
    expect(toUnits(0n, 9)).toBe(0);
    expect(toUnits(-5n * 10n ** 6n, 6)).toBe(-5);
    expect(toUnits(7n, 0)).toBe(7);
    expect(() => toUnits(1n, -1)).toThrow(/decimals/);
    expect(() => toUnits(1n, 1.5)).toThrow(/decimals/);
  });

  it('toRaw handles large amounts, exponent-notation doubles and odd decimals without toFixed pitfalls', () => {
    expect(toRaw(1.5, 18)).toBe(1_500_000_000_000_000_000n);
    expect(toRaw(1e21, 18)).toBe(10n ** 39n); // (1e21).toFixed(18) is "1e+21": the old code threw
    expect(toRaw(0.000001, 6)).toBe(1n);
    expect(toRaw(0.0000001, 6)).toBe(0n); // rounds down
    expect(toRaw(123, 0)).toBe(123n);
    expect(toRaw(2.5, 30)).toBe(25n * 10n ** 29n); // decimals > 20 (toFixed caps at 100, drifts past 17)
    expect(toRaw(0.3, 18)).toBe(300_000_000_000_000_000n); // (0.3).toFixed(18) is "0.299999999999999989": the old code drifted
    expect(toRaw(0.1 + 0.2, 18)).toBe(300_000_000_000_000_040n); // the double really is 0.30000000000000004; truncated, not rounded
    expect(toRaw(1e-7, 6)).toBe(0n); // "1e-7" exponent form below 1e-6
    expect(() => toRaw(-1, 6)).toThrow(/invalid amount/);
    expect(() => toRaw(Number.NaN, 6)).toThrow(/invalid amount/);
    expect(() => toRaw(Number.POSITIVE_INFINITY, 6)).toThrow(/invalid amount/);
    // round trip
    for (const n of [0, 1, 0.5, 42.42, 1e9, 123456.789012]) expect(toUnits(toRaw(n, 9), 9)).toBeCloseTo(n, 9);
  });

  it('assertBps bounds share and slippage so a sweep cannot compute a negative treasury share', () => {
    expect(assertBps(5000, 'holderShareBps')).toBe(5000);
    expect(assertBps(0, 'x')).toBe(0);
    expect(assertBps(10_000, 'x')).toBe(10_000);
    expect(() => assertBps(10_001, 'holderShareBps')).toThrow(/holderShareBps.*0 and 10000/);
    expect(() => assertBps(-1, 'x')).toThrow();
    expect(() => assertBps(12.5, 'x')).toThrow();
    const a = new EvmAdapter({ holderShareBps: 20_000, tokenAddress: '0x0000000000000000000000000000000000000001', feeVault: '0x0000000000000000000000000000000000000002', decimals: 18, dryRun: true });
    // sweep validates before touching the chain, so the fake-less adapter throws the bps error, not an RPC one
    return expect(a.sweep()).rejects.toThrow(/holderShareBps/);
  });
});
