// Shared "log one Master-Trainer-delivered training session for every
// selected ToT (optionally including the Master Trainer herself) in one
// submission, Attendance recorded as a separate step afterward" logic --
// the TOT-level equivalent of groupSessions.js, used by
// routes/Mastertrainer.js's POST/GET /group-tot-sessions. See migration 024.

const ATTENDANCE_STATUSES = ["present", "absent", "excused", "partial"];

/**
 * @param {object} db
 * @param {object} params
 * @param {number} params.masterTrainerId
 * @param {string} [params.title]
 * @param {string} params.date - 'YYYY-MM-DD'
 * @param {string} [params.time]
 * @param {number} params.durationMinutes
 * @param {string} [params.notes]
 * @param {Array<number>} params.totIds - already validated against this Master Trainer's own Group (may include masterTrainerId itself when includeSelf was checked)
 * @returns {Promise<{error:string}|{occasionId:number, created:Array<{totId:number, sessionId:number}>, isFuture:boolean}>}
 */
async function createTotSessionOccasion(db, params) {
  const { masterTrainerId, title, date, time, durationMinutes, notes, totIds } = params;

  if (!date) return { error: "date is required" };
  if (!Number.isFinite(Number(durationMinutes)) || Number(durationMinutes) < 0) {
    return { error: "durationMinutes is required and must be a non-negative number" };
  }
  if (!Array.isArray(totIds) || !totIds.length) {
    return { error: "At least one TOT is required" };
  }

  const { rows: todayRows } = await db.query("SELECT CURDATE() AS today");
  const isFuture = date > todayRows[0].today;

  const { rows: dupeRows } = await db.query(
    `SELECT id FROM tot_session_occasions
     WHERE master_trainer_id = ? AND session_date = ? AND duration_minutes = ?
       AND created_at >= NOW() - INTERVAL 10 SECOND`,
    [masterTrainerId, date, Number(durationMinutes)]
  );
  if (dupeRows.length) return { error: "This looks like a duplicate of a session just logged. Refresh and check the list before retrying." };

  const occasionInsert = await db.query(
    `INSERT INTO tot_session_occasions (master_trainer_id, title, session_date, session_time, duration_minutes, notes)
     VALUES (?,?,?,?,?,?)`,
    [masterTrainerId, title || null, date, time || null, Number(durationMinutes), notes || null]
  );
  const occasionId = occasionInsert.insertId;

  const created = [];
  const seen = new Set();
  for (const rawId of totIds) {
    const totId = Number(rawId);
    if (seen.has(totId)) continue;
    seen.add(totId);

    const sessionInsert = await db.query(
      `INSERT INTO tot_training_sessions (tot_id, master_trainer_id, title, session_date, session_time, duration_minutes, notes, status, occasion_id)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [totId, masterTrainerId, title || null, date, time || null, Number(durationMinutes), notes || null, isFuture ? "scheduled" : "completed", occasionId]
    );
    created.push({ totId, sessionId: sessionInsert.insertId });
  }

  return { occasionId, created, isFuture };
}

/**
 * Records/updates Attendance for some or all of a ToT-session occasion's
 * roster, same upsert shape as recordSessionOccasionAttendance.
 *
 * @param {object} db
 * @param {{occasionId:number, masterTrainerId:number, recordedBy:number, entries:Array<{totId:number, status:string, minutesCompleted?:number, excuseReasonCode?:string}>}} params
 */
async function recordTotSessionOccasionAttendance(db, { occasionId, masterTrainerId, recordedBy, entries }) {
  const { rows: occRows } = await db.query(
    "SELECT id, master_trainer_id, duration_minutes FROM tot_session_occasions WHERE id = ?",
    [occasionId]
  );
  if (!occRows.length || Number(occRows[0].master_trainer_id) !== Number(masterTrainerId)) {
    return { error: "Session occasion not found" };
  }
  const occasionDurationMinutes = Number(occRows[0].duration_minutes);

  if (!Array.isArray(entries) || !entries.length) {
    return { error: "At least one attendance entry is required" };
  }
  for (const entry of entries) {
    if (!ATTENDANCE_STATUSES.includes(entry.status)) {
      return { error: `TOT ${entry.totId}: a valid attendance status is required` };
    }
    if (entry.status === "partial") {
      if (!(Number.isFinite(Number(entry.minutesCompleted)) && Number(entry.minutesCompleted) >= 0)) {
        return { error: `TOT ${entry.totId}: minutesCompleted is required and must be a non-negative number when status is 'partial'` };
      }
      // Only ever enforced client-side before -- see groupSessions.js's
      // identical check for why that's not enough on its own.
      if (Number(entry.minutesCompleted) > occasionDurationMinutes) {
        return {
          error: `TOT ${entry.totId}: minutesCompleted (${Number(entry.minutesCompleted)}) can't exceed the session's own duration (${occasionDurationMinutes} minutes)`,
        };
      }
    }
  }

  const updated = [];
  for (const entry of entries) {
    const totId = Number(entry.totId);
    const { rows: sessRows } = await db.query("SELECT id FROM tot_training_sessions WHERE occasion_id = ? AND tot_id = ?", [
      occasionId,
      totId,
    ]);
    if (!sessRows.length) continue;
    const sessionId = sessRows[0].id;
    const minutesCompleted = entry.status === "partial" ? Number(entry.minutesCompleted) : null;
    const excuseReasonCode = entry.status === "excused" ? entry.excuseReasonCode || null : null;

    await db.query("UPDATE tot_training_sessions SET status = 'completed' WHERE id = ? AND status = 'scheduled'", [sessionId]);

    const { rows: existing } = await db.query("SELECT id FROM tot_training_attendance WHERE session_id = ?", [sessionId]);
    if (existing.length) {
      await db.query(
        `UPDATE tot_training_attendance SET status = ?, minutes_completed = ?, excuse_reason_code = ?, updated_by = ?, updated_at = NOW()
         WHERE session_id = ?`,
        [entry.status, minutesCompleted, excuseReasonCode, recordedBy, sessionId]
      );
    } else {
      await db.query(
        `INSERT INTO tot_training_attendance (session_id, tot_id, status, minutes_completed, excuse_reason_code, recorded_by)
         VALUES (?,?,?,?,?,?)`,
        [sessionId, totId, entry.status, minutesCompleted, excuseReasonCode, recordedBy]
      );
    }
    updated.push({ totId, sessionId });
  }

  return { updated };
}

module.exports = { createTotSessionOccasion, recordTotSessionOccasionAttendance };
