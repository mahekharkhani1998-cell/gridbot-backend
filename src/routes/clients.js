const router     = require("express").Router();
const db         = require("../services/database");
const auth       = require("../middleware/auth");
const { encrypt, decrypt, mask } = require("../services/encryption");

// GET /api/clients?page=1&limit=50&q=jigar — paginated list with optional search
router.get("/", auth, async (req, res) => {
  try {
    const page  = Math.max(parseInt(req.query.page  || "1",  10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "50", 10) || 50, 1), 500);
    const q     = (req.query.q || "").trim();
    const offset = (page - 1) * limit;

    let where = "";
    const params = [];
    if (q) {
      params.push(`%${q.toUpperCase()}%`);
      where = ` WHERE UPPER(name) LIKE $${params.length} OR UPPER(broker) LIKE $${params.length}`;
    }

    const countRow = await db.getOne(`SELECT COUNT(*)::int AS n FROM clients${where}`, params);
    const total    = countRow?.n || 0;

    params.push(limit);
    params.push(offset);
    const rows = await db.getAll(
      `SELECT id,name,broker,segment,note,active,credentials_enc,token_refreshed_at,created_at
       FROM clients${where}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const clients = rows.map(row => {
      let credentials = {};
      try { credentials = decrypt(row.credentials_enc); } catch(e) {}
      return {
        id: row.id, name: row.name, broker: row.broker, segment: row.segment,
        note: row.note, active: row.active, credentials,
        token_refreshed_at: row.token_refreshed_at, created_at: row.created_at,
        bots: 0, pnl: 0,
        added: row.created_at ? new Date(row.created_at).toLocaleDateString("en-IN",{timeZone:"Asia/Kolkata",day:"2-digit",month:"short",year:"numeric"}) : "",
      };
    });
    res.json({ ok: true, clients, total, page, limit, pages: Math.ceil(total / limit) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/clients  — add client with encrypted credentials
router.post("/", auth, async (req, res) => {
  try {
    const { name, broker, segment, note, credentials } = req.body;
    if (!name || !broker || !credentials?.client_id) return res.status(400).json({ error: "name, broker, credentials.client_id required" });
    const enc = encrypt(credentials);
    const row = await db.getOne(
      "INSERT INTO clients (name,broker,segment,note,credentials_enc) VALUES ($1,$2,$3,$4,$5) RETURNING id,name,broker,segment,note,active,created_at",
      [name, broker, segment || "NSE_EQ", note || "", enc]
    );
    const client = {
      ...row,
      credentials,
      bots: 0, pnl: 0,
      added: row.created_at ? new Date(row.created_at).toLocaleDateString("en-IN",{timeZone:"Asia/Kolkata",day:"2-digit",month:"short",year:"numeric"}) : "",
    };
    res.json({ ok: true, client });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/clients/:id
router.put("/:id", auth, async (req, res) => {
  try {
    const { name, broker, segment, note, credentials, active } = req.body;
    const existing = await db.getOne("SELECT credentials_enc FROM clients WHERE id=$1", [req.params.id]);
    if (!existing) return res.status(404).json({ error: "Client not found" });
    const oldCreds = decrypt(existing.credentials_enc);
    const merged   = { ...oldCreds, ...credentials };
    const enc      = encrypt(merged);
    const row = await db.getOne(
      "UPDATE clients SET name=$1,broker=$2,segment=$3,note=$4,credentials_enc=$5,active=$6 WHERE id=$7 RETURNING id,name,broker,segment,note,active",
      [name, broker, segment, note, enc, active !== undefined ? active : true, req.params.id]
    );
    const merged_creds = { ...oldCreds, ...credentials };
    const client = {
      ...row,
      credentials: merged_creds,
      bots: 0, pnl: 0,
      added: "",
    };
    res.json({ ok: true, client });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/clients/:id
router.delete("/:id", auth, async (req, res) => {
  try {
    await db.query("DELETE FROM clients WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/clients/:id/credentials  — returns masked credentials only
router.get("/:id/credentials", auth, async (req, res) => {
  try {
    const row = await db.getOne("SELECT credentials_enc FROM clients WHERE id=$1", [req.params.id]);
    if (!row) return res.status(404).json({ error: "Not found" });
    const creds = decrypt(row.credentials_enc);
    res.json({ ok: true, credentials: mask(creds) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/clients/:id/holdings
router.get("/:id/holdings", auth, async (req, res) => {
  try {
    const row = await db.getOne("SELECT credentials_enc, broker FROM clients WHERE id=$1", [req.params.id]);
    if (!row) return res.status(404).json({ error: "Not found" });
    const creds = decrypt(row.credentials_enc);
    const { DhanAPI } = require("../services/dhan");
    const api = new DhanAPI(creds.client_id, creds.access_token);
    const holdings = await api.getHoldings();
    res.json({ ok: true, holdings });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/clients/:id/positions
router.get("/:id/positions", auth, async (req, res) => {
  try {
    const row = await db.getOne("SELECT credentials_enc FROM clients WHERE id=$1", [req.params.id]);
    if (!row) return res.status(404).json({ error: "Not found" });
    const creds = decrypt(row.credentials_enc);
    const { DhanAPI } = require("../services/dhan");
    const api = new DhanAPI(creds.client_id, creds.access_token);
    const positions = await api.getPositions();
    res.json({ ok: true, positions });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/clients/:id/limits
router.get("/:id/limits", auth, async (req, res) => {
  try {
    const row = await db.getOne("SELECT credentials_enc FROM clients WHERE id=$1", [req.params.id]);
    if (!row) return res.status(404).json({ error: "Not found" });
    const creds = decrypt(row.credentials_enc);
    const { DhanAPI } = require("../services/dhan");
    const api = new DhanAPI(creds.client_id, creds.access_token);
    const limits = await api.getFundLimits();
    res.json({ ok: true, limits });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
