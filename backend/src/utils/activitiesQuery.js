// Powers the redesigned "Training Activities" list (Totdashboard.html) --
// one row per real-world activity (a Group Session occasion OR a single-
// trainee session), never one row per trainee-under-an-occasion. Group
// Sessions used to have their own separate, already-grouped card
// (session_occasions, see migration 024) while "Training Activities" was a
// flat N+1-fetched list of every individual sessions row across the whole
// caseload -- a 17-trainee Group Session showed up as 17 identical-looking
// rows there. This UNIONs both shapes into one normalized feed so the
// table can search/filter/sort/paginate over "activities" as a single
// concept, with the per-trainee detail available on demand (GET
// /session-occasions/:id for a group row's roster; a single row already
// carries its one trainee inline).
//
// Deliberately server-side paginated (not fetch-everything-then-slice in
// JS) -- the whole point of this redesign is staying fast with hundreds of
// sessions/thousands of trainee-activity rows, and the old per-student N+1
// fetch loop was the actual scalability problem, not just a display one.

const SORTS = {
  newest: "activity_date DESC, created_at DESC",
  oldest: "activity_date ASC, created_at ASC",
  duration: "duration_minutes DESC, activity_date DESC",
  name: "title ASC, activity_date DESC",
};

const UNION_BASE = `
  SELECT 'occasion' AS kind, so.id, so.title, so.session_type AS type_code, ht.label AS type_label,
         so.session_date AS activity_date, so.session_time AS activity_time, so.duration_minutes, so.created_at,
         NULL AS student_id, so.notes, NULL AS attendance_status, NULL AS student_name, NULL AS student_code,
         (SELECT COUNT(*) FROM sessions s WHERE s.occasion_id = so.id) AS trainee_count,
         (SELECT COUNT(*) FROM sessions s JOIN attendance a ON a.session_id = s.id WHERE s.occasion_id = so.id) AS recorded_count,
         (SELECT GROUP_CONCAT(st.full_name, ' ', uc.member_code SEPARATOR '  ')
            FROM sessions s JOIN students st ON st.id = s.student_id JOIN user_credentials uc ON uc.id = st.id
           WHERE s.occasion_id = so.id) AS trainee_blob
  FROM session_occasions so
  JOIN hour_types ht ON ht.code = so.session_type
  WHERE so.supervisor_id = ? AND so.series_id IS NULL

  UNION ALL

  SELECT 'single' AS kind, s.id, s.title, s.session_type AS type_code, ht.label AS type_label,
         s.session_date AS activity_date, s.session_time AS activity_time, s.duration_minutes, s.created_at,
         s.student_id, s.notes, att.status AS attendance_status, st.full_name AS student_name, uc.member_code AS student_code,
         1 AS trainee_count,
         (SELECT COUNT(*) FROM attendance a WHERE a.session_id = s.id) AS recorded_count,
         CONCAT(st.full_name, ' ', uc.member_code) AS trainee_blob
  FROM sessions s
  JOIN students st ON st.id = s.student_id
  JOIN user_credentials uc ON uc.id = st.id
  JOIN hour_types ht ON ht.code = s.session_type
  LEFT JOIN attendance att ON att.session_id = s.id
  WHERE s.supervisor_id = ? AND s.occasion_id IS NULL
`;

/**
 * @param {number} supervisorId
 * @param {object} filters
 * @param {string} [filters.search] - matches activity title or any trainee's name/member code
 * @param {string} [filters.type] - '' | 'training' | 'supervision' | 'app' | 'group'
 * @param {string} [filters.dateFrom] - 'YYYY-MM-DD', inclusive
 * @param {string} [filters.dateTo] - 'YYYY-MM-DD', inclusive
 * @param {number} [filters.traineeId] - only activities this trainee is part of
 * @param {string} [filters.sort] - one of SORTS' keys, default 'newest'
 * @param {number} [filters.page] - 1-based, default 1
 * @param {number} [filters.pageSize] - default 20, capped at 100
 */
function buildActivitiesQuery(supervisorId, filters = {}) {
  const { where, params } = buildWhere(filters);
  const sort = SORTS[filters.sort] || SORTS.newest;
  const page = Math.max(1, Number(filters.page) || 1);
  const pageSize = Math.min(Math.max(1, Number(filters.pageSize) || 20), 100);
  const offset = (page - 1) * pageSize;

  const sql = `
    SELECT * FROM (${UNION_BASE}) combined
    ${where}
    ORDER BY ${sort}
    LIMIT ? OFFSET ?
  `;
  return { sql, params: [supervisorId, supervisorId, ...params, pageSize, offset], page, pageSize };
}

function buildCountQuery(supervisorId, filters = {}) {
  const { where, params } = buildWhere(filters);
  const sql = `SELECT COUNT(*) AS total FROM (${UNION_BASE}) combined ${where}`;
  return { sql, params: [supervisorId, supervisorId, ...params] };
}

function buildWhere(filters) {
  const clauses = [];
  const params = [];

  if (filters.search && filters.search.trim()) {
    const like = `%${filters.search.trim()}%`;
    clauses.push("(combined.title LIKE ? OR combined.trainee_blob LIKE ?)");
    params.push(like, like);
  }

  if (filters.type === "training" || filters.type === "supervision") {
    clauses.push("combined.type_code = ?");
    params.push(filters.type);
  } else if (filters.type === "app") {
    clauses.push("combined.type_code NOT IN ('training', 'supervision')");
  } else if (filters.type === "group") {
    clauses.push("combined.kind = 'occasion'");
  }

  if (filters.dateFrom) {
    clauses.push("combined.activity_date >= ?");
    params.push(filters.dateFrom);
  }
  if (filters.dateTo) {
    clauses.push("combined.activity_date <= ?");
    params.push(filters.dateTo);
  }

  if (filters.traineeId) {
    clauses.push(
      `(
        (combined.kind = 'single' AND combined.id IN (SELECT id FROM sessions WHERE student_id = ? AND occasion_id IS NULL))
        OR (combined.kind = 'occasion' AND combined.id IN (SELECT occasion_id FROM sessions WHERE student_id = ? AND occasion_id IS NOT NULL))
      )`
    );
    params.push(Number(filters.traineeId), Number(filters.traineeId));
  }

  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

/**
 * Compact top-summary numbers for the whole caseload -- deliberately
 * unfiltered (always the caller's full picture, same convention as every
 * other "totals" card elsewhere in the app), not scoped to the current
 * search/filter/page.
 */
async function buildActivitiesSummary(db, supervisorId) {
  const { computeHoursByType } = require("./serializers");
  const [{ rows: totals }, hoursByType] = await Promise.all([
    db.query(
      `SELECT
         COUNT(*) AS total_activities,
         SUM(CASE WHEN type_code = 'training' THEN 1 ELSE 0 END) AS training_activities,
         SUM(CASE WHEN recorded_count < trainee_count THEN 1 ELSE 0 END) AS pending_attendance,
         (SELECT COUNT(DISTINCT student_id) FROM sessions WHERE supervisor_id = ?) AS trainees_covered
       FROM (${UNION_BASE}) combined`,
      [supervisorId, supervisorId, supervisorId]
    ),
    computeHoursByType(db, { supervisorId }),
  ]);
  const t = totals[0];
  const trainingHours = hoursByType.find((h) => h.code === "training")?.hours || 0;

  return {
    totalActivities: Number(t.total_activities),
    trainingSessions: Number(t.training_activities),
    trainingHours,
    traineesCovered: Number(t.trainees_covered),
    pendingAttendance: Number(t.pending_attendance),
  };
}

module.exports = { buildActivitiesQuery, buildCountQuery, buildActivitiesSummary };
