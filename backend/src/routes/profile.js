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
const { createNotification } = require("../utils/notifications");
const { ASSIGNMENT_WITH_SUBMISSION_SELECT, assignmentRowToApi } = require("../utils/assignmentsQuery");

const router = express.Router();

router.use(requireAuth);

// Works for any role -- admin, supervisor, trainee, and designer dashboards
// all call GET/PUT /profile/me, so this is intentionally generic rather
// than four separate role-specific endpoints (see routes/admin.js -- an
// earlier /admin/me duplicated this; removed in favor of this one).
const PROFILE_SELECT = `
  SELECT
    uc.id, uc.member_code, uc.role, uc.status, uc.must_change_password,
    uc.created_at, uc.updated_at,
    COALESCE(a.full_name, sup.full_name, st.full_name, d.full_name) AS full_name,
    COALESCE(a.email, sup.email, st.email, d.email) AS email,
    COALESCE(a.phone, sup.phone, st.phone, d.phone) AS phone,
    COALESCE(a.photo, sup.photo, st.photo, d.photo) AS photo,
    st.gender, st.date_of_birth, st.marital_status, st.address,
    st.highest_degree, st.institution, st.certifications, st.cv_file,
    st.cohort_id, c.name AS cohort_name, st.current_year,
    sup.specialization, sup.bio
  FROM user_credentials uc
  LEFT JOIN admin_users a ON a.id = uc.id
  LEFT JOIN supervisors sup ON sup.id = uc.id
  LEFT JOIN students st ON st.id = uc.id
  LEFT JOIN designers d ON d.id = uc.id
  LEFT JOIN cohorts c ON c.id = st.cohort_id
  WHERE uc.id = ?
`;

function requireStudent(req, res, next) {
  if (req.user.role !== "trainee") {
    return res.status(403).json({ error: "This endpoint is only available to trainee accounts" });
  }
  next();
}

/** Maps a role to its 1:1 profile-extension table. */
function profileTableForRole(role) {
  if (role === "trainee") return "students";
  if (role === "supervisor") return "supervisors";
  if (role === "designer") return "designers";
  return "admin_users";
}

/** Builds a `col IN (?,?,...)` fragment + matching params for a dynamic id list. */
function inClause(ids) {
  return { sql: ids.map(() => "?").join(","), params: ids };
}

// Attaches the trainee's real supervisor_students list to a profile object
// in place. toProfileResponse/toPublicUser always set `.supervisors` to []
// for a trainee (PROFILE_SELECT has no supervisors column to parse), so
// every route that returns a trainee profile must call this or the field
// silently reads as "Unassigned" -- this bit PUT /me until fixed here,
// wiping the Supervisor(s) field from the UI the instant a trainee saved
// their profile even though nothing about their assignment had changed.
async function attachTraineeSupervisors(db, profile, userId) {
  const { rows: supRows } = await db.query(
    `SELECT sup.id, sup.full_name FROM supervisor_students ss
     JOIN supervisors sup ON sup.id = ss.supervisor_id
     WHERE ss.student_id = ? ORDER BY sup.full_name`,
    [userId]
  );
  profile.supervisors = supRows.map((r) => ({ id: r.id, full_name: r.full_name }));
}

// GET /api/profile/me
router.get(
  "/me",
  asyncRoute(async (req, res, db) => {
    const { rows } = await db.query(PROFILE_SELECT, [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: "Profile not found" });

    const profile = toProfileResponse(rows[0]);
    if (req.user.role === "trainee") await attachTraineeSupervisors(db, profile, req.user.id);

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
      bio,
      specialization,
    } = req.body || {};

    if (!full_name || !String(full_name).trim()) {
      return res.status(400).json({ error: "Full name is required" });
    }

    const table = profileTableForRole(req.user.role);

    if (email) {
      const { rows: existing } = await db.query(`SELECT id FROM ${table} WHERE email = ? AND id != ?`, [
        email,
        req.user.id,
      ]);
      if (existing.length) return res.status(409).json({ error: "That email is already in use" });
    }

    if (table === "students") {
      await db.query(
        `UPDATE students SET
          full_name = ?, email = ?, gender = ?, date_of_birth = ?, marital_status = ?,
          phone = ?, address = ?, highest_degree = ?, institution = ?, certifications = ?,
          updated_at = NOW()
         WHERE id = ?`,
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
        `UPDATE supervisors SET full_name = ?, email = ?, phone = ?, bio = ?, specialization = ?, updated_at = NOW() WHERE id = ?`,
        [full_name.trim(), email || null, phone || null, bio || null, specialization || null, req.user.id]
      );
    } else if (table === "designers") {
      await db.query(
        `UPDATE designers SET full_name = ?, email = ?, phone = ?, updated_at = NOW() WHERE id = ?`,
        [full_name.trim(), email || null, phone || null, req.user.id]
      );
    } else {
      await db.query(`UPDATE admin_users SET full_name = ?, email = ?, phone = ?, updated_at = NOW() WHERE id = ?`, [
        full_name.trim(),
        email || null,
        phone || null,
        req.user.id,
      ]);
    }

    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES (?, 'profile_updated', ?, ?)",
      [req.user.id, table, req.user.id]
    );

    const { rows } = await db.query(PROFILE_SELECT, [req.user.id]);
    const profile = toProfileResponse(rows[0]);
    if (req.user.role === "trainee") await attachTraineeSupervisors(db, profile, req.user.id);
    res.json(profile);
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

    const { rows } = await db.query("SELECT password_hash FROM user_credentials WHERE id = ?", [req.user.id]);
    if (!(await verifyPassword(currentPassword, rows[0].password_hash))) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }

    const newHash = await hashPassword(newPassword);
    await db.query(
      "UPDATE user_credentials SET password_hash = ?, must_change_password = FALSE, updated_at = NOW() WHERE id = ?",
      [newHash, req.user.id]
    );
    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES (?, 'password_changed', 'user_credentials', ?)",
      [req.user.id, req.user.id]
    );

    res.json({ success: true, message: "Password updated successfully" });
  })
);

// POST /api/profile/photo  (multipart, field "photo") -- any role
router.post("/photo", requireAuth, (req, res) => {
  photoUpload.single("photo")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No photo uploaded" });

    const table = profileTableForRole(req.user.role);
    const { pool } = require("../db");
    await pool.query(`UPDATE ${table} SET photo = ?, updated_at = NOW() WHERE id = ?`, [
      req.file.filename,
      req.user.id,
    ]);

    res.json({ success: true, photo: req.file.filename });
  });
});

// POST /api/profile/cv  (multipart, field "cv") -- trainees only
router.post("/cv", requireStudent, (req, res) => {
  cvUpload.single("cv")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No CV uploaded" });

    const { pool } = require("../db");
    await pool.query("UPDATE students SET cv_file = ?, updated_at = NOW() WHERE id = ?", [
      req.file.filename,
      req.user.id,
    ]);

    res.json({ success: true, cvFile: req.file.filename });
  });
});

// ---- Trainee Sub-resources -------------------------------------------

// POST /api/profile/records/:id/submission  (multipart, field "submission")
// The one previously-missing piece: a trainee submitting a file back for
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
        "SELECT id, student_id, supervisor_id, title FROM assignments WHERE id = ?",
        [assignmentId]
      );
      if (!assignmentRows.length) {
        return res.status(404).json({ error: "Assignment not found" });
      }
      if (String(assignmentRows[0].student_id) !== String(req.user.id)) {
        return res.status(403).json({ error: "This assignment doesn't belong to you" });
      }

      const insert = await pool.query(
        `INSERT INTO assignment_submissions (assignment_id, student_id, filename, original_name, notes)
         VALUES (?, ?, ?, ?, ?)`,
        [assignmentId, req.user.id, req.file.filename, req.file.originalname, req.body?.notes || null]
      );

      await pool.query("UPDATE assignments SET status = 'submitted', updated_at = NOW() WHERE id = ?", [
        assignmentId,
      ]);

      await pool.query(
        "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES (?, 'assignment_submitted', 'assignment_submissions', ?)",
        [req.user.id, insert.insertId]
      );

      const { rows: studentRows } = await pool.query("SELECT full_name FROM students WHERE id = ?", [req.user.id]);
      const traineeName = (studentRows[0] && studentRows[0].full_name) || "A trainee";
      await createNotification(pool, {
        recipientId: assignmentRows[0].supervisor_id,
        type: "assignment",
        title: `${traineeName} submitted: ${assignmentRows[0].title}`,
        relatedEntityType: "assignment",
        relatedEntityId: assignmentRows[0].id,
        email: {
          template: "assignmentSubmitted",
          data: { assignmentTitle: assignmentRows[0].title, traineeName },
        },
      });

      const { rows } = await pool.query("SELECT * FROM assignment_submissions WHERE id = ?", [insert.insertId]);

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
    const rq = buildRecordsQuery(req.user.id, type);
    let { sql, params } = rq;
    if (supervisorId) {
      // Wrap the UNION query and filter by supervisor -- keeps
      // buildRecordsQuery() itself untouched for the other callers
      // (supervisor.js) that don't need this filter. Re-apply ORDER BY
      // on the outer query since ordering inside a subquery isn't
      // guaranteed to survive without it. MySQL's default DESC already
      // sorts NULL record_date last, same as Postgres's DESC NULLS LAST.
      sql = `SELECT * FROM (${sql}) AS filtered WHERE supervisor_id = ? ORDER BY record_date DESC`;
      params = [...params, supervisorId];
    }
    const { rows } = await db.query(sql, params);

    // Attach supervisor names (the UNION query only carries supervisor_id)
    const supIds = [...new Set(rows.map((r) => r.supervisor_id).filter((x) => x != null))];
    const names = {};
    if (supIds.length) {
      const { sql: idSql, params: idParams } = inClause(supIds);
      const { rows: supRows } = await db.query(`SELECT id, full_name FROM supervisors WHERE id IN (${idSql})`, idParams);
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
      filter = `AND d.uploaded_by = ?`;
    }
    const { rows } = await db.query(
      `SELECT d.*, COALESCE(a.full_name, sup.full_name) AS uploaded_by_name
       FROM documents d
       JOIN user_credentials uc ON uc.id = d.uploaded_by
       LEFT JOIN admin_users a ON a.id = d.uploaded_by
       LEFT JOIN supervisors sup ON sup.id = d.uploaded_by
       WHERE d.student_id = ? ${filter} ORDER BY d.created_at DESC`,
      params
    );
    res.json({ documents: rows.map(toDocument) });
  })
);

// ---- Assignments (richer than the generic /records?type=assignment view --
// carries attachment/content link + submission + grade/feedback, none of
// which fit the flat shape the other 6 record types share) ----------------

// GET /api/profile/assignments?status=
router.get(
  "/assignments",
  requireStudent,
  asyncRoute(async (req, res, db) => {
    const { rows } = await db.query(
      `${ASSIGNMENT_WITH_SUBMISSION_SELECT} WHERE a.student_id = ? ORDER BY a.due_date IS NULL, a.due_date ASC`,
      [req.user.id]
    );
    let items = rows.map(assignmentRowToApi);
    if (req.query.status) items = items.filter((i) => i.status === req.query.status);
    res.json({ assignments: items });
  })
);

// GET /api/profile/assignments/:id
router.get(
  "/assignments/:id",
  requireStudent,
  asyncRoute(async (req, res, db) => {
    const { rows } = await db.query(`${ASSIGNMENT_WITH_SUBMISSION_SELECT} WHERE a.id = ? AND a.student_id = ?`, [
      req.params.id,
      req.user.id,
    ]);
    if (!rows.length) return res.status(404).json({ error: "Assignment not found" });
    res.json(assignmentRowToApi(rows[0]));
  })
);

// ---- Notifications (any role -- this file has no role restriction beyond
// requireAuth, so it's the one place these live rather than duplicating
// four copies across admin.js/supervisor.js/Mastertrainer.js/designer.js) --

// GET /api/profile/notifications?unreadOnly=&limit=
router.get(
  "/notifications",
  asyncRoute(async (req, res, db) => {
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const clauses = ["recipient_id = ?"];
    const params = [req.user.id];
    if (req.query.unreadOnly === "true") clauses.push("is_read = FALSE");
    const { rows } = await db.query(
      `SELECT id, notification_type, title, body, related_entity_type, related_entity_id, is_read, created_at
         FROM notifications WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
      [...params, limit]
    );
    res.json({
      notifications: rows.map((n) => ({
        id: n.id,
        type: n.notification_type,
        title: n.title,
        body: n.body,
        relatedEntityType: n.related_entity_type,
        relatedEntityId: n.related_entity_id,
        isRead: !!n.is_read,
        createdAt: n.created_at,
      })),
    });
  })
);

// GET /api/profile/notifications/unread-count
router.get(
  "/notifications/unread-count",
  asyncRoute(async (req, res, db) => {
    const { rows } = await db.query(
      "SELECT COUNT(*) AS count FROM notifications WHERE recipient_id = ? AND is_read = FALSE",
      [req.user.id]
    );
    res.json({ count: Number(rows[0].count) });
  })
);

// PATCH /api/profile/notifications/:id/read
router.patch(
  "/notifications/:id/read",
  asyncRoute(async (req, res, db) => {
    const { affectedRows } = await db.query(
      "UPDATE notifications SET is_read = TRUE WHERE id = ? AND recipient_id = ?",
      [req.params.id, req.user.id]
    );
    if (!affectedRows) return res.status(404).json({ error: "Notification not found" });
    res.json({ success: true });
  })
);

// POST /api/profile/notifications/mark-all-read
router.post(
  "/notifications/mark-all-read",
  asyncRoute(async (req, res, db) => {
    await db.query("UPDATE notifications SET is_read = TRUE WHERE recipient_id = ? AND is_read = FALSE", [
      req.user.id,
    ]);
    res.json({ success: true });
  })
);

// PUT /api/profile/notification-preferences -- replaces the localStorage-only
// stopgap every dashboard's Settings page currently uses; writes the real
// `settings` row that createNotification() already reads from.
router.put(
  "/notification-preferences",
  asyncRoute(async (req, res, db) => {
    const { notifyMessages, notifyAssignments, notifySessions, notifyPayments, notifyAnnouncements } = req.body || {};
    const updates = [];
    const params = [];
    const fields = {
      notify_messages: notifyMessages,
      notify_assignments: notifyAssignments,
      notify_sessions: notifySessions,
      notify_payments: notifyPayments,
      notify_announcements: notifyAnnouncements,
    };
    for (const [column, value] of Object.entries(fields)) {
      if (value !== undefined) {
        updates.push(`${column} = ?`);
        params.push(!!value);
      }
    }
    if (!updates.length) return res.status(400).json({ error: "No preferences to update" });

    params.push(req.user.id);
    const { affectedRows } = await db.query(
      `UPDATE settings SET ${updates.join(", ")}, updated_at = NOW() WHERE user_id = ?`,
      params
    );
    if (!affectedRows) return res.status(404).json({ error: "Settings not found" });
    res.json({ success: true });
  })
);

// GET /api/profile/notification-preferences
router.get(
  "/notification-preferences",
  asyncRoute(async (req, res, db) => {
    const { rows } = await db.query(
      "SELECT notify_messages, notify_assignments, notify_sessions, notify_payments, notify_announcements FROM settings WHERE user_id = ?",
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Settings not found" });
    const s = rows[0];
    res.json({
      notifyMessages: !!s.notify_messages,
      notifyAssignments: !!s.notify_assignments,
      notifySessions: !!s.notify_sessions,
      notifyPayments: !!s.notify_payments,
      notifyAnnouncements: !!s.notify_announcements,
    });
  })
);

// ---- Messages (per-supervisor chat thread) ------------------------------

async function getOrCreateChat(db, supervisorId, studentId) {
  const { rows } = await db.query(
    "SELECT id FROM chats WHERE supervisor_id = ? AND student_id = ?",
    [supervisorId, studentId]
  );
  if (rows.length) return rows[0].id;
  const created = await db.query(
    "INSERT INTO chats (supervisor_id, student_id) VALUES (?, ?)",
    [supervisorId, studentId]
  );
  return created.insertId;
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
       WHERE m.chat_id = ? ORDER BY m.created_at ASC`,
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

    const { rows: supRows } = await db.query("SELECT id FROM supervisors WHERE id = ?", [supervisorId]);
    if (!supRows.length) return res.status(404).json({ error: "Supervisor not found" });

    const chatId = await getOrCreateChat(db, supervisorId, req.user.id);
    const insert = await db.query(
      "INSERT INTO messages (chat_id, sender_id, content) VALUES (?, ?, ?)",
      [chatId, req.user.id, content.trim()]
    );
    await db.query("UPDATE chats SET last_message_at = NOW() WHERE id = ?", [chatId]);

    const { rows } = await db.query("SELECT * FROM messages WHERE id = ?", [insert.insertId]);
    res.status(201).json(toMessage({ ...rows[0], sender_name: req.user.member_code }, req.user.id));
  })
);

// GET /api/profile/materials-feed
router.get(
  "/materials-feed",
  requireStudent,
  asyncRoute(async (req, res, db) => {
    const { supervisorId } = req.query;
    const params = [req.user.id, req.user.id, req.user.id];
    let filter = "";
    if (supervisorId) {
      params.push(supervisorId);
      filter = "AND lm.supervisor_id = ?";
    }
    const { rows } = await db.query(
      `SELECT lm.*, sup.full_name AS supervisor_name,
              (SELECT a.id FROM assignments a
                WHERE a.student_id = ? AND LOWER(a.title) = LOWER(lm.title)
                ORDER BY a.id DESC LIMIT 1) AS matched_assignment_id
       FROM learning_materials lm
       JOIN supervisors sup ON sup.id = lm.supervisor_id
       WHERE lm.supervisor_id IN (SELECT supervisor_id FROM supervisor_students WHERE student_id = ?)
         AND (lm.student_id IS NULL OR lm.student_id = ?)
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
    const params = [req.user.id, req.user.id];
    let filter = "";
    if (supervisorId) {
      params.push(supervisorId);
      filter = "AND a.supervisor_id = ?";
    }
    const { rows } = await db.query(
      `SELECT a.*, sup.full_name AS supervisor_name FROM announcements a
       JOIN supervisors sup ON sup.id = a.supervisor_id
       WHERE a.supervisor_id IN (SELECT supervisor_id FROM supervisor_students WHERE student_id = ?)
         AND (a.cohort_id IS NULL OR a.cohort_id = (SELECT cohort_id FROM students WHERE id = ?))
         ${filter}
       ORDER BY a.created_at DESC`,
      params
    );
    res.json({ announcements: rows.map(toAnnouncement) });
  })
);

// GET /api/profile/payments — my own summary + history, read-only.
// Restricted to the caller's own student_id by the WHERE clause itself
// (there is no Row-Level Security in MySQL to lean on for this).
router.get(
  "/payments",
  requireStudent,
  asyncRoute(async (req, res, db) => {
    const { rows: paymentsRows } = await db.query("SELECT * FROM payments WHERE student_id = ?", [req.user.id]);
    const { rows: transactions } = await db.query(
      `SELECT pt.*, COALESCE(a.full_name, sup.full_name) AS added_by_name FROM payment_transactions pt
       LEFT JOIN admin_users a ON a.id = pt.added_by
       LEFT JOIN supervisors sup ON sup.id = pt.added_by
       WHERE pt.student_id = ? ORDER BY pt.payment_date DESC, pt.created_at DESC`,
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
      "SELECT action, created_at FROM audit_logs WHERE actor_id = ? ORDER BY created_at DESC LIMIT 20",
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
    const params = [req.user.id, req.user.id];
    let filter = "";
    if (supervisorId) {
      params.push(supervisorId);
      filter = "AND m.supervisor_id = ?";
    }
    const { rows } = await db.query(
      `SELECT m.* FROM meetings m
       WHERE m.supervisor_id IN (SELECT supervisor_id FROM supervisor_students WHERE student_id = ?)
         AND (m.student_id IS NULL OR m.student_id = ?)
         ${filter}
       ORDER BY (m.scheduled_at IS NULL), m.scheduled_at ASC`,
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
