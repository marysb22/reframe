// Shared "log one training/supervision activity for a whole caseload/Group
// at once, Attendance recorded as a separate step afterward" logic -- used
// by both a ToT's own Group (routes/supervisor.js's
// POST/GET /session-occasions) and a Master Trainer's Group
// (routes/Mastertrainer.js's POST/GET /group-sessions). See migration 024.
//
// Session creation no longer takes attendance at all: it just creates one
// session_occasions row (the shared date/duration/type/title/notes) plus
// one sessions row per selected trainee, linked via occasion_id. Attendance
// is recorded afterward through recordSessionOccasionAttendance, called
// from the occasion's own PUT .../attendance route once the roster's real
// attendance is known -- this mirrors the shipped UI exactly (Add Session,
// then open the occasion's Attendance modal separately).

const ATTENDANCE_STATUSES = ["present", "absent", "excused", "partial"];

/**
 * @param {object} db - transactional db client (asyncRoute)
 * @param {object} params
 * @param {number} params.supervisorId
 * @param {string} params.sessionType - an hour_types.code
 * @param {string} [params.title]
 * @param {string} params.date - 'YYYY-MM-DD'
 * @param {string} [params.time]
 * @param {number} params.durationMinutes
 * @param {string} [params.notes]
 * @param {string} [params.attachmentFilename]
 * @param {string} [params.attachmentOriginalName]
 * @param {Array<number>} params.studentIds - already validated against the caller's own caseload/Group
 * @returns {Promise<{error:string}|{occasionId:number, created:Array<{studentId:number, sessionId:number}>, isFuture:boolean, sessionTypeLabel:string}>}
 */
async function createSessionOccasion(db, params) {
  const {
    supervisorId,
    sessionType,
    title,
    date,
    time,
    durationMinutes,
    notes,
    attachmentFilename,
    attachmentOriginalName,
    studentIds,
  } = params;

  if (!date) return { error: "date is required" };
  if (!Number.isFinite(Number(durationMinutes)) || Number(durationMinutes) < 0) {
    return { error: "durationMinutes is required and must be a non-negative number" };
  }
  if (!Array.isArray(studentIds) || !studentIds.length) {
    return { error: "At least one trainee is required" };
  }

  const { rows: htRows } = await db.query("SELECT code, label FROM hour_types WHERE code = ? AND is_active = 1", [
    sessionType,
  ]);
  if (!htRows.length) return { error: "That session type does not exist or is inactive" };
  const sessionTypeLabel = htRows[0].label;

  const { rows: todayRows } = await db.query("SELECT CURDATE() AS today");
  const isFuture = date > todayRows[0].today;

  // Same duplicate-submission guard as the old one-shot flow -- a
  // double-click/client retry within a few seconds is treated as one
  // occasion, not two.
  const { rows: dupeRows } = await db.query(
    `SELECT id FROM session_occasions
     WHERE supervisor_id = ? AND session_type = ? AND session_date = ?
       AND duration_minutes = ? AND created_at >= NOW() - INTERVAL 10 SECOND`,
    [supervisorId, sessionType, date, Number(durationMinutes)]
  );
  if (dupeRows.length) return { error: "This looks like a duplicate of a session just logged. Refresh and check the list before retrying." };

  const occasionInsert = await db.query(
    `INSERT INTO session_occasions (supervisor_id, session_type, title, session_date, session_time, duration_minutes, notes, attachment_filename, attachment_original_name)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      supervisorId,
      sessionType,
      title || null,
      date,
      time || null,
      Number(durationMinutes),
      notes || null,
      attachmentFilename || null,
      attachmentOriginalName || null,
    ]
  );
  const occasionId = occasionInsert.insertId;

  const created = [];
  const seen = new Set();
  for (const rawId of studentIds) {
    const studentId = Number(rawId);
    if (seen.has(studentId)) continue; // uq_sessions_occasion_student would otherwise reject a repeated id in the same submission
    seen.add(studentId);

    const sessionInsert = await db.query(
      `INSERT INTO sessions (student_id, supervisor_id, session_type, title, session_date, session_time, duration_minutes, notes, status, occasion_id, attachment_filename, attachment_original_name)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        studentId,
        supervisorId,
        sessionType,
        title || null,
        date,
        time || null,
        Number(durationMinutes),
        notes || null,
        isFuture ? "scheduled" : "completed",
        occasionId,
        attachmentFilename || null,
        attachmentOriginalName || null,
      ]
    );
    created.push({ studentId, sessionId: sessionInsert.insertId });
  }

  return { occasionId, created, isFuture, sessionTypeLabel };
}

/**
 * Records/updates Attendance for some or all of an occasion's roster.
 * Each entry upserts the attendance row tied to that trainee's own session
 * under this occasion -- reusing the exact same attendance table (and
 * therefore the exact same hours computation, see computeHoursByType) as
 * the single-student path.
 *
 * @param {object} db
 * @param {{occasionId:number, supervisorId:number, recordedBy:number, entries:Array<{studentId:number, status:string, minutesCompleted?:number, excuseReasonCode?:string}>}} params
 */
async function recordSessionOccasionAttendance(db, { occasionId, supervisorId, recordedBy, entries }) {
  const { rows: occRows } = await db.query(
    "SELECT id, supervisor_id, session_date FROM session_occasions WHERE id = ?",
    [occasionId]
  );
  if (!occRows.length || Number(occRows[0].supervisor_id) !== Number(supervisorId)) {
    return { error: "Session occasion not found" };
  }
  const attendanceDate = occRows[0].session_date;

  if (!Array.isArray(entries) || !entries.length) {
    return { error: "At least one attendance entry is required" };
  }
  for (const entry of entries) {
    if (!ATTENDANCE_STATUSES.includes(entry.status)) {
      return { error: `Trainee ${entry.studentId}: a valid attendance status is required` };
    }
    if (entry.status === "partial" && !(Number.isFinite(Number(entry.minutesCompleted)) && Number(entry.minutesCompleted) >= 0)) {
      return { error: `Trainee ${entry.studentId}: minutesCompleted is required and must be a non-negative number when status is 'partial'` };
    }
  }

  const updated = [];
  for (const entry of entries) {
    const studentId = Number(entry.studentId);
    const { rows: sessRows } = await db.query("SELECT id FROM sessions WHERE occasion_id = ? AND student_id = ?", [
      occasionId,
      studentId,
    ]);
    if (!sessRows.length) continue; // not part of this occasion's roster -- silently skip rather than error on a stale client roster
    const sessionId = sessRows[0].id;
    const minutesCompleted = entry.status === "partial" ? Number(entry.minutesCompleted) : null;
    const excuseReasonCode = entry.status === "excused" ? entry.excuseReasonCode || null : null;

    // Attendance being recorded at all means the session actually happened
    // -- a session created 'scheduled' (it was future-dated at the time)
    // never otherwise transitions to 'completed' under the deferred-
    // Attendance flow, since creation and recording are now two separate
    // steps that can be arbitrarily far apart.
    await db.query("UPDATE sessions SET status = 'completed' WHERE id = ? AND status = 'scheduled'", [sessionId]);

    const { rows: existing } = await db.query("SELECT id FROM attendance WHERE session_id = ?", [sessionId]);
    if (existing.length) {
      await db.query(
        `UPDATE attendance SET status = ?, minutes_completed = ?, excuse_reason_code = ?, updated_by = ?, updated_at = NOW()
         WHERE session_id = ?`,
        [entry.status, minutesCompleted, excuseReasonCode, recordedBy, sessionId]
      );
    } else {
      await db.query(
        `INSERT INTO attendance (student_id, supervisor_id, session_id, attendance_date, status, minutes_completed, excuse_reason_code, recorded_by)
         VALUES (?,?,?,?,?,?,?,?)`,
        [studentId, supervisorId, sessionId, attendanceDate, entry.status, minutesCompleted, excuseReasonCode, recordedBy]
      );
    }
    updated.push({ studentId, sessionId });
  }

  return { updated };
}

module.exports = { createSessionOccasion, recordSessionOccasionAttendance };
