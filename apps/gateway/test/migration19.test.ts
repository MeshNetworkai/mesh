import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from '../src/db.js';

// A database that already holds rows at schema 18 survives migration 19 (the ledger CHECK rebuild) intact.
describe('migration 19 on a populated database', () => {
  it('keeps every ledger row, the unique indexes and the autoincrement sequence', () => {
    const db = new Database(':memory:');
    migrate(db);
    // Rewind to schema 18: drop what 19 added and restore the old CHECKs, with data in place.
    db.exec(`
      DELETE FROM schema_migrations WHERE id = 19;
      DROP TABLE reserve_snapshots;
      CREATE TABLE credits_ledger_old (id INTEGER PRIMARY KEY AUTOINCREMENT, wallet TEXT NOT NULL, delta_usd_micros INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('distribution','usage','adjustment','starter','market_escrow','market_refund','market_buy')), ref TEXT, created_at INTEGER NOT NULL);
      DROP TABLE credits_ledger; ALTER TABLE credits_ledger_old RENAME TO credits_ledger;
      CREATE UNIQUE INDEX ledger_distribution_unique ON credits_ledger(wallet, ref) WHERE kind = 'distribution';
      CREATE TABLE prepaid_ledger_old (id INTEGER PRIMARY KEY AUTOINCREMENT, wallet TEXT NOT NULL, delta_micros INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('topup','market_buy','market_sale','withdrawal','withdrawal_refund','adjustment')), ref TEXT, created_at INTEGER NOT NULL);
      DROP TABLE prepaid_ledger; ALTER TABLE prepaid_ledger_old RENAME TO prepaid_ledger;
      CREATE UNIQUE INDEX prepaid_kind_ref ON prepaid_ledger(kind, ref) WHERE ref IS NOT NULL;
      INSERT INTO credits_ledger (wallet, delta_usd_micros, kind, ref, created_at) VALUES ('a', 5000000, 'distribution', 'epoch:1', 100), ('a', -1000, 'usage', 'req:1', 101), ('b', 2000000, 'starter', 'starter:auto', 102);
      INSERT INTO prepaid_ledger (wallet, delta_micros, kind, ref, created_at) VALUES ('a', 9000000, 'topup', 'pay-1', 100);
    `);
    expect(() => db.prepare(`INSERT INTO credits_ledger (wallet, delta_usd_micros, kind, created_at) VALUES ('a', -1, 'expiry', 1)`).run()).toThrow(/CHECK/);

    migrate(db); // applies 19 only

    expect(db.prepare(`SELECT id, wallet, delta_usd_micros AS d, kind, ref, created_at AS at FROM credits_ledger ORDER BY id`).all()).toEqual([
      { id: 1, wallet: 'a', d: 5000000, kind: 'distribution', ref: 'epoch:1', at: 100 },
      { id: 2, wallet: 'a', d: -1000, kind: 'usage', ref: 'req:1', at: 101 },
      { id: 3, wallet: 'b', d: 2000000, kind: 'starter', ref: 'starter:auto', at: 102 },
    ]);
    expect(db.prepare(`SELECT id, wallet, delta_micros AS d, kind, ref FROM prepaid_ledger`).all()).toEqual([{ id: 1, wallet: 'a', d: 9000000, kind: 'topup', ref: 'pay-1' }]);
    // new kinds are accepted, ids carry on, the old unique rules still hold
    expect(Number(db.prepare(`INSERT INTO credits_ledger (wallet, delta_usd_micros, kind, created_at) VALUES ('a', -1, 'expiry', 1)`).run().lastInsertRowid)).toBe(4);
    expect(Number(db.prepare(`INSERT INTO credits_ledger (wallet, delta_usd_micros, kind, created_at) VALUES ('a', 1, 'purchase', 1)`).run().lastInsertRowid)).toBe(5);
    expect(Number(db.prepare(`INSERT INTO prepaid_ledger (wallet, delta_micros, kind, ref, created_at) VALUES ('a', -1, 'credit_purchase', 'purchase:x', 1)`).run().lastInsertRowid)).toBe(2);
    expect(() => db.prepare(`INSERT INTO credits_ledger (wallet, delta_usd_micros, kind, ref, created_at) VALUES ('a', 1, 'distribution', 'epoch:1', 1)`).run()).toThrow(/UNIQUE/);
    expect(() => db.prepare(`INSERT INTO prepaid_ledger (wallet, delta_micros, kind, ref, created_at) VALUES ('a', 1, 'topup', 'pay-1', 1)`).run()).toThrow(/UNIQUE/);
    expect(() => db.prepare(`INSERT INTO credits_ledger (wallet, delta_usd_micros, kind, created_at) VALUES ('a', 1, 'bogus', 1)`).run()).toThrow(/CHECK/);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM reserve_snapshots`).get() as { n: number }).n).toBe(0);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM schema_migrations WHERE id = 19`).get() as { n: number }).n).toBe(1);
  });
});
