import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from '../src/db.js';

// A database that already holds withdrawal requests survives migration 20 (withdrawal announcements) without replaying them.
describe('migration 20 on a database with withdrawals', () => {
  it('adds notified_at and stamps the rows that are already there, so an upgrade does not replay old requests', () => {
    const db = new Database(':memory:');
    migrate(db);
    db.exec(`
      DELETE FROM schema_migrations WHERE id = 20;
      ALTER TABLE withdrawal_requests DROP COLUMN notified_at;
      INSERT INTO withdrawal_requests (wallet, amount_micros, status, created_at) VALUES ('a', 5000000, 'pending', 100), ('b', 2000000, 'paid', 200);
    `);
    migrate(db); // applies 20 only
    expect(db.prepare(`SELECT id, wallet, status, notified_at FROM withdrawal_requests ORDER BY id`).all()).toEqual([
      { id: 1, wallet: 'a', status: 'pending', notified_at: 100 },
      { id: 2, wallet: 'b', status: 'paid', notified_at: 200 },
    ]);
    // a request made after the upgrade starts unannounced
    db.prepare(`INSERT INTO withdrawal_requests (wallet, amount_micros, status, created_at) VALUES ('c', 1, 'pending', 300)`).run();
    expect((db.prepare(`SELECT notified_at FROM withdrawal_requests WHERE wallet = 'c'`).get() as { notified_at: number | null }).notified_at).toBeNull();
  });
});
