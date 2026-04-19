const router = require("express").Router();
const db     = require("../services/database");
const auth   = require("../middleware/auth");

// GET /api/buckets — all buckets with member client IDs and counts
router.get("/", auth, async (_req, res) => {
  try {
    const rows = await db.getAll(`
      SELECT b.id, b.name, b.description, b.created_at,
             COALESCE(json_agg(m.client_id) FILTER (WHERE m.client_id IS NOT NULL), '[]'::json) AS client_ids,
             COUNT(m.client_id)::int AS member_count
      FROM client_buckets b
      LEFT JOIN bucket_members m ON b.id = m.bucket_id
      GROUP BY b.id
      ORDER BY b.created_at DESC
    `);
    res.json({ ok: true, buckets: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/buckets — create bucket with optional initial members
router.post("/", auth, async (req, res) => {
  try {
    const { name, description, client_ids } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: "name required" });
    const bucket = await db.getOne(
      "INSERT INTO client_buckets (name, description) VALUES ($1, $2) RETURNING id, name, description, created_at",
      [name.trim(), description || ""]
    );
    if (Array.isArray(client_ids) && client_ids.length) {
      const tuples = client_ids.map((_, i) => `($1, $${i+2})`).join(",");
      await db.query(
        `INSERT INTO bucket_members (bucket_id, client_id) VALUES ${tuples} ON CONFLICT DO NOTHING`,
        [bucket.id, ...client_ids]
      );
    }
    res.json({ ok: true, bucket: { ...bucket, client_ids: client_ids || [], member_count: client_ids?.length || 0 } });
  } catch (err) {
    if (String(err.message).includes("unique")) return res.status(409).json({ error: "Bucket name already exists" });
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/buckets/:id — update name/description AND replace member list
router.put("/:id", auth, async (req, res) => {
  try {
    const { name, description, client_ids } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: "name required" });
    const bucket = await db.getOne(
      "UPDATE client_buckets SET name=$1, description=$2 WHERE id=$3 RETURNING id, name, description, created_at",
      [name.trim(), description || "", req.params.id]
    );
    if (!bucket) return res.status(404).json({ error: "Bucket not found" });

    if (Array.isArray(client_ids)) {
      await db.query("DELETE FROM bucket_members WHERE bucket_id=$1", [req.params.id]);
      if (client_ids.length) {
        const tuples = client_ids.map((_, i) => `($1, $${i+2})`).join(",");
        await db.query(
          `INSERT INTO bucket_members (bucket_id, client_id) VALUES ${tuples} ON CONFLICT DO NOTHING`,
          [req.params.id, ...client_ids]
        );
      }
    }
    res.json({ ok: true, bucket: { ...bucket, client_ids: client_ids || [], member_count: client_ids?.length || 0 } });
  } catch (err) {
    if (String(err.message).includes("unique")) return res.status(409).json({ error: "Bucket name already exists" });
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/buckets/:id
router.delete("/:id", auth, async (req, res) => {
  try {
    await db.query("DELETE FROM client_buckets WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
