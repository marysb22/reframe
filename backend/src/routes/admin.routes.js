const fs = require("fs");
const path = require("path");
const express = require("express");
const db = require("../../db");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { generateNextId } = require("../utils/idGenerator");
const { hashPassword, generateTempPassword } = require("../utils/authUtils");
const {
  toPublicUser,
  toProfileResponse,
  toPublicEvent,
  toPaymentSummary,
  toPaymentTransaction,
  toRecord,
  toDocument,
  toProgressSummary,
  toGroupSummary,
} = require("../utils/serializers");
const config = require("../config");
const { eventImageUpload, documentsDir } = require("../utils/uploads");

const router = express.Router();

router.use(requireAuth, requireAdmin);

// POST /api/admin/users
// Creates a new account and auto-assigns the next sequential ID (TRN001, TRN002, ... / MT001, MT002, ...).
// Body: { full_name, email?, role?, cohort?, currentYear?, tempPassword? }
router.post("/users", (req, res) => {
  const { full_name, email, role, cohort, currentYear, tempPassword, memberCode: manualCode } = req.body || {};

  if (!full_name || !String(full_name).trim()) {
    return res.status(400).json({ error: "Full name is required" });
  }

  const allowedRoles = ["trainer", "master_trainer"];
  if (role === "admin") {
    return res.status(400).json({
      error: "Admin accounts can't be created here. The admin account is fixed and seeded separately.",
    });
  }
  const finalRole = allowedRoles.includes(role) ? role : "trainer";

  if (email) {
    const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
    if (existing) return res.status(409).json({ error: "That email is already in use" });
  }

  // Trainer IDs look like TRN001, Master Trainer IDs like MT001 -- each
  // role keeps its own counter so they can grow independently. Admins can
  // also type a specific ID instead, as long as it isn't already taken.
  let memberCode;
  if (manualCode && String(manualCode).trim()) {
    memberCode = String(manualCode).trim().toUpperCase();
    const taken = db.prepare("SELECT id FROM users WHERE member_code = ?").get(memberCode);
    if (taken) return res.status(409).json({ error: `ID "${memberCode}" is already in use` });
  } else {
    const prefix = finalRole === "trainer" ? "TRN" : finalRole === "master_trainer" ? "MT" : config.idPrefix;
    memberCode = generateNextId(prefix);
  } // e.g. TRN004 — atomic, never collides
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
  const limit = Math.min(Number(pageSize) || 25, 200);
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

// PUT /api/admin/users/:id — admin-managed fields (cohort, year, role,
// status, Group, direct Master Trainer links)
router.put("/users/:id", (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });

  const { cohort, currentYear, role, status, masterTrainerIds, groupId } = req.body || {};

  const allowedRoles = ["trainer", "master_trainer", "admin"];
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

  if (Array.isArray(masterTrainerIds)) {
    const tx = db.transaction((ids) => {
      db.prepare("DELETE FROM trainer_master_trainers WHERE trainer_id = ?").run(user.id);
      const insert = db.prepare("INSERT INTO trainer_master_trainers (trainer_id, master_trainer_id) VALUES (?, ?)");
      for (const mtId of ids) insert.run(user.id, mtId);
    });
    tx(masterTrainerIds);
  }

  if (groupId !== undefined && (user.role === "trainer" || allowedRoles.includes(role))) {
    db.prepare("UPDATE users SET group_id = ? WHERE id = ?").run(groupId || null, user.id);
  }

  const updated = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id);
  db.prepare("INSERT INTO activity_log (user_id, action) VALUES (?, 'Account updated by admin')").run(user.id);

  res.json(toProfileResponse(updated));
});

// PATCH /api/admin/users/:id/status  { status: 'active' | 'suspended' }
router.patch("/users/:id/status", (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });

  const { status } = req.body || {};
  if (!["active", "suspended"].includes(status)) {
    return res.status(400).json({ error: "status must be 'active' or 'suspended'" });
  }

  db.prepare("UPDATE users SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, user.id);
  db.prepare("INSERT INTO activity_log (user_id, action) VALUES (?, ?)").run(
    user.id,
    status === "active" ? "Account activated by admin" : "Account suspended by admin"
  );

  res.json(toPublicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(user.id)));
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

// DELETE /api/admin/users/:id?force=true
//
// Default behaviour is always non-destructive to *other* people's data:
//   - A Trainer with no recorded history (no sessions, documents, payments,
//     or messages) is deleted outright -- there's nothing to lose.
//   - A Trainer WITH history is refused (409) unless ?force=true is passed,
//     since deleting them cascades away that entire training history.
//   - A Master Trainer or Admin is only ever suspended, never hard-deleted
//     here (even with ?force=true) -- their trainer_records/documents/etc.
//     rows are actually *other trainees'* history, so cascading them away
//     would destroy data that doesn't belong to this account.
router.delete("/users/:id", (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });

  const force = req.query.force === "true";

  if (user.role === "trainer") {
    const hasHistory =
      db.prepare("SELECT 1 FROM trainer_records WHERE trainer_id = ?").get(user.id) ||
      db.prepare("SELECT 1 FROM documents WHERE trainer_id = ?").get(user.id) ||
      db.prepare("SELECT 1 FROM payment_transactions WHERE user_id = ?").get(user.id) ||
      db.prepare("SELECT 1 FROM messages WHERE sender_id = ? OR recipient_id = ?").get(user.id, user.id);

    if (hasHistory && !force) {
      return res.status(409).json({
        error: "This trainer has training history and can't be deleted without erasing that history too.",
      });
    }

    db.prepare("DELETE FROM users WHERE id = ?").run(user.id); // cascades via ON DELETE CASCADE
    return res.json({ success: true, permanentlyDeleted: true });
  }

  // Master Trainers and Admins: always a reversible suspend.
  db.prepare("UPDATE users SET status = 'suspended', updated_at = datetime('now') WHERE id = ?").run(user.id);
  db.prepare("INSERT INTO activity_log (user_id, action) VALUES (?, 'Account suspended by admin')").run(user.id);

  res.json({ success: true });
});

// ---- Trainer profiles (full detail view for admin) ----------------------

// GET /api/admin/trainers/:id/profile — everything the admin dashboard's
// full-profile view needs: personal info, academic progress + records,
// documents, and payment summary + history.
router.get("/trainers/:id/profile", (req, res) => {
  const trainer = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'trainer'").get(req.params.id);
  if (!trainer) return res.status(404).json({ error: "Trainer not found" });

  const records = db
    .prepare(
      `SELECT tr.*, u.full_name AS master_trainer_name FROM trainer_records tr
       JOIN users u ON u.id = tr.master_trainer_id
       WHERE tr.trainer_id = ? ORDER BY tr.record_date DESC, tr.created_at DESC`
    )
    .all(trainer.id);

  const documents = db
    .prepare(
      `SELECT d.*, u.full_name AS uploaded_by_name FROM documents d
       JOIN users u ON u.id = d.uploaded_by
       WHERE d.trainer_id = ? ORDER BY d.created_at DESC`
    )
    .all(trainer.id);

  const totalFeeRow = db.prepare("SELECT total_fee_cents FROM payment_profiles WHERE user_id = ?").get(trainer.id);
  const totalFeeCents = totalFeeRow ? totalFeeRow.total_fee_cents : 0;
  const transactions = db
    .prepare(
      `SELECT pt.*, u.full_name AS added_by_name FROM payment_transactions pt
       JOIN users u ON u.id = pt.added_by
       WHERE pt.user_id = ? ORDER BY pt.payment_date DESC, pt.created_at DESC`
    )
    .all(trainer.id);

  res.json({
    profile: toProfileResponse(trainer),
    progress: toProgressSummary(records),
    records: records.map(toRecord),
    documents: documents.map(toDocument),
    payment: toPaymentSummary(trainer, totalFeeCents, transactions),
    paymentTransactions: transactions.map(toPaymentTransaction),
  });
});

// DELETE /api/admin/documents/:id — permanently removes a document (and
// its file on disk) from a Trainer's profile.
router.delete("/documents/:id", (req, res) => {
  const document = db.prepare("SELECT * FROM documents WHERE id = ?").get(req.params.id);
  if (!document) return res.status(404).json({ error: "Document not found" });

  db.prepare("DELETE FROM documents WHERE id = ?").run(document.id);

  const filePath = path.join(documentsDir, document.filename);
  fs.unlink(filePath, () => {}); // best-effort; a missing file shouldn't fail the request

  res.json({ success: true });
});

// ---- Groups (Master Trainer / TOT hierarchy) ----------------------------
//
// Each Group has exactly one Master Trainer and exactly two Trainers in
// Training (TOT), all working with the same set of Trainers. The database
// itself guarantees at most one 'master' row per Group (partial unique
// index in schema.sql); the checks below enforce the rest of the shape
// (exactly one Master Trainer, exactly two distinct TOTs, no account
// filling two seats on the same Group) before writing.

function loadGroupSummary(groupId) {
  const group = db.prepare("SELECT * FROM groups WHERE id = ?").get(groupId);
  if (!group) return null;
  const leadership = db
    .prepare(
      `SELECT gl.role, u.id, u.member_code, u.full_name FROM group_leadership gl
       JOIN users u ON u.id = gl.master_trainer_id
       WHERE gl.group_id = ?`
    )
    .all(groupId);
  const trainers = db
    .prepare("SELECT id, member_code, full_name FROM users WHERE group_id = ? AND role = 'trainer' ORDER BY full_name")
    .all(groupId);
  return toGroupSummary(group, leadership, trainers);
}

// GET /api/admin/groups — every Group with its current leadership + trainer count
router.get("/groups", (req, res) => {
  const groups = db.prepare("SELECT id FROM groups ORDER BY name").all();
  res.json({ groups: groups.map((g) => loadGroupSummary(g.id)) });
});

// POST /api/admin/groups  { name }
router.post("/groups", (req, res) => {
  const { name } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: "Group name is required" });
  }

  const result = db.prepare("INSERT INTO groups (name) VALUES (?)").run(name.trim());
  res.status(201).json(loadGroupSummary(result.lastInsertRowid));
});

// GET /api/admin/groups/:id
router.get("/groups/:id", (req, res) => {
  const group = loadGroupSummary(req.params.id);
  if (!group) return res.status(404).json({ error: "Group not found" });
  res.json(group);
});

// PUT /api/admin/groups/:id  { name }
router.put("/groups/:id", (req, res) => {
  const existing = db.prepare("SELECT id FROM groups WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Group not found" });

  const { name } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: "Group name is required" });
  }

  db.prepare("UPDATE groups SET name = ?, updated_at = datetime('now') WHERE id = ?").run(name.trim(), req.params.id);
  res.json(loadGroupSummary(req.params.id));
});

// DELETE /api/admin/groups/:id — removes the Group. Its leadership rows
// cascade-delete; any Trainers who belonged to it fall back to unassigned
// (users.group_id ON DELETE SET NULL) rather than being deleted themselves.
router.delete("/groups/:id", (req, res) => {
  const existing = db.prepare("SELECT id FROM groups WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Group not found" });

  db.prepare("DELETE FROM groups WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// PUT /api/admin/groups/:id/leadership  { masterTrainerId, totIds: [id, id] }
// Assigns/replaces the full 3-person hierarchy in one atomic operation.
router.put("/groups/:id/leadership", (req, res) => {
  const group = db.prepare("SELECT id FROM groups WHERE id = ?").get(req.params.id);
  if (!group) return res.status(404).json({ error: "Group not found" });

  const { masterTrainerId, totIds } = req.body || {};

  if (!masterTrainerId) {
    return res.status(400).json({ error: "masterTrainerId is required" });
  }
  if (!Array.isArray(totIds) || totIds.length !== 2) {
    return res.status(400).json({ error: "totIds must be an array of exactly 2 Trainer in Training IDs" });
  }
  const totSet = new Set(totIds.map(Number));
  if (totSet.size !== 2) {
    return res.status(400).json({ error: "The two Trainers in Training must be different people" });
  }
  if (totSet.has(Number(masterTrainerId))) {
    return res.status(400).json({ error: "The Master Trainer can't also be a Trainer in Training on the same Group" });
  }

  const allIds = [Number(masterTrainerId), ...totSet];
  const placeholders = allIds.map(() => "?").join(",");
  const found = db
    .prepare(`SELECT id FROM users WHERE id IN (${placeholders}) AND role = 'master_trainer'`)
    .all(...allIds);
  if (found.length !== allIds.length) {
    return res.status(400).json({ error: "masterTrainerId and totIds must all reference active Master Trainer accounts" });
  }

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM group_leadership WHERE group_id = ?").run(req.params.id);
    const insert = db.prepare("INSERT INTO group_leadership (group_id, master_trainer_id, role) VALUES (?, ?, ?)");
    insert.run(req.params.id, masterTrainerId, "master");
    for (const totId of totSet) insert.run(req.params.id, totId, "tot");
  });
  tx();

  db.prepare("INSERT INTO activity_log (user_id, action) VALUES (?, 'Assigned as Master Trainer for a Group')").run(masterTrainerId);
  for (const totId of totSet) {
    db.prepare("INSERT INTO activity_log (user_id, action) VALUES (?, 'Assigned as Trainer in Training for a Group')").run(totId);
  }

  res.json(loadGroupSummary(req.params.id));
});

// PUT /api/admin/groups/:id/trainers  { trainerIds: [...] }
// Sets the Group's full Trainer roster (replace semantics -- a Trainer
// belongs to at most one Group, so adding them here moves them out of
// whichever Group they were in before).
router.put("/groups/:id/trainers", (req, res) => {
  const group = db.prepare("SELECT id FROM groups WHERE id = ?").get(req.params.id);
  if (!group) return res.status(404).json({ error: "Group not found" });

  const { trainerIds } = req.body || {};
  if (!Array.isArray(trainerIds)) {
    return res.status(400).json({ error: "trainerIds must be an array" });
  }

  if (trainerIds.length) {
    const placeholders = trainerIds.map(() => "?").join(",");
    const found = db
      .prepare(`SELECT id FROM users WHERE id IN (${placeholders}) AND role = 'trainer'`)
      .all(...trainerIds);
    if (found.length !== new Set(trainerIds.map(Number)).size) {
      return res.status(400).json({ error: "trainerIds must all reference active Trainer accounts" });
    }
  }

  const tx = db.transaction(() => {
    db.prepare("UPDATE users SET group_id = NULL WHERE group_id = ?").run(req.params.id);
    if (trainerIds.length) {
      const placeholders = trainerIds.map(() => "?").join(",");
      db.prepare(`UPDATE users SET group_id = ? WHERE id IN (${placeholders})`).run(req.params.id, ...trainerIds);
    }
  });
  tx();

  res.json(loadGroupSummary(req.params.id));
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
