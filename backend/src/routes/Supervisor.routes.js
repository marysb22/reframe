const express = require("express");
const db = require("../../db");
const { requireAuth, requireSupervisor, requireAssignedStudent } = require("../middleware/auth");
const {
  toStudentSummary,
  toProfileResponse,
  toRecord,
  toDocument,
  toMessage,
  toProgressSummary,
  toMaterial,
  toAnnouncement,
} = require("../utils/serializers");
const { documentUpload, materialUpload } = require("../utils/Uploads");

const router = express.Router();

router.use(requireAuth, requireSupervisor);

const RECORD_TYPES = [
  "attendance",
  "training_session",
  "supervision_session",
  "clinical_hours",
  "assignment",
  "note",
  "evaluation",
];

function getRecordsForStudent(studentId) {
  return db
    .prepare(
      `SELECT sr.*, u.full_name AS supervisor_name
       FROM student_records sr
       JOIN users u ON u.id = sr.supervisor_id
       WHERE sr.student_id = ?
       ORDER BY sr.record_date DESC, sr.created_at DESC`
    )
    .all(studentId);
}

// ---- Students ----------------------------------------------------------

// GET /api/supervisor/students — everyone currently assigned to me
// (admins see everyone they've been explicitly assigned to as well, not
// the whole roster — admins have /api/admin/users for that).
router.get("/students", (req, res) => {
  const rows = db
    .prepare(
      `SELECT u.* FROM users u
       JOIN user_supervisors us ON us.user_id = u.id
       WHERE us.supervisor_id = ? AND u.role = 'trainee'
       ORDER BY u.full_name`
    )
    .all(req.user.id);

  res.json({ students: rows.map(toStudentSummary) });
});

// POST /api/supervisor/students  { studentCode: "TTR001" }
// Self-service assignment: a supervisor enters a student's ID and the
// student immediately appears in their list (and the supervisor
// immediately appears on the student's My Profile page).
router.post("/students", (req, res) => {
  const { studentCode } = req.body || {};
  if (!studentCode || !String(studentCode).trim()) {
    return res.status(400).json({ error: "Student ID is required" });
  }

  const student = db
    .prepare("SELECT * FROM users WHERE member_code = ? AND role = 'trainee'")
    .get(String(studentCode).trim());

  if (!student) {
    return res.status(404).json({ error: "No student found with that ID" });
  }

  const existing = db
    .prepare("SELECT 1 FROM user_supervisors WHERE user_id = ? AND supervisor_id = ?")
    .get(student.id, req.user.id);

  if (!existing) {
    db.prepare("INSERT INTO user_supervisors (user_id, supervisor_id) VALUES (?, ?)").run(
      student.id,
      req.user.id
    );
    db.prepare("INSERT INTO activity_log (user_id, action) VALUES (?, 'Supervisor assigned')").run(student.id);
  }

  res.status(201).json({ student: toStudentSummary(student) });
});

// DELETE /api/supervisor/students/:studentId — unassign myself from a student.
// Does not delete any of the records/documents/messages already created —
// history is preserved even after the relationship ends.
router.delete("/students/:studentId", requireAssignedStudent, (req, res) => {
  db.prepare("DELETE FROM user_supervisors WHERE user_id = ? AND supervisor_id = ?").run(
    req.student.id,
    req.user.id
  );
  db.prepare("INSERT INTO activity_log (user_id, action) VALUES (?, 'Supervisor removed')").run(req.student.id);
  res.json({ success: true });
});

// GET /api/supervisor/students/:studentId — full detail: profile, all
// records, documents, and a computed progress summary.
router.get("/students/:studentId", requireAssignedStudent, (req, res) => {
  const records = getRecordsForStudent(req.student.id);
  const documents = db
    .prepare(
      `SELECT d.*, u.full_name AS uploaded_by_name
       FROM documents d JOIN users u ON u.id = d.uploaded_by
       WHERE d.student_id = ? ORDER BY d.created_at DESC`
    )
    .all(req.student.id);

  res.json({
    student: toProfileResponse(req.student),
    records: records.map(toRecord),
    documents: documents.map(toDocument),
    progress: toProgressSummary(records),
  });
});

// ---- Records (attendance, sessions, hours, assignments, notes, evals) --

// POST /api/supervisor/students/:studentId/records
router.post("/students/:studentId/records", requireAssignedStudent, (req, res) => {
  const { recordType, date, time, durationMinutes, status, title, content, score } = req.body || {};

  if (!RECORD_TYPES.includes(recordType)) {
    return res.status(400).json({ error: `recordType must be one of: ${RECORD_TYPES.join(", ")}` });
  }

  const result = db
    .prepare(
      `INSERT INTO student_records
        (student_id, supervisor_id, record_type, record_date, record_time, duration_minutes, status, title, content, score)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.student.id,
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
    req.student.id,
    `${recordType.replace("_", " ")} added by supervisor`
  );

  const row = db
    .prepare(
      `SELECT sr.*, u.full_name AS supervisor_name FROM student_records sr
       JOIN users u ON u.id = sr.supervisor_id WHERE sr.id = ?`
    )
    .get(result.lastInsertRowid);

  res.status(201).json(toRecord(row));
});

// Shared ownership check for edit/delete: the record must belong to a
// student this supervisor is currently assigned to (admins bypass).
function loadEditableRecord(req, res) {
  const record = db.prepare("SELECT * FROM student_records WHERE id = ?").get(req.params.recordId);
  if (!record) {
    res.status(404).json({ error: "Record not found" });
    return null;
  }
  if (req.user.role !== "admin") {
    const assigned = db
      .prepare("SELECT 1 FROM user_supervisors WHERE user_id = ? AND supervisor_id = ?")
      .get(record.student_id, req.user.id);
    if (!assigned) {
      res.status(403).json({ error: "You are not assigned to this student" });
      return null;
    }
  }
  return record;
}

// PUT /api/supervisor/records/:recordId
router.put("/records/:recordId", (req, res) => {
  const record = loadEditableRecord(req, res);
  if (!record) return;

  const { date, time, durationMinutes, status, title, content, score } = req.body || {};

  db.prepare(
    `UPDATE student_records SET
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
      `SELECT sr.*, u.full_name AS supervisor_name FROM student_records sr
       JOIN users u ON u.id = sr.supervisor_id WHERE sr.id = ?`
    )
    .get(record.id);

  res.json(toRecord(updated));
});

// DELETE /api/supervisor/records/:recordId
router.delete("/records/:recordId", (req, res) => {
  const record = loadEditableRecord(req, res);
  if (!record) return;

  db.prepare("DELETE FROM student_records WHERE id = ?").run(record.id);
  res.json({ success: true });
});

// ---- Documents -----------------------------------------------------------

// POST /api/supervisor/students/:studentId/documents  (multipart, field "document")
router.post("/students/:studentId/documents", requireAssignedStudent, (req, res) => {
  documentUpload.single("document")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const result = db
      .prepare(
        "INSERT INTO documents (student_id, uploaded_by, filename, original_name) VALUES (?, ?, ?, ?)"
      )
      .run(req.student.id, req.user.id, req.file.filename, req.file.originalname);

    db.prepare("INSERT INTO activity_log (user_id, action) VALUES (?, 'Document uploaded by supervisor')").run(
      req.student.id
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

// GET /api/supervisor/students/:studentId/messages — full thread with this student
router.get("/students/:studentId/messages", requireAssignedStudent, (req, res) => {
  const rows = db
    .prepare(
      `SELECT m.*, u.full_name AS sender_name FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE (m.sender_id = ? AND m.recipient_id = ?) OR (m.sender_id = ? AND m.recipient_id = ?)
       ORDER BY m.created_at ASC`
    )
    .all(req.user.id, req.student.id, req.student.id, req.user.id);

  res.json({ messages: rows.map((r) => toMessage(r, req.user.id)) });
});

// POST /api/supervisor/students/:studentId/messages  { content }
router.post("/students/:studentId/messages", requireAssignedStudent, (req, res) => {
  const { content } = req.body || {};
  if (!content || !String(content).trim()) {
    return res.status(400).json({ error: "Message content is required" });
  }

  const result = db
    .prepare("INSERT INTO messages (sender_id, recipient_id, content) VALUES (?, ?, ?)")
    .run(req.user.id, req.student.id, content.trim());

  const row = db
    .prepare(
      `SELECT m.*, u.full_name AS sender_name FROM messages m
       JOIN users u ON u.id = m.sender_id WHERE m.id = ?`
    )
    .get(result.lastInsertRowid);

  res.status(201).json(toMessage(row, req.user.id));
});

// ---- Learning materials (shared with every currently-assigned student) --

// GET /api/supervisor/materials — everything I've shared
router.get("/materials", (req, res) => {
  const rows = db
    .prepare(
      `SELECT lm.*, u.full_name AS supervisor_name FROM learning_materials lm
       JOIN users u ON u.id = lm.supervisor_id
       WHERE lm.supervisor_id = ? ORDER BY lm.created_at DESC`
    )
    .all(req.user.id);
  res.json({ materials: rows.map(toMaterial) });
});

// POST /api/supervisor/materials
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
          `INSERT INTO learning_materials (supervisor_id, title, description, material_type, filename, original_name)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(req.user.id, title, description || null, materialType, req.file.filename, req.file.originalname);

      const row = db
        .prepare(
          `SELECT lm.*, u.full_name AS supervisor_name FROM learning_materials lm
           JOIN users u ON u.id = lm.supervisor_id WHERE lm.id = ?`
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
      `INSERT INTO learning_materials (supervisor_id, title, description, material_type, external_url)
       VALUES (?, ?, ?, 'link', ?)`
    )
    .run(req.user.id, title, description || null, externalUrl);

  const row = db
    .prepare(
      `SELECT lm.*, u.full_name AS supervisor_name FROM learning_materials lm
       JOIN users u ON u.id = lm.supervisor_id WHERE lm.id = ?`
    )
    .get(result.lastInsertRowid);

  res.status(201).json(toMaterial(row));
});

// DELETE /api/supervisor/materials/:materialId
router.delete("/materials/:materialId", (req, res) => {
  const material = db
    .prepare("SELECT * FROM learning_materials WHERE id = ? AND supervisor_id = ?")
    .get(req.params.materialId, req.user.id);
  if (!material) return res.status(404).json({ error: "Material not found" });

  db.prepare("DELETE FROM learning_materials WHERE id = ?").run(material.id);
  res.json({ success: true });
});

// ---- Announcements (broadcast to every currently-assigned student) ------

// GET /api/supervisor/announcements
router.get("/announcements", (req, res) => {
  const rows = db
    .prepare(
      `SELECT a.*, u.full_name AS supervisor_name FROM announcements a
       JOIN users u ON u.id = a.supervisor_id
       WHERE a.supervisor_id = ? ORDER BY a.created_at DESC`
    )
    .all(req.user.id);
  res.json({ announcements: rows.map(toAnnouncement) });
});

// POST /api/supervisor/announcements  { title, content }
router.post("/announcements", (req, res) => {
  const { title, content } = req.body || {};
  if (!title || !content) {
    return res.status(400).json({ error: "title and content are required" });
  }

  const result = db
    .prepare("INSERT INTO announcements (supervisor_id, title, content) VALUES (?, ?, ?)")
    .run(req.user.id, title, content);

  const row = db
    .prepare(
      `SELECT a.*, u.full_name AS supervisor_name FROM announcements a
       JOIN users u ON u.id = a.supervisor_id WHERE a.id = ?`
    )
    .get(result.lastInsertRowid);

  res.status(201).json(toAnnouncement(row));
});

// DELETE /api/supervisor/announcements/:announcementId
router.delete("/announcements/:announcementId", (req, res) => {
  const announcement = db
    .prepare("SELECT * FROM announcements WHERE id = ? AND supervisor_id = ?")
    .get(req.params.announcementId, req.user.id);
  if (!announcement) return res.status(404).json({ error: "Announcement not found" });

  db.prepare("DELETE FROM announcements WHERE id = ?").run(announcement.id);
  res.json({ success: true });
});

// GET /api/supervisor/schedule — training/supervision sessions across all my
// students, split into "today" and "upcoming" for the dashboard widgets.
router.get("/schedule", (req, res) => {
  const rows = db
    .prepare(
      `SELECT sr.*, u.full_name AS student_name, u.member_code AS student_code
       FROM student_records sr
       JOIN users u ON u.id = sr.student_id
       WHERE sr.supervisor_id = ?
         AND sr.record_type IN ('training_session', 'supervision_session')
         AND sr.record_date IS NOT NULL
         AND sr.record_date >= date('now')
       ORDER BY sr.record_date ASC, sr.record_time ASC`
    )
    .all(req.user.id);

  const todayStr = new Date().toISOString().slice(0, 10);
  const today = [];
  const upcoming = [];
  for (const r of rows) {
    const item = {
      id: r.id,
      studentId: r.student_id,
      studentName: r.student_name,
      studentCode: r.student_code,
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

// GET /api/supervisor/activity — most recent actions logged for any of my
// students (from the shared activity_log), for the dashboard's recent-activity feed.
router.get("/activity", (req, res) => {
  const rows = db
    .prepare(
      `SELECT al.action, al.created_at, u.full_name AS student_name
       FROM activity_log al
       JOIN users u ON u.id = al.user_id
       WHERE al.user_id IN (SELECT user_id FROM user_supervisors WHERE supervisor_id = ?)
       ORDER BY al.created_at DESC
       LIMIT 15`
    )
    .all(req.user.id);

  res.json({
    activity: rows.map((r) => ({ action: r.action, studentName: r.student_name, createdAt: r.created_at })),
  });
});

module.exports = router;