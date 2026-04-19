const router   = require("express").Router();
const bcrypt   = require("bcryptjs");
const jwt      = require("jsonwebtoken");
const db       = require("../services/database");
const auth     = require("../middleware/auth");

// POST /api/auth/register  (first-time setup only)
router.post("/register", async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error: "email, password, name required" });
    const existing = await db.getOne("SELECT id FROM users WHERE email=$1", [email]);
    if (existing) return res.status(409).json({ error: "User already exists" });
    const hash = await bcrypt.hash(password, 12);
    const user = await db.getOne("INSERT INTO users (email,password,name) VALUES ($1,$2,$3) RETURNING id,email,name", [email, hash, name]);
    res.json({ ok: true, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await db.getOne("SELECT * FROM users WHERE email=$1", [email]);
    if (!user) return res.status(401).json({ error: "Invalid credentials" });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });
    const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || "7d" });
    res.json({ ok: true, token, user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/me — current user profile
router.get("/me", auth, async (req, res) => {
  try {
    const user = await db.getOne("SELECT id, email, name, role, created_at FROM users WHERE id=$1", [req.user.id]);
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ ok: true, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/auth/profile — update name (email/role are not user-editable)
router.put("/profile", auth, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: "name required" });
    const user = await db.getOne(
      "UPDATE users SET name=$1 WHERE id=$2 RETURNING id, email, name, role",
      [name.trim(), req.user.id]
    );
    res.json({ ok: true, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/password — change password (requires current password)
router.post("/password", auth, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return res.status(400).json({ error: "current_password and new_password required" });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ error: "New password must be at least 8 characters" });
    }
    const user = await db.getOne("SELECT password FROM users WHERE id=$1", [req.user.id]);
    if (!user) return res.status(404).json({ error: "User not found" });
    const ok = await bcrypt.compare(current_password, user.password);
    if (!ok) return res.status(401).json({ error: "Current password is incorrect" });
    const hash = await bcrypt.hash(new_password, 12);
    await db.query("UPDATE users SET password=$1 WHERE id=$2", [hash, req.user.id]);
    res.json({ ok: true, message: "Password updated" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
