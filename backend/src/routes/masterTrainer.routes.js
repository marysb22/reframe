const express = require("express");
const db = require("../../db");
const { requireAuth, requireMasterTrainer, requireAssignedTrainer, isTrainerAssignedToMasterTrainer } = require("../middleware/auth");
const {
  toTrainerSummary,
  toProfileResponse,
  toRecord,
  toDocument,
  toMessage,
  toProgressSummary,
  toMaterial,
  toAnnouncement,
} = require("../utils/serializers");
const { documentUpload, materialUpload } = require("../utils/uploads");

const router = express.Router();

router.use(requireAuth, requireMasterTrainer);

const RECORD_TYPES = [
  "attendance",
  "training_session",
  "supervision_session",
  "clinical_hours",
  "assignment",
  "note",
  "evaluation",
];

function getRecordsForTrainer(trainerId) {
  return db
    .prepare(
      `SELECT tr.*, u.full_name AS master_trainer_name
       FROM trainer_records tr
       JOIN users u ON u.id = tr.master_trainer_id
       WHERE tr.trainer_id = ?
       ORDER BY tr.record_date DESC, tr.created_at DESC`
    )
    .all(trainerId);
}

// The full caseload for a Master Trainer: every Trainer they're linked to
// directly (trainer_master_trainers self-service assignment) plus every
// Trainer in a Group where they hold a group_leadership seat (as Master
// Trainer or as a Trainer in Training).
function getCaseloadTrainers(masterTrainerId) {
  return db
    .prepare(
      `SELECT DISTINCT u.* FROM users u
       WHERE u.role = 'trainer' AND (
         u.id IN (SELECT trainer_id FROM trainer_master_trainers WHERE master_trainer_id = ?)
         OR u.group_id IN (SELECT group_id FROM group_leadership WHERE master_trainer_id = ?)
       )
       ORDER BY u.full_name`
    )
    .all(masterTrainerId, masterTrainerId);
}

// ---- Trainers ----------------------------------------------------------

// GET /api/master-trainer/trainers — everyone currently assigned to me,
// directly or through a shared Group (admins see everyone they've been
// explicitly assigned to as well, not the whole roster — admins have
// /api/admin/users for that).
router.get("/trainers", (req, res) => {
  const rows = getCaseloadTrainers(req.user.id);
  res.json({ trainers: rows.map(toTrainerSummary) });
});

// POST /api/master-trainer/trainers  { trainerCode: "TRN001" }
// Self-service assignment: a Master Trainer enters a Trainer's ID and the
// Trainer immediately appears in their list (and the Master Trainer
// immediately appears on the Trainer's My Profile page). Independent of
// any Group assignment.
router.post("/trainers", (req, res) => {
  const { trainerCode } = req.body || {};
  if (!trainerCode || !String(trainerCode).trim()) {
    return res.status(400).json({ error: "Trainer ID is required" });
  }

  const trainer = db
    .prepare("SELECT * FROM users WHERE member_code = ? AND role = 'trainer'")
    .get(String(trainerCode).trim());

  if (!trainer) {
    return res.status(404).json({ error: "No trainer found with that ID" });
  }

  const existing = db
    .prepare("SELECT 1 FROM trainer_master_trainers WHERE trainer_id = ? AND master_trainer_id = ?")
    .get(trainer.id, req.user.id);

  if (!existing) {
    db.prepare("INSERT INTO trainer_master_trainers (trainer_id, master_trainer_id) VALUES (?, ?)").run(
      trainer.id,
      req.user.id
    );
    db.prepare("INSERT INTO activity_log (user_id, action) VALUES (?, 'Master Trainer assigned')").run(trainer.id);
  }

  res.status(201).json({ trainer: toTrainerSummary(trainer) });
});

// DELETE /api/master-trainer/trainers/:trainerId — unassign myself from a
// Trainer. Only removes the direct link; if the Trainer also belongs to a
// shared Group with me, that Group membership is unaffected (managed by
// an admin, not here). Does not delete any of the records/documents/
// messages already created — history is preserved even after the
// relationship ends.
router.delete("/trainers/:trainerId", requireAssignedTrainer, (req, res) => {
  db.prepare("DELETE FROM trainer_master_trainers WHERE trainer_id = ? AND master_trainer_id = ?").run(
    req.trainer.id,
    req.user.id
  );
  db.prepare("INSERT INTO activity_log (user_id, action) VALUES (?, 'Master Trainer removed')").run(req.trainer.id);
  res.json({ success: true });
});

// GET /api/master-trainer/trainers/:trainerId — full detail: profile, all
// records, documents, and a computed progress summary.
router.get("/trainers/:trainerId", requireAssignedTrainer, (req, res) => {
  const records = getRecordsForTrainer(req.trainer.id);
  const documents = db
    .prepare(
      `SELECT d.*, u.full_name AS uploaded_by_name
       FROM documents d JOIN users u ON u.id = d.uploaded_by
       WHERE d.trainer_id = ? ORDER BY d.created_at DESC`
    )
    .all(req.trainer.id);

  res.json({
    trainer: toProfileResponse(req.trainer),
    records: records.map(toRecord),
    documents: documents.map(toDocument),
    progress: toProgressSummary(records),
  });
});

// ---- Records (attendance, sessions, hours, assignments, notes, evals) --

// POST /api/master-trainer/trainers/:trainerId/records
router.post("/trainers/:trainerId/records", requireAssignedTrainer, (req, res) => {
  const { recordType, date, time, durationMinutes, status, title, content, score } = req.body || {};

  if (!RECORD_TYPES.includes(recordType)) {
    return res.status(400).json({ error: `recordType must be one of: ${RECORD_TYPES.join(", ")}` });
  }

  const result = db
    .prepare(
      `INSERT INTO trainer_records
        (trainer_id, master_trainer_id, record_type, record_date, record_time, duration_minutes, status, title, content, score)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.trainer.id,
      req.user.id,
      recordType,
      date || null,
      time || null,
      durationMinutes || null,
      status || null,
      title || null,
      content || null,
      score ?? null
    );

  db.prepare("INSERT INTO activity_log (user_id, action) VALUES (?, ?)").run(
    req.trainer.id,
    `${recordType.replace("_", " ")} added by master trainer`
  );

  const row = db
    .prepare(
      `SELECT tr.*, u.full_name AS master_trainer_name FROM trainer_records tr
       JOIN users u ON u.id = tr.master_trainer_id WHERE tr.id = ?`
    )
    .get(result.lastInsertRowid);

  res.status(201).json(toRecord(row));
});

// Shared ownership check for edit/delete: the record must belong to a
// Trainer this Master Trainer is currently assigned to (admins bypass).
function loadEditableRecord(req, res) {
  const record = db.prepare("SELECT * FROM trainer_records WHERE id = ?").get(req.params.recordId);
  if (!record) {
    res.status(404).json({ error: "Record not found" });
    return null;
  }
  if (req.user.role !== "admin") {
    if (!isTrainerAssignedToMasterTrainer(record.trainer_id, req.user.id)) {
      res.status(403).json({ error: "You are not assigned to this trainer" });
      return null;
    }
  }
  return record;
}

// PUT /api/master-trainer/records/:recordId
router.put("/records/:recordId", (req, res) => {
  const record = loadEditableRecord(req, res);
  if (!record) return;

  const { date, time, durationMinutes, status, title, content, score } = req.body || {};

  db.prepare(
    `UPDATE trainer_records SET
      record_date = COALESCE(?, record_date),
      record_time = COALESCE(?, record_time),
      duration_minutes = COALESCE(?, duration_minutes),
      status = COALESCE(?, status),
      title = COALESCE(?, title),
      content = COALESCE(?, content),
      score = COALESCE(?, score),
      updated_at = datetime('now')
     WHERE id = ?`
  ).run(date ?? null, time ?? null, durationMinutes ?? null, status ?? null, title ?? null, content ?? null, score ?? null, record.id);

  const updated = db
    .prepare(
      `SELECT tr.*, u.full_name AS master_trainer_name FROM trainer_records tr
       JOIN users u ON u.id = tr.master_trainer_id WHERE tr.id = ?`
    )
    .get(record.id);

  res.json(toRecord(updated));
});

// DELETE /api/master-trainer/records/:recordId
router.delete("/records/:recordId", (req, res) => {
  const record = loadEditableRecord(req, res);
  if (!record) return;

  db.prepare("DELETE FROM trainer_records WHERE id = ?").run(record.id);
  res.json({ success: true });
});

// ---- Documents -----------------------------------------------------------

// POST /api/master-trainer/trainers/:trainerId/documents  (multipart, field "document")
router.post("/trainers/:trainerId/documents", requireAssignedTrainer, (req, res) => {
  documentUpload.single("document")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const result = db
      .prepare(
        "INSERT INTO documents (trainer_id, uploaded_by, filename, original_name) VALUES (?, ?, ?, ?)"
      )
      .run(req.trainer.id, req.user.id, req.file.filename, req.file.originalname);

    db.prepare("INSERT INTO activity_log (user_id, action) VALUES (?, 'Document uploaded by master trainer')").run(
      req.trainer.id
    );

    const row = db
      .prepare(
        `SELECT d.*, u.full_name AS uploaded_by_name FROM documents d
         JOIN users u ON u.id = d.uploaded_by WHERE d.id = ?`
      )
      .get(result.lastInsertRowid);

    res.status(201).json(toDocument(row));
  });
});

// ---- Messages --------------------------------------------------------

// GET /api/master-trainer/trainers/:trainerId/messages — full thread with this Trainer
router.get("/trainers/:trainerId/messages", requireAssignedTrainer, (req, res) => {
  const rows = db
    .prepare(
      `SELECT m.*, u.full_name AS sender_name FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE (m.sender_id = ? AND m.recipient_id = ?) OR (m.sender_id = ? AND m.recipient_id = ?)
       ORDER BY m.created_at ASC`
    )
    .all(req.user.id, req.trainer.id, req.trainer.id, req.user.id);

  res.json({ messages: rows.map((r) => toMessage(r, req.user.id)) });
});

// POST /api/master-trainer/trainers/:trainerId/messages  { content }
router.post("/trainers/:trainerId/messages", requireAssignedTrainer, (req, res) => {
  const { content } = req.body || {};
  if (!content || !String(content).trim()) {
    return res.status(400).json({ error: "Message content is required" });
  }

  const result = db
    .prepare("INSERT INTO messages (sender_id, recipient_id, content) VALUES (?, ?, ?)")
    .run(req.user.id, req.trainer.id, content.trim());

  const row = db
    .prepare(
      `SELECT m.*, u.full_name AS sender_name FROM messages m
       JOIN users u ON u.id = m.sender_id WHERE m.id = ?`
    )
    .get(result.lastInsertRowid);

  res.status(201).json(toMessage(row, req.user.id));
});

// ---- Learning materials (shared with every currently-assigned Trainer) --

// GET /api/master-trainer/materials — everything I've shared
router.get("/materials", (req, res) => {
  const rows = db
    .prepare(
      `SELECT lm.*, u.full_name AS master_trainer_name FROM learning_materials lm
       JOIN users u ON u.id = lm.master_trainer_id
       WHERE lm.master_trainer_id = ? ORDER BY lm.created_at DESC`
    )
    .all(req.user.id);
  res.json({ materials: rows.map(toMaterial) });
});

// POST /api/master-trainer/materials
// For file-based types (document/image/video/audio/worksheet), send multipart
// with field "file". For type "link", send JSON with externalUrl instead.
router.post("/materials", (req, res) => {
  const contentType = req.headers["content-type"] || "";

  if (contentType.includes("multipart/form-data")) {
    materialUpload.single("file")(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      const { title, description, materialType } = req.body || {};
      if (!title || !materialType) {
        return res.status(400).json({ error: "title and materialType are required" });
      }
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });

      const result = db
        .prepare(
          `INSERT INTO learning_materials (master_trainer_id, title, description, material_type, filename, original_name)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(req.user.id, title, description || null, materialType, req.file.filename, req.file.originalname);

      const row = db
        .prepare(
          `SELECT lm.*, u.full_name AS master_trainer_name FROM learning_materials lm
           JOIN users u ON u.id = lm.master_trainer_id WHERE lm.id = ?`
        )
        .get(result.lastInsertRowid);

      res.status(201).json(toMaterial(row));
    });
    return;
  }

  const { title, description, materialType, externalUrl } = req.body || {};
  if (!title || materialType !== "link" || !externalUrl) {
    return res.status(400).json({ error: "For non-file materials, materialType must be 'link' and externalUrl is required" });
  }

  const result = db
    .prepare(
      `INSERT INTO learning_materials (master_trainer_id, title, description, material_type, external_url)
       VALUES (?, ?, ?, 'link', ?)`
    )
    .run(req.user.id, title, description || null, externalUrl);

  const row = db
    .prepare(
      `SELECT lm.*, u.full_name AS master_trainer_name FROM learning_materials lm
       JOIN users u ON u.id = lm.master_trainer_id WHERE lm.id = ?`
    )
    .get(result.lastInsertRowid);

  res.status(201).json(toMaterial(row));
});

// DELETE /api/master-trainer/materials/:materialId
router.delete("/materials/:materialId", (req, res) => {
  const material = db
    .prepare("SELECT * FROM learning_materials WHERE id = ? AND master_trainer_id = ?")
    .get(req.params.materialId, req.user.id);
  if (!material) return res.status(404).json({ error: "Material not found" });

  db.prepare("DELETE FROM learning_materials WHERE id = ?").run(material.id);
  res.json({ success: true });
});

// ---- Announcements (broadcast to every currently-assigned Trainer) ------

// GET /api/master-trainer/announcements
router.get("/announcements", (req, res) => {
  const rows = db
    .prepare(
      `SELECT a.*, u.full_name AS master_trainer_name FROM announcements a
       JOIN users u ON u.id = a.master_trainer_id
       WHERE a.master_trainer_id = ? ORDER BY a.created_at DESC`
    )
    .all(req.user.id);
  res.json({ announcements: rows.map(toAnnouncement) });
});

// POST /api/master-trainer/announcements  { title, content }
router.post("/announcements", (req, res) => {
  const { title, content } = req.body || {};
  if (!title || !content) {
    return res.status(400).json({ error: "title and content are required" });
  }

  const result = db
    .prepare("INSERT INTO announcements (master_trainer_id, title, content) VALUES (?, ?, ?)")
    .run(req.user.id, title, content);

  const row = db
    .prepare(
      `SELECT a.*, u.full_name AS master_trainer_name FROM announcements a
       JOIN users u ON u.id = a.master_trainer_id WHERE a.id = ?`
    )
    .get(result.lastInsertRowid);

  res.status(201).json(toAnnouncement(row));
});

// DELETE /api/master-trainer/announcements/:announcementId
router.delete("/announcements/:announcementId", (req, res) => {
  const announcement = db
    .prepare("SELECT * FROM announcements WHERE id = ? AND master_trainer_id = ?")
    .get(req.params.announcementId, req.user.id);
  if (!announcement) return res.status(404).json({ error: "Announcement not found" });

  db.prepare("DELETE FROM announcements WHERE id = ?").run(announcement.id);
  res.json({ success: true });
});

// GET /api/master-trainer/schedule — training/supervision sessions across
// all my Trainers, split into "today" and "upcoming" for the dashboard widgets.
router.get("/schedule", (req, res) => {
  const trainerIds = getCaseloadTrainers(req.user.id).map((t) => t.id);
  if (!trainerIds.length) return res.json({ today: [], upcoming: [] });

  const placeholders = trainerIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT tr.*, u.full_name AS trainer_name, u.member_code AS trainer_code
       FROM trainer_records tr
       JOIN users u ON u.id = tr.trainer_id
       WHERE tr.trainer_id IN (${placeholders})
         AND tr.record_type IN ('training_session', 'supervision_session')
         AND tr.record_date IS NOT NULL
         AND tr.record_date >= date('now')
       ORDER BY tr.record_date ASC, tr.record_time ASC`
    )
    .all(...trainerIds);

  const todayStr = new Date().toISOString().slice(0, 10);
  const today = [];
  const upcoming = [];
  for (const r of rows) {
    const item = {
      id: r.id,
      trainerId: r.trainer_id,
      trainerName: r.trainer_name,
      trainerCode: r.trainer_code,
      recordType: r.record_type,
      date: r.record_date,
      time: r.record_time,
      durationMinutes: r.duration_minutes,
      title: r.title,
    };
    (r.record_date === todayStr ? today : upcoming).push(item);
  }

  res.json({ today, upcoming: upcoming.slice(0, 10) });
});

// GET /api/master-trainer/activity — most recent actions logged for any of
// my Trainers (from the shared activity_log), for the dashboard's
// recent-activity feed.
router.get("/activity", (req, res) => {
  const trainerIds = getCaseloadTrainers(req.user.id).map((t) => t.id);
  if (!trainerIds.length) return res.json({ activity: [] });

  const placeholders = trainerIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT al.action, al.created_at, u.full_name AS trainer_name
       FROM activity_log al
       JOIN users u ON u.id = al.user_id
       WHERE al.user_id IN (${placeholders})
       ORDER BY al.created_at DESC
       LIMIT 15`
    )
    .all(...trainerIds);

  res.json({
    activity: rows.map((r) => ({ action: r.action, trainerName: r.trainer_name, createdAt: r.created_at })),
  });
});

// ---- Groups (read-only here — an admin manages assignment) -------------

// GET /api/master-trainer/groups — every Group I'm part of, my role in
// each ('master' or 'tot'), my teammates, and the Group's Trainers. Lets a
// Master Trainer see the hierarchy: if they're the Master Trainer, who the
// two Trainers in Training under them are; if they're a TOT, who their
// Master Trainer is.
router.get("/groups", (req, res) => {
  const myGroupIds = db
    .prepare("SELECT DISTINCT group_id FROM group_leadership WHERE master_trainer_id = ?")
    .all(req.user.id)
    .map((r) => r.group_id);

  if (!myGroupIds.length) return res.json({ groups: [] });

  const groups = myGroupIds.map((groupId) => {
    const group = db.prepare("SELECT * FROM groups WHERE id = ?").get(groupId);
    const leadership = db
      .prepare(
        `SELECT gl.role, u.id, u.member_code, u.full_name FROM group_leadership gl
         JOIN users u ON u.id = gl.master_trainer_id
         WHERE gl.group_id = ?`
      )
      .all(groupId);
    const trainers = db
      .prepare("SELECT id, member_code, full_name, cohort, current_year, status FROM users WHERE group_id = ? AND role = 'trainer'")
      .all(groupId);

    const master = leadership.find((r) => r.role === "master") || null;
    const tots = leadership.filter((r) => r.role === "tot");

    return {
      id: group.id,
      name: group.name,
      myRole: leadership.find((r) => r.id === req.user.id)?.role || null,
      masterTrainer: master ? { id: master.id, memberCode: master.member_code, fullName: master.full_name } : null,
      trainersInTraining: tots.map((t) => ({ id: t.id, memberCode: t.member_code, fullName: t.full_name })),
      trainers: trainers.map(toTrainerSummary),
    };
  });

  res.json({ groups });
});

module.exports = router;
