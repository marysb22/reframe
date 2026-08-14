const express = require("express");
const jwt = require("jsonwebtoken");
const config = require("../config");
const { pool } = require("../db");
const { requireAuth, asyncRoute } = require("../middleware/auth");
const { verifyPassword, hashPassword } = require("../utils/authUtils");

const router = express.Router();

// POST /api/auth/login  { memberCode, password }
// No requireAuth here -- this IS how you get authenticated.
router.post("/login", async (req, res, next) => {
  try {
    const { memberCode, password } = req.body || {};
    if (!memberCode || !password) {
      return res.status(400).json({ error: "Member ID and password are required" });
    }

    const { rows } = await pool.query(
      "SELECT id, member_code, password_hash, role, status, must_change_password FROM user_credentials WHERE member_code = $1",
      [String(memberCode).trim().toUpperCase()]
    );
    const user = rows[0];

    // Deliberately identical error for "no such ID" and "wrong password" --
    // distinguishing them lets an attacker enumerate valid member codes.
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return res.status(401).json({ error: "Invalid ID or password" });
    }
    if (user.status !== "active") {
      return res.status(403).json({ error: "This account has been suspended. Contact your administrator." });
    }

    await pool.query("UPDATE user_credentials SET last_login_at = now() WHERE id = $1", [user.id]);
    await pool.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES ($1, 'login', 'user_credentials', $1)",
      [user.id]
    );

    const token = jwt.sign({ id: user.id, role: user.role }, config.jwtSecret, {
      expiresIn: config.jwtExpiresIn,
    });

    res.json({
      token,
      user: {
        id: user.id,
        memberCode: user.member_code,
        role: user.role,
        mustChangePassword: user.must_change_password,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/change-password  { currentPassword, newPassword }
// Any authenticated role. Clears must_change_password, so this is also
// how a first-login forced reset gets satisfied.
router.post(
  "/change-password",
  requireAuth,
  asyncRoute(async (req, res, db) => {
    const { currentPassword, newPassword } = req.body || {};

    if (!newPassword || String(newPassword).length < 8) {
      return res.status(400).json({ error: "New password must be at least 8 characters" });
    }

    const { rows } = await db.query("SELECT password_hash FROM user_credentials WHERE id = $1", [req.user.id]);
    const valid = await verifyPassword(currentPassword || "", rows[0].password_hash);
    if (!valid) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }

    const newHash = await hashPassword(newPassword);
    await db.query(
      "UPDATE user_credentials SET password_hash = $1, must_change_password = FALSE, updated_at = now() WHERE id = $2",
      [newHash, req.user.id]
    );
    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES ($1, 'password_changed', 'user_credentials', $1)",
      [req.user.id]
    );

    res.json({ success: true });
  })
);

module.exports = router;
