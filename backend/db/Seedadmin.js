require("dotenv").config();
const db = require("./index");
const { hashPassword } = require("../src/utils/authUtils");

const memberCode = process.env.SEED_ADMIN_ID || "ADMIN001";
const password = process.env.SEED_ADMIN_PASSWORD;
const fullName = process.env.SEED_ADMIN_NAME || "System Administrator";

if (!password) {
  console.error("Set SEED_ADMIN_PASSWORD in your .env before running this script.");
  process.exit(1);
}

const existing = db.prepare("SELECT id FROM users WHERE member_code = ?").get(memberCode);
if (existing) {
  console.log(`Admin account ${memberCode} already exists — nothing to do.`);
  process.exit(0);
}

db.prepare(
  `INSERT INTO users (member_code, password_hash, role, full_name, must_change_password)
   VALUES (?, ?, 'admin', ?, 1)`
).run(memberCode, hashPassword(password), fullName);

console.log(`Created admin account:
  ID:       ${memberCode}
  Password: ${password}
  (must_change_password is set — change it on first login)`);
