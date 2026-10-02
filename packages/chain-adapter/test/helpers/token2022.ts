/** Encoders for Token-2022 account/mint data with TransferFee extensions (test fixtures). */
import { PublicKey } from '@solana/web3.js';
import {
  ACCOUNT_SIZE,
  AccountLayout,
  AccountState,
  AccountType,
  ExtensionType,
  LENGTH_SIZE,
  MINT_SIZE,
  MintLayout,
  TYPE_SIZE,
  TransferFeeAmountLayout,
  TransferFeeConfigLayout,
  TRANSFER_FEE_AMOUNT_SIZE,
  TRANSFER_FEE_CONFIG_SIZE,
} from '@solana/spl-token';

function tlv(type: ExtensionType, body: Buffer): Buffer {
  const head = Buffer.alloc(TYPE_SIZE + LENGTH_SIZE);
  head.writeUInt16LE(type, 0);
  head.writeUInt16LE(body.length, TYPE_SIZE);
  return Buffer.concat([head, body]);
}

export function encodeTokenAccount(p: { mint: PublicKey; owner: PublicKey; amount: bigint; withheld?: bigint }): Buffer {
  const base = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode(
    {
      mint: p.mint,
      owner: p.owner,
      amount: p.amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: AccountState.Initialized,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    base,
  );
  const fee = Buffer.alloc(TRANSFER_FEE_AMOUNT_SIZE);
  TransferFeeAmountLayout.encode({ withheldAmount: p.withheld ?? 0n }, fee);
  return Buffer.concat([base, Buffer.from([AccountType.Account]), tlv(ExtensionType.TransferFeeAmount, fee)]);
}

export function encodeMint(p: {
  decimals: number;
  supply: bigint;
  authority: PublicKey;
  feeBps: number;
  maxFee: bigint;
  withheld?: bigint;
}): Buffer {
  const base = Buffer.alloc(ACCOUNT_SIZE); // mint base is padded to account size before the type byte
  MintLayout.encode(
    {
      mintAuthorityOption: 1,
      mintAuthority: p.authority,
      supply: p.supply,
      decimals: p.decimals,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    base,
  );
  if (MINT_SIZE > ACCOUNT_SIZE) throw new Error('unexpected layout sizes');
  const cfg = Buffer.alloc(TRANSFER_FEE_CONFIG_SIZE);
  const fee = { epoch: 0n, maximumFee: p.maxFee, transferFeeBasisPoints: p.feeBps };
  TransferFeeConfigLayout.encode(
    {
      transferFeeConfigAuthority: p.authority,
      withdrawWithheldAuthority: p.authority,
      withheldAmount: p.withheld ?? 0n,
      olderTransferFee: fee,
      newerTransferFee: fee,
    },
    cfg,
  );
  return Buffer.concat([base, Buffer.from([AccountType.Mint]), tlv(ExtensionType.TransferFeeConfig, cfg)]);
}

export const b64 = (b: Buffer) => b.toString('base64');
