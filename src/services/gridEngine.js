const { DhanAPI }  = require("./dhan");
const { decrypt }  = require("./encryption");
const { logger }   = require("./logger");
const db           = require("./database");

// ─── Market hours helpers ────────────────────────────────────────────────────
function istNow() {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

function istMinutes() {
  const ist = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  return { weekday: ist.getDay(), mins: ist.getHours() * 60 + ist.getMinutes() };
}

function isMarketOpen() {
  const { weekday, mins } = istMinutes();
  if (weekday === 0 || weekday === 6) return false;
  return mins >= 555 && mins <= 930; // 09:15–15:30 IST
}

function isNearClose() {
  return istMinutes().mins >= 920; // 15:20 IST
}

// ─── In-memory running bot registry (lost on PM2 restart; resumeBotsOnStartup rebuilds it) ──
const runningBots = new Map(); // botId → { interval, watcherInterval, api, bot }

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function saveOrder(botId, clientId, bot, brokerId, side, type, qty, price) {
  try {
    await db.query(
      `INSERT INTO orders (bot_id,client_id,broker_order_id,exchange,security_id,ticker,side,order_type,product,qty,price,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'PENDING')`,
      [botId, clientId, brokerId, bot.exchange, bot.security_id, bot.ticker, side, type, bot.product, qty, price]
    );
  } catch (e) { logger.error(`saveOrder error: ${e.message}`); }
}

function pairBlocked(refPrice, bot) {
  const buyPrice  = +(refPrice - parseFloat(bot.grid_step)).toFixed(2);
  const sellPrice = +(refPrice + parseFloat(bot.tp_interval || bot.grid_step)).toFixed(2);
  const lower = bot.lower_limit ? parseFloat(bot.lower_limit) : null;
  const upper = bot.upper_limit ? parseFloat(bot.upper_limit) : null;
  return {
    buyPrice,
    sellPrice,
    buyBlocked:  lower != null && buyPrice  <= lower,
    sellBlocked: upper != null && sellPrice >= upper,
  };
}

// ─── Start a bot (called from bot creation + resumeBotsOnStartup) ─────────────
async function startBot(botId) {
  if (runningBots.has(botId)) {
    logger.warn(`Bot ${botId} already running in-memory — ignoring duplicate start`);
    return { ok: false, message: "Bot already running" };
  }

  if (!isMarketOpen()) {
    return { ok: false, message: `Market closed. Current IST: ${istNow()}` };
  }

  const bot = await db.getOne(
    `SELECT b.*, c.credentials_enc, c.broker
     FROM bots b JOIN clients c ON b.client_id = c.id WHERE b.id = $1`, [botId]
  );
  if (!bot) return { ok: false, message: "Bot not found" };
  if (bot.status === "KILLED") return { ok: false, message: "Bot is killed, cannot restart" };

  const creds = decrypt(bot.credentials_enc);
  const api   = new DhanAPI(creds.client_id, creds.access_token);

  logger.info(`=== GRID BOT START | ${bot.ticker} | ${bot.exchange} | IST: ${istNow()} ===`);
  logger.info(`Script: ${bot.security_id} | Step: ₹${bot.grid_step} | TP: ₹${bot.tp_interval || bot.grid_step} | Qty: ${bot.trade_qty}`);
  logger.info(`Range: ₹${bot.lower_limit || "-"}–₹${bot.upper_limit || "-"} | Initial qty: ${bot.initial_qty} | Ref: ₹${bot.start_price}`);

  // SEEDING: ensure we hold at least initial_qty before the grid activates
  let positionQty   = parseInt(bot.position_qty || 0);
  let lastFillPrice = parseFloat(bot.last_fill_price || bot.start_price);
  let avgBuyPrice   = parseFloat(bot.avg_buy_price   || bot.last_fill_price || bot.start_price);

  if (positionQty < parseInt(bot.initial_qty || 0)) {
    const targetQty = parseInt(bot.initial_qty);

    // Reconcile with Dhan holdings first (user may already hold the shares)
    const holdings = await api.getHoldings();
    const h = holdings.find(x => String(x.securityId) === String(bot.security_id));
    const heldInDhan = h ? parseInt(h.availableQty || h.totalQty || 0) : 0;

    if (heldInDhan >= targetQty) {
      positionQty   = targetQty;
      avgBuyPrice   = parseFloat(h.avgCostPrice || lastFillPrice);
      lastFillPrice = avgBuyPrice;
      logger.info(`Dhan already holds ${heldInDhan} — adopting ${targetQty} @ avg ₹${avgBuyPrice} as initial. Skipping seed buy.`);
    } else {
      const shortfall = targetQty - heldInDhan;
      logger.info(`Seeding: Dhan holds ${heldInDhan}, need ${targetQty} — market BUY for ${shortfall}`);
      await db.query("UPDATE bots SET status='SEEDING', updated_at=NOW() WHERE id=$1", [botId]);

      const seedId = await api.placeMarketOrder({
        securityId: bot.security_id, exchangeSegment: bot.exchange,
        side: "BUY", qty: shortfall, productType: bot.product,
      });
      if (!seedId) {
        const reason = api.lastError || "Unknown";
        await db.query("UPDATE bots SET status='PAUSED', updated_at=NOW() WHERE id=$1", [botId]);
        return { ok: false, message: `Seed buy failed: ${reason}` };
      }
      await saveOrder(botId, bot.client_id, bot, seedId, "BUY", "MARKET", shortfall, 0);

      // Wait for full seed fill (partial-fill rule: wait until complete)
      const filled = await waitForCompleteFill(api, seedId, 30);
      if (!filled.ok) {
        await db.query("UPDATE bots SET status='PAUSED', updated_at=NOW() WHERE id=$1", [botId]);
        return { ok: false, message: `Seed buy did not complete: ${filled.reason}` };
      }
      // Weighted avg across Dhan-held + seed-filled
      const seedQty   = filled.filledQty;
      const seedPrice = filled.fillPrice;
      const dhanAvg   = h ? parseFloat(h.avgCostPrice || 0) : 0;
      const totalQty  = heldInDhan + seedQty;
      avgBuyPrice   = totalQty > 0 ? ((dhanAvg * heldInDhan) + (seedPrice * seedQty)) / totalQty : seedPrice;
      lastFillPrice = seedPrice;
      positionQty   = totalQty;
      await db.query("UPDATE orders SET status='FILLED', fill_price=$1, filled_at=NOW() WHERE broker_order_id=$2", [seedPrice, seedId]);
      logger.info(`SEED filled ${seedQty} @ ₹${seedPrice}. Position=${positionQty}, avgBuy=₹${avgBuyPrice.toFixed(2)}`);
    }
  }

  // ── Place first grid pair
  const pair = await placeGridPair(api, bot, lastFillPrice, positionQty);
  if (!pair.ok && !pair.allBlocked) {
    return { ok: false, message: `Grid placement failed: ${api.lastError || "unknown"}` };
  }
  if (pair.allBlocked) {
    logger.warn(`Both sides blocked by limits at start — bot goes to PAUSED`);
    await db.query("UPDATE bots SET status='PAUSED', position_qty=$1, last_fill_price=$2, avg_buy_price=$3, updated_at=NOW() WHERE id=$4",
      [positionQty, lastFillPrice, avgBuyPrice, botId]);
    return { ok: true, message: "Bot created but PAUSED — price outside limits" };
  }

  await db.query(
    `UPDATE bots SET status='RUNNING', position_qty=$1, last_fill_price=$2, avg_buy_price=$3,
       buy_order_id=$4, sell_order_id=$5, buy_price=$6, sell_price=$7, waiting_reentry=FALSE,
       flat_peak_price=NULL, flat_since_ts=NULL, updated_at=NOW() WHERE id=$8`,
    [positionQty, lastFillPrice, avgBuyPrice, pair.buyId, pair.sellId, pair.buyPrice, pair.sellPrice, botId]
  );

  // Main 5-second poll loop
  const interval = setInterval(() => monitorTick(botId, api).catch(e => logger.error(`Poll error bot ${botId}: ${e.message}`)), 5000);
  // Reconcile every 5 min (safety net)
  const reconcileInterval = setInterval(() => reconcileBot(botId, api).catch(e => logger.error(`Reconcile error bot ${botId}: ${e.message}`)), 5 * 60 * 1000);

  runningBots.set(botId, { interval, reconcileInterval, api, bot });
  logger.info(`Bot ${botId} (${bot.ticker}) RUNNING | IST: ${istNow()}`);
  return { ok: true, message: "Bot started" };
}

// ─── Main tick — drive RUNNING / WAITING_FLAT / PAUSED transitions ────────────
async function monitorTick(botId, api) {
  if (!isMarketOpen()) { logger.info(`Market closed — stopping ${botId}`); await stopBot(botId); return; }
  if (isNearClose())    { logger.info(`EOD ${istNow()} — cancelling grid, holding shares`); await cancelGridHoldShares(botId, api); return; }

  const state = await db.getOne("SELECT * FROM bots WHERE id=$1", [botId]);
  if (!state || state.status === "KILLED") { await stopBot(botId); return; }

  if (state.status === "PAUSED") return; // do nothing, wait for user action
  if (state.status === "WAITING_FLAT") { await waitingFlatTick(botId, api, state); return; }
  if (state.status !== "RUNNING") return;

  // RUNNING — check our two orders
  const buy  = state.buy_order_id  ? await api.getStatusSmart(state.buy_order_id)  : { status: null };
  const sell = state.sell_order_id ? await api.getStatusSmart(state.sell_order_id) : { status: null };

  logger.info(`[${state.ticker}] BUY ₹${state.buy_price} [${buy.status}] | SELL ₹${state.sell_price} [${sell.status}] | Pos: ${state.position_qty}`);

  // Partial-fill guard: if either order is partially filled, do nothing — wait
  const buyPartial  = buy.status  === "TRADED" && buy.fillPrice  && state.buy_order_id  && await isPartial(api, state.buy_order_id);
  const sellPartial = sell.status === "TRADED" && sell.fillPrice && state.sell_order_id && await isPartial(api, state.sell_order_id);
  if (buyPartial || sellPartial) {
    logger.info(`Partial fill on one side — waiting for completion before re-arming`);
    return;
  }

  if (buy.status === "TRADED" && !buyPartial) {
    await handleBuyFilled(botId, api, state, buy.fillPrice);
  } else if (sell.status === "TRADED" && !sellPartial) {
    await handleSellFilled(botId, api, state, sell.fillPrice);
  } else if (buy.status === "CANCELLED" || buy.status === "REJECTED") {
    logger.warn(`BUY ${buy.status} — re-placing`);
    const newId = await api.placeLimitOrder({ securityId: state.security_id, exchangeSegment: state.exchange, side: "BUY", qty: state.trade_qty, price: state.buy_price, productType: state.product });
    if (newId) await db.query("UPDATE bots SET buy_order_id=$1 WHERE id=$2", [newId, botId]);
  } else if (sell.status === "CANCELLED" || sell.status === "REJECTED") {
    logger.warn(`SELL ${sell.status} — re-placing`);
    const newId = await api.placeLimitOrder({ securityId: state.security_id, exchangeSegment: state.exchange, side: "SELL", qty: state.trade_qty, price: state.sell_price, productType: state.product });
    if (newId) await db.query("UPDATE bots SET sell_order_id=$1 WHERE id=$2", [newId, botId]);
  }
}

// ─── Handle BUY fill — qty increases, ref_price moves down, re-arm ────────────
async function handleBuyFilled(botId, api, state, fillPrice) {
  logger.info(`BUY FILLED @ ₹${fillPrice} (bot ${state.ticker})`);
  if (state.sell_order_id) await api.cancelOrder(state.sell_order_id).catch(()=>{});
  await db.query("UPDATE orders SET status='CANCELLED', cancelled_at=NOW() WHERE broker_order_id=$1", [state.sell_order_id]);
  await db.query("UPDATE orders SET status='FILLED', fill_price=$1, filled_at=NOW() WHERE broker_order_id=$2", [fillPrice, state.buy_order_id]);

  const prevQty  = parseInt(state.position_qty);
  const prevAvg  = parseFloat(state.avg_buy_price || state.last_fill_price);
  const addQty   = parseInt(state.trade_qty);
  const newQty   = prevQty + addQty;
  const newAvg   = newQty > 0 ? ((prevAvg * prevQty) + (fillPrice * addQty)) / newQty : fillPrice;
  const cycles   = (state.total_cycles || 0) + 1;

  await sleep(500);
  const pair = await placeGridPair(api, state, fillPrice, newQty);
  await applyGridUpdate(botId, { positionQty: newQty, lastFill: fillPrice, avgBuy: newAvg, cycles, pair });
}

// ─── Handle SELL fill — qty decreases, maybe go WAITING_FLAT ──────────────────
async function handleSellFilled(botId, api, state, fillPrice) {
  logger.info(`SELL FILLED @ ₹${fillPrice} (bot ${state.ticker})`);
  if (state.buy_order_id) await api.cancelOrder(state.buy_order_id).catch(()=>{});
  await db.query("UPDATE orders SET status='CANCELLED', cancelled_at=NOW() WHERE broker_order_id=$1", [state.buy_order_id]);
  await db.query("UPDATE orders SET status='FILLED', fill_price=$1, filled_at=NOW() WHERE broker_order_id=$2", [fillPrice, state.sell_order_id]);

  const prevQty = parseInt(state.position_qty);
  const prevAvg = parseFloat(state.avg_buy_price || state.last_fill_price);
  const soldQty = parseInt(state.trade_qty);
  const profit  = (fillPrice - prevAvg) * soldQty;
  const newQty  = prevQty - soldQty;
  const newPnl  = parseFloat(state.realized_pnl || 0) + profit;
  const cycles  = (state.total_cycles || 0) + 1;

  if (newQty <= 0) {
    logger.info(`Position flat after SELL @ ₹${fillPrice}. Entering WAITING_FLAT.`);
    await db.query(
      `UPDATE bots SET status='WAITING_FLAT', position_qty=0, realized_pnl=$1, total_cycles=$2,
         buy_order_id=NULL, sell_order_id=NULL, buy_price=NULL, sell_price=NULL,
         flat_peak_price=$3, flat_since_ts=NOW(), updated_at=NOW() WHERE id=$4`,
      [newPnl, cycles, fillPrice, botId]
    );
    return;
  }

  await sleep(500);
  const pair = await placeGridPair(api, state, fillPrice, newQty);
  await applyGridUpdate(botId, { positionQty: newQty, lastFill: fillPrice, avgBuy: prevAvg, cycles, pnl: newPnl, pair });
}

async function applyGridUpdate(botId, { positionQty, lastFill, avgBuy, cycles, pnl, pair }) {
  if (pair.allBlocked) {
    logger.warn(`Both limits breached — bot PAUSED`);
    await db.query("UPDATE bots SET status='PAUSED', position_qty=$1, last_fill_price=$2, avg_buy_price=$3, total_cycles=$4, realized_pnl=COALESCE($5,realized_pnl), buy_order_id=NULL, sell_order_id=NULL, updated_at=NOW() WHERE id=$6",
      [positionQty, lastFill, avgBuy, cycles, pnl, botId]);
    return;
  }
  await db.query(
    `UPDATE bots SET position_qty=$1, last_fill_price=$2, avg_buy_price=$3, total_cycles=$4,
       realized_pnl=COALESCE($5,realized_pnl),
       buy_order_id=$6, sell_order_id=$7, buy_price=$8, sell_price=$9, updated_at=NOW()
     WHERE id=$10`,
    [positionQty, lastFill, avgBuy, cycles, pnl, pair.buyId, pair.sellId, pair.buyPrice, pair.sellPrice, botId]
  );
}

// ─── WAITING_FLAT tick — poll 5-min candles, watch for pullback ───────────────
async function waitingFlatTick(botId, api, state) {
  const ltp = await api.getLTP(state.security_id, state.exchange);
  if (!ltp) return;

  // Peak tracking: since flat_since_ts, highest LTP AND highest 5-min HIGH
  let peak = parseFloat(state.flat_peak_price || ltp);
  if (ltp > peak) peak = ltp;

  // Pull 5-min candles since flat_since_ts and update peak from candle HIGHs
  // (lightweight — only if ltp moved; reduce Dhan calls)
  // For simplicity this tick uses LTP peak; a separate 5-min-candle refresher could augment.

  const trigger = peak - parseFloat(state.grid_step);
  logger.info(`[${state.ticker}] WAITING_FLAT | LTP ₹${ltp} | Peak ₹${peak} | Trigger ₹${trigger.toFixed(2)} | Need drop ₹${state.grid_step}`);

  if (peak !== parseFloat(state.flat_peak_price)) {
    await db.query("UPDATE bots SET flat_peak_price=$1, updated_at=NOW() WHERE id=$2", [peak, botId]);
  }

  if (ltp <= trigger) {
    logger.info(`🎯 Pullback hit. LTP ₹${ltp} <= trigger ₹${trigger.toFixed(2)}. Market BUY ${state.initial_qty}`);
    const orderId = await api.placeMarketOrder({ securityId: state.security_id, exchangeSegment: state.exchange, side: "BUY", qty: state.initial_qty, productType: state.product });
    if (!orderId) { logger.error(`Re-entry buy failed: ${api.lastError}`); return; }
    await saveOrder(botId, state.client_id, state, orderId, "BUY", "MARKET", state.initial_qty, 0);

    const filled = await waitForCompleteFill(api, orderId, 30);
    if (!filled.ok) { logger.error(`Re-entry did not complete: ${filled.reason}`); return; }

    await db.query("UPDATE orders SET status='FILLED', fill_price=$1, filled_at=NOW() WHERE broker_order_id=$2", [filled.fillPrice, orderId]);

    const pair = await placeGridPair(api, state, filled.fillPrice, state.initial_qty);
    if (pair.allBlocked) {
      await db.query("UPDATE bots SET status='PAUSED', position_qty=$1, last_fill_price=$2, avg_buy_price=$2, flat_peak_price=NULL, flat_since_ts=NULL WHERE id=$3",
        [state.initial_qty, filled.fillPrice, botId]);
      return;
    }
    await db.query(
      `UPDATE bots SET status='RUNNING', position_qty=$1, last_fill_price=$2, avg_buy_price=$2,
         buy_order_id=$3, sell_order_id=$4, buy_price=$5, sell_price=$6,
         flat_peak_price=NULL, flat_since_ts=NULL, updated_at=NOW() WHERE id=$7`,
      [state.initial_qty, filled.fillPrice, pair.buyId, pair.sellId, pair.buyPrice, pair.sellPrice, botId]
    );
  }
}

// ─── Place grid pair with upper/lower limit enforcement ───────────────────────
async function placeGridPair(api, bot, refPrice, posQty) {
  const { buyPrice, sellPrice, buyBlocked, sellBlocked } = pairBlocked(refPrice, bot);
  const canSell = posQty >= parseInt(bot.trade_qty) && !sellBlocked;
  const canBuy  = !buyBlocked;

  if (!canBuy && !canSell) {
    logger.warn(`GRID blocked on both sides: buy@₹${buyPrice} vs lower₹${bot.lower_limit} | sell@₹${sellPrice} vs upper₹${bot.upper_limit} (pos=${posQty})`);
    return { ok: false, allBlocked: true };
  }

  let buyId = null, sellId = null;
  if (canBuy)  buyId  = await api.placeLimitOrder({ securityId: bot.security_id, exchangeSegment: bot.exchange, side: "BUY",  qty: bot.trade_qty, price: buyPrice,  productType: bot.product });
  if (canSell) sellId = await api.placeLimitOrder({ securityId: bot.security_id, exchangeSegment: bot.exchange, side: "SELL", qty: bot.trade_qty, price: sellPrice, productType: bot.product });

  // Require at least one side to be live; if neither placed, treat as failure
  if ((canBuy && !buyId) || (canSell && !sellId)) {
    if (buyId)  await api.cancelOrder(buyId).catch(()=>{});
    if (sellId) await api.cancelOrder(sellId).catch(()=>{});
    return { ok: false, allBlocked: false };
  }

  if (buyId)  await saveOrder(bot.id, bot.client_id, bot, buyId,  "BUY",  "LIMIT", bot.trade_qty, buyPrice);
  if (sellId) await saveOrder(bot.id, bot.client_id, bot, sellId, "SELL", "LIMIT", bot.trade_qty, sellPrice);

  logger.info(`GRID placed | BUY ${canBuy ? "₹"+buyPrice+" ("+buyId+")" : "SKIPPED(lower)"} | SELL ${canSell ? "₹"+sellPrice+" ("+sellId+")" : "SKIPPED(upper/no-qty)"}`);
  return { ok: true, allBlocked: false, buyId, sellId, buyPrice: canBuy ? buyPrice : null, sellPrice: canSell ? sellPrice : null };
}

// ─── Wait for complete fill (handles partial-fill rule) ───────────────────────
async function waitForCompleteFill(api, orderId, maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(2000);
    const s = await api.getStatusSmart(orderId);
    if (s.status === "TRADED") {
      const partial = await isPartial(api, orderId);
      if (!partial) return { ok: true, fillPrice: s.fillPrice, filledQty: null };
    }
    if (s.status === "CANCELLED" || s.status === "REJECTED") {
      return { ok: false, reason: s.status };
    }
  }
  return { ok: false, reason: "timeout" };
}

async function isPartial(api, orderId) {
  try {
    const all = await api.getAllOrders();
    const o = all.find(x => String(x.orderId) === String(orderId));
    if (!o) return false;
    return o.filledQty > 0 && o.filledQty < o.quantity && o.orderStatus !== "TRADED";
  } catch { return false; }
}

// ─── Reconcile one bot's position against Dhan holdings ───────────────────────
async function reconcileBot(botId, api) {
  const state = await db.getOne("SELECT * FROM bots WHERE id=$1", [botId]);
  if (!state || !["RUNNING","WAITING_FLAT","PAUSED"].includes(state.status)) return;

  // Fetch BOTH holdings (settled + T1 shares from prior days) AND positions (today's intraday net)
  // because today's bot-bought shares appear in positions, NOT holdings (T+1 settlement).
  let holdings, positions;
  try {
    [holdings, positions] = await Promise.all([api.getHoldings(), api.getPositions()]);
  } catch (e) {
    logger.warn(`RECONCILE ${state.ticker}: API fetch failed (${e.message}) — skipping reconcile this cycle`);
    return;
  }

  const h = holdings.find(x => String(x.securityId) === String(state.security_id));
  const p = positions.find(x => String(x.securityId) === String(state.security_id));

  // Holdings: use totalQty (settled + T1), NOT availableQty (which excludes T1 shares we own but cannot sell yet)
  const holdingQty = h ? parseInt(h.totalQty || 0) : 0;
  const holdingAvg = h ? parseFloat(h.avgCostPrice || 0) : 0;

  // Positions: netQty is signed. For a long-only grid bot, this should always be >= 0.
  const positionNetQty = p ? parseInt(p.netQty || 0) : 0;
  const positionAvg    = p ? parseFloat(p.buyAvg || 0) : 0;

  if (positionNetQty < 0) {
    logger.warn(`RECONCILE ${state.ticker}: Dhan position is short (netQty=${positionNetQty}) — unexpected for grid bot. Skipping reconcile.`);
    return;
  }

  const dhanQty = holdingQty + positionNetQty;
  const botQty  = parseInt(state.position_qty || 0);

  // Weighted average across both sources, falling back to existing avg if no shares
  const dhanAvg = dhanQty > 0
    ? ((holdingAvg * holdingQty) + (positionAvg * positionNetQty)) / dhanQty
    : parseFloat(state.avg_buy_price || 0);

  if (dhanQty !== botQty) {
    logger.warn(`RECONCILE ${state.ticker}: Dhan=${dhanQty} (holdings=${holdingQty} + intraday=${positionNetQty}) Bot=${botQty} — adopting Dhan as truth, avg=₹${dhanAvg.toFixed(2)}`);
    await db.query(
      "UPDATE bots SET position_qty=$1, avg_buy_price=$2, updated_at=NOW() WHERE id=$3",
      [dhanQty, dhanAvg, botId]
    );
  }
}
// ─── EOD: cancel grid, keep shares, bot status → IDLE ─────────────────────────
async function cancelGridHoldShares(botId, api) {
  const state = await db.getOne("SELECT * FROM bots WHERE id=$1", [botId]);
  if (!state) return;
  logger.info(`EOD cancel grid | ${state.ticker} | holding ${state.position_qty} overnight`);
  if (state.buy_order_id)  await api.cancelOrder(state.buy_order_id).catch(()=>{});
  if (state.sell_order_id) await api.cancelOrder(state.sell_order_id).catch(()=>{});
  await db.query("UPDATE bots SET status='IDLE', buy_order_id=NULL, sell_order_id=NULL, buy_price=NULL, sell_price=NULL, updated_at=NOW() WHERE id=$1", [botId]);
  const inst = runningBots.get(botId);
  if (inst) { clearInterval(inst.interval); if (inst.reconcileInterval) clearInterval(inst.reconcileInterval); runningBots.delete(botId); }
}

// ─── Stop bot (used on market close / manual stop) ────────────────────────────
async function stopBot(botId) {
  const inst = runningBots.get(botId);
  if (inst) {
    clearInterval(inst.interval);
    if (inst.reconcileInterval) clearInterval(inst.reconcileInterval);
    runningBots.delete(botId);
    const state = await db.getOne("SELECT buy_order_id, sell_order_id FROM bots WHERE id=$1", [botId]);
    if (state?.buy_order_id)  await inst.api.cancelOrder(state.buy_order_id).catch(()=>{});
    if (state?.sell_order_id) await inst.api.cancelOrder(state.sell_order_id).catch(()=>{});
  }
  await db.query("UPDATE bots SET status='IDLE', buy_order_id=NULL, sell_order_id=NULL, updated_at=NOW() WHERE id=$1 AND status NOT IN ('KILLED','PAUSED')", [botId]);
}

// ─── Kill switch (Phase E will expand; for now: cancel + mark KILLED) ─────────
async function killBot(botId) {
  const inst = runningBots.get(botId);
  const state = await db.getOne("SELECT buy_order_id, sell_order_id, client_id, credentials_enc FROM bots b JOIN clients c ON b.client_id=c.id WHERE b.id=$1", [botId]);
  if (state) {
    const creds = decrypt(state.credentials_enc);
    const api = inst?.api || new DhanAPI(creds.client_id, creds.access_token);
    if (state.buy_order_id)  await api.cancelOrder(state.buy_order_id).catch(()=>{});
    if (state.sell_order_id) await api.cancelOrder(state.sell_order_id).catch(()=>{});
  }
  if (inst) { clearInterval(inst.interval); if (inst.reconcileInterval) clearInterval(inst.reconcileInterval); runningBots.delete(botId); }
  await db.query("UPDATE bots SET status='KILLED', killed_at=NOW(), buy_order_id=NULL, sell_order_id=NULL, updated_at=NOW() WHERE id=$1", [botId]);
  logger.warn(`Bot ${botId} KILLED`);
}

async function killAllBots(clientId = null) {
  const where = clientId ? "WHERE client_id=$1 AND status IN ('RUNNING','PAUSED','WAITING_FLAT','IDLE','SEEDING')" : "WHERE status IN ('RUNNING','PAUSED','WAITING_FLAT','IDLE','SEEDING')";
  const bots  = await db.getAll(`SELECT id FROM bots ${where}`, clientId ? [clientId] : []);
  for (const b of bots) await killBot(b.id);
  return { killed: bots.length };
}

// ─── Resume bots on startup (PM2 restart recovery) ────────────────────────────
async function resumeBotsOnStartup() {
  if (!isMarketOpen()) { logger.info("Market closed — skipping bot auto-resume on startup"); return; }
  const bots = await db.getAll("SELECT id FROM bots WHERE status IN ('RUNNING','WAITING_FLAT','IDLE','SEEDING')");
  logger.info(`Resuming ${bots.length} bots after startup`);
  for (const b of bots) {
    try { await startBot(b.id); } catch (e) { logger.error(`Resume bot ${b.id} failed: ${e.message}`); }
  }
}

module.exports = {
  startBot, stopBot, killBot, killAllBots,
  resumeBotsOnStartup, reconcileBot,
  runningBots,
};
