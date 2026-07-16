const express = require("express");
const db = require("../../db");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { generateNextId } = require("../utils/idGenerator");
const { hashPassword, generateTempPassword } = require("../utils/authUtils");
const { toPublicUser, toProfileResponse, toPublicEvent, toPaymentSummary, toPaymentTransaction } = require("../utils/serializers");
const config = require("../config");
const { eventImageUpload } = require("../utils/uploads");

const router = express.Router();

router.use(requireAuth, requireAdmin);

// POST /api/admin/users
// Creates a new account and auto-assigns the next sequential ID (TTR001, TTR002, ...).
// Body: { full_name, email?, role?, cohort?, currentYear?, tempPassword? }
router.post("/users", (req, res) => {
  const { full_name, email, role, cohort, currentYear, tempPassword, memberCode: manualCode } = req.body || {};

  if (!full_name || !String(full_name).trim()) {
    return res.status(400).json({ error: "Full name is required" });
  }

  const allowedRoles = ["trainee", "supervisor"];
  if (role === "admin") {
    return res.status(400).json({
      error: "Admin accounts can't be created here. The admin account is fixed and seeded separately.",
    });
  }
  const finalRole = allowedRoles.includes(role) ? role : "trainee";

  if (email) {
    const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
    if (existing) return res.status(409).json({ error: "That email is already in use" });
  }

  // Student IDs look like ST001, supervisor IDs like SUP001 -- each role
  // keeps its own counter so they can grow independently. Admins can also
  // type a specific ID instead, as long as it isn't already taken.
  let memberCode;
  if (manualCode && String(manualCode).trim()) {
    memberCode = String(manualCode).trim().toUpperCase();
    const taken = db.prepare("SELECT id FROM users WHERE member_code = ?").get(memberCode);
    if (taken) return res.status(409).json({ error: `ID "${memberCode}" is already in use` });
  } else {
    const prefix = finalRole === "trainee" ? "ST" : finalRole === "supervisor" ? "SUP" : config.idPrefix;
    memberCode = generateNextId(prefix);
  } // e.g. TTR004 — atomic, never collides
  const plainTempPassword = tempPassword && String(tempPassword).length >= 8
    ? tempPassword
    : generateTempPassword();

  const result = db
    .prepare(
      `INSERT INTO users (member_code, password_hash, role, full_name, email, cohort, current_year, must_change_password)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
    )
    .run(
      memberCode,
      hashPassword(plainTempPassword),
      finalRole,
      full_name.trim(),
      email || null,
      cohort || null,
      currentYear || null
    );

  const newUser = db.prepare("SELECT * FROM users WHERE id = ?").get(result.lastInsertRowid);

  db.prepare("INSERT INTO activity_log (user_id, action) VALUES (?, 'Account created by admin')").run(newUser.id);

  // The temp password is only ever returned here, once, at creation time.
  // It is not retrievable later — use POST /api/admin/users/:id/reset-password instead.
  res.status(201).json({
    user: toPublicUser(newUser),
    memberCode,
    tempPassword: plainTempPassword,
  });
});

// GET /api/admin/users?search=&role=&status=&page=&pageSize=
router.get("/users", (req, res) => {
  const { search = "", role, status, page = 1, pageSize = 25 } = req.query;

  const clauses = [];
  const params = [];

  if (search) {
    clauses.push("(full_name LIKE ? OR member_code LIKE ? OR email LIKE ?)");
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (role) {
    clauses.push("role = ?");
    params.push(role);
  }
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.min(Number(pageSize) || 25, 100);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;

  const rows = db
    .prepare(`SELECT * FROM users ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);

  const { total } = db.prepare(`SELECT COUNT(*) AS total FROM users ${where}`).get(...params);

  res.json({
    users: rows.map(toPublicUser),
    total,
    page: Number(page),
    pageSize: limit,
  });
});

// GET /api/admin/users/:id — full profile view for admin
router.get("/users/:id", (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json(toProfileResponse(user));
});

// PUT /api/admin/users/:id — admin-managed fields (cohort, year, role, status, supervisors)
router.put("/users/:id", (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });

  const { cohort, currentYear, role, status, supervisorIds } = req.body || {};

  const allowedRoles = ["trainee", "supervisor", "admin"];
  const allowedStatus = ["active", "suspended"];

  db.prepare(
    `UPDATE users SET
      cohort = COALESCE(?, cohort),
      current_year = COALESCE(?, current_year),
      role = ?,
      status = ?,
      updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    cohort ?? null,
    currentYear ?? null,
    allowedRoles.includes(role) ? role : user.role,
    allowedStatus.includes(status) ? status : user.status,
    user.id
  );

  if (Array.isArray(supervisorIds)) {
    const tx = db.transaction((ids) => {
      db.prepare("DELETE FROM user_supervisors WHERE user_id = ?").run(user.id);
      const insert = db.prepare("INSERT INTO user_supervisors (user_id, supervisor_id) VALUES (?, ?)");
      for (const supId of ids) insert.run(user.id, supId);
    });
    tx(supervisorIds);
  }

  const updated = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id);
  db.prepare("INSERT INTO activity_log (user_id, action) VALUES (?, 'Account updated by admin')").run(user.id);

  res.json(toProfileResponse(updated));
});

// POST /api/admin/users/:id/reset-password — issues a new temp password
router.post("/users/:id/reset-password", (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });

  const tempPassword = generateTempPassword();

  db.prepare(
    "UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = datetime('now') WHERE id = ?"
  ).run(hashPassword(tempPassword), user.id);

  db.prepare("INSERT INTO activity_log (user_id, action) VALUES (?, 'Password reset by admin')").run(user.id);

  res.json({ success: true, memberCode: user.member_code, tempPassword });
});

// DELETE /api/admin/users/:id — soft delete (suspend), preserves history/IDs
router.delete("/users/:id", (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });

  db.prepare("UPDATE users SET status = 'suspended', updated_at = datetime('now') WHERE id = ?").run(user.id);
  db.prepare("INSERT INTO activity_log (user_id, action) VALUES (?, 'Account suspended by admin')").run(user.id);

  res.json({ success: true });
});

// ---- Events (public site management) -------------------------------

// POST /api/admin/events/upload-image  (multipart, field "image")
// Returns a URL the events form (and events.html) can use directly.
router.post("/events/upload-image", (req, res) => {
  eventImageUpload.single("image")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    res.status(201).json({ url: `/uploads/events/${req.file.filename}` });
  });
});

function toJsonArrayString(value) {
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === "string") {
    // allow admins to paste newline-separated bullets in the form
    return JSON.stringify(value.split("\n").map((s) => s.trim()).filter(Boolean));
  }
  return "[]";
}

// GET /api/admin/events — full list for the management table
router.get("/events", (req, res) => {
  const rows = db.prepare("SELECT * FROM events ORDER BY event_date DESC").all();
  res.json({ events: rows.map(toPublicEvent) });
});

// POST /api/admin/events
router.post("/events", (req, res) => {
  const b = req.body || {};
  if (!b.date) {
    return res.status(400).json({ error: "date is required" });
  }

  const result = db
    .prepare(
      `INSERT INTO events (
        event_date, image, status, fee, register_url,
        title_en, format_en, facilitator_en, about_en, learn_en, who_en, outcomes_en, facilitator_bio_en,
        title_ar, format_ar, facilitator_ar, about_ar, learn_ar, who_ar, outcomes_ar, facilitator_bio_ar
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      b.date, b.image || null, ["upcoming", "concluded"].includes(b.status) ? b.status : "upcoming",
      b.fee || null, b.register || null,
      b.englishTitle || null, b.englishFormat || null, b.englishFacilitator || null, b.englishAbout || null,
      toJsonArrayString(b.englishLearn), toJsonArrayString(b.englishWho), toJsonArrayString(b.englishOutcomes),
      b.englishFacilitatorBio || null,
      b.arabicTitle || null, b.arabicFormat || null, b.arabicFacilitator || null, b.arabicAbout || null,
      toJsonArrayString(b.arabicLearn), toJsonArrayString(b.arabicWho), toJsonArrayString(b.arabicOutcomes),
      b.arabicFacilitatorBio || null
    );

  const row = db.prepare("SELECT * FROM events WHERE id = ?").get(result.lastInsertRowid);
  res.status(201).json(toPublicEvent(row));
});

// PUT /api/admin/events/:id
router.put("/events/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM events WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Event not found" });

  const b = req.body || {};
  db.prepare(
    `UPDATE events SET
      event_date = ?, image = ?, status = ?, fee = ?, register_url = ?,
      title_en = ?, format_en = ?, facilitator_en = ?, about_en = ?, learn_en = ?, who_en = ?, outcomes_en = ?, facilitator_bio_en = ?,
      title_ar = ?, format_ar = ?, facilitator_ar = ?, about_ar = ?, learn_ar = ?, who_ar = ?, outcomes_ar = ?, facilitator_bio_ar = ?,
      updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    b.date ?? existing.event_date,
    b.image ?? existing.image,
    ["upcoming", "concluded"].includes(b.status) ? b.status : existing.status,
    b.fee ?? existing.fee,
    b.register ?? existing.register_url,
    b.englishTitle ?? existing.title_en,
    b.englishFormat ?? existing.format_en,
    b.englishFacilitator ?? existing.facilitator_en,
    b.englishAbout ?? existing.about_en,
    b.englishLearn !== undefined ? toJsonArrayString(b.englishLearn) : existing.learn_en,
    b.englishWho !== undefined ? toJsonArrayString(b.englishWho) : existing.who_en,
    b.englishOutcomes !== undefined ? toJsonArrayString(b.englishOutcomes) : existing.outcomes_en,
    b.englishFacilitatorBio ?? existing.facilitator_bio_en,
    b.arabicTitle ?? existing.title_ar,
    b.arabicFormat ?? existing.format_ar,
    b.arabicFacilitator ?? existing.facilitator_ar,
    b.arabicAbout ?? existing.about_ar,
    b.arabicLearn !== undefined ? toJsonArrayString(b.arabicLearn) : existing.learn_ar,
    b.arabicWho !== undefined ? toJsonArrayString(b.arabicWho) : existing.who_ar,
    b.arabicOutcomes !== undefined ? toJsonArrayString(b.arabicOutcomes) : existing.outcomes_ar,
    b.arabicFacilitatorBio ?? existing.facilitator_bio_ar,
    req.params.id
  );

  const row = db.prepare("SELECT * FROM events WHERE id = ?").get(req.params.id);
  res.json(toPublicEvent(row));
});

// DELETE /api/admin/events/:id
router.delete("/events/:id", (req, res) => {
  const existing = db.prepare("SELECT id FROM events WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Event not found" });

  db.prepare("DELETE FROM events WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// ---- Payments (financial ledger, admin-managed) -----------------------

function getTotalFeeCents(userId) {
  const row = db.prepare("SELECT total_fee_cents FROM payment_profiles WHERE user_id = ?").get(userId);
  return row ? row.total_fee_cents : 0;
}
function getTransactions(userId) {
  return db
    .prepare(
      `SELECT pt.*, u.full_name AS added_by_name FROM payment_transactions pt
       JOIN users u ON u.id = pt.added_by
       WHERE pt.user_id = ? ORDER BY pt.payment_date DESC, pt.created_at DESC`
    )
    .all(userId);
}

// GET /api/admin/payments?search= — every non-admin user with their
// computed payment summary (total fee / paid / remaining / status).
router.get("/payments", (req, res) => {
  const { search = "" } = req.query;
  const clause = search ? "WHERE (full_name LIKE ? OR member_code LIKE ?) AND role != 'admin'" : "WHERE role != 'admin'";
  const params = search ? [`%${search}%`, `%${search}%`] : [];

  const users = db.prepare(`SELECT * FROM users ${clause} ORDER BY full_name`).all(...params);

  const summaries = users.map((user) => {
    const totalFeeCents = getTotalFeeCents(user.id);
    const transactions = db.prepare("SELECT amount_cents FROM payment_transactions WHERE user_id = ?").all(user.id);
    return toPaymentSummary(user, totalFeeCents, transactions);
  });

  res.json({ payments: summaries });
});

// GET /api/admin/payments/:userId — full profile + complete transaction history
router.get("/payments/:userId", (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.userId);
  if (!user) return res.status(404).json({ error: "User not found" });

  const totalFeeCents = getTotalFeeCents(user.id);
  const transactions = getTransactions(user.id);

  res.json({
    summary: toPaymentSummary(user, totalFeeCents, transactions),
    transactions: transactions.map(toPaymentTransaction),
  });
});

// PUT /api/admin/payments/:userId/total-fee  { totalFee }
// Sets the program's total required fee for this user. This is a profile
// setting, not a ledger entry, so it can be corrected freely (unlike
// transactions, which are never edited once recorded).
router.put("/payments/:userId/total-fee", (req, res) => {
  const user = db.prepare("SELECT id FROM users WHERE id = ?").get(req.params.userId);
  if (!user) return res.status(404).json({ error: "User not found" });

  const totalFee = Number(req.body?.totalFee);
  if (!Number.isFinite(totalFee) || totalFee < 0) {
    return res.status(400).json({ error: "totalFee must be a non-negative number" });
  }
  const totalFeeCents = Math.round(totalFee * 100);

  const existing = db.prepare("SELECT user_id FROM payment_profiles WHERE user_id = ?").get(user.id);
  if (existing) {
    db.prepare("UPDATE payment_profiles SET total_fee_cents = ?, updated_at = datetime('now') WHERE user_id = ?").run(
      totalFeeCents,
      user.id
    );
  } else {
    db.prepare("INSERT INTO payment_profiles (user_id, total_fee_cents) VALUES (?, ?)").run(user.id, totalFeeCents);
  }

  const transactions = getTransactions(user.id);
  res.json({
    summary: toPaymentSummary(user, totalFeeCents, transactions),
    transactions: transactions.map(toPaymentTransaction),
  });
});

// POST /api/admin/payments/:userId/transactions  { amount, date, method, notes }
// Records a new payment. Transactions are append-only -- there is no
// edit/delete endpoint by design, so the financial history can't be
// silently altered after the fact.
router.post("/payments/:userId/transactions", (req, res) => {
  const user = db.prepare("SELECT id FROM users WHERE id = ?").get(req.params.userId);
  if (!user) return res.status(404).json({ error: "User not found" });

  const { amount, date, method, notes } = req.body || {};
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount === 0) {
    return res.status(400).json({ error: "amount must be a non-zero number" });
  }
  if (!date) {
    return res.status(400).json({ error: "date is required" });
  }
  const amountCents = Math.round(numericAmount * 100);

  // Lightweight duplicate-submission guard: reject an identical entry
  // (same user, amount, date, method) recorded in the last 10 seconds --
  // catches accidental double-clicks without blocking legitimate repeat
  // payments made later.
  const recentDuplicate = db
    .prepare(
      `SELECT id FROM payment_transactions
       WHERE user_id = ? AND amount_cents = ? AND payment_date = ? AND IFNULL(method,'') = IFNULL(?,'')
         AND created_at >= datetime('now', '-10 seconds')`
    )
    .get(user.id, amountCents, date, method || null);
  if (recentDuplicate) {
    return res.status(409).json({ error: "This looks like a duplicate of a payment just submitted. Refresh and check the history before retrying." });
  }

  db.prepare(
    "INSERT INTO payment_transactions (user_id, amount_cents, payment_date, method, added_by, notes) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(user.id, amountCents, date, method || null, req.user.id, notes || null);

  db.prepare("INSERT INTO activity_log (user_id, action) VALUES (?, 'Payment recorded by admin')").run(user.id);

  const totalFeeCents = getTotalFeeCents(user.id);
  const transactions = getTransactions(user.id);
  res.status(201).json({
    summary: toPaymentSummary(user, totalFeeCents, transactions),
    transactions: transactions.map(toPaymentTransaction),
  });
});

module.exports = router;