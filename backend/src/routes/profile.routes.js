const express = require("express");
const db = require("../../db");
const { requireAuth } = require("../middleware/auth");
const {
  toProfileResponse,
  toRecord,
  toDocument,
  toMessage,
  toProgressSummary,
  toMaterial,
  toAnnouncement,
  toPaymentSummary,
  toPaymentTransaction,
} = require("../utils/serializers");
const { hashPassword, verifyPassword } = require("../utils/authUtils");
const { photoUpload, cvUpload } = require("../utils/uploads");

const router = express.Router();

router.use(requireAuth);

// GET /api/profile/me
router.get("/me", (req, res) => {
  res.json(toProfileResponse(req.user));
});

// PUT /api/profile/me — only self-editable fields. member_code, role,
// status, cohort, currentYear, group, and Master Trainer links are
// admin-managed (see admin.routes.js) so a user can't grant themselves a
// new ID, cohort, or Group.
router.put("/me", (req, res) => {
  const {
    full_name,
    email,
    gender,
    dateOfBirth,
    maritalStatus,
    phone,
    address,
    highestDegree,
    institution,
    certifications,
  } = req.body || {};

  if (!full_name || !String(full_name).trim()) {
    return res.status(400).json({ error: "Full name is required" });
  }

  if (email) {
    const existing = db
      .prepare("SELECT id FROM users WHERE email = ? AND id != ?")
      .get(email, req.user.id);
    if (existing) {
      return res.status(409).json({ error: "That email is already in use" });
    }
  }

  db.prepare(
    `UPDATE users SET
      full_name = ?, email = ?, gender = ?, date_of_birth = ?, marital_status = ?,
      phone = ?, address = ?, highest_degree = ?, institution = ?, certifications = ?,
      updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    full_name,
    email || null,
    gender || null,
    dateOfBirth || null,
    maritalStatus || null,
    phone || null,
    address || null,
    highestDegree || null,
    institution || null,
    certifications || null,
    req.user.id
  );

  db.prepare("INSERT INTO activity_log (user_id, action) VALUES (?, 'Profile updated')").run(req.user.id);

  const updated = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  res.json(toProfileResponse(updated));
});

// POST /api/profile/change-password  { currentPassword, newPassword }
router.post("/change-password", (req, res) => {
  const { currentPassword, newPassword } = req.body || {};

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "Current and new password are required" });
  }
  if (String(newPassword).length < 8) {
    return res.status(400).json({ error: "New password must be at least 8 characters" });
  }
  if (!verifyPassword(currentPassword, req.user.password_hash)) {
    return res.status(401).json({ error: "Current password is incorrect" });
  }

  db.prepare(
    "UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = datetime('now') WHERE id = ?"
  ).run(hashPassword(newPassword), req.user.id);

  db.prepare("INSERT INTO activity_log (user_id, action) VALUES (?, 'Password changed')").run(req.user.id);

  res.json({ success: true, message: "Password updated successfully" });
});

// POST /api/profile/photo  (multipart/form-data, field name "photo")
router.post("/photo", (req, res) => {
  photoUpload.single("photo")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No photo uploaded" });

    db.prepare("UPDATE users SET photo = ?, updated_at = datetime('now') WHERE id = ?").run(
      req.file.filename,
      req.user.id
    );
    db.prepare("INSERT INTO activity_log (user_id, action) VALUES (?, 'Photo uploaded')").run(req.user.id);

    res.json({ success: true, photo: req.file.filename });
  });
});

// POST /api/profile/cv  (multipart/form-data, field name "cv")
router.post("/cv", (req, res) => {
  cvUpload.single("cv")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No CV uploaded" });

    db.prepare("UPDATE users SET cv_file = ?, updated_at = datetime('now') WHERE id = ?").run(
      req.file.filename,
      req.user.id
    );
    db.prepare("INSERT INTO activity_log (user_id, action) VALUES (?, 'CV uploaded')").run(req.user.id);

    res.json({ success: true, cvFile: req.file.filename });
  });
});

// GET /api/profile/records?type=attendance — everything a Master Trainer
// has logged for me. Optional ?type= filters to one record_type.
router.get("/records", (req, res) => {
  const { type } = req.query;
  const rows = type
    ? db
        .prepare(
          `SELECT tr.*, u.full_name AS master_trainer_name FROM trainer_records tr
           JOIN users u ON u.id = tr.master_trainer_id
           WHERE tr.trainer_id = ? AND tr.record_type = ?
           ORDER BY tr.record_date DESC, tr.created_at DESC`
        )
        .all(req.user.id, type)
    : db
        .prepare(
          `SELECT tr.*, u.full_name AS master_trainer_name FROM trainer_records tr
           JOIN users u ON u.id = tr.master_trainer_id
           WHERE tr.trainer_id = ?
           ORDER BY tr.record_date DESC, tr.created_at DESC`
        )
        .all(req.user.id);

  res.json({ records: rows.map(toRecord) });
});

// GET /api/profile/progress — the numbers behind the profile completion /
// program progress cards (clinical hours, attendance rate, etc.)
router.get("/progress", (req, res) => {
  const rows = db.prepare("SELECT * FROM trainer_records WHERE trainer_id = ?").all(req.user.id);
  res.json(toProgressSummary(rows));
});

// GET /api/profile/documents — files Master Trainers have shared with me
router.get("/documents", (req, res) => {
  const rows = db
    .prepare(
      `SELECT d.*, u.full_name AS uploaded_by_name FROM documents d
       JOIN users u ON u.id = d.uploaded_by
       WHERE d.trainer_id = ? ORDER BY d.created_at DESC`
    )
    .all(req.user.id);
  res.json({ documents: rows.map(toDocument) });
});

// GET /api/profile/messages/:masterTrainerId — my thread with one Master Trainer
router.get("/messages/:masterTrainerId", (req, res) => {
  const masterTrainerId = Number(req.params.masterTrainerId);
  const rows = db
    .prepare(
      `SELECT m.*, u.full_name AS sender_name FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE (m.sender_id = ? AND m.recipient_id = ?) OR (m.sender_id = ? AND m.recipient_id = ?)
       ORDER BY m.created_at ASC`
    )
    .all(req.user.id, masterTrainerId, masterTrainerId, req.user.id);
  res.json({ messages: rows.map((r) => toMessage(r, req.user.id)) });
});

// POST /api/profile/messages/:masterTrainerId  { content } — reply to a Master Trainer
router.post("/messages/:masterTrainerId", (req, res) => {
  const masterTrainerId = Number(req.params.masterTrainerId);
  const { content } = req.body || {};
  if (!content || !String(content).trim()) {
    return res.status(400).json({ error: "Message content is required" });
  }

  const masterTrainer = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'master_trainer'").get(masterTrainerId);
  if (!masterTrainer) return res.status(404).json({ error: "Master Trainer not found" });

  const result = db
    .prepare("INSERT INTO messages (sender_id, recipient_id, content) VALUES (?, ?, ?)")
    .run(req.user.id, masterTrainerId, content.trim());

  const row = db
    .prepare(
      `SELECT m.*, u.full_name AS sender_name FROM messages m
       JOIN users u ON u.id = m.sender_id WHERE m.id = ?`
    )
    .get(result.lastInsertRowid);

  res.status(201).json(toMessage(row, req.user.id));
});

// GET /api/profile/materials-feed — everything shared by any of my Master Trainers
router.get("/materials-feed", (req, res) => {
  const rows = db
    .prepare(
      `SELECT lm.*, u.full_name AS master_trainer_name FROM learning_materials lm
       JOIN users u ON u.id = lm.master_trainer_id
       WHERE lm.master_trainer_id IN (
         SELECT master_trainer_id FROM trainer_master_trainers WHERE trainer_id = ?
         UNION
         SELECT gl.master_trainer_id FROM users t
         JOIN group_leadership gl ON gl.group_id = t.group_id
         WHERE t.id = ?
       )
       ORDER BY lm.created_at DESC`
    )
    .all(req.user.id, req.user.id);
  res.json({ materials: rows.map(toMaterial) });
});

// GET /api/profile/announcements — everything posted by any of my Master Trainers
router.get("/announcements", (req, res) => {
  const rows = db
    .prepare(
      `SELECT a.*, u.full_name AS master_trainer_name FROM announcements a
       JOIN users u ON u.id = a.master_trainer_id
       WHERE a.master_trainer_id IN (
         SELECT master_trainer_id FROM trainer_master_trainers WHERE trainer_id = ?
         UNION
         SELECT gl.master_trainer_id FROM users t
         JOIN group_leadership gl ON gl.group_id = t.group_id
         WHERE t.id = ?
       )
       ORDER BY a.created_at DESC`
    )
    .all(req.user.id, req.user.id);
  res.json({ announcements: rows.map(toAnnouncement) });
});

// GET /api/profile/payments — my own payment summary + history (read-only;
// only an admin can add or change payment records).
router.get("/payments", (req, res) => {
  const totalFeeRow = db.prepare("SELECT total_fee_cents FROM payment_profiles WHERE user_id = ?").get(req.user.id);
  const totalFeeCents = totalFeeRow ? totalFeeRow.total_fee_cents : 0;

  const transactions = db
    .prepare(
      `SELECT pt.*, u.full_name AS added_by_name FROM payment_transactions pt
       JOIN users u ON u.id = pt.added_by
       WHERE pt.user_id = ? ORDER BY pt.payment_date DESC, pt.created_at DESC`
    )
    .all(req.user.id);

  res.json({
    summary: toPaymentSummary(req.user, totalFeeCents, transactions),
    transactions: transactions.map(toPaymentTransaction),
  });
});

// GET /api/profile/activity — powers the "Security & Activity" list
router.get("/activity", (req, res) => {
  const rows = db
    .prepare("SELECT action, created_at FROM activity_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 20")
    .all(req.user.id);
  res.json(rows);
});

module.exports = router;
