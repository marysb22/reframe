const express = require("express");
const db = require("../../db");
const { verifyPassword, signToken } = require("../utils/authUtils");
const { toPublicUser } = require("../utils/serializers");

const router = express.Router();

router.post("/login", (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required" });
  }

  const user = db
    .prepare("SELECT * FROM users WHERE member_code = ?")
    .get(String(username).trim());

  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: "Invalid ID or password" });
  }

  if (user.status !== "active") {
    return res.status(403).json({ error: "This account has been suspended. Contact an administrator." });
  }

  const token = signToken(user);

  db.prepare("INSERT INTO activity_log (user_id, action) VALUES (?, 'Logged in')").run(user.id);

  res.json({ token, user: toPublicUser(user) });
});

module.exports = router;
