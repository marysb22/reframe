const express = require("express");
const { requireAuth, asyncRoute } = require("../middleware/auth");
const { toRecord, toDocument, toMaterial } = require("../utils/serializers");

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
            sup.full_name, sup.email, sup.phone, sup.photo, sup.group_id, sup.supervisor_type
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
              sup.full_name, sup.email, sup.phone, sup.photo,
              (SELECT COUNT(*) FROM supervisor_students ss WHERE ss.supervisor_id = sup.id) AS trainee_count,
              (SELECT COUNT(*) FROM sessions s WHERE s.supervisor_id = sup.id) AS session_count,
              (SELECT COUNT(*) FROM meetings m WHERE m.supervisor_id = sup.id) AS meeting_count,
              (SELECT COUNT(*) FROM documents d
                 JOIN supervisor_students ss2 ON ss2.student_id = d.student_id
                 WHERE ss2.supervisor_id = sup.id) AS document_count,
              (SELECT COALESCE(SUM(th.hours), 0) FROM training_hours th WHERE th.supervisor_id = sup.id) AS training_hours,
              (SELECT COALESCE(SUM(sh.hours), 0) FROM supervision_hours sh WHERE sh.supervisor_id = sup.id) AS supervision_hours,
              (SELECT MAX(al.created_at) FROM audit_logs al WHERE al.actor_id = sup.id) AS last_activity_at
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
              ) AS tots
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

        res.json({
            student,
            tots,
            records: recordRows.map(toRecord),
            documents: documents.map(toDocument),
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
            `SELECT lm.*, sup.full_name AS supervisor_name FROM learning_materials lm
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
