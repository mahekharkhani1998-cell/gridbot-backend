const axios  = require("axios");
const { logger } = require("./logger");

const BASE_URL = "https://api.dhan.co";
const AUTH_URL = "https://auth.dhan.co";

// All Dhan v2 endpoints. v1 is deprecated and returns 404 / empty arrays for
// many accounts as of late 2025.
const EP = {
  ORDERS:   "/v2/orders",
  HOLDINGS: "/v2/holdings",
  POSITIONS:"/v2/positions",
  FUNDS:    "/v2/fundlimit",
  OHLC:     "/v2/marketfeed/ohlc",
  INTRA:    "/v2/charts/intraday",
  HIST:     "/v2/charts/historical",
  PROFILE:  "/v2/profile",
  RENEW:    "/v2/RenewToken",
};

// Auth endpoints live on a different host (auth.dhan.co, not api.dhan.co)
const AUTH_EP = {
  GENERATE: "/app/generateAccessToken",
};

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const int = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };

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
        "Accept":       "application/json",
      },
      timeout: 15000,
    });
  }

  // Dhan returns either {data: [...]} or [...] depending on endpoint. Unwrap once.
  static unwrap(res) {
    const d = res?.data;
    if (d && typeof d === "object" && "data" in d && d.data !== undefined) return d.data;
    return d;
  }

  async placeMarketOrder({ securityId, exchangeSegment, side, qty, productType = "CNC" }) {
    try {
      const res = await this.http.post(EP.ORDERS, {
        dhanClientId: this.clientId, transactionType: side, exchangeSegment,
        productType, orderType: "MARKET", validity: "DAY",
        securityId: String(securityId), quantity: qty, price: 0,
      });
      const orderId = res.data?.orderId || res.data?.data?.orderId || null;
      logger.info(`Market ${side} sent | qty:${qty} | orderId:${orderId}`);
      this.lastError = orderId ? null : "No order ID returned by Dhan";
      return orderId;
    } catch (err) {
      const msg = err.response?.data?.errorMessage || err.response?.data?.message || err.message;
      logger.error(`Market order error: ${msg}`);
      this.lastError = msg;
      return null;
    }
  }

  async placeLimitOrder({ securityId, exchangeSegment, side, qty, price, productType = "CNC" }) {
    try {
      const res = await this.http.post(EP.ORDERS, {
        dhanClientId: this.clientId, transactionType: side, exchangeSegment,
        productType, orderType: "LIMIT", validity: "DAY",
        securityId: String(securityId), quantity: qty, price,
      });
      const orderId = res.data?.orderId || res.data?.data?.orderId || null;
      logger.info(`Limit ${side} @ ₹${price} | qty:${qty} | orderId:${orderId}`);
      this.lastError = orderId ? null : "No order ID returned by Dhan";
      return orderId;
    } catch (err) {
      const msg = err.response?.data?.errorMessage || err.response?.data?.message || err.message;
      logger.error(`Limit order error: ${msg}`);
      this.lastError = msg;
      return null;
    }
  }

  async cancelOrder(orderId) {
    try {
      await this.http.delete(`${EP.ORDERS}/${orderId}`);
      logger.info(`Cancel ${orderId}: OK`);
      return true;
    } catch (err) {
      logger.error(`Cancel error ${orderId}: ${err.message}`);
      return false;
    }
  }

  async getOrderStatus(orderId) {
    try {
      const res = await this.http.get(`${EP.ORDERS}/${orderId}`);
      const data = DhanAPI.unwrap(res);
      const o = Array.isArray(data) ? data.find(x => String(x.orderId) === String(orderId)) : data;
      return { status: o?.orderStatus, fillPrice: num(o?.averageTradedPrice) };
    } catch (err) {
      logger.error(`Order status error ${orderId}: ${err.message}`);
      return { status: null, fillPrice: 0 };
    }
  }

  async getOrderStatusFromList(orderId) {
    try {
      const res  = await this.http.get(EP.ORDERS);
      const list = DhanAPI.unwrap(res) || [];
      const o    = list.find(x => String(x.orderId) === String(orderId));
      if (o) return { status: o.orderStatus, fillPrice: num(o.averageTradedPrice) };
    } catch (err) {
      logger.error(`Order list error: ${err.message}`);
    }
    return { status: null, fillPrice: 0 };
  }

  async getStatusSmart(orderId) {
    let result = await this.getOrderStatus(orderId);
    if (!result.status) result = await this.getOrderStatusFromList(orderId);
    return result;
  }

  async getLTP(securityId, exchangeSegment = "NSE_EQ") {
    // 1. intraday minute candle
    try {
      const res = await this.http.post(EP.INTRA, {
        securityId: String(securityId), exchangeSegment, instrument: "EQUITY", interval: "1",
      });
      const data = DhanAPI.unwrap(res);
      const closes = data?.close || [];
      if (closes.length) {
        const ltp = num(closes[closes.length - 1]);
        if (ltp > 0) return ltp;
      }
    } catch (e) {}

    // 2. market feed OHLC
    try {
      const res = await this.http.post(EP.OHLC, { [exchangeSegment]: [int(securityId)] });
      const data = DhanAPI.unwrap(res) || {};
      for (const seg of Object.values(data)) {
        for (const val of Object.values(seg || {})) {
          const ltp = num(val?.last_price ?? val?.ltp ?? val?.close);
          if (ltp > 0) return ltp;
        }
      }
    } catch (e) {}

    // 3. positions
    try {
      const list = await this.getPositionsRaw();
      const pos  = list.find(p => String(p.securityId) === String(securityId));
      if (pos) {
        const ltp = num(pos.lastTradedPrice ?? pos.ltp);
        if (ltp > 0) return ltp;
      }
    } catch (e) {}

    // 4. holdings
    try {
      const list = await this.getHoldingsRaw();
      const h    = list.find(x => String(x.securityId) === String(securityId));
      if (h) {
        const ltp = num(h.lastTradedPrice ?? h.ltp);
        if (ltp > 0) return ltp;
      }
    } catch (e) {}

    // 5. daily historical
    try {
      const res = await this.http.post(EP.HIST, {
        securityId: String(securityId), exchangeSegment, instrument: "EQUITY", expiryCode: 0,
      });
      const data = DhanAPI.unwrap(res);
      const closes = data?.close || [];
      if (closes.length) {
        const ltp = num(closes[closes.length - 1]);
        if (ltp > 0) return ltp;
      }
    } catch (e) {}

    logger.warn(`All LTP methods failed for securityId:${securityId}`);
    return null;
  }

  async getHoldingsRaw() {
    try {
      const res = await this.http.get(EP.HOLDINGS);
      const data = DhanAPI.unwrap(res);
      return Array.isArray(data) ? data : [];
    } catch (err) {
      logger.error(`Holdings error: ${err.response?.status || ""} ${err.response?.data?.errorMessage || err.message}`);
      return [];
    }
  }

  async getPositionsRaw() {
    try {
      const res = await this.http.get(EP.POSITIONS);
      const data = DhanAPI.unwrap(res);
      return Array.isArray(data) ? data : [];
    } catch (err) {
      logger.error(`Positions error: ${err.response?.status || ""} ${err.response?.data?.errorMessage || err.message}`);
      return [];
    }
  }

  // Normalized — frontend gets one stable shape regardless of Dhan version.
  // Holdings v2: tradingSymbol, securityId, isin, totalQty, dpQty, t1Qty,
  // availableQty, collateralQty, avgCostPrice. (LTP and P&L computed locally.)
  async getHoldings() {
    const raw = await this.getHoldingsRaw();
    return raw.map(h => {
      const qty = int(h.totalQty);
      const avg = num(h.avgCostPrice);
      const ltp = num(h.lastTradedPrice ?? h.LTP ?? h.ltp);
      const pnl    = ltp > 0 && avg > 0 && qty > 0 ? +((ltp - avg) * qty).toFixed(2) : 0;
      const pnlPct = avg > 0 ? +(((ltp - avg) / avg) * 100).toFixed(2) : 0;
      return {
        tradingSymbol:   h.tradingSymbol || h.customSymbol || String(h.securityId || ""),
        securityId:      String(h.securityId || ""),
        isin:            h.isin || "",
        exchange:        h.exchange || h.exchangeSegment || "",
        totalQty:        qty,
        availableQty:    int(h.availableQty),
        dpQty:           int(h.dpQty),
        t1Qty:           int(h.t1Qty),
        collateralQty:   int(h.collateralQty),
        avgCostPrice:    avg,
        lastTradedPrice: ltp,
        pnl, pnlPct,
      };
    });
  }

  // Positions v2: tradingSymbol, securityId, positionType, exchangeSegment,
  // productType, buyAvg/buyQty, sellAvg/sellQty, netQty, realizedProfit,
  // unrealizedProfit, costPrice.
  async getPositions() {
    const raw = await this.getPositionsRaw();
    return raw.map(p => {
      const seg  = p.exchangeSegment || "";
      const type = seg.includes("FNO") || seg.includes("FUT") ? "FUT"
                 : seg.includes("OPT") ? "OPT" : "EQ";
      return {
        tradingSymbol:    p.tradingSymbol || p.customSymbol || String(p.securityId || ""),
        securityId:       String(p.securityId || ""),
        exchangeSegment:  seg,
        productType:      p.productType || "",
        positionType:     p.positionType || "",
        type,
        buyQty:           int(p.buyQty),
        sellQty:          int(p.sellQty),
        netQty:           int(p.netQty),
        buyAvg:           num(p.buyAvg),
        sellAvg:          num(p.sellAvg),
        costPrice:        num(p.costPrice),
        lastTradedPrice:  num(p.lastTradedPrice ?? p.ltp),
        realizedProfit:   num(p.realizedProfit),
        unrealizedProfit: num(p.unrealizedProfit),
        pnl:              num(p.unrealizedProfit) + num(p.realizedProfit),
      };
    });
  }

  // Fund limits — note the "availabelBalance" typo is from Dhan, not us.
  async getFundLimits() {
    try {
      const res  = await this.http.get(EP.FUNDS);
      const data = DhanAPI.unwrap(res) || {};
      const f    = Array.isArray(data) ? (data[0] || {}) : data;
      return {
        dhanClientId:        f.dhanClientId || this.clientId,
        availableBalance:    num(f.availabelBalance ?? f.availableBalance),
        sodLimit:            num(f.sodLimit),
        collateralAmount:    num(f.collateralAmount),
        receivableAmount:    num(f.receivableAmount ?? f.receiveableAmount),
        utilizedAmount:      num(f.utilizedAmount),
        blockedPayoutAmount: num(f.blockedPayoutAmount),
        withdrawableBalance: num(f.withdrawableBalance),
      };
    } catch (err) {
      logger.error(`Fund limit error: ${err.response?.status || ""} ${err.response?.data?.errorMessage || err.message}`);
      return {
        dhanClientId: this.clientId,
        availableBalance: 0, sodLimit: 0, collateralAmount: 0,
        receivableAmount: 0, utilizedAmount: 0,
        blockedPayoutAmount: 0, withdrawableBalance: 0,
      };
    }
  }

  async getAllOrders() {
    try {
      const res  = await this.http.get(EP.ORDERS);
      const list = DhanAPI.unwrap(res);
      if (!Array.isArray(list)) return [];
      return list.map(o => ({
        orderId:           o.orderId,
        correlationId:     o.correlationId || "",
        orderStatus:       o.orderStatus || "",
        transactionType:   o.transactionType || "",
        exchangeSegment:   o.exchangeSegment || "",
        productType:       o.productType || "",
        orderType:         o.orderType || "",
        validity:          o.validity || "",
        tradingSymbol:     o.tradingSymbol || o.customSymbol || "",
        securityId:        String(o.securityId || ""),
        quantity:          int(o.quantity),
        filledQty:         int(o.filledQty),
        remainingQuantity: int(o.remainingQuantity),
        price:             num(o.price),
        triggerPrice:      num(o.triggerPrice),
        averageTradedPrice:num(o.averageTradedPrice),
        createTime:        o.createTime || "",
        updateTime:        o.updateTime || "",
        exchangeTime:      o.exchangeTime || "",
        omsErrorDescription:o.omsErrorDescription || "",
      }));
    } catch (err) {
      logger.error(`All orders error: ${err.response?.status || ""} ${err.response?.data?.errorMessage || err.message}`);
      return [];
    }
  }

  // Quick health check — if this returns 200 the access token is still valid.
  async checkProfile() {
    try {
      const res = await this.http.get(EP.PROFILE);
      return { ok: true, data: DhanAPI.unwrap(res) };
    } catch (err) {
      const status = err.response?.status;
      return { ok: false, status, message: err.response?.data?.errorMessage || err.message };
    }
  }
}

// ─── TOTP-based token refresh ────────────────────────────────────────────────
//
// Corrected version. Previous code called POST api.dhan.co/v2/token/generate
// with body { clientId, authCode } — that endpoint does not exist. The real
// endpoint (per Dhan v2 docs) is:
//
//   POST https://auth.dhan.co/app/generateAccessToken
//        ?dhanClientId={id}&pin={pin}&totp={totp}
//
// It requires the 6-digit Dhan PIN in addition to the TOTP. Returns a JWT
// valid for 24 hours plus an ISO expiryTime.
//
// Returns: { accessToken, expiryTime, clientName, clientUcc, ddpi } on success,
//          null on failure (error already logged).
async function refreshDhanToken(clientId, totpSecret, pin) {
  const OTPAuth = require("otpauth");
  if (!clientId || !totpSecret || !pin) {
    logger.error(`refreshDhanToken: missing required input (clientId=${!!clientId} totpSecret=${!!totpSecret} pin=${!!pin})`);
    return null;
  }
  try {
    const totp = new OTPAuth.TOTP({
      secret: OTPAuth.Secret.fromBase32(totpSecret),
      digits: 6,
      period: 30,
    });
    const otp = totp.generate();
    const ist = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
    logger.info(`TOTP generated for client ${clientId} (IST: ${ist})`);

    const res = await axios.post(
      `${AUTH_URL}${AUTH_EP.GENERATE}`,
      null,
      {
        params: { dhanClientId: clientId, pin, totp: otp },
        timeout: 15000,
      }
    );

    const newToken  = res.data?.accessToken;
    const expiryStr = res.data?.expiryTime; // e.g. "2026-04-21T12:37:23" — IST, no tz suffix
    if (!newToken) {
      logger.warn(`Token refresh returned no token for client ${clientId}: ${JSON.stringify(res.data)}`);
      return null;
    }
    logger.info(`Token refreshed for client ${clientId} at IST ${ist}, expires ${expiryStr}`);
    return {
      accessToken: newToken,
      expiryTime:  expiryStr, // caller stores this; we append +05:30 when parsing
      clientName:  res.data?.dhanClientName || null,
      clientUcc:   res.data?.dhanClientUcc  || null,
      ddpi:        res.data?.givenPowerOfAttorney ?? null,
    };
  } catch (err) {
    const detail = err.response
      ? `${err.response.status} ${JSON.stringify(err.response.data)}`
      : err.message;
    logger.error(`Token refresh failed for client ${clientId}: ${detail}`);
    return null;
  }
}

module.exports = { DhanAPI, refreshDhanToken };
