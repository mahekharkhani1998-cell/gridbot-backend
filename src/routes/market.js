const router = require("express").Router();
const db     = require("../services/database");
const auth   = require("../middleware/auth");
const { refreshScriptMaster } = require("../jobs/scheduler");

// GET /api/market/scripts?exchange=NSE_EQ&q=BSE
// Returns scripts from DB (populated daily from NSE/BSE master CSV)
router.get("/scripts", auth, async (req, res) => {
  try {
    const { exchange, q } = req.query;
    if (!exchange) return res.status(400).json({ error: "exchange required" });
    let sql  = "SELECT * FROM script_master WHERE exchange=$1";
    const params = [exchange];
    if (q) {
      params.push(`%${q.toUpperCase()}%`);
      sql += ` AND (UPPER(name) LIKE $2 OR security_id LIKE $2)`;
    }
    sql += " ORDER BY name LIMIT 50";
    const rows = await db.getAll(sql, params);
    res.json({ ok: true, scripts: rows, total: rows.length, exchange });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/market/refresh  — manually trigger script master refresh
router.post("/refresh", auth, async (req, res) => {
  try {
    res.json({ ok: true, message: "Script master refresh started in background" });
    refreshScriptMaster(); // runs async, don't await
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/market/expiries  — dynamic expiries based on exchange type
router.get("/expiries", auth, async (req, res) => {
  const { exchange } = req.query;
  // NSE_EQ and BSE_EQ have NO expiry
  if (exchange === "NSE_EQ" || exchange === "BSE_EQ") {
    return res.json({ ok: true, expiries: [], hasExpiry: false });
  }
  // FNO, Currency, Commodity — return next 6 monthly expiries (3rd Thursday)
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
    const exp = thursdays[2]; // 3rd Thursday
    if (exp) {
      expiries.push(exp.toLocaleDateString("en-IN", {
        day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata",
      }));
    }
  }
  // Add weekly expiries (next 8 Thursdays) for FNO
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
    const all = [...new Set([...weekly, ...expiries])].sort();
    return res.json({ ok: true, expiries: all, hasExpiry: true });
  }
  res.json({ ok: true, expiries, hasExpiry: true });
});

module.exports = router;
