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
  WHERE uc.id = $1
`;

/** Confirms studentId is currently assigned to the calling supervisor and returns their row, or writes a 403/404 and returns null. */
async function loadAssignedStudent(db, supervisorId, studentId, res) {
  const { rows: assignRows } = await db.query(
    "SELECT 1 FROM supervisor_students WHERE supervisor_id = $1 AND student_id = $2",
    [supervisorId, studentId]
  );
  if (!assignRows.length) {
    res.status(403).json({ error: "You are not assigned to this student" });
    return null;
  }
  const { rows } = await db.query(STUDENT_PROFILE_SELECT, [studentId]);
  if (!rows.length) {
    res.status(404).json({ error: "Student not found" });
    return null;
  }
  return rows[0];
}

async function attachSupervisorNames(db, rows) {
  const supIds = [...new Set(rows.map((r) => r.supervisor_id))];
  if (!supIds.length) return rows;
  const { rows: supRows } = await db.query("SELECT id, full_name FROM supervisors WHERE id = ANY($1)", [supIds]);
  const names = {};
  supRows.forEach((r) => (names[r.id] = r.full_name));
  return rows.map((r) => ({ ...r, supervisor_name: names[r.supervisor_id] }));
}

// ---- Students -----------------------------------------------------------

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
       WHERE ss.supervisor_id = $1
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
      return res.status(400).json({ error: "Student ID is required" });
    }

    const { rows: studentRows } = await db.query(
      `SELECT uc.id, uc.member_code, uc.status, st.full_name, st.current_year, c.name AS cohort_name
       FROM user_credentials uc JOIN students st ON st.id = uc.id LEFT JOIN cohorts c ON c.id = st.cohort_id
       WHERE uc.member_code = $1`,
      [String(studentCode).trim().toUpperCase()]
    );
    if (!studentRows.length) {
      return res.status(404).json({ error: "This Student ID does not exist. Please contact the Administrator." });
    }
    const student = studentRows[0];

    await db.query(
      "INSERT INTO supervisor_students (supervisor_id, student_id, assigned_by) VALUES ($1, $2, $1) ON CONFLICT DO NOTHING",
      [req.user.id, student.id]
    );
    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES ($1, 'supervisor_assigned', 'supervisor_students', $2)",
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

    await db.query("DELETE FROM supervisor_students WHERE supervisor_id = $1 AND student_id = $2", [
      req.user.id,
      studentId,
    ]);
    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES ($1, 'supervisor_unassigned', 'supervisor_students', $2)",
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

    const { rows: recordRows } = await db.query(buildRecordsQuery(null), [studentId]);
    const records = await attachSupervisorNames(db, recordRows);

    const { rows: documents } = await db.query(
      `SELECT d.*, COALESCE(a.full_name, sup.full_name) AS uploaded_by_name FROM documents d
       LEFT JOIN admin_users a ON a.id = d.uploaded_by
       LEFT JOIN supervisors sup ON sup.id = d.uploaded_by
       WHERE d.student_id = $1 ORDER BY d.created_at DESC`,
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
        const { rows } = await db.query(
          `INSERT INTO sessions (student_id, supervisor_id, session_type, title, session_date, session_time, duration_minutes, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [studentId, req.user.id, sessionType, title || null, date || null, time || null, durationMinutes || null, content || null]
        );
        insertedId = rows[0].id;
        break;
      }
      case "attendance": {
        if (!["present", "absent", "excused"].includes(status)) {
          return res.status(400).json({ error: "attendance requires status: present, absent, or excused" });
        }
        const { rows } = await db.query(
          `INSERT INTO attendance (student_id, supervisor_id, attendance_date, status, notes, recorded_by)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [studentId, req.user.id, date || null, status, content || null, req.user.id]
        );
        insertedId = rows[0].id;
        break;
      }
      case "training_hours":
      case "supervision_hours": {
        const table = recordType;
        const hours = durationMinutes ? Number(durationMinutes) / 60 : 0;
        const { rows } = await db.query(
          `INSERT INTO ${table} (student_id, supervisor_id, hours, hour_date, description) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [studentId, req.user.id, hours, date || null, content || null]
        );
        insertedId = rows[0].id;
        break;
      }
      case "assignment": {
        const { rows } = await db.query(
          `INSERT INTO assignments (student_id, supervisor_id, title, description, due_date, status)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [studentId, req.user.id, title || "Untitled assignment", content || null, date || null, status || "pending"]
        );
        insertedId = rows[0].id;
        break;
      }
      case "note": {
        const { rows } = await db.query(
          `INSERT INTO supervisor_notes (student_id, supervisor_id, note_date, content) VALUES ($1,$2,$3,$4) RETURNING id`,
          [studentId, req.user.id, date || null, content || ""]
        );
        insertedId = rows[0].id;
        break;
      }
      case "evaluation": {
        const { rows } = await db.query(
          `INSERT INTO evaluations (student_id, supervisor_id, evaluation_date, title, score, content)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [studentId, req.user.id, date || null, title || null, score ?? null, content || null]
        );
        insertedId = rows[0].id;
        break;
      }
    }

    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, new_values) VALUES ($1, $2, $3, $4, $5)",
      [
        req.user.id,
        `${recordType.replace(/_/g, " ")} added`,
        recordType,
        studentId,
        JSON.stringify({ recordId: insertedId }),
      ]
    );

    const { rows: freshRows } = await db.query(buildRecordsQuery(recordType), [studentId, recordType]);
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

    const { rows: existingRows } = await db.query(`SELECT * FROM ${meta.table} WHERE id = $1`, [recordId]);
    const existing = existingRows[0];
    if (!existing) return res.status(404).json({ error: "Record not found" });

    const { rows: assignRows } = await db.query(
      "SELECT 1 FROM supervisor_students WHERE supervisor_id = $1 AND student_id = $2",
      [req.user.id, existing.student_id]
    );
    if (!assignRows.length) return res.status(403).json({ error: "You are not assigned to this student" });

    const { date, time, durationMinutes, status, title, content, score } = req.body || {};

    if (recordType === "training_session" || recordType === "supervision_session") {
      await db.query(
        `UPDATE sessions SET
          session_date = COALESCE($1, session_date), session_time = COALESCE($2, session_time),
          duration_minutes = COALESCE($3, duration_minutes), title = COALESCE($4, title),
          notes = COALESCE($5, notes), updated_at = now()
         WHERE id = $6`,
        [date ?? null, time ?? null, durationMinutes ?? null, title ?? null, content ?? null, recordId]
      );
    } else if (recordType === "attendance") {
      await db.query(
        `UPDATE attendance SET attendance_date = COALESCE($1, attendance_date), status = COALESCE($2, status), notes = COALESCE($3, notes) WHERE id = $4`,
        [date ?? null, status ?? null, content ?? null, recordId]
      );
    } else if (recordType === "training_hours" || recordType === "supervision_hours") {
      const hours = durationMinutes != null ? Number(durationMinutes) / 60 : null;
      await db.query(
        `UPDATE ${meta.table} SET hour_date = COALESCE($1, hour_date), hours = COALESCE($2, hours), description = COALESCE($3, description) WHERE id = $4`,
        [date ?? null, hours, content ?? null, recordId]
      );
    } else if (recordType === "assignment") {
      await db.query(
        `UPDATE assignments SET due_date = COALESCE($1, due_date), status = COALESCE($2, status), title = COALESCE($3, title), description = COALESCE($4, description), updated_at = now() WHERE id = $5`,
        [date ?? null, status ?? null, title ?? null, content ?? null, recordId]
      );
    } else if (recordType === "note") {
      await db.query(
        `UPDATE supervisor_notes SET note_date = COALESCE($1, note_date), content = COALESCE($2, content), updated_at = now() WHERE id = $3`,
        [date ?? null, content ?? null, recordId]
      );
    } else if (recordType === "evaluation") {
      await db.query(
        `UPDATE evaluations SET evaluation_date = COALESCE($1, evaluation_date), title = COALESCE($2, title), score = COALESCE($3, score), content = COALESCE($4, content), updated_at = now() WHERE id = $5`,
        [date ?? null, title ?? null, score ?? null, content ?? null, recordId]
      );
    }

    const { rows: freshRows } = await db.query(buildRecordsQuery(recordType), [existing.student_id, recordType]);
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

    const { rows: existingRows } = await db.query(`SELECT student_id FROM ${meta.table} WHERE id = $1`, [recordId]);
    if (!existingRows.length) return res.status(404).json({ error: "Record not found" });

    const { rows: assignRows } = await db.query(
      "SELECT 1 FROM supervisor_students WHERE supervisor_id = $1 AND student_id = $2",
      [req.user.id, existingRows[0].student_id]
    );
    if (!assignRows.length) return res.status(403).json({ error: "You are not assigned to this student" });

    await db.query(`DELETE FROM ${meta.table} WHERE id = $1`, [recordId]);
    res.json({ success: true });
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
      "SELECT 1 FROM supervisor_students WHERE supervisor_id = $1 AND student_id = $2",
      [req.user.id, studentId]
    );
    if (!assigned.rows.length) return res.status(403).json({ error: "You are not assigned to this student" });

    const { rows } = await pool.query(
      `INSERT INTO documents (student_id, uploaded_by, filename, original_name) VALUES ($1,$2,$3,$4)
       RETURNING *`,
      [studentId, req.user.id, req.file.filename, req.file.originalname]
    );

    res.status(201).json(toDocument({ ...rows[0], uploaded_by_name: req.user.member_code }));
  });
});

// ---- Messages --------------------------------------------------------

async function getOrCreateChat(db, supervisorId, studentId) {
  const { rows } = await db.query("SELECT id FROM chats WHERE supervisor_id = $1 AND student_id = $2", [
    supervisorId,
    studentId,
  ]);
  if (rows.length) return rows[0].id;
  const created = await db.query("INSERT INTO chats (supervisor_id, student_id) VALUES ($1, $2) RETURNING id", [
    supervisorId,
    studentId,
  ]);
  return created.rows[0].id;
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
       WHERE m.chat_id = $1 ORDER BY m.created_at ASC`,
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
    const { rows } = await db.query(
      "INSERT INTO messages (chat_id, sender_id, content) VALUES ($1, $2, $3) RETURNING *",
      [chatId, req.user.id, content.trim()]
    );
    await db.query("UPDATE chats SET last_message_at = now() WHERE id = $1", [chatId]);

    res.status(201).json(toMessage({ ...rows[0], sender_name: req.user.member_code }, req.user.id));
  })
);

// ---- Learning materials --------------------------------------------------

router.get(
  "/materials",
  asyncRoute(async (req, res, db) => {
    const { rows } = await db.query(
      "SELECT * FROM learning_materials WHERE supervisor_id = $1 ORDER BY created_at DESC",
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

      const { rows } = await pool.query(
        `INSERT INTO learning_materials (supervisor_id, student_id, title, description, material_type, filename, original_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [req.user.id, studentId || null, title, description || null, materialType, req.file.filename, req.file.originalname]
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
    const { rows } = await pool.query(
      `INSERT INTO learning_materials (supervisor_id, student_id, title, description, material_type, external_url)
       VALUES ($1,$2,$3,$4,'link',$5) RETURNING *`,
      [req.user.id, studentId || null, title, description || null, externalUrl]
    );
    res.status(201).json(toMaterial({ ...rows[0], supervisor_name: req.user.member_code }));
  })().catch((err) => res.status(500).json({ error: "Internal server error" }));
});

router.delete(
  "/materials/:materialId",
  asyncRoute(async (req, res, db) => {
    const { rowCount } = await db.query("DELETE FROM learning_materials WHERE id = $1 AND supervisor_id = $2", [
      req.params.materialId,
      req.user.id,
    ]);
    if (!rowCount) return res.status(404).json({ error: "Material not found" });
    res.json({ success: true });
  })
);

// ---- Announcements ---------------------------------------------------

router.get(
  "/announcements",
  asyncRoute(async (req, res, db) => {
    const { rows } = await db.query(
      "SELECT * FROM announcements WHERE supervisor_id = $1 ORDER BY created_at DESC",
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

    const { rows } = await db.query(
      "INSERT INTO announcements (supervisor_id, title, content) VALUES ($1, $2, $3) RETURNING *",
      [req.user.id, title, content]
    );
    res.status(201).json(toAnnouncement({ ...rows[0], supervisor_name: req.user.member_code }));
  })
);

router.delete(
  "/announcements/:announcementId",
  asyncRoute(async (req, res, db) => {
    const { rowCount } = await db.query("DELETE FROM announcements WHERE id = $1 AND supervisor_id = $2", [
      req.params.announcementId,
      req.user.id,
    ]);
    if (!rowCount) return res.status(404).json({ error: "Announcement not found" });
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
       WHERE s.supervisor_id = $1 AND s.session_date >= CURRENT_DATE
       ORDER BY s.session_date ASC, s.session_time ASC NULLS LAST`,
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
       WHERE al.actor_id = $1 AND al.entity_type IN (
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
       WHERE m.supervisor_id = $1
       ORDER BY m.scheduled_at ASC NULLS LAST`,
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
        "SELECT 1 FROM supervisor_students WHERE supervisor_id = $1 AND student_id = $2",
        [req.user.id, studentId]
      );
      if (!assignRows.length) return res.status(403).json({ error: "You are not assigned to this student" });
    }

    const { rows } = await db.query(
      `INSERT INTO meetings (supervisor_id, student_id, title, platform, meeting_url, scheduled_at, duration_minutes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.user.id, studentId || null, title, platform, meetingUrl, scheduledAt || null, durationMinutes || null]
    );
    res.status(201).json(toMeeting(rows[0]));
  })
);

// PUT /api/supervisor/meetings/:id
router.put(
  "/meetings/:id",
  asyncRoute(async (req, res, db) => {
    const meetingId = req.params.id;
    const { rows: existingRows } = await db.query("SELECT * FROM meetings WHERE id = $1 AND supervisor_id = $2", [
      meetingId,
      req.user.id,
    ]);
    if (!existingRows.length) return res.status(404).json({ error: "Meeting not found" });

    const { title, studentId, platform, meetingUrl, scheduledAt, durationMinutes } = req.body || {};
    const { rows } = await db.query(
      `UPDATE meetings SET
        title = COALESCE($1, title), student_id = $2, platform = COALESCE($3, platform),
        meeting_url = COALESCE($4, meeting_url), scheduled_at = COALESCE($5, scheduled_at),
        duration_minutes = COALESCE($6, duration_minutes), updated_at = now()
       WHERE id = $7 RETURNING *`,
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
    res.json(toMeeting(rows[0]));
  })
);

// DELETE /api/supervisor/meetings/:id
router.delete(
  "/meetings/:id",
  asyncRoute(async (req, res, db) => {
    const { rowCount } = await db.query("DELETE FROM meetings WHERE id = $1 AND supervisor_id = $2", [
      req.params.id,
      req.user.id,
    ]);
    if (!rowCount) return res.status(404).json({ error: "Meeting not found" });
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
      dateFilter = `AND ce.event_date BETWEEN $2 AND $3`;
    }
    const { rows } = await db.query(
      `SELECT ce.*, st.full_name AS student_name FROM calendar_events ce
       LEFT JOIN students st ON st.id = ce.student_id
       WHERE ce.owner_id = $1 ${dateFilter}
       ORDER BY ce.event_date ASC, ce.event_time ASC NULLS LAST`,
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
        "SELECT 1 FROM supervisor_students WHERE supervisor_id = $1 AND student_id = $2",
        [req.user.id, studentId]
      );
      if (!assignRows.length) return res.status(403).json({ error: "You are not assigned to this student" });
    }

    const { rows } = await db.query(
      `INSERT INTO calendar_events (owner_id, student_id, event_type, title, description, event_date, event_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.user.id, studentId || null, type, title, description || null, date, time || null]
    );
    res.status(201).json(toCalendarEvent(rows[0]));
  })
);

// PUT /api/supervisor/calendar-events/:id
router.put(
  "/calendar-events/:id",
  asyncRoute(async (req, res, db) => {
    const eventId = req.params.id;
    const { rows: existingRows } = await db.query(
      "SELECT * FROM calendar_events WHERE id = $1 AND owner_id = $2",
      [eventId, req.user.id]
    );
    if (!existingRows.length) return res.status(404).json({ error: "Event not found" });

    const { title, description, date, time } = req.body || {};
    const { rows } = await db.query(
      `UPDATE calendar_events SET
        title = COALESCE($1, title), description = COALESCE($2, description),
        event_date = COALESCE($3, event_date), event_time = COALESCE($4, event_time)
       WHERE id = $5 RETURNING *`,
      [title ?? null, description ?? null, date ?? null, time ?? null, eventId]
    );
    res.json(toCalendarEvent(rows[0]));
  })
);

// DELETE /api/supervisor/calendar-events/:id
router.delete(
  "/calendar-events/:id",
  asyncRoute(async (req, res, db) => {
    const { rowCount } = await db.query("DELETE FROM calendar_events WHERE id = $1 AND owner_id = $2", [
      req.params.id,
      req.user.id,
    ]);
    if (!rowCount) return res.status(404).json({ error: "Event not found" });
    res.json({ success: true });
  })
);


module.exports = router;