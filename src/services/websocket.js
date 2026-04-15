const { WebSocketServer } = require("ws");
const { logger } = require("./logger");

let wss = null;

function attach(server) {
  wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws, req) => {
    logger.info(`WS client connected | IST: ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`);

    ws.on("message", (msg) => {
      try {
        const data = JSON.parse(msg);
        // Client can subscribe to specific bot IDs
        if (data.type === "subscribe" && data.botId) {
          ws.subscribedBotId = data.botId;
        }
      } catch {}
    });

    ws.on("close", () => {
      logger.info("WS client disconnected");
    });

    // Send heartbeat every 30s
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });
  });

  // Ping/pong keepalive
  setInterval(() => {
    if (!wss) return;
    wss.clients.forEach(ws => {
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  logger.info("WebSocket server ready at /ws");
}

// Broadcast bot state update to all connected clients
function broadcastBotUpdate(botId, data) {
  if (!wss) return;
  const msg = JSON.stringify({ type: "bot_update", botId, data, ist: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) });
  wss.clients.forEach(ws => {
    if (ws.readyState === 1) ws.send(msg);
  });
}

// Broadcast price tick
function broadcastPrice(securityId, ltp) {
  if (!wss) return;
  const msg = JSON.stringify({ type: "price", securityId, ltp, ist: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) });
  wss.clients.forEach(ws => {
    if (ws.readyState === 1) ws.send(msg);
  });
}

module.exports = { attach, broadcastBotUpdate, broadcastPrice };
