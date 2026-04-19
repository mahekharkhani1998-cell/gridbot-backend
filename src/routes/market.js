const router = require("express").Router();
const db     = require("../services/database");
const auth   = require("../middleware/auth");
const { refreshScriptMaster } = require("../jobs/scheduler");

// GET /api/market/scripts?exchange=NSE_EQ&q=RELIA&limit=50
// Searches both trading_symbol and name (case-insensitive). security_id matches as a prefix.
router.get("/scripts", auth, async (req, res) => {
  try {
    const { exchange, q } = req.query;
    const limit = Math.min(parseInt(req.query.limit || "50", 10) || 50, 200);
    if (!exchange) return res.status(400).json({ error: "exchange required" });

    let sql, params;
    if (q && q.trim()) {
      const term = q.trim().toUpperCase();
      sql = `
        SELECT exchange, security_id, name, trading_symbol, isin, lot_size, expiry, instrument
        FROM script_master
        WHERE exchange = $1
          AND (
            UPPER(trading_symbol) LIKE $2 OR
            UPPER(name)           LIKE $2 OR
            security_id           LIKE $3
          )
        ORDER BY
          CASE WHEN UPPER(trading_symbol) = $4 THEN 0
               WHEN UPPER(trading_symbol) LIKE $5 THEN 1
               ELSE 2 END,
          name
        LIMIT $6`;
      params = [exchange, `%${term}%`, `${term}%`, term, `${term}%`, limit];
    } else {
      sql = `
        SELECT exchange, security_id, name, trading_symbol, isin, lot_size, expiry, instrument
        FROM script_master
        WHERE exchange = $1
        ORDER BY name
        LIMIT $2`;
      params = [exchange, limit];
    }

    const rows = await db.getAll(sql, params);
    res.json({ ok: true, scripts: rows, total: rows.length, exchange });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/market/scripts/count — useful for the UI footer
router.get("/scripts/count", auth, async (_req, res) => {
  try {
    const rows = await db.getAll(`
      SELECT exchange, COUNT(*)::int AS n, MAX(updated_at) AS updated_at
      FROM script_master GROUP BY exchange ORDER BY exchange`);
    res.json({ ok: true, counts: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/market/refresh — manually trigger script master refresh
router.post("/refresh", auth, async (_req, res) => {
  res.json({ ok: true, message: "Dhan script master refresh started in background" });
  refreshScriptMaster(); // fire-and-forget
});

// GET /api/market/expiries — dynamic expiries by exchange
router.get("/expiries", auth, async (req, res) => {
  const { exchange } = req.query;
  if (exchange === "NSE_EQ" || exchange === "BSE_EQ") {
    return res.json({ ok: true, expiries: [], hasExpiry: false });
  }
  const expiries = [];
  const now = new Date();
  for (let m = 0; m < 6; m++) {
    const d = new Date(now.getFullYear(), now.getMonth() + m, 1);
    const thursdays = [];
    for (let day = 1; day <= 31; day++) {
      const dt = new Date(d.getFullYear(), d.getMonth(), day);
      if (dt.getMonth() !== d.getMonth()) break;
      if (dt.getDay() === 4) thursdays.push(dt);
    }
    const exp = thursdays[2];
    if (exp) {
      expiries.push(exp.toLocaleDateString("en-IN", {
        day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata",
      }));
    }
  }
  if (exchange === "NSE_FNO") {
    const weekly = [];
    for (let w = 0; w < 8; w++) {
      const d = new Date();
      const daysUntilThurs = (4 - d.getDay() + 7) % 7 || 7;
      d.setDate(d.getDate() + daysUntilThurs + w * 7);
      weekly.push(d.toLocaleDateString("en-IN", {
        day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata",
      }));
    }
    return res.json({ ok: true, expiries: [...new Set([...weekly, ...expiries])].sort(), hasExpiry: true });
  }
  res.json({ ok: true, expiries, hasExpiry: true });
});

module.exports = router;
