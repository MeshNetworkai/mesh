import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = Database.Database;

const MIGRATIONS: Array<{ id: number; sql: string }> = [
  {
    id: 1,
    sql: `
    CREATE TABLE IF NOT EXISTS wallets (
      wallet      TEXT PRIMARY KEY,
      chain       TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      last_login  INTEGER
    );
    CREATE TABLE IF NOT EXISTS api_keys (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      key_hash    TEXT NOT NULL UNIQUE,
      key_prefix  TEXT NOT NULL,
      wallet      TEXT NOT NULL REFERENCES wallets(wallet),
      label       TEXT,
      created_at  INTEGER NOT NULL,
      revoked     INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS api_keys_wallet ON api_keys(wallet);
    CREATE TABLE IF NOT EXISTS credits_ledger (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet           TEXT NOT NULL,
      delta_usd_micros INTEGER NOT NULL,
      kind             TEXT NOT NULL CHECK (kind IN ('distribution','usage','adjustment','starter')),
      ref              TEXT,
      created_at       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ledger_wallet ON credits_ledger(wallet, id);
    CREATE UNIQUE INDEX IF NOT EXISTS ledger_distribution_unique
      ON credits_ledger(wallet, ref) WHERE kind = 'distribution';
    CREATE TABLE IF NOT EXISTS epochs (
      epoch_start             INTEGER PRIMARY KEY,
      epoch_end               INTEGER NOT NULL,
      fees_usd_micros         INTEGER NOT NULL,
      holder_pool_usd_micros  INTEGER NOT NULL,
      treasury_usd_micros     INTEGER NOT NULL,
      eligible_holders        INTEGER NOT NULL,
      fee_tx_id               TEXT,
      status                  TEXT NOT NULL CHECK (status IN ('complete','empty','failed')),
      created_at              INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS requests_log (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      api_key_id         INTEGER NOT NULL,
      wallet             TEXT NOT NULL,
      model              TEXT NOT NULL,
      prompt_tokens      INTEGER NOT NULL DEFAULT 0,
      completion_tokens  INTEGER NOT NULL DEFAULT 0,
      cost_usd_micros    INTEGER NOT NULL DEFAULT 0,
      upstream           TEXT NOT NULL,
      latency_ms         INTEGER NOT NULL,
      stream             INTEGER NOT NULL DEFAULT 0,
      created_at         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS requests_created ON requests_log(created_at);
    CREATE TABLE IF NOT EXISTS nodes (
      node_id     TEXT PRIMARY KEY,
      wallet      TEXT NOT NULL,
      url         TEXT NOT NULL,
      models      TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      last_seen   INTEGER NOT NULL
    );
    `,
  },
  {
    id: 2,
    sql: `
    ALTER TABLE api_keys ADD COLUMN name TEXT;
    ALTER TABLE api_keys ADD COLUMN spend_limit_usd_micros INTEGER;
    ALTER TABLE api_keys ADD COLUMN spent_usd_micros INTEGER NOT NULL DEFAULT 0;
    UPDATE api_keys SET name = label WHERE name IS NULL;
    CREATE INDEX IF NOT EXISTS requests_key_created ON requests_log(api_key_id, created_at);

    CREATE TABLE IF NOT EXISTS auth_nonces (
      nonce       TEXT PRIMARY KEY,
      wallet      TEXT NOT NULL,
      domain      TEXT NOT NULL,
      issued_at   INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL,
      used_at     INTEGER
    );
    CREATE INDEX IF NOT EXISTS auth_nonces_wallet ON auth_nonces(wallet, issued_at);

    CREATE TABLE IF NOT EXISTS admin_actions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      action      TEXT NOT NULL,
      payload     TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS errors_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      route       TEXT NOT NULL,
      status      INTEGER NOT NULL,
      code        TEXT NOT NULL,
      message     TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS errors_created ON errors_log(created_at);

    ALTER TABLE nodes ADD COLUMN ram_gb REAL;
    ALTER TABLE nodes ADD COLUMN chip TEXT;
    ALTER TABLE nodes ADD COLUMN busy INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    // Node protocol: bearer tokens, heartbeat history, job queue, node reward ledger.
    id: 3,
    sql: `
    ALTER TABLE nodes ADD COLUMN token_hash TEXT;
    ALTER TABLE nodes ADD COLUMN agent_version TEXT;
    ALTER TABLE nodes ADD COLUMN load_avg REAL;
    CREATE INDEX IF NOT EXISTS nodes_wallet ON nodes(wallet);
    CREATE INDEX IF NOT EXISTS nodes_last_seen ON nodes(last_seen);

    CREATE TABLE IF NOT EXISTS heartbeats (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id   TEXT NOT NULL,
      ts        INTEGER NOT NULL,
      busy      INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS heartbeats_node_ts ON heartbeats(node_id, ts);
    CREATE INDEX IF NOT EXISTS heartbeats_ts ON heartbeats(ts);

    CREATE TABLE IF NOT EXISTS jobs (
      job_id            TEXT PRIMARY KEY,
      model             TEXT NOT NULL,
      tag               TEXT NOT NULL,
      wallet            TEXT NOT NULL,
      api_key_id        INTEGER,
      status            TEXT NOT NULL CHECK (status IN ('queued','running','done','failed','fallback')),
      payload           TEXT NOT NULL,
      max_tokens        INTEGER NOT NULL,
      deadline_ms       INTEGER NOT NULL,
      node_id           TEXT,
      exclude_node_id   TEXT,
      parent_job_id     TEXT,
      attempt           INTEGER NOT NULL DEFAULT 1,
      prompt_tokens     INTEGER,
      completion_tokens INTEGER,
      finish_reason     TEXT,
      error             TEXT,
      node_fault        INTEGER NOT NULL DEFAULT 0,
      created_at        INTEGER NOT NULL,
      created_ms        INTEGER NOT NULL,
      claimed_ms        INTEGER,
      first_chunk_ms    INTEGER,
      finished_ms       INTEGER
    );
    CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status, tag, created_ms);
    CREATE INDEX IF NOT EXISTS jobs_node_created ON jobs(node_id, created_at);
    CREATE INDEX IF NOT EXISTS jobs_created ON jobs(created_at);

    CREATE TABLE IF NOT EXISTS node_rewards (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet      TEXT NOT NULL,
      node_id     TEXT NOT NULL,
      job_id      TEXT,
      kind        TEXT NOT NULL DEFAULT 'node_reward' CHECK (kind IN ('node_reward','payout')),
      tokens      INTEGER NOT NULL DEFAULT 0,
      usd_micros  INTEGER NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS node_rewards_wallet ON node_rewards(wallet, id);
    CREATE INDEX IF NOT EXISTS node_rewards_node_created ON node_rewards(node_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS node_rewards_job ON node_rewards(job_id) WHERE job_id IS NOT NULL;
    `,
  },
  {
    // Holding-age cache (when the adapter cannot report holdSinceTs) + treasury ledger for /report.
    id: 4,
    sql: `
    CREATE TABLE IF NOT EXISTS holder_age (
      wallet        TEXT PRIMARY KEY,
      hold_since    INTEGER NOT NULL,
      last_balance  REAL NOT NULL,
      updated_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS treasury_ledger (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      kind        TEXT NOT NULL CHECK (kind IN ('fee_share','node_reward_accrual','buyback','ops','other')),
      usd_micros  INTEGER NOT NULL,
      ref         TEXT,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS treasury_created ON treasury_ledger(created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS treasury_kind_ref ON treasury_ledger(kind, ref) WHERE ref IS NOT NULL;
    `,
  },
  {
    // One-time node link codes: the wallet signs in the browser (POST /nodes/link), the Mac registers with the code.
    id: 5,
    sql: `
    CREATE TABLE IF NOT EXISTS node_link_codes (
      code_hash     TEXT PRIMARY KEY,
      wallet        TEXT NOT NULL,
      chain         TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      expires_at    INTEGER NOT NULL,
      used_at       INTEGER,
      used_node_id  TEXT
    );
    CREATE INDEX IF NOT EXISTS node_link_codes_wallet ON node_link_codes(wallet, expires_at);
    `,
  },
  {
    // Network credits: what the upstream would have charged (list price) and what the wallet saved
    // because a Mesh node served the request. Upstream-served rows have list == cost, saved == 0.
    id: 6,
    sql: `
    ALTER TABLE requests_log ADD COLUMN list_cost_usd_micros INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE requests_log ADD COLUMN saved_usd_micros INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS requests_wallet_created ON requests_log(wallet, created_at);
    `,
  },
  {
    // Pre-launch points programme + referrals (points.ts, routes/points.ts, routes/referrals.ts).
    // points_ledger is append-only; (wallet, kind, ref) is unique so every source row is awarded once.
    id: 7,
    sql: `
    CREATE TABLE IF NOT EXISTS points_ledger (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet      TEXT NOT NULL,
      kind        TEXT NOT NULL CHECK (kind IN ('credits','usage','node','referral_signup','referral_share','adjustment')),
      points      REAL NOT NULL,
      ref         TEXT,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS points_wallet_created ON points_ledger(wallet, created_at);
    CREATE INDEX IF NOT EXISTS points_created ON points_ledger(created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS points_wallet_kind_ref ON points_ledger(wallet, kind, ref) WHERE ref IS NOT NULL;
    CREATE VIEW IF NOT EXISTS points_balances AS
      SELECT wallet, SUM(points) AS points, COUNT(*) AS entries, MAX(created_at) AS last_at
      FROM points_ledger GROUP BY wallet;

    -- Cursor per source ledger so awarding is an incremental scan (see syncPoints).
    CREATE TABLE IF NOT EXISTS points_sync (
      source   TEXT PRIMARY KEY,
      last_id  INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS referral_codes (
      wallet      TEXT PRIMARY KEY,
      code        TEXT NOT NULL UNIQUE,
      created_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS referrals (
      wallet      TEXT PRIMARY KEY,
      referrer    TEXT NOT NULL,
      code        TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS referrals_referrer ON referrals(referrer, created_at);
    `,
  },
  {
    // Request privacy tiers (docs/PRIVACY.md): per-key default tier, the tier a job was queued under
    // (trusted jobs are only claimable by trusted nodes), and the operator pledge per node.
    id: 8,
    sql: `
    ALTER TABLE api_keys ADD COLUMN privacy TEXT;
    ALTER TABLE jobs ADD COLUMN privacy TEXT NOT NULL DEFAULT 'network';
    ALTER TABLE nodes ADD COLUMN pledge_at INTEGER;
    ALTER TABLE nodes ADD COLUMN pledge_signature TEXT;
    ALTER TABLE nodes ADD COLUMN pledge_chain TEXT;
    `,
  },
  {
    // Owner rule for the trusted tier (docs/PRIVACY.md §2): the wallet that made the request. A node
    // whose reward wallet equals it may claim the trusted job. Internal only: never part of the node-facing
    // job view (routes/nodes.ts jobView / JOB_VIEW_FIELDS).
    id: 9,
    sql: `
    ALTER TABLE jobs ADD COLUMN requester_wallet TEXT;
    `,
  },
  {
    // Spot-check verification (verification.ts, docs/NODE_PROTOCOL.md §10): a sampled job is re-run on a
    // second node / the upstream and compared. `jobs.check_of` marks the re-run (internal, never in the
    // node-facing job view). A mismatch withholds the primary node's reward (node_rewards.status) and
    // repeated mismatches quarantine the node (nodes.quarantined_at) until an admin clears it.
    id: 10,
    sql: `
    ALTER TABLE jobs ADD COLUMN check_of TEXT;
    ALTER TABLE nodes ADD COLUMN quarantined_at INTEGER;
    ALTER TABLE nodes ADD COLUMN quarantine_reason TEXT;
    ALTER TABLE node_rewards ADD COLUMN status TEXT NOT NULL DEFAULT 'accrued';
    CREATE TABLE IF NOT EXISTS verifications (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id        TEXT NOT NULL,
      check_job_id  TEXT,
      primary_node  TEXT NOT NULL,
      check_node    TEXT NOT NULL,
      score         REAL,
      verdict       TEXT NOT NULL CHECK (verdict IN ('ok','suspect','mismatch','inconclusive')),
      reasons       TEXT NOT NULL DEFAULT '[]',
      primary_tokens INTEGER,
      check_tokens  INTEGER,
      created_at    INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS verifications_job ON verifications(job_id);
    CREATE INDEX IF NOT EXISTS verifications_primary ON verifications(primary_node, created_at);
    `,
  },
  {
    // Public beta gating (routes/auth.ts, routes/admin.ts, docs/RUNBOOK.md): waitlist, invite codes and
    // the wallets admitted so far. Codes are stored in clear so an admin can read them back to send.
    id: 11,
    sql: `
    CREATE TABLE IF NOT EXISTS waitlist (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet      TEXT,
      email       TEXT,
      created_at  INTEGER NOT NULL,
      invited_at  INTEGER,
      code        TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS waitlist_wallet ON waitlist(wallet) WHERE wallet IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS waitlist_email ON waitlist(email) WHERE email IS NOT NULL;
    CREATE INDEX IF NOT EXISTS waitlist_created ON waitlist(invited_at, created_at);
    CREATE TABLE IF NOT EXISTS invite_codes (
      code        TEXT PRIMARY KEY,
      uses_left   INTEGER NOT NULL,
      created_by  TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admissions (
      wallet       TEXT PRIMARY KEY,
      admitted_at  INTEGER NOT NULL,
      via          TEXT NOT NULL,
      code         TEXT
    );
    `,
  },
];

/** Cheap liveness probe used by /health. */
export function dbOk(db: Db): boolean {
  try {
    return (db.prepare('SELECT 1 AS one').get() as { one: number }).one === 1;
  } catch {
    return false;
  }
}

export function recordError(db: Db, e: { route: string; status: number; code: string; message: string }): void {
  try {
    db.prepare(`INSERT INTO errors_log (route, status, code, message, created_at) VALUES (?, ?, ?, ?, ?)`).run(
      e.route.slice(0, 200),
      e.status,
      e.code.slice(0, 64),
      e.message.slice(0, 500),
      nowSec(),
    );
  } catch {
    /* never let error bookkeeping fail a request */
  }
}

export function recordAdminAction(db: Db, action: string, payload: unknown): number {
  const res = db
    .prepare(`INSERT INTO admin_actions (action, payload, created_at) VALUES (?, ?, ?)`)
    .run(action, JSON.stringify(payload ?? null), nowSec());
  return Number(res.lastInsertRowid);
}

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`);
  const applied = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as Array<{ id: number }>).map((r) => r.id),
  );
  const apply = db.transaction((m: { id: number; sql: string }) => {
    db.exec(m.sql);
    db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(m.id, nowSec());
  });
  for (const m of MIGRATIONS) if (!applied.has(m.id)) apply(m);
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
