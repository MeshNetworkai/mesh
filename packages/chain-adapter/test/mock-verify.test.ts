import { describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { privateKeyToAccount } from 'viem/accounts';
import { MockAdapter } from '../src/mock.js';

describe('MockAdapter.verifyWalletSignature accepts real wallet signatures', () => {
  const message = 'localhost wants you to sign in with your wallet:\nnonce: abc';

  it('still accepts the mock test signature', () => {
    const a = new MockAdapter();
    expect(a.verifyWalletSignature('alice', message, MockAdapter.sign('alice', message))).toBe(true);
    expect(a.verifyWalletSignature('alice', message, 'nope')).toBe(false);
  });

  it('accepts a real ed25519 (Phantom-style) signature over the message bytes', () => {
    const kp = nacl.sign.keyPair();
    const wallet = bs58.encode(kp.publicKey);
    const sig = bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey));
    const a = new MockAdapter();
    expect(a.verifyWalletSignature(wallet, message, sig)).toBe(true);
    expect(a.verifyWalletSignature(wallet, message + 'x', sig)).toBe(false);
  });

  it('accepts a real EIP-191 (MetaMask-style) signature for a 0x wallet', async () => {
    const acct = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
    const sig = await acct.signMessage({ message });
    const a = new MockAdapter({ chain: 'evm' });
    expect(a.verifyWalletSignature(acct.address, message, sig)).toBe(true);
    expect(a.verifyWalletSignature(acct.address, message + 'x', sig)).toBe(false);
  });
  it('rejects the mock test signature when acceptMockSignatures is false (production), real signatures still pass', async () => {
    const acct = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
    const a = new MockAdapter({ chain: 'evm', acceptMockSignatures: false });
    expect(a.verifyWalletSignature(acct.address, message, MockAdapter.sign(acct.address, message))).toBe(false);
    expect(a.verifyWalletSignature(acct.address, message, await acct.signMessage({ message }))).toBe(true);
  });
});
