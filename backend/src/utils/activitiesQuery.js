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
         -- Actually attended (present or partial), not merely "has an
         -- attendance row" -- an Absent/Excused entry IS recorded but must
         -- not count toward the Attendance column, which the user reads as
         -- a presence rate (see actAttendanceCell in Totdashboard.html).
         (SELECT COUNT(*) FROM sessions s JOIN attendance a ON a.session_id = s.id
           WHERE s.occasion_id = so.id AND a.status IN ('present', 'partial')) AS present_count,
         (SELECT GROUP_CONCAT(st.full_name, ' ', uc.member_code SEPARATOR '  ')
            FROM sessions s JOIN students st ON st.id = s.student_id JOIN user_credentials uc ON uc.id = st.id
           WHERE s.occasion_id = so.id) AS trainee_blob,
         1 AS day_count,
         (SELECT COUNT(*) FROM sessions s WHERE s.occasion_id = so.id) AS slot_count,
         -- "Hours Provided By" (migration 035) -- whose delivered hours
         -- this counts toward, distinct from who logged it (so.supervisor_id,
         -- untouched/unused here beyond the WHERE scoping below). Falls
         -- back to the creator when no explicit provider was set, same
         -- COALESCE convention used everywhere else this column is read.
         occ_provider.id AS provided_by_id, COALESCE(occ_provider_guest.full_name, occ_provider_ext.full_name, occ_provider.full_name) AS provided_by_name, so.provided_by_guest_trainer_id AS provided_by_guest_id, so.provided_by_external_trainer_id AS provided_by_external_id
  FROM session_occasions so
  JOIN hour_types ht ON ht.code = so.session_type
  LEFT JOIN supervisors occ_provider ON occ_provider.id = IF(so.provided_by_guest_trainer_id IS NULL AND so.provided_by_external_trainer_id IS NULL, COALESCE(so.provided_by_supervisor_id, so.supervisor_id), NULL)
  LEFT JOIN guest_trainers occ_provider_guest ON occ_provider_guest.id = so.provided_by_guest_trainer_id
  LEFT JOIN external_trainers occ_provider_ext ON occ_provider_ext.id = so.provided_by_external_trainer_id
  WHERE so.supervisor_id = ? AND so.series_id IS NULL

  UNION ALL

  SELECT 'single' AS kind, s.id, s.title, s.session_type AS type_code, ht.label AS type_label,
         s.session_date AS activity_date, s.session_time AS activity_time, s.duration_minutes, s.created_at,
         s.student_id, s.notes, att.status AS attendance_status, st.full_name AS student_name, uc.member_code AS student_code,
         1 AS trainee_count,
         (SELECT COUNT(*) FROM attendance a WHERE a.session_id = s.id) AS recorded_count,
         (SELECT COUNT(*) FROM attendance a WHERE a.session_id = s.id AND a.status IN ('present', 'partial')) AS present_count,
         CONCAT(st.full_name, ' ', uc.member_code) AS trainee_blob,
         1 AS day_count,
         1 AS slot_count,
         single_provider.id AS provided_by_id, COALESCE(single_provider_guest.full_name, single_provider_ext.full_name, single_provider.full_name) AS provided_by_name, s.provided_by_guest_trainer_id AS provided_by_guest_id, s.provided_by_external_trainer_id AS provided_by_external_id
  FROM sessions s
  JOIN students st ON st.id = s.student_id
  JOIN user_credentials uc ON uc.id = st.id
  JOIN hour_types ht ON ht.code = s.session_type
  LEFT JOIN attendance att ON att.session_id = s.id
  LEFT JOIN supervisors single_provider ON single_provider.id = IF(s.provided_by_guest_trainer_id IS NULL AND s.provided_by_external_trainer_id IS NULL, COALESCE(s.provided_by_supervisor_id, s.supervisor_id), NULL)
  LEFT JOIN guest_trainers single_provider_guest ON single_provider_guest.id = s.provided_by_guest_trainer_id
  LEFT JOIN external_trainers single_provider_ext ON single_provider_ext.id = s.provided_by_external_trainer_id
  WHERE s.supervisor_id = ? AND s.occasion_id IS NULL

  UNION ALL

  -- A whole multi-day Session (session_series, migration 030) as ONE row,
  -- sorted by its earliest day, so it takes its real place in the
  -- chronological feed instead of only living in the separate "Multi-day
  -- Sessions" list below it (see Totdashboard.html's #sessionSeriesBody
  -- comment) -- a Session spanning several dates was otherwise invisible
  -- here entirely, breaking chronological ordering across the two lists.
  -- Correlated scalar subqueries on purpose, not a nested derived table --
  -- see the MariaDB derived-table correlation-loss note elsewhere in this
  -- codebase (memberListSql) for why.
  SELECT 'series' AS kind, ss.id, ss.title, ss.session_type AS type_code, ht.label AS type_label,
         (SELECT MIN(so.session_date) FROM session_occasions so WHERE so.series_id = ss.id) AS activity_date,
         NULL AS activity_time,
         (SELECT SUM(so.duration_minutes) FROM session_occasions so WHERE so.series_id = ss.id) AS duration_minutes,
         ss.created_at,
         NULL AS student_id, ss.notes, NULL AS attendance_status, NULL AS student_name, NULL AS student_code,
         (SELECT COUNT(DISTINCT s.student_id) FROM sessions s JOIN session_occasions so ON so.id = s.occasion_id WHERE so.series_id = ss.id) AS trainee_count,
         (SELECT COUNT(a.id) FROM sessions s JOIN session_occasions so ON so.id = s.occasion_id JOIN attendance a ON a.session_id = s.id WHERE so.series_id = ss.id) AS recorded_count,
         (SELECT COUNT(a.id) FROM sessions s JOIN session_occasions so ON so.id = s.occasion_id JOIN attendance a ON a.session_id = s.id
           WHERE so.series_id = ss.id AND a.status IN ('present', 'partial')) AS present_count,
         (SELECT GROUP_CONCAT(DISTINCT st.full_name, ' ', uc.member_code SEPARATOR '  ')
            FROM sessions s JOIN session_occasions so ON so.id = s.occasion_id
            JOIN students st ON st.id = s.student_id JOIN user_credentials uc ON uc.id = st.id
           WHERE so.series_id = ss.id) AS trainee_blob,
         (SELECT COUNT(*) FROM session_occasions so WHERE so.series_id = ss.id) AS day_count,
         (SELECT COUNT(DISTINCT s.id) FROM sessions s JOIN session_occasions so ON so.id = s.occasion_id WHERE so.series_id = ss.id) AS slot_count,
         -- A multi-day Session's provider is set once on session_series
         -- and cascades to every day at creation/edit time (see
         -- updateSessionSeries in groupSessions.js) -- all days share the
         -- same provider by design, so reading it off the series row
         -- itself (not per-day) is correct, not an approximation.
         series_provider.id AS provided_by_id, COALESCE(series_provider_guest.full_name, series_provider_ext.full_name, series_provider.full_name) AS provided_by_name, ss.provided_by_guest_trainer_id AS provided_by_guest_id, ss.provided_by_external_trainer_id AS provided_by_external_id
  FROM session_series ss
  JOIN hour_types ht ON ht.code = ss.session_type
  LEFT JOIN supervisors series_provider ON series_provider.id = IF(ss.provided_by_guest_trainer_id IS NULL AND ss.provided_by_external_trainer_id IS NULL, COALESCE(ss.provided_by_supervisor_id, ss.supervisor_id), NULL)
  LEFT JOIN guest_trainers series_provider_guest ON series_provider_guest.id = ss.provided_by_guest_trainer_id
  LEFT JOIN external_trainers series_provider_ext ON series_provider_ext.id = ss.provided_by_external_trainer_id
  WHERE ss.supervisor_id = ?
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
  return { sql, params: [supervisorId, supervisorId, supervisorId, ...params, pageSize, offset], page, pageSize };
}

function buildCountQuery(supervisorId, filters = {}) {
  const { where, params } = buildWhere(filters);
  const sql = `SELECT COUNT(*) AS total FROM (${UNION_BASE}) combined ${where}`;
  return { sql, params: [supervisorId, supervisorId, supervisorId, ...params] };
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
    clauses.push("combined.kind IN ('occasion', 'series')");
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
        OR (combined.kind = 'series' AND combined.id IN (
          SELECT so.series_id FROM sessions s JOIN session_occasions so ON so.id = s.occasion_id
          WHERE s.student_id = ? AND so.series_id IS NOT NULL
        ))
      )`
    );
    params.push(Number(filters.traineeId), Number(filters.traineeId), Number(filters.traineeId));
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
         SUM(CASE WHEN recorded_count < slot_count THEN 1 ELSE 0 END) AS pending_attendance,
         -- Bounded to the supervisor's CURRENT caseload (supervisor_students),
         -- not every student_id that has ever appeared in a session row under
         -- this supervisor_id. Without the join, a trainee who was later
         -- reassigned/removed keeps permanently inflating this count forever
         -- -- confirmed live: it stayed unchanged after removing a trainee
         -- from the caseload, even though the Trainee Profiles list (which
         -- IS caseload-bound) no longer shows them at all.
         (SELECT COUNT(DISTINCT s.student_id) FROM sessions s
            JOIN supervisor_students ss ON ss.supervisor_id = s.supervisor_id AND ss.student_id = s.student_id
          WHERE s.supervisor_id = ?) AS trainees_covered
       FROM (${UNION_BASE}) combined`,
      [supervisorId, supervisorId, supervisorId, supervisorId]
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
