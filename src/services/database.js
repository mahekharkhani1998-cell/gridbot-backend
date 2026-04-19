const { Pool } = require("pg");
const { logger } = require("./logger");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ─── All CREATE TABLE statements ──────────────────────────────────────────────
const MIGRATIONS = `
  CREATE TABLE IF NOT EXISTS users (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email       TEXT UNIQUE NOT NULL,
    password    TEXT NOT NULL,
    name        TEXT NOT NULL,
    role        TEXT DEFAULT 'admin',
    created_at  TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS clients (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    broker          TEXT NOT NULL,
    segment         TEXT DEFAULT 'NSE_EQ',
    note            TEXT,
    -- AES-256 encrypted JSON blob: { client_id, access_token, api_key, api_secret, totp_secret, ... }
    credentials_enc TEXT NOT NULL,
    active          BOOLEAN DEFAULT TRUE,
    token_refreshed_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS bots (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id       UUID REFERENCES clients(id) ON DELETE CASCADE,
    exchange        TEXT NOT NULL,
    ticker          TEXT NOT NULL,
    security_id     TEXT NOT NULL,
    isin            TEXT,
    product         TEXT DEFAULT 'CNC',
    expiry          TEXT,
    grid_step       NUMERIC NOT NULL,
    tp_interval     NUMERIC DEFAULT 0,
    trade_qty       INTEGER NOT NULL,
    initial_qty     INTEGER DEFAULT 0,
    start_price     NUMERIC NOT NULL,
    lower_limit     NUMERIC NOT NULL,
    upper_limit     NUMERIC NOT NULL,
    status          TEXT DEFAULT 'IDLE',
    -- Runtime state (updated live)
    position_qty    INTEGER DEFAULT 0,
    last_fill_price NUMERIC,
    buy_order_id    TEXT,
    sell_order_id   TEXT,
    buy_price       NUMERIC,
    sell_price      NUMERIC,
    waiting_reentry BOOLEAN DEFAULT FALSE,
    realized_pnl    NUMERIC DEFAULT 0,
    total_cycles    INTEGER DEFAULT 0,
    killed_at       TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS orders (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id          UUID REFERENCES bots(id) ON DELETE CASCADE,
    client_id       UUID REFERENCES clients(id),
    broker_order_id TEXT,
    exchange        TEXT,
    security_id     TEXT,
    ticker          TEXT,
    side            TEXT NOT NULL,
    order_type      TEXT DEFAULT 'LIMIT',
    product         TEXT DEFAULT 'CNC',
    qty             INTEGER NOT NULL,
    price           NUMERIC,
    fill_price      NUMERIC,
    status          TEXT DEFAULT 'PENDING',
    -- IST timestamp stored as timestamptz (DB converts to UTC, display in IST)
    placed_at       TIMESTAMPTZ DEFAULT NOW(),
    filled_at       TIMESTAMPTZ,
    cancelled_at    TIMESTAMPTZ,
    raw_response    JSONB
  );

  CREATE TABLE IF NOT EXISTS script_master (
    exchange        TEXT NOT NULL,
    security_id     TEXT NOT NULL,
    name            TEXT NOT NULL,
    trading_symbol  TEXT,
    isin            TEXT,
    sector          TEXT,
    lot_size        INTEGER DEFAULT 1,
    expiry          TEXT,
    instrument      TEXT,
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (exchange, security_id)
  );

  -- Add columns for installations created before the schema change
  ALTER TABLE script_master ADD COLUMN IF NOT EXISTS trading_symbol TEXT;
  ALTER TABLE script_master ADD COLUMN IF NOT EXISTS expiry         TEXT;
  ALTER TABLE script_master ADD COLUMN IF NOT EXISTS instrument     TEXT;

  CREATE TABLE IF NOT EXISTS token_refresh_log (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id   UUID REFERENCES clients(id),
    success     BOOLEAN,
    message     TEXT,
    refreshed_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS app_logs (
    id            BIGSERIAL PRIMARY KEY,
    level         TEXT NOT NULL,
    message       TEXT NOT NULL,
    ist_timestamp TEXT,
    meta          JSONB,
    created_at    TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_app_logs_created  ON app_logs(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_app_logs_level    ON app_logs(level);

  CREATE TABLE IF NOT EXISTS client_buckets (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL UNIQUE,
    description TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS bucket_members (
    bucket_id  UUID REFERENCES client_buckets(id) ON DELETE CASCADE,
    client_id  UUID REFERENCES clients(id)        ON DELETE CASCADE,
    PRIMARY KEY (bucket_id, client_id)
  );
  CREATE INDEX IF NOT EXISTS idx_bucket_members_client ON bucket_members(client_id);

  CREATE INDEX IF NOT EXISTS idx_orders_bot_id    ON orders(bot_id);
  CREATE INDEX IF NOT EXISTS idx_orders_client_id ON orders(client_id);
  CREATE INDEX IF NOT EXISTS idx_orders_status    ON orders(status);
  CREATE INDEX IF NOT EXISTS idx_bots_client_id   ON bots(client_id);
  CREATE INDEX IF NOT EXISTS idx_bots_status      ON bots(status);
  CREATE INDEX IF NOT EXISTS idx_script_name        ON script_master(name);
  CREATE INDEX IF NOT EXISTS idx_script_tradingsym  ON script_master(trading_symbol);
  CREATE INDEX IF NOT EXISTS idx_script_exch_name   ON script_master(exchange, name);
`;

async function connect() {
  await pool.query("SELECT 1");
}

async function migrate() {
  await pool.query(MIGRATIONS);
  logger.info("DB migration complete");
}

async function query(sql, params = []) {
  try {
    const res = await pool.query(sql, params);
    return res;
  } catch (err) {
    logger.error("DB query error:", { sql: sql.slice(0, 80), err: err.message });
    throw err;
  }
}

async function getOne(sql, params = []) {
  const res = await query(sql, params);
  return res.rows[0] || null;
}

async function getAll(sql, params = []) {
  const res = await query(sql, params);
  return res.rows;
}

// IST helper — converts any date to IST string for display
function toIST(date) {
  return new Date(date).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

module.exports = { connect, migrate, query, getOne, getAll, pool, toIST };
