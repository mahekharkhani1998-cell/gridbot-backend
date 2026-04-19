const router = require("express").Router();
const db     = require("../services/database");
const auth   = require("../middleware/auth");
const { decrypt } = require("../services/encryption");
const { DhanAPI } = require("../services/dhan");
const { logger } = require("../services/logger");

// Helper: place one order on Dhan and persist the row in `orders` table.
// Returns { ok, order_id?, error?, status?, fill_price? } for the multi-order
// results table.
async function placeOneOrder(client, payload) {
  const creds = decrypt(client.credentials_enc);
  const api   = new DhanAPI(creds.client_id, creds.access_token);

  const {
    exchange, security_id, ticker, side, order_type, product, qty, price,
  } = payload;

  let orderId;
  if (order_type === "MARKET") {
    orderId = await api.placeMarketOrder({
      securityId: security_id, exchangeSegment: exchange,
      side, qty, productType: product,
    });
  } else {
    orderId = await api.placeLimitOrder({
      securityId: security_id, exchangeSegment: exchange,
      side, qty, price, productType: product,
    });
  }

  if (!orderId) {
    return { ok: false, client_id: client.id, client_name: client.name, error: api.lastError || "Order rejected" };
  }

  // Persist in our orders table (no bot_id since this is a manual order)
  try {
    await db.query(`
      INSERT INTO orders
        (bot_id, client_id, broker_order_id, exchange, security_id, ticker, side, order_type, product, qty, price, status, placed_at)
      VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'PENDING', NOW())
    `, [client.id, orderId, exchange, security_id, ticker || "", side, order_type, product, qty, price || 0]);
  } catch (e) {
    logger.warn(`Order placed (id ${orderId}) but DB insert failed: ${e.message}`);
  }

  return { ok: true, client_id: client.id, client_name: client.name, order_id: orderId };
}

// Validate a payload — returns null if OK, error string otherwise.
function validatePayload(p) {
  if (!p) return "Missing order payload";
  if (!p.exchange) return "exchange required";
  if (!p.security_id) return "security_id required";
  if (!p.side || !["BUY","SELL"].includes(String(p.side).toUpperCase())) return "side must be BUY or SELL";
  if (!p.order_type || !["MARKET","LIMIT"].includes(String(p.order_type).toUpperCase())) return "order_type must be MARKET or LIMIT";
  if (!p.product) return "product required (CNC/INTRADAY/MARGIN/MTF)";
  if (!Number.isInteger(p.qty) || p.qty <= 0) return "qty must be a positive integer";
  if (String(p.order_type).toUpperCase() === "LIMIT") {
    const price = parseFloat(p.price);
    if (!Number.isFinite(price) || price <= 0) return "price required for LIMIT orders";
  }
  return null;
}

// POST /api/trade/single — { client_id, payload }
router.post("/single", auth, async (req, res) => {
  try {
    const { client_id, payload } = req.body;
    if (!client_id) return res.status(400).json({ error: "client_id required" });
    const err = validatePayload(payload);
    if (err) return res.status(400).json({ error: err });

    const client = await db.getOne("SELECT id, name, broker, credentials_enc FROM clients WHERE id=$1 AND active=TRUE", [client_id]);
    if (!client) return res.status(404).json({ error: "Client not found or inactive" });
    if (client.broker !== "Dhan") return res.status(400).json({ error: `Broker ${client.broker} not yet supported for manual orders` });

    const result = await placeOneOrder(client, {
      ...payload,
      side: String(payload.side).toUpperCase(),
      order_type: String(payload.order_type).toUpperCase(),
    });
    res.json({ ok: result.ok, result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/trade/multi — { client_ids?: [], bucket_id?, orders: [payload, ...] }
// Places EACH order in `orders` array on EACH client, sequentially.
// Returns { ok, results: [{client_name, order_index, ok, order_id?, error?}] }
router.post("/multi", auth, async (req, res) => {
  try {
    const { client_ids, bucket_id, orders } = req.body;
    if (!Array.isArray(orders) || !orders.length) {
      return res.status(400).json({ error: "orders array required (one or more order payloads)" });
    }
    for (let i = 0; i < orders.length; i++) {
      const err = validatePayload(orders[i]);
      if (err) return res.status(400).json({ error: `Order #${i+1}: ${err}` });
    }

    // Resolve target client list
    let targetIds = [];
    if (bucket_id) {
      const rows = await db.getAll("SELECT client_id FROM bucket_members WHERE bucket_id=$1", [bucket_id]);
      targetIds = rows.map(r => r.client_id);
    }
    if (Array.isArray(client_ids) && client_ids.length) {
      targetIds = [...new Set([...targetIds, ...client_ids])];
    }
    if (!targetIds.length) return res.status(400).json({ error: "No client_ids or bucket_id provided" });

    const clients = await db.getAll(
      `SELECT id, name, broker, credentials_enc FROM clients WHERE id = ANY($1::uuid[]) AND active=TRUE`,
      [targetIds]
    );
    if (!clients.length) return res.status(404).json({ error: "No active clients matched" });

    const ist = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
    logger.info(`[MULTI-ORDER] Placing ${orders.length} order(s) × ${clients.length} client(s) | IST: ${ist}`);

    const results = [];
    // Sequential to respect Dhan's 10/sec rate limit (and to keep results predictable)
    for (let oi = 0; oi < orders.length; oi++) {
      const p = {
        ...orders[oi],
        side: String(orders[oi].side).toUpperCase(),
        order_type: String(orders[oi].order_type).toUpperCase(),
      };
      for (const c of clients) {
        if (c.broker !== "Dhan") {
          results.push({
            order_index: oi, client_id: c.id, client_name: c.name,
            ok: false, error: `Broker ${c.broker} not yet supported`,
          });
          continue;
        }
        try {
          const r = await placeOneOrder(c, p);
          results.push({ order_index: oi, ...r });
        } catch (e) {
          results.push({
            order_index: oi, client_id: c.id, client_name: c.name,
            ok: false, error: e.message,
          });
        }
        // Tiny delay to stay well under 10 req/sec
        await new Promise(r => setTimeout(r, 120));
      }
    }

    const ok    = results.filter(r => r.ok).length;
    const fails = results.length - ok;
    logger.info(`[MULTI-ORDER] Done | ok:${ok} fail:${fails}`);
    res.json({ ok: true, results, summary: { total: results.length, ok, fail: fails } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
