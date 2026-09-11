// Shared "log one training/supervision activity for every selected trainee
// in one submission" logic -- used by both a ToT's own group
// (routes/supervisor.js) and a Master Trainer's group (routes/Mastertrainer.js).
//
// This mirrors the exact validation and INSERT shape already used by the
// single-student session path (routes/supervisor.js's
// POST /students/:studentId/records, case 'training_session'/
// 'supervision_session'/'hour_session') -- same rules, just looped over
// multiple students instead of one, so the two paths can never compute
// hours differently:
//   - sessionType is always looked up against hour_types (training and
//     supervision are already ordinary rows in that table, not a special
//     case -- see database/reframe_mhs_schema.sql's hour_types seed data).
//   - a session dated today or earlier requires attendance and gets it in
//     the same INSERT batch; a future-dated session is created
//     status='scheduled' with no attendance row (completed later), exactly
//     like the single-student path -- any attendance data supplied for a
//     future date is intentionally ignored, not saved, matching that
//     existing rule.
//   - partial attendance requires minutesCompleted, stored as
//     attendance.minutes_completed (already the source computeHoursByType
//     reads for a partial trainee's actual hours -- nothing new here).

const ATTENDANCE_STATUSES = ["present", "absent", "excused", "partial"];

/**
 * @param {object} db - transactional db client (asyncRoute)
 * @param {object} params
 * @param {number} params.supervisorId - who is logging this (ToT or Master Trainer)
 * @param {string} params.sessionType - an hour_types.code
 * @param {string} [params.title]
 * @param {string} params.date - 'YYYY-MM-DD'
 * @param {string} [params.time]
 * @param {number} params.durationMinutes
 * @param {string} [params.notes]
 * @param {string} [params.attachmentFilename]
 * @param {string} [params.attachmentOriginalName]
 * @param {Array<{studentId:number, status:string, minutesCompleted?:number}>} params.attendance
 * @returns {Promise<{error:string}|{created:Array<{studentId:number, sessionId:number}>, isFuture:boolean, sessionTypeLabel:string}>}
 *   Returns an { error } object instead of throwing for any validation
 *   failure, so the calling route can turn it into a 400 without its own
 *   duplicate validation logic.
 */
async function createGroupSession(db, params) {
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
    attendance,
  } = params;

  if (!date) return { error: "date is required" };
  if (!Number.isFinite(Number(durationMinutes)) || Number(durationMinutes) < 0) {
    return { error: "durationMinutes is required and must be a non-negative number" };
  }
  if (!Array.isArray(attendance) || !attendance.length) {
    return { error: "At least one trainee is required" };
  }

  const { rows: htRows } = await db.query("SELECT code, label FROM hour_types WHERE code = ? AND is_active = 1", [
    sessionType,
  ]);
  if (!htRows.length) return { error: "That session type does not exist or is inactive" };
  const sessionTypeLabel = htRows[0].label;

  const { rows: todayRows } = await db.query("SELECT CURDATE() AS today");
  const isFuture = date > todayRows[0].today;

  if (!isFuture) {
    for (const entry of attendance) {
      if (!ATTENDANCE_STATUSES.includes(entry.status)) {
        return { error: `Trainee ${entry.studentId}: attendanceStatus is required for a session dated today or earlier` };
      }
      if (entry.status === "partial" && !(Number.isFinite(Number(entry.minutesCompleted)) && Number(entry.minutesCompleted) >= 0)) {
        return { error: `Trainee ${entry.studentId}: minutesCompleted is required and must be a non-negative number when attendanceStatus is 'partial'` };
      }
    }
  }

  // Paired with studentId (not a flat id array) so a caller can correctly
  // attribute each created session back to its trainee even when an entry
  // is skipped mid-loop by the duplicate guard below -- a flat array would
  // silently misalign against the original `attendance` array's indices
  // the moment any single entry is skipped.
  const created = [];
  for (const entry of attendance) {
    const studentId = Number(entry.studentId);

    // Same duplicate-submission guard as the single-student path.
    const { rows: dupeRows } = await db.query(
      `SELECT id FROM sessions
       WHERE student_id = ? AND supervisor_id = ? AND session_type = ? AND session_date = ?
         AND duration_minutes = ? AND created_at >= NOW() - INTERVAL 10 SECOND`,
      [studentId, supervisorId, sessionType, date, Number(durationMinutes)]
    );
    if (dupeRows.length) continue; // already logged moments ago -- skip, not an error

    const sessionInsert = await db.query(
      `INSERT INTO sessions (student_id, supervisor_id, session_type, title, session_date, session_time, duration_minutes, notes, status, attachment_filename, attachment_original_name)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
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
        attachmentFilename || null,
        attachmentOriginalName || null,
      ]
    );
    const sessionId = sessionInsert.insertId;
    created.push({ studentId, sessionId });

    if (!isFuture) {
      const minutesCompleted = entry.status === "partial" ? Number(entry.minutesCompleted) : null;
      await db.query(
        `INSERT INTO attendance (student_id, supervisor_id, session_id, attendance_date, status, minutes_completed, recorded_by)
         VALUES (?,?,?,?,?,?,?)`,
        [studentId, supervisorId, sessionId, date, entry.status, minutesCompleted, supervisorId]
      );
    }
  }

  return { created, isFuture, sessionTypeLabel };
}

module.exports = { createGroupSession };
