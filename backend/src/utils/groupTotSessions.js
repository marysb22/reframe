// Shared "log one Master-Trainer-delivered training session for every
// selected ToT in one submission" logic -- the TOT-level equivalent of
// groupSessions.js's createGroupSession, used by
// POST /master-trainer/group-tot-sessions.
//
// Mirrors the exact validation/INSERT shape already used by the
// single-ToT session path (Mastertrainer.js's
// POST /tots/:totId/sessions) -- same rules, just looped over multiple
// ToTs instead of one, so the two paths can never compute hours
// differently:
//   - a session dated today or earlier requires attendance and gets it in
//     the same batch; a future-dated session is created status='scheduled'
//     with no attendance row (completed later), exactly like the
//     single-ToT path -- any attendance data supplied for a future date is
//     intentionally ignored, not saved, matching that existing rule.
//   - partial attendance requires minutesCompleted, stored as
//     tot_training_attendance.minutes_completed (added in migration 019,
//     mirrors the trainee-side attendance.minutes_completed).
//   - unlike the trainee-facing `sessions` table, there is no session_type/
//     hour_types link here -- Master-Trainer-to-ToT training was never
//     typed by hour bucket, and this does not introduce one.

const ATTENDANCE_STATUSES = ["present", "absent", "excused", "partial"];

/**
 * @param {object} db - transactional db client (asyncRoute)
 * @param {object} params
 * @param {number} params.masterTrainerId
 * @param {string} [params.title]
 * @param {string} params.date - 'YYYY-MM-DD'
 * @param {string} [params.time]
 * @param {number} params.durationMinutes
 * @param {string} [params.notes]
 * @param {Array<{totId:number, status:string, minutesCompleted?:number}>} params.attendance
 * @returns {Promise<{error:string}|{created:Array<{totId:number, sessionId:number}>, isFuture:boolean}>}
 */
async function createGroupTotSession(db, params) {
  const { masterTrainerId, title, date, time, durationMinutes, notes, attendance } = params;

  if (!date) return { error: "date is required" };
  if (!Number.isFinite(Number(durationMinutes)) || Number(durationMinutes) < 0) {
    return { error: "durationMinutes is required and must be a non-negative number" };
  }
  if (!Array.isArray(attendance) || !attendance.length) {
    return { error: "At least one TOT is required" };
  }

  const { rows: todayRows } = await db.query("SELECT CURDATE() AS today");
  const isFuture = date > todayRows[0].today;

  if (!isFuture) {
    for (const entry of attendance) {
      if (!ATTENDANCE_STATUSES.includes(entry.status)) {
        return { error: `TOT ${entry.totId}: attendanceStatus is required for a session dated today or earlier` };
      }
      if (entry.status === "partial" && !(Number.isFinite(Number(entry.minutesCompleted)) && Number(entry.minutesCompleted) >= 0)) {
        return { error: `TOT ${entry.totId}: minutesCompleted is required and must be a non-negative number when attendanceStatus is 'partial'` };
      }
    }
  }

  const created = [];
  for (const entry of attendance) {
    const totId = Number(entry.totId);

    // Same duplicate-submission guard as the single-ToT path.
    const { rows: dupeRows } = await db.query(
      `SELECT id FROM tot_training_sessions
       WHERE tot_id = ? AND master_trainer_id = ? AND session_date = ?
         AND duration_minutes = ? AND created_at >= NOW() - INTERVAL 10 SECOND`,
      [totId, masterTrainerId, date, Number(durationMinutes)]
    );
    if (dupeRows.length) continue; // already logged moments ago -- skip, not an error

    const sessionInsert = await db.query(
      `INSERT INTO tot_training_sessions (tot_id, master_trainer_id, title, session_date, session_time, duration_minutes, notes, status)
       VALUES (?,?,?,?,?,?,?,?)`,
      [totId, masterTrainerId, title || null, date, time || null, Number(durationMinutes), notes || null, isFuture ? "scheduled" : "completed"]
    );
    const sessionId = sessionInsert.insertId;
    created.push({ totId, sessionId });

    if (!isFuture) {
      const minutesCompleted = entry.status === "partial" ? Number(entry.minutesCompleted) : null;
      await db.query(
        `INSERT INTO tot_training_attendance (session_id, tot_id, status, minutes_completed, recorded_by)
         VALUES (?,?,?,?,?)`,
        [sessionId, totId, entry.status, minutesCompleted, masterTrainerId]
      );
    }
  }

  return { created, isFuture };
}

module.exports = { createGroupTotSession };
