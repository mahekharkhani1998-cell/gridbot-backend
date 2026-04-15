const router  = require("express").Router();
const db      = require("../services/database");
const auth    = require("../middleware/auth");
const { startBot, stopBot, killAllBots } = require("../services/gridEngine");

// GET /api/bots
router.get("/", auth, async (req, res) => {
  try {
    const rows = await db.getAll(`
      SELECT b.*, c.name AS client_name, c.broker
      FROM bots b JOIN clients c ON b.client_id=c.id
      ORDER BY b.created_at DESC
    `);
    res.json({ ok: true, bots: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/bots — create bot
router.post("/", auth, async (req, res) => {
  try {
    const {
      client_id, exchange, ticker, security_id, isin, product,
      expiry, grid_step, tp_interval, trade_qty, initial_qty,
      start_price, lower_limit, upper_limit,
    } = req.body;
    if (!client_id || !exchange || !security_id || !trade_qty || !start_price)
      return res.status(400).json({ error: "client_id, exchange, security_id, trade_qty, start_price required" });

    const bot = await db.getOne(`
      INSERT INTO bots (client_id,exchange,ticker,security_id,isin,product,expiry,
        grid_step,tp_interval,trade_qty,initial_qty,start_price,lower_limit,upper_limit)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING *
    `, [client_id,exchange,ticker,security_id,isin||"",product||"CNC",expiry||"",
        grid_step,tp_interval||0,trade_qty,initial_qty||0,start_price,lower_limit,upper_limit]);
    res.json({ ok: true, bot });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/bots/:id/start
router.post("/:id/start", auth, async (req, res) => {
  try {
    const result = await startBot(req.params.id);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/bots/:id/stop
router.post("/:id/stop", auth, async (req, res) => {
  try {
    await stopBot(req.params.id);
    res.json({ ok: true, message: "Bot stopped. Shares held in Demat." });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/bots/kill-all  — KILL SWITCH
router.post("/kill-all", auth, async (req, res) => {
  try {
    const { client_id } = req.body;
    const result = await killAllBots(client_id || null);
    res.json({ ok: true, ...result, message: `Kill switch executed. ${result.killed} bot(s) stopped.` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/bots/:id/kill
router.post("/:id/kill", auth, async (req, res) => {
  try {
    await stopBot(req.params.id);
    res.json({ ok: true, message: "Bot killed. Positions squared off." });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/bots/:id
router.delete("/:id", auth, async (req, res) => {
  try {
    await stopBot(req.params.id);
    await db.query("DELETE FROM bots WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
