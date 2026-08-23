const express = require("express");
const fs = require("fs");
const path = require("path");
const { requireAuth, requireAdmin, asyncRoute } = require("../middleware/auth");
const { generateNextId } = require("../utils/idGenerator");
const { hashPassword, generateTempPassword } = require("../utils/authUtils");
const {
  toArray,
  toPublicUser,
  toProfileResponse,
  toPublicEvent,
  toEventDetail,
  toPaymentSummary,
  toPaymentTransaction,
  toRecord,
  toDocument,
  computeProgressSummary,
} = require("../utils/serializers");
const { eventImageUpload } = require("../utils/uploads");
const { fetchEventChildren, writeEventChildren, generateUniqueSlug } = require("../utils/eventChildren");
const { buildRecordsQuery } = require("../utils/recordsQuery");

const router = express.Router();

router.use(requireAuth, requireAdmin);

// Every account-management query joins the three profile tables and their
// cohort, so a single row shape covers both a student and a supervisor
// (the columns that don't apply to that role just come back NULL).
// The `supervisors` JSON list is built via an ordered derived table because
// MySQL's JSON_ARRAYAGG (unlike Postgres's json_agg) has no inline ORDER BY.
const USER_SELECT = `
  SELECT
    uc.id, uc.member_code, uc.role, uc.status, uc.must_change_password,
    uc.created_at, uc.updated_at,
    COALESCE(sup.full_name, st.full_name) AS full_name,
    COALESCE(sup.email, st.email) AS email,
    COALESCE(sup.phone, st.phone) AS phone,
    COALESCE(sup.photo, st.photo) AS photo,
    sup.specialization, sup.bio, sup.supervisor_type,
    st.gender, st.date_of_birth, st.marital_status, st.address, st.certifications, st.cv_file,
    st.cohort_id, c.name AS cohort_name, st.current_year, st.highest_degree, st.institution,
    COALESCE(
      (SELECT JSON_ARRAYAGG(obj) FROM (
         SELECT JSON_OBJECT('id', sup2.id, 'full_name', sup2.full_name) AS obj
         FROM supervisor_students ss JOIN supervisors sup2 ON sup2.id = ss.supervisor_id
         WHERE ss.student_id = uc.id
         ORDER BY sup2.full_name
       ) t),
      JSON_ARRAY()
    ) AS supervisors
  FROM user_credentials uc
  LEFT JOIN supervisors sup ON sup.id = uc.id
  LEFT JOIN students st ON st.id = uc.id
  LEFT JOIN cohorts c ON c.id = st.cohort_id
`;

function parseIdParam(raw) {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Resolves a free-text cohort name to its id, creating the cohort if it doesn't exist yet. */
async function resolveCohortId(db, cohortName) {
  if (!cohortName || !String(cohortName).trim()) return null;
  const name = String(cohortName).trim();
  const existing = await db.query("SELECT id FROM cohorts WHERE name = ?", [name]);
  if (existing.rows.length) return existing.rows[0].id;
  const created = await db.query("INSERT INTO cohorts (name) VALUES (?)", [name]);
  return created.insertId;
}

// ---- Accounts (Trainees + Master Trainers/Trainers) ---------------------

// POST /api/admin/users
// Creates a Trainee or Supervisor (Master Trainer/Trainer) account. Admin
// accounts are never created through this route -- there is exactly one,
// seeded directly in the database, per the "one static Admin account"
// requirement.
router.post(
  "/users",
  asyncRoute(async (req, res, db) => {
    const {
      full_name,
      email,
      role,
      cohort,
      currentYear,
      tempPassword,
      memberCode: manualCode,
    } = req.body || {};

    if (!full_name || !String(full_name).trim()) {
      return res.status(400).json({ error: "Full name is required" });
    }

    const allowedRoles = ["trainee", "supervisor"];
    if (role === "admin" || role === "designer") {
      return res.status(400).json({
        error: "Admin and Designer accounts can't be created here.",
      });
    }
    const finalRole = allowedRoles.includes(role) ? role : "trainee";

    if (email) {
      const emailCol = finalRole === "trainee" ? "students" : "supervisors";
      const existing = await db.query(`SELECT id FROM ${emailCol} WHERE email = ?`, [email]);
      if (existing.rows.length) return res.status(409).json({ error: "That email is already in use" });
    }

    let memberCode;
    if (manualCode && String(manualCode).trim()) {
      memberCode = String(manualCode).trim().toUpperCase();
      const taken = await db.query("SELECT id FROM user_credentials WHERE member_code = ?", [memberCode]);
      if (taken.rows.length) return res.status(409).json({ error: `ID "${memberCode}" is already in use` });
    } else {
      const prefix = finalRole === "trainee" ? "TTR" : "SUP";
      memberCode = await generateNextId(db, prefix);
    }

    const plainTempPassword =
      tempPassword && String(tempPassword).length >= 8 ? tempPassword : generateTempPassword();
    const passwordHash = await hashPassword(plainTempPassword);

    const credInsert = await db.query(
      `INSERT INTO user_credentials (member_code, password_hash, role, must_change_password)
       VALUES (?, ?, ?, TRUE)`,
      [memberCode, passwordHash, finalRole]
    );
    const newId = credInsert.insertId;

    if (finalRole === "trainee") {
      const cohortId = await resolveCohortId(db, cohort);
      await db.query(
        `INSERT INTO students (id, full_name, email, cohort_id, current_year)
         VALUES (?, ?, ?, ?, ?)`,
        [newId, full_name.trim(), email || null, cohortId, currentYear || null]
      );
    } else {
      await db.query(`INSERT INTO supervisors (id, full_name, email) VALUES (?, ?, ?)`, [
        newId,
        full_name.trim(),
        email || null,
      ]);
    }

    // Every account gets baseline settings/privacy rows so those pages
    // never have to special-case "row doesn't exist yet."
    await db.query("INSERT INTO settings (user_id) VALUES (?)", [newId]);
    await db.query("INSERT INTO privacy_preferences (user_id) VALUES (?)", [newId]);
    if (finalRole === "trainee") {
      await db.query("INSERT INTO payments (student_id, total_fee_cents) VALUES (?, 0)", [newId]);
    }

    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES (?, 'account_created', 'user_credentials', ?)",
      [req.user.id, newId]
    );

    const { rows } = await db.query(`${USER_SELECT} WHERE uc.id = ?`, [newId]);

    // The temp password is only ever returned here, once, at creation
    // time. It is not retrievable later -- use POST /users/:id/reset-password.
    res.status(201).json({
      user: toPublicUser(rows[0]),
      memberCode,
      tempPassword: plainTempPassword,
    });
  })
);

// GET /api/admin/users?search=&role=&status=&page=&pageSize=
router.get(
  "/users",
  asyncRoute(async (req, res, db) => {
    const { search = "", role, status, page = 1, pageSize = 25 } = req.query;

    const clauses = ["uc.role != 'admin'"]; // this list is Trainees + Supervisors only
    const params = [];

    if (search) {
      params.push(`%${search}%`, `%${search}%`);
      clauses.push(`(COALESCE(sup.full_name, st.full_name) LIKE ? OR uc.member_code LIKE ?)`);
    }
    if (role && ["trainee", "supervisor"].includes(role)) {
      params.push(role);
      clauses.push(`uc.role = ?`);
    }
    if (status && ["active", "suspended"].includes(status)) {
      params.push(status);
      clauses.push(`uc.status = ?`);
    }

    const where = `WHERE ${clauses.join(" AND ")}`;
    const limit = Math.min(Number(pageSize) || 25, 100);
    const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;

    const { rows } = await db.query(
      `${USER_SELECT} ${where} ORDER BY uc.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) AS total FROM user_credentials uc
       LEFT JOIN supervisors sup ON sup.id = uc.id
       LEFT JOIN students st ON st.id = uc.id
       ${where}`,
      params
    );

    res.json({
      users: rows.map(toPublicUser),
      total: Number(countRows[0].total),
      page: Number(page),
      pageSize: limit,
    });
  })
);

// GET /api/admin/users/:id
router.get(
  "/users/:id",
  asyncRoute(async (req, res, db) => {
    const id = parseIdParam(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid account id" });

    const { rows } = await db.query(`${USER_SELECT} WHERE uc.id = ?`, [id]);
    if (!rows.length) return res.status(404).json({ error: "Account not found" });
    res.json(toProfileResponse(rows[0]));
  })
);

// PUT /api/admin/users/:id — admin-managed fields (cohort, year, status, supervisor assignments)
router.put(
  "/users/:id",
  asyncRoute(async (req, res, db) => {
    const id = parseIdParam(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid account id" });

    const { rows: existingRows } = await db.query(
      "SELECT id, role, status FROM user_credentials WHERE id = ?",
      [id]
    );
    const existing = existingRows[0];
    if (!existing) return res.status(404).json({ error: "Account not found" });

    const { cohort, currentYear, status, supervisorIds, fullName, email, phone } = req.body || {};
    const allowedStatus = ["active", "suspended"];

    if (status !== undefined && !allowedStatus.includes(status)) {
      return res.status(400).json({ error: "Status must be 'active' or 'suspended'" });
    }
    if (status !== undefined) {
      await db.query("UPDATE user_credentials SET status = ?, updated_at = NOW() WHERE id = ?", [status, id]);
    }

    const profileTable = existing.role === "trainee" ? "students" : "supervisors";
    const profileUpdates = [];
    const profileParams = [];
    if (fullName !== undefined) {
      profileParams.push(fullName);
      profileUpdates.push(`full_name = ?`);
    }
    if (email !== undefined) {
      profileParams.push(email || null);
      profileUpdates.push(`email = ?`);
    }
    if (phone !== undefined) {
      profileParams.push(phone || null);
      profileUpdates.push(`phone = ?`);
    }
    if (existing.role === "trainee" && currentYear !== undefined) {
      profileParams.push(currentYear || null);
      profileUpdates.push(`current_year = ?`);
    }
    if (existing.role === "trainee" && cohort !== undefined) {
      const cohortId = await resolveCohortId(db, cohort);
      profileParams.push(cohortId);
      profileUpdates.push(`cohort_id = ?`);
    }
    if (profileUpdates.length) {
      profileParams.push(id);
      await db.query(
        `UPDATE ${profileTable} SET ${profileUpdates.join(", ")}, updated_at = NOW() WHERE id = ?`,
        profileParams
      );
    }

    if (existing.role === "trainee" && Array.isArray(supervisorIds)) {
      await db.query("DELETE FROM supervisor_students WHERE student_id = ?", [id]);
      for (const supId of supervisorIds) {
        await db.query(
          `INSERT INTO supervisor_students (supervisor_id, student_id, assigned_by) VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE assigned_at = assigned_at`,
          [supId, id, req.user.id]
        );
      }
    }

    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES (?, 'account_updated', 'user_credentials', ?)",
      [req.user.id, id]
    );

    const { rows } = await db.query(`${USER_SELECT} WHERE uc.id = ?`, [id]);
    res.json(toProfileResponse(rows[0]));
  })
);

// PATCH /api/admin/users/:id/status  { status }
router.patch(
  "/users/:id/status",
  asyncRoute(async (req, res, db) => {
    const id = parseIdParam(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid account id" });

    const { status } = req.body || {};
    if (!["active", "suspended"].includes(status)) {
      return res.status(400).json({ error: "Status must be 'active' or 'suspended'" });
    }

    const { affectedRows } = await db.query(
      "UPDATE user_credentials SET status = ?, updated_at = NOW() WHERE id = ?",
      [status, id]
    );
    if (!affectedRows) return res.status(404).json({ error: "Account not found" });

    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES (?, ?, 'user_credentials', ?)",
      [req.user.id, status === "suspended" ? "account_suspended" : "account_activated", id]
    );

    res.json({ success: true, status });
  })
);

// POST /api/admin/users/:id/reset-password
router.post(
  "/users/:id/reset-password",
  asyncRoute(async (req, res, db) => {
    const id = parseIdParam(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid account id" });

    const { rows } = await db.query("SELECT member_code FROM user_credentials WHERE id = ?", [id]);
    if (!rows.length) return res.status(404).json({ error: "Account not found" });

    const tempPassword = generateTempPassword();
    const passwordHash = await hashPassword(tempPassword);

    await db.query(
      "UPDATE user_credentials SET password_hash = ?, must_change_password = TRUE, updated_at = NOW() WHERE id = ?",
      [passwordHash, id]
    );
    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES (?, 'password_reset_by_admin', 'user_credentials', ?)",
      [req.user.id, id]
    );

    res.json({ success: true, memberCode: rows[0].member_code, tempPassword });
  })
);

// DELETE /api/admin/users/:id
// Attempts a REAL delete (not a cosmetic status flip). The schema blocks
// this with a foreign key violation (MySQL error 1451,
// ER_ROW_IS_REFERENCED_2) if the account has any history that must be
// preserved permanently -- sessions, hours, payments recorded, etc. When
// that happens, this returns a clear 409 telling the admin to suspend
// instead. An account with zero history (e.g. created by mistake) deletes
// cleanly. This was reproduced and verified live while validating the
// MySQL schema.
router.delete(
  "/users/:id",
  asyncRoute(async (req, res, db) => {
    const id = parseIdParam(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid account id" });
    const force = req.query.force === "true";

    const { rows } = await db.query("SELECT id, role FROM user_credentials WHERE id = ?", [id]);
    if (!rows.length) return res.status(404).json({ error: "Account not found" });
    const targetRole = rows[0].role;

    // Payment transactions are a financial audit trail and are never
    // force-deletable, for anyone, regardless of role -- this is a hard
    // boundary, not a preference.
    const { rows: paymentRows } = await db.query(
      "SELECT 1 FROM payment_transactions WHERE added_by = ? LIMIT 1",
      [id]
    );
    if (paymentRows.length) {
      return res.status(409).json({
        error: "This account has recorded payment transactions and can never be permanently deleted -- this protects financial audit history. Suspend the account instead.",
      });
    }

    if (force && targetRole !== "trainee") {
      // A supervisor's (or admin's) authored records -- attendance they
      // logged, documents they uploaded, sessions they ran -- belong to
      // OTHER people's compliance history, not just this account. Force-
      // deleting them would silently destroy other trainees' real
      // training records, which is exactly the data-loss bug this
      // schema's RESTRICT constraints exist to prevent. Force delete is
      // therefore only offered for trainees, whose own history is
      // self-contained to their own account.
      return res.status(409).json({
        error: "Force delete isn't available for supervisor or admin accounts with recorded history -- their records belong to other trainees' training history too. Suspend the account instead.",
      });
    }

    if (force && targetRole === "trainee") {
      // Trainees can send chat messages (messages.sender_id has no
      // cascade), which is the one realistic blocker for a trainee
      // account. Everything else about a trainee (sessions, attendance,
      // hours, assignments, documents, payments, evaluations, notes) is
      // already ON DELETE CASCADE via student_id and will be removed
      // automatically by the DELETE below.
      await db.query("DELETE FROM messages WHERE sender_id = ?", [id]);
    }

    try {
      await db.query("DELETE FROM user_credentials WHERE id = ?", [id]);
    } catch (err) {
      if (err.code === "ER_ROW_IS_REFERENCED_2" || err.errno === 1451) {
        return res.status(409).json({
          error: force
            ? "This account still has protected history that can't be force-deleted. Suspend it instead."
            : "This account has recorded history (sessions, hours, payments, or messages) and can't be deleted. Suspend it instead, or use permanent delete if you specifically need to erase this trainee's data.",
        });
      }
      throw err;
    }

    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, new_values) VALUES (?, ?, 'user_credentials', ?, ?)",
      [
        req.user.id,
        force ? "account_permanently_deleted" : "account_deleted",
        id,
        JSON.stringify({ force, targetRole }),
      ]
    );

    res.json({ success: true, permanent: force });
  })
);

// NOTE: an earlier version had GET/PUT /admin/me here for the admin's own
// profile. Removed -- it duplicated routes/profile.js's generic GET/PUT
// /profile/me, which already works for any role (admin included) and is
// what the Admin/Supervisor/Trainee dashboards all already call. Two
// endpoints doing the same thing is a maintenance trap waiting to diverge.

// ---- Groups (Admin's only account-creation action) ----------------------
// A Group is 1 Master Trainer (supervisors.supervisor_type = 'primary') +
// 2 Trainers/ToT (supervisor_type = 'in_training', primary_supervisor_id
// pointing at the Master Trainer) + N Trainees, all created together and
// tied to one trainer_groups row. See database/reframe_mhs_schema.sql's
// design notes on `supervisors` and `trainer_groups` for the full
// hierarchy rationale, including why the table isn't named `groups`
// (reserved word in MySQL 8).

// MySQL's TINYINT(1) columns (our BOOLEANs) come back as real JS booleans
// at the top level thanks to db.js's typeCast hook -- but that hook only
// sees raw wire-protocol field values, not values already serialized
// *inside* a JSON_OBJECT()/JSON_ARRAYAGG() blob. Left alone,
// must_change_password would come back as the JSON number 0/1 wherever
// it's nested in one of these Group queries. This IF/CAST wraps it as a
// real JSON true/false at the point the object is built instead.
const MUST_CHANGE_PW_JSON = "IF(cred.must_change_password, CAST('true' AS JSON), CAST('false' AS JSON))";

/** Builds the ordered-derived-table JSON_ARRAYAGG snippet for a set of group members. */
function memberListSql(fromTable, extraFields) {
  return `
    COALESCE((
      SELECT JSON_ARRAYAGG(obj) FROM (
        SELECT JSON_OBJECT(
          'id', member.id, 'full_name', member.full_name, 'member_code', cred.member_code,
          'status', cred.status, 'must_change_password', ${MUST_CHANGE_PW_JSON}
          ${extraFields ? `, ${extraFields}` : ""}
        ) AS obj
        FROM ${fromTable} member JOIN user_credentials cred ON cred.id = member.id
        WHERE member.group_id = g.id ${fromTable === "supervisors" ? "AND member.supervisor_type = ?" : ""}
        ORDER BY member.full_name
      ) t
    ), JSON_ARRAY())
  `;
}

// GET /api/admin/groups
router.get(
  "/groups",
  asyncRoute(async (req, res, db) => {
    const supervisorExtraFields =
      "'email', member.email, 'phone', member.phone, 'specialization', member.specialization, 'bio', member.bio";

    const { rows } = await db.query(
      `
      SELECT
        g.id, g.name, g.created_at,
        (
          SELECT JSON_OBJECT(
            'id', member.id, 'full_name', member.full_name, 'member_code', cred.member_code,
            'status', cred.status, 'must_change_password', ${MUST_CHANGE_PW_JSON},
            'email', member.email, 'phone', member.phone,
            'specialization', member.specialization, 'bio', member.bio
          )
          FROM supervisors member JOIN user_credentials cred ON cred.id = member.id
          WHERE member.group_id = g.id AND member.supervisor_type = 'primary'
          LIMIT 1
        ) AS master_trainer,
        ${memberListSql("supervisors", supervisorExtraFields)} AS trainers,
        ${memberListSql("students", null)} AS trainees
      FROM trainer_groups g
      ORDER BY g.created_at DESC
      `,
      ["in_training"]
    );

    res.json({
      groups: rows.map((g) => ({
        id: g.id,
        name: g.name,
        createdAt: g.created_at,
        masterTrainer: g.master_trainer,
        trainers: g.trainers,
        trainees: g.trainees,
      })),
    });
  })
);

// POST /api/admin/groups
// { name, masterTrainer: {fullName, memberCode?}, trainers: [{fullName, memberCode?} x2],
//   trainees: [{fullName, memberCode?}, ...], trainerPassword?, traineePassword? }
router.post(
  "/groups",
  asyncRoute(async (req, res, db) => {
    const body = req.body || {};
    const name = String(body.name || "").trim();
    const masterTrainerIn = body.masterTrainer || {};
    const trainersIn = Array.isArray(body.trainers) ? body.trainers : [];
    const traineesIn = Array.isArray(body.trainees) ? body.trainees : [];

    if (!name) return res.status(400).json({ error: "Group name is required" });
    if (!masterTrainerIn.fullName || !String(masterTrainerIn.fullName).trim()) {
      return res.status(400).json({ error: "Master Trainer full name is required" });
    }
    if (trainersIn.length !== 2 || trainersIn.some((t) => !t?.fullName || !String(t.fullName).trim())) {
      return res.status(400).json({ error: "Both Trainer (ToT) full names are required" });
    }
    if (!traineesIn.length || traineesIn.some((t) => !t?.fullName || !String(t.fullName).trim())) {
      return res.status(400).json({ error: "At least one trainee full name is required" });
    }

    const { rows: nameRows } = await db.query("SELECT id FROM trainer_groups WHERE name = ?", [name]);
    if (nameRows.length) return res.status(409).json({ error: `A group named "${name}" already exists` });

    // Resolve every member code up front (before creating anyone) so a
    // conflict on, say, the second trainee doesn't leave the master
    // trainer/trainers already created -- asyncRoute rolls back the whole
    // transaction on any thrown error, but an early `return` here commits
    // whatever ran so far, so nothing gets inserted until all codes check out.
    async function resolveCode(manualCode, prefix) {
      if (manualCode && String(manualCode).trim()) {
        const code = String(manualCode).trim().toUpperCase();
        const { rows } = await db.query("SELECT id FROM user_credentials WHERE member_code = ?", [code]);
        if (rows.length) return { conflict: `ID "${code}" is already in use` };
        return { code };
      }
      return { code: await generateNextId(db, prefix) };
    }

    const masterCode = await resolveCode(masterTrainerIn.memberCode, "SUP");
    if (masterCode.conflict) return res.status(409).json({ error: masterCode.conflict });

    const trainerCodes = [];
    for (const t of trainersIn) {
      const resolved = await resolveCode(t.memberCode, "SUP");
      if (resolved.conflict) return res.status(409).json({ error: resolved.conflict });
      trainerCodes.push(resolved.code);
    }

    const traineeCodes = [];
    for (const t of traineesIn) {
      const resolved = await resolveCode(t.memberCode, "TTR");
      if (resolved.conflict) return res.status(409).json({ error: resolved.conflict });
      traineeCodes.push(resolved.code);
    }

    const trainerPlainPassword =
      body.trainerPassword && String(body.trainerPassword).length >= 8
        ? String(body.trainerPassword)
        : generateTempPassword();
    const traineePlainPassword =
      body.traineePassword && String(body.traineePassword).length >= 8
        ? String(body.traineePassword)
        : generateTempPassword();
    const trainerHash = await hashPassword(trainerPlainPassword);
    const traineeHash = await hashPassword(traineePlainPassword);

    const groupInsert = await db.query("INSERT INTO trainer_groups (name) VALUES (?)", [name]);
    const group = { id: groupInsert.insertId, name };

    async function insertSupervisor(fullName, memberCode, supervisorType, primarySupervisorId) {
      const cred = await db.query(
        `INSERT INTO user_credentials (member_code, password_hash, role, must_change_password)
         VALUES (?, ?, 'supervisor', TRUE)`,
        [memberCode, trainerHash]
      );
      const id = cred.insertId;
      await db.query(
        `INSERT INTO supervisors (id, full_name, supervisor_type, primary_supervisor_id, group_id)
         VALUES (?, ?, ?, ?, ?)`,
        [id, fullName.trim(), supervisorType, primarySupervisorId, group.id]
      );
      await db.query("INSERT INTO settings (user_id) VALUES (?)", [id]);
      await db.query("INSERT INTO privacy_preferences (user_id) VALUES (?)", [id]);
      return { id, fullName: fullName.trim(), memberCode };
    }

    const masterTrainer = await insertSupervisor(masterTrainerIn.fullName, masterCode.code, "primary", null);

    const trainers = [];
    for (let i = 0; i < trainersIn.length; i++) {
      trainers.push(
        await insertSupervisor(trainersIn[i].fullName, trainerCodes[i], "in_training", masterTrainer.id)
      );
    }

    const trainerRoleIds = [masterTrainer.id, ...trainers.map((t) => t.id)];
    const trainees = [];
    for (let i = 0; i < traineesIn.length; i++) {
      const memberCode = traineeCodes[i];
      const cred = await db.query(
        `INSERT INTO user_credentials (member_code, password_hash, role, must_change_password)
         VALUES (?, ?, 'trainee', TRUE)`,
        [memberCode, traineeHash]
      );
      const id = cred.insertId;
      await db.query(`INSERT INTO students (id, full_name, group_id) VALUES (?, ?, ?)`, [
        id,
        traineesIn[i].fullName.trim(),
        group.id,
      ]);
      await db.query("INSERT INTO settings (user_id) VALUES (?)", [id]);
      await db.query("INSERT INTO privacy_preferences (user_id) VALUES (?)", [id]);
      await db.query("INSERT INTO payments (student_id, total_fee_cents) VALUES (?, 0)", [id]);

      // Assign this trainee to all three trainer-role accounts in the
      // group (Master Trainer + both Trainers/ToT) so messaging,
      // materials, and assignments work from all three, not just one.
      for (const trainerId of trainerRoleIds) {
        await db.query(
          `INSERT INTO supervisor_students (supervisor_id, student_id, assigned_by) VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE assigned_at = assigned_at`,
          [trainerId, id, req.user.id]
        );
      }

      trainees.push({ id, fullName: traineesIn[i].fullName.trim(), memberCode });
    }

    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES (?, 'group_created', 'trainer_groups', ?)",
      [req.user.id, group.id]
    );

    res.status(201).json({
      group: { id: group.id, name: group.name },
      masterTrainer,
      trainers,
      trainerPassword: trainerPlainPassword,
      trainees,
      traineePassword: traineePlainPassword,
    });
  })
);

// ---- Trainee Profiles (full detail view, admin-only) ---------------------
// Unlike routes/supervisor.js's GET /students/:id, this has NO
// supervisor_students assignment check -- Admin can view ANY trainee's
// complete profile, not just ones they're personally assigned to.

// GET /api/admin/students/:id/profile
router.get(
  "/students/:id/profile",
  asyncRoute(async (req, res, db) => {
    const id = parseIdParam(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid student id" });

    const { rows: userRows } = await db.query(`${USER_SELECT} WHERE uc.id = ? AND uc.role = 'trainee'`, [id]);
    if (!userRows.length) return res.status(404).json({ error: "Trainee not found" });
    const profile = toProfileResponse(userRows[0]);

    const rq = buildRecordsQuery(id, null);
    const { rows: recordRows } = await db.query(rq.sql, rq.params);
    const supIds = [...new Set(recordRows.map((r) => r.supervisor_id).filter((x) => x != null))];
    let supNames = {};
    if (supIds.length) {
      const placeholders = supIds.map(() => "?").join(",");
      const { rows: supRows } = await db.query(
        `SELECT id, full_name FROM supervisors WHERE id IN (${placeholders})`,
        supIds
      );
      supRows.forEach((r) => (supNames[r.id] = r.full_name));
    }
    const records = recordRows.map((r) => toRecord({ ...r, supervisor_name: supNames[r.supervisor_id] }));

    const { rows: documentRows } = await db.query(
      `SELECT d.*, COALESCE(a.full_name, sup.full_name) AS uploaded_by_name FROM documents d
       LEFT JOIN admin_users a ON a.id = d.uploaded_by
       LEFT JOIN supervisors sup ON sup.id = d.uploaded_by
       WHERE d.student_id = ? ORDER BY d.created_at DESC`,
      [id]
    );
    const documents = documentRows.map(toDocument);

    const progress = await computeProgressSummary(db, id);

    const paymentsRow = await getPaymentsRow(db, id);
    const transactions = await getTransactions(db, id);
    const payment = toPaymentSummary(
      { id, full_name: profile.full_name, member_code: profile.memberCode },
      paymentsRow,
      transactions
    );

    const { masterTrainer, totTrainers, trainingHours } = await getTrainersAndHours(db, id, profile.full_name);

    res.json({
      profile,
      records,
      documents,
      progress,
      payment,
      paymentTransactions: transactions.map(toPaymentTransaction),
      masterTrainer,
      totTrainers,
      trainingHours,
    });
  })
);

// Looks up this trainee's assigned Master Trainer + Trainer(s)/ToT (via
// supervisor_students, the caseload assignment table -- see its schema
// comment) along with the supervision hours each of them has logged for
// this specific trainee, plus the trainee's own logged training hours.
// Reuses training_hours/supervision_hours as-is; no new tables.
async function getTrainersAndHours(db, studentId, studentFullName) {
  const { rows: supervisorRows } = await db.query(
    `SELECT sup.id, sup.full_name, sup.email, sup.phone, sup.specialization, sup.bio,
            sup.supervisor_type, uc.member_code, uc.status
     FROM supervisor_students ss
     JOIN supervisors sup ON sup.id = ss.supervisor_id
     JOIN user_credentials uc ON uc.id = sup.id
     WHERE ss.student_id = ?
     ORDER BY sup.supervisor_type, sup.full_name`,
    [studentId]
  );

  const { rows: hoursRows } = await db.query(
    `SELECT supervisor_id, COALESCE(SUM(hours), 0) AS hours
     FROM supervision_hours WHERE student_id = ? GROUP BY supervisor_id`,
    [studentId]
  );
  const hoursBySupervisor = {};
  hoursRows.forEach((r) => (hoursBySupervisor[r.supervisor_id] = Number(r.hours)));

  const { rows: traineeHoursRows } = await db.query(
    "SELECT COALESCE(SUM(hours), 0) AS hours FROM training_hours WHERE student_id = ?",
    [studentId]
  );
  const traineeHours = Number(traineeHoursRows[0].hours);

  function toTrainerInfo(row) {
    return {
      id: row.id,
      fullName: row.full_name,
      memberCode: row.member_code,
      status: row.status,
      email: row.email,
      phone: row.phone,
      specialization: row.specialization,
      bio: row.bio,
      hours: hoursBySupervisor[row.id] || 0,
    };
  }

  const masterTrainerRow = supervisorRows.find((s) => s.supervisor_type === "primary");
  const totTrainerRows = supervisorRows.filter((s) => s.supervisor_type === "in_training");

  const masterTrainer = masterTrainerRow ? toTrainerInfo(masterTrainerRow) : null;
  const totTrainers = totTrainerRows.map(toTrainerInfo);

  return {
    masterTrainer,
    totTrainers,
    trainingHours: {
      trainee: { fullName: studentFullName, hours: traineeHours },
      masterTrainer: masterTrainer ? { fullName: masterTrainer.fullName, hours: masterTrainer.hours } : null,
      totTrainers: totTrainers.map((t) => ({ fullName: t.fullName, hours: t.hours })),
    },
  };
}

// DELETE /api/admin/documents/:id
// Removes a trainee document -- both the DB row AND the file on disk.
// Works for any trainee's document, no assignment restriction (Admin-wide).
router.delete(
  "/documents/:id",
  asyncRoute(async (req, res, db) => {
    const id = parseIdParam(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid document id" });

    const { rows } = await db.query("SELECT filename FROM documents WHERE id = ?", [id]);
    if (!rows.length) return res.status(404).json({ error: "Document not found" });

    await db.query("DELETE FROM documents WHERE id = ?", [id]);

    const filePath = path.join(__dirname, "../../uploads/documents", rows[0].filename);
    fs.unlink(filePath, (err) => {
      // A missing file on disk shouldn't fail the request -- the DB row
      // (the source of truth for "does this document exist") is already
      // gone; log and move on rather than leaving an orphaned DB state.
      if (err && err.code !== "ENOENT") console.error("Failed to delete document file:", err);
    });

    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES (?, 'document_deleted', 'documents', ?)",
      [req.user.id, id]
    );

    res.json({ success: true });
  })
);

// ---- Events (public site management) -----------------------------------

router.post("/events/upload-image", (req, res) => {
  eventImageUpload.single("image")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    res.status(201).json({ url: `/uploads/events/${req.file.filename}` });
  });
});

router.get(
  "/events",
  asyncRoute(async (req, res, db) => {
    const { rows } = await db.query("SELECT * FROM events ORDER BY event_date DESC");
    res.json({ events: rows.map(toPublicEvent) });
  })
);

// GET /events/:id -- single event, ANY designer's, full child data
// regardless of show_* toggle state (see toEventDetail). No ownership
// check, matching every other admin event route.
router.get(
  "/events/:id",
  asyncRoute(async (req, res, db) => {
    const id = parseIdParam(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid event id" });

    const { rows } = await db.query("SELECT * FROM events WHERE id = ?", [id]);
    const event = rows[0];
    if (!event) return res.status(404).json({ error: "Event not found" });

    const children = await fetchEventChildren(db, id);
    res.json(toEventDetail(event, children));
  })
);

router.post(
  "/events",
  asyncRoute(async (req, res, db) => {
    const b = req.body || {};
    if (!b.date) return res.status(400).json({ error: "date is required" });

    const slug = b.slug || (await generateUniqueSlug(db, b.englishTitle, b.arabicTitle));

    const insert = await db.query(
      `INSERT INTO events (
        created_by, event_date, image, status, fee, register_url, slug,
        show_speakers, show_agenda, show_sponsors, show_gallery, show_registration,
        title_en, format_en, facilitator_en, about_en, learn_en, who_en, outcomes_en, facilitator_bio_en,
        title_ar, format_ar, facilitator_ar, about_ar, learn_ar, who_ar, outcomes_ar, facilitator_bio_ar
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        req.user.id,
        b.date,
        b.image || null,
        ["upcoming", "concluded"].includes(b.status) ? b.status : "upcoming",
        b.fee || null,
        b.register || null,
        slug,
        !!b.showSpeakers,
        !!b.showAgenda,
        !!b.showSponsors,
        !!b.showGallery,
        b.showRegistration === undefined ? true : !!b.showRegistration,
        b.englishTitle || null,
        b.englishFormat || null,
        b.englishFacilitator || null,
        b.englishAbout || null,
        JSON.stringify(toArray(b.englishLearn)),
        JSON.stringify(toArray(b.englishWho)),
        JSON.stringify(toArray(b.englishOutcomes)),
        b.englishFacilitatorBio || null,
        b.arabicTitle || null,
        b.arabicFormat || null,
        b.arabicFacilitator || null,
        b.arabicAbout || null,
        JSON.stringify(toArray(b.arabicLearn)),
        JSON.stringify(toArray(b.arabicWho)),
        JSON.stringify(toArray(b.arabicOutcomes)),
        b.arabicFacilitatorBio || null,
      ]
    );

    await writeEventChildren(db, insert.insertId, b);

    const { rows } = await db.query("SELECT * FROM events WHERE id = ?", [insert.insertId]);
    const children = await fetchEventChildren(db, insert.insertId);
    res.status(201).json(toEventDetail(rows[0], children));
  })
);

router.put(
  "/events/:id",
  asyncRoute(async (req, res, db) => {
    const id = parseIdParam(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid event id" });

    const { rows: existingRows } = await db.query("SELECT * FROM events WHERE id = ?", [id]);
    const existing = existingRows[0];
    if (!existing) return res.status(404).json({ error: "Event not found" });

    const b = req.body || {};
    await db.query(
      `UPDATE events SET
        event_date = ?, image = ?, status = ?, fee = ?, register_url = ?, slug = ?,
        show_speakers = ?, show_agenda = ?, show_sponsors = ?, show_gallery = ?, show_registration = ?,
        title_en = ?, format_en = ?, facilitator_en = ?, about_en = ?,
        learn_en = ?, who_en = ?, outcomes_en = ?, facilitator_bio_en = ?,
        title_ar = ?, format_ar = ?, facilitator_ar = ?, about_ar = ?,
        learn_ar = ?, who_ar = ?, outcomes_ar = ?, facilitator_bio_ar = ?,
        updated_at = NOW()
       WHERE id = ?`,
      [
        b.date ?? existing.event_date,
        b.image ?? existing.image,
        ["upcoming", "concluded"].includes(b.status) ? b.status : existing.status,
        b.fee ?? existing.fee,
        b.register ?? existing.register_url,
        b.slug ?? existing.slug,
        b.showSpeakers ?? existing.show_speakers,
        b.showAgenda ?? existing.show_agenda,
        b.showSponsors ?? existing.show_sponsors,
        b.showGallery ?? existing.show_gallery,
        b.showRegistration ?? existing.show_registration,
        b.englishTitle ?? existing.title_en,
        b.englishFormat ?? existing.format_en,
        b.englishFacilitator ?? existing.facilitator_en,
        b.englishAbout ?? existing.about_en,
        b.englishLearn !== undefined ? JSON.stringify(toArray(b.englishLearn)) : JSON.stringify(existing.learn_en),
        b.englishWho !== undefined ? JSON.stringify(toArray(b.englishWho)) : JSON.stringify(existing.who_en),
        b.englishOutcomes !== undefined
          ? JSON.stringify(toArray(b.englishOutcomes))
          : JSON.stringify(existing.outcomes_en),
        b.englishFacilitatorBio ?? existing.facilitator_bio_en,
        b.arabicTitle ?? existing.title_ar,
        b.arabicFormat ?? existing.format_ar,
        b.arabicFacilitator ?? existing.facilitator_ar,
        b.arabicAbout ?? existing.about_ar,
        b.arabicLearn !== undefined ? JSON.stringify(toArray(b.arabicLearn)) : JSON.stringify(existing.learn_ar),
        b.arabicWho !== undefined ? JSON.stringify(toArray(b.arabicWho)) : JSON.stringify(existing.who_ar),
        b.arabicOutcomes !== undefined
          ? JSON.stringify(toArray(b.arabicOutcomes))
          : JSON.stringify(existing.outcomes_ar),
        b.arabicFacilitatorBio ?? existing.facilitator_bio_ar,
        id,
      ]
    );

    await writeEventChildren(db, id, b);

    const { rows } = await db.query("SELECT * FROM events WHERE id = ?", [id]);
    const children = await fetchEventChildren(db, id);
    res.json(toEventDetail(rows[0], children));
  })
);

router.delete(
  "/events/:id",
  asyncRoute(async (req, res, db) => {
    const id = parseIdParam(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid event id" });

    const { affectedRows } = await db.query("DELETE FROM events WHERE id = ?", [id]);
    if (!affectedRows) return res.status(404).json({ error: "Event not found" });
    res.json({ success: true });
  })
);

// ---- Payments (financial ledger, admin-managed) -------------------------
// Authorization for these tables is enforced entirely at the Express
// layer: this whole router requires requireAdmin (see `router.use` above)
// -- there is no Row-Level Security in MySQL to lean on the way the
// previous Postgres schema's (defense-in-depth, not the actual
// enforcement point) RLS policies did.

async function getPaymentsRow(db, studentId) {
  const { rows } = await db.query("SELECT * FROM payments WHERE student_id = ?", [studentId]);
  return rows[0] || null;
}
async function getTransactions(db, studentId) {
  const { rows } = await db.query(
    `SELECT pt.*, uc.member_code AS added_by_code, COALESCE(a.full_name, sup.full_name) AS added_by_name
     FROM payment_transactions pt
     JOIN user_credentials uc ON uc.id = pt.added_by
     LEFT JOIN admin_users a ON a.id = pt.added_by
     LEFT JOIN supervisors sup ON sup.id = pt.added_by
     WHERE pt.student_id = ?
     ORDER BY pt.payment_date DESC, pt.created_at DESC`,
    [studentId]
  );
  return rows;
}
/** Keeps the stored payments.status column in sync with the live ledger total, for any other query that filters/sorts by it directly. */
async function recomputeStoredStatus(db, studentId) {
  const paymentsRow = await getPaymentsRow(db, studentId);
  const transactions = await getTransactions(db, studentId);
  const paidCents = transactions.reduce((sum, t) => sum + t.amount_cents, 0);
  const netFeeCents = Math.max((paymentsRow?.total_fee_cents || 0) - (paymentsRow?.discount_cents || 0), 0);
  const remaining = netFeeCents - paidCents;
  const status = paidCents > 0 && remaining <= 0 ? "paid" : paidCents > 0 ? "partial" : "unpaid";
  await db.query("UPDATE payments SET status = ?, updated_at = NOW() WHERE student_id = ?", [status, studentId]);
  return { paymentsRow: { ...paymentsRow, status }, transactions };
}

// GET /api/admin/payments?search=
router.get(
  "/payments",
  asyncRoute(async (req, res, db) => {
    const { search = "" } = req.query;
    const params = [];
    let where = "";
    if (search) {
      params.push(`%${search}%`, `%${search}%`);
      where = `WHERE st.full_name LIKE ? OR uc.member_code LIKE ?`;
    }

    const { rows: studentRows } = await db.query(
      `SELECT uc.id, uc.member_code, st.full_name
       FROM user_credentials uc JOIN students st ON st.id = uc.id
       ${where} ORDER BY st.full_name`,
      params
    );

    const summaries = [];
    for (const s of studentRows) {
      const paymentsRow = await getPaymentsRow(db, s.id);
      const transactions = await getTransactions(db, s.id);
      summaries.push(
        toPaymentSummary({ id: s.id, full_name: s.full_name, member_code: s.member_code }, paymentsRow, transactions)
      );
    }

    res.json({ payments: summaries });
  })
);

// GET /api/admin/payments/:studentId
router.get(
  "/payments/:studentId",
  asyncRoute(async (req, res, db) => {
    const studentId = parseIdParam(req.params.studentId);
    if (!studentId) return res.status(400).json({ error: "Invalid student id" });

    const { rows } = await db.query(
      "SELECT uc.id, uc.member_code, st.full_name FROM user_credentials uc JOIN students st ON st.id = uc.id WHERE uc.id = ?",
      [studentId]
    );
    if (!rows.length) return res.status(404).json({ error: "Trainee not found" });

    const paymentsRow = await getPaymentsRow(db, studentId);
    const transactions = await getTransactions(db, studentId);

    res.json({
      summary: toPaymentSummary({ id: rows[0].id, full_name: rows[0].full_name, member_code: rows[0].member_code }, paymentsRow, transactions),
      transactions: transactions.map(toPaymentTransaction),
    });
  })
);

// PUT /api/admin/payments/:studentId/total-fee  { totalFee, discount?, paymentPlan?, nextDueDate? }
router.put(
  "/payments/:studentId/total-fee",
  asyncRoute(async (req, res, db) => {
    const studentId = parseIdParam(req.params.studentId);
    if (!studentId) return res.status(400).json({ error: "Invalid student id" });

    const { rows: studentRows } = await db.query("SELECT id FROM students WHERE id = ?", [studentId]);
    if (!studentRows.length) return res.status(404).json({ error: "Trainee not found" });

    const totalFee = Number(req.body?.totalFee);
    if (!Number.isFinite(totalFee) || totalFee < 0) {
      return res.status(400).json({ error: "totalFee must be a non-negative number" });
    }
    const totalFeeCents = Math.round(totalFee * 100);
    const discountCents = req.body?.discount != null ? Math.round(Number(req.body.discount) * 100) : 0;
    const paymentPlan = ["full", "installment", "custom"].includes(req.body?.paymentPlan)
      ? req.body.paymentPlan
      : null;
    const nextDueDate = req.body?.nextDueDate || null;

    const existing = await getPaymentsRow(db, studentId);
    if (existing) {
      await db.query(
        `UPDATE payments SET total_fee_cents = ?, discount_cents = ?, payment_plan = ?, next_due_date = ?, updated_at = NOW()
         WHERE student_id = ?`,
        [totalFeeCents, discountCents, paymentPlan, nextDueDate, studentId]
      );
    } else {
      await db.query(
        `INSERT INTO payments (student_id, total_fee_cents, discount_cents, payment_plan, next_due_date)
         VALUES (?, ?, ?, ?, ?)`,
        [studentId, totalFeeCents, discountCents, paymentPlan, nextDueDate]
      );
    }

    const { paymentsRow, transactions } = await recomputeStoredStatus(db, studentId);
    const { rows: nameRows } = await db.query(
      "SELECT uc.member_code, st.full_name FROM user_credentials uc JOIN students st ON st.id = uc.id WHERE uc.id = ?",
      [studentId]
    );

    res.json({
      summary: toPaymentSummary(
        { id: studentId, full_name: nameRows[0].full_name, member_code: nameRows[0].member_code },
        paymentsRow,
        transactions
      ),
      transactions: transactions.map(toPaymentTransaction),
    });
  })
);

// POST /api/admin/payments/:studentId/transactions  { amount, date, method, notes }
router.post(
  "/payments/:studentId/transactions",
  asyncRoute(async (req, res, db) => {
    const studentId = parseIdParam(req.params.studentId);
    if (!studentId) return res.status(400).json({ error: "Invalid student id" });

    const { rows: studentRows } = await db.query("SELECT id FROM students WHERE id = ?", [studentId]);
    if (!studentRows.length) return res.status(404).json({ error: "Trainee not found" });

    const { amount, date, method, notes } = req.body || {};
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount === 0) {
      return res.status(400).json({ error: "amount must be a non-zero number" });
    }
    if (!date) return res.status(400).json({ error: "date is required" });
    const amountCents = Math.round(numericAmount * 100);

    // Duplicate-submission guard (same student/amount/date/method within
    // the last 10 seconds) -- catches accidental double-clicks without
    // blocking legitimate repeat payments made later.
    const { rows: dupeRows } = await db.query(
      `SELECT id FROM payment_transactions
       WHERE student_id = ? AND amount_cents = ? AND payment_date = ? AND COALESCE(method,'') = COALESCE(?,'')
         AND created_at >= NOW() - INTERVAL 10 SECOND`,
      [studentId, amountCents, date, method || null]
    );
    if (dupeRows.length) {
      return res.status(409).json({
        error: "This looks like a duplicate of a payment just submitted. Refresh and check the history before retrying.",
      });
    }

    await db.query(
      `INSERT INTO payment_transactions (student_id, amount_cents, transaction_type, payment_date, method, added_by, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [studentId, amountCents, amountCents < 0 ? "refund" : "payment", date, method || null, req.user.id, notes || null]
    );
    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, new_values) VALUES (?, 'payment_recorded', 'payment_transactions', ?, ?)",
      [req.user.id, studentId, JSON.stringify({ amountCents, date, method })]
    );

    const { paymentsRow, transactions } = await recomputeStoredStatus(db, studentId);
    const { rows: nameRows } = await db.query(
      "SELECT uc.member_code, st.full_name FROM user_credentials uc JOIN students st ON st.id = uc.id WHERE uc.id = ?",
      [studentId]
    );

    res.status(201).json({
      summary: toPaymentSummary(
        { id: studentId, full_name: nameRows[0].full_name, member_code: nameRows[0].member_code },
        paymentsRow,
        transactions
      ),
      transactions: transactions.map(toPaymentTransaction),
    });
  })
);

module.exports = router;
