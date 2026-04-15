const axios  = require("axios");
const { logger } = require("./logger");

const BASE_URL = "https://api.dhan.co";

// ─── Dhan API wrapper — mirrors your grid_bot_cnc.py DhanAPI class ────────────
class DhanAPI {
  constructor(clientId, accessToken) {
    this.clientId    = clientId;
    this.accessToken = accessToken;
    this.http = axios.create({
      baseURL: BASE_URL,
      headers: {
        "access-token": accessToken,
        "client-id":    clientId,
        "Content-Type": "application/json",
      },
      timeout: 15000,
    });
  }

  // ── Place market order (CNC) ──────────────────────────────────────────────
  async placeMarketOrder({ securityId, exchangeSegment, side, qty, productType = "CNC" }) {
    try {
      const res = await this.http.post("/orders", {
        dhanClientId:    this.clientId,
        transactionType: side,           // "BUY" or "SELL"
        exchangeSegment: exchangeSegment, // "NSE_EQ"
        productType:     productType,
        orderType:       "MARKET",
        validity:        "DAY",
        securityId:      String(securityId),
        quantity:        qty,
        price:           0,
      });
      logger.info(`Market ${side} sent | qty:${qty} | resp:${JSON.stringify(res.data)}`);
      return res.data?.data?.orderId || null;
    } catch (err) {
      logger.error(`Market order error: ${err.message}`);
      return null;
    }
  }

  // ── Place limit order (CNC) ───────────────────────────────────────────────
  async placeLimitOrder({ securityId, exchangeSegment, side, qty, price, productType = "CNC" }) {
    try {
      const res = await this.http.post("/orders", {
        dhanClientId:    this.clientId,
        transactionType: side,
        exchangeSegment: exchangeSegment,
        productType:     productType,
        orderType:       "LIMIT",
        validity:        "DAY",
        securityId:      String(securityId),
        quantity:        qty,
        price:           price,
      });
      logger.info(`Limit ${side} @ ₹${price} | qty:${qty} | resp:${JSON.stringify(res.data)}`);
      return res.data?.data?.orderId || null;
    } catch (err) {
      logger.error(`Limit order error: ${err.message}`);
      return null;
    }
  }

  // ── Cancel order ──────────────────────────────────────────────────────────
  async cancelOrder(orderId) {
    try {
      const res = await this.http.delete(`/orders/${orderId}`);
      logger.info(`Cancel ${orderId}: ${JSON.stringify(res.data)}`);
      return true;
    } catch (err) {
      logger.error(`Cancel error ${orderId}: ${err.message}`);
      return false;
    }
  }

  // ── Get order status ──────────────────────────────────────────────────────
  async getOrderStatus(orderId) {
    try {
      const res = await this.http.get(`/orders/${orderId}`);
      const data = res.data?.data || res.data;
      if (Array.isArray(data)) {
        const o = data.find(x => String(x.orderId) === String(orderId));
        return { status: o?.orderStatus, fillPrice: parseFloat(o?.averageTradedPrice || 0) };
      }
      return { status: data?.orderStatus, fillPrice: parseFloat(data?.averageTradedPrice || 0) };
    } catch (err) {
      logger.error(`Order status error ${orderId}: ${err.message}`);
      return { status: null, fillPrice: 0 };
    }
  }

  // ── Get order status from full list (fallback, mirrors get_order_status_from_list) ──
  async getOrderStatusFromList(orderId) {
    try {
      const res  = await this.http.get("/orders");
      const list = res.data?.data || res.data || [];
      const o    = list.find(x => String(x.orderId) === String(orderId));
      if (o) return { status: o.orderStatus, fillPrice: parseFloat(o.averageTradedPrice || 0) };
    } catch (err) {
      logger.error(`Order list error: ${err.message}`);
    }
    return { status: null, fillPrice: 0 };
  }

  // ── Smart status — tries direct first, falls back to list ─────────────────
  async getStatusSmart(orderId) {
    let result = await this.getOrderStatus(orderId);
    if (!result.status) result = await this.getOrderStatusFromList(orderId);
    return result;
  }

  // ── Get LTP — 5 methods, mirrors get_ltp() from Python exactly ───────────
  async getLTP(securityId, exchangeSegment = "NSE_EQ") {
    // Method 1: intraday minute data
    try {
      const res  = await this.http.get("/charts/intraday", {
        params: { securityId, exchangeSegment, instrument: "EQUITY" },
      });
      const data = res.data?.data || res.data;
      const closes = data?.close || [];
      if (closes.length) {
        const ltp = parseFloat(closes[closes.length - 1]);
        if (ltp > 10) { logger.info(`LTP from minute_data: ₹${ltp}`); return ltp; }
      }
    } catch (e) { logger.debug(`LTP minute_data fail: ${e.message}`); }

    // Method 2: market feed OHLC
    try {
      const res  = await this.http.post("/marketfeed/ohlc", {
        NSE_EQ: [parseInt(securityId)],
      });
      const data = res.data?.data || {};
      for (const val of Object.values(data)) {
        const ltp = parseFloat(val?.ltp || val?.close || 0);
        if (ltp > 10) { logger.info(`LTP from market_feed: ₹${ltp}`); return ltp; }
      }
    } catch (e) { logger.debug(`LTP market_feed fail: ${e.message}`); }

    // Method 3: positions
    try {
      const res  = await this.http.get("/positions");
      const list = res.data?.data || [];
      const pos  = list.find(p => String(p.securityId) === String(securityId));
      if (pos) {
        const ltp = parseFloat(pos.lastTradedPrice || pos.ltp || 0);
        if (ltp > 10) { logger.info(`LTP from positions: ₹${ltp}`); return ltp; }
      }
    } catch (e) { logger.debug(`LTP positions fail: ${e.message}`); }

    // Method 4: holdings (CNC)
    try {
      const res  = await this.http.get("/holdings");
      const list = res.data?.data || [];
      const h    = list.find(x => String(x.securityId) === String(securityId));
      if (h) {
        const ltp = parseFloat(h.lastTradedPrice || h.ltp || 0);
        if (ltp > 10) { logger.info(`LTP from holdings: ₹${ltp}`); return ltp; }
      }
    } catch (e) { logger.debug(`LTP holdings fail: ${e.message}`); }

    // Method 5: daily OHLC fallback
    try {
      const res  = await this.http.get("/charts/historical", {
        params: { securityId, exchangeSegment, instrument: "EQUITY", expiryCode: 0 },
      });
      const data   = res.data?.data || res.data;
      const closes = data?.close || [];
      if (closes.length) {
        const ltp = parseFloat(closes[closes.length - 1]);
        if (ltp > 10) { logger.info(`LTP from daily_data: ₹${ltp}`); return ltp; }
      }
    } catch (e) { logger.debug(`LTP daily_data fail: ${e.message}`); }

    logger.warn(`All LTP methods failed for securityId:${securityId}`);
    return null;
  }

  // ── Get holdings ──────────────────────────────────────────────────────────
  async getHoldings() {
    try {
      const res  = await this.http.get("/holdings");
      return res.data?.data || res.data || [];
    } catch (err) {
      logger.error(`Holdings error: ${err.message}`);
      return [];
    }
  }

  // ── Get positions ─────────────────────────────────────────────────────────
  async getPositions() {
    try {
      const res  = await this.http.get("/positions");
      return res.data?.data || res.data || [];
    } catch (err) {
      logger.error(`Positions error: ${err.message}`);
      return [];
    }
  }

  // ── Get fund limits ───────────────────────────────────────────────────────
  async getFundLimits() {
    try {
      const res = await this.http.get("/fundlimit");
      return res.data?.data || res.data || {};
    } catch (err) {
      logger.error(`Fund limit error: ${err.message}`);
      return {};
    }
  }

  // ── Get all orders ────────────────────────────────────────────────────────
  async getAllOrders() {
    try {
      const res  = await this.http.get("/orders");
      return res.data?.data || res.data || [];
    } catch (err) {
      logger.error(`All orders error: ${err.message}`);
      return [];
    }
  }
}

// ─── TOTP-based token refresh for Dhan ───────────────────────────────────────
// Dhan uses a session token that can be refreshed via their login flow with TOTP
async function refreshDhanToken(clientId, totpSecret) {
  const OTPAuth = require("otpauth");
  try {
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(totpSecret), digits: 6, period: 30 });
    const otp  = totp.generate();
    logger.info(`TOTP generated for client ${clientId}: ${otp} (IST: ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })})`);
    // Dhan token refresh endpoint — call their login API with client_id + TOTP
    // NOTE: Exact endpoint depends on Dhan's current API version.
    // Endpoint: POST https://api.dhan.co/v2/token/generate
    const res = await axios.post(`${BASE_URL}/v2/token/generate`, {
      clientId, authCode: otp,
    });
    const newToken = res.data?.accessToken || res.data?.data?.accessToken;
    if (newToken) {
      logger.info(`Token refreshed for client ${clientId} at IST ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`);
      return newToken;
    }
    logger.warn(`Token refresh returned no token for client ${clientId}`);
    return null;
  } catch (err) {
    logger.error(`Token refresh failed for client ${clientId}: ${err.message}`);
    return null;
  }
}

module.exports = { DhanAPI, refreshDhanToken };
