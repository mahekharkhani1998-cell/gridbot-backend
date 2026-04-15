// ─── orders.js ────────────────────────────────────────────────────────────────
const orderRouter = require("express").Router();
const db   = require("../services/database");
const auth = require("../middleware/auth");

orderRouter.get("/", auth, async (req, res) => {
  try {
    const { bot_id, client_id, status, limit = 200 } = req.query;
    let sql    = "SELECT o.*, b.ticker FROM orders o LEFT JOIN bots b ON o.bot_id=b.id WHERE 1=1";
    const vals = [];
    if (bot_id)    { vals.push(bot_id);    sql += ` AND o.bot_id=$${vals.length}`; }
    if (client_id) { vals.push(client_id); sql += ` AND o.client_id=$${vals.length}`; }
    if (status)    { vals.push(status);    sql += ` AND o.status=$${vals.length}`; }
    sql += ` ORDER BY o.placed_at DESC LIMIT ${parseInt(limit)}`;
    const rows = await db.getAll(sql, vals);
    // Convert timestamps to IST for display
    const withIST = rows.map(r => ({
      ...r,
      placed_at_ist:    r.placed_at    ? db.toIST(r.placed_at)    : null,
      filled_at_ist:    r.filled_at    ? db.toIST(r.filled_at)    : null,
      cancelled_at_ist: r.cancelled_at ? db.toIST(r.cancelled_at) : null,
    }));
    res.json({ ok: true, orders: withIST });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = { orderRouter };
