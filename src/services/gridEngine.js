const { DhanAPI }  = require("./dhan");
const { decrypt }  = require("./encryption");
const { logger }   = require("./logger");
const db           = require("./database");

// IST market hours check
function isMarketOpen() {
  const now = new Date();
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const wd  = ist.getDay(); // 0=Sun, 6=Sat
  if (wd === 0 || wd === 6) return false;
  const mins = ist.getHours() * 60 + ist.getMinutes();
  return mins >= 555 && mins <= 930; // 9:15 to 15:30 IST
}

function isNearClose() {
  const now = new Date();
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const mins = ist.getHours() * 60 + ist.getMinutes();
  return mins >= 920; // 15:20 IST — EOD cancel
}

function istNow() {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

// ─── Running bot instances ────────────────────────────────────────────────────
const runningBots = new Map(); // botId → { interval, api, state }

// ─── Start a bot ─────────────────────────────────────────────────────────────
async function startBot(botId) {
  if (runningBots.has(botId)) {
    logger.warn(`Bot ${botId} already running`);
    return { ok: false, message: "Bot already running" };
  }

  const bot = await db.getOne("SELECT b.*, c.credentials_enc, c.broker FROM bots b JOIN clients c ON b.client_id=c.id WHERE b.id=$1", [botId]);
  if (!bot) return { ok: false, message: "Bot not found" };

  const creds = decrypt(bot.credentials_enc);
  const api   = new DhanAPI(creds.client_id, creds.access_token);

  logger.info(`=== GRID BOT START | ${bot.ticker} | ${bot.exchange} | ${bot.product} | IST: ${istNow()} ===`);
  logger.info(`Script: ${bot.security_id} | ISIN: ${bot.isin} | Step: ₹${bot.grid_step} | Qty: ${bot.trade_qty}`);
  logger.info(`Range: ₹${bot.lower_limit} – ₹${bot.upper_limit} | Start: ₹${bot.start_price}`);

  // Check existing holdings (CNC)
  const holdings = await api.getHoldings();
  const holding  = holdings.find(h => String(h.securityId) === String(bot.security_id));
  let positionQty  = holding ? parseInt(holding.availableQty || holding.totalQty || 0) : 0;
  let lastFillPrice = holding ? parseFloat(holding.avgCostPrice || holding.averagePrice || 0) : 0;

  if (positionQty > 0) {
    logger.info(`Existing CNC holding: ${positionQty} shares @ ₹${lastFillPrice} — skipping initial buy`);
  } else {
    // Initial market buy
    logger.info(`No existing holding — market BUY ${bot.trade_qty} shares (CNC) IST: ${istNow()}`);
    const orderId = await api.placeMarketOrder({
      securityId: bot.security_id, exchangeSegment: bot.exchange,
      side: "BUY", qty: bot.trade_qty, productType: bot.product,
    });
    if (!orderId) { logger.error("Initial buy failed"); return { ok: false, message: "Initial buy failed" }; }

    await saveOrder(botId, bot.client_id, bot, orderId, "BUY", "MARKET", bot.trade_qty, 0);

    // Wait for fill
    for (let i = 0; i < 30; i++) {
      await sleep(2000);
      const { status, fillPrice } = await api.getStatusSmart(orderId);
      logger.info(`Waiting for fill... [${status}] attempt ${i + 1}/30 IST: ${istNow()}`);
      if (status === "TRADED") {
        lastFillPrice = fillPrice;
        positionQty   = bot.trade_qty;
        await db.query("UPDATE orders SET status='FILLED', fill_price=$1, filled_at=NOW() WHERE broker_order_id=$2", [fillPrice, orderId]);
        logger.info(`BUY filled @ ₹${fillPrice} | IST: ${istNow()}`);
        break;
      }
      if (status === "CANCELLED" || status === "REJECTED") {
        logger.error(`Initial buy ${status}`);
        return { ok: false, message: `Initial buy ${status}` };
      }
    }
  }

  // Place first grid pair
  const pair = await placeGridPair(api, bot, lastFillPrice, positionQty);
  if (!pair.ok) return { ok: false, message: "Grid placement failed" };

  // Update bot state in DB
  await db.query(`UPDATE bots SET status='RUNNING', position_qty=$1, last_fill_price=$2,
    buy_order_id=$3, sell_order_id=$4, buy_price=$5, sell_price=$6, updated_at=NOW()
    WHERE id=$7`,
    [positionQty, lastFillPrice, pair.buyId, pair.sellId, pair.buyPrice, pair.sellPrice, botId]);

  // ─── Poll loop — mirrors the main while loop in grid_bot_cnc.py ────────────
  const pollMs = 5000; // 5 seconds (same as POLL_INTERVAL=5 in Python)
  const interval = setInterval(async () => {
    try {
      if (!isMarketOpen()) {
        logger.info(`Market CLOSED IST: ${istNow()} — stopping bot ${bot.ticker}`);
        await stopBot(botId);
        return;
      }
      if (isNearClose()) {
        logger.info(`EOD 15:20 IST — cancelling grid, holding shares`);
        await cancelGridHoldShares(botId, api);
        return;
      }
      await monitorOrders(botId, api, bot);
    } catch (err) {
      logger.error(`Poll loop error bot ${botId}: ${err.message}`);
    }
  }, pollMs);

  runningBots.set(botId, { interval, api, bot });
  logger.info(`Bot ${botId} running (${bot.ticker}) | IST: ${istNow()}`);
  return { ok: true, message: "Bot started" };
}

// ─── Monitor orders — mirrors monitor_orders() in Python ─────────────────────
async function monitorOrders(botId, api, bot) {
  const state = await db.getOne("SELECT * FROM bots WHERE id=$1", [botId]);
  if (!state || state.status !== "RUNNING") return;
  if (state.waiting_reentry) return;

  const { status: buyStatus,  fillPrice: buyFill  } = state.buy_order_id  ? await api.getStatusSmart(state.buy_order_id)  : {};
  const { status: sellStatus, fillPrice: sellFill } = state.sell_order_id ? await api.getStatusSmart(state.sell_order_id) : {};

  logger.info(`BUY ₹${state.buy_price} [${buyStatus}] | SELL ₹${state.sell_price} [${sellStatus}] | Pos: ${state.position_qty} | IST: ${istNow()}`);

  if (buyStatus === "TRADED") {
    logger.info(`BUY FILLED @ ₹${buyFill} → cancel SELL → new grid | IST: ${istNow()}`);
    if (sellStatus !== "TRADED" && sellStatus !== "CANCELLED") {
      await api.cancelOrder(state.sell_order_id);
    }
    await db.query("UPDATE orders SET status='CANCELLED', cancelled_at=NOW() WHERE broker_order_id=$1", [state.sell_order_id]);
    await db.query("UPDATE orders SET status='FILLED', fill_price=$1, filled_at=NOW() WHERE broker_order_id=$2", [buyFill, state.buy_order_id]);

    const newQty = state.position_qty + bot.trade_qty;
    await sleep(1000);
    const pair = await placeGridPair(api, bot, buyFill, newQty);
    if (pair.ok) {
      await db.query(`UPDATE bots SET position_qty=$1, last_fill_price=$2,
        buy_order_id=$3, sell_order_id=$4, buy_price=$5, sell_price=$6, updated_at=NOW() WHERE id=$7`,
        [newQty, buyFill, pair.buyId, pair.sellId, pair.buyPrice, pair.sellPrice, botId]);
    }

  } else if (sellStatus === "TRADED") {
    const profit = parseFloat(bot.tp_interval || bot.grid_step) * bot.trade_qty;
    logger.info(`SELL FILLED @ ₹${sellFill} → profit ₹${profit} | IST: ${istNow()}`);
    if (buyStatus !== "TRADED" && buyStatus !== "CANCELLED") {
      await api.cancelOrder(state.buy_order_id);
    }
    await db.query("UPDATE orders SET status='CANCELLED', cancelled_at=NOW() WHERE broker_order_id=$1", [state.buy_order_id]);
    await db.query("UPDATE orders SET status='FILLED', fill_price=$1, filled_at=NOW() WHERE broker_order_id=$2", [sellFill, state.sell_order_id]);

    const newQty    = state.position_qty - bot.trade_qty;
    const newPnl    = parseFloat(state.realized_pnl || 0) + profit;
    const newCycles = (state.total_cycles || 0) + 1;

    if (newQty <= 0) {
      logger.info(`ALL SHARES SOLD @ ₹${sellFill}. Starting 1-min re-entry watch. IST: ${istNow()}`);
      await db.query(`UPDATE bots SET position_qty=0, waiting_reentry=TRUE, realized_pnl=$1, total_cycles=$2, updated_at=NOW() WHERE id=$3`,
        [newPnl, newCycles, botId]);
      startReentryWatcher(botId, api, bot, sellFill);
      return;
    }

    await sleep(1000);
    const pair = await placeGridPair(api, bot, sellFill, newQty);
    if (pair.ok) {
      await db.query(`UPDATE bots SET position_qty=$1, last_fill_price=$2, realized_pnl=$3, total_cycles=$4,
        buy_order_id=$5, sell_order_id=$6, buy_price=$7, sell_price=$8, updated_at=NOW() WHERE id=$9`,
        [newQty, sellFill, newPnl, newCycles, pair.buyId, pair.sellId, pair.buyPrice, pair.sellPrice, botId]);
    }

  } else if (buyStatus === "CANCELLED" || buyStatus === "REJECTED") {
    logger.warn(`BUY ${buyStatus} — re-placing @ ₹${state.buy_price} IST: ${istNow()}`);
    const newId = await api.placeLimitOrder({ securityId: bot.security_id, exchangeSegment: bot.exchange, side: "BUY", qty: bot.trade_qty, price: state.buy_price, productType: bot.product });
    if (newId) await db.query("UPDATE bots SET buy_order_id=$1, updated_at=NOW() WHERE id=$2", [newId, botId]);

  } else if (sellStatus === "CANCELLED" || sellStatus === "REJECTED") {
    logger.warn(`SELL ${sellStatus} — re-placing @ ₹${state.sell_price} IST: ${istNow()}`);
    const newId = await api.placeLimitOrder({ securityId: bot.security_id, exchangeSegment: bot.exchange, side: "SELL", qty: bot.trade_qty, price: state.sell_price, productType: bot.product });
    if (newId) await db.query("UPDATE bots SET sell_order_id=$1, updated_at=NOW() WHERE id=$2", [newId, botId]);
  }
}

// ─── Re-entry watcher — mirrors start_reentry_watcher() in Python ─────────────
function startReentryWatcher(botId, api, bot, startPrice) {
  logger.info(`1-MIN RE-ENTRY WATCHER started @ ₹${startPrice}. Need ₹${bot.grid_step} drop. IST: ${istNow()}`);
  let candleStart = Date.now();
  let candleHigh  = startPrice;

  const watchInterval = setInterval(async () => {
    if (!isMarketOpen() || isNearClose()) {
      logger.info("Market closed/near-close — re-entry watch stopped");
      clearInterval(watchInterval);
      await db.query("UPDATE bots SET waiting_reentry=FALSE, updated_at=NOW() WHERE id=$1", [botId]);
      return;
    }

    const ltp = await api.getLTP(bot.security_id, bot.exchange);
    if (!ltp) return;

    const elapsed = (Date.now() - candleStart) / 60000;
    if (elapsed >= 1) { // 1-minute candle reset
      logger.info(`1-min candle closed. High=₹${candleHigh}. New candle @ ₹${ltp}. IST: ${istNow()}`);
      candleStart = Date.now();
      candleHigh  = ltp;
    }
    if (ltp > candleHigh) { candleHigh = ltp; logger.info(`New 1-min high: ₹${candleHigh}`); }

    const drop = candleHigh - ltp;
    logger.info(`Re-entry | LTP ₹${ltp} | 1m-High ₹${candleHigh} | Drop ₹${drop.toFixed(2)} | Need ₹${bot.grid_step} | IST: ${istNow()}`);

    if (drop >= bot.grid_step) {
      logger.info(`🎯 RE-ENTRY TRIGGERED! Drop=₹${drop.toFixed(2)} from ₹${candleHigh}. IST: ${istNow()}`);
      clearInterval(watchInterval);
      await db.query("UPDATE bots SET waiting_reentry=FALSE, updated_at=NOW() WHERE id=$1", [botId]);

      // Re-entry market buy
      const orderId = await api.placeMarketOrder({ securityId: bot.security_id, exchangeSegment: bot.exchange, side: "BUY", qty: bot.trade_qty, productType: bot.product });
      if (!orderId) { logger.error("Re-entry order failed"); return; }

      for (let i = 0; i < 30; i++) {
        await sleep(2000);
        const { status, fillPrice } = await api.getStatusSmart(orderId);
        if (status === "TRADED") {
          logger.info(`RE-ENTRY BUY filled @ ₹${fillPrice}. Grid restarting. IST: ${istNow()}`);
          const pair = await placeGridPair(api, bot, fillPrice, bot.trade_qty);
          if (pair.ok) {
            await db.query(`UPDATE bots SET position_qty=$1, last_fill_price=$2,
              buy_order_id=$3, sell_order_id=$4, buy_price=$5, sell_price=$6, updated_at=NOW() WHERE id=$7`,
              [bot.trade_qty, fillPrice, pair.buyId, pair.sellId, pair.buyPrice, pair.sellPrice, botId]);
          }
          return;
        }
        if (status === "CANCELLED" || status === "REJECTED") { logger.error(`Re-entry order ${status}`); return; }
      }
    }
  }, 5000);
}

// ─── Place grid pair — mirrors place_grid_pair() ─────────────────────────────
async function placeGridPair(api, bot, refPrice, posQty) {
  const buyPrice  = parseFloat((refPrice - bot.grid_step).toFixed(2));
  const sellPrice = parseFloat((refPrice + (bot.tp_interval || bot.grid_step)).toFixed(2));
  logger.info(`GRID: SELL @ ₹${sellPrice} | Ref ₹${refPrice} | BUY @ ₹${buyPrice} | IST: ${istNow()}`);

  const buyId  = await api.placeLimitOrder({ securityId: bot.security_id, exchangeSegment: bot.exchange, side: "BUY",  qty: bot.trade_qty, price: buyPrice,  productType: bot.product });
  const sellId = await api.placeLimitOrder({ securityId: bot.security_id, exchangeSegment: bot.exchange, side: "SELL", qty: bot.trade_qty, price: sellPrice, productType: bot.product });

  if (!buyId || !sellId) {
    if (buyId)  await api.cancelOrder(buyId);
    if (sellId) await api.cancelOrder(sellId);
    logger.error("Grid placement failed — cleaned up");
    return { ok: false };
  }

  await Promise.all([
    saveOrder(bot.id, bot.client_id, bot, buyId,  "BUY",  "LIMIT", bot.trade_qty, buyPrice),
    saveOrder(bot.id, bot.client_id, bot, sellId, "SELL", "LIMIT", bot.trade_qty, sellPrice),
  ]);

  logger.info(`Grid active. BUY:${buyId} SELL:${sellId} | IST: ${istNow()}`);
  return { ok: true, buyId, sellId, buyPrice, sellPrice };
}

// ─── EOD cancel grid, hold shares — mirrors cancel_grid_hold_shares() ─────────
async function cancelGridHoldShares(botId, api) {
  const state = await db.getOne("SELECT * FROM bots WHERE id=$1", [botId]);
  if (!state) return;
  logger.info(`EOD: Cancelling grid. Holding ${state.position_qty} shares overnight. IST: ${istNow()}`);
  if (state.buy_order_id)  await api.cancelOrder(state.buy_order_id);
  if (state.sell_order_id) await api.cancelOrder(state.sell_order_id);
  await db.query("UPDATE bots SET status='IDLE', buy_order_id=NULL, sell_order_id=NULL, updated_at=NOW() WHERE id=$1", [botId]);
  const inst = runningBots.get(botId);
  if (inst) { clearInterval(inst.interval); runningBots.delete(botId); }
}

// ─── Stop bot ─────────────────────────────────────────────────────────────────
async function stopBot(botId) {
  const inst = runningBots.get(botId);
  if (inst) {
    clearInterval(inst.interval);
    runningBots.delete(botId);
    const state = await db.getOne("SELECT buy_order_id, sell_order_id, position_qty FROM bots WHERE id=$1", [botId]);
    if (state?.buy_order_id)  await inst.api.cancelOrder(state.buy_order_id);
    if (state?.sell_order_id) await inst.api.cancelOrder(state.sell_order_id);
    logger.info(`Bot ${botId} stopped. ${state?.position_qty||0} shares held in Demat. IST: ${istNow()}`);
  }
  await db.query("UPDATE bots SET status='STOPPED', buy_order_id=NULL, sell_order_id=NULL, updated_at=NOW() WHERE id=$1", [botId]);
}

// ─── Kill switch — square off all positions ───────────────────────────────────
async function killAllBots(clientId = null) {
  logger.warn(`⚡ KILL SWITCH EXECUTED | clientId:${clientId||"ALL"} | IST: ${istNow()}`);
  const where = clientId ? "WHERE client_id=$1 AND status IN ('RUNNING','PAUSED')" : "WHERE status IN ('RUNNING','PAUSED')";
  const bots  = await db.getAll(`SELECT id FROM bots ${where}`, clientId ? [clientId] : []);
  for (const b of bots) await stopBot(b.id);
  await db.query(`UPDATE bots SET status='STOPPED', killed_at=NOW() ${where}`, clientId ? [clientId] : []);
  return { killed: bots.length };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function saveOrder(botId, clientId, bot, brokerId, side, type, qty, price) {
  try {
    await db.query(`INSERT INTO orders (bot_id,client_id,broker_order_id,exchange,security_id,ticker,side,order_type,product,qty,price,status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'PENDING')`,
      [botId, clientId, brokerId, bot.exchange, bot.security_id, bot.ticker, side, type, bot.product, qty, price]);
  } catch (e) { logger.error(`saveOrder error: ${e.message}`); }
}

module.exports = { startBot, stopBot, killAllBots, runningBots };
