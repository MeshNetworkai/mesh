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
  {
    // Guest chat (routes/guest.ts): per-IP daily message counters that survive restarts, and a new
    // treasury kind `guest_chat` for what the free messages cost. SQLite cannot alter a CHECK, so the
    // treasury ledger is rebuilt in place (ids and rows preserved, indexes recreated).
    id: 12,
    sql: `
    CREATE TABLE IF NOT EXISTS guest_quota (
      ip_hash       TEXT PRIMARY KEY,
      window_start  INTEGER NOT NULL,
      used          INTEGER NOT NULL DEFAULT 0,
      updated_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS guest_quota_window ON guest_quota(window_start);

    CREATE TABLE treasury_ledger_v12 (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      kind        TEXT NOT NULL CHECK (kind IN ('fee_share','node_reward_accrual','buyback','ops','other','guest_chat')),
      usd_micros  INTEGER NOT NULL,
      ref         TEXT,
      created_at  INTEGER NOT NULL
    );
    INSERT INTO treasury_ledger_v12 (id, kind, usd_micros, ref, created_at)
      SELECT id, kind, usd_micros, ref, created_at FROM treasury_ledger;
    DROP TABLE treasury_ledger;
    ALTER TABLE treasury_ledger_v12 RENAME TO treasury_ledger;
    CREATE INDEX IF NOT EXISTS treasury_created ON treasury_ledger(created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS treasury_kind_ref ON treasury_ledger(kind, ref) WHERE ref IS NOT NULL;
    `,
  },
  {
    // Per-node concurrency (docs/LOADTEST.md bottleneck 2): `max_parallel` is what the node advertised on
    // register/heartbeat (capped by routing.maxParallelPerNode); `busy` becomes the count of running jobs.
    // Indexes for the hot aggregations run every minute by alerts.ts / every 10 s by /stats and /report.
    id: 13,
    sql: `
    ALTER TABLE nodes ADD COLUMN max_parallel INTEGER NOT NULL DEFAULT 1;
    CREATE INDEX IF NOT EXISTS ledger_kind_created ON credits_ledger(kind, created_at);
    CREATE INDEX IF NOT EXISTS jobs_wallet ON jobs(wallet);
    CREATE INDEX IF NOT EXISTS jobs_node_status ON jobs(node_id, status);
    `,
  },
  {
    // Credit marketplace (market.ts, routes/market.ts, docs/MARKETPLACE.md). A listing escrows credits out
    // of the seller's spendable balance (credits_ledger kind market_escrow; market_refund on cancel/expiry;
    // the buyer receives a market_buy row). Buyers pay from a prepaid USD balance (prepaid_ledger: topped
    // up by an admin today, by a USDG settlement adapter later); sellers are paid into the same balance
    // and withdraw through withdrawal_requests. The holders' share of each fee waits in pool_extra_micros
    // until the next epoch; the treasury share is a `market_fee` treasury row. SQLite cannot alter a
    // CHECK, so both ledgers are rebuilt in place (migration 12 pattern).
    id: 14,
    sql: `
    CREATE TABLE credits_ledger_v14 (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet           TEXT NOT NULL,
      delta_usd_micros INTEGER NOT NULL,
      kind             TEXT NOT NULL CHECK (kind IN ('distribution','usage','adjustment','starter','market_escrow','market_refund','market_buy')),
      ref              TEXT,
      created_at       INTEGER NOT NULL
    );
    INSERT INTO credits_ledger_v14 (id, wallet, delta_usd_micros, kind, ref, created_at)
      SELECT id, wallet, delta_usd_micros, kind, ref, created_at FROM credits_ledger;
    DROP TABLE credits_ledger;
    ALTER TABLE credits_ledger_v14 RENAME TO credits_ledger;
    CREATE INDEX IF NOT EXISTS ledger_wallet ON credits_ledger(wallet, id);
    CREATE UNIQUE INDEX IF NOT EXISTS ledger_distribution_unique ON credits_ledger(wallet, ref) WHERE kind = 'distribution';
    CREATE INDEX IF NOT EXISTS ledger_kind_created ON credits_ledger(kind, created_at);

    CREATE TABLE treasury_ledger_v14 (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      kind        TEXT NOT NULL CHECK (kind IN ('fee_share','node_reward_accrual','buyback','ops','other','guest_chat','market_fee')),
      usd_micros  INTEGER NOT NULL,
      ref         TEXT,
      created_at  INTEGER NOT NULL
    );
    INSERT INTO treasury_ledger_v14 (id, kind, usd_micros, ref, created_at)
      SELECT id, kind, usd_micros, ref, created_at FROM treasury_ledger;
    DROP TABLE treasury_ledger;
    ALTER TABLE treasury_ledger_v14 RENAME TO treasury_ledger;
    CREATE INDEX IF NOT EXISTS treasury_created ON treasury_ledger(created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS treasury_kind_ref ON treasury_ledger(kind, ref) WHERE ref IS NOT NULL;

    CREATE TABLE IF NOT EXISTS market_listings (
      id                    TEXT PRIMARY KEY,
      seller_wallet         TEXT NOT NULL,
      amount_micros         INTEGER NOT NULL,
      remaining_micros      INTEGER NOT NULL,
      discount_bps          INTEGER NOT NULL,
      price_micros_per_usd  INTEGER NOT NULL,
      status                TEXT NOT NULL CHECK (status IN ('open','filled','cancelled','expired')),
      created_at            INTEGER NOT NULL,
      expires_at            INTEGER NOT NULL,
      closed_at             INTEGER
    );
    CREATE INDEX IF NOT EXISTS market_listings_seller ON market_listings(seller_wallet, created_at);
    CREATE INDEX IF NOT EXISTS market_listings_book ON market_listings(status, discount_bps, created_at);
    CREATE INDEX IF NOT EXISTS market_listings_expiry ON market_listings(status, expires_at);

    CREATE TABLE IF NOT EXISTS market_fills (
      id                      TEXT PRIMARY KEY,
      listing_id              TEXT NOT NULL REFERENCES market_listings(id),
      buyer_wallet            TEXT NOT NULL,
      seller_wallet           TEXT NOT NULL,
      credits_micros          INTEGER NOT NULL,
      paid_micros             INTEGER NOT NULL,
      fee_micros              INTEGER NOT NULL,
      fee_to_holders_micros   INTEGER NOT NULL,
      fee_to_treasury_micros  INTEGER NOT NULL,
      discount_bps            INTEGER NOT NULL,
      settlement              TEXT NOT NULL CHECK (settlement IN ('prepaid','external')),
      settlement_ref          TEXT,
      created_at              INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS market_fills_buyer ON market_fills(buyer_wallet, created_at);
    CREATE INDEX IF NOT EXISTS market_fills_seller ON market_fills(seller_wallet, created_at);
    CREATE INDEX IF NOT EXISTS market_fills_listing ON market_fills(listing_id);
    CREATE INDEX IF NOT EXISTS market_fills_created ON market_fills(created_at);

    CREATE TABLE IF NOT EXISTS prepaid_ledger (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet        TEXT NOT NULL,
      delta_micros  INTEGER NOT NULL,
      kind          TEXT NOT NULL CHECK (kind IN ('topup','market_buy','market_sale','withdrawal','withdrawal_refund','adjustment')),
      ref           TEXT,
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS prepaid_wallet ON prepaid_ledger(wallet, id);
    CREATE UNIQUE INDEX IF NOT EXISTS prepaid_kind_ref ON prepaid_ledger(kind, ref) WHERE ref IS NOT NULL;

    CREATE TABLE IF NOT EXISTS withdrawal_requests (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet         TEXT NOT NULL,
      amount_micros  INTEGER NOT NULL,
      status         TEXT NOT NULL CHECK (status IN ('pending','paid')),
      note           TEXT,
      tx_ref         TEXT,
      created_at     INTEGER NOT NULL,
      paid_at        INTEGER
    );
    CREATE INDEX IF NOT EXISTS withdrawal_wallet ON withdrawal_requests(wallet, created_at);
    CREATE INDEX IF NOT EXISTS withdrawal_status ON withdrawal_requests(status, created_at);

    CREATE TABLE IF NOT EXISTS pool_extra_micros (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      source       TEXT NOT NULL,
      usd_micros   INTEGER NOT NULL,
      ref          TEXT NOT NULL UNIQUE,
      epoch_start  INTEGER,
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pool_extra_epoch ON pool_extra_micros(epoch_start);
    `,
  },
  {
    // Usage-revenue share (usage-share.ts, docs/PRICING.md): one row per paid request that produced a positive
    // margin while usageShare.enabled. holder_micros is mirrored into pool_extra_micros (source 'usage', same
    // ref) so the next epoch pays it out; treasury_micros is what stayed with the treasury. The table is the
    // audit trail /report and /stats aggregate; it is never written while the feature is off.
    id: 15,
    sql: `
    CREATE TABLE IF NOT EXISTS usage_share_log (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      source           TEXT NOT NULL CHECK (source IN ('network','upstream')),
      ref              TEXT NOT NULL UNIQUE,
      wallet           TEXT NOT NULL,
      model            TEXT NOT NULL,
      billed_micros    INTEGER NOT NULL,
      cost_micros      INTEGER NOT NULL,
      margin_micros    INTEGER NOT NULL,
      holder_micros    INTEGER NOT NULL,
      treasury_micros  INTEGER NOT NULL,
      created_at       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS usage_share_created ON usage_share_log(created_at);
    `,
  },
  {
    // Starter credits on first connect (starter.ts, config.starterCredits): one row per wallet that received
    // the automatic grant, so it is never paid twice; ip_hash (peppered, same scheme as guest_quota) backs the
    // per-IP daily cap. starter_settings holds the runtime enable/pause override set by POST /admin/starter/toggle.
    id: 16,
    sql: `
    CREATE TABLE IF NOT EXISTS starter_grants (
      wallet         TEXT PRIMARY KEY,
      amount_micros  INTEGER NOT NULL,
      granted_at     INTEGER NOT NULL,
      ip_hash        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS starter_grants_ip ON starter_grants(ip_hash, granted_at);
    CREATE TABLE IF NOT EXISTS starter_settings (
      key         TEXT PRIMARY KEY,
      value       TEXT NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    `,
  },
  {
    // Chain / token settings pasted in Admin → Token (chain-settings.ts): one row per overridable deploy-config
    // field (token, feeVault, creditPool, treasury, stable, swapRouter, priceFeed, deployBlock, excludeWallets).
    // Values are JSON. They take precedence over config/deploy.<network>.json when the adapter is built; every
    // change is also an admin_actions row ('chain-settings'), so the table is the current state and the
    // audit log is the history.
    id: 17,
    sql: `
    CREATE TABLE IF NOT EXISTS chain_settings (
      key         TEXT PRIMARY KEY,
      value       TEXT NOT NULL,
      updated_at  INTEGER NOT NULL,
      updated_by  TEXT
    );
    `,
  },
  {
    id: 18,
    sql: `
    CREATE TABLE IF NOT EXISTS market_deposits (
      tx_hash       TEXT PRIMARY KEY,
      wallet        TEXT NOT NULL,
      token         TEXT NOT NULL,
      amount_micros INTEGER NOT NULL,
      block_number  INTEGER NOT NULL,
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS market_deposits_wallet ON market_deposits(wallet, created_at);
    `,
  },
  {
    // Credit expiry, direct sales and the published reserve (expiry.ts, direct-sales.ts, reserve-report.ts,
    // docs/PRICING.md §5-7). credits_ledger gains `purchase` (credit bought from Mesh at face value) and
    // `expiry` (credit that lapsed creditExpiry.days after it landed); prepaid_ledger gains `credit_purchase`
    // (what the buyer paid for it). SQLite cannot alter a CHECK, so both ledgers are rebuilt in place
    // (migration 14 pattern). reserve_snapshots keeps what the credit-pool wallet held each time the
    // gateway read it (once per epoch); held_usd_micros is NULL when the adapter has no reserve to read
    // (the mock adapter before the token launch).
    id: 19,
    sql: `
    CREATE TABLE credits_ledger_v19 (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet           TEXT NOT NULL,
      delta_usd_micros INTEGER NOT NULL,
      kind             TEXT NOT NULL CHECK (kind IN ('distribution','usage','adjustment','starter','market_escrow','market_refund','market_buy','purchase','expiry')),
      ref              TEXT,
      created_at       INTEGER NOT NULL
    );
    INSERT INTO credits_ledger_v19 (id, wallet, delta_usd_micros, kind, ref, created_at)
      SELECT id, wallet, delta_usd_micros, kind, ref, created_at FROM credits_ledger;
    DROP TABLE credits_ledger;
    ALTER TABLE credits_ledger_v19 RENAME TO credits_ledger;
    CREATE INDEX IF NOT EXISTS ledger_wallet ON credits_ledger(wallet, id);
    CREATE UNIQUE INDEX IF NOT EXISTS ledger_distribution_unique ON credits_ledger(wallet, ref) WHERE kind = 'distribution';
    CREATE INDEX IF NOT EXISTS ledger_kind_created ON credits_ledger(kind, created_at);

    CREATE TABLE prepaid_ledger_v19 (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet        TEXT NOT NULL,
      delta_micros  INTEGER NOT NULL,
      kind          TEXT NOT NULL CHECK (kind IN ('topup','market_buy','market_sale','withdrawal','withdrawal_refund','adjustment','credit_purchase')),
      ref           TEXT,
      created_at    INTEGER NOT NULL
    );
    INSERT INTO prepaid_ledger_v19 (id, wallet, delta_micros, kind, ref, created_at)
      SELECT id, wallet, delta_micros, kind, ref, created_at FROM prepaid_ledger;
    DROP TABLE prepaid_ledger;
    ALTER TABLE prepaid_ledger_v19 RENAME TO prepaid_ledger;
    CREATE INDEX IF NOT EXISTS prepaid_wallet ON prepaid_ledger(wallet, id);
    CREATE UNIQUE INDEX IF NOT EXISTS prepaid_kind_ref ON prepaid_ledger(kind, ref) WHERE ref IS NOT NULL;

    CREATE TABLE IF NOT EXISTS reserve_snapshots (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      source            TEXT NOT NULL,
      asset             TEXT,
      held_usd_micros   INTEGER,
      stable_usd_micros INTEGER,
      other_usd_micros  INTEGER,
      note              TEXT,
      created_at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS reserve_snapshots_created ON reserve_snapshots(created_at);
    `,
  },
  {
    // Withdrawals are paid by hand, so somebody has to be told when one is requested. notified_at is set
    // once the operator channel (alerts.ts: Telegram, or the server log when no bot is set) has been sent the request; a
    // pending row without it is announced on the next alert check. Rows that predate this migration are
    // stamped so an upgrade does not replay old requests.
    id: 20,
    sql: `
    ALTER TABLE withdrawal_requests ADD COLUMN notified_at INTEGER;
    UPDATE withdrawal_requests SET notified_at = created_at;
    `,
  },
  {
    // Node rewards are paid as AI credits (node-payouts.ts, docs/NODE_PROTOCOL.md §7). credits_ledger gains
    // the kind `node_payout` (CHECK rebuild, migration 14 pattern); node_rewards.paid_ledger_id points at the
    // credits_ledger row that paid a reward (NULL = not paid yet), so a reward is paid exactly once.
    id: 21,
    sql: `
    CREATE TABLE credits_ledger_v21 (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet           TEXT NOT NULL,
      delta_usd_micros INTEGER NOT NULL,
      kind             TEXT NOT NULL CHECK (kind IN ('distribution','usage','adjustment','starter','market_escrow','market_refund','market_buy','purchase','expiry','node_payout')),
      ref              TEXT,
      created_at       INTEGER NOT NULL
    );
    INSERT INTO credits_ledger_v21 (id, wallet, delta_usd_micros, kind, ref, created_at)
      SELECT id, wallet, delta_usd_micros, kind, ref, created_at FROM credits_ledger;
    DROP TABLE credits_ledger;
    ALTER TABLE credits_ledger_v21 RENAME TO credits_ledger;
    CREATE INDEX IF NOT EXISTS ledger_wallet ON credits_ledger(wallet, id);
    CREATE UNIQUE INDEX IF NOT EXISTS ledger_distribution_unique ON credits_ledger(wallet, ref) WHERE kind = 'distribution';
    CREATE INDEX IF NOT EXISTS ledger_kind_created ON credits_ledger(kind, created_at);

    ALTER TABLE node_rewards ADD COLUMN paid_ledger_id INTEGER;
    CREATE INDEX IF NOT EXISTS node_rewards_unpaid ON node_rewards(wallet, created_at) WHERE paid_ledger_id IS NULL;
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
