const express = require("express");
const { requireAuth, asyncRoute } = require("../middleware/auth");
const {
  toProfileResponse,
  toRecord,
  toDocument,
  toMessage,
  toMaterial,
  toAnnouncement,
  toPaymentSummary,
  toPaymentTransaction,
  computeProgressSummary,
} = require("../utils/serializers");
const { hashPassword, verifyPassword } = require("../utils/authUtils");
const { photoUpload, cvUpload, submissionUpload } = require("../utils/uploads");
const { buildRecordsQuery } = require("../utils/recordsQuery");

const router = express.Router();

router.use(requireAuth);

// Works for any role -- admin, supervisor, and student dashboards all
// call GET/PUT /profile/me, so this is intentionally generic rather than
// three separate role-specific endpoints (see routes/admin.js -- an
// earlier /admin/me duplicated this; removed in favor of this one).
const PROFILE_SELECT = `
  SELECT
    uc.id, uc.member_code, uc.role, uc.status, uc.must_change_password,
    uc.created_at, uc.updated_at,
    COALESCE(a.full_name, sup.full_name, st.full_name) AS full_name,
    COALESCE(a.email, sup.email, st.email) AS email,
    COALESCE(a.phone, sup.phone, st.phone) AS phone,
    COALESCE(a.photo, sup.photo, st.photo) AS photo,
    st.gender, st.date_of_birth, st.marital_status, st.address,
    st.highest_degree, st.institution, st.certifications, st.cv_file,
    st.cohort_id, c.name AS cohort_name, st.current_year,
    sup.specialization, sup.bio
  FROM user_credentials uc
  LEFT JOIN admin_users a ON a.id = uc.id
  LEFT JOIN supervisors sup ON sup.id = uc.id
  LEFT JOIN students st ON st.id = uc.id
  LEFT JOIN cohorts c ON c.id = st.cohort_id
  WHERE uc.id = $1
`;

function requireStudent(req, res, next) {
  if (req.user.role !== "trainee") {
    return res.status(403).json({ error: "This endpoint is only available to student accounts" });
  }
  next();
}

// GET /api/profile/me
router.get(
  "/me",
  asyncRoute(async (req, res, db) => {
    const { rows } = await db.query(PROFILE_SELECT, [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: "Profile not found" });

    const profile = toProfileResponse(rows[0]);

    if (req.user.role === "trainee") {
      const { rows: supRows } = await db.query(
        `SELECT sup.id, sup.full_name FROM supervisor_students ss
         JOIN supervisors sup ON sup.id = ss.supervisor_id
         WHERE ss.student_id = $1 ORDER BY sup.full_name`,
        [req.user.id]
      );
      profile.supervisors = supRows.map((r) => ({ id: r.id, full_name: r.full_name }));
    }

    res.json(profile);
  })
);

// PUT /api/profile/me — only self-editable fields. member_code, role,
// status, cohort, currentYear, and supervisor assignments are
// admin/supervisor-managed, not editable here.
router.put(
  "/me",
  asyncRoute(async (req, res, db) => {
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

    const table = req.user.role === "trainee" ? "students" : req.user.role === "supervisor" ? "supervisors" : "admin_users";

    if (email) {
      const { rows: existing } = await db.query(`SELECT id FROM ${table} WHERE email = $1 AND id != $2`, [
        email,
        req.user.id,
      ]);
      if (existing.length) return res.status(409).json({ error: "That email is already in use" });
    }

    if (table === "students") {
      await db.query(
        `UPDATE students SET
          full_name = $1, email = $2, gender = $3, date_of_birth = $4, marital_status = $5,
          phone = $6, address = $7, highest_degree = $8, institution = $9, certifications = $10,
          updated_at = now()
         WHERE id = $11`,
        [
          full_name.trim(),
          email || null,
          gender || null,
          dateOfBirth || null,
          maritalStatus || null,
          phone || null,
          address || null,
          highestDegree || null,
          institution || null,
          certifications || null,
          req.user.id,
        ]
      );
    } else if (table === "supervisors") {
      await db.query(
        `UPDATE supervisors SET full_name = $1, email = $2, phone = $3, updated_at = now() WHERE id = $4`,
        [full_name.trim(), email || null, phone || null, req.user.id]
      );
    } else {
      await db.query(`UPDATE admin_users SET full_name = $1, email = $2, phone = $3, updated_at = now() WHERE id = $4`, [
        full_name.trim(),
        email || null,
        phone || null,
        req.user.id,
      ]);
    }

    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES ($1, 'profile_updated', $2, $1)",
      [req.user.id, table]
    );

    const { rows } = await db.query(PROFILE_SELECT, [req.user.id]);
    res.json(toProfileResponse(rows[0]));
  })
);

// POST /api/profile/change-password  { currentPassword, newPassword }
// (Also available at /api/auth/change-password -- kept here too since the
// existing dashboards already call this path.)
router.post(
  "/change-password",
  asyncRoute(async (req, res, db) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "Current and new password are required" });
    }
    if (String(newPassword).length < 8) {
      return res.status(400).json({ error: "New password must be at least 8 characters" });
    }

    const { rows } = await db.query("SELECT password_hash FROM user_credentials WHERE id = $1", [req.user.id]);
    if (!(await verifyPassword(currentPassword, rows[0].password_hash))) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }

    const newHash = await hashPassword(newPassword);
    await db.query(
      "UPDATE user_credentials SET password_hash = $1, must_change_password = FALSE, updated_at = now() WHERE id = $2",
      [newHash, req.user.id]
    );
    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES ($1, 'password_changed', 'user_credentials', $1)",
      [req.user.id]
    );

    res.json({ success: true, message: "Password updated successfully" });
  })
);

// POST /api/profile/photo  (multipart, field "photo") -- any role
router.post("/photo", requireAuth, (req, res) => {
  photoUpload.single("photo")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No photo uploaded" });

    const table = req.user.role === "trainee" ? "students" : req.user.role === "supervisor" ? "supervisors" : "admin_users";
    const { pool } = require("../db");
    await pool.query(`UPDATE ${table} SET photo = $1, updated_at = now() WHERE id = $2`, [
      req.file.filename,
      req.user.id,
    ]);

    res.json({ success: true, photo: req.file.filename });
  });
});

// POST /api/profile/cv  (multipart, field "cv") -- students only
router.post("/cv", requireStudent, (req, res) => {
  cvUpload.single("cv")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No CV uploaded" });

    const { pool } = require("../db");
    await pool.query("UPDATE students SET cv_file = $1, updated_at = now() WHERE id = $2", [
      req.file.filename,
      req.user.id,
    ]);

    res.json({ success: true, cvFile: req.file.filename });
  });
});

// ---- Student Sub-resources -------------------------------------------

// POST /api/profile/records/:id/submission  (multipart, field "submission")
// The one previously-missing piece: a student submitting a file back for
// an assignment. :id is the assignment's real id in the `assignments`
// table (matches what /profile/records already returns for recordType
// === 'assignment'). Also flips the assignment's own status to
// 'submitted' so the supervisor sees it without any extra polling.
router.post("/records/:id/submission", requireStudent, (req, res) => {
  submissionUpload.single("submission")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const { pool } = require("../db");
    const assignmentId = req.params.id;

    try {
      const { rows: assignmentRows } = await pool.query(
        "SELECT id, student_id FROM assignments WHERE id = $1",
        [assignmentId]
      );
      if (!assignmentRows.length) {
        return res.status(404).json({ error: "Assignment not found" });
      }
      if (String(assignmentRows[0].student_id) !== String(req.user.id)) {
        return res.status(403).json({ error: "This assignment doesn't belong to you" });
      }

      const { rows } = await pool.query(
        `INSERT INTO assignment_submissions (assignment_id, student_id, filename, original_name, notes)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [assignmentId, req.user.id, req.file.filename, req.file.originalname, req.body?.notes || null]
      );

      await pool.query("UPDATE assignments SET status = 'submitted', updated_at = now() WHERE id = $1", [
        assignmentId,
      ]);

      await pool.query(
        "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES ($1, 'assignment_submitted', 'assignment_submissions', $2)",
        [req.user.id, rows[0].id]
      );

      res.status(201).json({
        success: true,
        submission: {
          id: rows[0].id,
          filename: rows[0].filename,
          originalName: rows[0].original_name,
          submittedAt: rows[0].submitted_at,
          status: rows[0].status,
        },
      });
    } catch (e) {
      res.status(500).json({ error: "Internal server error" });
    }
  });
});

// GET /api/profile/records?type=attendance
router.get(
  "/records",
  requireStudent,
  asyncRoute(async (req, res, db) => {
    const { type, supervisorId } = req.query;
    const params = type ? [req.user.id, type] : [req.user.id];
    let query = buildRecordsQuery(type);
    if (supervisorId) {
      // Wrap the UNION query and filter by supervisor -- keeps
      // buildRecordsQuery() itself untouched for the other callers
      // (supervisor.js) that don't need this filter. Re-apply ORDER BY
      // on the outer query since ordering inside a subquery isn't
      // guaranteed to survive without it.
      query = `SELECT * FROM (${query}) AS filtered WHERE supervisor_id = $${params.length + 1} ORDER BY record_date DESC NULLS LAST`;
      params.push(supervisorId);
    }
    const { rows } = await db.query(query, params);

    // Attach supervisor names (the UNION query only carries supervisor_id)
    const supIds = [...new Set(rows.map((r) => r.supervisor_id))];
    const names = {};
    if (supIds.length) {
      const { rows: supRows } = await db.query(
        `SELECT id, full_name FROM supervisors WHERE id = ANY($1)`,
        [supIds]
      );
      supRows.forEach((r) => (names[r.id] = r.full_name));
    }

    res.json({ records: rows.map((r) => toRecord({ ...r, supervisor_name: names[r.supervisor_id] })) });
  })
);

// GET /api/profile/progress
router.get(
  "/progress",
  requireStudent,
  asyncRoute(async (req, res, db) => {
    res.json(await computeProgressSummary(db, req.user.id));
  })
);

// GET /api/profile/documents
router.get(
  "/documents",
  requireStudent,
  asyncRoute(async (req, res, db) => {
    const { supervisorId } = req.query;
    const params = [req.user.id];
    let filter = "";
    if (supervisorId) {
      params.push(supervisorId);
      filter = `AND d.uploaded_by = $2`;
    }
    const { rows } = await db.query(
      `SELECT d.*, COALESCE(a.full_name, sup.full_name) AS uploaded_by_name
       FROM documents d
       JOIN user_credentials uc ON uc.id = d.uploaded_by
       LEFT JOIN admin_users a ON a.id = d.uploaded_by
       LEFT JOIN supervisors sup ON sup.id = d.uploaded_by
       WHERE d.student_id = $1 ${filter} ORDER BY d.created_at DESC`,
      params
    );
    res.json({ documents: rows.map(toDocument) });
  })
);

// ---- Messages (per-supervisor chat thread) ------------------------------

async function getOrCreateChat(db, supervisorId, studentId) {
  const { rows } = await db.query(
    "SELECT id FROM chats WHERE supervisor_id = $1 AND student_id = $2",
    [supervisorId, studentId]
  );
  if (rows.length) return rows[0].id;
  const created = await db.query(
    "INSERT INTO chats (supervisor_id, student_id) VALUES ($1, $2) RETURNING id",
    [supervisorId, studentId]
  );
  return created.rows[0].id;
}

// GET /api/profile/messages/:supervisorId
router.get(
  "/messages/:supervisorId",
  requireStudent,
  asyncRoute(async (req, res, db) => {
    const supervisorId = Number(req.params.supervisorId);
    const chatId = await getOrCreateChat(db, supervisorId, req.user.id);
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

// POST /api/profile/messages/:supervisorId  { content }
router.post(
  "/messages/:supervisorId",
  requireStudent,
  asyncRoute(async (req, res, db) => {
    const supervisorId = Number(req.params.supervisorId);
    const { content } = req.body || {};
    if (!content || !String(content).trim()) {
      return res.status(400).json({ error: "Message content is required" });
    }

    const { rows: supRows } = await db.query("SELECT id FROM supervisors WHERE id = $1", [supervisorId]);
    if (!supRows.length) return res.status(404).json({ error: "Supervisor not found" });

    const chatId = await getOrCreateChat(db, supervisorId, req.user.id);
    const { rows } = await db.query(
      "INSERT INTO messages (chat_id, sender_id, content) VALUES ($1, $2, $3) RETURNING *",
      [chatId, req.user.id, content.trim()]
    );
    await db.query("UPDATE chats SET last_message_at = now() WHERE id = $1", [chatId]);

    res.status(201).json(toMessage({ ...rows[0], sender_name: req.user.member_code }, req.user.id));
  })
);

// GET /api/profile/materials-feed
router.get(
  "/materials-feed",
  requireStudent,
  asyncRoute(async (req, res, db) => {
    const { supervisorId } = req.query;
    const params = [req.user.id];
    let filter = "";
    if (supervisorId) {
      params.push(supervisorId);
      filter = "AND lm.supervisor_id = $2";
    }
    const { rows } = await db.query(
      `SELECT lm.*, sup.full_name AS supervisor_name FROM learning_materials lm
       JOIN supervisors sup ON sup.id = lm.supervisor_id
       WHERE lm.supervisor_id IN (SELECT supervisor_id FROM supervisor_students WHERE student_id = $1)
         AND (lm.student_id IS NULL OR lm.student_id = $1)
         ${filter}
       ORDER BY lm.created_at DESC`,
      params
    );
    res.json({ materials: rows.map(toMaterial) });
  })
);

// GET /api/profile/announcements
router.get(
  "/announcements",
  requireStudent,
  asyncRoute(async (req, res, db) => {
    const { supervisorId } = req.query;
    const params = [req.user.id];
    let filter = "";
    if (supervisorId) {
      params.push(supervisorId);
      filter = "AND a.supervisor_id = $2";
    }
    const { rows } = await db.query(
      `SELECT a.*, sup.full_name AS supervisor_name FROM announcements a
       JOIN supervisors sup ON sup.id = a.supervisor_id
       WHERE a.supervisor_id IN (SELECT supervisor_id FROM supervisor_students WHERE student_id = $1)
         AND (a.cohort_id IS NULL OR a.cohort_id = (SELECT cohort_id FROM students WHERE id = $1))
         ${filter}
       ORDER BY a.created_at DESC`,
      params
    );
    res.json({ announcements: rows.map(toAnnouncement) });
  })
);

// GET /api/profile/payments — my own summary + history, read-only.
// Runs through the RLS-context-setting transactional client, same as
// the Admin payments routes -- the "student_id = current_user_id" policy
// is what actually restricts this to the caller's own row.
router.get(
  "/payments",
  requireStudent,
  asyncRoute(async (req, res, db) => {
    const { rows: paymentsRows } = await db.query("SELECT * FROM payments WHERE student_id = $1", [req.user.id]);
    const { rows: transactions } = await db.query(
      `SELECT pt.*, COALESCE(a.full_name, sup.full_name) AS added_by_name FROM payment_transactions pt
       LEFT JOIN admin_users a ON a.id = pt.added_by
       LEFT JOIN supervisors sup ON sup.id = pt.added_by
       WHERE pt.student_id = $1 ORDER BY pt.payment_date DESC, pt.created_at DESC`,
      [req.user.id]
    );

    res.json({
      summary: toPaymentSummary({ id: req.user.id }, paymentsRows[0] || null, transactions),
      transactions: transactions.map(toPaymentTransaction),
    });
  })
);

// GET /api/profile/activity
router.get(
  "/activity",
  asyncRoute(async (req, res, db) => {
    const { rows } = await db.query(
      "SELECT action, created_at FROM audit_logs WHERE actor_id = $1 ORDER BY created_at DESC LIMIT 20",
      [req.user.id]
    );
    res.json(rows);
  })
);

// GET /api/profile/meetings -- meetings assigned to me (either targeted
// at me specifically, or shared with my whole caseload by a supervisor
// I'm actually assigned to).
router.get(
  "/meetings",
  requireStudent,
  asyncRoute(async (req, res, db) => {
    const { supervisorId } = req.query;
    const params = [req.user.id];
    let filter = "";
    if (supervisorId) {
      params.push(supervisorId);
      filter = "AND m.supervisor_id = $2";
    }
    const { rows } = await db.query(
      `SELECT m.* FROM meetings m
       WHERE m.supervisor_id IN (SELECT supervisor_id FROM supervisor_students WHERE student_id = $1)
         AND (m.student_id IS NULL OR m.student_id = $1)
         ${filter}
       ORDER BY m.scheduled_at ASC NULLS LAST`,
      params
    );
    res.json({
      meetings: rows.map((r) => ({
        id: r.id,
        title: r.title,
        platform: r.platform,
        meetingUrl: r.meeting_url,
        scheduledAt: r.scheduled_at,
        durationMinutes: r.duration_minutes,
      })),
    });
  })
);

module.exports = router;