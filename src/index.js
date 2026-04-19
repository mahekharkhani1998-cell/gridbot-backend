require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { logger } = require("./services/logger");
const db = require("./services/database");
const scheduler = require("./jobs/scheduler");
const wsServer = require("./services/websocket");
const authRoutes = require("./routes/auth");
const clientRoutes = require("./routes/clients");
const botRoutes = require("./routes/bots");
const orderRoutes = require("./routes/orders");
const marketRoutes = require("./routes/market");
const holdingRoutes = require("./routes/holdings");
const logRoutes = require("./routes/logs");
const app = express();
const PORT = process.env.PORT || 4000;
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, _res, next) => {
  const ist = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  logger.info(`[${ist} IST] ${req.method} ${req.path}`);
  next();
});
app.get("/health", (_req, res) => {
  const ist = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  res.json({ status: "ok", time_ist: ist, version: "1.0.0" });
});
app.use("/api/auth", authRoutes);
app.use("/api/clients", clientRoutes);
app.use("/api/bots", botRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/market", marketRoutes);
app.use("/api/holdings", holdingRoutes);
app.use("/api/logs", logRoutes);
app.use((_req, res) => res.status(404).json({ error: "Route not found" }));
app.use((err, _req, res, _next) => {
  logger.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error", message: err.message });
});
async function start() {
  try {
    await db.connect();
    logger.info("✓ Database connected");
    await db.migrate();
    logger.info("✓ Database migrated");
    scheduler.start();
    logger.info("✓ Scheduler started");
    // First-boot: refresh script master if empty, sparse, or stale
    try {
      const row = await db.getOne(`
        SELECT COUNT(*)::int AS n,
               EXTRACT(EPOCH FROM (NOW() - COALESCE(MAX(updated_at), '1970-01-01'::timestamptz)))::bigint AS age_sec
        FROM script_master
      `);
      const n   = row?.n || 0;
      const age = row?.age_sec || Infinity;
      const STALE_HOURS = 36;
      const MIN_ROWS    = 50000;
      if (n === 0 || n < MIN_ROWS || age > STALE_HOURS * 3600) {
        const reason = n === 0 ? "empty" : n < MIN_ROWS ? `only ${n} rows (expected 150k+)` : `${Math.round(age/3600)}h stale`;
        logger.info(`[BOOT] script_master is ${reason} — triggering Dhan refresh in background`);
        scheduler.refreshScriptMaster();
      } else {
        logger.info(`[BOOT] script_master has ${n} rows, ${Math.round(age/3600)}h old — fresh enough`);
      }
    } catch (e) { logger.warn(`First-boot script check failed: ${e.message}`); }
    const server = app.listen(PORT, () => {
      const ist = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
      logger.info(`✓ GridBot backend running on port ${PORT} | IST: ${ist}`);
    });
    wsServer.attach(server);
    logger.info("✓ WebSocket server attached");
  } catch (err) {
    logger.error("Failed to start server:", err);
    process.exit(1);
  }
}
start();
