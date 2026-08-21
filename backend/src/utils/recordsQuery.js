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
    ) combined
    ${recordType ? "WHERE record_type = ?" : ""}
    ORDER BY record_date DESC, created_at DESC
  `;

  const params = new Array(7).fill(studentId);
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

module.exports = { buildRecordsQuery, RECORD_TYPE_TABLES };
