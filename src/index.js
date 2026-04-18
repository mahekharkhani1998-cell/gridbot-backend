require("dotenv").config();
const express    = require("express");
const cors       = require("cors");
const { logger } = require("./services/logger");
const db         = require("./services/database");
const scheduler  = require("./jobs/scheduler");
const wsServer   = require("./services/websocket");

// ─── Routes ──────────────────────────────────────────────────────────────────
const authRoutes     = require("./routes/auth");
const clientRoutes   = require("./routes/clients");
const botRoutes      = require("./routes/bots");
const orderRoutes    = require("./routes/orders");
const marketRoutes   = require("./routes/market");
const holdingRoutes  = require("./routes/holdings");

const app  = express();
const PORT = process.env.PORT || 4000;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({
  origin: true,
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logger
app.use((req, _res, next) => {
  const ist = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  logger.info(`[${ist} IST] ${req.method} ${req.path}`);
  next();
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  const ist = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  res.json({ status: "ok", time_ist: ist, version: "1.0.0" });
});

// ─── API routes ───────────────────────────────────────────────────────────────
app.use("/api/auth",     authRoutes);
app.use("/api/clients",  clientRoutes);
app.use("/api/bots",     botRoutes);
app.use("/api/orders",   orderRoutes);
app.use("/api/market",   marketRoutes);
app.use("/api/holdings", holdingRoutes);

// ─── 404 handler ──────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: "Route not found" }));

// ─── Error handler ────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  logger.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error", message: err.message });
});

// ─── Start ────────────────────────────────────────────────────────────────────
async function start() {
  try {
    await db.connect();
    logger.info("✓ Database connected");
    await db.migrate();
    logger.info("✓ Database migrated");
    scheduler.start();
    logger.info("✓ Scheduler started (token refresh 8:00 AM IST, script refresh 6:00 AM IST)");
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
