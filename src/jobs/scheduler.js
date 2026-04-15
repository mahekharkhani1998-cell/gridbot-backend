const cron       = require("node-cron");
const { logger } = require("../services/logger");
const db         = require("../services/database");
const { decrypt, encrypt } = require("../services/encryption");
const { refreshDhanToken } = require("../services/dhan");
const axios      = require("axios");

// ─── All times in IST (UTC+5:30) ─────────────────────────────────────────────
// Cron format: minute hour day month weekday
// 8:00 AM IST  = 2:30 AM UTC  → cron "30 2 * * 1-5"
// 6:00 AM IST  = 12:30 AM UTC → cron "30 0 * * 1-5"

function start() {

  // ── 1. TOKEN REFRESH — 8:00 AM IST every weekday ─────────────────────────
  cron.schedule("30 2 * * 1-5", async () => {
    const ist = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
    logger.info(`[SCHEDULER] Token refresh started | IST: ${ist}`);

    try {
      const clients = await db.getAll("SELECT id, broker, credentials_enc FROM clients WHERE active=TRUE");
      for (const client of clients) {
        try {
          const creds = decrypt(client.credentials_enc);

          // Only attempt if TOTP secret is present
          if (!creds.totp_secret) {
            logger.warn(`Client ${client.id} (${client.broker}) has no TOTP secret — skipping auto-refresh`);
            continue;
          }

          let newToken = null;

          // Broker-specific refresh logic
          if (client.broker === "Dhan") {
            newToken = await refreshDhanToken(creds.client_id, creds.totp_secret);
          } else {
            // Generic TOTP-based brokers (Zerodha, Angel One, Upstox, Fyers etc.)
            // Each broker has different login endpoint — add cases here as you onboard them
            logger.info(`Broker ${client.broker} refresh not yet implemented — add in scheduler.js`);
            continue;
          }

          if (newToken) {
            creds.access_token = newToken;
            const newEnc = encrypt(creds);
            await db.query("UPDATE clients SET credentials_enc=$1, token_refreshed_at=NOW() WHERE id=$2", [newEnc, client.id]);
            await db.query("INSERT INTO token_refresh_log (client_id, success, message) VALUES ($1, TRUE, $2)",
              [client.id, `Token refreshed at ${ist} IST`]);
            logger.info(`✓ Token refreshed for client ${client.id} at IST ${ist}`);
          } else {
            await db.query("INSERT INTO token_refresh_log (client_id, success, message) VALUES ($1, FALSE, $2)",
              [client.id, `Token refresh FAILED at ${ist} IST`]);
            logger.error(`✗ Token refresh FAILED for client ${client.id}`);
          }
        } catch (err) {
          logger.error(`Token refresh error for client ${client.id}: ${err.message}`);
        }
      }
    } catch (err) {
      logger.error(`Token refresh scheduler error: ${err.message}`);
    }
  }, { timezone: "UTC" }); // cron runs in UTC, times above are pre-converted

  // ── 2. SCRIPT MASTER REFRESH — 6:00 AM IST every weekday ─────────────────
  cron.schedule("30 0 * * 1-5", async () => {
    const ist = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
    logger.info(`[SCHEDULER] Script master refresh started | IST: ${ist}`);
    await refreshScriptMaster();
  }, { timezone: "UTC" });

  logger.info("[SCHEDULER] Jobs registered: token-refresh@8:00AM IST, script-refresh@6:00AM IST (weekdays)");
}

// ─── Fetch NSE/BSE master CSV and upsert into script_master table ─────────────
async function refreshScriptMaster() {
  // NSE Equity master CSV
  try {
    const res = await axios.get(
      "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv",
      { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 30000 }
    );
    const lines = res.data.split("\n").slice(1); // skip header
    let count = 0;
    for (const line of lines) {
      const cols = line.split(",");
      if (cols.length < 5) continue;
      const name       = cols[1]?.trim();
      const secId      = cols[4]?.trim(); // TOKEN / SECURITY_ID column
      const isin       = cols[2]?.trim();
      if (!name || !secId) continue;
      await db.query(`INSERT INTO script_master (exchange, security_id, name, isin, updated_at)
        VALUES ('NSE_EQ', $1, $2, $3, NOW())
        ON CONFLICT (exchange, security_id) DO UPDATE SET name=$2, isin=$3, updated_at=NOW()`,
        [secId, name, isin]);
      count++;
    }
    logger.info(`✓ NSE_EQ script master updated: ${count} scripts | IST: ${new Date().toLocaleString("en-IN",{timeZone:"Asia/Kolkata"})}`);
  } catch (err) {
    logger.error(`NSE script master refresh failed: ${err.message}`);
  }

  // BSE Equity — BSE provides JSON API
  try {
    const res = await axios.get(
      "https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w?Group=&Scripcode=&industry=&segment=Equity&status=Active",
      { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.bseindia.com" }, timeout: 30000 }
    );
    const list = res.data || [];
    let count  = 0;
    for (const s of list) {
      const name  = s.short_name || s.LONG_NAME;
      const secId = String(s.SCRIP_CD || s.scripcode);
      const isin  = s.ISIN_NUMBER || s.isinno || "";
      if (!name || !secId) continue;
      await db.query(`INSERT INTO script_master (exchange, security_id, name, isin, updated_at)
        VALUES ('BSE_EQ', $1, $2, $3, NOW())
        ON CONFLICT (exchange, security_id) DO UPDATE SET name=$2, isin=$3, updated_at=NOW()`,
        [secId, name, isin]);
      count++;
    }
    logger.info(`✓ BSE_EQ script master updated: ${count} scripts | IST: ${new Date().toLocaleString("en-IN",{timeZone:"Asia/Kolkata"})}`);
  } catch (err) {
    logger.error(`BSE script master refresh failed: ${err.message}`);
  }
}

module.exports = { start, refreshScriptMaster };
