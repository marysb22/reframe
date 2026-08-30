const express = require("express");
const jwt = require("jsonwebtoken");
const config = require("../config");
const { pool } = require("../db");
const { requireAuth, asyncRoute } = require("../middleware/auth");
const { verifyPassword, hashPassword } = require("../utils/authUtils");
const { requestReset, checkCode, completeReset } = require("../utils/passwordReset");

const router = express.Router();

// Safe, generic strings only -- never surface DB/SMTP internals here (see
// server.js's global error handler for the same principle on unexpected
// failures).
const RESET_ERROR_MESSAGES = {
  invalid: "The verification code is incorrect or has expired.",
  expired: "The verification code is incorrect or has expired.",
  no_active_code: "The verification code is incorrect or has expired.",
  too_many_attempts: "Too many attempts. Please request a new verification code.",
};

// POST /api/auth/login  { memberCode, password }
// No requireAuth here -- this IS how you get authenticated.
router.post("/login", async (req, res, next) => {
  try {
    const { memberCode, password } = req.body || {};
    if (!memberCode || !password) {
      return res.status(400).json({ error: "Member ID and password are required" });
    }

    // LEFT JOIN supervisors so a role='supervisor' login also gets back
    // supervisor_type ('primary' = Master Trainer, 'in_training' = ToT) --
    // the frontend needs this to send the two supervisor sub-roles to
    // their own dashboards (masterDashborad.html vs Totdashboard.html)
    // instead of lumping them together. NULL for every other role.
    const { rows } = await pool.query(
      `SELECT uc.id, uc.member_code, uc.password_hash, uc.role, uc.status, uc.must_change_password,
              sup.supervisor_type
         FROM user_credentials uc
         LEFT JOIN supervisors sup ON sup.id = uc.id
        WHERE uc.member_code = ?`,
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

    await pool.query("UPDATE user_credentials SET last_login_at = NOW() WHERE id = ?", [user.id]);
    await pool.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES (?, 'login', 'user_credentials', ?)",
      [user.id, user.id]
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
        supervisorType: user.supervisor_type,
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

    const { rows } = await db.query("SELECT password_hash FROM user_credentials WHERE id = ?", [req.user.id]);
    const valid = await verifyPassword(currentPassword || "", rows[0].password_hash);
    if (!valid) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }

    const newHash = await hashPassword(newPassword);
    await db.query(
      "UPDATE user_credentials SET password_hash = ?, must_change_password = FALSE, updated_at = NOW() WHERE id = ?",
      [newHash, req.user.id]
    );
    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES (?, 'password_changed', 'user_credentials', ?)",
      [req.user.id, req.user.id]
    );

    res.json({ success: true });
  })
);

// POST /api/auth/forgot-password  { identifier }
// identifier is a Member ID or email address. Always resolves with the same
// generic response regardless of whether the identifier matched a real
// account -- see passwordReset.js's requestReset for why.
router.post(
  "/forgot-password",
  asyncRoute(async (req, res, db) => {
    const { identifier } = req.body || {};
    if (!identifier || !String(identifier).trim()) {
      return res.status(400).json({ error: "Enter your email address or Member ID" });
    }
    const { message } = await requestReset(db, { identifier, ip: req.ip });
    res.json({ message });
  })
);

// POST /api/auth/verify-reset-code  { identifier, code }
router.post(
  "/verify-reset-code",
  asyncRoute(async (req, res, db) => {
    const { identifier, code } = req.body || {};
    if (!identifier || !code) {
      return res.status(400).json({ error: "The verification code is incorrect or has expired." });
    }
    const { result } = await checkCode(db, { identifier, code });
    if (result !== "valid") {
      return res.status(400).json({ error: RESET_ERROR_MESSAGES[result] || RESET_ERROR_MESSAGES.invalid });
    }
    res.json({ valid: true });
  })
);

// POST /api/auth/reset-password  { identifier, code, newPassword }
router.post(
  "/reset-password",
  asyncRoute(async (req, res, db) => {
    const { identifier, code, newPassword } = req.body || {};
    if (!identifier || !code) {
      return res.status(400).json({ error: "The verification code is incorrect or has expired." });
    }
    if (!newPassword || String(newPassword).length < 8) {
      return res.status(400).json({ error: "Please meet all password requirements." });
    }
    const { result } = await completeReset(db, { identifier, code, newPassword: String(newPassword) });
    if (result !== "valid") {
      return res.status(400).json({ error: RESET_ERROR_MESSAGES[result] || RESET_ERROR_MESSAGES.invalid });
    }
    res.json({ success: true });
  })
);

module.exports = router;
