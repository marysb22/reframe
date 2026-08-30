const express = require("express");
const { requireAuth, asyncRoute } = require("../middleware/auth");
const { toRecord, toDocument, toMaterial, computeTrainingProgress } = require("../utils/serializers");

const router = express.Router();

/* =========================================================================
   This router was originally written against Postgres syntax ($1/$2
   placeholders, ::int casts, NULLS LAST, json_agg/json_build_object) but
   the app runs on MySQL (see db.js) which uses `?` positional placeholders,
   has no ::int cast operator, sorts NULLs first for ASC / last for DESC by
   default (the opposite of what a couple of these queries needed), and
   aggregates JSON with JSON_ARRAYAGG/JSON_OBJECT instead of
   json_agg/json_build_object. Converted throughout to match how
   routes/supervisor.js and routes/admin.js already talk to MySQL.

   ASSUMPTIONS — please verify against your real files and adjust if wrong.
   I only had dashboard.html + routes/supervisor.js to work from, so this
   file infers the following instead of guessing blindly:

   1. `requireAuth` (imported from ../middleware/auth, same as supervisor.js)
      runs first and sets req.user = { id, member_code, ... } from the JWT.
      It does NOT need to know about Master Trainer vs ToT — that
      distinction is resolved below, purely from the `supervisors` table,
      exactly the way routes/supervisor.js already resolves `req.user.id`
      against `supervisor_students` for the ToT/trainee relationship.

   2. `supervisors` table (id === user_credentials.id, same pattern as
      `students`) has: full_name, email, phone, photo, group_id,
      supervisor_type ('primary' | 'in_training'), primary_supervisor_id.
      This matches the existing GET /api/supervisor/group handler in
      routes/supervisor.js, which already reads exactly these columns.

   3. `students` has a `group_id` column directly (confirmed by the
      existing `SELECT COUNT(*) AS count FROM students WHERE
      group_id = ?` in routes/supervisor.js's /group route).

   4. Tables `sessions`, `attendance`, `training_hours`,
      `supervision_hours`, `assignments`, `supervisor_notes`,
      `evaluations`, `documents`, `learning_materials`, `meetings`,
      `calendar_events`, `audit_logs`, `chats`, `messages` are exactly as
      shaped in routes/supervisor.js (I did not invent new columns).

   5. `bio` / `specialization` columns on `supervisors` are NOT confirmed
      to exist in your schema (nothing in the two files you gave me
      referenced them), so this router does not hard-code them into any
      SELECT list — only `sup.*` is spread for the ToT/MT own profile.
      If those columns exist, they will already flow through
      automatically; if they don't yet, add them with a small migration
      and no route code here needs to change.

   6. This router is READ-ONLY by design. Section 6/10 of the brief asks
      the Master Trainer to "monitor" her ToTs, not manage their trainees,
      records, uploads, etc. — those stay exclusively on
      routes/supervisor.js, untouched. If you also want her to message a
      ToT/trainee or post group-wide announcements, that's a small,
      separate addition — flag it and I'll add explicit write endpoints
      rather than silently expanding scope here.

   INTEGRATION STEPS:
   - Mounted in server.js as app.use("/api/master-trainer", require("./routes/Mastertrainer")).
   - Admin's "manage group" flow (routes/admin.js) should, when assigning a
     Master Trainer to a Group, do:
       UPDATE supervisors
       SET supervisor_type = 'primary', group_id = ?, primary_supervisor_id = NULL
       WHERE id = ?;
     and keep enforcing "exactly 1 primary per group" the same way it
     already enforces "exactly 2 in_training per group".
   - login.html now reads supervisorType off the login response (added to
     routes/auth.js's login query/response) and redirects 'primary' ->
     masterDashborad.html, 'in_training' -> Totdashboard.html.
   ========================================================================= */

router.use(requireAuth, requireMasterTrainer);

/** Loads the calling user's own Master Trainer row (must be supervisor_type='primary'),
 *  attaches req.masterTrainer = { id, groupId, fullName }, or responds 403/404. */
async function requireMasterTrainer(req, res, next) {
    try {
        const db = req.db || require("../db").pool; // matches asyncRoute's db handoff below
        const { rows } = await db.query(
            `SELECT sup.id, sup.full_name, sup.group_id, sup.supervisor_type
       FROM supervisors sup
       WHERE sup.id = ?`, [req.user.id]
        );
        if (!rows.length || rows[0].supervisor_type !== "primary") {
            return res.status(403).json({ error: "Master Trainer access only" });
        }
        req.masterTrainer = { id: rows[0].id, groupId: rows[0].group_id, fullName: rows[0].full_name };
        next();
    } catch (err) {
        res.status(500).json({ error: "Internal server error" });
    }
}

/** Every route below is already scoped to req.masterTrainer.groupId. If she has
 *  no group yet (Admin hasn't assigned one), we return empty results everywhere
 *  instead of erroring, same spirit as the existing /supervisor/group "No Group
 *  assigned" fallback. */
function noGroupResponse(res, shape) {
    return res.json(shape);
}

/** Confirms totId is an in_training supervisor inside the calling MT's group.
 *  Returns the row or writes 403/404 and returns null — same pattern as
 *  loadAssignedStudent() in routes/supervisor.js. */
async function loadGroupTot(db, groupId, totId, res) {
    const { rows } = await db.query(
        `SELECT uc.id, uc.member_code, uc.status, uc.created_at,
            sup.full_name, sup.email, sup.phone, sup.photo, sup.bio, sup.specialization,
            sup.group_id, sup.supervisor_type
     FROM user_credentials uc
     JOIN supervisors sup ON sup.id = uc.id
     WHERE uc.id = ? AND sup.supervisor_type = 'in_training'`, [totId]
    );
    if (!rows.length) {
        res.status(404).json({ error: "Trainer not found" });
        return null;
    }
    if (!groupId || rows[0].group_id !== groupId) {
        res.status(403).json({ error: "This trainer is not in your group" });
        return null;
    }
    return rows[0];
}

/** Confirms studentId belongs (via students.group_id) to the calling MT's group. */
async function loadGroupStudent(db, groupId, studentId, res) {
    const { rows } = await db.query(
        `SELECT uc.id, uc.member_code, uc.status, uc.created_at,
            st.full_name, st.email, st.phone, st.photo, st.gender, st.current_year,
            st.highest_degree, st.institution, st.certifications, st.cv_file,
            st.group_id, c.name AS cohort_name
     FROM user_credentials uc
     JOIN students st ON st.id = uc.id
     LEFT JOIN cohorts c ON c.id = st.cohort_id
     WHERE uc.id = ?`, [studentId]
    );
    if (!rows.length) {
        res.status(404).json({ error: "Trainee not found" });
        return null;
    }
    if (!groupId || rows[0].group_id !== groupId) {
        res.status(403).json({ error: "This trainee is not in your group" });
        return null;
    }
    return rows[0];
}

// ---- /me — Master Trainer's own profile + group summary -----------------

// GET /api/master-trainer/me
router.get(
    "/me",
    asyncRoute(async(req, res, db) => {
        const { groupId } = req.masterTrainer;

        const { rows: selfRows } = await db.query(
            `SELECT uc.id, uc.member_code, uc.status, uc.must_change_password,
              sup.full_name, sup.email, sup.phone, sup.photo, sup.bio, sup.specialization,
              sup.group_id, g.name AS group_name
       FROM user_credentials uc
       JOIN supervisors sup ON sup.id = uc.id
       LEFT JOIN trainer_groups g ON g.id = sup.group_id
       WHERE uc.id = ?`, [req.user.id]
        );
        const self = selfRows[0];

        if (!groupId) {
            return res.json({ profile: self, groupLabel: "No Group assigned", totCount: 0, traineeCount: 0 });
        }

        const { rows: countRows } = await db.query(
            `SELECT
        (SELECT COUNT(*) FROM supervisors WHERE group_id = ? AND supervisor_type = 'in_training') AS tot_count,
        (SELECT COUNT(*) FROM students WHERE group_id = ?) AS trainee_count`, [groupId, groupId]
        );

        res.json({
            profile: self,
            groupLabel: self.group_name || "My Group",
            totCount: countRows[0].tot_count,
            traineeCount: countRows[0].trainee_count,
        });
    })
);

// GET /api/master-trainer/dashboard-summary — the Dashboard section's full KPI row.
// Every count is a real query against real tables, scoped by group_id via the
// supervisors join (the only group-scoping path -- sessions/attendance/
// assignments/learning_materials have no group_id column of their own).
// Rates are null (never 0) when there's no denominator, matching
// computeProgressSummary's existing convention, so an empty group shows
// "no data yet" instead of a fabricated 0%.
router.get(
    "/dashboard-summary",
    asyncRoute(async(req, res, db) => {
        const { groupId } = req.masterTrainer;
        if (!groupId) {
            return noGroupResponse(res, {
                sessionsCompleted: 0, sessionsUpcoming: 0, sessionsCancelled: 0,
                assignmentsTotal: 0, assignmentsCompleted: 0, assignmentsOverdue: 0,
                materialsAddedThisWeek: 0, attendanceRatePct: null, completionRatePct: null,
                trainingProgress: { value: null, basis: null },
            });
        }

        const { rows } = await db.query(
            `SELECT
        (SELECT COUNT(*) FROM sessions s JOIN supervisors sup ON sup.id = s.supervisor_id
           WHERE sup.group_id = ? AND s.status = 'completed') AS sessions_completed,
        (SELECT COUNT(*) FROM sessions s JOIN supervisors sup ON sup.id = s.supervisor_id
           WHERE sup.group_id = ? AND s.status = 'scheduled' AND s.session_date >= CURRENT_DATE) AS sessions_upcoming,
        (SELECT COUNT(*) FROM sessions s JOIN supervisors sup ON sup.id = s.supervisor_id
           WHERE sup.group_id = ? AND s.status = 'cancelled') AS sessions_cancelled,
        (SELECT COUNT(*) FROM assignments a JOIN supervisors sup ON sup.id = a.supervisor_id
           WHERE sup.group_id = ?) AS assignments_total,
        (SELECT COUNT(*) FROM assignments a JOIN supervisors sup ON sup.id = a.supervisor_id
           WHERE sup.group_id = ? AND a.status = 'completed') AS assignments_completed,
        (SELECT COUNT(*) FROM assignments a JOIN supervisors sup ON sup.id = a.supervisor_id
           WHERE sup.group_id = ? AND a.due_date < CURRENT_DATE AND a.status NOT IN ('completed')) AS assignments_overdue,
        (SELECT COUNT(*) FROM learning_materials lm JOIN supervisors sup ON sup.id = lm.supervisor_id
           WHERE sup.group_id = ? AND lm.created_at >= DATE_SUB(CURRENT_DATE, INTERVAL 7 DAY)) AS materials_week,
        (SELECT COUNT(*) FROM attendance att JOIN supervisors sup ON sup.id = att.supervisor_id
           WHERE sup.group_id = ? AND att.status = 'present') AS attendance_present,
        (SELECT COUNT(*) FROM attendance att JOIN supervisors sup ON sup.id = att.supervisor_id
           WHERE sup.group_id = ?) AS attendance_total,
        (SELECT COUNT(*) FROM students WHERE group_id = ?) AS trainee_count,
        (SELECT COUNT(*) FROM training_milestones WHERE is_active = TRUE) AS active_milestone_count,
        (SELECT COUNT(*) FROM trainee_milestone_progress tmp JOIN students st ON st.id = tmp.student_id
           WHERE st.group_id = ? AND tmp.status = 'completed') AS milestones_completed`,
            Array(12).fill(groupId)
        );
        const r = rows[0];

        const assignmentsTotal = Number(r.assignments_total);
        const assignmentsCompleted = Number(r.assignments_completed);
        const attendanceTotal = Number(r.attendance_total);
        const attendancePresent = Number(r.attendance_present);
        // Denominator = every active milestone x every trainee in the group
        // (each trainee is expected to eventually complete every active
        // milestone); numerator = how many of those trainee-milestone pairs
        // are actually marked completed. computeTrainingProgress() falls
        // back to the assignments basis on its own whenever this is 0.
        const milestonesTotal = Number(r.trainee_count) * Number(r.active_milestone_count);
        const milestonesCompleted = Number(r.milestones_completed);

        res.json({
            sessionsCompleted: Number(r.sessions_completed),
            sessionsUpcoming: Number(r.sessions_upcoming),
            sessionsCancelled: Number(r.sessions_cancelled),
            assignmentsTotal,
            assignmentsCompleted,
            assignmentsOverdue: Number(r.assignments_overdue),
            materialsAddedThisWeek: Number(r.materials_week),
            attendanceRatePct: attendanceTotal > 0 ? Math.round((attendancePresent / attendanceTotal) * 1000) / 10 : null,
            completionRatePct: assignmentsTotal > 0 ? Math.round((assignmentsCompleted / assignmentsTotal) * 1000) / 10 : null,
            trainingProgress: computeTrainingProgress({
                milestonesCompleted, milestonesTotal, assignmentsCompleted, assignmentsTotal,
            }),
        });
    })
);

// ---- My Group -------------------------------------------------------------

// GET /api/master-trainer/group
router.get(
    "/group",
    asyncRoute(async(req, res, db) => {
        const { groupId } = req.masterTrainer;
        if (!groupId) return noGroupResponse(res, { groupLabel: "No Group assigned", tots: [], traineeCount: 0 });

        const { rows: groupRows } = await db.query("SELECT name FROM trainer_groups WHERE id = ?", [groupId]);
        const { rows: tots } = await db.query(
            `SELECT uc.id, uc.member_code, uc.status, sup.full_name, sup.email, sup.phone, sup.photo
       FROM supervisors sup
       JOIN user_credentials uc ON uc.id = sup.id
       WHERE sup.group_id = ? AND sup.supervisor_type = 'in_training'
       ORDER BY sup.full_name`, [groupId]
        );
        const { rows: countRows } = await db.query("SELECT COUNT(*) AS count FROM students WHERE group_id = ?", [groupId]);

        res.json({ groupLabel: groupRows[0]?.name || "My Group", tots, traineeCount: countRows[0].count });
    })
);

// ---- My ToTs ---------------------------------------------------------------

// GET /api/master-trainer/tots — list with aggregated stats (single query, DB-side)
router.get(
    "/tots",
    asyncRoute(async(req, res, db) => {
        const { groupId } = req.masterTrainer;
        if (!groupId) return noGroupResponse(res, { tots: [] });

        const { rows } = await db.query(
            `SELECT uc.id, uc.member_code, uc.status, uc.created_at,
              sup.full_name, sup.email, sup.phone, sup.photo, sup.bio, sup.specialization,
              (SELECT COUNT(*) FROM supervisor_students ss WHERE ss.supervisor_id = sup.id) AS trainee_count,
              (SELECT COUNT(*) FROM sessions s WHERE s.supervisor_id = sup.id) AS session_count,
              (SELECT COUNT(*) FROM meetings m WHERE m.supervisor_id = sup.id) AS meeting_count,
              (SELECT COUNT(*) FROM documents d
                 JOIN supervisor_students ss2 ON ss2.student_id = d.student_id
                 WHERE ss2.supervisor_id = sup.id) AS document_count,
              (SELECT COALESCE(SUM(th.hours), 0) FROM training_hours th WHERE th.supervisor_id = sup.id) AS training_hours,
              (SELECT COALESCE(SUM(sh.hours), 0) FROM supervision_hours sh WHERE sh.supervisor_id = sup.id) AS supervision_hours,
              (SELECT MAX(al.created_at) FROM audit_logs al WHERE al.actor_id = sup.id) AS last_activity_at,
              (SELECT COUNT(*) FROM assignments a WHERE a.supervisor_id = sup.id) AS assignments_total,
              (SELECT COUNT(*) FROM assignments a WHERE a.supervisor_id = sup.id AND a.status = 'completed') AS assignments_completed,
              (SELECT CASE WHEN COUNT(*) = 0 THEN NULL
                      ELSE ROUND(100 * SUM(CASE WHEN a2.status = 'completed' THEN 1 ELSE 0 END) / COUNT(*), 1) END
                 FROM assignments a2 WHERE a2.supervisor_id = sup.id) AS completion_pct,
              (SELECT CASE WHEN COUNT(*) = 0 THEN NULL
                      ELSE ROUND(100 * SUM(CASE WHEN att.status = 'present' THEN 1 ELSE 0 END) / COUNT(*), 1) END
                 FROM attendance att WHERE att.supervisor_id = sup.id) AS attendance_rate
       FROM supervisors sup
       JOIN user_credentials uc ON uc.id = sup.id
       WHERE sup.group_id = ? AND sup.supervisor_type = 'in_training'
       ORDER BY sup.full_name`, [groupId]
        );

        res.json({ tots: rows });
    })
);

// GET /api/master-trainer/tots/:totId — full profile the MT can drill into
router.get(
    "/tots/:totId",
    asyncRoute(async(req, res, db) => {
        const { groupId } = req.masterTrainer;
        const totId = Number(req.params.totId);
        const tot = await loadGroupTot(db, groupId, totId, res);
        if (!tot) return;

        const { rows: students } = await db.query(
            `SELECT uc.id, uc.member_code, uc.status, st.full_name, st.current_year, c.name AS cohort_name
       FROM supervisor_students ss
       JOIN user_credentials uc ON uc.id = ss.student_id
       JOIN students st ON st.id = ss.student_id
       LEFT JOIN cohorts c ON c.id = st.cohort_id
       WHERE ss.supervisor_id = ?
       ORDER BY st.full_name`, [totId]
        );

        const { rows: statRows } = await db.query(
            `SELECT
        (SELECT COUNT(*) FROM sessions WHERE supervisor_id = ? AND session_type = 'training') AS training_sessions,
        (SELECT COUNT(*) FROM sessions WHERE supervisor_id = ? AND session_type = 'supervision') AS supervision_sessions,
        (SELECT COALESCE(SUM(hours), 0) FROM training_hours WHERE supervisor_id = ?) AS training_hours,
        (SELECT COALESCE(SUM(hours), 0) FROM supervision_hours WHERE supervisor_id = ?) AS supervision_hours,
        (SELECT COUNT(*) FROM assignments WHERE supervisor_id = ?) AS assignments_total,
        (SELECT COUNT(*) FROM assignments WHERE supervisor_id = ? AND status = 'completed') AS assignments_completed,
        (SELECT COUNT(*) FROM evaluations WHERE supervisor_id = ?) AS evaluation_count,
        (SELECT COUNT(*) FROM meetings WHERE supervisor_id = ?) AS meeting_count,
        (SELECT COUNT(*) FROM learning_materials WHERE supervisor_id = ?) AS material_count`,
            Array(9).fill(totId)
        );

        const recentRecords = await recentRecordsForSupervisor(db, totId, 20);
        const recentActivity = await recentActivityForActor(db, totId, 15);
        const documents = await recentDocumentsForSupervisor(db, totId, 20);
        const materials = await materialsForSupervisor(db, totId);
        const meetings = await meetingsForSupervisor(db, totId);

        res.json({
            trainer: tot,
            students,
            stats: statRows[0],
            recentRecords: recentRecords.map(toRecord),
            recentActivity,
            documents: documents.map(toDocument),
            materials: materials.map(toMaterial),
            meetings,
        });
    })
);

// GET /api/master-trainer/tots/:totId/students — trainees assigned to one ToT
router.get(
    "/tots/:totId/students",
    asyncRoute(async(req, res, db) => {
        const { groupId } = req.masterTrainer;
        const totId = Number(req.params.totId);
        const tot = await loadGroupTot(db, groupId, totId, res);
        if (!tot) return;

        const { rows } = await db.query(
            `SELECT uc.id, uc.member_code, uc.status, st.full_name, st.current_year, c.name AS cohort_name
       FROM supervisor_students ss
       JOIN user_credentials uc ON uc.id = ss.student_id
       JOIN students st ON st.id = ss.student_id
       LEFT JOIN cohorts c ON c.id = st.cohort_id
       WHERE ss.supervisor_id = ?
       ORDER BY st.full_name`, [totId]
        );
        res.json({ students: rows });
    })
);

// GET /api/master-trainer/tots/:totId/cv — read-only CV view of one ToT
// (email/phone/photo/bio/specialization only -- `supervisors` has no
// highest_degree/institution/certifications columns, those exist only on
// `students`, so this never fabricates a degree field for a ToT).
router.get(
    "/tots/:totId/cv",
    asyncRoute(async(req, res, db) => {
        const { groupId } = req.masterTrainer;
        const totId = Number(req.params.totId);
        const tot = await loadGroupTot(db, groupId, totId, res);
        if (!tot) return;

        res.json({
            id: tot.id,
            memberCode: tot.member_code,
            fullName: tot.full_name,
            email: tot.email,
            phone: tot.phone,
            photo: tot.photo,
            bio: tot.bio,
            specialization: tot.specialization,
            status: tot.status,
        });
    })
);

// ---- Trainees (group-wide) -------------------------------------------------

// GET /api/master-trainer/trainees
router.get(
    "/trainees",
    asyncRoute(async(req, res, db) => {
        const { groupId } = req.masterTrainer;
        if (!groupId) return noGroupResponse(res, { trainees: [] });

        const { rows } = await db.query(
            `SELECT uc.id, uc.member_code, uc.status, st.full_name, st.current_year, c.name AS cohort_name,
              COALESCE(
                (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', sup.id, 'fullName', sup.full_name))
                 FROM supervisor_students ss
                 JOIN supervisors sup ON sup.id = ss.supervisor_id
                 WHERE ss.student_id = st.id),
                JSON_ARRAY()
              ) AS tots,
              (SELECT COUNT(*) FROM assignments a WHERE a.student_id = st.id) AS assignments_total,
              (SELECT COUNT(*) FROM assignments a WHERE a.student_id = st.id AND a.status = 'completed') AS assignments_completed,
              (SELECT CASE WHEN COUNT(*) = 0 THEN NULL
                      ELSE ROUND(100 * SUM(CASE WHEN a2.status = 'completed' THEN 1 ELSE 0 END) / COUNT(*), 1) END
                 FROM assignments a2 WHERE a2.student_id = st.id) AS completion_pct,
              (SELECT CASE WHEN COUNT(*) = 0 THEN NULL
                      ELSE ROUND(100 * SUM(CASE WHEN att.status = 'present' THEN 1 ELSE 0 END) / COUNT(*), 1) END
                 FROM attendance att WHERE att.student_id = st.id) AS attendance_rate,
              (SELECT MAX(al.created_at) FROM audit_logs al WHERE al.entity_id = st.id
                 AND al.entity_type IN ('attendance','training_session','supervision_session','training_hours','supervision_hours','assignment','note','evaluation')) AS last_activity_at,
              (SELECT COUNT(*) FROM trainee_milestone_progress tmp WHERE tmp.student_id = st.id AND tmp.status = 'completed') AS milestones_completed,
              (SELECT COUNT(*) FROM training_milestones WHERE is_active = TRUE) AS milestones_total
       FROM students st
       JOIN user_credentials uc ON uc.id = st.id
       LEFT JOIN cohorts c ON c.id = st.cohort_id
       WHERE st.group_id = ?
       ORDER BY st.full_name`, [groupId]
        );
        res.json({ trainees: rows });
    })
);

// GET /api/master-trainer/trainees/:studentId
router.get(
    "/trainees/:studentId",
    asyncRoute(async(req, res, db) => {
        const { groupId } = req.masterTrainer;
        const studentId = Number(req.params.studentId);
        const student = await loadGroupStudent(db, groupId, studentId, res);
        if (!student) return;

        const { rows: tots } = await db.query(
            `SELECT sup.id, sup.full_name, sup.email, sup.phone
       FROM supervisor_students ss
       JOIN supervisors sup ON sup.id = ss.supervisor_id
       WHERE ss.student_id = ?`, [studentId]
        );

        const { rows: recordRows } = await db.query(
            `SELECT id, 'training_session' AS record_type, student_id, supervisor_id, title, session_date AS date, session_time AS time, duration_minutes, notes AS content
         FROM sessions WHERE student_id = ? AND session_type = 'training'
       UNION ALL
       SELECT id, 'supervision_session', student_id, supervisor_id, title, session_date, session_time, duration_minutes, notes
         FROM sessions WHERE student_id = ? AND session_type = 'supervision'
       UNION ALL
       SELECT id, 'attendance', student_id, supervisor_id, NULL, attendance_date, NULL, NULL, notes
         FROM attendance WHERE student_id = ?
       UNION ALL
       SELECT id, 'assignment', student_id, supervisor_id, title, due_date, NULL, NULL, description
         FROM assignments WHERE student_id = ?
       UNION ALL
       SELECT id, 'evaluation', student_id, supervisor_id, title, evaluation_date, NULL, NULL, content
         FROM evaluations WHERE student_id = ?
       ORDER BY date DESC
       LIMIT 30`, Array(5).fill(studentId)
        );

        const { rows: documents } = await db.query(
            `SELECT d.*, COALESCE(a.full_name, sup.full_name) AS uploaded_by_name FROM documents d
       LEFT JOIN admin_users a ON a.id = d.uploaded_by
       LEFT JOIN supervisors sup ON sup.id = d.uploaded_by
       WHERE d.student_id = ? ORDER BY d.created_at DESC`, [studentId]
        );

        const { rows: milestones } = await db.query(
            `SELECT tm.id AS milestone_id, tm.code, tm.name_en, tm.name_ar, tm.sort_order,
              COALESCE(tmp.status, 'not_started') AS status, tmp.completed_at
         FROM training_milestones tm
         LEFT JOIN trainee_milestone_progress tmp ON tmp.milestone_id = tm.id AND tmp.student_id = ?
        WHERE tm.is_active = TRUE
        ORDER BY tm.sort_order ASC`, [studentId]
        );

        res.json({
            student,
            tots,
            records: recordRows.map(toRecord),
            documents: documents.map(toDocument),
            milestones,
        });
    })
);

// ---- Group-wide monitoring lists -------------------------------------------

// GET /api/master-trainer/schedule — upcoming sessions across the whole group
router.get(
    "/schedule",
    asyncRoute(async(req, res, db) => {
        const { groupId } = req.masterTrainer;
        if (!groupId) return noGroupResponse(res, { today: [], upcoming: [] });

        const { rows } = await db.query(
            `SELECT s.id, s.session_type, s.title, s.session_date AS date, s.session_time AS time,
              s.duration_minutes, st.full_name AS student_name, sup.full_name AS trainer_name
       FROM sessions s
       JOIN students st ON st.id = s.student_id
       JOIN supervisors sup ON sup.id = s.supervisor_id
       WHERE sup.group_id = ? AND s.session_date >= CURRENT_DATE
       ORDER BY s.session_date ASC, (s.session_time IS NULL), s.session_time ASC
       LIMIT 100`, [groupId]
        );

        const todayStr = new Date().toISOString().slice(0, 10);
        const today = [],
            upcoming = [];
        for (const r of rows) {
            const item = {
                id: r.id,
                studentName: r.student_name,
                trainerName: r.trainer_name,
                recordType: r.session_type === "training" ? "training_session" : "supervision_session",
                date: r.date,
                time: r.time,
                durationMinutes: r.duration_minutes,
                title: r.title,
            };
            (String(r.date) === todayStr ? today : upcoming).push(item);
        }
        res.json({ today, upcoming: upcoming.slice(0, 15) });
    })
);

// GET /api/master-trainer/sessions?status=&from=&to= — full sessions overview
// (completed/upcoming/cancelled), unlike /schedule which only ever shows
// today+upcoming. Same join shape as /schedule, with the CURRENT_DATE
// floor dropped and optional status/date-range filters added.
router.get(
    "/sessions",
    asyncRoute(async(req, res, db) => {
        const { groupId } = req.masterTrainer;
        if (!groupId) return noGroupResponse(res, { sessions: [] });

        const { status, from, to } = req.query;
        const clauses = ["sup.group_id = ?"];
        const params = [groupId];
        if (status && ["scheduled", "completed", "cancelled"].includes(status)) {
            clauses.push("s.status = ?");
            params.push(status);
        }
        if (from) {
            clauses.push("s.session_date >= ?");
            params.push(from);
        }
        if (to) {
            clauses.push("s.session_date <= ?");
            params.push(to);
        }

        const { rows } = await db.query(
            `SELECT s.id, s.session_type, s.title, s.session_date AS date, s.session_time AS time,
              s.duration_minutes, s.location, s.notes, s.status,
              st.full_name AS student_name, sup.id AS tot_id, sup.full_name AS trainer_name
       FROM sessions s
       JOIN students st ON st.id = s.student_id
       JOIN supervisors sup ON sup.id = s.supervisor_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY s.session_date DESC, (s.session_time IS NULL), s.session_time DESC
       LIMIT 300`,
            params
        );

        res.json({
            sessions: rows.map((r) => ({
                id: r.id,
                recordType: r.session_type === "training" ? "training_session" : "supervision_session",
                title: r.title,
                date: r.date,
                time: r.time,
                durationMinutes: r.duration_minutes,
                location: r.location,
                notes: r.notes,
                status: r.status,
                studentName: r.student_name,
                totId: r.tot_id,
                trainerName: r.trainer_name,
            })),
        });
    })
);

// GET /api/master-trainer/assignments?status=&totId= — group-wide assignment
// overview. `status` is never trusted for "overdue" (nothing in the app
// ever sets that value) -- it's always computed live from due_date.
router.get(
    "/assignments",
    asyncRoute(async(req, res, db) => {
        const { groupId } = req.masterTrainer;
        if (!groupId) return noGroupResponse(res, { assignments: [], summary: { total: 0, completed: 0, pending: 0, overdue: 0, completionRatePct: null } });

        const { totId } = req.query;
        const clauses = ["sup.group_id = ?"];
        const params = [groupId];
        if (totId) {
            clauses.push("sup.id = ?");
            params.push(Number(totId));
        }

        const { rows } = await db.query(
            `SELECT a.id, a.title, a.due_date, a.status, a.max_score,
              st.full_name AS student_name, sup.id AS tot_id, sup.full_name AS trainer_name
       FROM assignments a
       JOIN students st ON st.id = a.student_id
       JOIN supervisors sup ON sup.id = a.supervisor_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY a.due_date ASC`,
            params
        );

        const todayStr = new Date().toISOString().slice(0, 10);
        let completed = 0,
            overdue = 0;
        const assignments = rows.map((r) => {
            const isCompleted = r.status === "completed";
            const isOverdue = !isCompleted && r.due_date && String(r.due_date).slice(0, 10) < todayStr;
            if (isCompleted) completed++;
            else if (isOverdue) overdue++;
            return {
                id: r.id,
                title: r.title,
                dueDate: r.due_date,
                maxScore: r.max_score,
                status: isCompleted ? "completed" : isOverdue ? "overdue" : "pending",
                studentName: r.student_name,
                totId: r.tot_id,
                trainerName: r.trainer_name,
            };
        });
        const filtered = req.query.status
            ? assignments.filter((a) => a.status === req.query.status)
            : assignments;

        res.json({
            assignments: filtered,
            summary: {
                total: assignments.length,
                completed,
                overdue,
                pending: assignments.length - completed - overdue,
                completionRatePct: assignments.length > 0 ? Math.round((completed / assignments.length) * 1000) / 10 : null,
            },
        });
    })
);

// Shared by GET /needs-attention and the Weekly Report's Recommendations
// section, so both read from exactly one rule implementation. Every rule is
// a real WHERE clause over real columns; no rule fires on missing data
// (e.g. a trainee with zero attendance rows is never flagged "low
// attendance" -- there's no evidence of a problem, only an absence of
// data, which is not the same thing and would be a fabricated alert).
async function computeNeedsAttentionItems(db, groupId) {
    const items = [];

    // Rule: overdue assignment (due_date < today, not completed) -- same
    // live-computed definition used everywhere else in this router.
    const { rows: overdueAssignments } = await db.query(
        `SELECT a.id, a.title, a.due_date, st.id AS student_id, st.full_name AS student_name
     FROM assignments a
     JOIN students st ON st.id = a.student_id
     JOIN supervisors sup ON sup.id = a.supervisor_id
     WHERE sup.group_id = ? AND a.due_date < CURRENT_DATE AND a.status NOT IN ('completed')
     ORDER BY a.due_date ASC`, [groupId]
    );
    overdueAssignments.forEach((a) => {
        items.push({
            ruleId: "overdue_assignment",
            severity: "high",
            entityType: "assignment",
            entityId: a.id,
            studentId: a.student_id,
            entityName: a.student_name,
            detail: `"${a.title}" was due ${String(a.due_date).slice(0, 10)}`,
            since: a.due_date,
        });
    });

    // Rule: trainee attendance rate below 70% over the last 30 days -- only
    // considers trainees who have at least one attendance row in that
    // window (HAVING total_count >= 1), so silence, not a false alert, is
    // what a brand-new trainee with no records yet gets.
    const { rows: lowAttendance } = await db.query(
        `SELECT st.id, st.full_name,
            SUM(CASE WHEN att.status = 'present' THEN 1 ELSE 0 END) AS present_count,
            COUNT(*) AS total_count
     FROM attendance att
     JOIN students st ON st.id = att.student_id
     WHERE st.group_id = ? AND att.attendance_date >= DATE_SUB(CURRENT_DATE, INTERVAL 30 DAY)
     GROUP BY st.id, st.full_name
     HAVING total_count >= 1 AND (present_count / total_count) < 0.70`, [groupId]
    );
    lowAttendance.forEach((s) => {
        const rate = Math.round((Number(s.present_count) / Number(s.total_count)) * 1000) / 10;
        items.push({
            ruleId: "low_attendance",
            severity: "medium",
            entityType: "trainee",
            entityId: s.id,
            studentId: s.id,
            entityName: s.full_name,
            detail: `Attendance is ${rate}% over the last 30 days (below the 70% threshold)`,
            since: null,
        });
    });

    // Rule: Trainer (ToT) with no session logged in the last 14 days
    // (including one who has never logged any session at all).
    const { rows: totActivity } = await db.query(
        `SELECT sup.id, sup.full_name, MAX(s.session_date) AS last_session
     FROM supervisors sup
     LEFT JOIN sessions s ON s.supervisor_id = sup.id
     WHERE sup.group_id = ? AND sup.supervisor_type = 'in_training'
     GROUP BY sup.id, sup.full_name`, [groupId]
    );
    totActivity.forEach((t) => {
        const lastSession = t.last_session ? new Date(t.last_session) : null;
        const daysSince = lastSession ? Math.floor((Date.now() - lastSession.getTime()) / 86400000) : null;
        if (!lastSession || daysSince > 14) {
            items.push({
                ruleId: "tot_inactive",
                severity: "medium",
                entityType: "trainer",
                entityId: t.id,
                entityName: t.full_name,
                detail: lastSession ? `No session logged in the last ${daysSince} days` : "No sessions logged yet",
                since: t.last_session,
            });
        }
    });

    // Rule: a session's date has passed but it was never marked completed
    // or cancelled -- a missing session report.
    const { rows: missedSessions } = await db.query(
        `SELECT s.id, s.title, s.session_date, st.id AS student_id, st.full_name AS student_name, sup.full_name AS trainer_name
     FROM sessions s
     JOIN students st ON st.id = s.student_id
     JOIN supervisors sup ON sup.id = s.supervisor_id
     WHERE sup.group_id = ? AND s.status = 'scheduled' AND s.session_date < CURRENT_DATE
     ORDER BY s.session_date ASC`, [groupId]
    );
    missedSessions.forEach((s) => {
        items.push({
            ruleId: "unmarked_session",
            severity: "medium",
            entityType: "session",
            entityId: s.id,
            studentId: s.student_id,
            entityName: s.student_name,
            detail: `Session with ${s.trainer_name} on ${String(s.session_date).slice(0, 10)} was never marked completed or cancelled`,
            since: s.session_date,
        });
    });

    const severityRank = { high: 0, medium: 1, low: 2 };
    items.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
    return items;
}

// GET /api/master-trainer/needs-attention
router.get(
    "/needs-attention",
    asyncRoute(async(req, res, db) => {
        const { groupId } = req.masterTrainer;
        if (!groupId) return noGroupResponse(res, { items: [], counts: { high: 0, medium: 0, low: 0 } });

        const items = await computeNeedsAttentionItems(db, groupId);
        res.json({
            items,
            counts: {
                high: items.filter((i) => i.severity === "high").length,
                medium: items.filter((i) => i.severity === "medium").length,
                low: items.filter((i) => i.severity === "low").length,
            },
        });
    })
);

// GET /api/master-trainer/analytics?from=&to= — date-range aggregate stats +
// a per-ToT comparison, for the Analytics section's charts. Defaults to the
// last 7 days if no range given. Every number is a real query over the
// given date range -- no synthetic/interpolated data points.
router.get(
    "/analytics",
    asyncRoute(async(req, res, db) => {
        const { groupId } = req.masterTrainer;
        const emptyShape = {
            range: { from: null, to: null }, sessionsCompleted: 0, sessionsScheduled: 0, sessionsCancelled: 0,
            assignmentsTotal: 0, assignmentsCompleted: 0, attendanceRatePct: null, completionRatePct: null,
            dailySessionsCompleted: [], totComparison: [],
        };
        if (!groupId) return noGroupResponse(res, emptyShape);

        const today = new Date();
        const to = (req.query.to && String(req.query.to)) || today.toISOString().slice(0, 10);
        const defaultFrom = new Date(today.getTime() - 6 * 86400000).toISOString().slice(0, 10);
        const from = (req.query.from && String(req.query.from)) || defaultFrom;

        const rangeParams = Array(7).fill([groupId, from, to]).flat();
        const { rows: summaryRows } = await db.query(
            `SELECT
        (SELECT COUNT(*) FROM sessions s JOIN supervisors sup ON sup.id = s.supervisor_id
           WHERE sup.group_id = ? AND s.session_date BETWEEN ? AND ? AND s.status = 'completed') AS sessions_completed,
        (SELECT COUNT(*) FROM sessions s JOIN supervisors sup ON sup.id = s.supervisor_id
           WHERE sup.group_id = ? AND s.session_date BETWEEN ? AND ? AND s.status = 'scheduled') AS sessions_scheduled,
        (SELECT COUNT(*) FROM sessions s JOIN supervisors sup ON sup.id = s.supervisor_id
           WHERE sup.group_id = ? AND s.session_date BETWEEN ? AND ? AND s.status = 'cancelled') AS sessions_cancelled,
        (SELECT COUNT(*) FROM assignments a JOIN supervisors sup ON sup.id = a.supervisor_id
           WHERE sup.group_id = ? AND a.due_date BETWEEN ? AND ?) AS assignments_total,
        (SELECT COUNT(*) FROM assignments a JOIN supervisors sup ON sup.id = a.supervisor_id
           WHERE sup.group_id = ? AND a.due_date BETWEEN ? AND ? AND a.status = 'completed') AS assignments_completed,
        (SELECT COUNT(*) FROM attendance att JOIN supervisors sup ON sup.id = att.supervisor_id
           WHERE sup.group_id = ? AND att.attendance_date BETWEEN ? AND ? AND att.status = 'present') AS attendance_present,
        (SELECT COUNT(*) FROM attendance att JOIN supervisors sup ON sup.id = att.supervisor_id
           WHERE sup.group_id = ? AND att.attendance_date BETWEEN ? AND ?) AS attendance_total`,
            rangeParams
        );
        const r = summaryRows[0];
        const assignmentsTotal = Number(r.assignments_total);
        const assignmentsCompleted = Number(r.assignments_completed);
        const attendanceTotal = Number(r.attendance_total);
        const attendancePresent = Number(r.attendance_present);

        const { rows: dailyRows } = await db.query(
            `SELECT s.session_date AS date, COUNT(*) AS count
       FROM sessions s JOIN supervisors sup ON sup.id = s.supervisor_id
       WHERE sup.group_id = ? AND s.session_date BETWEEN ? AND ? AND s.status = 'completed'
       GROUP BY s.session_date
       ORDER BY s.session_date ASC`, [groupId, from, to]
        );

        const totParams = [...Array(5).fill([from, to]).flat(), groupId];
        const { rows: totRows } = await db.query(
            `SELECT sup.id, sup.full_name,
              (SELECT COUNT(*) FROM sessions s WHERE s.supervisor_id = sup.id AND s.session_date BETWEEN ? AND ? AND s.status = 'completed') AS sessions_completed,
              (SELECT COUNT(*) FROM assignments a WHERE a.supervisor_id = sup.id AND a.due_date BETWEEN ? AND ?) AS assignments_total,
              (SELECT COUNT(*) FROM assignments a WHERE a.supervisor_id = sup.id AND a.due_date BETWEEN ? AND ? AND a.status = 'completed') AS assignments_completed,
              (SELECT COUNT(CASE WHEN att.status = 'present' THEN 1 END) FROM attendance att WHERE att.supervisor_id = sup.id AND att.attendance_date BETWEEN ? AND ?) AS attendance_present,
              (SELECT COUNT(*) FROM attendance att WHERE att.supervisor_id = sup.id AND att.attendance_date BETWEEN ? AND ?) AS attendance_total
       FROM supervisors sup
       WHERE sup.group_id = ? AND sup.supervisor_type = 'in_training'
       ORDER BY sup.full_name`, totParams
        );

        res.json({
            range: { from, to },
            sessionsCompleted: Number(r.sessions_completed),
            sessionsScheduled: Number(r.sessions_scheduled),
            sessionsCancelled: Number(r.sessions_cancelled),
            assignmentsTotal,
            assignmentsCompleted,
            attendanceRatePct: attendanceTotal > 0 ? Math.round((attendancePresent / attendanceTotal) * 1000) / 10 : null,
            completionRatePct: assignmentsTotal > 0 ? Math.round((assignmentsCompleted / assignmentsTotal) * 1000) / 10 : null,
            dailySessionsCompleted: dailyRows.map((d) => ({ date: d.date, count: Number(d.count) })),
            totComparison: totRows.map((t) => {
                const tTotal = Number(t.assignments_total);
                const tCompleted = Number(t.assignments_completed);
                const tAttTotal = Number(t.attendance_total);
                const tAttPresent = Number(t.attendance_present);
                return {
                    id: t.id,
                    fullName: t.full_name,
                    sessionsCompleted: Number(t.sessions_completed),
                    assignmentsTotal: tTotal,
                    assignmentsCompleted: tCompleted,
                    completionRatePct: tTotal > 0 ? Math.round((tCompleted / tTotal) * 1000) / 10 : null,
                    attendanceRatePct: tAttTotal > 0 ? Math.round((tAttPresent / tAttTotal) * 1000) / 10 : null,
                };
            }),
        });
    })
);

// ---- Weekly Training Reports ---------------------------------------------
// Computed on demand for any ISO week, no snapshot table -- every fact (a
// session, an assignment, an audit row) is timestamped and re-queried live,
// so a report for a past week always reflects the current state of that
// week's data (e.g. if a ToT corrects a session's date afterward, the
// report reflects the correction, not a frozen wrong snapshot).

/** ISO 8601 week string ("2026-W34") for the given Date, in UTC. */
function isoWeekOf(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

/** Monday-Sunday date range (YYYY-MM-DD strings) for an ISO week string. */
function isoWeekToDateRange(weekStr) {
    const [yearStr, wStr] = String(weekStr).split("-W");
    const year = Number(yearStr);
    const week = Number(wStr);
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const jan4Day = jan4.getUTCDay() || 7;
    const week1Monday = new Date(jan4);
    week1Monday.setUTCDate(jan4.getUTCDate() - jan4Day + 1);
    const monday = new Date(week1Monday);
    monday.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
    const sunday = new Date(monday);
    sunday.setUTCDate(monday.getUTCDate() + 6);
    return { start: monday.toISOString().slice(0, 10), end: sunday.toISOString().slice(0, 10) };
}

// GET /api/master-trainer/reports/weekly/history — last N weeks with a
// lightweight session-activity count each, to populate the report picker
// without fetching every week's full report.
router.get(
    "/reports/weekly/history",
    asyncRoute(async(req, res, db) => {
        const { groupId } = req.masterTrainer;
        if (!groupId) return noGroupResponse(res, { weeks: [] });

        const weeksBack = Math.min(Number(req.query.count) || 8, 26);
        const currentWeek = isoWeekOf(new Date());
        const weeks = [];
        const cursor = new Date();
        for (let i = 0; i < weeksBack; i++) {
            const weekStr = isoWeekOf(cursor);
            const { start, end } = isoWeekToDateRange(weekStr);
            weeks.push({ week: weekStr, start, end, isCurrent: weekStr === currentWeek });
            cursor.setUTCDate(cursor.getUTCDate() - 7);
        }

        const earliestStart = weeks[weeks.length - 1].start;
        const { rows } = await db.query(
            `SELECT s.session_date AS date, COUNT(*) AS count
       FROM sessions s JOIN supervisors sup ON sup.id = s.supervisor_id
       WHERE sup.group_id = ? AND s.session_date >= ?
       GROUP BY s.session_date`, [groupId, earliestStart]
        );
        const countsByDate = {};
        rows.forEach((r) => { countsByDate[String(r.date).slice(0, 10)] = Number(r.count); });

        weeks.forEach((w) => {
            let total = 0;
            const d = new Date(w.start + "T00:00:00Z");
            for (let i = 0; i < 7; i++) {
                total += countsByDate[d.toISOString().slice(0, 10)] || 0;
                d.setUTCDate(d.getUTCDate() + 1);
            }
            w.sessionsCount = total;
        });

        res.json({ weeks });
    })
);

// GET /api/master-trainer/reports/weekly?week=2026-W34 — full report for one
// ISO week (defaults to the current week).
router.get(
    "/reports/weekly",
    asyncRoute(async(req, res, db) => {
        const { groupId } = req.masterTrainer;
        const emptyShape = {
            week: null, range: null, executiveSummary: null, sessions: [], totPerformance: [],
            traineeProgress: [], materials: [], milestonesAchieved: [], recommendations: [],
        };
        if (!groupId) return noGroupResponse(res, emptyShape);

        const week = (req.query.week && String(req.query.week)) || isoWeekOf(new Date());
        const { start, end } = isoWeekToDateRange(week);
        const startDT = `${start} 00:00:00`;
        const endDT = `${end} 23:59:59`;

        // ---- Executive summary --------------------------------------------
        const { rows: summaryRows } = await db.query(
            `SELECT
        (SELECT COUNT(*) FROM sessions s JOIN supervisors sup ON sup.id = s.supervisor_id
           WHERE sup.group_id = ? AND s.session_date BETWEEN ? AND ?) AS sessions_total,
        (SELECT COUNT(*) FROM sessions s JOIN supervisors sup ON sup.id = s.supervisor_id
           WHERE sup.group_id = ? AND s.session_date BETWEEN ? AND ? AND s.status = 'completed') AS sessions_completed,
        (SELECT COUNT(*) FROM sessions s JOIN supervisors sup ON sup.id = s.supervisor_id
           WHERE sup.group_id = ? AND s.session_date BETWEEN ? AND ? AND s.status = 'cancelled') AS sessions_cancelled,
        (SELECT COUNT(*) FROM students st JOIN user_credentials uc ON uc.id = st.id
           WHERE st.group_id = ? AND uc.status = 'active') AS active_trainees,
        (SELECT CASE WHEN COUNT(*) = 0 THEN NULL
                ELSE ROUND(100 * SUM(CASE WHEN att.status = 'present' THEN 1 ELSE 0 END) / COUNT(*), 1) END
           FROM attendance att JOIN supervisors sup ON sup.id = att.supervisor_id
           WHERE sup.group_id = ? AND att.attendance_date BETWEEN ? AND ?) AS attendance_rate,
        (SELECT COUNT(*) FROM assignments a JOIN supervisors sup ON sup.id = a.supervisor_id
           WHERE sup.group_id = ? AND a.due_date BETWEEN ? AND ? AND a.status = 'completed') AS assignments_completed,
        (SELECT COUNT(*) FROM learning_materials lm JOIN supervisors sup ON sup.id = lm.supervisor_id
           WHERE sup.group_id = ? AND lm.created_at BETWEEN ? AND ?) AS materials_added,
        (SELECT COUNT(*) FROM trainee_milestone_progress tmp JOIN students st ON st.id = tmp.student_id
           WHERE st.group_id = ? AND tmp.status = 'completed' AND tmp.completed_at BETWEEN ? AND ?) AS milestones_achieved`,
            [
                groupId, start, end,
                groupId, start, end,
                groupId, start, end,
                groupId,
                groupId, start, end,
                groupId, start, end,
                groupId, startDT, endDT,
                groupId, startDT, endDT,
            ]
        );
        const sm = summaryRows[0];

        // ---- Recommendations (current needs-attention state -- see the
        // route's own comment for why this isn't recomputed historically). --
        const attentionItems = await computeNeedsAttentionItems(db, groupId);

        // ---- Sessions this week --------------------------------------------
        const { rows: sessionRows } = await db.query(
            `SELECT s.id, s.session_type, s.title, s.session_date AS date, s.session_time AS time,
              s.duration_minutes, s.status, st.full_name AS student_name, sup.id AS tot_id, sup.full_name AS trainer_name
       FROM sessions s
       JOIN students st ON st.id = s.student_id
       JOIN supervisors sup ON sup.id = s.supervisor_id
       WHERE sup.group_id = ? AND s.session_date BETWEEN ? AND ?
       ORDER BY s.session_date ASC, (s.session_time IS NULL), s.session_time ASC`, [groupId, start, end]
        );
        const sessions = sessionRows.map((r) => ({
            id: r.id,
            recordType: r.session_type === "training" ? "training_session" : "supervision_session",
            title: r.title,
            date: r.date,
            time: r.time,
            durationMinutes: r.duration_minutes,
            status: r.status,
            studentName: r.student_name,
            totId: r.tot_id,
            trainerName: r.trainer_name,
        }));

        // ---- Per-ToT performance this week -----------------------------
        const { rows: totRows } = await db.query(
            `SELECT sup.id, sup.full_name FROM supervisors sup WHERE sup.group_id = ? AND sup.supervisor_type = 'in_training' ORDER BY sup.full_name`,
            [groupId]
        );
        const totPerformance = totRows.map((t) => {
            const totSessions = sessions.filter((s) => s.totId === t.id);
            return {
                id: t.id,
                fullName: t.full_name,
                sessionsCompleted: totSessions.filter((s) => s.status === "completed").length,
                sessionsTotal: totSessions.length,
                outstandingItems: attentionItems.filter((i) => i.entityType === "trainer" && i.entityId === t.id).map((i) => i.detail),
            };
        });

        // ---- Materials added this week --------------------------------
        const { rows: materialRows } = await db.query(
            `SELECT lm.id, lm.title, lm.material_type, lm.created_at, sup.full_name AS trainer_name
       FROM learning_materials lm JOIN supervisors sup ON sup.id = lm.supervisor_id
       WHERE sup.group_id = ? AND lm.created_at BETWEEN ? AND ?
       ORDER BY lm.created_at DESC`, [groupId, startDT, endDT]
        );

        // ---- Milestones achieved this week -----------------------------
        const { rows: milestoneRows } = await db.query(
            `SELECT tmp.completed_at, st.full_name AS student_name, tm.name_en AS milestone_name
       FROM trainee_milestone_progress tmp
       JOIN students st ON st.id = tmp.student_id
       JOIN training_milestones tm ON tm.id = tmp.milestone_id
       WHERE st.group_id = ? AND tmp.status = 'completed' AND tmp.completed_at BETWEEN ? AND ?
       ORDER BY tmp.completed_at DESC`, [groupId, startDT, endDT]
        );

        // ---- Trainee progress buckets -----------------------------------
        // On Track / Needs Attention / Behind Schedule / Completed Milestone,
        // derived from the same needs-attention rules + this week's milestone
        // completions + the group's existing completion/attendance figures
        // (reusing the same subqueries already proven in GET /trainees).
        const { rows: traineeRows } = await db.query(
            `SELECT st.id, st.full_name,
              (SELECT CASE WHEN COUNT(*) = 0 THEN NULL
                      ELSE ROUND(100 * SUM(CASE WHEN a2.status = 'completed' THEN 1 ELSE 0 END) / COUNT(*), 1) END
                 FROM assignments a2 WHERE a2.student_id = st.id) AS completion_pct,
              (SELECT CASE WHEN COUNT(*) = 0 THEN NULL
                      ELSE ROUND(100 * SUM(CASE WHEN att.status = 'present' THEN 1 ELSE 0 END) / COUNT(*), 1) END
                 FROM attendance att WHERE att.student_id = st.id) AS attendance_rate
       FROM students st WHERE st.group_id = ? ORDER BY st.full_name`, [groupId]
        );
        const milestoneNamesByStudent = {};
        milestoneRows.forEach((m) => {
            (milestoneNamesByStudent[m.student_name] = milestoneNamesByStudent[m.student_name] || []).push(m.milestone_name);
        });
        const traineeProgress = traineeRows.map((s) => {
            const issues = attentionItems.filter((i) => i.studentId === s.id);
            const achievedThisWeek = milestoneNamesByStudent[s.full_name];
            let bucket, reason;
            if (issues.length) {
                bucket = "needs_attention";
                reason = issues.map((i) => i.detail).join("; ");
            } else if (achievedThisWeek) {
                bucket = "completed_milestone";
                reason = `Completed: ${achievedThisWeek.join(", ")}`;
            } else if ((s.completion_pct !== null && s.completion_pct < 50) || (s.attendance_rate !== null && s.attendance_rate < 50)) {
                bucket = "behind_schedule";
                reason = "Completion or attendance is below 50%";
            } else {
                bucket = "on_track";
                reason = null;
            }
            return { id: s.id, fullName: s.full_name, bucket, reason };
        });

        res.json({
            week,
            range: { start, end },
            executiveSummary: {
                sessionsTotal: Number(sm.sessions_total),
                sessionsCompleted: Number(sm.sessions_completed),
                sessionsCancelled: Number(sm.sessions_cancelled),
                activeTrainees: Number(sm.active_trainees),
                attendanceRatePct: sm.attendance_rate !== null ? Number(sm.attendance_rate) : null,
                assignmentsCompleted: Number(sm.assignments_completed),
                materialsAdded: Number(sm.materials_added),
                milestonesAchieved: Number(sm.milestones_achieved),
                issuesRequiringAttention: attentionItems.length,
            },
            sessions,
            totPerformance,
            traineeProgress,
            materials: materialRows.map((m) => ({
                id: m.id, title: m.title, materialType: m.material_type, createdAt: m.created_at, trainerName: m.trainer_name,
            })),
            milestonesAchieved: milestoneRows.map((m) => ({
                studentName: m.student_name, milestoneName: m.milestone_name, completedAt: m.completed_at,
            })),
            recommendations: attentionItems.map((i) => ({ ruleId: i.ruleId, severity: i.severity, entityName: i.entityName, detail: i.detail })),
        });
    })
);

// GET /api/master-trainer/milestones — group-wide milestone completion
// overview: for every active milestone, how many of the group's trainees
// have completed it (and who). Read-only -- marking progress happens on
// routes/supervisor.js, by the Trainer (ToT) who actually runs the training.
router.get(
    "/milestones",
    asyncRoute(async(req, res, db) => {
        const { groupId } = req.masterTrainer;
        if (!groupId) return noGroupResponse(res, { milestones: [], traineeCount: 0 });

        const { rows: traineeCountRows } = await db.query("SELECT COUNT(*) AS count FROM students WHERE group_id = ?", [groupId]);
        const traineeCount = Number(traineeCountRows[0].count);

        const { rows: milestoneRows } = await db.query(
            "SELECT id, code, name_en, name_ar, sort_order FROM training_milestones WHERE is_active = TRUE ORDER BY sort_order ASC"
        );

        const milestones = [];
        for (const m of milestoneRows) {
            const { rows: completedRows } = await db.query(
                `SELECT st.id, st.full_name, tmp.completed_at
           FROM trainee_milestone_progress tmp
           JOIN students st ON st.id = tmp.student_id
          WHERE tmp.milestone_id = ? AND st.group_id = ? AND tmp.status = 'completed'
          ORDER BY tmp.completed_at DESC`, [m.id, groupId]
            );
            milestones.push({
                id: m.id,
                code: m.code,
                nameEn: m.name_en,
                nameAr: m.name_ar,
                completedCount: completedRows.length,
                traineeCount,
                completionPct: traineeCount > 0 ? Math.round((completedRows.length / traineeCount) * 1000) / 10 : null,
                completedBy: completedRows.map((r) => ({ id: r.id, fullName: r.full_name, completedAt: r.completed_at })),
            });
        }

        res.json({ milestones, traineeCount });
    })
);

// GET /api/master-trainer/meetings — every meeting scheduled by any ToT in the group
router.get(
    "/meetings",
    asyncRoute(async(req, res, db) => {
        const { groupId } = req.masterTrainer;
        if (!groupId) return noGroupResponse(res, { meetings: [] });

        const { rows } = await db.query(
            `SELECT m.*, st.full_name AS student_name, sup.full_name AS trainer_name FROM meetings m
       JOIN supervisors sup ON sup.id = m.supervisor_id
       LEFT JOIN students st ON st.id = m.student_id
       WHERE sup.group_id = ?
       ORDER BY (m.scheduled_at IS NULL), m.scheduled_at ASC
       LIMIT 100`, [groupId]
        );
        res.json({ meetings: rows });
    })
);

// GET /api/master-trainer/materials — every material shared by any ToT in the group
router.get(
    "/materials",
    asyncRoute(async(req, res, db) => {
        const { groupId } = req.masterTrainer;
        if (!groupId) return noGroupResponse(res, { materials: [] });

        const { rows } = await db.query(
            `SELECT lm.*, sup.full_name AS supervisor_name,
                    (SELECT a.id FROM assignments a
                      WHERE a.student_id = lm.student_id AND a.supervisor_id = lm.supervisor_id
                        AND LOWER(a.title) = LOWER(lm.title)
                      ORDER BY a.id DESC LIMIT 1) AS matched_assignment_id
       FROM learning_materials lm
       JOIN supervisors sup ON sup.id = lm.supervisor_id
       WHERE sup.group_id = ?
       ORDER BY lm.created_at DESC
       LIMIT 100`, [groupId]
        );
        res.json({ materials: rows.map(toMaterial) });
    })
);

// GET /api/master-trainer/documents — every document uploaded for a trainee in the group
router.get(
    "/documents",
    asyncRoute(async(req, res, db) => {
        const { groupId } = req.masterTrainer;
        if (!groupId) return noGroupResponse(res, { documents: [] });

        const { rows } = await db.query(
            `SELECT d.*, st.full_name AS student_name, uc.member_code AS student_code,
              COALESCE(a.full_name, sup.full_name) AS uploaded_by_name
       FROM documents d
       JOIN students st ON st.id = d.student_id
       JOIN user_credentials uc ON uc.id = st.id
       LEFT JOIN admin_users a ON a.id = d.uploaded_by
       LEFT JOIN supervisors sup ON sup.id = d.uploaded_by
       WHERE st.group_id = ?
       ORDER BY d.created_at DESC
       LIMIT 200`, [groupId]
        );
        res.json({ documents: rows.map(toDocument) });
    })
);

// GET /api/master-trainer/activity — recent audit log entries for every ToT in the group
router.get(
    "/activity",
    asyncRoute(async(req, res, db) => {
        const { groupId } = req.masterTrainer;
        if (!groupId) return noGroupResponse(res, { activity: [] });

        const { rows } = await db.query(
            `SELECT al.action, al.created_at, sup.full_name AS trainer_name, st.full_name AS student_name
       FROM audit_logs al
       JOIN supervisors sup ON sup.id = al.actor_id
       LEFT JOIN students st ON st.id = al.entity_id
         AND al.entity_type IN ('attendance','training_session','supervision_session','training_hours','supervision_hours','assignment','note','evaluation')
       WHERE sup.group_id = ?
       ORDER BY al.created_at DESC
       LIMIT 40`, [groupId]
        );
        res.json({
            activity: rows.map((r) => ({
                action: r.action,
                trainerName: r.trainer_name,
                studentName: r.student_name,
                createdAt: r.created_at,
            })),
        });
    })
);

// GET /api/master-trainer/calendar-events?start=&end= — group-wide custom calendar entries
router.get(
    "/calendar-events",
    asyncRoute(async(req, res, db) => {
        const { groupId } = req.masterTrainer;
        if (!groupId) return noGroupResponse(res, { events: [] });

        const { start, end } = req.query;
        const params = [groupId];
        let dateFilter = "";
        if (start && end) {
            params.push(start, end);
            dateFilter = "AND ce.event_date BETWEEN ? AND ?";
        }
        const { rows } = await db.query(
            `SELECT ce.*, sup.full_name AS trainer_name, st.full_name AS student_name
       FROM calendar_events ce
       JOIN supervisors sup ON sup.id = ce.owner_id
       LEFT JOIN students st ON st.id = ce.student_id
       WHERE sup.group_id = ? ${dateFilter}
       ORDER BY ce.event_date ASC, (ce.event_time IS NULL), ce.event_time ASC`,
            params
        );
        res.json({ events: rows });
    })
);

// ---- Shared query helpers ---------------------------------------------

async function recentRecordsForSupervisor(db, supervisorId, limit) {
    const { rows } = await db.query(
        `SELECT id, 'training_session' AS record_type, student_id, supervisor_id, title, session_date AS date, session_time AS time, duration_minutes, notes AS content
       FROM sessions WHERE supervisor_id = ? AND session_type = 'training'
     UNION ALL
     SELECT id, 'supervision_session', student_id, supervisor_id, title, session_date, session_time, duration_minutes, notes
       FROM sessions WHERE supervisor_id = ? AND session_type = 'supervision'
     UNION ALL
     SELECT id, 'attendance', student_id, supervisor_id, NULL, attendance_date, NULL, NULL, notes
       FROM attendance WHERE supervisor_id = ?
     UNION ALL
     SELECT id, 'assignment', student_id, supervisor_id, title, due_date, NULL, NULL, description
       FROM assignments WHERE supervisor_id = ?
     UNION ALL
     SELECT id, 'evaluation', student_id, supervisor_id, title, evaluation_date, NULL, NULL, content
       FROM evaluations WHERE supervisor_id = ?
     UNION ALL
     SELECT id, 'note', student_id, supervisor_id, NULL, note_date, NULL, NULL, content
       FROM supervisor_notes WHERE supervisor_id = ?
     ORDER BY date DESC
     LIMIT ?`, [...Array(6).fill(supervisorId), limit]
    );
    const supNames = await attachSupervisorNamesLocal(db, rows);
    return supNames;
}

async function attachSupervisorNamesLocal(db, rows) {
    const supIds = [...new Set(rows.map((r) => r.supervisor_id))];
    if (!supIds.length) return rows;
    const { rows: supRows } = await db.query("SELECT id, full_name FROM supervisors WHERE id IN (?)", [supIds]);
    const names = {};
    supRows.forEach((r) => (names[r.id] = r.full_name));
    return rows.map((r) => ({...r, supervisor_name: names[r.supervisor_id] }));
}

async function recentActivityForActor(db, actorId, limit) {
    const { rows } = await db.query(
        `SELECT al.action, al.created_at, st.full_name AS student_name
     FROM audit_logs al
     LEFT JOIN students st ON st.id = al.entity_id
     WHERE al.actor_id = ?
     ORDER BY al.created_at DESC
     LIMIT ?`, [actorId, limit]
    );
    return rows.map((r) => ({ action: r.action, studentName: r.student_name, createdAt: r.created_at }));
}

async function recentDocumentsForSupervisor(db, supervisorId, limit) {
    const { rows } = await db.query(
        `SELECT d.* FROM documents d
     JOIN supervisor_students ss ON ss.student_id = d.student_id
     WHERE ss.supervisor_id = ?
     ORDER BY d.created_at DESC
     LIMIT ?`, [supervisorId, limit]
    );
    return rows;
}

async function materialsForSupervisor(db, supervisorId) {
    const { rows } = await db.query(
        "SELECT * FROM learning_materials WHERE supervisor_id = ? ORDER BY created_at DESC", [supervisorId]
    );
    return rows;
}

async function meetingsForSupervisor(db, supervisorId) {
    const { rows } = await db.query(
        `SELECT m.*, st.full_name AS student_name FROM meetings m
     LEFT JOIN students st ON st.id = m.student_id
     WHERE m.supervisor_id = ?
     ORDER BY (m.scheduled_at IS NULL), m.scheduled_at ASC`, [supervisorId]
    );
    return rows;
}

module.exports = router;
