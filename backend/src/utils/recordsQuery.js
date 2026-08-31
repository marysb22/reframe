/**
 * The old schema stored attendance/sessions/hours/assignments/notes/
 * evaluations as one flexible student_records table with a `record_type`
 * column. The new schema normalizes each into its own table instead --
 * better for constraints and indexing, but the Supervisor and Student
 * dashboards already built against this project both expect a single
 * unified "records" feed (one array, each item tagged with a recordType).
 *
 * Rather than rewrite both frontends, this UNION ALL reconstructs that
 * same shape at query time. Every branch produces identical columns in
 * the same order so the UNION is well-typed; branches that don't have a
 * given column (e.g. attendance has no `title`) supply a typed NULL via
 * CAST(NULL AS ...) -- MySQL's `::type` cast syntax doesn't exist.
 *
 * Returns { sql, params } for one student, newest first (NULL
 * record_date sorts last under MySQL's default DESC ordering, same as
 * Postgres's `DESC NULLS LAST` this replaces). Pass `recordType` to
 * filter to a single type (matches the old `?type=` query param).
 * MySQL's `?` placeholders are purely positional, so the same studentId
 * has to be repeated once per UNION branch -- baking that into this
 * function (instead of every call site remembering to do it) is the
 * whole reason it now returns params alongside the SQL.
 */
function buildRecordsQuery(studentId, recordType) {
  const sql = `
    SELECT id, student_id, supervisor_id, record_type, record_date, record_time,
           duration_minutes, status, title, content, score, created_at
    FROM (
      SELECT s.id, s.student_id, s.supervisor_id,
             CASE WHEN s.session_type = 'training' THEN 'training_session' ELSE 'supervision_session' END AS record_type,
             s.session_date AS record_date, s.session_time AS record_time,
             s.duration_minutes, s.status, s.title, s.notes AS content, CAST(NULL AS DECIMAL(5,2)) AS score, s.created_at
      FROM sessions s WHERE s.student_id = ?

      UNION ALL

      SELECT a.id, a.student_id, a.supervisor_id, 'attendance' AS record_type,
             a.attendance_date, CAST(NULL AS TIME), CAST(NULL AS SIGNED), a.status, CAST(NULL AS CHAR), a.notes, CAST(NULL AS DECIMAL(5,2)), a.created_at
      FROM attendance a WHERE a.student_id = ?

      UNION ALL

      SELECT th.id, th.student_id, th.supervisor_id, 'training_hours' AS record_type,
             th.hour_date, CAST(NULL AS TIME), CAST(ROUND(th.hours * 60) AS SIGNED) AS duration_minutes,
             CAST(NULL AS CHAR), CAST(NULL AS CHAR), th.description, CAST(NULL AS DECIMAL(5,2)), th.created_at
      FROM training_hours th WHERE th.student_id = ?

      UNION ALL

      SELECT sh.id, sh.student_id, sh.supervisor_id, 'supervision_hours' AS record_type,
             sh.hour_date, CAST(NULL AS TIME), CAST(ROUND(sh.hours * 60) AS SIGNED) AS duration_minutes,
             CAST(NULL AS CHAR), CAST(NULL AS CHAR), sh.description, CAST(NULL AS DECIMAL(5,2)), sh.created_at
      FROM supervision_hours sh WHERE sh.student_id = ?

      UNION ALL

      SELECT asg.id, asg.student_id, asg.supervisor_id, 'assignment' AS record_type,
             asg.due_date, CAST(NULL AS TIME), CAST(NULL AS SIGNED), asg.status, asg.title, asg.description, CAST(NULL AS DECIMAL(5,2)), asg.created_at
      FROM assignments asg WHERE asg.student_id = ?

      UNION ALL

      SELECT n.id, n.student_id, n.supervisor_id, 'note' AS record_type,
             n.note_date, CAST(NULL AS TIME), CAST(NULL AS SIGNED), CAST(NULL AS CHAR), CAST(NULL AS CHAR), n.content, CAST(NULL AS DECIMAL(5,2)), n.created_at
      FROM supervisor_notes n WHERE n.student_id = ?

      UNION ALL

      SELECT ev.id, ev.student_id, ev.supervisor_id, 'evaluation' AS record_type,
             ev.evaluation_date, CAST(NULL AS TIME), CAST(NULL AS SIGNED), CAST(NULL AS CHAR), ev.title, ev.content, ev.score, ev.created_at
      FROM evaluations ev WHERE ev.student_id = ?

      UNION ALL

      -- Manual hour adjustments (trainee_hour_adjustments) -- append-only,
      -- deliberately absent from RECORD_TYPE_TABLES below so the generic
      -- PUT/DELETE record routes can never edit or delete one, mirroring
      -- payment_transactions' "never UPDATE or DELETE" ledger convention.
      -- status carries hour_type ('training'/'supervision') here since
      -- this record_type has no attendance-style status of its own.
      SELECT tha.id, tha.student_id, tha.added_by, 'hour_adjustment' AS record_type,
             DATE(tha.created_at), CAST(NULL AS TIME), CAST(ROUND(tha.hours * 60) AS SIGNED) AS duration_minutes,
             tha.hour_type, tha.reason, tha.notes, CAST(NULL AS DECIMAL(5,2)), tha.created_at
      FROM trainee_hour_adjustments tha WHERE tha.student_id = ?
    ) combined
    ${recordType ? "WHERE record_type = ?" : ""}
    ORDER BY record_date DESC, created_at DESC
  `;

  const params = new Array(8).fill(studentId);
  if (recordType) params.push(recordType);
  return { sql, params };
}

/** Maps each record_type to the table + id column it actually lives in, for edit/delete routes. */
const RECORD_TYPE_TABLES = {
  training_session: { table: "sessions", dateCol: "session_date", timeCol: "session_time" },
  supervision_session: { table: "sessions", dateCol: "session_date", timeCol: "session_time" },
  attendance: { table: "attendance", dateCol: "attendance_date" },
  training_hours: { table: "training_hours", dateCol: "hour_date" },
  supervision_hours: { table: "supervision_hours", dateCol: "hour_date" },
  assignment: { table: "assignments", dateCol: "due_date" },
  note: { table: "supervisor_notes", dateCol: "note_date" },
  evaluation: { table: "evaluations", dateCol: "evaluation_date" },
};

/**
 * The transparency drill-down behind a trainee's hours total: every row
 * that contributed hours, tagged with exactly where it came from, so
 * "where did this hour come from?" always has a concrete answer --
 * `Session + Attendance + Duration + Role + Adjustment = Final Hours`,
 * never a hidden or trusted-cached number. Three sources, newest first:
 *   'session'    -- a sessions row with its linked attendance row (the
 *                   only source of NEW hours going forward). hours is 0
 *                   whenever attendance isn't 'present' or the session was
 *                   cancelled, even though the row still shows up here so
 *                   an absence is visibly accounted for, not just missing.
 *   'legacy'     -- a training_hours/supervision_hours row typed directly
 *                   before this redesign (frozen, never re-derived).
 *   'adjustment' -- a trainee_hour_adjustments manual entry.
 */
function buildHoursBreakdownQuery(studentId) {
  const sql = `
    SELECT * FROM (
      SELECT s.session_date AS hour_date, s.title AS title, s.session_type AS hour_type,
             s.duration_minutes AS duration_minutes, a.status AS attendance_status,
             CASE WHEN a.status = 'present' AND s.status != 'cancelled' THEN ROUND(s.duration_minutes / 60, 2) ELSE 0 END AS hours,
             'session' AS source, s.created_at
      FROM sessions s
      JOIN attendance a ON a.session_id = s.id
      WHERE s.student_id = ?

      UNION ALL

      SELECT th.hour_date, th.description, 'training', ROUND(th.hours * 60), CAST(NULL AS CHAR), th.hours, 'legacy', th.created_at
      FROM training_hours th WHERE th.student_id = ?

      UNION ALL

      SELECT sh.hour_date, sh.description, 'supervision', ROUND(sh.hours * 60), CAST(NULL AS CHAR), sh.hours, 'legacy', sh.created_at
      FROM supervision_hours sh WHERE sh.student_id = ?

      UNION ALL

      SELECT DATE(tha.created_at), tha.reason, tha.hour_type, CAST(NULL AS SIGNED), CAST(NULL AS CHAR), tha.hours, 'adjustment', tha.created_at
      FROM trainee_hour_adjustments tha WHERE tha.student_id = ?
    ) combined
    ORDER BY hour_date DESC, created_at DESC
  `;
  return { sql, params: [studentId, studentId, studentId, studentId] };
}

/** Same shape as buildHoursBreakdownQuery, for a ToT's own hours *received*
 * from their Master Trainer (tot_training_sessions/tot_training_attendance
 * + tot_hour_adjustments -- structurally separate tables from the trainee
 * ones above, so this can never overlap with what a ToT *delivers*). */
function buildTotHoursBreakdownQuery(totId) {
  const sql = `
    SELECT * FROM (
      SELECT ts.session_date AS hour_date, ts.title AS title,
             ts.duration_minutes AS duration_minutes, ta.status AS attendance_status,
             CASE WHEN ta.status = 'present' AND ts.status != 'cancelled' THEN ROUND(ts.duration_minutes / 60, 2) ELSE 0 END AS hours,
             'session' AS source, ts.created_at
      FROM tot_training_sessions ts
      JOIN tot_training_attendance ta ON ta.session_id = ts.id
      WHERE ts.tot_id = ?

      UNION ALL

      SELECT DATE(tha.created_at), tha.reason, CAST(NULL AS SIGNED), CAST(NULL AS CHAR), tha.hours, 'adjustment', tha.created_at
      FROM tot_hour_adjustments tha WHERE tha.tot_id = ?
    ) combined
    ORDER BY hour_date DESC, created_at DESC
  `;
  return { sql, params: [totId, totId] };
}

module.exports = { buildRecordsQuery, RECORD_TYPE_TABLES, buildHoursBreakdownQuery, buildTotHoursBreakdownQuery };
