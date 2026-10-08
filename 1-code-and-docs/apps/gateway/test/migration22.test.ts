import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from '../src/db.js';
import { balanceMicros } from '../src/ledger.js';
import { prepaidBalanceMicros } from '../src/market.js';

const MIXED = '0xAbCdEf0000000000000000000000000000000001';
const LOWER = MIXED.toLowerCase();
const ONLY_MIXED = '0X00000000000000000000000000000000000000FE';
const SOLANA = 'So1anaKeyIsCaseSensitive1111111111111111111';

// A database that already holds wallets in more than one spelling is merged by migration 22 (canonical wallets).
describe('migration 22 on a database with mixed-case EVM wallets', () => {
  it('lowercases every stored EVM address, merging the accounts, and leaves other keys alone', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    db.exec(`
      DELETE FROM schema_migrations WHERE id = 22;
      INSERT INTO wallets (wallet, chain, created_at) VALUES ('${MIXED}', 'evm', 10), ('${LOWER}', 'evm', 20), ('${ONLY_MIXED}', 'evm', 30), ('${SOLANA}', 'solana', 40);
      INSERT INTO api_keys (key_hash, key_prefix, wallet, created_at) VALUES ('h1', 'mesh_1', '${MIXED}', 10), ('h2', 'mesh_2', '${ONLY_MIXED}', 30), ('h3', 'mesh_3', '${SOLANA}', 40);
      INSERT INTO credits_ledger (wallet, delta_usd_micros, kind, ref, created_at) VALUES
        ('${MIXED}', 2000000, 'starter', 'starter', 10),
        ('${LOWER}', 5000000, 'distribution', 'epoch:1', 20),
        ('${MIXED}', 7000000, 'distribution', 'epoch:1', 20),
        ('${SOLANA}', 1000000, 'adjustment', NULL, 40);
      INSERT INTO prepaid_ledger (wallet, delta_micros, kind, ref, created_at) VALUES ('${MIXED}', 3000000, 'topup', 'pay:1', 10), ('${LOWER}', 1000000, 'topup', 'pay:2', 20);
      INSERT INTO starter_grants (wallet, amount_micros, granted_at, ip_hash) VALUES ('${MIXED}', 2000000, 10, 'ip'), ('${LOWER}', 2000000, 20, 'ip'), ('${ONLY_MIXED}', 2000000, 30, 'ip');
      INSERT INTO admissions (wallet, admitted_at, via) VALUES ('${ONLY_MIXED}', 30, 'admin');
      INSERT INTO withdrawal_requests (wallet, amount_micros, status, created_at, notified_at) VALUES ('${MIXED}', 1000000, 'pending', 50, 50);
      INSERT INTO market_listings (id, seller_wallet, amount_micros, remaining_micros, discount_bps, price_micros_per_usd, status, created_at, expires_at) VALUES ('lst_1', '${MIXED}', 1, 1, 0, 1000000, 'open', 50, 60);
    `);
    migrate(db); // applies 22 only

    const wallets = (db.prepare(`SELECT wallet FROM wallets ORDER BY created_at`).all() as Array<{ wallet: string }>).map((r) => r.wallet);
    expect(wallets).toEqual([LOWER, ONLY_MIXED.toLowerCase(), SOLANA]);
    expect(db.prepare(`SELECT key_prefix, wallet FROM api_keys ORDER BY id`).all()).toEqual([
      { key_prefix: 'mesh_1', wallet: LOWER },
      { key_prefix: 'mesh_2', wallet: ONLY_MIXED.toLowerCase() },
      { key_prefix: 'mesh_3', wallet: SOLANA },
    ]);
    // The starter grant joined the lowercase account. The distribution that would collide with the lowercase
    // account's own row for the same epoch is not deleted: it stays under its old spelling.
    expect(balanceMicros(db, LOWER)).toBe(7_000_000);
    expect(balanceMicros(db, MIXED)).toBe(7_000_000);
    expect(balanceMicros(db, SOLANA)).toBe(1_000_000);
    expect(prepaidBalanceMicros(db, LOWER)).toBe(4_000_000);
    expect(prepaidBalanceMicros(db, MIXED)).toBe(0);
    // Unique per wallet: the twin that already existed wins, the single spelling moves.
    expect((db.prepare(`SELECT wallet FROM starter_grants ORDER BY granted_at`).all() as Array<{ wallet: string }>).map((r) => r.wallet)).toEqual([MIXED, LOWER, ONLY_MIXED.toLowerCase()]);
    expect(db.prepare(`SELECT wallet FROM admissions`).all()).toEqual([{ wallet: ONLY_MIXED.toLowerCase() }]);
    expect(db.prepare(`SELECT wallet FROM withdrawal_requests`).all()).toEqual([{ wallet: LOWER }]);
    expect(db.prepare(`SELECT seller_wallet FROM market_listings`).all()).toEqual([{ seller_wallet: LOWER }]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('is a no-op on a database that only holds canonical wallets', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    db.exec(`
      DELETE FROM schema_migrations WHERE id = 22;
      INSERT INTO wallets (wallet, chain, created_at) VALUES ('${LOWER}', 'evm', 20), ('${SOLANA}', 'solana', 40);
      INSERT INTO credits_ledger (wallet, delta_usd_micros, kind, ref, created_at) VALUES ('${LOWER}', 5000000, 'distribution', 'epoch:1', 20);
    `);
    migrate(db);
    expect(db.prepare(`SELECT wallet FROM wallets ORDER BY created_at`).all()).toEqual([{ wallet: LOWER }, { wallet: SOLANA }]);
    expect(balanceMicros(db, LOWER)).toBe(5_000_000);
  });
});
