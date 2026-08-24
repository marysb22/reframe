const express = require("express");
const { requireAuth, requireSupervisor, asyncRoute } = require("../middleware/auth");
const {
  toStudentSummary,
  toProfileResponse,
  toRecord,
  toDocument,
  toMessage,
  toMaterial,
  toAnnouncement,
  computeProgressSummary,
} = require("../utils/serializers");
const { documentUpload, materialUpload } = require("../utils/uploads");
const { buildRecordsQuery, RECORD_TYPE_TABLES } = require("../utils/recordsQuery");

const router = express.Router();

router.use(requireAuth, requireSupervisor);

const STUDENT_PROFILE_SELECT = `
  SELECT uc.id, uc.member_code, uc.role, uc.status, uc.must_change_password, uc.created_at, uc.updated_at,
         st.full_name, st.email, st.phone, st.photo, st.gender, st.date_of_birth, st.marital_status,
         st.address, st.highest_degree, st.institution, st.certifications, st.cv_file,
         st.cohort_id, c.name AS cohort_name, st.current_year
  FROM user_credentials uc
  JOIN students st ON st.id = uc.id
  LEFT JOIN cohorts c ON c.id = st.cohort_id
  WHERE uc.id = ?
`;

/** Builds a `col IN (?,?,...)` fragment + matching params for a dynamic id list. */
function inClause(ids) {
  return { sql: ids.map(() => "?").join(","), params: ids };
}

/** Confirms studentId is currently assigned to the calling supervisor and returns their row, or writes a 403/404 and returns null. */
async function loadAssignedStudent(db, supervisorId, studentId, res) {
  const { rows: assignRows } = await db.query(
    "SELECT 1 FROM supervisor_students WHERE supervisor_id = ? AND student_id = ?",
    [supervisorId, studentId]
  );
  if (!assignRows.length) {
    res.status(403).json({ error: "You are not assigned to this trainee" });
    return null;
  }
  const { rows } = await db.query(STUDENT_PROFILE_SELECT, [studentId]);
  if (!rows.length) {
    res.status(404).json({ error: "Trainee not found" });
    return null;
  }
  return rows[0];
}

async function attachSupervisorNames(db, rows) {
  const supIds = [...new Set(rows.map((r) => r.supervisor_id).filter((x) => x != null))];
  if (!supIds.length) return rows;
  const { sql, params } = inClause(supIds);
  const { rows: supRows } = await db.query(`SELECT id, full_name FROM supervisors WHERE id IN (${sql})`, params);
  const names = {};
  supRows.forEach((r) => (names[r.id] = r.full_name));
  return rows.map((r) => ({ ...r, supervisor_name: names[r.supervisor_id] }));
}

// ---- Trainees -------------------------------------------------------------

// GET /api/supervisor/students
router.get(
  "/students",
  asyncRoute(async (req, res, db) => {
    const { rows } = await db.query(
      `SELECT uc.id, uc.member_code, uc.status, st.full_name, st.current_year, c.name AS cohort_name
       FROM supervisor_students ss
       JOIN user_credentials uc ON uc.id = ss.student_id
       JOIN students st ON st.id = ss.student_id
       LEFT JOIN cohorts c ON c.id = st.cohort_id
       WHERE ss.supervisor_id = ?
       ORDER BY st.full_name`,
      [req.user.id]
    );
    res.json({ students: rows.map(toStudentSummary) });
  })
);

// POST /api/supervisor/students  { studentCode: "TTR001" }
router.post(
  "/students",
  asyncRoute(async (req, res, db) => {
    const { studentCode } = req.body || {};
    if (!studentCode || !String(studentCode).trim()) {
      return res.status(400).json({ error: "Trainee ID is required" });
    }

    const { rows: studentRows } = await db.query(
      `SELECT uc.id, uc.member_code, uc.status, st.full_name, st.current_year, c.name AS cohort_name
       FROM user_credentials uc JOIN students st ON st.id = uc.id LEFT JOIN cohorts c ON c.id = st.cohort_id
       WHERE uc.member_code = ?`,
      [String(studentCode).trim().toUpperCase()]
    );
    if (!studentRows.length) {
      return res.status(404).json({ error: "This Trainee ID does not exist. Please contact the Administrator." });
    }
    const student = studentRows[0];

    await db.query(
      `INSERT INTO supervisor_students (supervisor_id, student_id, assigned_by) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE assigned_at = assigned_at`,
      [req.user.id, student.id, req.user.id]
    );
    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES (?, 'supervisor_assigned', 'supervisor_students', ?)",
      [req.user.id, student.id]
    );

    res.status(201).json({ student: toStudentSummary(student) });
  })
);

// DELETE /api/supervisor/students/:studentId — unassign only, history stays intact
router.delete(
  "/students/:studentId",
  asyncRoute(async (req, res, db) => {
    const studentId = Number(req.params.studentId);
    const student = await loadAssignedStudent(db, req.user.id, studentId, res);
    if (!student) return;

    await db.query("DELETE FROM supervisor_students WHERE supervisor_id = ? AND student_id = ?", [
      req.user.id,
      studentId,
    ]);
    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES (?, 'supervisor_unassigned', 'supervisor_students', ?)",
      [req.user.id, studentId]
    );
    res.json({ success: true });
  })
);

// GET /api/supervisor/students/:studentId
router.get(
  "/students/:studentId",
  asyncRoute(async (req, res, db) => {
    const studentId = Number(req.params.studentId);
    const student = await loadAssignedStudent(db, req.user.id, studentId, res);
    if (!student) return;

    const rq = buildRecordsQuery(studentId, null);
    const { rows: recordRows } = await db.query(rq.sql, rq.params);
    const records = await attachSupervisorNames(db, recordRows);

    const { rows: documents } = await db.query(
      `SELECT d.*, COALESCE(a.full_name, sup.full_name) AS uploaded_by_name FROM documents d
       LEFT JOIN admin_users a ON a.id = d.uploaded_by
       LEFT JOIN supervisors sup ON sup.id = d.uploaded_by
       WHERE d.student_id = ? ORDER BY d.created_at DESC`,
      [studentId]
    );

    res.json({
      student: toProfileResponse(student),
      records: records.map(toRecord),
      documents: documents.map(toDocument),
      progress: await computeProgressSummary(db, studentId),
    });
  })
);

// ---- Records (8 types, dispatched to their real table) ------------------

const RECORD_TYPES = Object.keys(RECORD_TYPE_TABLES);

// POST /api/supervisor/students/:studentId/records
router.post(
  "/students/:studentId/records",
  asyncRoute(async (req, res, db) => {
    const studentId = Number(req.params.studentId);
    const student = await loadAssignedStudent(db, req.user.id, studentId, res);
    if (!student) return;

    const { recordType, date, time, durationMinutes, status, title, content, score } = req.body || {};
    if (!RECORD_TYPES.includes(recordType)) {
      return res.status(400).json({ error: `recordType must be one of: ${RECORD_TYPES.join(", ")}` });
    }

    let insertedId;
    switch (recordType) {
      case "training_session":
      case "supervision_session": {
        const sessionType = recordType === "training_session" ? "training" : "supervision";
        const insert = await db.query(
          `INSERT INTO sessions (student_id, supervisor_id, session_type, title, session_date, session_time, duration_minutes, notes)
           VALUES (?,?,?,?,?,?,?,?)`,
          [studentId, req.user.id, sessionType, title || null, date || null, time || null, durationMinutes || null, content || null]
        );
        insertedId = insert.insertId;
        break;
      }
      case "attendance": {
        if (!["present", "absent", "excused"].includes(status)) {
          return res.status(400).json({ error: "attendance requires status: present, absent, or excused" });
        }
        const insert = await db.query(
          `INSERT INTO attendance (student_id, supervisor_id, attendance_date, status, notes, recorded_by)
           VALUES (?,?,?,?,?,?)`,
          [studentId, req.user.id, date || null, status, content || null, req.user.id]
        );
        insertedId = insert.insertId;
        break;
      }
      case "training_hours":
      case "supervision_hours": {
        const table = recordType;
        const hours = durationMinutes ? Number(durationMinutes) / 60 : 0;
        const insert = await db.query(
          `INSERT INTO ${table} (student_id, supervisor_id, hours, hour_date, description) VALUES (?,?,?,?,?)`,
          [studentId, req.user.id, hours, date || null, content || null]
        );
        insertedId = insert.insertId;
        break;
      }
      case "assignment": {
        const insert = await db.query(
          `INSERT INTO assignments (student_id, supervisor_id, title, description, due_date, status)
           VALUES (?,?,?,?,?,?)`,
          [studentId, req.user.id, title || "Untitled assignment", content || null, date || null, status || "pending"]
        );
        insertedId = insert.insertId;
        break;
      }
      case "note": {
        const insert = await db.query(
          `INSERT INTO supervisor_notes (student_id, supervisor_id, note_date, content) VALUES (?,?,?,?)`,
          [studentId, req.user.id, date || null, content || ""]
        );
        insertedId = insert.insertId;
        break;
      }
      case "evaluation": {
        const insert = await db.query(
          `INSERT INTO evaluations (student_id, supervisor_id, evaluation_date, title, score, content)
           VALUES (?,?,?,?,?,?)`,
          [studentId, req.user.id, date || null, title || null, score ?? null, content || null]
        );
        insertedId = insert.insertId;
        break;
      }
    }

    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, new_values) VALUES (?, ?, ?, ?, ?)",
      [
        req.user.id,
        `${recordType.replace(/_/g, " ")} added`,
        recordType,
        studentId,
        JSON.stringify({ recordId: insertedId }),
      ]
    );

    const freshRq = buildRecordsQuery(studentId, recordType);
    const { rows: freshRows } = await db.query(freshRq.sql, freshRq.params);
    const [withName] = await attachSupervisorNames(db, freshRows.filter((r) => r.id === insertedId));
    res.status(201).json(toRecord(withName || freshRows.find((r) => r.id === insertedId)));
  })
);

// PUT /api/supervisor/records/:recordType/:recordId
router.put(
  "/records/:recordType/:recordId",
  asyncRoute(async (req, res, db) => {
    const { recordType, recordId } = req.params;
    const meta = RECORD_TYPE_TABLES[recordType];
    if (!meta) return res.status(400).json({ error: "Unknown record type" });

    const { rows: existingRows } = await db.query(`SELECT * FROM ${meta.table} WHERE id = ?`, [recordId]);
    const existing = existingRows[0];
    if (!existing) return res.status(404).json({ error: "Record not found" });

    const { rows: assignRows } = await db.query(
      "SELECT 1 FROM supervisor_students WHERE supervisor_id = ? AND student_id = ?",
      [req.user.id, existing.student_id]
    );
    if (!assignRows.length) return res.status(403).json({ error: "You are not assigned to this trainee" });

    const { date, time, durationMinutes, status, title, content, score } = req.body || {};

    if (recordType === "training_session" || recordType === "supervision_session") {
      await db.query(
        `UPDATE sessions SET
          session_date = COALESCE(?, session_date), session_time = COALESCE(?, session_time),
          duration_minutes = COALESCE(?, duration_minutes), title = COALESCE(?, title),
          notes = COALESCE(?, notes), updated_at = NOW()
         WHERE id = ?`,
        [date ?? null, time ?? null, durationMinutes ?? null, title ?? null, content ?? null, recordId]
      );
    } else if (recordType === "attendance") {
      await db.query(
        `UPDATE attendance SET attendance_date = COALESCE(?, attendance_date), status = COALESCE(?, status), notes = COALESCE(?, notes) WHERE id = ?`,
        [date ?? null, status ?? null, content ?? null, recordId]
      );
    } else if (recordType === "training_hours" || recordType === "supervision_hours") {
      const hours = durationMinutes != null ? Number(durationMinutes) / 60 : null;
      await db.query(
        `UPDATE ${meta.table} SET hour_date = COALESCE(?, hour_date), hours = COALESCE(?, hours), description = COALESCE(?, description) WHERE id = ?`,
        [date ?? null, hours, content ?? null, recordId]
      );
    } else if (recordType === "assignment") {
      await db.query(
        `UPDATE assignments SET due_date = COALESCE(?, due_date), status = COALESCE(?, status), title = COALESCE(?, title), description = COALESCE(?, description), updated_at = NOW() WHERE id = ?`,
        [date ?? null, status ?? null, title ?? null, content ?? null, recordId]
      );
    } else if (recordType === "note") {
      await db.query(
        `UPDATE supervisor_notes SET note_date = COALESCE(?, note_date), content = COALESCE(?, content), updated_at = NOW() WHERE id = ?`,
        [date ?? null, content ?? null, recordId]
      );
    } else if (recordType === "evaluation") {
      await db.query(
        `UPDATE evaluations SET evaluation_date = COALESCE(?, evaluation_date), title = COALESCE(?, title), score = COALESCE(?, score), content = COALESCE(?, content), updated_at = NOW() WHERE id = ?`,
        [date ?? null, title ?? null, score ?? null, content ?? null, recordId]
      );
    }

    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, old_values) VALUES (?, ?, ?, ?, ?)",
      [req.user.id, `${recordType.replace(/_/g, " ")} updated`, recordType, recordId, JSON.stringify(existing)]
    );

    const freshRq = buildRecordsQuery(existing.student_id, recordType);
    const { rows: freshRows } = await db.query(freshRq.sql, freshRq.params);
    const [withName] = await attachSupervisorNames(db, freshRows.filter((r) => String(r.id) === String(recordId)));
    res.json(toRecord(withName));
  })
);

// DELETE /api/supervisor/records/:recordType/:recordId
router.delete(
  "/records/:recordType/:recordId",
  asyncRoute(async (req, res, db) => {
    const { recordType, recordId } = req.params;
    const meta = RECORD_TYPE_TABLES[recordType];
    if (!meta) return res.status(400).json({ error: "Unknown record type" });

    const { rows: existingRows } = await db.query(`SELECT * FROM ${meta.table} WHERE id = ?`, [recordId]);
    if (!existingRows.length) return res.status(404).json({ error: "Record not found" });
    const existing = existingRows[0];

    const { rows: assignRows } = await db.query(
      "SELECT 1 FROM supervisor_students WHERE supervisor_id = ? AND student_id = ?",
      [req.user.id, existing.student_id]
    );
    if (!assignRows.length) return res.status(403).json({ error: "You are not assigned to this trainee" });

    await db.query(`DELETE FROM ${meta.table} WHERE id = ?`, [recordId]);
    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, old_values) VALUES (?, ?, ?, ?, ?)",
      [req.user.id, `${recordType.replace(/_/g, " ")} deleted`, recordType, recordId, JSON.stringify(existing)]
    );
    res.json({ success: true });
  })
);

// ---- Training Milestones ---------------------------------------------------
// Definitions are Admin-managed (backend/src/routes/admin.js); a Trainer
// (ToT) marks their own trainees' progress against them here. Progress rows
// are created lazily (upserted) the first time a milestone is touched for a
// given trainee -- not pre-seeded, so "no row" simply means not_started.

// GET /api/supervisor/milestones — active milestone definitions (global, not
// group-scoped -- these are shared curriculum stages, same list every
// Trainer sees).
router.get(
  "/milestones",
  asyncRoute(async (req, res, db) => {
    const { rows } = await db.query(
      "SELECT id, code, name_en, name_ar, description_en, description_ar, sort_order FROM training_milestones WHERE is_active = TRUE ORDER BY sort_order ASC"
    );
    res.json({ milestones: rows });
  })
);

// GET /api/supervisor/students/:studentId/milestones — this trainee's progress
// against every active milestone (LEFT JOIN so an untouched milestone still
// appears, as not_started, rather than being silently missing).
router.get(
  "/students/:studentId/milestones",
  asyncRoute(async (req, res, db) => {
    const studentId = Number(req.params.studentId);
    const student = await loadAssignedStudent(db, req.user.id, studentId, res);
    if (!student) return;

    const { rows } = await db.query(
      `SELECT tm.id AS milestone_id, tm.code, tm.name_en, tm.name_ar, tm.sort_order,
              COALESCE(tmp.status, 'not_started') AS status, tmp.completed_at, tmp.notes, tmp.updated_at
         FROM training_milestones tm
         LEFT JOIN trainee_milestone_progress tmp ON tmp.milestone_id = tm.id AND tmp.student_id = ?
        WHERE tm.is_active = TRUE
        ORDER BY tm.sort_order ASC`,
      [studentId]
    );
    res.json({ milestones: rows });
  })
);

// PUT /api/supervisor/students/:studentId/milestones/:milestoneId  { status, notes? }
router.put(
  "/students/:studentId/milestones/:milestoneId",
  asyncRoute(async (req, res, db) => {
    const studentId = Number(req.params.studentId);
    const milestoneId = Number(req.params.milestoneId);
    const student = await loadAssignedStudent(db, req.user.id, studentId, res);
    if (!student) return;

    const { status, notes } = req.body || {};
    if (!["not_started", "in_progress", "completed"].includes(status)) {
      return res.status(400).json({ error: "Status must be 'not_started', 'in_progress', or 'completed'" });
    }

    const { rows: milestoneRows } = await db.query(
      "SELECT id, name_en FROM training_milestones WHERE id = ? AND is_active = TRUE",
      [milestoneId]
    );
    if (!milestoneRows.length) return res.status(404).json({ error: "Milestone not found" });

    const completedAt = status === "completed" ? new Date() : null;
    await db.query(
      `INSERT INTO trainee_milestone_progress (student_id, milestone_id, status, completed_at, marked_by, notes)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE status = VALUES(status), completed_at = VALUES(completed_at),
         marked_by = VALUES(marked_by), notes = VALUES(notes), updated_at = NOW()`,
      [studentId, milestoneId, status, completedAt, req.user.id, notes || null]
    );

    if (status === "completed") {
      await db.query(
        "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, new_values) VALUES (?, 'milestone_marked_completed', 'trainee_milestone_progress', ?, ?)",
        [req.user.id, studentId, JSON.stringify({ milestoneId, milestoneName: milestoneRows[0].name_en })]
      );
    }

    res.json({ success: true, studentId, milestoneId, status, completedAt });
  })
);

// ---- Documents -----------------------------------------------------------

router.post("/students/:studentId/documents", (req, res) => {
  documentUpload.single("document")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const { pool } = require("../db");
    const studentId = Number(req.params.studentId);
    const assigned = await pool.query(
      "SELECT 1 FROM supervisor_students WHERE supervisor_id = ? AND student_id = ?",
      [req.user.id, studentId]
    );
    if (!assigned.rows.length) return res.status(403).json({ error: "You are not assigned to this trainee" });

    const insert = await pool.query(
      `INSERT INTO documents (student_id, uploaded_by, filename, original_name) VALUES (?,?,?,?)`,
      [studentId, req.user.id, req.file.filename, req.file.originalname]
    );
    const { rows } = await pool.query("SELECT * FROM documents WHERE id = ?", [insert.insertId]);

    res.status(201).json(toDocument({ ...rows[0], uploaded_by_name: req.user.member_code }));
  });
});

// ---- Messages --------------------------------------------------------

async function getOrCreateChat(db, supervisorId, studentId) {
  const { rows } = await db.query("SELECT id FROM chats WHERE supervisor_id = ? AND student_id = ?", [
    supervisorId,
    studentId,
  ]);
  if (rows.length) return rows[0].id;
  const created = await db.query("INSERT INTO chats (supervisor_id, student_id) VALUES (?, ?)", [
    supervisorId,
    studentId,
  ]);
  return created.insertId;
}

router.get(
  "/students/:studentId/messages",
  asyncRoute(async (req, res, db) => {
    const studentId = Number(req.params.studentId);
    const student = await loadAssignedStudent(db, req.user.id, studentId, res);
    if (!student) return;

    const chatId = await getOrCreateChat(db, req.user.id, studentId);
    const { rows } = await db.query(
      `SELECT m.*, COALESCE(sup.full_name, st.full_name) AS sender_name FROM messages m
       LEFT JOIN supervisors sup ON sup.id = m.sender_id
       LEFT JOIN students st ON st.id = m.sender_id
       WHERE m.chat_id = ? ORDER BY m.created_at ASC`,
      [chatId]
    );
    res.json({ messages: rows.map((r) => toMessage(r, req.user.id)) });
  })
);

router.post(
  "/students/:studentId/messages",
  asyncRoute(async (req, res, db) => {
    const studentId = Number(req.params.studentId);
    const student = await loadAssignedStudent(db, req.user.id, studentId, res);
    if (!student) return;

    const { content } = req.body || {};
    if (!content || !String(content).trim()) {
      return res.status(400).json({ error: "Message content is required" });
    }

    const chatId = await getOrCreateChat(db, req.user.id, studentId);
    const insert = await db.query(
      "INSERT INTO messages (chat_id, sender_id, content) VALUES (?, ?, ?)",
      [chatId, req.user.id, content.trim()]
    );
    await db.query("UPDATE chats SET last_message_at = NOW() WHERE id = ?", [chatId]);

    const { rows } = await db.query("SELECT * FROM messages WHERE id = ?", [insert.insertId]);
    res.status(201).json(toMessage({ ...rows[0], sender_name: req.user.member_code }, req.user.id));
  })
);

// ---- Learning materials --------------------------------------------------

router.get(
  "/materials",
  asyncRoute(async (req, res, db) => {
    const { rows } = await db.query(
      "SELECT * FROM learning_materials WHERE supervisor_id = ? ORDER BY created_at DESC",
      [req.user.id]
    );
    res.json({ materials: rows.map((r) => toMaterial({ ...r, supervisor_name: req.user.member_code })) });
  })
);

router.post("/materials", (req, res) => {
  const contentType = req.headers["content-type"] || "";
  const { pool } = require("../db");

  if (contentType.includes("multipart/form-data")) {
    materialUpload.single("file")(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.message });
      const { title, description, materialType, studentId } = req.body || {};
      if (!title || !materialType) return res.status(400).json({ error: "title and materialType are required" });
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });

      const insert = await pool.query(
        `INSERT INTO learning_materials (supervisor_id, student_id, title, description, material_type, filename, original_name)
         VALUES (?,?,?,?,?,?,?)`,
        [req.user.id, studentId || null, title, description || null, materialType, req.file.filename, req.file.originalname]
      );
      const { rows } = await pool.query("SELECT * FROM learning_materials WHERE id = ?", [insert.insertId]);
      await pool.query(
        "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES (?, 'material added', 'learning_materials', ?)",
        [req.user.id, insert.insertId]
      );
      res.status(201).json(toMaterial({ ...rows[0], supervisor_name: req.user.member_code }));
    });
    return;
  }

  (async () => {
    const { title, description, materialType, externalUrl, studentId } = req.body || {};
    if (!title || materialType !== "link" || !externalUrl) {
      return res.status(400).json({ error: "For non-file materials, materialType must be 'link' and externalUrl is required" });
    }
    const insert = await pool.query(
      `INSERT INTO learning_materials (supervisor_id, student_id, title, description, material_type, external_url)
       VALUES (?,?,?,?,'link',?)`,
      [req.user.id, studentId || null, title, description || null, externalUrl]
    );
    const { rows } = await pool.query("SELECT * FROM learning_materials WHERE id = ?", [insert.insertId]);
    await pool.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES (?, 'material added', 'learning_materials', ?)",
      [req.user.id, insert.insertId]
    );
    res.status(201).json(toMaterial({ ...rows[0], supervisor_name: req.user.member_code }));
  })().catch((err) => res.status(500).json({ error: "Internal server error" }));
});

router.delete(
  "/materials/:materialId",
  asyncRoute(async (req, res, db) => {
    const { rows: existingRows } = await db.query("SELECT * FROM learning_materials WHERE id = ? AND supervisor_id = ?", [
      req.params.materialId,
      req.user.id,
    ]);
    if (!existingRows.length) return res.status(404).json({ error: "Material not found" });

    await db.query("DELETE FROM learning_materials WHERE id = ?", [req.params.materialId]);
    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, old_values) VALUES (?, 'material deleted', 'learning_materials', ?, ?)",
      [req.user.id, req.params.materialId, JSON.stringify(existingRows[0])]
    );
    res.json({ success: true });
  })
);

// ---- Announcements ---------------------------------------------------

router.get(
  "/announcements",
  asyncRoute(async (req, res, db) => {
    const { rows } = await db.query(
      "SELECT * FROM announcements WHERE supervisor_id = ? ORDER BY created_at DESC",
      [req.user.id]
    );
    res.json({ announcements: rows.map((r) => toAnnouncement({ ...r, supervisor_name: req.user.member_code })) });
  })
);

router.post(
  "/announcements",
  asyncRoute(async (req, res, db) => {
    const { title, content } = req.body || {};
    if (!title || !content) return res.status(400).json({ error: "title and content are required" });

    const insert = await db.query(
      "INSERT INTO announcements (supervisor_id, title, content) VALUES (?, ?, ?)",
      [req.user.id, title, content]
    );
    const { rows } = await db.query("SELECT * FROM announcements WHERE id = ?", [insert.insertId]);
    res.status(201).json(toAnnouncement({ ...rows[0], supervisor_name: req.user.member_code }));
  })
);

router.delete(
  "/announcements/:announcementId",
  asyncRoute(async (req, res, db) => {
    const { affectedRows } = await db.query("DELETE FROM announcements WHERE id = ? AND supervisor_id = ?", [
      req.params.announcementId,
      req.user.id,
    ]);
    if (!affectedRows) return res.status(404).json({ error: "Announcement not found" });
    res.json({ success: true });
  })
);

// GET /api/supervisor/schedule
router.get(
  "/schedule",
  asyncRoute(async (req, res, db) => {
    const { rows } = await db.query(
      `SELECT s.id, s.session_type, s.title, s.session_date AS date, s.session_time AS time,
              s.duration_minutes, st.full_name AS student_name, uc.member_code AS student_code
       FROM sessions s
       JOIN students st ON st.id = s.student_id
       JOIN user_credentials uc ON uc.id = s.student_id
       WHERE s.supervisor_id = ? AND s.session_date >= CURRENT_DATE
       ORDER BY s.session_date ASC, (s.session_time IS NULL), s.session_time ASC`,
      [req.user.id]
    );

    const todayStr = new Date().toISOString().slice(0, 10);
    const today = [];
    const upcoming = [];
    for (const r of rows) {
      const item = {
        id: r.id,
        studentName: r.student_name,
        studentCode: r.student_code,
        recordType: r.session_type === "training" ? "training_session" : "supervision_session",
        date: r.date,
        time: r.time,
        durationMinutes: r.duration_minutes,
        title: r.title,
      };
      (String(r.date) === todayStr ? today : upcoming).push(item);
    }

    res.json({ today, upcoming: upcoming.slice(0, 10) });
  })
);

// GET /api/supervisor/activity
router.get(
  "/activity",
  asyncRoute(async (req, res, db) => {
    const { rows } = await db.query(
      `SELECT al.action, al.created_at, st.full_name AS student_name
       FROM audit_logs al
       JOIN students st ON st.id = al.entity_id
       WHERE al.actor_id = ? AND al.entity_type IN (
         'attendance','training_session','supervision_session','training_hours','supervision_hours','assignment','note','evaluation'
       )
       ORDER BY al.created_at DESC LIMIT 15`,
      [req.user.id]
    );
    res.json({
      activity: rows.map((r) => ({ action: r.action, studentName: r.student_name, createdAt: r.created_at })),
    });
  })
);

// ---- Meetings ------------------------------------------------------------

function toMeeting(row) {
  return {
    id: row.id,
    title: row.title,
    platform: row.platform,
    meetingUrl: row.meeting_url,
    scheduledAt: row.scheduled_at,
    durationMinutes: row.duration_minutes,
    studentId: row.student_id,
    studentName: row.student_name || null,
    createdAt: row.created_at,
  };
}

// GET /api/supervisor/meetings
router.get(
  "/meetings",
  asyncRoute(async (req, res, db) => {
    const { rows } = await db.query(
      `SELECT m.*, st.full_name AS student_name FROM meetings m
       LEFT JOIN students st ON st.id = m.student_id
       WHERE m.supervisor_id = ?
       ORDER BY (m.scheduled_at IS NULL), m.scheduled_at ASC`,
      [req.user.id]
    );
    res.json({ meetings: rows.map(toMeeting) });
  })
);

// POST /api/supervisor/meetings  { title, studentId, platform, meetingUrl, scheduledAt, durationMinutes }
router.post(
  "/meetings",
  asyncRoute(async (req, res, db) => {
    const { title, studentId, platform, meetingUrl, scheduledAt, durationMinutes } = req.body || {};
    if (!title || !meetingUrl) return res.status(400).json({ error: "title and meetingUrl are required" });
    if (!["zoom", "teams", "meet", "other"].includes(platform)) {
      return res.status(400).json({ error: "platform must be one of: zoom, teams, meet, other" });
    }

    if (studentId) {
      const { rows: assignRows } = await db.query(
        "SELECT 1 FROM supervisor_students WHERE supervisor_id = ? AND student_id = ?",
        [req.user.id, studentId]
      );
      if (!assignRows.length) return res.status(403).json({ error: "You are not assigned to this trainee" });
    }

    const insert = await db.query(
      `INSERT INTO meetings (supervisor_id, student_id, title, platform, meeting_url, scheduled_at, duration_minutes)
       VALUES (?,?,?,?,?,?,?)`,
      [req.user.id, studentId || null, title, platform, meetingUrl, scheduledAt || null, durationMinutes || null]
    );
    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES (?, 'meeting scheduled', 'meetings', ?)",
      [req.user.id, insert.insertId]
    );
    const { rows } = await db.query("SELECT * FROM meetings WHERE id = ?", [insert.insertId]);
    res.status(201).json(toMeeting(rows[0]));
  })
);

// PUT /api/supervisor/meetings/:id
router.put(
  "/meetings/:id",
  asyncRoute(async (req, res, db) => {
    const meetingId = req.params.id;
    const { rows: existingRows } = await db.query("SELECT * FROM meetings WHERE id = ? AND supervisor_id = ?", [
      meetingId,
      req.user.id,
    ]);
    if (!existingRows.length) return res.status(404).json({ error: "Meeting not found" });

    const { title, studentId, platform, meetingUrl, scheduledAt, durationMinutes } = req.body || {};
    await db.query(
      `UPDATE meetings SET
        title = COALESCE(?, title), student_id = ?, platform = COALESCE(?, platform),
        meeting_url = COALESCE(?, meeting_url), scheduled_at = COALESCE(?, scheduled_at),
        duration_minutes = COALESCE(?, duration_minutes), updated_at = NOW()
       WHERE id = ?`,
      [
        title ?? null,
        studentId !== undefined ? studentId || null : existingRows[0].student_id,
        platform ?? null,
        meetingUrl ?? null,
        scheduledAt ?? null,
        durationMinutes ?? null,
        meetingId,
      ]
    );
    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, old_values) VALUES (?, 'meeting updated', 'meetings', ?, ?)",
      [req.user.id, meetingId, JSON.stringify(existingRows[0])]
    );
    const { rows } = await db.query("SELECT * FROM meetings WHERE id = ?", [meetingId]);
    res.json(toMeeting(rows[0]));
  })
);

// DELETE /api/supervisor/meetings/:id
router.delete(
  "/meetings/:id",
  asyncRoute(async (req, res, db) => {
    const { rows: existingRows } = await db.query("SELECT * FROM meetings WHERE id = ? AND supervisor_id = ?", [
      req.params.id,
      req.user.id,
    ]);
    if (!existingRows.length) return res.status(404).json({ error: "Meeting not found" });

    await db.query("DELETE FROM meetings WHERE id = ?", [req.params.id]);
    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, old_values) VALUES (?, 'meeting deleted', 'meetings', ?, ?)",
      [req.user.id, req.params.id, JSON.stringify(existingRows[0])]
    );
    res.json({ success: true });
  })
);

// ---- Calendar events -------------------------------------------------
// Standalone events (holidays, reminders, custom entries) distinct from
// sessions/meetings, which already appear on the calendar via /schedule
// and /meetings without needing a calendar_events row.

function toCalendarEvent(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    eventType: row.event_type,
    date: row.event_date,
    time: row.event_time,
    studentId: row.student_id,
    studentName: row.student_name || null,
    createdAt: row.created_at,
  };
}

// GET /api/supervisor/calendar-events?start=YYYY-MM-DD&end=YYYY-MM-DD
router.get(
  "/calendar-events",
  asyncRoute(async (req, res, db) => {
    const { start, end } = req.query;
    const params = [req.user.id];
    let dateFilter = "";
    if (start && end) {
      params.push(start, end);
      dateFilter = `AND ce.event_date BETWEEN ? AND ?`;
    }
    const { rows } = await db.query(
      `SELECT ce.*, st.full_name AS student_name FROM calendar_events ce
       LEFT JOIN students st ON st.id = ce.student_id
       WHERE ce.owner_id = ? ${dateFilter}
       ORDER BY ce.event_date ASC, (ce.event_time IS NULL), ce.event_time ASC`,
      params
    );
    res.json({ events: rows.map(toCalendarEvent) });
  })
);

// POST /api/supervisor/calendar-events  { title, description, date, time, studentId, eventType }
router.post(
  "/calendar-events",
  asyncRoute(async (req, res, db) => {
    const { title, description, date, time, studentId, eventType } = req.body || {};
    if (!title || !date) return res.status(400).json({ error: "title and date are required" });

    const type = ["session", "meeting", "assignment_deadline", "custom", "holiday"].includes(eventType)
      ? eventType
      : "custom";

    if (studentId) {
      const { rows: assignRows } = await db.query(
        "SELECT 1 FROM supervisor_students WHERE supervisor_id = ? AND student_id = ?",
        [req.user.id, studentId]
      );
      if (!assignRows.length) return res.status(403).json({ error: "You are not assigned to this trainee" });
    }

    const insert = await db.query(
      `INSERT INTO calendar_events (owner_id, student_id, event_type, title, description, event_date, event_time)
       VALUES (?,?,?,?,?,?,?)`,
      [req.user.id, studentId || null, type, title, description || null, date, time || null]
    );
    const { rows } = await db.query("SELECT * FROM calendar_events WHERE id = ?", [insert.insertId]);
    res.status(201).json(toCalendarEvent(rows[0]));
  })
);

// PUT /api/supervisor/calendar-events/:id
router.put(
  "/calendar-events/:id",
  asyncRoute(async (req, res, db) => {
    const eventId = req.params.id;
    const { rows: existingRows } = await db.query(
      "SELECT * FROM calendar_events WHERE id = ? AND owner_id = ?",
      [eventId, req.user.id]
    );
    if (!existingRows.length) return res.status(404).json({ error: "Event not found" });

    const { title, description, date, time } = req.body || {};
    await db.query(
      `UPDATE calendar_events SET
        title = COALESCE(?, title), description = COALESCE(?, description),
        event_date = COALESCE(?, event_date), event_time = COALESCE(?, event_time)
       WHERE id = ?`,
      [title ?? null, description ?? null, date ?? null, time ?? null, eventId]
    );
    const { rows } = await db.query("SELECT * FROM calendar_events WHERE id = ?", [eventId]);
    res.json(toCalendarEvent(rows[0]));
  })
);

// DELETE /api/supervisor/calendar-events/:id
router.delete(
  "/calendar-events/:id",
  asyncRoute(async (req, res, db) => {
    const { affectedRows } = await db.query("DELETE FROM calendar_events WHERE id = ? AND owner_id = ?", [
      req.params.id,
      req.user.id,
    ]);
    if (!affectedRows) return res.status(404).json({ error: "Event not found" });
    res.json({ success: true });
  })
);


module.exports = router;
