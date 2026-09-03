const express = require("express");
const fs = require("fs");
const path = require("path");
const config = require("../config");
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
const { documentUpload, materialUpload, assignmentAttachmentUpload } = require("../utils/uploads");
const { optimizeImageIfPossible } = require("../utils/imageOptimize");
const { checkFileContent } = require("../utils/fileTypeCheck");
const {
  buildRecordsQuery,
  RECORD_TYPE_TABLES,
  TRAINEE_ACTIVITY_ENTITY_TYPES,
  buildHoursBreakdownQuery,
  buildTotHoursBreakdownQuery,
} = require("../utils/recordsQuery");
const { createNotification, getUserContactInfo } = require("../utils/notifications");
const { ASSIGNMENT_WITH_SUBMISSION_SELECT, assignmentRowToApi, attachSubmissionHistories } = require("../utils/assignmentsQuery");
const { resolveWeekRange } = require("../utils/weekPeriod");

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
      `SELECT uc.id, uc.member_code, uc.status, st.full_name, st.current_year, st.group_id, c.name AS cohort_name
       FROM user_credentials uc JOIN students st ON st.id = uc.id LEFT JOIN cohorts c ON c.id = st.cohort_id
       WHERE uc.member_code = ?`,
      [String(studentCode).trim().toUpperCase()]
    );
    if (!studentRows.length) {
      return res.status(404).json({ error: "This Trainee ID does not exist. Please contact the Administrator." });
    }
    const student = studentRows[0];

    // A supervisor may only self-assign to a trainee already in their own
    // Group -- without this, any supervisor could add themself to any
    // trainee system-wide just by knowing (or guessing, since codes are
    // sequential) their ID, bypassing every Group/caseload boundary the
    // rest of the app enforces.
    const { rows: callerRows } = await db.query("SELECT group_id FROM supervisors WHERE id = ?", [req.user.id]);
    const callerGroupId = callerRows[0] && callerRows[0].group_id;
    if (!callerGroupId || student.group_id !== callerGroupId) {
      return res.status(403).json({ error: "This trainee is not in your Group. Ask your Master Trainer or Admin to assign you." });
    }

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
       WHERE d.student_id = ? ORDER BY d.created_at DESC LIMIT 500`,
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

    const { recordType, date, time, durationMinutes, status, attendanceStatus, title, content, score, hourTypeCode } = req.body || {};
    if (!RECORD_TYPES.includes(recordType)) {
      return res.status(400).json({ error: `recordType must be one of: ${RECORD_TYPES.join(", ")}` });
    }

    let insertedId;
    let sessionType;
    let sessionTypeLabel;
    switch (recordType) {
      case "training_session":
      case "supervision_session":
      case "hour_session": {
        // Hours are never a typed number anymore -- they're derived from
        // this session's duration + its attendance status. A session dated
        // today or earlier already happened, so attendance is required and
        // captured in the SAME request (atomic, via asyncRoute's
        // transaction) -- see computeProgressSummary for the formula. A
        // future-dated session is being scheduled ahead of time, when
        // attendance can't be known yet: it's created with
        // status='scheduled' and no attendance row, to be completed later
        // via PUT (below) once it actually happens.
        if (!date) return res.status(400).json({ error: "date is required" });
        if (!Number.isFinite(Number(durationMinutes)) || Number(durationMinutes) < 0) {
          return res.status(400).json({ error: "durationMinutes is required and must be a non-negative number" });
        }
        // "training"/"supervision" are the two permanent, hardcoded types;
        // any other active Admin-configured hour type is looked up live
        // (the DB no longer enforces this with a CHECK constraint, so this
        // lookup is now the only thing standing between a bad hourTypeCode
        // and a broken foreign key).
        if (recordType === "training_session") {
          sessionType = "training";
          sessionTypeLabel = "training";
        } else if (recordType === "supervision_session") {
          sessionType = "supervision";
          sessionTypeLabel = "supervision";
        } else {
          if (!hourTypeCode) return res.status(400).json({ error: "hourTypeCode is required for a hour_session record" });
          const { rows: htRows } = await db.query("SELECT code, label FROM hour_types WHERE code = ? AND is_active = 1", [hourTypeCode]);
          if (!htRows.length) return res.status(400).json({ error: "That hour type does not exist or is inactive" });
          sessionType = htRows[0].code;
          sessionTypeLabel = htRows[0].label;
        }
        const { rows: todayRows } = await db.query("SELECT CURDATE() AS today");
        const isFuture = date > todayRows[0].today;
        if (!isFuture && !["present", "absent", "excused"].includes(attendanceStatus)) {
          return res.status(400).json({ error: "attendanceStatus is required for a session dated today or earlier" });
        }
        // Duplicate-submission guard (same student/type/date/duration
        // within the last 10 seconds) -- catches a double-click or a
        // client retry without blocking a legitimate second session
        // logged for the same trainee later. Same pattern already used
        // for payments (admin.js); sessions had no equivalent guard even
        // though their duration directly drives certified training hours.
        const { rows: dupeSessionRows } = await db.query(
          `SELECT id FROM sessions
           WHERE student_id = ? AND supervisor_id = ? AND session_type = ? AND session_date = ?
             AND duration_minutes = ? AND created_at >= NOW() - INTERVAL 10 SECOND`,
          [studentId, req.user.id, sessionType, date, Number(durationMinutes)]
        );
        if (dupeSessionRows.length) {
          return res.status(409).json({
            error: "This looks like a duplicate of a session just logged. Refresh and check the history before retrying.",
          });
        }
        const sessionInsert = await db.query(
          `INSERT INTO sessions (student_id, supervisor_id, session_type, title, session_date, session_time, duration_minutes, notes, status)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [studentId, req.user.id, sessionType, title || null, date, time || null, Number(durationMinutes), content || null, isFuture ? "scheduled" : "completed"]
        );
        insertedId = sessionInsert.insertId;
        if (!isFuture) {
          await db.query(
            `INSERT INTO attendance (student_id, supervisor_id, session_id, attendance_date, status, recorded_by)
             VALUES (?,?,?,?,?,?)`,
            [studentId, req.user.id, insertedId, date, attendanceStatus, req.user.id]
          );
        }
        break;
      }
      case "attendance":
      case "training_hours":
      case "supervision_hours": {
        return res.status(400).json({
          error:
            "Standalone attendance/hours entries are no longer supported -- record attendance together with its training/supervision session, or use a manual hour adjustment for an exception.",
        });
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

    if (recordType === "assignment") {
      const trainer = await getUserContactInfo(db, req.user.id);
      await createNotification(db, {
        recipientId: studentId,
        type: "assignment",
        title: `New assignment: ${title || "Untitled assignment"}`,
        body: content || null,
        relatedEntityType: "assignment",
        relatedEntityId: insertedId,
        email: {
          template: "newAssignment",
          data: { assignmentTitle: title || "Untitled assignment", trainerName: (trainer && trainer.fullName) || "Your trainer", dueDate: date },
        },
      });
    } else if (recordType === "training_session" || recordType === "supervision_session" || recordType === "hour_session") {
      const trainer = await getUserContactInfo(db, req.user.id);
      await createNotification(db, {
        recipientId: studentId,
        type: "session",
        title: `New ${sessionTypeLabel} session logged`,
        body: title || null,
        relatedEntityType: "session",
        relatedEntityId: insertedId,
        email: {
          template: "newSession",
          data: {
            sessionTitle: title,
            sessionType: sessionTypeLabel,
            trainerName: (trainer && trainer.fullName) || "Your trainer",
            date,
          },
        },
      });
    }

    const freshRq = buildRecordsQuery(studentId, recordType);
    const { rows: freshRows } = await db.query(freshRq.sql, freshRq.params);
    const [withName] = await attachSupervisorNames(db, freshRows.filter((r) => r.id === insertedId));
    const responseBody = toRecord(withName || freshRows.find((r) => r.id === insertedId));
    if (recordType === "training_session" || recordType === "supervision_session" || recordType === "hour_session") {
      responseBody.attendanceStatus = attendanceStatus;
    }
    res.status(201).json(responseBody);
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
    // Sharing caseload access to a trainee (e.g. two ToTs, or a ToT and
    // their Master Trainer, both linked via supervisor_students) is not
    // the same as owning a specific record about that trainee -- every
    // table behind RECORD_TYPE_TABLES has its own supervisor_id tracking
    // who actually created it. Without this check, any supervisor sharing
    // the trainee could silently overwrite or delete another supervisor's
    // session/assignment/note/evaluation. Master Trainer gets no special
    // case here: their existing oversight of a ToT's trainee-facing
    // records is deliberately read-only (see Mastertrainer.js), and this
    // route doesn't extend that into write access.
    if (existing.supervisor_id !== req.user.id) {
      return res.status(403).json({ error: "You can only edit records you created" });
    }

    const { date, time, durationMinutes, status, title, content, score, attendanceStatus } = req.body || {};

    if (recordType === "training_session" || recordType === "supervision_session" || recordType === "hour_session") {
      await db.query(
        `UPDATE sessions SET
          session_date = COALESCE(?, session_date), session_time = COALESCE(?, session_time),
          duration_minutes = COALESCE(?, duration_minutes), title = COALESCE(?, title),
          notes = COALESCE(?, notes), updated_at = NOW()
         WHERE id = ?`,
        [date ?? null, time ?? null, durationMinutes ?? null, title ?? null, content ?? null, recordId]
      );
      // Completing a previously-scheduled session: it may not have an
      // attendance row yet (none is created at scheduling time, since
      // attendance can't be known in advance -- see the POST handler
      // above), so this upserts rather than assuming UPDATE will match a
      // row. Also flips the session's own lifecycle status to 'completed'
      // now that attendance -- and therefore its hours -- are known.
      if (["present", "absent", "excused"].includes(attendanceStatus)) {
        const { rows: attRows } = await db.query("SELECT id FROM attendance WHERE session_id = ?", [recordId]);
        if (attRows.length) {
          await db.query("UPDATE attendance SET status = ? WHERE session_id = ?", [attendanceStatus, recordId]);
        } else {
          await db.query(
            `INSERT INTO attendance (student_id, supervisor_id, session_id, attendance_date, status, recorded_by)
             VALUES (?, ?, ?, (SELECT session_date FROM sessions WHERE id = ?), ?, ?)`,
            [existing.student_id, req.user.id, recordId, recordId, attendanceStatus, req.user.id]
          );
        }
        await db.query("UPDATE sessions SET status = 'completed' WHERE id = ? AND status = 'scheduled'", [recordId]);
      }
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
    // Same author-only rule as the PUT above -- shared caseload access
    // isn't ownership of a specific record. No Master Trainer exception:
    // their oversight of a ToT's trainee-facing records is deliberately
    // read-only elsewhere in the app.
    if (existing.supervisor_id !== req.user.id) {
      return res.status(403).json({ error: "You can only delete records you created" });
    }

    if (recordType === "training_session" || recordType === "supervision_session" || recordType === "hour_session") {
      // Attendance is 1:1 with its session going forward (created together
      // by POST /records) -- deleting the session without its attendance
      // row would otherwise leave an orphaned attendance record (the FK is
      // ON DELETE SET NULL, not CASCADE, precisely so a legacy unlinked
      // attendance row is never silently destroyed by an unrelated delete).
      await db.query("DELETE FROM attendance WHERE session_id = ?", [recordId]);
    }
    await db.query(`DELETE FROM ${meta.table} WHERE id = ?`, [recordId]);
    if (recordType === "assignment" && existing.attachment_filename) {
      const filePath = path.join(config.uploadsDir, "assignments", existing.attachment_filename);
      fs.unlink(filePath, (err) => {
        if (err && err.code !== "ENOENT") console.error("Failed to delete assignment attachment file:", err);
      });
    }
    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, old_values) VALUES (?, ?, ?, ?, ?)",
      [req.user.id, `${recordType.replace(/_/g, " ")} deleted`, recordType, recordId, JSON.stringify(existing)]
    );
    res.json({ success: true });
  })
);

// ---- Trainee hour adjustments (audited manual exceptions) ----------------
// Append-only, exactly like payment_transactions -- never UPDATE/DELETE.
// Gated by the same supervisor_students caseload check as every other
// record above, so authorization exactly matches "who can already record
// for this trainee today" -- a Master Trainer (auto-linked to every
// trainee in their group at group-creation time) can adjust any of their
// group's trainees; a ToT only their explicitly assigned ones.

// POST /api/supervisor/students/:studentId/hour-adjustments  { hourType, hours, reason, notes? }
router.post(
  "/students/:studentId/hour-adjustments",
  asyncRoute(async (req, res, db) => {
    const studentId = Number(req.params.studentId);
    const student = await loadAssignedStudent(db, req.user.id, studentId, res);
    if (!student) return;

    const { hourType, hours, reason, notes } = req.body || {};
    // The DB no longer restricts this with a CHECK constraint (hour types
    // are Admin-configurable via the hour_types table), so this live
    // lookup is now what stops an invalid/inactive hourType from being
    // inserted.
    const { rows: htRows } = await db.query("SELECT code FROM hour_types WHERE code = ? AND is_active = 1", [hourType]);
    if (!htRows.length) {
      return res.status(400).json({ error: "hourType does not exist or is inactive" });
    }
    const numericHours = Number(hours);
    if (!Number.isFinite(numericHours) || numericHours === 0) {
      return res.status(400).json({ error: "hours must be a non-zero number (negative to correct a prior adjustment)" });
    }
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ error: "reason is required" });
    }

    const insert = await db.query(
      `INSERT INTO trainee_hour_adjustments (student_id, hour_type, hours, reason, notes, added_by) VALUES (?,?,?,?,?,?)`,
      [studentId, hourType, numericHours, reason, notes || null, req.user.id]
    );
    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, new_values) VALUES (?, 'hour_adjustment_added', 'trainee_hour_adjustments', ?, ?)",
      [req.user.id, insert.insertId, JSON.stringify({ studentId, hourType, hours: numericHours, reason })]
    );

    const progress = await computeProgressSummary(db, studentId);
    res.status(201).json({ id: insert.insertId, progress });
  })
);

// GET /api/supervisor/students/:studentId/hour-adjustments
router.get(
  "/students/:studentId/hour-adjustments",
  asyncRoute(async (req, res, db) => {
    const studentId = Number(req.params.studentId);
    const student = await loadAssignedStudent(db, req.user.id, studentId, res);
    if (!student) return;

    const { rows } = await db.query(
      `SELECT tha.*, COALESCE(a.full_name, sup.full_name) AS added_by_name
       FROM trainee_hour_adjustments tha
       LEFT JOIN admin_users a ON a.id = tha.added_by
       LEFT JOIN supervisors sup ON sup.id = tha.added_by
       WHERE tha.student_id = ? ORDER BY tha.created_at DESC`,
      [studentId]
    );
    res.json({ adjustments: rows });
  })
);

// GET /api/supervisor/students/:studentId/hours-breakdown -- the full
// transparency drill-down behind the total (spec: "where did this hour
// come from?" must always be answerable).
router.get(
  "/students/:studentId/hours-breakdown",
  asyncRoute(async (req, res, db) => {
    const studentId = Number(req.params.studentId);
    const student = await loadAssignedStudent(db, req.user.id, studentId, res);
    if (!student) return;

    const rq = buildHoursBreakdownQuery(studentId);
    const { rows } = await db.query(rq.sql, rq.params);
    res.json({ breakdown: rows });
  })
);

// ---- A ToT's own hours (received from their Master Trainer, delivered to
// their trainees) -- reachable only here, not Mastertrainer.js, since both
// a Master Trainer and a ToT log in with role='supervisor' but only a ToT
// can call this meaningfully; Mastertrainer.js is gated to supervisor_type
// = 'primary' only. Structurally separate tables (tot_training_sessions
// keyed by tot_id vs the trainee-facing sessions keyed by supervisor_id)
// mean "received" and "delivered" can never overlap or double-count. -----

// GET /api/supervisor/me/training-received
router.get(
  "/me/training-received",
  asyncRoute(async (req, res, db) => {
    const totId = req.user.id;
    const [hoursRes, attendanceRes] = await Promise.all([
      db.query(
        `SELECT
           COALESCE((
             SELECT SUM(ts.duration_minutes) / 60 FROM tot_training_sessions ts
             JOIN tot_training_attendance ta ON ta.session_id = ts.id AND ta.status = 'present'
             WHERE ts.tot_id = ? AND ts.status != 'cancelled'
           ), 0) AS session_hours,
           COALESCE((SELECT SUM(hours) FROM tot_hour_adjustments WHERE tot_id = ?), 0) AS adjustment_hours`,
        [totId, totId]
      ),
      db.query(
        `SELECT COUNT(CASE WHEN status = 'present' THEN 1 END) AS present, COUNT(*) AS total
         FROM tot_training_attendance WHERE tot_id = ?`,
        [totId]
      ),
    ]);
    const h = hoursRes.rows[0];
    const a = attendanceRes.rows[0];
    const sessionHours = Number(h.session_hours);
    const adjustmentHours = Number(h.adjustment_hours);

    res.json({
      totalHours: sessionHours + adjustmentHours,
      sessionHours,
      adjustmentHours,
      sessionsAttended: Number(a.present),
      sessionsMissed: Number(a.total) - Number(a.present),
      attendanceRate: Number(a.total) > 0 ? Math.round((Number(a.present) / Number(a.total)) * 100) : null,
    });
  })
);

// GET /api/supervisor/me/training-received/breakdown
router.get(
  "/me/training-received/breakdown",
  asyncRoute(async (req, res, db) => {
    const rq = buildTotHoursBreakdownQuery(req.user.id);
    const { rows } = await db.query(rq.sql, rq.params);
    res.json({ breakdown: rows });
  })
);

// GET /api/supervisor/me/training-delivered -- aggregate across every
// trainee currently assigned to this ToT (supervisor_students caseload),
// using the exact same attendance-derived formula as computeProgressSummary.
router.get(
  "/me/training-delivered",
  asyncRoute(async (req, res, db) => {
    const supervisorId = req.user.id;
    const [hoursRes, attendanceRes, traineeRes] = await Promise.all([
      db.query(
        `SELECT COALESCE(SUM(s.duration_minutes) / 60, 0) AS hours
         FROM sessions s
         JOIN attendance a ON a.session_id = s.id AND a.status = 'present'
         WHERE s.supervisor_id = ? AND s.status != 'cancelled'`,
        [supervisorId]
      ),
      db.query(
        `SELECT COUNT(CASE WHEN status = 'present' THEN 1 END) AS present, COUNT(*) AS total
         FROM attendance WHERE supervisor_id = ?`,
        [supervisorId]
      ),
      db.query(
        `SELECT COUNT(DISTINCT student_id) AS trainee_count, COUNT(*) AS session_count
         FROM sessions WHERE supervisor_id = ? AND status != 'cancelled'`,
        [supervisorId]
      ),
    ]);
    const h = hoursRes.rows[0];
    const a = attendanceRes.rows[0];
    const t = traineeRes.rows[0];

    res.json({
      totalHours: Number(h.hours),
      sessionsConducted: Number(t.session_count),
      traineesTrained: Number(t.trainee_count),
      traineeAttendanceRate: Number(a.total) > 0 ? Math.round((Number(a.present) / Number(a.total)) * 100) : null,
    });
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
    // This one Trainee's own completion percentage -- previously only
    // ever computed as a Group-wide aggregate (Mastertrainer.js's
    // /milestones), never per-trainee, on either this Trainer-facing view
    // or the Trainee's own.
    const completedCount = rows.filter((r) => r.status === "completed").length;
    res.json({
      milestones: rows,
      completionPct: rows.length > 0 ? Math.round((completedCount / rows.length) * 1000) / 10 : null,
    });
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

    // A Master Trainer is auto-linked to every trainee in their Group for
    // oversight (supervisor_students), which would otherwise let them pass
    // the caseload check above and mark milestone progress for a trainee
    // who is actually being trained day-to-day by one of their ToTs. That
    // contradicts this app's own documented "Master Trainer is read-only
    // for Trainee data" design elsewhere (Mastertrainer.js) -- milestone
    // marking is a ToT's action, not group-wide oversight.
    const { rows: callerTypeRows } = await db.query("SELECT supervisor_type FROM supervisors WHERE id = ?", [
      req.user.id,
    ]);
    if (callerTypeRows[0] && callerTypeRows[0].supervisor_type === "primary") {
      return res.status(403).json({ error: "Master Trainers have read-only access to trainee milestones" });
    }

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

// ---- Assignments (dedicated overview + grading) --------------------------
// The generic POST /students/:studentId/records (recordType="assignment",
// above) still works exactly as before for a single trainee -- these routes
// add: (a) creating one assignment for MULTIPLE trainees at once without
// changing that schema (one `assignments` row per trainee, looped, same as
// every existing report already assumes), (b) a real overview that doesn't
// require one API call per trainee, and (c) reviewing/grading a trainee's
// submission, which previously had no route at all despite the submission
// upload itself (routes/profile.js) already working.

// POST /api/supervisor/assignments — create one assignment for one or more
// trainees at once. Accepts multipart (field "attachment") or plain JSON;
// "studentIds" is a JSON-array string either way (FormData can't carry a
// real array field).
router.post("/assignments", (req, res) => {
  const contentType = req.headers["content-type"] || "";

  const handle = async (attachmentFilename) => {
    const { studentIds, title, description, dueDate, contentUrl } = req.body || {};
    let ids;
    try {
      ids = typeof studentIds === "string" ? JSON.parse(studentIds) : studentIds;
    } catch {
      ids = null;
    }
    if (!Array.isArray(ids) || !ids.length) {
      return res.status(400).json({ error: "studentIds must be a non-empty array" });
    }
    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: "title is required" });
    }

    const { pool } = require("../db");
    const trainer = await getUserContactInfo(pool, req.user.id);
    const created = [];
    for (const rawId of ids) {
      const studentId = Number(rawId);
      const { rows: assignRows } = await pool.query(
        "SELECT 1 FROM supervisor_students WHERE supervisor_id = ? AND student_id = ?",
        [req.user.id, studentId]
      );
      if (!assignRows.length) continue; // silently skip a trainee not assigned to this Trainer -- never assign outside your own caseload

      const insert = await pool.query(
        `INSERT INTO assignments (student_id, supervisor_id, title, description, attachment_filename, content_url, due_date, status)
         VALUES (?,?,?,?,?,?,?,'pending')`,
        [studentId, req.user.id, title.trim(), description || null, attachmentFilename || null, contentUrl || null, dueDate || null]
      );
      await pool.query(
        "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, new_values) VALUES (?, 'assignment added', 'assignment', ?, ?)",
        [req.user.id, insert.insertId, JSON.stringify({ studentId })]
      );
      await createNotification(pool, {
        recipientId: studentId,
        type: "assignment",
        title: `New assignment: ${title.trim()}`,
        body: description || null,
        relatedEntityType: "assignment",
        relatedEntityId: insert.insertId,
        email: {
          template: "newAssignment",
          data: { assignmentTitle: title.trim(), trainerName: (trainer && trainer.fullName) || "Your trainer", dueDate },
        },
      });
      created.push(insert.insertId);
    }

    if (!created.length) {
      return res.status(403).json({ error: "None of the selected trainees are assigned to you" });
    }
    res.status(201).json({ createdIds: created, skipped: ids.length - created.length });
  };

  if (contentType.includes("multipart/form-data")) {
    assignmentAttachmentUpload.single("attachment")(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (req.file) {
        const check = checkFileContent(req.file.path, ["pdf", "office", "image"]);
        if (!check.safe) {
          fs.unlink(req.file.path, () => {});
          return res.status(400).json({ error: check.reason });
        }
        await optimizeImageIfPossible(req.file.path, { maxDimension: 1920 });
      }
      try {
        await handle(req.file ? req.file.filename : null);
      } catch (err) {
        res.status(500).json({ error: "Internal server error" });
      }
    });
  } else {
    handle(null).catch(() => res.status(500).json({ error: "Internal server error" }));
  }
});

// GET /api/supervisor/assignments?status=&studentId= — full overview,
// including each assignment's latest submission (if any), in one call.
router.get(
  "/assignments",
  asyncRoute(async (req, res, db) => {
    const clauses = ["a.supervisor_id = ?"];
    const params = [req.user.id];
    if (req.query.studentId) {
      clauses.push("a.student_id = ?");
      params.push(Number(req.query.studentId));
    }
    // A hard ceiling, not real pagination -- `status` here is a live-
    // computed field (assignmentRowToApi), not a raw column, so it has to
    // be filtered in JS after the query rather than in SQL. 500 is far
    // beyond one Trainer's realistic assignment volume across their whole
    // caseload even after years of training.
    const { rows } = await db.query(
      `${ASSIGNMENT_WITH_SUBMISSION_SELECT} WHERE ${clauses.join(" AND ")} ORDER BY a.due_date IS NULL, a.due_date ASC LIMIT 500`,
      params
    );

    let items = rows.map(assignmentRowToApi);
    if (req.query.status) items = items.filter((i) => i.status === req.query.status);
    await attachSubmissionHistories(db, items);

    res.json({ assignments: items });
  })
);

// GET /api/supervisor/assignments/:id — single-assignment detail w/ submission
router.get(
  "/assignments/:id",
  asyncRoute(async (req, res, db) => {
    const { rows } = await db.query(`${ASSIGNMENT_WITH_SUBMISSION_SELECT} WHERE a.id = ? AND a.supervisor_id = ?`, [
      req.params.id,
      req.user.id,
    ]);
    if (!rows.length) return res.status(404).json({ error: "Assignment not found" });
    const item = assignmentRowToApi(rows[0]);
    await attachSubmissionHistories(db, [item]);
    res.json(item);
  })
);

// PUT /api/supervisor/assignments/:id/grade  { score, feedback }
router.put(
  "/assignments/:id/grade",
  asyncRoute(async (req, res, db) => {
    const assignmentId = Number(req.params.id);
    const { rows: assignmentRows } = await db.query(
      "SELECT * FROM assignments WHERE id = ? AND supervisor_id = ?",
      [assignmentId, req.user.id]
    );
    if (!assignmentRows.length) return res.status(404).json({ error: "Assignment not found" });
    const assignment = assignmentRows[0];

    const { rows: submissionRows } = await db.query(
      "SELECT id FROM assignment_submissions WHERE assignment_id = ? ORDER BY submitted_at DESC LIMIT 1",
      [assignmentId]
    );
    if (!submissionRows.length) return res.status(409).json({ error: "This trainee hasn't submitted anything yet" });

    const { score, feedback } = req.body || {};
    await db.query(
      `UPDATE assignment_submissions SET score = ?, feedback = ?, graded_by = ?, graded_at = NOW(), status = 'graded' WHERE id = ?`,
      [score ?? null, feedback || null, req.user.id, submissionRows[0].id]
    );
    await db.query("UPDATE assignments SET status = 'completed', updated_at = NOW() WHERE id = ?", [assignmentId]);
    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, new_values) VALUES (?, 'assignment graded', 'assignment_submissions', ?, ?)",
      [req.user.id, submissionRows[0].id, JSON.stringify({ score, feedback })]
    );
    await createNotification(db, {
      recipientId: assignment.student_id,
      type: "assignment",
      title: `Your assignment was graded: ${assignment.title}`,
      body: feedback || null,
      relatedEntityType: "assignment",
      relatedEntityId: assignmentId,
      email: {
        template: "assignmentGraded",
        data: { assignmentTitle: assignment.title, score, feedback },
      },
    });

    res.json({ success: true });
  })
);

// ---- Documents -----------------------------------------------------------

router.post("/students/:studentId/documents", (req, res) => {
  documentUpload.single("document")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const check = checkFileContent(req.file.path, ["pdf", "office", "image"]);
    if (!check.safe) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: check.reason });
    }
    await optimizeImageIfPossible(req.file.path, { maxDimension: 1920 });

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
// Mirrors learning_materials.material_type's own CHECK constraint (schema),
// minus 'link' -- that value only ever goes through the externalUrl branch
// below, never the file-upload one this list validates.
const MATERIAL_TYPES = ["document", "image", "video", "audio", "assignment", "worksheet", "reading"];

router.get(
  "/materials",
  asyncRoute(async (req, res, db) => {
    const { rows } = await db.query(
      `SELECT lm.*,
              (SELECT a.id FROM assignments a
                WHERE a.student_id = lm.student_id AND a.supervisor_id = lm.supervisor_id
                  AND LOWER(a.title) = LOWER(lm.title)
                ORDER BY a.id DESC LIMIT 1) AS matched_assignment_id
       FROM learning_materials lm
       WHERE lm.supervisor_id = ?
       ORDER BY lm.created_at DESC
       LIMIT 200`,
      [req.user.id]
    );
    res.json({ materials: rows.map((r) => toMaterial({ ...r, supervisor_name: req.user.member_code })) });
  })
);

/**
 * Notifies whoever a newly-added material is relevant to: just the one
 * trainee if the material was scoped to them, or the supervisor's whole
 * current caseload if it wasn't (materials with no studentId are shared
 * with every assigned trainee -- see the materials-feed read side).
 */
async function notifyMaterialRecipients(pool, supervisorId, studentId, materialTitle, materialId) {
  const trainer = await getUserContactInfo(pool, supervisorId);
  const trainerName = (trainer && trainer.fullName) || "Your trainer";
  let recipientIds;
  if (studentId) {
    recipientIds = [Number(studentId)];
  } else {
    const { rows } = await pool.query("SELECT student_id FROM supervisor_students WHERE supervisor_id = ?", [supervisorId]);
    recipientIds = rows.map((r) => r.student_id);
  }
  for (const recipientId of recipientIds) {
    await createNotification(pool, {
      recipientId,
      type: "document",
      title: `New material: ${materialTitle}`,
      relatedEntityType: "learning_material",
      relatedEntityId: materialId,
      email: { template: "newMaterial", data: { materialTitle, trainerName } },
    });
  }
}

router.post("/materials", (req, res) => {
  const contentType = req.headers["content-type"] || "";
  const { pool } = require("../db");

  if (contentType.includes("multipart/form-data")) {
    materialUpload.single("file")(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.message });
      const { title, description, materialType, studentId } = req.body || {};
      if (!title || !materialType) return res.status(400).json({ error: "title and materialType are required" });
      // The schema's own CHECK constraint on learning_materials.material_type
      // is silently unenforced on MySQL below 8.0.16 (its own header
      // comment says so) -- this route never validated independently, so a
      // bad value would either fail with a raw DB error on a version that
      // does enforce it, or corrupt the column silently on one that doesn't.
      if (!MATERIAL_TYPES.includes(materialType)) {
        return res.status(400).json({ error: `materialType must be one of: ${MATERIAL_TYPES.join(", ")}` });
      }
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      const check = checkFileContent(req.file.path, ["pdf", "office", "image", "media"]);
      if (!check.safe) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: check.reason });
      }
      await optimizeImageIfPossible(req.file.path, { maxDimension: 1920 });

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
      await notifyMaterialRecipients(pool, req.user.id, studentId, title, insert.insertId);
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
    await notifyMaterialRecipients(pool, req.user.id, studentId, title, insert.insertId);
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
    if (existingRows[0].filename) {
      const filePath = path.join(config.uploadsDir, "materials", existingRows[0].filename);
      fs.unlink(filePath, (err) => {
        if (err && err.code !== "ENOENT") console.error("Failed to delete material file:", err);
      });
    }
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

    // Broadcast to every trainee currently assigned to this supervisor --
    // announcements have no per-trainee scoping, they're always caseload-wide
    // (matches the read side: GET /announcements has no studentId filter).
    const trainer = await getUserContactInfo(db, req.user.id);
    const { rows: caseloadRows } = await db.query("SELECT student_id FROM supervisor_students WHERE supervisor_id = ?", [
      req.user.id,
    ]);
    for (const { student_id: recipientId } of caseloadRows) {
      await createNotification(db, {
        recipientId,
        type: "announcement",
        title: `New announcement: ${title}`,
        body: content,
        relatedEntityType: "announcement",
        relatedEntityId: insert.insertId,
        email: {
          template: "newAnnouncement",
          data: { announcementTitle: title, announcementContent: content, trainerName: (trainer && trainer.fullName) || "Your trainer" },
        },
      });
    }

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
        recordType:
          r.session_type === "training" ? "training_session" : r.session_type === "supervision" ? "supervision_session" : "hour_session",
        hourTypeCode: r.session_type,
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

// GET /api/supervisor/activity -- scoped to the current week (see
// weekPeriod.js); feeds a small "Recent activity" teaser widget.
router.get(
  "/activity",
  asyncRoute(async (req, res, db) => {
    const { weekStart, weekEnd } = await resolveWeekRange(db, req.query.week);
    const { rows } = await db.query(
      `SELECT al.action, al.created_at, st.full_name AS student_name
       FROM audit_logs al
       JOIN students st ON st.id = al.entity_id
       WHERE al.actor_id = ? AND al.entity_type IN (${TRAINEE_ACTIVITY_ENTITY_TYPES.map(() => "?").join(",")})
       AND al.created_at >= ? AND al.created_at < ?
       ORDER BY al.created_at DESC LIMIT 500`,
      [req.user.id, ...TRAINEE_ACTIVITY_ENTITY_TYPES, weekStart, weekEnd]
    );
    res.json({
      weekStart,
      weekEnd,
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

/** True for a real, absolute http(s) URL -- a plain string like "call me"
 *  or a bare word was previously accepted here and rendered directly as a
 *  clickable "Join" link, which resolves as a broken relative path (e.g.
 *  https://app.example.com/call%20me) when clicked instead of failing
 *  validation up front. */
function isValidMeetingUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// POST /api/supervisor/meetings  { title, studentId, platform, meetingUrl, scheduledAt, durationMinutes }
router.post(
  "/meetings",
  asyncRoute(async (req, res, db) => {
    const { title, studentId, platform, meetingUrl, scheduledAt, durationMinutes } = req.body || {};
    if (!title || !meetingUrl) return res.status(400).json({ error: "title and meetingUrl are required" });
    if (!isValidMeetingUrl(meetingUrl)) {
      return res.status(400).json({ error: "meetingUrl must be a valid http:// or https:// link" });
    }
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

    {
      const trainer = await getUserContactInfo(db, req.user.id);
      const trainerName = (trainer && trainer.fullName) || "Your trainer";
      let recipientIds;
      if (studentId) {
        recipientIds = [Number(studentId)];
      } else {
        const { rows: caseloadRows } = await db.query("SELECT student_id FROM supervisor_students WHERE supervisor_id = ?", [req.user.id]);
        recipientIds = caseloadRows.map((r) => r.student_id);
      }
      for (const recipientId of recipientIds) {
        await createNotification(db, {
          recipientId,
          type: "meeting",
          title: `New meeting scheduled: ${title}`,
          relatedEntityType: "meeting",
          relatedEntityId: insert.insertId,
          email: { template: "newMeeting", data: { meetingTitle: title, trainerName, platform, scheduledAt } },
        });
      }
    }

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
    if (meetingUrl && !isValidMeetingUrl(meetingUrl)) {
      return res.status(400).json({ error: "meetingUrl must be a valid http:// or https:// link" });
    }

    // Same caseload check POST enforces -- without it, a meeting could be
    // retargeted to a trainee outside the caller's caseload, silently
    // taking it away from its original (correctly authorized) recipient.
    if (studentId) {
      const { rows: assignRows } = await db.query(
        "SELECT 1 FROM supervisor_students WHERE supervisor_id = ? AND student_id = ?",
        [req.user.id, studentId]
      );
      if (!assignRows.length) return res.status(403).json({ error: "You are not assigned to this trainee" });
    }

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

// ---- Hour type definitions ------------------------------------------------
// Master Trainer and Trainer (ToT) both log in with role='supervisor', so
// this router (not admin.js) is where they share the ability to manage
// which categories of hours the system tracks. sessions.session_type and
// trainee_hour_adjustments.hour_type both FK to hour_types.code -- adding
// a new one here is purely a data change; every hours computation
// (computeHoursByType in serializers.js) reads this table generically
// rather than hardcoding category names. `code` is the FK target and is
// never editable after creation -- deactivate and create a new one
// instead of renaming. Only one row may be primary at a time (see
// set-primary below) -- that is the type shown on a Trainee's own
// dashboard headline. (Read-only access for every other role is the
// separate GET /api/profile/hour-types in profile.js.)

// GET /api/supervisor/hour-types — every type, active and inactive
router.get(
  "/hour-types",
  asyncRoute(async (req, res, db) => {
    const { rows } = await db.query(
      "SELECT code, label, is_active, is_primary, sort_order, created_at FROM hour_types ORDER BY sort_order ASC"
    );
    res.json({ hourTypes: rows });
  })
);

// POST /api/supervisor/hour-types  { code, label, sortOrder? }
router.post(
  "/hour-types",
  asyncRoute(async (req, res, db) => {
    const { code, label, sortOrder } = req.body || {};
    const cleanCode = String(code || "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
    if (!cleanCode) return res.status(400).json({ error: "Code is required" });
    if (!label || !String(label).trim()) return res.status(400).json({ error: "Label is required" });

    const { rows: existing } = await db.query("SELECT code FROM hour_types WHERE code = ?", [cleanCode]);
    if (existing.length) return res.status(409).json({ error: `Code "${cleanCode}" is already in use` });

    await db.query("INSERT INTO hour_types (code, label, sort_order) VALUES (?, ?, ?)", [
      cleanCode,
      label.trim(),
      Number(sortOrder) || 0,
    ]);

    res.status(201).json({ code: cleanCode });
  })
);

// PATCH /api/supervisor/hour-types/:code  { label?, isActive?, sortOrder? }
router.patch(
  "/hour-types/:code",
  asyncRoute(async (req, res, db) => {
    const code = String(req.params.code || "");
    const { rows: existingRows } = await db.query("SELECT code, is_primary FROM hour_types WHERE code = ?", [code]);
    if (!existingRows.length) return res.status(404).json({ error: "Hour type not found" });

    const { label, isActive, sortOrder } = req.body || {};
    if (isActive === false && existingRows[0].is_primary) {
      return res.status(409).json({ error: "This is the primary hour type -- set a different type as primary before deactivating it" });
    }

    const updates = [];
    const params = [];
    if (label !== undefined) { updates.push("label = ?"); params.push(label); }
    if (isActive !== undefined) { updates.push("is_active = ?"); params.push(!!isActive); }
    if (sortOrder !== undefined) { updates.push("sort_order = ?"); params.push(Number(sortOrder) || 0); }
    if (!updates.length) return res.status(400).json({ error: "No fields to update" });

    params.push(code);
    await db.query(`UPDATE hour_types SET ${updates.join(", ")} WHERE code = ?`, params);

    res.json({ success: true });
  })
);

// POST /api/supervisor/hour-types/:code/set-primary — atomically moves the
// "shown on the Trainee dashboard headline" flag to this type.
router.post(
  "/hour-types/:code/set-primary",
  asyncRoute(async (req, res, db) => {
    const code = String(req.params.code || "");
    const { rows } = await db.query("SELECT code, is_active FROM hour_types WHERE code = ?", [code]);
    if (!rows.length) return res.status(404).json({ error: "Hour type not found" });
    if (!rows[0].is_active) return res.status(400).json({ error: "Cannot make an inactive hour type primary" });

    await db.query("UPDATE hour_types SET is_primary = FALSE WHERE is_primary = TRUE");
    await db.query("UPDATE hour_types SET is_primary = TRUE WHERE code = ?", [code]);

    res.json({ success: true });
  })
);

module.exports = router;
