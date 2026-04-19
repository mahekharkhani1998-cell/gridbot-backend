const cron       = require("node-cron");
const { logger } = require("../services/logger");
const db         = require("../services/database");
const { decrypt, encrypt } = require("../services/encryption");
const { refreshDhanToken } = require("../services/dhan");
const axios      = require("axios");
const readline   = require("readline");

// ─── Cron times — IST converted to UTC for cron ───────────────────────────────
// 8:00 AM IST  → 02:30 UTC → "30 2 * * 1-5"
// 6:00 AM IST  → 00:30 UTC → "30 0 * * 1-5"

function start() {
  // Token refresh — 8:00 AM IST weekdays
  cron.schedule("30 2 * * 1-5", async () => {
    const ist = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
    logger.info(`[SCHEDULER] Token refresh started | IST: ${ist}`);
    try {
      const clients = await db.getAll("SELECT id, broker, credentials_enc FROM clients WHERE active=TRUE");
      for (const client of clients) {
        try {
          const creds = decrypt(client.credentials_enc);
          if (!creds.totp_secret) {
            logger.warn(`Client ${client.id} (${client.broker}) has no TOTP secret — skipping`);
            continue;
          }
          let newToken = null;
          if (client.broker === "Dhan") {
            newToken = await refreshDhanToken(creds.client_id, creds.totp_secret);
          } else {
            logger.info(`Broker ${client.broker} refresh not yet implemented`);
            continue;
          }
          if (newToken) {
            creds.access_token = newToken;
            await db.query("UPDATE clients SET credentials_enc=$1, token_refreshed_at=NOW() WHERE id=$2", [encrypt(creds), client.id]);
            await db.query("INSERT INTO token_refresh_log (client_id, success, message) VALUES ($1,TRUE,$2)", [client.id, `Refreshed at ${ist} IST`]);
            logger.info(`✓ Token refreshed for client ${client.id}`);
          } else {
            await db.query("INSERT INTO token_refresh_log (client_id, success, message) VALUES ($1,FALSE,$2)", [client.id, `FAILED at ${ist} IST`]);
          }
        } catch (err) {
          logger.error(`Token refresh error for client ${client.id}: ${err.message}`);
        }
      }
    } catch (err) {
      logger.error(`Token refresh scheduler error: ${err.message}`);
    }
  }, { timezone: "UTC" });

  // Script master refresh — 6:00 AM IST weekdays
  cron.schedule("30 0 * * 1-5", async () => {
    const ist = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
    logger.info(`[SCHEDULER] Dhan script master refresh started | IST: ${ist}`);
    await refreshScriptMaster();
  }, { timezone: "UTC" });

  // App logs cleanup — 3:00 AM IST every day. Keep 7 days.
  cron.schedule("30 21 * * *", async () => {
    try {
      const r = await db.query("DELETE FROM app_logs WHERE created_at < NOW() - INTERVAL '7 days'");
      logger.info(`[SCHEDULER] app_logs cleanup: deleted ${r.rowCount || 0} old rows`);
    } catch (err) {
      logger.error(`app_logs cleanup error: ${err.message}`);
    }
  }, { timezone: "UTC" });

  logger.info("[SCHEDULER] Jobs registered: token-refresh@8:00AM IST, dhan-script-refresh@6:00AM IST (weekdays), logs-cleanup@3:00AM IST (daily)");
}

// ─── Dhan script master ──────────────────────────────────────────────────────
// The compact CSV (~150k rows) lives at images.dhan.co. We stream-parse it so
// memory stays bounded, batch-upsert in chunks of 1000.
const DHAN_SCRIP_URL = "https://images.dhan.co/api-data/api-scrip-master.csv";
const BATCH_SIZE     = 1000;

// Map Dhan's SEM_EXM_EXCH_ID + SEM_SEGMENT to our app's exchange-segment names.
function mapSegment(exch, seg) {
  const e = String(exch || "").toUpperCase();
  const s = String(seg  || "").toUpperCase();
  if (e === "NSE" && s === "E") return "NSE_EQ";
  if (e === "BSE" && s === "E") return "BSE_EQ";
  if (e === "NSE" && s === "D") return "NSE_FNO";
  if (e === "BSE" && s === "D") return "BSE_FNO";
  if (e === "NSE" && s === "C") return "NSE_CURRENCY";
  if (e === "BSE" && s === "C") return "BSE_CURRENCY";
  if (e === "MCX" && (s === "M" || s === "D")) return "MCX_COMM";
  if (e === "NSE" && s === "I") return "IDX_I";
  return null; // skip unknown segments
}

async function refreshScriptMaster() {
  let total = 0, kept = 0, batch = [];
  const colIdx = {}; // header → index

  try {
    const res = await axios.get(DHAN_SCRIP_URL, {
      responseType: "stream",
      timeout: 120000,
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    const rl = readline.createInterface({ input: res.data, crlfDelay: Infinity });

    for await (const line of rl) {
      total++;
      if (total === 1) {
        const headers = line.split(",").map(h => h.trim().toUpperCase());
        headers.forEach((h, i) => { colIdx[h] = i; });
        // Required columns
        const req = ["SEM_SMST_SECURITY_ID", "SEM_TRADING_SYMBOL", "SEM_EXM_EXCH_ID", "SEM_SEGMENT"];
        for (const r of req) {
          if (!(r in colIdx)) {
            logger.error(`Dhan CSV missing required column ${r}. Headers: ${headers.join("|")}`);
            return;
          }
        }
        continue;
      }

      // Compact CSV has no quoted fields with embedded commas for the columns we use.
      const cols = line.split(",");
      const secId   = (cols[colIdx.SEM_SMST_SECURITY_ID] || "").trim();
      const exch    = (cols[colIdx.SEM_EXM_EXCH_ID]      || "").trim();
      const seg     = (cols[colIdx.SEM_SEGMENT]          || "").trim();
      const segment = mapSegment(exch, seg);
      if (!secId || !segment) continue;

      const tradingSym = (cols[colIdx.SEM_TRADING_SYMBOL] || "").trim();
      const customSym  = colIdx.SEM_CUSTOM_SYMBOL !== undefined ? (cols[colIdx.SEM_CUSTOM_SYMBOL] || "").trim() : "";
      const isin       = colIdx.SEM_ISIN !== undefined ? (cols[colIdx.SEM_ISIN] || "").trim() : "";
      const lotSize    = colIdx.SEM_LOT_UNITS !== undefined ? parseInt(cols[colIdx.SEM_LOT_UNITS] || "1", 10) : 1;
      const expiry     = colIdx.SEM_EXPIRY_DATE !== undefined ? (cols[colIdx.SEM_EXPIRY_DATE] || "").trim() : "";
      const instrType  = colIdx.SEM_INSTRUMENT_NAME !== undefined ? (cols[colIdx.SEM_INSTRUMENT_NAME] || "").trim() : "";
      const name       = customSym || tradingSym;
      if (!name) continue;

      batch.push([segment, secId, name, tradingSym, isin, Number.isFinite(lotSize) ? lotSize : 1, expiry, instrType]);
      kept++;

      if (batch.length >= BATCH_SIZE) {
        await flushBatch(batch);
        batch = [];
      }
    }
    if (batch.length) await flushBatch(batch);

    const ist = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
    logger.info(`✓ Dhan script master updated: ${kept} scripts kept of ${total - 1} CSV rows | IST: ${ist}`);
  } catch (err) {
    logger.error(`Dhan script master refresh failed: ${err.message}`);
  }
}

async function flushBatch(batch) {
  // Build a single INSERT ... VALUES ($1,$2,...),($n,...) ON CONFLICT DO UPDATE
  const cols   = 8;
  const params = [];
  const tuples = batch.map((row, i) => {
    const base = i * cols;
    params.push(...row);
    return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},NOW())`;
  });
  const sql = `
    INSERT INTO script_master
      (exchange, security_id, name, trading_symbol, isin, lot_size, expiry, instrument, updated_at)
    VALUES ${tuples.join(",")}
    ON CONFLICT (exchange, security_id) DO UPDATE SET
      name           = EXCLUDED.name,
      trading_symbol = EXCLUDED.trading_symbol,
      isin           = EXCLUDED.isin,
      lot_size       = EXCLUDED.lot_size,
      expiry         = EXCLUDED.expiry,
      instrument     = EXCLUDED.instrument,
      updated_at     = NOW()
  `;
  await db.query(sql, params);
}

module.exports = { start, refreshScriptMaster };
