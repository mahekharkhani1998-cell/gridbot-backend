// ─────────────────────────────────────────────────────────────────────────────
//  api.js  —  Frontend service to talk to the GridBot Node.js backend
//  Place this file at:  src/services/api.js
//
//  Usage in any component:
//    import api from "./services/api";
//    const bots = await api.getBots();
// ─────────────────────────────────────────────────────────────────────────────

// Set this to your DigitalOcean server URL after deployment
// During local dev: http://localhost:4000
// After deployment: https://api.yourdomain.com  OR  http://YOUR_SERVER_IP:4000
const BASE_URL = process.env.REACT_APP_API_URL || "http://localhost:4000";

// ─── Token storage ────────────────────────────────────────────────────────────
const getToken = () => localStorage.getItem("gridbot_token");
const setToken = (t) => localStorage.setItem("gridbot_token", t);
const clearToken = () => localStorage.removeItem("gridbot_token");

// ─── Core fetch wrapper ───────────────────────────────────────────────────────
async function req(method, path, body = null) {
  const headers = { "Content-Type": "application/json" };
  const token   = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const res  = await fetch(`${BASE_URL}${path}`, opts);
  const data = await res.json();

  if (res.status === 401) {
    clearToken();
    window.location.href = "/login"; // redirect to login if token expired
    return;
  }
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
const auth = {
  login: async (email, password) => {
    const data = await req("POST", "/api/auth/login", { email, password });
    if (data?.token) setToken(data.token);
    return data;
  },
  register: (email, password, name) =>
    req("POST", "/api/auth/register", { email, password, name }),
  logout: () => clearToken(),
  isLoggedIn: () => !!getToken(),
};

// ─── Clients ──────────────────────────────────────────────────────────────────
const clients = {
  getAll:      ()         => req("GET",    "/api/clients"),
  add:         (data)     => req("POST",   "/api/clients",      data),
  update:      (id, data) => req("PUT",    `/api/clients/${id}`, data),
  remove:      (id)       => req("DELETE", `/api/clients/${id}`),
  getHoldings: (id)       => req("GET",    `/api/clients/${id}/holdings`),
  getPositions:(id)       => req("GET",    `/api/clients/${id}/positions`),
  getLimits:   (id)       => req("GET",    `/api/clients/${id}/limits`),
};

// ─── Bots ─────────────────────────────────────────────────────────────────────
const bots = {
  getAll:  ()   => req("GET",    "/api/bots"),
  add:     (d)  => req("POST",   "/api/bots",         d),
  start:   (id) => req("POST",   `/api/bots/${id}/start`),
  stop:    (id) => req("POST",   `/api/bots/${id}/stop`),
  kill:    (id) => req("POST",   `/api/bots/${id}/kill`),
  killAll: (clientId) => req("POST", "/api/bots/kill-all", clientId ? { client_id: clientId } : {}),
  remove:  (id) => req("DELETE", `/api/bots/${id}`),
};

// ─── Orders ───────────────────────────────────────────────────────────────────
const orders = {
  getAll: (filters = {}) => {
    const qs = new URLSearchParams(filters).toString();
    return req("GET", `/api/orders${qs ? "?" + qs : ""}`);
  },
};

// ─── Market data (scripts + expiries) ────────────────────────────────────────
const market = {
  searchScripts: (exchange, q = "") =>
    req("GET", `/api/market/scripts?exchange=${exchange}&q=${encodeURIComponent(q)}`),

  getExpiries: (exchange) =>
    req("GET", `/api/market/expiries?exchange=${exchange}`),

  refreshScripts: () =>
    req("POST", "/api/market/refresh"),
};

// ─── WebSocket — live bot events + price ticks ────────────────────────────────
function connectWebSocket(onMessage) {
  const wsUrl = BASE_URL.replace("http", "ws") + "/ws";
  const ws    = new WebSocket(wsUrl);

  ws.onopen    = () => console.log("[WS] Connected to GridBot backend");
  ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch {} };
  ws.onclose   = () => {
    console.log("[WS] Disconnected — reconnecting in 5s...");
    setTimeout(() => connectWebSocket(onMessage), 5000);
  };
  ws.onerror   = (e) => console.error("[WS] Error:", e);

  return {
    subscribe: (botId) => ws.send(JSON.stringify({ type: "subscribe", botId })),
    close:     ()      => ws.close(),
  };
}

// ─── Health check ─────────────────────────────────────────────────────────────
const health = () => req("GET", "/health");

const api = { auth, clients, bots, orders, market, connectWebSocket, health };
export default api;

// ─────────────────────────────────────────────────────────────────────────────
//  HOW TO USE IN YOUR REACT COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────
//
//  1. LOGIN
//  --------
//  const result = await api.auth.login("admin@email.com", "password");
//  // Token auto-saved to localStorage
//
//  2. LOAD BOTS on Dashboard mount
//  ---------------------------------
//  useEffect(() => {
//    api.bots.getAll().then(data => setBots(data.bots));
//  }, []);
//
//  3. ADD BOT
//  ----------
//  await api.bots.add({
//    client_id, exchange, ticker, security_id, isin, product,
//    grid_step, tp_interval, trade_qty, initial_qty,
//    start_price, lower_limit, upper_limit,
//  });
//
//  4. START / STOP / KILL
//  ----------------------
//  await api.bots.start(botId);
//  await api.bots.stop(botId);
//  await api.bots.killAll();   // Kill switch
//
//  5. HOLDINGS for a client
//  ------------------------
//  const { holdings } = await api.clients.getHoldings(clientId);
//
//  6. LIVE WEBSOCKET
//  -----------------
//  const ws = api.connectWebSocket((msg) => {
//    if (msg.type === "bot_update") setBotState(msg.data);
//    if (msg.type === "price")      setLtp(msg.ltp);
//  });
//  ws.subscribe(botId);
//  // Cleanup: ws.close() in useEffect return
//
//  7. SEARCH SCRIPTS (replaces local seed data)
//  ---------------------------------------------
//  const { scripts } = await api.market.searchScripts("NSE_EQ", "BSE");
//
//  8. GET EXPIRIES (respects NSE_EQ/BSE_EQ = no expiry)
//  -------------------------------------------------------
//  const { expiries, hasExpiry } = await api.market.getExpiries("NSE_FNO");
//  if (!hasExpiry) { /* hide expiry dropdown */ }
