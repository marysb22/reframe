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
  toArray,
  toPublicEvent,
  toEventDetail,
} = require("../utils/serializers");
const { documentUpload, materialUpload, MATERIAL_UPLOAD_MAX_BYTES, assignmentAttachmentUpload, sessionAttachmentUpload, eventImageUpload } = require("../utils/uploads");
const { createUploadGuard, hashFile } = require("../utils/uploadGuard");
const { fetchEventChildren, writeEventChildren, generateUniqueSlug } = require("../utils/eventChildren");
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
const { broadcastDirectMessage, broadcastMessage } = require("../realtime/chatSocket");
const { ASSIGNMENT_WITH_SUBMISSION_SELECT, assignmentRowToApi, attachSubmissionHistories } = require("../utils/assignmentsQuery");
const { resolveWeekRange } = require("../utils/weekPeriod");
const { createSessionOccasion, recordSessionOccasionAttendance } = require("../utils/groupSessions");
const { buildActivitiesQuery, buildCountQuery, buildActivitiesSummary } = require("../utils/activitiesQuery");
const { DOCUMENT_SELECT } = require("../utils/documentsQuery");

const router = express.Router();

router.use(requireAuth, requireSupervisor);

const STUDENT_PROFILE_SELECT = `
  SELECT uc.id, uc.member_code, uc.role, uc.status, uc.must_change_password, uc.created_at, uc.updated_at,
         st.full_name, st.email, st.phone, st.photo, st.gender, st.date_of_birth, st.marital_status,
         st.address, st.highest_degree, st.institution, st.certifications, st.cv_file,
         st.cohort_id, c.name AS cohort_name, st.current_year,
         st.training_start_date, CURDATE() AS training_today
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

// Caseload assignment (which trainee belongs to which ToT) is managed only
// by Admin/Master Trainer, not self-service by a ToT -- see
// PATCH /master-trainer/trainees/:studentId/tots and Admin's group-detail
// UI. A ToT-facing POST /students (add-by-ID) / DELETE /students/:studentId
// used to exist here; removed so a ToT can no longer grant or revoke their
// own caseload assignment.

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
      `${DOCUMENT_SELECT}
       WHERE (
         d.student_id = ?
         OR (d.student_id IS NULL AND d.group_id = (SELECT group_id FROM students WHERE id = ?) AND d.approval_status = 'approved')
         OR (d.uploaded_by = ? AND d.shared_with_supervisor_id = ?)
       )
       ORDER BY d.created_at DESC LIMIT 500`,
      [studentId, studentId, studentId, req.user.id]
    );

    res.json({
      student: toProfileResponse(student),
      records: records.map(toRecord),
      documents: documents.map((r) => ({ ...toDocument(r), canManage: Number(r.uploaded_by) === Number(req.user.id) })),
      progress: await computeProgressSummary(db, studentId),
    });
  })
);

// ---- Health & Emergency Information (read-only, caseload-gated) --------
// The schema's own student_health_info table comment documents this
// exactly: "the trainee themself, and their assigned Master Trainer/
// Trainers (read-only) may access this". loadAssignedStudent is the same
// real supervisor_students check every other student-scoped route here
// already uses -- being a Master Trainer or ToT by role is never enough
// on its own, only an actual assignment grants this. Never folded into
// GET /students/:studentId above, so nothing accidentally widens what
// that response includes.

// GET /api/supervisor/students/:studentId/health
router.get(
  "/students/:studentId/health",
  asyncRoute(async (req, res, db) => {
    const studentId = Number(req.params.studentId);
    const student = await loadAssignedStudent(db, req.user.id, studentId, res);
    if (!student) return;

    const { rows } = await db.query(
      `SELECT medical_conditions, emergency_contact_name, emergency_contact_relationship,
              emergency_contact_phone, emergency_contact_phone_2, updated_at
         FROM student_health_info WHERE student_id = ?`,
      [studentId]
    );
    const h = rows[0] || {};
    res.json({
      studentId,
      medicalConditions: h.medical_conditions || null,
      emergencyContactName: h.emergency_contact_name || null,
      emergencyContactRelationship: h.emergency_contact_relationship || null,
      emergencyContactPhone: h.emergency_contact_phone || null,
      emergencyContactPhone2: h.emergency_contact_phone_2 || null,
      updatedAt: h.updated_at || null,
    });
  })
);

// PUT/DELETE /api/supervisor/students/:studentId/health -- categorically
// read-only for every Master Trainer/ToT, regardless of assignment. Not
// simply omitted (which would 404) so a write attempt gets an explicit,
// unambiguous "you can view this, not change it" instead of looking like
// the route doesn't exist.
router.put("/students/:studentId/health", (req, res) => {
  res.status(403).json({ error: "Health & Emergency information is read-only for Master Trainers/ToTs." });
});
router.delete("/students/:studentId/health", (req, res) => {
  res.status(403).json({ error: "Health & Emergency information is read-only for Master Trainers/ToTs." });
});

// ---- Records (8 types, dispatched to their real table) ------------------

const RECORD_TYPES = Object.keys(RECORD_TYPE_TABLES);

// POST /api/supervisor/students/:studentId/records
router.post(
  "/students/:studentId/records",
  asyncRoute(async (req, res, db) => {
    const studentId = Number(req.params.studentId);
    const student = await loadAssignedStudent(db, req.user.id, studentId, res);
    if (!student) return;

    const { recordType, date, time, durationMinutes, status, attendanceStatus, minutesCompleted, title, content, score, hourTypeCode } = req.body || {};
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
        if (!isFuture && !["present", "absent", "excused", "partial"].includes(attendanceStatus)) {
          return res.status(400).json({ error: "attendanceStatus is required for a session dated today or earlier" });
        }
        if (attendanceStatus === "partial" && !(Number.isFinite(Number(minutesCompleted)) && Number(minutesCompleted) >= 0)) {
          return res.status(400).json({ error: "minutesCompleted is required and must be a non-negative number when attendanceStatus is 'partial'" });
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
            `INSERT INTO attendance (student_id, supervisor_id, session_id, attendance_date, status, minutes_completed, recorded_by)
             VALUES (?,?,?,?,?,?,?)`,
            [studentId, req.user.id, insertedId, date, attendanceStatus, attendanceStatus === "partial" ? Number(minutesCompleted) : null, req.user.id]
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

// ---- Session Occasions (Add Session for the whole caseload/Group at once,
// Attendance recorded afterward as a separate step) -- see migration 024
// and utils/groupSessions.js for the full design note. No groupId/roster
// in the URL or body -- "every selected trainee" is simply this ToT's own
// caseload within their Group (loadAssignedStudent's own rule: a ToT never
// logs hours for a trainee not actually assigned to them, even one in the
// same Group), resolved server-side exactly like the old POST
// /group-sessions this replaces. multipart-or-JSON dance mirrors POST
// /assignments above (one shared optional attachment). ---------------------

// POST /api/supervisor/session-occasions
router.post("/session-occasions", (req, res) => {
  const contentType = req.headers["content-type"] || "";

  const handle = async (attachmentFilename, attachmentOriginalName) => {
    const { pool } = require("../db");

    const { rows: meRows } = await pool.query("SELECT group_id FROM supervisors WHERE id = ?", [req.user.id]);
    const groupId = meRows.length ? meRows[0].group_id : null;
    if (!groupId) {
      return res.status(400).json({ error: "You don't have a Group assigned yet" });
    }

    const { sessionType, title, date, time, durationMinutes, notes } = req.body || {};

    // Narrowed to this ToT's own caseload within the Group, not just Group
    // membership.
    const { rows: eligibleRows } = await pool.query(
      `SELECT id FROM students WHERE group_id = ? AND id IN (SELECT student_id FROM supervisor_students WHERE supervisor_id = ?)`,
      [groupId, req.user.id]
    );
    if (!eligibleRows.length) {
      return res.status(400).json({ error: "You don't have any trainees in your caseload for this Group yet" });
    }

    const result = await createSessionOccasion(pool, {
      supervisorId: req.user.id,
      sessionType,
      title,
      date,
      time,
      durationMinutes,
      notes,
      attachmentFilename,
      attachmentOriginalName,
      studentIds: eligibleRows.map((r) => r.id),
    });
    if (result.error) return res.status(400).json({ error: result.error });

    if (!result.isFuture) {
      const trainer = await getUserContactInfo(pool, req.user.id);
      for (const { studentId, sessionId } of result.created) {
        await createNotification(pool, {
          recipientId: studentId,
          type: "session",
          title: `New ${result.sessionTypeLabel} session logged`,
          body: title || null,
          relatedEntityType: "session",
          relatedEntityId: sessionId,
          email: {
            template: "newSession",
            data: { sessionTitle: title, sessionType: result.sessionTypeLabel, trainerName: (trainer && trainer.fullName) || "Your trainer", date },
          },
        });
      }
    }

    res.status(201).json({ occasionId: result.occasionId, created: result.created });
  };

  if (contentType.includes("multipart/form-data")) {
    sessionAttachmentUpload.single("attachment")(req, res, async (err) => {
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
        await handle(req.file ? req.file.filename : null, req.file ? req.file.originalname : null);
      } catch (err) {
        console.error("[supervisor] failed to create session occasion:", err);
        if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
      }
    });
  } else {
    handle(null, null).catch((err) => {
      console.error("[supervisor] failed to create session occasion:", err);
      if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
    });
  }
});

// GET /api/supervisor/session-occasions -- this ToT's own Group Sessions
// list, newest first. recordedCount/traineeCount drive the "3/5 recorded"
// summary the list shows before Attendance is opened.
router.get(
  "/session-occasions",
  asyncRoute(async (req, res, db) => {
    const { rows } = await db.query(
      `SELECT so.id, so.title, ht.label AS session_type_label, so.session_date, so.session_time, so.duration_minutes,
              COUNT(s.id) AS trainee_count,
              COUNT(a.id) AS recorded_count
       FROM session_occasions so
       JOIN hour_types ht ON ht.code = so.session_type
       LEFT JOIN sessions s ON s.occasion_id = so.id
       LEFT JOIN attendance a ON a.session_id = s.id
       WHERE so.supervisor_id = ?
       GROUP BY so.id
       ORDER BY so.session_date DESC, so.created_at DESC`,
      [req.user.id]
    );
    res.json({
      occasions: rows.map((r) => ({
        id: r.id,
        title: r.title,
        sessionTypeLabel: r.session_type_label,
        date: r.session_date,
        time: r.session_time,
        durationMinutes: r.duration_minutes,
        traineeCount: Number(r.trainee_count),
        recordedCount: Number(r.recorded_count),
      })),
    });
  })
);

// GET /api/supervisor/session-occasions/:id -- one occasion + its roster,
// each trainee's current attendance (if any) already resolved, for the
// Attendance modal.
router.get(
  "/session-occasions/:id",
  asyncRoute(async (req, res, db) => {
    const occasionId = Number(req.params.id);
    const { rows: occRows } = await db.query(
      `SELECT so.id, so.title, ht.label AS session_type_label, so.session_date, so.session_time, so.duration_minutes
       FROM session_occasions so JOIN hour_types ht ON ht.code = so.session_type
       WHERE so.id = ? AND so.supervisor_id = ?`,
      [occasionId, req.user.id]
    );
    if (!occRows.length) return res.status(404).json({ error: "Session occasion not found" });
    const o = occRows[0];

    const { rows: rosterRows } = await db.query(
      `SELECT st.id AS student_id, st.full_name, a.status, a.minutes_completed, a.excuse_reason_code
       FROM sessions s
       JOIN students st ON st.id = s.student_id
       LEFT JOIN attendance a ON a.session_id = s.id
       WHERE s.occasion_id = ?
       ORDER BY st.full_name`,
      [occasionId]
    );

    res.json({
      occasion: {
        id: o.id,
        title: o.title,
        sessionTypeLabel: o.session_type_label,
        date: o.session_date,
        time: o.session_time,
        durationMinutes: o.duration_minutes,
      },
      roster: rosterRows.map((r) => ({
        studentId: r.student_id,
        fullName: r.full_name,
        status: r.status,
        minutesCompleted: r.minutes_completed,
        excuseReasonCode: r.excuse_reason_code,
      })),
    });
  })
);

// PUT /api/supervisor/session-occasions/:id/attendance  { entries: [{studentId, status, minutesCompleted?, excuseReasonCode?}] }
router.put(
  "/session-occasions/:id/attendance",
  asyncRoute(async (req, res, db) => {
    const occasionId = Number(req.params.id);
    const { entries } = req.body || {};

    const result = await recordSessionOccasionAttendance(db, {
      occasionId,
      supervisorId: req.user.id,
      recordedBy: req.user.id,
      entries,
    });
    if (result.error) {
      const status = result.error === "Session occasion not found" ? 404 : 400;
      return res.status(status).json({ error: result.error });
    }

    res.json({ updated: result.updated });
  })
);

// ---- Training Activities (redesigned) -- one row per real-world
// activity (a Group Session occasion OR a single-trainee session), never
// one row per trainee under an occasion. See utils/activitiesQuery.js for
// the full design note; this replaces the old client-side N+1
// GET /students/:id loop the previous flat list used. --------------------

// GET /api/supervisor/activities?search=&type=&dateFrom=&dateTo=&traineeId=&sort=&page=&pageSize=
router.get(
  "/activities",
  asyncRoute(async (req, res, db) => {
    const filters = {
      search: req.query.search,
      type: req.query.type,
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
      traineeId: req.query.traineeId,
      sort: req.query.sort,
      page: req.query.page,
      pageSize: req.query.pageSize,
    };
    const listQuery = buildActivitiesQuery(req.user.id, filters);
    const countQuery = buildCountQuery(req.user.id, filters);
    const [{ rows }, { rows: countRows }] = await Promise.all([
      db.query(listQuery.sql, listQuery.params),
      db.query(countQuery.sql, countQuery.params),
    ]);

    res.json({
      activities: rows.map((r) => ({
        id: r.id,
        kind: r.kind, // 'occasion' | 'single'
        title: r.title,
        typeCode: r.type_code,
        typeLabel: r.type_label,
        date: r.activity_date,
        time: r.activity_time,
        durationMinutes: r.duration_minutes,
        notes: r.notes,
        traineeCount: Number(r.trainee_count),
        recordedCount: Number(r.recorded_count),
        // 'single' kind only -- lets the row render/edit/delete without a
        // second round-trip; always null for an 'occasion' row (multiple
        // trainees, see the expand panel's own roster fetch instead).
        studentId: r.student_id,
        studentName: r.student_name,
        studentCode: r.student_code,
        attendanceStatus: r.attendance_status,
      })),
      total: Number(countRows[0].total),
      page: listQuery.page,
      pageSize: listQuery.pageSize,
    });
  })
);

// GET /api/supervisor/activities/summary -- compact top-of-page totals,
// always unfiltered (the caller's whole caseload picture).
router.get(
  "/activities/summary",
  asyncRoute(async (req, res, db) => {
    const summary = await buildActivitiesSummary(db, req.user.id);
    res.json(summary);
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

    const { date, time, durationMinutes, status, title, content, score, attendanceStatus, minutesCompleted } = req.body || {};

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
      if (["present", "absent", "excused", "partial"].includes(attendanceStatus)) {
        if (attendanceStatus === "partial" && !(Number.isFinite(Number(minutesCompleted)) && Number(minutesCompleted) >= 0)) {
          return res.status(400).json({ error: "minutesCompleted is required and must be a non-negative number when attendanceStatus is 'partial'" });
        }
        const minutesToStore = attendanceStatus === "partial" ? Number(minutesCompleted) : null;
        const { rows: attRows } = await db.query("SELECT id FROM attendance WHERE session_id = ?", [recordId]);
        if (attRows.length) {
          await db.query("UPDATE attendance SET status = ?, minutes_completed = ? WHERE session_id = ?", [attendanceStatus, minutesToStore, recordId]);
        } else {
          await db.query(
            `INSERT INTO attendance (student_id, supervisor_id, session_id, attendance_date, status, minutes_completed, recorded_by)
             VALUES (?, ?, ?, (SELECT session_date FROM sessions WHERE id = ?), ?, ?, ?)`,
            [existing.student_id, req.user.id, recordId, recordId, attendanceStatus, minutesToStore, req.user.id]
          );
        }
        await db.query("UPDATE sessions SET status = 'completed' WHERE id = ? AND status = 'scheduled'", [recordId]);
      }
    } else if (recordType === "attendance") {
      await db.query(
        `UPDATE attendance SET attendance_date = COALESCE(?, attendance_date), status = COALESCE(?, status),
          notes = COALESCE(?, notes), minutes_completed = COALESCE(?, minutes_completed) WHERE id = ?`,
        [date ?? null, status ?? null, content ?? null, minutesCompleted ?? null, recordId]
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
             SELECT SUM(CASE WHEN ta.status = 'partial' THEN ta.minutes_completed ELSE ts.duration_minutes END) / 60
             FROM tot_training_sessions ts
             JOIN tot_training_attendance ta ON ta.session_id = ts.id AND ta.status IN ('present', 'partial')
             WHERE ts.tot_id = ? AND ts.status != 'cancelled'
           ), 0) AS session_hours,
           COALESCE((SELECT SUM(hours) FROM tot_hour_adjustments WHERE tot_id = ?), 0) AS adjustment_hours`,
        [totId, totId]
      ),
      db.query(
        `SELECT COUNT(CASE WHEN status IN ('present', 'partial') THEN 1 END) AS present, COUNT(*) AS total
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
    // A Group Session occasion creates one `sessions` row PER ATTENDEE (see
    // migration 024) -- both totalHours and sessionsConducted must count an
    // occasion once, not once per trainee, or a single 2-hour session for
    // 17 trainees reports as 34 hours / 17 sessions instead of 2 hours / 1
    // session. Standalone (non-occasion) sessions are untouched. See
    // computeHoursByType's own version of this same split for the fuller
    // design note.
    const [hoursRes, attendanceRes, traineeRes] = await Promise.all([
      db.query(
        `SELECT COALESCE(SUM(hours), 0) AS hours FROM (
           SELECT CASE WHEN a.status = 'present' THEN s.duration_minutes ELSE COALESCE(a.minutes_completed, 0) END / 60 AS hours
           FROM sessions s
           JOIN attendance a ON a.session_id = s.id AND a.status IN ('present', 'partial')
           WHERE s.supervisor_id = ? AND s.status != 'cancelled' AND s.occasion_id IS NULL

           UNION ALL

           SELECT so.duration_minutes / 60 AS hours
           FROM session_occasions so
           WHERE so.supervisor_id = ?
             AND EXISTS (
               SELECT 1 FROM sessions s2
               JOIN attendance a2 ON a2.session_id = s2.id AND a2.status IN ('present', 'partial')
               WHERE s2.occasion_id = so.id AND s2.status != 'cancelled'
             )
         ) combined`,
        [supervisorId, supervisorId]
      ),
      db.query(
        `SELECT COUNT(CASE WHEN status = 'present' THEN 1 END) AS present, COUNT(*) AS total
         FROM attendance WHERE supervisor_id = ?`,
        [supervisorId]
      ),
      db.query(
        `SELECT COUNT(DISTINCT student_id) AS trainee_count FROM sessions WHERE supervisor_id = ? AND status != 'cancelled'`,
        [supervisorId]
      ),
    ]);
    const h = hoursRes.rows[0];
    const a = attendanceRes.rows[0];
    const t = traineeRes.rows[0];
    const { rows: sessionCountRows } = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM sessions WHERE supervisor_id = ? AND status != 'cancelled' AND occasion_id IS NULL) +
         (SELECT COUNT(*) FROM session_occasions WHERE supervisor_id = ?) AS session_count`,
      [supervisorId, supervisorId]
    );
    t.session_count = sessionCountRows[0].session_count;

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

// POST /api/supervisor/assignments — create an assignment for a Trainer
// (ToT)'s WHOLE current caseload at once (one `assignments` row per
// trainee, looped -- the schema has no group_id of its own, see comment
// above). No trainee picker on the client: every mutation path that ever
// builds supervisor_students (admin.js's group-move logic,
// Mastertrainer.js's per-trainee ToT override) scopes it to exactly one
// Group's roster, so "my caseload" and "my Group's trainees" are always
// the same set today -- the Group you're working in already determines
// who this goes to. Accepts multipart (field "attachment") or plain JSON.
router.post("/assignments", (req, res) => {
  const contentType = req.headers["content-type"] || "";

  const handle = async (attachmentFilename) => {
    const { title, description, dueDate, contentUrl } = req.body || {};
    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: "title is required" });
    }

    const { pool } = require("../db");
    const trainer = await getUserContactInfo(pool, req.user.id);
    const { rows: caseloadRows } = await pool.query(
      "SELECT student_id FROM supervisor_students WHERE supervisor_id = ?",
      [req.user.id]
    );
    const ids = caseloadRows.map((r) => r.student_id);
    if (!ids.length) {
      return res.status(400).json({ error: "You don't have any trainees assigned yet" });
    }

    const created = [];
    for (const studentId of ids) {
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

    res.status(201).json({ createdIds: created });
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

// PUT /api/supervisor/assignments/:id/return  { feedback }
// Sends the trainee's latest submission back for editing instead of
// grading it -- 'returned' is already a legal assignment_submissions.status
// value (see schema), this is just the first route that ever sets it.
// assignments.status goes back to 'submitted' (not 'completed', not
// 'pending') so assignmentRowToApi()'s existing overdue/submitted
// derivation stays accurate; the Trainee UI already renders "For Editing"
// whenever the latest submission's status is 'returned', regardless of
// what the assignment's own top-level status says.
router.put(
  "/assignments/:id/return",
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

    const { feedback } = req.body || {};
    if (!feedback || !feedback.trim()) {
      return res.status(400).json({ error: "Feedback is required when returning an assignment for editing" });
    }
    await db.query(
      `UPDATE assignment_submissions SET feedback = ?, graded_by = ?, graded_at = NOW(), status = 'returned' WHERE id = ?`,
      [feedback, req.user.id, submissionRows[0].id]
    );
    await db.query("UPDATE assignments SET status = 'submitted', updated_at = NOW() WHERE id = ?", [assignmentId]);
    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, new_values) VALUES (?, 'assignment returned for editing', 'assignment_submissions', ?, ?)",
      [req.user.id, submissionRows[0].id, JSON.stringify({ feedback })]
    );
    await createNotification(db, {
      recipientId: assignment.student_id,
      type: "assignment",
      title: `Changes requested on your assignment: ${assignment.title}`,
      body: feedback,
      relatedEntityType: "assignment",
      relatedEntityId: assignmentId,
      email: {
        template: "assignmentReturned",
        data: { assignmentTitle: assignment.title, feedback },
      },
    });

    res.json({ success: true });
  })
);

// ---- Documents -----------------------------------------------------------

// Its own guard instance -- independent from Materials' and Library's --
// so sharing a document and adding a material from the same account never
// block each other.
const documentsUploadGuard = createUploadGuard();

async function findDocumentByIdempotencyKey(pool, idempotencyKey) {
  if (!idempotencyKey) return null;
  const { rows } = await pool.query("SELECT * FROM documents WHERE idempotency_key = ?", [idempotencyKey]);
  return rows[0] || null;
}

router.post("/students/:studentId/documents", (req, res) => {
  if (!documentsUploadGuard.markStarted(req.user.id)) {
    return res.status(409).json({ error: "Upload already in progress." });
  }
  documentUpload.single("document")(req, res, async (err) => {
    if (err) {
      documentsUploadGuard.markFinished(req.user.id);
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ error: "File is too large." });
      }
      return res.status(400).json({ error: err.message });
    }
    // Previously had no try/catch here at all: a thrown error from any of
    // the awaited queries below left the request permanently unanswered
    // (an unhandled rejection -- server.js only logs those, it never sends
    // a response), which read to the user as "my click didn't work" and
    // was the actual root cause of duplicate document shares, not just
    // slowness.
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      const check = checkFileContent(req.file.path, ["pdf", "office", "image"]);
      if (!check.safe) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: check.reason });
      }

      const { pool } = require("../db");
      const studentId = Number(req.params.studentId);
      const idempotencyKey = req.body && req.body.idempotencyKey;

      const existing = await findDocumentByIdempotencyKey(pool, idempotencyKey);
      if (existing) {
        fs.unlink(req.file.path, () => {});
        return res.status(200).json({ ...toDocument({ ...existing, uploaded_by_name: req.user.member_code }), canManage: true });
      }

      const assigned = await pool.query(
        "SELECT 1 FROM supervisor_students WHERE supervisor_id = ? AND student_id = ?",
        [req.user.id, studentId]
      );
      if (!assigned.rows.length) {
        fs.unlink(req.file.path, () => {});
        return res.status(403).json({ error: "You are not assigned to this trainee" });
      }

      await optimizeImageIfPossible(req.file.path, { maxDimension: 1920 });

      // "Share with the whole group" resolves to that trainee's own group --
      // there's no separate group picker, matching the "auto-determine, don't
      // make the user select" convention used elsewhere on this page.
      let insert;
      try {
        if (req.body && (req.body.shareWithGroup === "1" || req.body.shareWithGroup === "true")) {
          const { rows: stuRows } = await pool.query("SELECT group_id FROM students WHERE id = ?", [studentId]);
          const groupId = stuRows[0] && stuRows[0].group_id;
          if (!groupId) {
            fs.unlink(req.file.path, () => {});
            return res.status(400).json({ error: "This trainee has no group to share with" });
          }
          insert = await pool.query(
            `INSERT INTO documents (student_id, group_id, uploaded_by, filename, original_name, idempotency_key) VALUES (NULL,?,?,?,?,?)`,
            [groupId, req.user.id, req.file.filename, req.file.originalname, idempotencyKey || null]
          );
        } else {
          insert = await pool.query(
            `INSERT INTO documents (student_id, uploaded_by, filename, original_name, idempotency_key) VALUES (?,?,?,?,?)`,
            [studentId, req.user.id, req.file.filename, req.file.originalname, idempotencyKey || null]
          );
        }
      } catch (dbErr) {
        if (dbErr.code === "ER_DUP_ENTRY" && idempotencyKey) {
          fs.unlink(req.file.path, () => {});
          const winner = await findDocumentByIdempotencyKey(pool, idempotencyKey);
          if (winner) return res.status(200).json({ ...toDocument({ ...winner, uploaded_by_name: req.user.member_code }), canManage: true });
        }
        throw dbErr;
      }

      const { rows } = await pool.query("SELECT * FROM documents WHERE id = ?", [insert.insertId]);
      res.status(201).json({ ...toDocument({ ...rows[0], uploaded_by_name: req.user.member_code }), canManage: true });
    } catch (e) {
      console.error("POST /students/:studentId/documents failed:", e);
      if (req.file) fs.unlink(req.file.path, () => {});
      if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
    } finally {
      documentsUploadGuard.markFinished(req.user.id);
    }
  });
});

// POST /api/supervisor/documents -- share a document with the caller's
// WHOLE Group by default (no trainee picker needed: a Trainer/Master
// Trainer only ever has one Group, see the comment on POST /assignments),
// or with one specific ToT in that Group via targetSupervisorId (checked
// server-side against real group membership, never trusted from the
// client). Replaces the old "pick a trainee, then optionally check 'share
// with group instead'" flow for the general Add-a-Document action -- the
// per-trainee upload (POST /students/:studentId/documents, above) still
// exists unchanged for a document meant for just one trainee.
router.post("/documents", (req, res) => {
  if (!documentsUploadGuard.markStarted(req.user.id)) {
    return res.status(409).json({ error: "Upload already in progress." });
  }
  documentUpload.single("document")(req, res, async (err) => {
    if (err) {
      documentsUploadGuard.markFinished(req.user.id);
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ error: "File is too large." });
      }
      return res.status(400).json({ error: err.message });
    }
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      const check = checkFileContent(req.file.path, ["pdf", "office", "image"]);
      if (!check.safe) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: check.reason });
      }

      const { pool } = require("../db");
      const idempotencyKey = req.body && req.body.idempotencyKey;
      const targetSupervisorId = req.body && req.body.targetSupervisorId;

      const existing = await findDocumentByIdempotencyKey(pool, idempotencyKey);
      if (existing) {
        fs.unlink(req.file.path, () => {});
        return res.status(200).json({ ...toDocument({ ...existing, uploaded_by_name: req.user.member_code }), canManage: true });
      }

      const { rows: meRows } = await pool.query("SELECT group_id FROM supervisors WHERE id = ?", [req.user.id]);
      const groupId = meRows[0] && meRows[0].group_id;
      if (!groupId) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: "You don't have a Group assigned yet" });
      }

      // Sharing with one specific ToT instead of the whole Group -- that
      // ToT must actually belong to the caller's own Group; never trust a
      // client-supplied id without checking it against real membership.
      let finalGroupId = groupId;
      let finalTargetSupervisorId = null;
      if (targetSupervisorId) {
        const { rows: targetRows } = await pool.query(
          "SELECT id FROM supervisors WHERE id = ? AND group_id = ? AND supervisor_type = 'in_training'",
          [targetSupervisorId, groupId]
        );
        if (!targetRows.length) {
          fs.unlink(req.file.path, () => {});
          return res.status(403).json({ error: "That Trainer (ToT) is not in your Group" });
        }
        finalGroupId = null;
        finalTargetSupervisorId = targetSupervisorId;
      }

      await optimizeImageIfPossible(req.file.path, { maxDimension: 1920 });

      let insert;
      try {
        insert = await pool.query(
          `INSERT INTO documents (student_id, group_id, shared_with_supervisor_id, uploaded_by, filename, original_name, idempotency_key) VALUES (NULL,?,?,?,?,?,?)`,
          [finalGroupId, finalTargetSupervisorId, req.user.id, req.file.filename, req.file.originalname, idempotencyKey || null]
        );
      } catch (dbErr) {
        if (dbErr.code === "ER_DUP_ENTRY" && idempotencyKey) {
          fs.unlink(req.file.path, () => {});
          const winner = await findDocumentByIdempotencyKey(pool, idempotencyKey);
          if (winner) return res.status(200).json({ ...toDocument({ ...winner, uploaded_by_name: req.user.member_code }), canManage: true });
        }
        throw dbErr;
      }

      const { rows } = await pool.query("SELECT * FROM documents WHERE id = ?", [insert.insertId]);
      res.status(201).json({ ...toDocument({ ...rows[0], uploaded_by_name: req.user.member_code }), canManage: true });
    } catch (e) {
      console.error("POST /documents failed:", e);
      if (req.file) fs.unlink(req.file.path, () => {});
      if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
    } finally {
      documentsUploadGuard.markFinished(req.user.id);
    }
  });
});

// PUT /api/supervisor/documents/:id (multipart, field "document") -- Change
// File. Only the supervisor who uploaded a document may replace its file;
// the row itself (id, sharing target, approval state) is left exactly as
// it is. A Master Trainer can technically reach this route too (the whole
// router requires only requireSupervisor), but can never satisfy the
// uploaded_by check since MT has no upload path anywhere in the app.
router.put("/documents/:id", (req, res) => {
  documentUpload.single("document")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const cleanup = () => fs.unlink(req.file.path, () => {});

    const check = checkFileContent(req.file.path, ["pdf", "office", "image"]);
    if (!check.safe) {
      cleanup();
      return res.status(400).json({ error: check.reason });
    }

    try {
      const { pool } = require("../db");
      const docId = Number(req.params.id);
      const { rows } = await pool.query("SELECT uploaded_by, filename FROM documents WHERE id = ?", [docId]);
      if (!rows.length) {
        cleanup();
        return res.status(404).json({ error: "Document not found" });
      }
      if (Number(rows[0].uploaded_by) !== Number(req.user.id)) {
        cleanup();
        return res.status(403).json({ error: "You can only replace a file you uploaded" });
      }

      await optimizeImageIfPossible(req.file.path, { maxDimension: 1920 });

      const previousFilename = rows[0].filename;
      await pool.query("UPDATE documents SET filename = ?, original_name = ? WHERE id = ?", [
        req.file.filename,
        req.file.originalname,
        docId,
      ]);
      fs.unlink(path.join(config.uploadsDir, "documents", previousFilename), (unlinkErr) => {
        if (unlinkErr && unlinkErr.code !== "ENOENT") console.error("Failed to remove replaced document file:", unlinkErr);
      });

      const { rows: updated } = await pool.query(`${DOCUMENT_SELECT} WHERE d.id = ?`, [docId]);
      res.json({ ...toDocument(updated[0]), canManage: true });
    } catch (e) {
      console.error("[supervisor] failed to replace document file:", e);
      cleanup();
      res.status(500).json({ error: "Internal server error" });
    }
  });
});

// DELETE /api/supervisor/documents/:id -- only the supervisor who uploaded a
// document may delete it. Mirrors admin.js's DELETE /admin/documents/:id
// (DB row + file on disk + audit log), scoped to the uploader instead of
// Admin's unrestricted access.
router.delete(
  "/documents/:id",
  asyncRoute(async (req, res, db) => {
    const docId = Number(req.params.id);
    if (!docId) return res.status(400).json({ error: "Invalid document id" });

    const { rows } = await db.query("SELECT uploaded_by, filename FROM documents WHERE id = ?", [docId]);
    if (!rows.length) return res.status(404).json({ error: "Document not found" });
    if (Number(rows[0].uploaded_by) !== Number(req.user.id)) {
      return res.status(403).json({ error: "You can only delete a document you uploaded" });
    }

    await db.query("DELETE FROM documents WHERE id = ?", [docId]);
    fs.unlink(path.join(config.uploadsDir, "documents", rows[0].filename), (err) => {
      if (err && err.code !== "ENOENT") console.error("Failed to delete document file:", err);
    });
    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES (?, 'document_deleted', 'documents', ?)",
      [req.user.id, docId]
    );

    res.json({ success: true });
  })
);

// GET /api/supervisor/group-documents -- a ToT's (or MT's) review queue for
// their own Group: every document shared with that Group, pending AND
// approved, regardless of whether the uploading trainee is in this
// supervisor's personal caseload (GET /students/:studentId is caseload-
// gated and can't see a group-mate outside that caseload -- this is the
// one place a supervisor sees the whole Group's shared documents).
router.get(
  "/group-documents",
  asyncRoute(async (req, res, db) => {
    const { rows: meRows } = await db.query("SELECT group_id FROM supervisors WHERE id = ?", [req.user.id]);
    const groupId = meRows[0] && meRows[0].group_id;
    if (!groupId) return res.json({ documents: [] });

    const { rows } = await db.query(
      `${DOCUMENT_SELECT}
       WHERE d.group_id = ? OR d.shared_with_supervisor_id = ?
       ORDER BY d.created_at DESC LIMIT 500`,
      [groupId, req.user.id]
    );
    res.json({
      documents: rows.map((r) => ({ ...toDocument(r), canManage: Number(r.uploaded_by) === Number(req.user.id) })),
    });
  })
);

// POST /api/supervisor/documents/:id/approve -- ANY ONE ToT responsible for
// the document's Group (supervisor_type='in_training' AND their own
// group_id matches the document's group_id) can approve it; a Master
// Trainer or a ToT from a different Group cannot. The state change is one
// atomic UPDATE guarded by `approval_status = 'pending'` in its own WHERE
// clause -- two ToTs racing to approve the same document can never both
// "win": MySQL/InnoDB serializes the two UPDATEs, the first flips the row
// and the second's WHERE no longer matches (affectedRows = 0), so it's
// reported the real current state instead of erroring or double-applying.
router.post(
  "/documents/:id/approve",
  asyncRoute(async (req, res, db) => {
    const docId = Number(req.params.id);
    if (!docId) return res.status(400).json({ error: "Invalid document id" });

    const { rows: meRows } = await db.query(
      "SELECT group_id, supervisor_type FROM supervisors WHERE id = ?",
      [req.user.id]
    );
    const me = meRows[0];
    if (!me || me.supervisor_type !== "in_training") {
      return res.status(403).json({ error: "Only a Trainer (ToT) can approve a shared document" });
    }
    if (!me.group_id) {
      return res.status(403).json({ error: "You don't belong to a Group" });
    }

    // Existence and group-membership are checked explicitly (and
    // separately) so a wrong-group ToT gets a clear 403 rather than a 404
    // that could be misread as "no such document".
    const { rows: docRows } = await db.query("SELECT group_id FROM documents WHERE id = ?", [docId]);
    if (!docRows.length) return res.status(404).json({ error: "Document not found" });
    if (Number(docRows[0].group_id) !== Number(me.group_id)) {
      return res.status(403).json({ error: "This document doesn't belong to your Group" });
    }

    const result = await db.query(
      `UPDATE documents SET approval_status = 'approved', approved_by = ?, approved_at = NOW()
       WHERE id = ? AND group_id = ? AND approval_status = 'pending'`,
      [req.user.id, docId, me.group_id]
    );

    // FOR UPDATE, not a plain SELECT: this whole handler runs inside one
    // REPEATABLE READ transaction (see asyncRoute), where a plain read
    // uses the snapshot taken at the transaction's FIRST query -- stale
    // if a concurrent ToT's approval committed in between. A locking read
    // forces a "current read" of the latest committed row instead, which
    // is what lets a losing racer correctly report who actually won.
    const { rows } = await db.query(
      `SELECT d.*, apsup.full_name AS approved_by_name
       FROM documents d LEFT JOIN supervisors apsup ON apsup.id = d.approved_by
       WHERE d.id = ?
       FOR UPDATE`,
      [docId]
    );

    if (result.affectedRows > 0) {
      await db.query(
        "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES (?, 'document_approved', 'documents', ?)",
        [req.user.id, docId]
      );
    }
    res.json(toDocument(rows[0]));
  })
);

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

// Marks this conversation read (the incoming messages + their matching
// notification) UNLESS called with ?peek=1 -- see profile.js's mirror of
// this same endpoint for the full reasoning. peek=1 exists specifically for
// loadChatInbox()'s preview-snippet loop below, which fetches every
// conversation just to show its last message and must never mark anything
// read just because the inbox *list* was viewed -- only actually opening a
// conversation should.
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

    if (req.query.peek !== "1") {
      await db.query("UPDATE messages SET is_read = TRUE WHERE chat_id = ? AND sender_id != ? AND is_read = FALSE", [
        chatId,
        req.user.id,
      ]);
      await db.query(
        `UPDATE notifications SET is_read = TRUE
         WHERE recipient_id = ? AND notification_type = 'message' AND related_entity_id = ? AND is_read = FALSE`,
        [req.user.id, studentId]
      );
    }

    res.json({ messages: rows.map((r) => toMessage(r, req.user.id)) });
  })
);

// GET /api/supervisor/messages/unread-count -- see profile.js's mirror for
// the full reasoning (same notifications-table-backed count, never
// week-scoped).
router.get(
  "/messages/unread-count",
  asyncRoute(async (req, res, db) => {
    const { rows } = await db.query(
      "SELECT COUNT(*) AS count FROM notifications WHERE recipient_id = ? AND notification_type = 'message' AND is_read = FALSE",
      [req.user.id]
    );
    res.json({ count: Number(rows[0].count) });
  })
);

// GET /api/supervisor/messages/unread-by-sender -- per-conversation unread
// counts (which trainee(s) sent something unread, and how many), for the
// small red badge shown next to each conversation in the inbox list --
// distinct from the single aggregate total above. Purely a read: never
// marks anything as read itself.
router.get(
  "/messages/unread-by-sender",
  asyncRoute(async (req, res, db) => {
    const { rows } = await db.query(
      `SELECT related_entity_id AS sender_id, COUNT(*) AS count FROM notifications
       WHERE recipient_id = ? AND notification_type = 'message' AND is_read = FALSE
       GROUP BY related_entity_id`,
      [req.user.id]
    );
    const counts = {};
    rows.forEach((r) => {
      counts[r.sender_id] = Number(r.count);
    });
    res.json({ counts });
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
    const message = toMessage({ ...rows[0], sender_name: req.user.member_code }, req.user.id);

    // Notification + live delivery for the trainee. relatedEntityId is this
    // supervisor's own id -- exactly what the trainee's UI needs to open
    // this conversation with one call, and the same id GET
    // .../messages/:supervisorId above marks read by.
    try {
      const { rows: meRows } = await db.query("SELECT full_name FROM supervisors WHERE id = ?", [req.user.id]);
      const supervisorName = (meRows[0] && meRows[0].full_name) || req.user.member_code;
      await createNotification(db, {
        recipientId: studentId,
        type: "message",
        title: `${supervisorName} sent you a message`,
        body: content.trim().slice(0, 140),
        relatedEntityType: "message",
        relatedEntityId: req.user.id,
      });
      broadcastDirectMessage(req.app.get("io"), chatId, { ...message, isMine: false, senderId: req.user.id }).catch(() => {});
    } catch (notifyErr) {
      console.error("[supervisor] failed to notify trainee of new message:", notifyErr);
    }

    res.status(201).json(message);
  })
);

// ---- Message my own Master Trainer -----------------------------------
// A ToT's Master Trainer is one more Direct Message contact alongside
// their trainees, in the same inbox UI -- but the chats/messages tables
// used for trainee conversations above have typed student_id/supervisor_id
// FKs that structurally cannot hold a supervisor-to-supervisor pair (see
// migration 023's comment on chat_rooms.is_direct). This reuses that same
// generic, already-built Direct Chat infrastructure (chat_rooms +
// chat_room_members + chat_room_messages) instead of duplicating a second
// messaging system, just addressed by "my Master Trainer" rather than a
// room id the client already knows.

/** Resolves this ToT's own Master Trainer (their Group's supervisor_type='primary' row), or null if no Group is assigned yet. */
async function loadMyMasterTrainer(db, totId) {
  const { rows } = await db.query(
    `SELECT mt.id, mt.full_name, mt.email, mt.phone, mt.photo
     FROM supervisors tot
     JOIN supervisors mt ON mt.group_id = tot.group_id AND mt.supervisor_type = 'primary'
     WHERE tot.id = ?`,
    [totId]
  );
  return rows[0] || null;
}

/** Find-or-create the Direct Chat room between this ToT and their Master Trainer -- same shape as POST /api/chat-rooms/direct. */
async function getOrCreateMasterTrainerRoom(db, totId, masterTrainerId, groupId) {
  const { rows: existing } = await db.query(
    `SELECT cr.id FROM chat_rooms cr
       JOIN chat_room_members m1 ON m1.room_id = cr.id AND m1.user_id = ?
       JOIN chat_room_members m2 ON m2.room_id = cr.id AND m2.user_id = ?
      WHERE cr.is_direct = TRUE
      LIMIT 1`,
    [totId, masterTrainerId]
  );
  if (existing.length) return existing[0].id;

  const { rows: nameRows } = await db.query("SELECT full_name FROM supervisors WHERE id = ?", [masterTrainerId]);
  const name = (nameRows[0] && nameRows[0].full_name) || "Direct message";
  const room = await db.query("INSERT INTO chat_rooms (name, created_by, group_id, is_direct) VALUES (?, ?, ?, TRUE)", [
    name,
    totId,
    groupId,
  ]);
  const roomId = room.insertId;
  await db.query("INSERT INTO chat_room_members (room_id, user_id, added_by) VALUES (?, ?, ?)", [roomId, totId, totId]);
  await db.query("INSERT INTO chat_room_members (room_id, user_id, added_by) VALUES (?, ?, ?)", [roomId, masterTrainerId, totId]);
  return roomId;
}

// GET /api/supervisor/master-trainer -- this ToT's own Master Trainer's
// contact info, or { masterTrainer: null } if no Group is assigned yet.
router.get(
  "/master-trainer",
  asyncRoute(async (req, res, db) => {
    const mt = await loadMyMasterTrainer(db, req.user.id);
    res.json({
      masterTrainer: mt && {
        id: mt.id,
        fullName: mt.full_name,
        email: mt.email,
        phone: mt.phone,
        photo: mt.photo,
      },
    });
  })
);

// GET /api/supervisor/master-trainer/messages?peek=1
router.get(
  "/master-trainer/messages",
  asyncRoute(async (req, res, db) => {
    const { rows: meRows } = await db.query("SELECT group_id FROM supervisors WHERE id = ?", [req.user.id]);
    const groupId = meRows.length ? meRows[0].group_id : null;
    const mt = await loadMyMasterTrainer(db, req.user.id);
    if (!groupId || !mt) return res.status(404).json({ error: "No Master Trainer assigned yet" });

    const roomId = await getOrCreateMasterTrainerRoom(db, req.user.id, mt.id, groupId);
    const { rows } = await db.query(
      `SELECT m.*, COALESCE(sup.full_name, st.full_name) AS sender_name FROM chat_room_messages m
       LEFT JOIN supervisors sup ON sup.id = m.sender_id
       LEFT JOIN students st ON st.id = m.sender_id
       WHERE m.room_id = ? ORDER BY m.created_at ASC`,
      [roomId]
    );

    if (req.query.peek !== "1") {
      await db.query("UPDATE chat_room_members SET last_read_at = NOW() WHERE room_id = ? AND user_id = ?", [
        roomId,
        req.user.id,
      ]);
      await db.query(
        `UPDATE notifications SET is_read = TRUE
         WHERE recipient_id = ? AND notification_type = 'message' AND related_entity_id = ? AND is_read = FALSE`,
        [req.user.id, mt.id]
      );
    }

    res.json({ messages: rows.map((r) => toMessage(r, req.user.id)) });
  })
);

router.post(
  "/master-trainer/messages",
  asyncRoute(async (req, res, db) => {
    const { rows: meRows } = await db.query("SELECT group_id FROM supervisors WHERE id = ?", [req.user.id]);
    const groupId = meRows.length ? meRows[0].group_id : null;
    const mt = await loadMyMasterTrainer(db, req.user.id);
    if (!groupId || !mt) return res.status(404).json({ error: "No Master Trainer assigned yet" });

    const { content } = req.body || {};
    if (!content || !String(content).trim()) {
      return res.status(400).json({ error: "Message content is required" });
    }

    const roomId = await getOrCreateMasterTrainerRoom(db, req.user.id, mt.id, groupId);
    const insert = await db.query(
      "INSERT INTO chat_room_messages (room_id, sender_id, content) VALUES (?, ?, ?)",
      [roomId, req.user.id, content.trim()]
    );
    await db.query("UPDATE chat_room_members SET last_read_at = NOW() WHERE room_id = ? AND user_id = ?", [
      roomId,
      req.user.id,
    ]);

    const { rows } = await db.query("SELECT * FROM chat_room_messages WHERE id = ?", [insert.insertId]);
    const message = toMessage({ ...rows[0], sender_name: req.user.member_code }, req.user.id);

    try {
      const { rows: mine } = await db.query("SELECT full_name FROM supervisors WHERE id = ?", [req.user.id]);
      const myName = (mine[0] && mine[0].full_name) || req.user.member_code;
      await createNotification(db, {
        recipientId: mt.id,
        type: "message",
        title: `${myName} sent you a message`,
        body: content.trim().slice(0, 140),
        relatedEntityType: "message",
        relatedEntityId: req.user.id,
      });
      broadcastMessage(req.app.get("io"), roomId, { ...message, senderId: req.user.id }).catch(() => {});
    } catch (notifyErr) {
      console.error("[supervisor] failed to notify Master Trainer of new message:", notifyErr);
    }

    res.status(201).json(message);
  })
);

// ---- Learning materials --------------------------------------------------
// Mirrors learning_materials.material_type's own CHECK constraint (schema),
// minus 'link' -- that value only ever goes through the externalUrl branch
// below, never the file-upload one this list validates.
const MATERIAL_TYPES = ["document", "image", "video", "audio", "assignment", "worksheet", "reading"];

// Blocks a double-click/rapid-repeat Add-Material submit from the SAME
// account before a second request even starts streaming a file to disk.
// Its own guard instance -- independent from Library's -- so adding a
// material and uploading a book from the same account never block each
// other. This is the fast, immediate line of defense; idempotencyKey
// (below) is what makes duplicate PREVENTION actually correct at the
// database level even if this in-memory check is ever bypassed (a
// deployment with more than one Node process, a retried request that
// arrives after the lock already cleared, etc).
const materialsUploadGuard = createUploadGuard();

router.get(
  "/materials",
  asyncRoute(async (req, res, db) => {
    const { rows } = await db.query(
      `SELECT lm.*, author_sup.full_name AS supervisor_name,
              tg.name AS shared_group_name,
              shsup.full_name AS shared_supervisor_name, shsup.supervisor_type AS shared_supervisor_type,
              (SELECT a.id FROM assignments a
                WHERE a.student_id = lm.student_id AND a.supervisor_id = lm.supervisor_id
                  AND LOWER(a.title) = LOWER(lm.title)
                ORDER BY a.id DESC LIMIT 1) AS matched_assignment_id
       FROM learning_materials lm
       JOIN supervisors author_sup ON author_sup.id = lm.supervisor_id
       LEFT JOIN trainer_groups tg ON tg.id = lm.group_id
       LEFT JOIN supervisors shsup ON shsup.id = lm.shared_with_supervisor_id
       WHERE lm.material_type != 'book'
         AND (
           lm.supervisor_id = ?
           OR lm.shared_with_supervisor_id = ?
           OR lm.group_id = (SELECT group_id FROM supervisors WHERE id = ?)
         )
       ORDER BY lm.created_at DESC
       LIMIT 200`,
      [req.user.id, req.user.id, req.user.id]
    );
    res.json({
      materials: rows.map((r) => ({ ...toMaterial(r), canDelete: Number(r.supervisor_id) === Number(req.user.id) })),
    });
  })
);

/**
 * Notifies whoever a newly-added material is relevant to: just the one
 * trainee if the material was scoped to them, or the supervisor's whole
 * current caseload if it wasn't (materials with no studentId are shared
 * with every assigned trainee -- see the materials-feed read side).
 *
 * Deliberately called WITHOUT awaiting it before responding to the client
 * (see the two call sites below) -- this fan-out was previously the main
 * cause of "Add/Share takes several seconds": one caseload of N trainees
 * meant N sequential awaited notification inserts (each itself 2-3 DB
 * round trips) before the HTTP response was ever sent. The material is
 * already fully committed by the time this runs, so a slow or partially
 * failed notification run can never affect whether the material exists or
 * looks duplicated -- it can only affect how quickly people are told about
 * it, which is why it's safe to move off the response's critical path.
 * Uses allSettled (not a sequential loop or Promise.all) so one
 * recipient's failed notification can't stop the others from going out.
 */
/**
 * Resolves an optional Materials-sharing target beyond the existing
 * trainee-facing studentId/whole-caseload convention: share with one
 * specific ToT (targetSupervisorId, checked against real Group membership
 * -- never trusted from the client) or the caller's whole Group
 * (shareWithGroup, always derived from the caller's own row, never a
 * client-supplied group id). Mirrors POST /documents' identical guard.
 * Returns { groupId, sharedWithSupervisorId } (both null for the existing
 * trainee-targeted/whole-caseload behavior) or { error, status }.
 */
async function resolveMaterialTarget(pool, callerId, targetSupervisorId, shareWithGroup) {
  if (targetSupervisorId) {
    const { rows: meRows } = await pool.query("SELECT group_id FROM supervisors WHERE id = ?", [callerId]);
    const myGroupId = meRows[0] && meRows[0].group_id;
    const { rows: targetRows } = await pool.query(
      "SELECT id FROM supervisors WHERE id = ? AND group_id = ? AND supervisor_type = 'in_training'",
      [targetSupervisorId, myGroupId]
    );
    if (!targetRows.length) return { error: "That Trainer (ToT) is not in your Group", status: 403 };
    return { groupId: null, sharedWithSupervisorId: targetSupervisorId };
  }
  if (shareWithGroup) {
    const { rows: meRows } = await pool.query("SELECT group_id FROM supervisors WHERE id = ?", [callerId]);
    const myGroupId = meRows[0] && meRows[0].group_id;
    if (!myGroupId) return { error: "You don't have a Group assigned yet", status: 400 };
    return { groupId: myGroupId, sharedWithSupervisorId: null };
  }
  return { groupId: null, sharedWithSupervisorId: null };
}

async function notifyMaterialRecipients(pool, supervisorId, studentId, materialTitle, materialId, target) {
  const trainer = await getUserContactInfo(pool, supervisorId);
  const trainerName = (trainer && trainer.fullName) || "Your trainer";
  let recipientIds;
  if (target && target.sharedWithSupervisorId) {
    recipientIds = [Number(target.sharedWithSupervisorId)];
  } else if (target && target.groupId) {
    const { rows } = await pool.query(
      "SELECT id FROM supervisors WHERE group_id = ? AND supervisor_type = 'in_training'",
      [target.groupId]
    );
    recipientIds = rows.map((r) => r.id);
  } else if (studentId) {
    recipientIds = [Number(studentId)];
  } else {
    const { rows } = await pool.query("SELECT student_id FROM supervisor_students WHERE supervisor_id = ?", [supervisorId]);
    recipientIds = rows.map((r) => r.student_id);
  }
  const results = await Promise.allSettled(
    recipientIds.map((recipientId) =>
      createNotification(pool, {
        recipientId,
        type: "document",
        title: `New material: ${materialTitle}`,
        relatedEntityType: "learning_material",
        relatedEntityId: materialId,
        email: { template: "newMaterial", data: { materialTitle, trainerName } },
      })
    )
  );
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length) {
    console.error(
      `notifyMaterialRecipients: ${failed.length}/${recipientIds.length} notifications failed for material ${materialId}`,
      failed.map((f) => f.reason)
    );
  }
}

/**
 * Looks up a material by its client-supplied idempotency key. The
 * frontend generates one UUID per logical Add/Share attempt and resends
 * the SAME key on every retry of that attempt (double-click, browser
 * retry, slow-network resubmit) -- if a row already exists for that key,
 * the earlier attempt already succeeded, so the correct response to a
 * retry is that SAME material, not a new one and not an error.
 */
async function findByIdempotencyKey(pool, idempotencyKey) {
  if (!idempotencyKey) return null;
  const { rows } = await pool.query("SELECT * FROM learning_materials WHERE idempotency_key = ?", [idempotencyKey]);
  return rows[0] || null;
}

router.post("/materials", (req, res) => {
  const contentType = req.headers["content-type"] || "";
  const { pool } = require("../db");

  if (contentType.includes("multipart/form-data")) {
    // Checked BEFORE multer starts streaming the file to disk, so a
    // double-click's second request is rejected almost instantly instead
    // of after wastefully uploading the whole file again.
    if (!materialsUploadGuard.markStarted(req.user.id)) {
      return res.status(409).json({ error: "Upload already in progress." });
    }
    materialUpload.single("file")(req, res, async (err) => {
      if (err) {
        materialsUploadGuard.markFinished(req.user.id);
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({ error: `File is too large. The maximum allowed size is ${config.materialUploadMaxMb}MB.` });
        }
        return res.status(400).json({ error: err.message });
      }
      // Everything from here on always reaches the finally block below,
      // so a thrown error (a DB blip, anything unexpected) still sends a
      // real response instead of leaving the request hanging forever --
      // that silent hang, not just slowness, was what made users think
      // their click "didn't work" and click Add/Share again.
      try {
        const { title, description, materialType, studentId, idempotencyKey, targetSupervisorId, shareWithGroup } = req.body || {};
        if (!title || !materialType) {
          fs.unlink(req.file.path, () => {});
          return res.status(400).json({ error: "title and materialType are required" });
        }
        // The schema's own CHECK constraint on learning_materials.material_type
        // is silently unenforced on MySQL below 8.0.16 (its own header
        // comment says so) -- this route never validated independently, so a
        // bad value would either fail with a raw DB error on a version that
        // does enforce it, or corrupt the column silently on one that doesn't.
        if (!MATERIAL_TYPES.includes(materialType)) {
          fs.unlink(req.file.path, () => {});
          return res.status(400).json({ error: `materialType must be one of: ${MATERIAL_TYPES.join(", ")}` });
        }

        const existing = await findByIdempotencyKey(pool, idempotencyKey);
        if (existing) {
          fs.unlink(req.file.path, () => {});
          return res.status(200).json(toMaterial({ ...existing, supervisor_name: req.user.member_code }));
        }

        // Share with one specific ToT, or the caller's whole Group, instead
        // of the trainee-facing studentId/whole-caseload targeting -- see
        // resolveMaterialTarget's comment.
        const target = await resolveMaterialTarget(pool, req.user.id, targetSupervisorId, shareWithGroup);
        if (target.error) {
          fs.unlink(req.file.path, () => {});
          return res.status(target.status).json({ error: target.error });
        }

        const check = checkFileContent(req.file.path, ["pdf", "office", "image", "media"]);
        if (!check.safe) {
          fs.unlink(req.file.path, () => {});
          return res.status(400).json({ error: check.reason });
        }
        await optimizeImageIfPossible(req.file.path, { maxDimension: 1920 });
        const fileHash = await hashFile(req.file.path);

        const finalStudentId = target.groupId || target.sharedWithSupervisorId ? null : studentId || null;
        let insert;
        try {
          insert = await pool.query(
            `INSERT INTO learning_materials (supervisor_id, student_id, group_id, shared_with_supervisor_id, title, description, material_type, filename, original_name, file_hash, idempotency_key)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            [req.user.id, finalStudentId, target.groupId, target.sharedWithSupervisorId, title, description || null, materialType, req.file.filename, req.file.originalname, fileHash, idempotencyKey || null]
          );
        } catch (dbErr) {
          // Lost a race against a near-simultaneous request carrying the
          // SAME idempotency key (both passed the findByIdempotencyKey
          // check above before either committed) -- the database's own
          // unique constraint is what actually closes that race; return
          // the winner's row instead of a confusing duplicate-key error.
          if (dbErr.code === "ER_DUP_ENTRY" && idempotencyKey) {
            fs.unlink(req.file.path, () => {});
            const winner = await findByIdempotencyKey(pool, idempotencyKey);
            if (winner) return res.status(200).json(toMaterial({ ...winner, supervisor_name: req.user.member_code }));
          }
          throw dbErr;
        }

        const { rows } = await pool.query("SELECT * FROM learning_materials WHERE id = ?", [insert.insertId]);
        await pool.query(
          "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES (?, 'material added', 'learning_materials', ?)",
          [req.user.id, insert.insertId]
        );
        res.status(201).json(toMaterial({ ...rows[0], supervisor_name: req.user.member_code }));
        notifyMaterialRecipients(pool, req.user.id, finalStudentId, title, insert.insertId, target).catch((notifyErr) => {
          console.error("Failed to notify material recipients:", notifyErr);
        });
      } catch (e) {
        console.error("POST /materials failed:", e);
        if (req.file) fs.unlink(req.file.path, () => {});
        if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
      } finally {
        materialsUploadGuard.markFinished(req.user.id);
      }
    });
    return;
  }

  (async () => {
    if (!materialsUploadGuard.markStarted(req.user.id)) {
      return res.status(409).json({ error: "Upload already in progress." });
    }
    try {
      const { title, description, materialType, externalUrl, studentId, idempotencyKey, targetSupervisorId, shareWithGroup } = req.body || {};
      if (!title || materialType !== "link" || !externalUrl) {
        return res.status(400).json({ error: "For non-file materials, materialType must be 'link' and externalUrl is required" });
      }

      const existing = await findByIdempotencyKey(pool, idempotencyKey);
      if (existing) {
        return res.status(200).json(toMaterial({ ...existing, supervisor_name: req.user.member_code }));
      }

      const target = await resolveMaterialTarget(pool, req.user.id, targetSupervisorId, shareWithGroup);
      if (target.error) return res.status(target.status).json({ error: target.error });
      const finalStudentId = target.groupId || target.sharedWithSupervisorId ? null : studentId || null;

      let insert;
      try {
        insert = await pool.query(
          `INSERT INTO learning_materials (supervisor_id, student_id, group_id, shared_with_supervisor_id, title, description, material_type, external_url, idempotency_key)
           VALUES (?,?,?,?,?,?,'link',?,?)`,
          [req.user.id, finalStudentId, target.groupId, target.sharedWithSupervisorId, title, description || null, externalUrl, idempotencyKey || null]
        );
      } catch (dbErr) {
        if (dbErr.code === "ER_DUP_ENTRY" && idempotencyKey) {
          const winner = await findByIdempotencyKey(pool, idempotencyKey);
          if (winner) return res.status(200).json(toMaterial({ ...winner, supervisor_name: req.user.member_code }));
        }
        throw dbErr;
      }

      const { rows } = await pool.query("SELECT * FROM learning_materials WHERE id = ?", [insert.insertId]);
      await pool.query(
        "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES (?, 'material added', 'learning_materials', ?)",
        [req.user.id, insert.insertId]
      );
      res.status(201).json(toMaterial({ ...rows[0], supervisor_name: req.user.member_code }));
      notifyMaterialRecipients(pool, req.user.id, finalStudentId, title, insert.insertId, target).catch((notifyErr) => {
        console.error("Failed to notify material recipients:", notifyErr);
      });
    } catch (err) {
      console.error("POST /materials (link) failed:", err);
      if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
    } finally {
      materialsUploadGuard.markFinished(req.user.id);
    }
  })();
});

router.delete(
  "/materials/:materialId",
  asyncRoute(async (req, res, db) => {
    const { rows: existingRows } = await db.query(
      "SELECT * FROM learning_materials WHERE id = ? AND supervisor_id = ? AND material_type != 'book'",
      [req.params.materialId, req.user.id]
    );
    if (!existingRows.length) return res.status(404).json({ error: "Material not found" });

    // Re-asserting supervisor_id here (not just id) means this statement's
    // own safety no longer depends on the SELECT above never changing --
    // each is independently scoped to the caller's own materials.
    await db.query("DELETE FROM learning_materials WHERE id = ? AND supervisor_id = ?", [req.params.materialId, req.user.id]);
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
    // A meeting the caller organized always has organizerName === null
    // (it's their own) -- set only when this meeting was created BY
    // someone else and targeted at the viewer (their Master Trainer, via
    // targetSupervisorId or targetGroupId).
    organizerName: row.organizer_name || null,
    targetSupervisorId: row.target_supervisor_id || null,
    targetSupervisorName: row.target_supervisor_name || null,
    isGroupMeeting: row.target_group_id != null,
    createdAt: row.created_at,
  };
}

// GET /api/supervisor/meetings -- every meeting the caller organized,
// PLUS (added alongside Master Trainer meeting creation) any meeting
// someone else targeted directly at them or at their whole Group.
router.get(
  "/meetings",
  asyncRoute(async (req, res, db) => {
    const { rows } = await db.query(
      `SELECT m.*, st.full_name AS student_name,
              tsup.full_name AS target_supervisor_name,
              osup.full_name AS organizer_name
         FROM meetings m
         LEFT JOIN students st ON st.id = m.student_id
         LEFT JOIN supervisors tsup ON tsup.id = m.target_supervisor_id
         LEFT JOIN supervisors osup ON osup.id = m.supervisor_id AND osup.id != ?
        WHERE m.supervisor_id = ?
           OR m.target_supervisor_id = ?
           OR m.target_group_id = (SELECT group_id FROM supervisors WHERE id = ?)
        ORDER BY (m.scheduled_at IS NULL), m.scheduled_at ASC`,
      [req.user.id, req.user.id, req.user.id, req.user.id]
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
// -- or, for a meeting with no trainee at all: { targetSupervisorId } (one
// specific ToT in the caller's own Group) or { shareWithGroup: true } (the
// caller's whole Group). shareWithGroup never trusts a client-supplied
// group id -- it's always derived from the caller's own row, exactly like
// POST /documents above.
router.post(
  "/meetings",
  asyncRoute(async (req, res, db) => {
    const { title, studentId, platform, meetingUrl, scheduledAt, durationMinutes, targetSupervisorId, shareWithGroup } = req.body || {};
    if (!title || !meetingUrl) return res.status(400).json({ error: "title and meetingUrl are required" });
    if (!isValidMeetingUrl(meetingUrl)) {
      return res.status(400).json({ error: "meetingUrl must be a valid http:// or https:// link" });
    }
    if (!["zoom", "teams", "meet", "other"].includes(platform)) {
      return res.status(400).json({ error: "platform must be one of: zoom, teams, meet, other" });
    }

    let finalStudentId = null;
    let finalTargetGroupId = null;
    let finalTargetSupervisorId = null;

    if (targetSupervisorId) {
      const { rows: meRows } = await db.query("SELECT group_id FROM supervisors WHERE id = ?", [req.user.id]);
      const myGroupId = meRows[0] && meRows[0].group_id;
      const { rows: targetRows } = await db.query(
        "SELECT id FROM supervisors WHERE id = ? AND group_id = ? AND supervisor_type = 'in_training'",
        [targetSupervisorId, myGroupId]
      );
      if (!targetRows.length) return res.status(403).json({ error: "That Trainer (ToT) is not in your Group" });
      finalTargetSupervisorId = targetSupervisorId;
    } else if (shareWithGroup) {
      const { rows: meRows } = await db.query("SELECT group_id FROM supervisors WHERE id = ?", [req.user.id]);
      const myGroupId = meRows[0] && meRows[0].group_id;
      if (!myGroupId) return res.status(400).json({ error: "You don't have a Group assigned yet" });
      finalTargetGroupId = myGroupId;
    } else if (studentId) {
      const { rows: assignRows } = await db.query(
        "SELECT 1 FROM supervisor_students WHERE supervisor_id = ? AND student_id = ?",
        [req.user.id, studentId]
      );
      if (!assignRows.length) return res.status(403).json({ error: "You are not assigned to this trainee" });
      finalStudentId = studentId;
    }
    // else: no target at all given -> the existing "my whole caseload" default.

    const insert = await db.query(
      `INSERT INTO meetings (supervisor_id, student_id, target_group_id, target_supervisor_id, title, platform, meeting_url, scheduled_at, duration_minutes)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [req.user.id, finalStudentId, finalTargetGroupId, finalTargetSupervisorId, title, platform, meetingUrl, scheduledAt || null, durationMinutes || null]
    );
    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES (?, 'meeting scheduled', 'meetings', ?)",
      [req.user.id, insert.insertId]
    );

    {
      const trainer = await getUserContactInfo(db, req.user.id);
      const trainerName = (trainer && trainer.fullName) || "Your trainer";
      if (finalTargetSupervisorId) {
        await createNotification(db, {
          recipientId: finalTargetSupervisorId,
          type: "meeting",
          title: `New meeting scheduled: ${title}`,
          relatedEntityType: "meeting",
          relatedEntityId: insert.insertId,
          email: { template: "newMeeting", data: { meetingTitle: title, trainerName, platform, scheduledAt } },
        });
      } else if (finalTargetGroupId) {
        const { rows: totRows } = await db.query(
          "SELECT id FROM supervisors WHERE group_id = ? AND supervisor_type = 'in_training'",
          [finalTargetGroupId]
        );
        await Promise.allSettled(
          totRows.map((t) =>
            createNotification(db, {
              recipientId: t.id,
              type: "meeting",
              title: `New meeting scheduled: ${title}`,
              relatedEntityType: "meeting",
              relatedEntityId: insert.insertId,
              email: { template: "newMeeting", data: { meetingTitle: title, trainerName, platform, scheduledAt } },
            })
          )
        );
      } else {
        let recipientIds;
        if (finalStudentId) {
          recipientIds = [Number(finalStudentId)];
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
    }

    const { rows } = await db.query(
      `SELECT m.*, tsup.full_name AS target_supervisor_name FROM meetings m
       LEFT JOIN supervisors tsup ON tsup.id = m.target_supervisor_id
       WHERE m.id = ?`,
      [insert.insertId]
    );
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
    if (!label || !String(label).trim()) return res.status(400).json({ error: "Label is required" });

    // The frontend's "Code (optional) - Auto-generated from label" placeholder
    // has always promised this, but nothing here ever actually derived one --
    // an omitted code hit the "Code is required" 400 below instead, forcing
    // every hour type creation to type a code by hand regardless of the UI's
    // own wording. Slugify the label itself when code is blank, same
    // char-cleanup rule as an explicitly typed code goes through.
    const rawCode = code && String(code).trim() ? code : label;
    let cleanCode = String(rawCode).trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
    if (!cleanCode) return res.status(400).json({ error: "Code is required" });

    // A derived code (not one the caller explicitly typed) that collides
    // with an existing one is resolved automatically -- e.g. two hour types
    // both labeled "App" would otherwise 409 on the second with no way for
    // the "auto-generated" path to recover without the caller ever seeing
    // a code field at all.
    if (!(code && String(code).trim())) {
      const base = cleanCode;
      let suffix = 2;
      while (true) {
        const { rows: dupe } = await db.query("SELECT 1 FROM hour_types WHERE code = ?", [cleanCode]);
        if (!dupe.length) break;
        cleanCode = `${base}_${suffix}`;
        suffix += 1;
      }
    }

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

// ---- Events (public site content, shared by Master Trainer + ToT) --------
// Both log in as role='supervisor' (see requireSupervisor above, which
// doesn't distinguish supervisor_type) -- same shared-capability pattern
// already used for calendar-events/hour-types in this file. Structurally a
// direct copy of routes/designer.js's Events routes: same ownership model
// (a supervisor only ever sees/edits/deletes events they themselves
// created -- events.created_by = their own id), same shared utilities
// (utils/eventChildren.js, utils/uploads.js's eventImageUpload,
// utils/serializers.js's event helpers), so this can never compute/store
// anything differently than the already-correct Admin/Designer paths.
// Admin keeps its own separate, unrestricted view of all events at
// /api/admin/events for oversight; this route is supervisor-only.

router.post("/events/upload-image", (req, res) => {
  eventImageUpload.single("image")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const check = checkFileContent(req.file.path, ["image"]);
    if (!check.safe) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: check.reason });
    }
    await optimizeImageIfPossible(req.file.path, { maxDimension: 1600 });
    res.status(201).json({ url: `/uploads/events/${req.file.filename}` });
  });
});

// GET /api/supervisor/events
router.get(
  "/events",
  asyncRoute(async (req, res, db) => {
    const { rows } = await db.query("SELECT * FROM events WHERE created_by = ? ORDER BY event_date DESC", [
      req.user.id,
    ]);
    res.json({ events: rows.map(toPublicEvent) });
  })
);

// GET /api/supervisor/events/:id -- single event, own only, with full child
// data regardless of show_* toggle state (see toEventDetail). Used by the
// editor when Edit is clicked; the list above stays lightweight/childless.
router.get(
  "/events/:id",
  asyncRoute(async (req, res, db) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid event id" });

    const { rows } = await db.query("SELECT * FROM events WHERE id = ?", [id]);
    const event = rows[0];
    if (!event) return res.status(404).json({ error: "Event not found" });
    if (event.created_by !== req.user.id) {
      return res.status(403).json({ error: "You can only view events you created" });
    }

    const children = await fetchEventChildren(db, id);
    res.json(toEventDetail(event, children));
  })
);

// POST /api/supervisor/events
router.post(
  "/events",
  asyncRoute(async (req, res, db) => {
    const b = req.body || {};
    if (!b.date) return res.status(400).json({ error: "date is required" });

    const slug = b.slug || (await generateUniqueSlug(db, b.englishTitle, b.arabicTitle));

    const insert = await db.query(
      `INSERT INTO events (
        created_by, event_date, image, status, fee, register_url, slug,
        show_speakers, show_agenda, show_sponsors, show_gallery, show_registration,
        title_en, format_en, facilitator_en, about_en, learn_en, who_en, outcomes_en, facilitator_bio_en,
        title_ar, format_ar, facilitator_ar, about_ar, learn_ar, who_ar, outcomes_ar, facilitator_bio_ar
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        req.user.id,
        b.date,
        b.image || null,
        ["upcoming", "concluded"].includes(b.status) ? b.status : "upcoming",
        b.fee || null,
        b.register || null,
        slug,
        !!b.showSpeakers,
        !!b.showAgenda,
        !!b.showSponsors,
        !!b.showGallery,
        b.showRegistration === undefined ? true : !!b.showRegistration,
        b.englishTitle || null,
        b.englishFormat || null,
        b.englishFacilitator || null,
        b.englishAbout || null,
        JSON.stringify(toArray(b.englishLearn)),
        JSON.stringify(toArray(b.englishWho)),
        JSON.stringify(toArray(b.englishOutcomes)),
        b.englishFacilitatorBio || null,
        b.arabicTitle || null,
        b.arabicFormat || null,
        b.arabicFacilitator || null,
        b.arabicAbout || null,
        JSON.stringify(toArray(b.arabicLearn)),
        JSON.stringify(toArray(b.arabicWho)),
        JSON.stringify(toArray(b.arabicOutcomes)),
        b.arabicFacilitatorBio || null,
      ]
    );

    await writeEventChildren(db, insert.insertId, b);

    const { rows } = await db.query("SELECT * FROM events WHERE id = ?", [insert.insertId]);
    const children = await fetchEventChildren(db, insert.insertId);
    res.status(201).json(toEventDetail(rows[0], children));
  })
);

// PUT /api/supervisor/events/:id -- only the supervisor's own events
router.put(
  "/events/:id",
  asyncRoute(async (req, res, db) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid event id" });

    const { rows: existingRows } = await db.query("SELECT * FROM events WHERE id = ?", [id]);
    const existing = existingRows[0];
    if (!existing) return res.status(404).json({ error: "Event not found" });
    if (existing.created_by !== req.user.id) {
      return res.status(403).json({ error: "You can only edit events you created" });
    }

    const b = req.body || {};
    await db.query(
      `UPDATE events SET
        event_date = ?, image = ?, status = ?, fee = ?, register_url = ?, slug = ?,
        show_speakers = ?, show_agenda = ?, show_sponsors = ?, show_gallery = ?, show_registration = ?,
        title_en = ?, format_en = ?, facilitator_en = ?, about_en = ?,
        learn_en = ?, who_en = ?, outcomes_en = ?, facilitator_bio_en = ?,
        title_ar = ?, format_ar = ?, facilitator_ar = ?, about_ar = ?,
        learn_ar = ?, who_ar = ?, outcomes_ar = ?, facilitator_bio_ar = ?,
        updated_at = NOW()
       WHERE id = ?`,
      [
        b.date ?? existing.event_date,
        b.image ?? existing.image,
        ["upcoming", "concluded"].includes(b.status) ? b.status : existing.status,
        b.fee ?? existing.fee,
        b.register ?? existing.register_url,
        // Slug is sticky unless the request explicitly sends a new one --
        // regenerating from the title on every edit would silently break
        // any link already shared for this event whenever the title changes.
        b.slug ?? existing.slug,
        b.showSpeakers ?? existing.show_speakers,
        b.showAgenda ?? existing.show_agenda,
        b.showSponsors ?? existing.show_sponsors,
        b.showGallery ?? existing.show_gallery,
        b.showRegistration ?? existing.show_registration,
        b.englishTitle ?? existing.title_en,
        b.englishFormat ?? existing.format_en,
        b.englishFacilitator ?? existing.facilitator_en,
        b.englishAbout ?? existing.about_en,
        b.englishLearn !== undefined ? JSON.stringify(toArray(b.englishLearn)) : JSON.stringify(existing.learn_en),
        b.englishWho !== undefined ? JSON.stringify(toArray(b.englishWho)) : JSON.stringify(existing.who_en),
        b.englishOutcomes !== undefined
          ? JSON.stringify(toArray(b.englishOutcomes))
          : JSON.stringify(existing.outcomes_en),
        b.englishFacilitatorBio ?? existing.facilitator_bio_en,
        b.arabicTitle ?? existing.title_ar,
        b.arabicFormat ?? existing.format_ar,
        b.arabicFacilitator ?? existing.facilitator_ar,
        b.arabicAbout ?? existing.about_ar,
        b.arabicLearn !== undefined ? JSON.stringify(toArray(b.arabicLearn)) : JSON.stringify(existing.learn_ar),
        b.arabicWho !== undefined ? JSON.stringify(toArray(b.arabicWho)) : JSON.stringify(existing.who_ar),
        b.arabicOutcomes !== undefined
          ? JSON.stringify(toArray(b.arabicOutcomes))
          : JSON.stringify(existing.outcomes_ar),
        b.arabicFacilitatorBio ?? existing.facilitator_bio_ar,
        id,
      ]
    );

    await writeEventChildren(db, id, b);

    const { rows } = await db.query("SELECT * FROM events WHERE id = ?", [id]);
    const children = await fetchEventChildren(db, id);
    res.json(toEventDetail(rows[0], children));
  })
);

// DELETE /api/supervisor/events/:id -- only the supervisor's own events
router.delete(
  "/events/:id",
  asyncRoute(async (req, res, db) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid event id" });

    const { rows: existingRows } = await db.query("SELECT created_by FROM events WHERE id = ?", [id]);
    if (!existingRows.length) return res.status(404).json({ error: "Event not found" });
    if (existingRows[0].created_by !== req.user.id) {
      return res.status(403).json({ error: "You can only delete events you created" });
    }

    await db.query("DELETE FROM events WHERE id = ?", [id]);
    res.json({ success: true });
  })
);

module.exports = router;
