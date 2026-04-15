const router = require("express").Router();
const auth   = require("../middleware/auth");

// Holdings and positions are served via /api/clients/:id/holdings and /positions
// This router handles aggregate views across all clients
router.get("/summary", auth, async (_req, res) => {
  res.json({ ok: true, message: "Use /api/clients/:id/holdings for per-client holdings" });
});

module.exports = router;
