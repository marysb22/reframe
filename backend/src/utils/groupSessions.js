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
 * @param {number} [params.providedBySupervisorId] - whose delivered hours this counts toward (migration 035) -- already validated by the caller against the same Group's supervisor roster; defaults to supervisorId (the creator) when omitted, same as before this field existed.
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
    seriesId = null, // set only when this occasion is one day of a multi-day Session (see createMultiDaySession below); NULL keeps this identical to a single-day Session, unchanged from before migration 030.
    providedBySupervisorId = supervisorId,
    providedByGuestTrainerId = null,
    providedByExternalTrainerId = null,
  } = params;
  // A Guest Trainer provider (migration 038) and an internal provider are
  // mutually exclusive -- a guest-delivered row stores NULL for the
  // internal column so it is never credited to anyone's account. An
  // External Trainer (migration 039) is a third, equally exclusive kind.
  const provider = providerPair(providedBySupervisorId, providedByGuestTrainerId, providedByExternalTrainerId);
  const providerSupervisorId = provider.supervisorId;
  const providerGuestTrainerId = provider.guestTrainerId;
  const providerExternalTrainerId = provider.externalTrainerId;

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
    `INSERT INTO session_occasions (supervisor_id, provided_by_supervisor_id, provided_by_guest_trainer_id, provided_by_external_trainer_id, session_type, title, session_date, session_time, duration_minutes, notes, attachment_filename, attachment_original_name, series_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      supervisorId,
      providerSupervisorId,
      providerGuestTrainerId,
      providerExternalTrainerId,
      sessionType,
      title || null,
      date,
      time || null,
      Number(durationMinutes),
      notes || null,
      attachmentFilename || null,
      attachmentOriginalName || null,
      seriesId,
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
      `INSERT INTO sessions (student_id, supervisor_id, provided_by_supervisor_id, provided_by_guest_trainer_id, provided_by_external_trainer_id, session_type, title, session_date, session_time, duration_minutes, notes, status, occasion_id, attachment_filename, attachment_original_name)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        studentId,
        supervisorId,
        providerSupervisorId,
        providerGuestTrainerId,
        providerExternalTrainerId,
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
    "SELECT id, supervisor_id, session_date, duration_minutes FROM session_occasions WHERE id = ?",
    [occasionId]
  );
  if (!occRows.length || Number(occRows[0].supervisor_id) !== Number(supervisorId)) {
    return { error: "Session occasion not found" };
  }
  const attendanceDate = occRows[0].session_date;
  const occasionDurationMinutes = Number(occRows[0].duration_minutes);

  if (!Array.isArray(entries) || !entries.length) {
    return { error: "At least one attendance entry is required" };
  }
  for (const entry of entries) {
    if (!ATTENDANCE_STATUSES.includes(entry.status)) {
      return { error: `Trainee ${entry.studentId}: a valid attendance status is required` };
    }
    if (entry.status === "partial") {
      if (!(Number.isFinite(Number(entry.minutesCompleted)) && Number(entry.minutesCompleted) >= 0)) {
        return { error: `Trainee ${entry.studentId}: minutesCompleted is required and must be a non-negative number when status is 'partial'` };
      }
      // The UI already caps this at the session's own duration (an
      // attendee can't have attended more of a 4-hour session than 4
      // hours), but that was only ever enforced client-side -- a direct
      // API call had no server-side bound at all, so a stray/malformed
      // value could be recorded and then double as an inflated hours
      // total everywhere computeHoursByType reads minutes_completed.
      if (Number(entry.minutesCompleted) > occasionDurationMinutes) {
        return {
          error: `Trainee ${entry.studentId}: minutesCompleted (${Number(entry.minutesCompleted)}) can't exceed the session's own duration (${occasionDurationMinutes} minutes)`,
        };
      }
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

/**
 * Multi-day Session: one session_series row (the shared title/type/notes)
 * plus one session_occasions row per day, each created via the exact same
 * createSessionOccasion() above (so per-day validation, the duplicate
 * guard, and the created sessions/attendance shape are all identical to a
 * single-day Session -- a day here is in every way an ordinary occasion,
 * just tagged with a shared series_id). The optional attachment is stored
 * once, on the first day only, mirroring the single-occasion behavior of
 * "one shared attachment" rather than duplicating the file per day.
 *
 * @param {object} db
 * @param {object} params - same shape as createSessionOccasion, except
 *   `days: Array<{date:string, time?:string, durationMinutes:number}>`
 *   replaces the single date/time/durationMinutes fields.
 */
async function createMultiDaySession(db, params) {
  const {
    supervisorId,
    sessionType,
    title,
    notes,
    days,
    attachmentFilename,
    attachmentOriginalName,
    studentIds,
    providedBySupervisorId = supervisorId,
    providedByGuestTrainerId = null,
    providedByExternalTrainerId = null,
  } = params;
  const seriesProvider = providerPair(providedBySupervisorId, providedByGuestTrainerId, providedByExternalTrainerId);

  if (!Array.isArray(days) || !days.length) {
    return { error: "At least one day is required" };
  }
  for (const day of days) {
    if (!day || !day.date) return { error: "Every day needs a date" };
    if (!Number.isFinite(Number(day.durationMinutes)) || Number(day.durationMinutes) < 0) {
      return { error: `Day ${day.date}: durationMinutes is required and must be a non-negative number` };
    }
  }
  const dates = days.map((d) => d.date);
  if (new Set(dates).size !== dates.length) {
    return { error: "Each day of the same Session must have a different date" };
  }

  const { rows: htRows } = await db.query("SELECT code, label FROM hour_types WHERE code = ? AND is_active = 1", [
    sessionType,
  ]);
  if (!htRows.length) return { error: "That session type does not exist or is inactive" };

  const seriesInsert = await db.query(
    `INSERT INTO session_series (supervisor_id, provided_by_supervisor_id, provided_by_guest_trainer_id, provided_by_external_trainer_id, session_type, title, notes) VALUES (?,?,?,?,?,?,?)`,
    [supervisorId, seriesProvider.supervisorId, seriesProvider.guestTrainerId, seriesProvider.externalTrainerId, sessionType, title || null, notes || null]
  );
  const seriesId = seriesInsert.insertId;

  const occasions = [];
  let created = [];
  let createdNonFuture = []; // only past/today days' entries -- mirrors createSessionOccasion's own isFuture gate so a scheduled future day never fires a "session logged" notification early.
  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    // A day can name its own provider (e.g. day 1 delivered by the Master
    // Trainer, day 2 by a different ToT) -- falls back to the series-wide
    // default (providedBySupervisorId) when the day doesn't override it,
    // so a submission with no per-day overrides behaves exactly as before.
    // A day's override may name a Guest Trainer instead (migration 038).
    const dayProvider = dayProviderPair(day, seriesProvider);
    const result = await createSessionOccasion(db, {
      supervisorId,
      sessionType,
      title,
      date: day.date,
      time: day.time,
      durationMinutes: day.durationMinutes,
      notes,
      attachmentFilename: i === 0 ? attachmentFilename : null,
      attachmentOriginalName: i === 0 ? attachmentOriginalName : null,
      studentIds,
      seriesId,
      providedBySupervisorId: dayProvider.supervisorId,
      providedByGuestTrainerId: dayProvider.guestTrainerId,
      providedByExternalTrainerId: dayProvider.externalTrainerId,
    });
    if (result.error) {
      // Roll back the days already created in this same submission so a
      // failure partway through (e.g. a duplicate-guard hit on day 3)
      // never leaves an orphaned partial Session behind.
      await db.query("DELETE FROM session_series WHERE id = ?", [seriesId]);
      return { error: `Day ${day.date}: ${result.error}` };
    }
    occasions.push({ occasionId: result.occasionId, date: day.date, durationMinutes: Number(day.durationMinutes) });
    created = created.concat(result.created);
    if (!result.isFuture) createdNonFuture = createdNonFuture.concat(result.created);
  }

  return { seriesId, occasions, created, createdNonFuture, sessionTypeLabel: htRows[0].label };
}

/**
 * Edits one day of a Session (single-day or one day of a multi-day
 * series) -- date/time/duration/title/notes/sessionType cascade to every
 * attendee's own sessions row under this occasion, which is what
 * computeHoursByType actually reads, so a change is reflected in Training
 * Hours immediately without touching attendance or creating any new hour
 * record (see module comment: hours are always computed live from
 * current sessions+attendance state, never stored/accumulated).
 *
 * sessionType is optional -- omitted (undefined), the occasion keeps
 * whatever type it already had. This used to be silently unsupported: the
 * UPDATE statements here never touched session_type at all, no matter
 * what the caller passed, so an edited Session's Type dropdown visually
 * showed a different value and "saved" successfully, but every hours
 * computation (which reads sessions.session_type/session_occasions.
 * session_type, never session_series.session_type) kept using the
 * original type forever. Confirmed as the reported bug's root cause
 * before fixing it: the frontend already read the dropdown's value into
 * a local `sessionType` variable, it just never made it into the PUT
 * body for a single-occasion edit.
 */
async function updateSessionOccasion(db, { occasionId, supervisorId, date, time, durationMinutes, title, notes, sessionType, providedBySupervisorId, providedByGuestTrainerId, providedByExternalTrainerId }) {
  const { rows } = await db.query(
    "SELECT id, supervisor_id, session_type, provided_by_supervisor_id, provided_by_guest_trainer_id, provided_by_external_trainer_id FROM session_occasions WHERE id = ?",
    [occasionId]
  );
  if (!rows.length || Number(rows[0].supervisor_id) !== Number(supervisorId)) {
    return { error: "Session occasion not found" };
  }
  if (!date) return { error: "date is required" };
  if (!Number.isFinite(Number(durationMinutes)) || Number(durationMinutes) < 0) {
    return { error: "durationMinutes is required and must be a non-negative number" };
  }

  let effectiveType = rows[0].session_type;
  if (sessionType != null && sessionType !== effectiveType) {
    const { rows: htRows } = await db.query("SELECT code FROM hour_types WHERE code = ? AND is_active = 1", [sessionType]);
    if (!htRows.length) return { error: "That session type does not exist or is inactive" };
    effectiveType = sessionType;
  }

  // providedBySupervisorId is optional on this call too, same reasoning as
  // sessionType above -- the caller (routes/supervisor.js, Mastertrainer.js)
  // has already validated an incoming value against the Group's supervisor
  // roster before this ever runs; omitted (undefined/null) keeps whatever
  // this occasion already had, never silently resets it to the creator.
  //
  // A provider is EITHER internal or a Guest Trainer (migration 038) --
  // whichever the caller passed replaces both columns together, so
  // switching a session from a guest back to an internal trainer (or vice
  // versa) can never leave both set.
  const effective =
    providedBySupervisorId != null || providedByGuestTrainerId != null || providedByExternalTrainerId != null
      ? providerPair(providedBySupervisorId, providedByGuestTrainerId, providedByExternalTrainerId)
      : {
          supervisorId: rows[0].provided_by_supervisor_id,
          guestTrainerId: rows[0].provided_by_guest_trainer_id,
          externalTrainerId: rows[0].provided_by_external_trainer_id,
        };

  // COALESCE(?, title/notes), not a direct SET -- title/notes are optional
  // on this call (e.g. a caller only changing sessionType/date, like
  // updateSessionSeries's per-day sessionType-only reconciliation). A
  // direct SET with an omitted (undefined -> null) value would silently
  // wipe an existing title/notes on any edit that didn't happen to resend
  // them -- COALESCE only overwrites when the caller actually passed a
  // value (including an explicit "" to intentionally clear it, which is
  // not NULL and so still applies).
  await db.query(
    `UPDATE session_occasions SET session_date = ?, session_time = ?, duration_minutes = ?, title = COALESCE(?, title), notes = COALESCE(?, notes), session_type = ?, provided_by_supervisor_id = ?, provided_by_guest_trainer_id = ?, provided_by_external_trainer_id = ?, updated_at = NOW()
     WHERE id = ?`,
    [date, time || null, Number(durationMinutes), title ?? null, notes ?? null, effectiveType, effective.supervisorId, effective.guestTrainerId, effective.externalTrainerId, occasionId]
  );
  // Every attendee's own sessions row under this occasion must carry the
  // same date/duration/title/type/provider -- that row, not the occasion
  // row, is what the hours formula and each trainee's own activity list
  // actually read.
  await db.query(
    `UPDATE sessions SET session_date = ?, session_time = ?, duration_minutes = ?, title = COALESCE(?, title), notes = COALESCE(?, notes), session_type = ?, provided_by_supervisor_id = ?, provided_by_guest_trainer_id = ?, provided_by_external_trainer_id = ?, updated_at = NOW()
     WHERE occasion_id = ?`,
    [date, time || null, Number(durationMinutes), title ?? null, notes ?? null, effectiveType, effective.supervisorId, effective.guestTrainerId, effective.externalTrainerId, occasionId]
  );

  return { updated: true };
}

/**
 * Deletes one occasion (one day). Explicitly deletes every attendee's
 * attendance row first, then the occasion itself -- CASCADEs (via the
 * existing FKs from migration 024) to every attendee's sessions row.
 * attendance.session_id is only ON DELETE SET NULL (not CASCADE), so
 * without this explicit delete the attendance rows would survive as
 * orphans (session_id=NULL) rather than being removed -- correct for
 * hours (computeHoursByType's derived-hours query requires a live
 * sessions row, so an orphan already contributes 0) but wrong for
 * Attendance Rate (a simple COUNT(*) over attendance, which an orphaned
 * row still inflates forever). Mirrors the single-session delete route's
 * own explicit `DELETE FROM attendance WHERE session_id = ?` (see
 * routes' DELETE /records/:recordType/:recordId) -- this brought the
 * Group Session path in line with that already-correct behavior.
 */
async function deleteSessionOccasion(db, { occasionId, supervisorId }) {
  const { rows } = await db.query(
    "SELECT id, supervisor_id, attachment_filename FROM session_occasions WHERE id = ?",
    [occasionId]
  );
  if (!rows.length || Number(rows[0].supervisor_id) !== Number(supervisorId)) {
    return { error: "Session occasion not found" };
  }
  await db.query("DELETE FROM attendance WHERE session_id IN (SELECT id FROM sessions WHERE occasion_id = ?)", [occasionId]);
  await db.query("DELETE FROM session_occasions WHERE id = ?", [occasionId]);
  return { deleted: true, attachmentFilename: rows[0].attachment_filename || null };
}

/**
 * Edits a whole multi-day Session: series-level title/notes, plus
 * reconciling the day list against what's actually there today --
 * existing days (matched by occasionId) are updated in place via
 * updateSessionOccasion, brand-new days (no occasionId) are created via
 * createSessionOccasion, and any day that used to exist but is no longer
 * in the submitted list is deleted. Every path reuses the exact same
 * per-day functions a single-day Session uses, so none of this
 * duplicates the hours/attendance logic.
 */
async function updateSessionSeries(db, { seriesId, supervisorId, sessionType, title, notes, days, studentIds, providedBySupervisorId, providedByGuestTrainerId, providedByExternalTrainerId }) {
  const { rows: seriesRows } = await db.query(
    "SELECT id, supervisor_id, provided_by_supervisor_id, provided_by_guest_trainer_id, provided_by_external_trainer_id FROM session_series WHERE id = ?",
    [seriesId]
  );
  if (!seriesRows.length || Number(seriesRows[0].supervisor_id) !== Number(supervisorId)) {
    return { error: "Session not found" };
  }
  if (!Array.isArray(days) || !days.length) {
    return { error: "At least one day is required" };
  }
  const dates = days.map((d) => d.date);
  if (new Set(dates).size !== dates.length) {
    return { error: "Each day of the same Session must have a different date" };
  }

  // Same "resolved once, applied to the series row and every day" shape as
  // effectiveType below -- omitted (undefined/null) keeps the series' (and
  // therefore every day's) current provider rather than resetting it.
  const effectiveProvider =
    providedBySupervisorId != null || providedByGuestTrainerId != null || providedByExternalTrainerId != null
      ? providerPair(providedBySupervisorId, providedByGuestTrainerId, providedByExternalTrainerId)
      : {
          supervisorId: seriesRows[0].provided_by_supervisor_id,
          guestTrainerId: seriesRows[0].provided_by_guest_trainer_id,
          externalTrainerId: seriesRows[0].provided_by_external_trainer_id,
        };

  await db.query(
    `UPDATE session_series SET session_type = COALESCE(?, session_type), title = ?, notes = ?, provided_by_supervisor_id = ?, provided_by_guest_trainer_id = ?, provided_by_external_trainer_id = ?, updated_at = NOW() WHERE id = ?`,
    [sessionType || null, title || null, notes || null, effectiveProvider.supervisorId, effectiveProvider.guestTrainerId, effectiveProvider.externalTrainerId, seriesId]
  );

  // Resolved once, up front, so every day -- existing or brand-new -- gets
  // the exact same type as the series row just above. Previously this was
  // only ever resolved for a brand-new day (createSessionOccasion below);
  // an existing day kept whatever type it already had regardless of a
  // type change in this same edit, leaving the series row and its own
  // days' actual hours-computation type inconsistent with each other.
  const effectiveType = sessionType || (await currentSeriesType(db, seriesId));

  const { rows: existingRows } = await db.query("SELECT id FROM session_occasions WHERE series_id = ?", [seriesId]);
  const existingIds = new Set(existingRows.map((r) => Number(r.id)));
  const keptIds = new Set();

  for (const day of days) {
    // Same per-day override as createMultiDaySession -- a day with its own
    // providedBySupervisorId keeps/sets that specific provider; a day with
    // none falls back to the series-wide value just resolved above.
    const dayProvider = dayProviderPair(day, effectiveProvider);
    if (day.occasionId && existingIds.has(Number(day.occasionId))) {
      const result = await updateSessionOccasion(db, {
        occasionId: Number(day.occasionId),
        supervisorId,
        date: day.date,
        time: day.time,
        durationMinutes: day.durationMinutes,
        title: title,
        notes: notes,
        sessionType: effectiveType,
        providedBySupervisorId: dayProvider.supervisorId,
        providedByGuestTrainerId: dayProvider.guestTrainerId,
        providedByExternalTrainerId: dayProvider.externalTrainerId,
      });
      if (result.error) return { error: `Day ${day.date}: ${result.error}` };
      keptIds.add(Number(day.occasionId));
    } else {
      const result = await createSessionOccasion(db, {
        supervisorId,
        sessionType: effectiveType,
        title,
        date: day.date,
        time: day.time,
        durationMinutes: day.durationMinutes,
        notes,
        studentIds,
        seriesId,
        providedBySupervisorId: dayProvider.supervisorId,
        providedByGuestTrainerId: dayProvider.guestTrainerId,
        providedByExternalTrainerId: dayProvider.externalTrainerId,
      });
      if (result.error) return { error: `Day ${day.date}: ${result.error}` };
      keptIds.add(result.occasionId);
    }
  }

  // A day present before but absent from this submission was removed in
  // the edit UI -- delete it the same way a standalone day is deleted.
  for (const id of existingIds) {
    if (!keptIds.has(id)) {
      await deleteSessionOccasion(db, { occasionId: id, supervisorId });
    }
  }

  return { updated: true };
}

/**
 * Normalizes a provider choice to exactly one kind: a Guest Trainer
 * (migration 038) or an External Trainer (migration 039) clears the other
 * two columns. Callers have already rejected requests naming more than one.
 */
function providerPair(supervisorId, guestTrainerId, externalTrainerId = null) {
  if (guestTrainerId != null) return { supervisorId: null, guestTrainerId: Number(guestTrainerId), externalTrainerId: null };
  if (externalTrainerId != null) return { supervisorId: null, guestTrainerId: null, externalTrainerId: Number(externalTrainerId) };
  return { supervisorId: supervisorId != null ? Number(supervisorId) : null, guestTrainerId: null, externalTrainerId: null };
}

/** A day's own provider override (internal, guest, or external), else the series-wide one. */
function dayProviderPair(day, fallback) {
  if (day && day.providedByGuestTrainerId != null) return providerPair(null, day.providedByGuestTrainerId);
  if (day && day.providedByExternalTrainerId != null) return providerPair(null, null, day.providedByExternalTrainerId);
  if (day && day.providedBySupervisorId != null) return providerPair(day.providedBySupervisorId, null);
  return fallback;
}

async function currentSeriesType(db, seriesId) {
  const { rows } = await db.query("SELECT session_type FROM session_series WHERE id = ?", [seriesId]);
  return rows.length ? rows[0].session_type : null;
}

/**
 * Deletes a whole multi-day Session. CASCADEs to every day (session_
 * occasions.series_id) and from there to sessions/attendance exactly like
 * deleteSessionOccasion, just for every day at once.
 */
async function deleteSessionSeries(db, { seriesId, supervisorId }) {
  const { rows } = await db.query("SELECT id, supervisor_id FROM session_series WHERE id = ?", [seriesId]);
  if (!rows.length || Number(rows[0].supervisor_id) !== Number(supervisorId)) {
    return { error: "Session not found" };
  }
  const { rows: occRows } = await db.query("SELECT id, attachment_filename FROM session_occasions WHERE series_id = ?", [
    seriesId,
  ]);
  // Deletes every day's attendee sessions explicitly, one occasion at a
  // time, rather than trusting a single DELETE FROM session_series to
  // cascade two levels deep (session_occasions -> sessions) on its own --
  // verified directly against this environment's DB that a two-level
  // cascade fanning out from multiple session_occasions rows in one
  // statement does NOT reliably reach every sessions row (confirmed via a
  // raw-SQL reproduction: 4 occasions deleted via one cascading
  // session_series delete left 2 of their sessions rows orphaned rather
  // than removed), even though the FKs themselves are correctly defined
  // ON DELETE CASCADE and a single-level cascade (one occasion -> its own
  // sessions rows, however many) is reliable on its own. Each
  // DELETE FROM sessions WHERE occasion_id = ? here is exactly that
  // already-proven single-level cascade, done explicitly.
  //
  // Attendance is deleted first, same reasoning as deleteSessionOccasion
  // above -- attendance.session_id is only ON DELETE SET NULL, so without
  // this every day's attendance would survive the sessions delete as an
  // orphaned row instead of being removed with the rest of the Session.
  for (const occ of occRows) {
    await db.query("DELETE FROM attendance WHERE session_id IN (SELECT id FROM sessions WHERE occasion_id = ?)", [occ.id]);
    await db.query("DELETE FROM sessions WHERE occasion_id = ?", [occ.id]);
  }
  await db.query("DELETE FROM session_series WHERE id = ?", [seriesId]);
  return { deleted: true, attachmentFilenames: occRows.map((r) => r.attachment_filename).filter(Boolean) };
}

module.exports = {
  createSessionOccasion,
  recordSessionOccasionAttendance,
  createMultiDaySession,
  updateSessionOccasion,
  deleteSessionOccasion,
  updateSessionSeries,
  deleteSessionSeries,
};
