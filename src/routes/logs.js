const router = require("express").Router();
const db     = require("../services/database");
const auth   = require("../middleware/auth");

// GET /api/logs?level=error&q=dhan&limit=500&since=2026-04-19T10:00:00Z
// Returns most recent first, capped at limit.
router.get("/", auth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "500", 10) || 500, 5000);
    const level = (req.query.level || "").toLowerCase().trim();
    const q     = (req.query.q || "").trim();
    const since = req.query.since;

    const where  = ["1=1"];
    const params = [];
    if (level && ["error","warn","info","debug","verbose"].includes(level)) {
      params.push(level);
      where.push(`level = $${params.length}`);
    }
    if (q) {
      params.push(`%${q}%`);
      where.push(`message ILIKE $${params.length}`);
    }
    if (since) {
      params.push(since);
      where.push(`created_at >= $${params.length}`);
    }

    params.push(limit);
    const rows = await db.getAll(
      `SELECT id, level, message, ist_timestamp, meta, created_at
       FROM app_logs
       WHERE ${where.join(" AND ")}
       ORDER BY id DESC
       LIMIT $${params.length}`,
      params
    );

    res.json({ ok: true, logs: rows, count: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/logs/stats — counts by level for the dashboard chip
router.get("/stats", auth, async (_req, res) => {
  try {
    const rows = await db.getAll(`
      SELECT level, COUNT(*)::int AS n
      FROM app_logs
      WHERE created_at > NOW() - INTERVAL '24 hours'
      GROUP BY level
      ORDER BY level
    `);
    res.json({ ok: true, last24h: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
