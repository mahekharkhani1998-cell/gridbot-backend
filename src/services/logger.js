const winston = require("winston");
require("winston-daily-rotate-file");
const Transport = require("winston-transport");

const IST_TIMESTAMP = winston.format((info) => {
  info.timestamp = new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }) + " IST";
  return info;
});

// Postgres transport — buffers in memory and flushes every 2s. Lazy-loads
// the db module so we don't hit a circular import (database.js requires logger).
class PgTransport extends Transport {
  constructor(opts = {}) {
    super(opts);
    this.buffer = [];
    this.maxBuffer = 1000;
    this.flushMs = 2000;
    this.timer = setInterval(() => this.flush(), this.flushMs);
    this.timer.unref?.();
  }

  log(info, callback) {
    setImmediate(() => this.emit("logged", info));
    this.buffer.push({
      level:     info.level,
      message:   String(info.message || "").slice(0, 4000),
      timestamp: info.timestamp || new Date().toISOString(),
      meta:      Object.keys(info).filter(k => !["level","message","timestamp"].includes(k))
                       .reduce((a, k) => { a[k] = info[k]; return a; }, {}),
    });
    if (this.buffer.length >= this.maxBuffer) this.flush();
    callback();
  }

  async flush() {
    if (!this.buffer.length) return;
    const rows = this.buffer.splice(0, this.buffer.length);
    try {
      const db = require("./database"); // lazy
      const cols = 4;
      const params = [];
      const tuples = rows.map((r, i) => {
        const base = i * cols;
        params.push(r.level, r.message, r.timestamp, JSON.stringify(r.meta || {}));
        return `($${base+1},$${base+2},$${base+3},$${base+4}::jsonb)`;
      });
      await db.query(
        `INSERT INTO app_logs (level, message, ist_timestamp, meta) VALUES ${tuples.join(",")}`,
        params
      );
    } catch (e) {
      // Don't recursively log — print directly so we don't loop.
      // eslint-disable-next-line no-console
      console.error("PgTransport flush failed:", e.message);
    }
  }
}

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    IST_TIMESTAMP(),
    winston.format.printf(({ level, message, timestamp, ...meta }) => {
      const metaStr = Object.keys(meta).length ? " " + JSON.stringify(meta) : "";
      return `[${timestamp}] ${level.toUpperCase()}: ${message}${metaStr}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.DailyRotateFile({
      filename: "logs/gridbot-%DATE%.log",
      datePattern: "YYYY-MM-DD",
      maxFiles: "30d",
      maxSize: "20m",
    }),
    new PgTransport(),
  ],
});

module.exports = { logger };
