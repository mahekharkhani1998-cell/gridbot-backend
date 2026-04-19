const orderRouter = require("express").Router();
const db   = require("../services/database");
const auth = require("../middleware/auth");
const { decrypt } = require("../services/encryption");

// Map Dhan orderStatus values to our app filter buckets.
function bucket(status) {
  const s = String(status || "").toUpperCase();
  if (s === "TRADED" || s === "FILLED" || s === "EXECUTED") return "FILLED";
  if (s === "CANCELLED" || s === "REJECTED" || s === "EXPIRED") return "CANCELLED";
  if (s === "PENDING" || s === "TRANSIT" || s === "OPEN" || s === "PART_TRADED" || s === "MODIFIED") return "OPEN";
  return s || "UNKNOWN";
}

// GET /api/orders?client_id=&bot_id=&status=&source=db|live|both&limit=
orderRouter.get("/", auth, async (req, res) => {
  try {
    const { bot_id, client_id, status } = req.query;
    const limit  = Math.min(parseInt(req.query.limit || "200", 10) || 200, 1000);
    const source = (req.query.source || "both").toLowerCase();

    let dbOrders = [];
    if (source === "db" || source === "both") {
      let sql    = `SELECT o.*, b.ticker FROM orders o LEFT JOIN bots b ON o.bot_id=b.id WHERE 1=1`;
      const vals = [];
      if (bot_id)    { vals.push(bot_id);    sql += ` AND o.bot_id=$${vals.length}`; }
      if (client_id) { vals.push(client_id); sql += ` AND o.client_id=$${vals.length}`; }
      if (status)    { vals.push(status);    sql += ` AND o.status=$${vals.length}`; }
      sql += ` ORDER BY o.placed_at DESC LIMIT ${limit}`;
      const rows = await db.getAll(sql, vals);
      dbOrders = rows.map(r => ({
        source:           "db",
        order_id:         r.broker_order_id || r.id,
        bot_id:           r.bot_id,
        client_id:        r.client_id,
        ticker:           r.ticker || "",
        security_id:      r.security_id || "",
        side:             r.side,
        order_type:       r.order_type || "LIMIT",
        product:          r.product || "CNC",
        qty:              r.qty,
        price:            parseFloat(r.price || 0),
        fill_price:       parseFloat(r.fill_price || 0),
        status:           r.status,
        bucket:           bucket(r.status),
        placed_at_ist:    r.placed_at    ? db.toIST(r.placed_at)    : null,
        filled_at_ist:    r.filled_at    ? db.toIST(r.filled_at)    : null,
        cancelled_at_ist: r.cancelled_at ? db.toIST(r.cancelled_at) : null,
      }));
    }

    let liveOrders = [];
    if ((source === "live" || source === "both") && client_id) {
      const row = await db.getOne("SELECT credentials_enc, broker FROM clients WHERE id=$1", [client_id]);
      if (row && row.broker === "Dhan") {
        try {
          const creds = decrypt(row.credentials_enc);
          const { DhanAPI } = require("../services/dhan");
          const api = new DhanAPI(creds.client_id, creds.access_token);
          const live = await api.getAllOrders();
          liveOrders = live.map(o => ({
            source:      "live",
            order_id:    o.orderId,
            client_id,
            bot_id:      null,
            ticker:      o.tradingSymbol,
            security_id: o.securityId,
            side:        o.transactionType,
            order_type:  o.orderType,
            product:     o.productType,
            qty:         o.quantity,
            price:       o.price,
            fill_price:  o.averageTradedPrice,
            status:      o.orderStatus,
            bucket:      bucket(o.orderStatus),
            placed_at_ist:    o.createTime || null,
            filled_at_ist:    bucket(o.orderStatus) === "FILLED"   ? (o.exchangeTime || o.updateTime) : null,
            cancelled_at_ist: bucket(o.orderStatus) === "CANCELLED" ? (o.updateTime  || null) : null,
            error:       o.omsErrorDescription || "",
          }));
        } catch (e) {
          // Live fetch failed — return DB orders + warning so the UI can flag it
          return res.json({ ok: true, orders: dbOrders, warning: `Live fetch failed: ${e.message}` });
        }
      }
    }

    // Merge: prefer live (broker is source of truth) for matching order_ids
    const seen = new Set(liveOrders.map(o => String(o.order_id)));
    const merged = [
      ...liveOrders,
      ...dbOrders.filter(o => !seen.has(String(o.order_id))),
    ].slice(0, limit);

    // Apply status filter on the merged set when source is "both"
    const filtered = status
      ? merged.filter(o => o.bucket === String(status).toUpperCase() || o.status === status)
      : merged;

    res.json({ ok: true, orders: filtered });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = orderRouter;
