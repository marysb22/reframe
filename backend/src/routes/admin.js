const express = require("express");
const fs = require("fs");
const path = require("path");
const config = require("../config");
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
const { optimizeImageIfPossible } = require("../utils/imageOptimize");
const { checkFileContent } = require("../utils/fileTypeCheck");
const { fetchEventChildren, writeEventChildren, generateUniqueSlug } = require("../utils/eventChildren");
const { buildRecordsQuery } = require("../utils/recordsQuery");

const router = express.Router();

router.use(requireAuth, requireAdmin);

// Every account-management query joins the three profile tables and their
// cohort, so a single row shape covers both a student and a supervisor
// (the columns that don't apply to that role just come back NULL).
//
// The `supervisors` JSON list is a plain correlated subquery, not a derived
// table -- an earlier version wrapped it as `(SELECT JSON_ARRAYAGG(obj)
// FROM (SELECT ... WHERE ss.student_id = uc.id ORDER BY ...) t)` to get an
// alphabetized array (JSON_ARRAYAGG has no inline ORDER BY), but production
// runs MariaDB, and MariaDB's optimizer loses the outer `uc.id` correlation
// once that inner SELECT gets materialized as a derived table -- it fails
// at runtime with "Unknown column 'uc.id' in 'WHERE'", even though the
// identical query runs fine on real MySQL. Removing the derived table
// fixes that; sorting is done in JS instead (see parseJsonArray below).
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
    sup.group_id AS supervisor_group_id, st.group_id AS student_group_id,
    tg.id AS group_id, tg.name AS group_name,
    COALESCE(
      (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', sup2.id, 'full_name', sup2.full_name, 'supervisor_type', sup2.supervisor_type))
         FROM supervisor_students ss JOIN supervisors sup2 ON sup2.id = ss.supervisor_id
         WHERE ss.student_id = uc.id),
      JSON_ARRAY()
    ) AS supervisors
  FROM user_credentials uc
  LEFT JOIN supervisors sup ON sup.id = uc.id
  LEFT JOIN students st ON st.id = uc.id
  LEFT JOIN cohorts c ON c.id = st.cohort_id
  LEFT JOIN trainer_groups tg ON tg.id = COALESCE(sup.group_id, st.group_id)
`;

// MariaDB's JSON type is really just LONGTEXT with a CHECK constraint, so
// (unlike a real MySQL JSON column) mysql2 doesn't auto-parse a
// JSON_ARRAYAGG()/JSON_OBJECT() result column into a JS value the way it
// does for MySQL -- it can come back as a plain string that still needs
// JSON.parse(). Handles both so the same code works against either engine.
function parseJsonValue(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
function parseJsonArray(value) {
  const arr = parseJsonValue(value, []);
  return Array.isArray(arr) ? arr : [];
}
function sortByFullName(arr) {
  return [...arr].sort((a, b) => String(a.full_name || "").localeCompare(String(b.full_name || "")));
}
// must_change_password is included in these nested JSON blobs as the raw
// 0/1 from cred.must_change_password (see the note where this used to be
// CAST(... AS JSON) further down) -- normalize it to a real boolean here,
// in JS, instead.
function toBool(v) {
  return v === 1 || v === true || v === "1";
}

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

// ---- Shared helpers: Group/Trainer account creation & assignment --------
// Used by POST /groups (whole-group creation), POST /trainers (standalone
// trainer creation), and PATCH /trainers/:id/group (assign/reassign/
// unassign) -- kept in one place so those three flows can never diverge on
// how a trainer account or a trainee<->trainer caseload link gets made.

/** Resolves a manually-supplied member code (checking for a conflict) or generates the next one for `prefix`. */
async function resolveMemberCode(db, manualCode, prefix) {
  if (manualCode && String(manualCode).trim()) {
    const code = String(manualCode).trim().toUpperCase();
    // member_code is VARCHAR(20) -- without this, a longer manual code
    // passes every check here and then fails at INSERT with a raw,
    // unhandled "Data too long for column" error.
    if (code.length > 20) return { conflict: "ID must be 20 characters or fewer" };
    const { rows } = await db.query("SELECT id FROM user_credentials WHERE member_code = ?", [code]);
    if (rows.length) return { conflict: `ID "${code}" is already in use` };
    return { code };
  }
  return { code: await generateNextId(db, prefix) };
}

/** Inserts a user_credentials + supervisors row pair for a Master Trainer or Trainer (ToT). */
async function insertSupervisorAccount(
  db,
  { fullName, memberCode, passwordHash, supervisorType, primarySupervisorId, groupId, email, phone }
) {
  const cred = await db.query(
    `INSERT INTO user_credentials (member_code, password_hash, role, must_change_password)
     VALUES (?, ?, 'supervisor', TRUE)`,
    [memberCode, passwordHash]
  );
  const id = cred.insertId;
  await db.query(
    `INSERT INTO supervisors (id, full_name, supervisor_type, primary_supervisor_id, group_id, email, phone)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, fullName.trim(), supervisorType, primarySupervisorId ?? null, groupId ?? null, email || null, phone || null]
  );
  await db.query("INSERT INTO settings (user_id) VALUES (?)", [id]);
  await db.query("INSERT INTO privacy_preferences (user_id) VALUES (?)", [id]);
  return { id, fullName: fullName.trim(), memberCode };
}

/** All trainee ids currently in a group. */
async function getTraineeIdsInGroup(db, groupId) {
  if (!groupId) return [];
  const { rows } = await db.query("SELECT id FROM students WHERE group_id = ?", [groupId]);
  return rows.map((r) => r.id);
}

/** All Trainer (ToT) ids currently in a group (excludes the Master Trainer). */
async function getTrainerIdsInGroup(db, groupId) {
  if (!groupId) return [];
  const { rows } = await db.query(
    "SELECT id FROM supervisors WHERE group_id = ? AND supervisor_type = 'in_training'",
    [groupId]
  );
  return rows.map((r) => r.id);
}

/** Links a trainer to a set of trainees' caseloads (idempotent -- safe to call for trainees already linked). */
async function linkTraineesToTrainer(db, trainerId, traineeIds, assignedByUserId) {
  for (const traineeId of traineeIds) {
    await db.query(
      `INSERT INTO supervisor_students (supervisor_id, student_id, assigned_by) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE assigned_at = assigned_at`,
      [trainerId, traineeId, assignedByUserId]
    );
  }
}

/** Links a trainee to a set of supervisors' caseloads (idempotent -- the trainee-side mirror of linkTraineesToTrainer). */
async function linkTraineeToSupervisors(db, traineeId, supervisorIds, assignedByUserId) {
  for (const supervisorId of supervisorIds) {
    await db.query(
      `INSERT INTO supervisor_students (supervisor_id, student_id, assigned_by) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE assigned_at = assigned_at`,
      [supervisorId, traineeId, assignedByUserId]
    );
  }
}

/** Removes a trainer's caseload links to a set of trainees (used when a trainer leaves a group). */
async function unlinkTraineesFromTrainer(db, trainerId, traineeIds) {
  if (!traineeIds.length) return;
  await db.query(
    `DELETE FROM supervisor_students WHERE supervisor_id = ? AND student_id IN (${traineeIds
      .map(() => "?")
      .join(",")})`,
    [trainerId, ...traineeIds]
  );
}

/** The group's current Master Trainer, if any -- status-agnostic on purpose: a suspended Master Trainer still occupies the group's one-Master-Trainer slot until explicitly unassigned. */
async function getActiveMasterTrainer(db, groupId) {
  const { rows } = await db.query(
    "SELECT id, full_name FROM supervisors WHERE group_id = ? AND supervisor_type = 'primary' LIMIT 1",
    [groupId]
  );
  return rows[0] || null;
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
      // member_code is VARCHAR(20) -- without this check, a longer manual
      // code passes every application-level check and then fails at
      // INSERT with a raw, unhandled "Data too long for column" error.
      if (memberCode.length > 20) {
        return res.status(400).json({ error: "ID must be 20 characters or fewer" });
      }
      const taken = await db.query("SELECT id FROM user_credentials WHERE member_code = ?", [memberCode]);
      if (taken.rows.length) return res.status(409).json({ error: `ID "${memberCode}" is already in use` });
    } else {
      const prefix = finalRole === "trainee" ? "TTR" : "SUP";
      memberCode = await generateNextId(db, prefix);
    }

    const plainTempPassword =
      tempPassword && String(tempPassword).length >= 8 ? tempPassword : generateTempPassword();
    const passwordHash = await hashPassword(plainTempPassword);

    // The SELECT above only catches a duplicate manual code sequentially --
    // two genuinely concurrent requests reusing the same one could both
    // pass it before either INSERTs (only the auto-generated path,
    // idGenerator.js, is race-safe via row locking). member_code's own
    // UNIQUE constraint still prevents real duplicate data either way;
    // this only turns the loser's failure into a clean 409 instead of a
    // raw, unhandled crash.
    let credInsert;
    try {
      credInsert = await db.query(
        `INSERT INTO user_credentials (member_code, password_hash, role, must_change_password)
         VALUES (?, ?, ?, TRUE)`,
        [memberCode, passwordHash, finalRole]
      );
    } catch (err) {
      if (err.code === "ER_DUP_ENTRY") {
        return res.status(409).json({ error: `ID "${memberCode}" is already in use` });
      }
      throw err;
    }
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

    const {
      cohort,
      currentYear,
      status,
      groupId,
      fullName,
      email,
      phone,
      // CV-content fields -- bio/specialization only make sense for a
      // supervisor row, highestDegree/institution/certifications only for
      // a student row (see the role check below, same pattern as
      // currentYear/cohort just above).
      bio,
      specialization,
      highestDegree,
      institution,
      certifications,
    } = req.body || {};
    const allowedStatus = ["active", "suspended"];

    if (status !== undefined && !allowedStatus.includes(status)) {
      return res.status(400).json({ error: "Status must be 'active' or 'suspended'" });
    }
    if (status !== undefined) {
      await db.query("UPDATE user_credentials SET status = ?, updated_at = NOW() WHERE id = ?", [status, id]);
    }

    // A Trainee's Group can be edited here (Master Trainers/Trainers keep
    // using PATCH /trainers/:id/group instead, which already has the
    // "target group needs an active Master Trainer" business rule this
    // route has no reason to duplicate). `groupId: null` unassigns.
    let effectiveGroupId;
    let groupActuallyChanged = false;
    if (existing.role === "trainee" && groupId !== undefined) {
      const { rows: priorRows } = await db.query("SELECT group_id FROM students WHERE id = ?", [id]);
      const previousGroupId = priorRows[0] ? priorRows[0].group_id : null;
      const newGroupId = groupId ? Number(groupId) : null;
      if (newGroupId) {
        const { rows: groupRows } = await db.query("SELECT id FROM trainer_groups WHERE id = ?", [newGroupId]);
        if (!groupRows.length) return res.status(404).json({ error: "Group not found" });
      }
      await db.query("UPDATE students SET group_id = ?, updated_at = NOW() WHERE id = ?", [newGroupId, id]);
      effectiveGroupId = newGroupId;
      groupActuallyChanged = newGroupId !== previousGroupId;
    } else if (existing.role === "trainee") {
      const { rows: currentRows } = await db.query("SELECT group_id FROM students WHERE id = ?", [id]);
      effectiveGroupId = currentRows[0] ? currentRows[0].group_id : null;
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
    if (existing.role === "trainee" && highestDegree !== undefined) {
      profileParams.push(highestDegree || null);
      profileUpdates.push(`highest_degree = ?`);
    }
    if (existing.role === "trainee" && institution !== undefined) {
      profileParams.push(institution || null);
      profileUpdates.push(`institution = ?`);
    }
    if (existing.role === "trainee" && certifications !== undefined) {
      profileParams.push(certifications || null);
      profileUpdates.push(`certifications = ?`);
    }
    if (existing.role === "supervisor" && bio !== undefined) {
      profileParams.push(bio || null);
      profileUpdates.push(`bio = ?`);
    }
    if (existing.role === "supervisor" && specialization !== undefined) {
      profileParams.push(specialization || null);
      profileUpdates.push(`specialization = ?`);
    }
    if (profileUpdates.length) {
      profileParams.push(id);
      await db.query(
        `UPDATE ${profileTable} SET ${profileUpdates.join(", ")}, updated_at = NOW() WHERE id = ?`,
        profileParams
      );
    }

    if (existing.role === "trainee" && groupActuallyChanged) {
      // The Group is the sole source of truth for who supervises a Trainee
      // -- moving them to a new Group re-links them to that Group's whole
      // current team (Master Trainer + every Trainer/ToT) and drops any
      // link to a supervisor outside it. There is no per-trainee selection.
      if (effectiveGroupId) {
        await db.query(
          `DELETE ss FROM supervisor_students ss
           JOIN supervisors sup ON sup.id = ss.supervisor_id
           WHERE ss.student_id = ? AND (sup.group_id IS NULL OR sup.group_id != ?)`,
          [id, effectiveGroupId]
        );
        const master = await getActiveMasterTrainer(db, effectiveGroupId);
        const totIds = await getTrainerIdsInGroup(db, effectiveGroupId);
        await linkTraineeToSupervisors(db, id, [master ? master.id : null, ...totIds].filter(Boolean), req.user.id);
      } else {
        // Unassigned from every Group -- no team to link to.
        await db.query("DELETE FROM supervisor_students WHERE student_id = ?", [id]);
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

    if (targetRole === "trainee") {
      // Every trainee-owned table (sessions, attendance, hours, hour
      // adjustments, assignments, submissions, documents, evaluations,
      // payment_transactions, invoices) FKs to students(id) ON DELETE
      // CASCADE -- the DELETE below erases all of it unconditionally,
      // force flag or not, since MySQL applies CASCADE regardless of which
      // application-level query params were sent. Without this check, a
      // plain (non-force) delete of a trainee with real training or
      // financial history would silently destroy that history exactly as
      // completely as "force" does, defeating the entire point of having
      // a separate force flow. So: history existing on for this trainee
      // is what actually gates force, not just the target's role.
      const { rows: historyRows } = await db.query(
        `SELECT 1 FROM sessions WHERE student_id = ?
         UNION ALL SELECT 1 FROM attendance WHERE student_id = ?
         UNION ALL SELECT 1 FROM training_hours WHERE student_id = ?
         UNION ALL SELECT 1 FROM supervision_hours WHERE student_id = ?
         UNION ALL SELECT 1 FROM trainee_hour_adjustments WHERE student_id = ?
         UNION ALL SELECT 1 FROM assignments WHERE student_id = ?
         UNION ALL SELECT 1 FROM assignment_submissions WHERE student_id = ?
         UNION ALL SELECT 1 FROM documents WHERE student_id = ?
         UNION ALL SELECT 1 FROM evaluations WHERE student_id = ?
         UNION ALL SELECT 1 FROM payment_transactions WHERE student_id = ?
         UNION ALL SELECT 1 FROM invoices WHERE student_id = ?
         LIMIT 1`,
        [id, id, id, id, id, id, id, id, id, id, id]
      );
      if (historyRows.length && !force) {
        return res.status(409).json({
          error:
            "This trainee has recorded training and/or financial history (sessions, hours, assignments, documents, evaluations, or payments). Deleting will permanently erase all of it. Suspend the account instead, or confirm permanent delete if you specifically intend to erase this trainee's data.",
        });
      }

      // Trainees can send messages in two separate systems -- the
      // original 1:1 supervisor chat (messages.sender_id) and Group Chats
      // (chat_room_messages.sender_id) -- and neither has a cascade from
      // user_credentials, so both are real remaining blockers once force
      // is actually confirmed. Everything else cascades via student_id.
      if (force) {
        await db.query("DELETE FROM messages WHERE sender_id = ?", [id]);
        await db.query("DELETE FROM chat_room_messages WHERE sender_id = ?", [id]);
      }
    }

    // Anyone -- trainee, supervisor, or admin -- can have sent chat
    // messages, and sender_id has no cascade on either messages table for
    // any role. A chat message isn't training/compliance history like
    // sessions or materials are, so clearing an account's own sent
    // messages before deletion doesn't touch the protections above: a
    // supervisor/admin with real history (sessions, materials, meetings,
    // evaluations) still hits the FK below and gets blocked exactly as
    // before, since none of those tables are touched here.
    if (targetRole !== "trainee") {
      await db.query("DELETE FROM messages WHERE sender_id = ?", [id]);
      await db.query("DELETE FROM chat_room_messages WHERE sender_id = ?", [id]);
    }

    try {
      await db.query("DELETE FROM user_credentials WHERE id = ?", [id]);
    } catch (err) {
      if (err.code === "ER_ROW_IS_REFERENCED_2" || err.errno === 1451) {
        // Permanent delete (force) is only ever offered for trainees (see
        // the check above) -- telling a blocked supervisor/admin deletion
        // to "use permanent delete" would point at an option that route
        // explicitly refuses for their role, and calling their own records
        // "this trainee's data" is simply wrong.
        const message =
          targetRole === "trainee"
            ? force
              ? "This account still has protected history that can't be force-deleted. Suspend it instead."
              : "This account has recorded history (sessions, hours, payments, or messages) and can't be deleted. Suspend it instead, or use permanent delete if you specifically need to erase this trainee's data."
            : "This account has recorded history (sessions, meetings, materials, or other records tied to trainees) and can't be permanently deleted. Suspend it instead.";
        return res.status(409).json({ error: message });
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

// Two things here used to be Postgres/MySQL-only and broke on MariaDB
// (what production actually runs), even though the schema notes above
// already flagged the `groups` reserved-word issue as MariaDB-specific:
//
// 1. must_change_password was wrapped as
//    `IF(cred.must_change_password, CAST('true' AS JSON), CAST('false' AS JSON))`
//    to get a real JSON true/false instead of a bare 0/1 inside the nested
//    blob (db.js's typeCast hook only sees top-level column values, not
//    values already serialized inside a JSON_OBJECT()). MariaDB has no
//    CAST(... AS JSON) target type at all -- "You have an error in your
//    SQL syntax" at exactly this point. Dropped; the raw 0/1 comes through
//    instead, and toBool() below normalizes it in JS.
// 2. The member list was built as `(SELECT JSON_ARRAYAGG(obj) FROM
//    (SELECT ... WHERE member.group_id = g.id ORDER BY ...) t)` -- a
//    derived table so the list could be alphabetized (JSON_ARRAYAGG has no
//    inline ORDER BY). MariaDB's optimizer loses the outer `g.id`
//    correlation once that inner SELECT gets materialized as a derived
//    table, and fails at runtime with "Unknown column 'g.id' in 'WHERE'"
//    -- identical to the `uc.id` failure fixed above for USER_SELECT, same
//    root cause. Flattened to a single-level correlated subquery; sorting
//    moved to sortByFullName() in JS instead.
function memberListSql(fromTable, extraFields) {
  return `
    COALESCE((
      SELECT JSON_ARRAYAGG(JSON_OBJECT(
        'id', member.id, 'full_name', member.full_name, 'member_code', cred.member_code,
        'status', cred.status, 'must_change_password', cred.must_change_password
        ${extraFields ? `, ${extraFields}` : ""}
      ))
      FROM ${fromTable} member JOIN user_credentials cred ON cred.id = member.id
      WHERE member.group_id = g.id ${fromTable === "supervisors" ? "AND member.supervisor_type = ?" : ""}
    ), JSON_ARRAY())
  `;
}

function normalizeMember(m) {
  if (!m) return m;
  return { ...m, must_change_password: toBool(m.must_change_password) };
}

// GET /api/admin/groups
router.get(
  "/groups",
  asyncRoute(async (req, res, db) => {
    const supervisorExtraFields =
      "'email', member.email, 'phone', member.phone, 'specialization', member.specialization, 'bio', member.bio";

    // Each trainee's own current ToT assignment(s) -- an array, since a
    // trainee can be linked to more than one Trainer (ToT) at once (Create
    // Group, Create Member, Add Trainee, and Edit Member all support
    // selecting several).
    const traineeExtraFields = `'tots', COALESCE((
      SELECT JSON_ARRAYAGG(JSON_OBJECT('id', tot.id, 'full_name', tot.full_name))
      FROM supervisor_students ss2
      JOIN supervisors tot ON tot.id = ss2.supervisor_id
      WHERE ss2.student_id = member.id AND tot.supervisor_type = 'in_training'
    ), JSON_ARRAY())`;

    const { rows } = await db.query(
      `
      SELECT
        g.id, g.name, g.created_at,
        (
          SELECT JSON_OBJECT(
            'id', member.id, 'full_name', member.full_name, 'member_code', cred.member_code,
            'status', cred.status, 'must_change_password', cred.must_change_password,
            'email', member.email, 'phone', member.phone,
            'specialization', member.specialization, 'bio', member.bio
          )
          FROM supervisors member JOIN user_credentials cred ON cred.id = member.id
          WHERE member.group_id = g.id AND member.supervisor_type = 'primary'
          LIMIT 1
        ) AS master_trainer,
        ${memberListSql("supervisors", supervisorExtraFields)} AS trainers,
        ${memberListSql("students", traineeExtraFields)} AS trainees
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
        masterTrainer: normalizeMember(parseJsonValue(g.master_trainer, null)),
        trainers: sortByFullName(parseJsonArray(g.trainers).map(normalizeMember)),
        trainees: sortByFullName(parseJsonArray(g.trainees).map(normalizeMember)),
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
    // Any number of Trainers (ToT) is allowed, including zero -- a group
    // can be created with just a Master Trainer and Trainees, and more
    // Trainers can always be added later via Create Trainer / a group's
    // own "Add Trainer" action. Whichever rows ARE submitted still need a
    // real name, same as before.
    if (trainersIn.some((t) => !t || !t.fullName || !String(t.fullName).trim())) {
      return res.status(400).json({ error: "Every Trainer (ToT) needs a full name" });
    }
    // Zero Trainees is valid -- a Group can be stood up with just a Master
    // Trainer (and optionally Trainers/ToT) and Trainees added later.
    // Whichever trainee rows ARE submitted still need a real name. There is
    // no per-trainee Trainer (ToT) selection -- every Trainee in a Group is
    // automatically linked to that Group's whole team below.
    if (traineesIn.some((t) => !t || !t.fullName || !String(t.fullName).trim())) {
      return res.status(400).json({ error: "Every trainee needs a full name" });
    }

    const { rows: nameRows } = await db.query("SELECT id FROM trainer_groups WHERE name = ?", [name]);
    if (nameRows.length) return res.status(409).json({ error: `A group named "${name}" already exists` });

    // Resolve every member code up front (before creating anyone) so a
    // conflict on, say, the second trainee doesn't leave the master
    // trainer/trainers already created -- asyncRoute rolls back the whole
    // transaction on any thrown error, but an early `return` here commits
    // whatever ran so far, so nothing gets inserted until all codes check out.
    const masterCode = await resolveMemberCode(db, masterTrainerIn.memberCode, "SUP");
    if (masterCode.conflict) return res.status(409).json({ error: masterCode.conflict });

    const trainerCodes = [];
    for (const t of trainersIn) {
      const resolved = await resolveMemberCode(db, t.memberCode, "SUP");
      if (resolved.conflict) return res.status(409).json({ error: resolved.conflict });
      trainerCodes.push(resolved.code);
    }

    const traineeCodes = [];
    for (const t of traineesIn) {
      const resolved = await resolveMemberCode(db, t.memberCode, "TTR");
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

    // The SELECT above only catches a duplicate name sequentially -- two
    // concurrent "create group" requests with the same name could both
    // pass it before either INSERTs. trainer_groups.name's own UNIQUE
    // constraint still prevents two groups actually ending up with the
    // same name; this only turns the loser's failure into a clean 409
    // instead of a raw, unhandled crash.
    let groupInsert;
    try {
      groupInsert = await db.query("INSERT INTO trainer_groups (name) VALUES (?)", [name]);
    } catch (err) {
      if (err.code === "ER_DUP_ENTRY") {
        return res.status(409).json({ error: `A group named "${name}" already exists` });
      }
      throw err;
    }
    const group = { id: groupInsert.insertId, name };

    const masterTrainer = await insertSupervisorAccount(db, {
      fullName: masterTrainerIn.fullName,
      memberCode: masterCode.code,
      passwordHash: trainerHash,
      supervisorType: "primary",
      primarySupervisorId: null,
      groupId: group.id,
    });

    const trainers = [];
    for (let i = 0; i < trainersIn.length; i++) {
      trainers.push(
        await insertSupervisorAccount(db, {
          fullName: trainersIn[i].fullName,
          memberCode: trainerCodes[i],
          passwordHash: trainerHash,
          supervisorType: "in_training",
          primarySupervisorId: masterTrainer.id,
          groupId: group.id,
        })
      );
    }

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

      // Every Trainee in a newly-created group is automatically supervised
      // by that group's whole training team -- the Master Trainer and every
      // Trainer (ToT) created alongside them. The Group is the source of
      // truth for who supervises whom; there is no per-trainee selection.
      await linkTraineeToSupervisors(db, id, [masterTrainer.id, ...trainers.map((t) => t.id)], req.user.id);

      trainees.push({
        id,
        fullName: traineesIn[i].fullName.trim(),
        memberCode,
      });
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

// PATCH /api/admin/groups/:id  { name }
// Rename a group. `trainer_groups` has no other editable column -- id,
// name, created_at is the whole table -- so renaming is the entirety of
// "edit group info".
router.patch(
  "/groups/:id",
  asyncRoute(async (req, res, db) => {
    const id = parseIdParam(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid group id" });

    const name = String((req.body || {}).name || "").trim();
    if (!name) return res.status(400).json({ error: "Group name is required" });

    const { rows: existingRows } = await db.query("SELECT id FROM trainer_groups WHERE id = ?", [id]);
    if (!existingRows.length) return res.status(404).json({ error: "Group not found" });

    const { rows: nameRows } = await db.query(
      "SELECT id FROM trainer_groups WHERE name = ? AND id != ?",
      [name, id]
    );
    if (nameRows.length) return res.status(409).json({ error: `A group named "${name}" already exists` });

    // Same race as group creation -- the SELECT above only catches a
    // sequential conflict; the UNIQUE constraint on name still prevents
    // real duplicates, this just avoids a raw crash for the loser.
    try {
      await db.query("UPDATE trainer_groups SET name = ? WHERE id = ?", [name, id]);
    } catch (err) {
      if (err.code === "ER_DUP_ENTRY") {
        return res.status(409).json({ error: `A group named "${name}" already exists` });
      }
      throw err;
    }
    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES (?, 'group_updated', 'trainer_groups', ?)",
      [req.user.id, id]
    );

    res.json({ id, name });
  })
);

// DELETE /api/admin/groups/:id -- only when fully emptied. Nothing about a
// Group's cascade behavior is safe to guess: trainer_groups.id is
// ON DELETE SET NULL from both supervisors.group_id and students.group_id,
// so deleting a Group with real members would silently detach them from
// their MT/Group instead of erroring -- exactly the kind of silent data
// loss the rest of this app goes out of its way to prevent. Retiring a
// Group is therefore only ever offered once every member has already been
// moved out or removed, never as a cascading action.
router.delete(
  "/groups/:id",
  asyncRoute(async (req, res, db) => {
    const id = parseIdParam(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid group id" });

    const { rows: existingRows } = await db.query("SELECT id, name FROM trainer_groups WHERE id = ?", [id]);
    if (!existingRows.length) return res.status(404).json({ error: "Group not found" });

    const { rows: memberRows } = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM supervisors WHERE group_id = ?) AS supervisor_count,
         (SELECT COUNT(*) FROM students WHERE group_id = ?) AS student_count`,
      [id, id]
    );
    const supervisorCount = Number(memberRows[0].supervisor_count);
    const studentCount = Number(memberRows[0].student_count);
    if (supervisorCount > 0 || studentCount > 0) {
      return res.status(409).json({
        error: `This Group still has ${supervisorCount} Trainer(s) and ${studentCount} Trainee(s). Reassign or remove every member before deleting the Group.`,
      });
    }

    await db.query("DELETE FROM trainer_groups WHERE id = ?", [id]);
    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, old_values) VALUES (?, 'group_deleted', 'trainer_groups', ?, ?)",
      [req.user.id, id, JSON.stringify(existingRows[0])]
    );

    res.json({ success: true });
  })
);

// ---- Trainers (create/assign independently of Group creation) -----------
// A Trainer (Master Trainer or Trainer/ToT) is a `supervisors` row like any
// created via POST /groups, but these two routes let Admin create or
// (re)assign one WITHOUT touching an existing group's other members --
// POST /groups is reserved for the initial "stand up a whole new group"
// action. Both routes share the insertSupervisorAccount/linkTraineesToTrainer
// helpers above with POST /groups, so there's exactly one way a trainer
// account or a trainee<->trainer caseload link ever gets created.

// POST /api/admin/trainers
// { fullName, role: 'primary'|'in_training'|'trainee', groupId?, email?, phone?, memberCode?, tempPassword? }
// Despite the route name (kept as-is to avoid touching its three existing
// callers), this is also where Create Member posts a Trainee -- one
// endpoint for all three roles, per the "one reusable Member system"
// requirement, rather than a separate near-duplicate route.
router.post(
  "/trainers",
  asyncRoute(async (req, res, db) => {
    const body = req.body || {};
    const fullName = String(body.fullName || "").trim();
    const role = body.role;
    const groupId = body.groupId ? Number(body.groupId) : null;

    if (!fullName) return res.status(400).json({ error: "Full name is required" });

    if (role === "trainee") {
      if (!groupId) return res.status(400).json({ error: "A Trainee must be assigned to a Group" });
      const { rows: groupRows } = await db.query("SELECT id FROM trainer_groups WHERE id = ?", [groupId]);
      if (!groupRows.length) return res.status(404).json({ error: "Group not found" });

      const codeResult = await resolveMemberCode(db, body.memberCode, "TTR");
      if (codeResult.conflict) return res.status(409).json({ error: codeResult.conflict });

      const plainTempPassword =
        body.tempPassword && String(body.tempPassword).length >= 8
          ? String(body.tempPassword)
          : generateTempPassword();
      const passwordHash = await hashPassword(plainTempPassword);

      const cred = await db.query(
        `INSERT INTO user_credentials (member_code, password_hash, role, must_change_password) VALUES (?, ?, 'trainee', TRUE)`,
        [codeResult.code, passwordHash]
      );
      const traineeId = cred.insertId;
      await db.query("INSERT INTO students (id, full_name, group_id) VALUES (?, ?, ?)", [traineeId, fullName, groupId]);
      await db.query("INSERT INTO settings (user_id) VALUES (?)", [traineeId]);
      await db.query("INSERT INTO privacy_preferences (user_id) VALUES (?)", [traineeId]);
      await db.query("INSERT INTO payments (student_id, total_fee_cents) VALUES (?, 0)", [traineeId]);

      // Always linked to the group's whole current training team -- the
      // Master Trainer (if one exists yet) plus every Trainer (ToT) in the
      // group. The Group is the source of truth for who supervises whom;
      // there is no per-trainee selection.
      const master = await getActiveMasterTrainer(db, groupId);
      const totIds = await getTrainerIdsInGroup(db, groupId);
      await linkTraineeToSupervisors(db, traineeId, [master ? master.id : null, ...totIds].filter(Boolean), req.user.id);

      await db.query(
        "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES (?, 'account_created', 'user_credentials', ?)",
        [req.user.id, traineeId]
      );

      const { rows: traineeRows } = await db.query(`${USER_SELECT} WHERE uc.id = ?`, [traineeId]);
      return res.status(201).json({
        user: toPublicUser(traineeRows[0]),
        memberCode: codeResult.code,
        tempPassword: plainTempPassword,
      });
    }

    if (!["primary", "in_training"].includes(role)) {
      return res.status(400).json({ error: "Role must be 'primary' (Master Trainer), 'in_training' (Trainer), or 'trainee'" });
    }
    if (role === "in_training" && !groupId) {
      return res.status(400).json({
        error:
          "A Trainer (ToT) must be assigned to a Group with an active Master Trainer -- create the Master Trainer first, or pick an existing Group.",
      });
    }

    let group = null;
    let primarySupervisorId = null;
    if (groupId) {
      const { rows: groupRows } = await db.query("SELECT id, name FROM trainer_groups WHERE id = ?", [groupId]);
      if (!groupRows.length) return res.status(404).json({ error: "Group not found" });
      group = groupRows[0];

      const existingMaster = await getActiveMasterTrainer(db, groupId);
      if (role === "primary" && existingMaster) {
        return res.status(409).json({
          error: `This group already has a Master Trainer (${existingMaster.full_name}). Reassign or unassign them first.`,
        });
      }
      if (role === "in_training") {
        if (!existingMaster) {
          return res.status(409).json({
            error: "Assign this group's Master Trainer before adding a Trainer (ToT).",
          });
        }
        primarySupervisorId = existingMaster.id;
      }
    }

    const codeResult = await resolveMemberCode(db, body.memberCode, "SUP");
    if (codeResult.conflict) return res.status(409).json({ error: codeResult.conflict });

    const plainTempPassword =
      body.tempPassword && String(body.tempPassword).length >= 8
        ? String(body.tempPassword)
        : generateTempPassword();
    const passwordHash = await hashPassword(plainTempPassword);

    const trainer = await insertSupervisorAccount(db, {
      fullName,
      memberCode: codeResult.code,
      passwordHash,
      supervisorType: role,
      primarySupervisorId,
      groupId: group ? group.id : null,
      email: body.email,
      phone: body.phone,
    });

    if (group) {
      const traineeIds = await getTraineeIdsInGroup(db, group.id);
      await linkTraineesToTrainer(db, trainer.id, traineeIds, req.user.id);
    }

    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES (?, 'account_created', 'user_credentials', ?)",
      [req.user.id, trainer.id]
    );

    const { rows } = await db.query(`${USER_SELECT} WHERE uc.id = ?`, [trainer.id]);
    res.status(201).json({
      user: toPublicUser(rows[0]),
      memberCode: codeResult.code,
      tempPassword: plainTempPassword,
    });
  })
);

// PATCH /api/admin/trainers/:id/group  { groupId: number|null }
// Assigns, reassigns, or unassigns (groupId: null) an EXISTING trainer.
// This is the one code path for both the standalone Trainers list's
// "Reassign" action and Groups -> open group -> "Add Trainer" -> "assign an
// existing unassigned trainer".
router.patch(
  "/trainers/:id/group",
  asyncRoute(async (req, res, db) => {
    const id = parseIdParam(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid trainer id" });

    const { rows: trainerRows } = await db.query(
      "SELECT id, supervisor_type, group_id FROM supervisors WHERE id = ?",
      [id]
    );
    if (!trainerRows.length) return res.status(404).json({ error: "Trainer not found" });
    const trainer = trainerRows[0];

    const body = req.body || {};
    const hasGroupId = Object.prototype.hasOwnProperty.call(body, "groupId");
    const newGroupId = hasGroupId && body.groupId !== null ? Number(body.groupId) : null;
    if (!hasGroupId) return res.status(400).json({ error: "groupId is required (use null to unassign)" });

    const oldTraineeIds = await getTraineeIdsInGroup(db, trainer.group_id);

    if (newGroupId === null) {
      // Unassigning a Master Trainer who still has active Trainers (ToT)
      // reporting to them would orphan that reporting line -- block it.
      if (trainer.supervisor_type === "primary") {
        const { rows: dependents } = await db.query(
          "SELECT id FROM supervisors WHERE primary_supervisor_id = ?",
          [id]
        );
        if (dependents.length) {
          return res.status(409).json({
            error: "This Master Trainer still has Trainers (ToT) reporting to them. Reassign or remove those Trainers first.",
          });
        }
      }
      await db.query("UPDATE supervisors SET group_id = NULL, updated_at = NOW() WHERE id = ?", [id]);
      await unlinkTraineesFromTrainer(db, id, oldTraineeIds);
    } else {
      const { rows: groupRows } = await db.query("SELECT id FROM trainer_groups WHERE id = ?", [newGroupId]);
      if (!groupRows.length) return res.status(404).json({ error: "Group not found" });

      const existingMaster = await getActiveMasterTrainer(db, newGroupId);
      let primarySupervisorId;
      if (trainer.supervisor_type === "primary") {
        if (existingMaster && existingMaster.id !== id) {
          return res.status(409).json({
            error: `This group already has a Master Trainer (${existingMaster.full_name}). Reassign or unassign them first.`,
          });
        }
        primarySupervisorId = null;
      } else {
        if (!existingMaster) {
          return res.status(409).json({ error: "This group doesn't have a Master Trainer yet -- assign one before adding a Trainer (ToT)." });
        }
        primarySupervisorId = existingMaster.id;
      }

      await db.query(
        "UPDATE supervisors SET group_id = ?, primary_supervisor_id = ?, updated_at = NOW() WHERE id = ?",
        [newGroupId, primarySupervisorId, id]
      );

      if (trainer.group_id !== newGroupId) {
        await unlinkTraineesFromTrainer(db, id, oldTraineeIds);
      }
      const newTraineeIds = await getTraineeIdsInGroup(db, newGroupId);
      await linkTraineesToTrainer(db, id, newTraineeIds, req.user.id);
    }

    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES (?, 'account_updated', 'user_credentials', ?)",
      [req.user.id, id]
    );

    const { rows } = await db.query(`${USER_SELECT} WHERE uc.id = ?`, [id]);
    res.json(toProfileResponse(rows[0]));
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
       WHERE d.student_id = ? ORDER BY d.created_at DESC LIMIT 500`,
      [id]
    );
    const documents = documentRows.map(toDocument);

    const progress = await computeProgressSummary(db, id);

    const { years: paymentYears, activeYear: paymentActiveYear } = await getYearlyPayments(
      db,
      id,
      profile.full_name,
      profile.memberCode
    );
    const activePaymentYear = paymentYears.find((y) => y.trainingYear === paymentActiveYear);

    const { masterTrainer, totTrainers, trainingHours } = await getTrainersAndHours(db, id, profile.full_name);

    res.json({
      profile,
      records,
      documents,
      progress,
      payment: activePaymentYear.summary,
      paymentTransactions: activePaymentYear.transactions,
      paymentActiveYear,
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

  // Same three-part formula as computeProgressSummary (legacy typed rows +
  // attendance-derived session hours + audited manual adjustments), just
  // grouped per supervisor instead of summed for the whole trainee, so
  // this card never disagrees with the trainee's own total shown elsewhere.
  const { rows: hoursRows } = await db.query(
    `SELECT supervisor_id, COALESCE(SUM(hours), 0) AS hours FROM (
       SELECT supervisor_id, hours FROM supervision_hours WHERE student_id = ?
       UNION ALL
       SELECT s.supervisor_id, s.duration_minutes / 60 AS hours FROM sessions s
         JOIN attendance a ON a.session_id = s.id AND a.status = 'present'
         WHERE s.student_id = ? AND s.session_type = 'supervision' AND s.status != 'cancelled'
       UNION ALL
       SELECT added_by AS supervisor_id, hours FROM trainee_hour_adjustments WHERE student_id = ? AND hour_type = 'supervision'
     ) combined GROUP BY supervisor_id`,
    [studentId, studentId, studentId]
  );
  const hoursBySupervisor = {};
  hoursRows.forEach((r) => (hoursBySupervisor[r.supervisor_id] = Number(r.hours)));

  const { rows: traineeHoursRows } = await db.query(
    `SELECT
       COALESCE((SELECT SUM(hours) FROM training_hours WHERE student_id = ?), 0) +
       COALESCE((SELECT SUM(s.duration_minutes) / 60 FROM sessions s
         JOIN attendance a ON a.session_id = s.id AND a.status = 'present'
         WHERE s.student_id = ? AND s.session_type = 'training' AND s.status != 'cancelled'), 0) +
       COALESCE((SELECT SUM(hours) FROM trainee_hour_adjustments WHERE student_id = ? AND hour_type = 'training'), 0)
     AS hours`,
    [studentId, studentId, studentId]
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

    const filePath = path.join(config.uploadsDir, "documents", rows[0].filename);
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
  eventImageUpload.single("image")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const check = checkFileContent(req.file.path, ["image"]);
    if (!check.safe) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: check.reason });
    }
    await optimizeImageIfPossible(req.file.path, { maxDimension: 1600 });
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

// ---- Payments (financial ledger, admin-managed, one independent fee ----
// agreement per training year 1-4) -------------------------------------
// Authorization for these tables is enforced entirely at the Express
// layer: this whole router requires requireAdmin (see `router.use` above)
// -- there is no Row-Level Security in MySQL to lean on the way the
// previous Postgres schema's (defense-in-depth, not the actual
// enforcement point) RLS policies did.
//
// The 4-year program is billed as four independent periods (different
// schedules, amounts, and payment counts are expected across years), so
// `payments` now has one row per (student, training_year) instead of one
// row per student, and every `payment_transactions` entry is tied to a
// specific year's row via payment_id. A year with no `payments` row yet
// simply hasn't been configured -- it still renders as a $0/not-started
// placeholder rather than being treated as an error.

const TRAINING_YEARS = [1, 2, 3, 4];

async function getPaymentsRow(db, studentId, trainingYear) {
  const { rows } = await db.query("SELECT * FROM payments WHERE student_id = ? AND training_year = ?", [
    studentId,
    trainingYear,
  ]);
  return rows[0] || null;
}
async function getTransactionsForPayment(db, paymentId) {
  if (!paymentId) return [];
  const { rows } = await db.query(
    `SELECT pt.*, uc.member_code AS added_by_code, COALESCE(a.full_name, sup.full_name) AS added_by_name
     FROM payment_transactions pt
     JOIN user_credentials uc ON uc.id = pt.added_by
     LEFT JOIN admin_users a ON a.id = pt.added_by
     LEFT JOIN supervisors sup ON sup.id = pt.added_by
     WHERE pt.payment_id = ?
     ORDER BY pt.payment_date DESC, pt.created_at DESC`,
    [paymentId]
  );
  return rows;
}
/** Keeps the stored payments.status column in sync with the live ledger total for this year's row, for any other query that filters/sorts by it directly. */
async function recomputeStoredStatus(db, paymentId) {
  const { rows } = await db.query("SELECT * FROM payments WHERE id = ?", [paymentId]);
  const paymentsRow = rows[0];
  const transactions = await getTransactionsForPayment(db, paymentId);
  const paidCents = transactions.reduce((sum, t) => sum + t.amount_cents, 0);
  const netFeeCents = Math.max((paymentsRow?.total_fee_cents || 0) - (paymentsRow?.discount_cents || 0), 0);
  const remaining = netFeeCents - paidCents;
  const status = paidCents > 0 && remaining <= 0 ? "paid" : paidCents > 0 ? "partial" : "unpaid";
  await db.query("UPDATE payments SET status = ?, updated_at = NOW() WHERE id = ?", [status, paymentId]);
  return { paymentsRow: { ...paymentsRow, status }, transactions };
}

/** Builds all 4 training-year entries for a student and picks the "active"
 * one -- the first year not yet marked completed (period_status is a
 * separate, explicitly admin-set lifecycle flag, independent of whether
 * the year's balance has reached zero, since a year's real close-out is
 * an administrative decision, not something derivable from the ledger). */
async function getYearlyPayments(db, studentId, fullName, memberCode) {
  const years = [];
  for (const trainingYear of TRAINING_YEARS) {
    const paymentsRow = await getPaymentsRow(db, studentId, trainingYear);
    const transactions = paymentsRow ? await getTransactionsForPayment(db, paymentsRow.id) : [];
    years.push({
      trainingYear,
      periodStatus: paymentsRow?.period_status || "active",
      summary: toPaymentSummary({ id: studentId, full_name: fullName, member_code: memberCode }, paymentsRow, transactions),
      transactions: transactions.map(toPaymentTransaction),
    });
  }
  const activeYear = years.find((y) => y.periodStatus !== "completed")?.trainingYear || 4;
  return { years, activeYear };
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
      const { years, activeYear } = await getYearlyPayments(db, s.id, s.full_name, s.member_code);
      const active = years.find((y) => y.trainingYear === activeYear);
      summaries.push({ ...active.summary, activeYear });
    }

    res.json({ payments: summaries });
  })
);

// GET /api/admin/payments/:studentId — all 4 years
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

    const { years, activeYear } = await getYearlyPayments(db, studentId, rows[0].full_name, rows[0].member_code);

    res.json({ fullName: rows[0].full_name, memberCode: rows[0].member_code, activeYear, years });
  })
);

// PUT /api/admin/payments/:studentId/years/:year/total-fee  { totalFee, discount?, paymentPlan?, nextDueDate? }
router.put(
  "/payments/:studentId/years/:year/total-fee",
  asyncRoute(async (req, res, db) => {
    const studentId = parseIdParam(req.params.studentId);
    const trainingYear = Number(req.params.year);
    if (!studentId) return res.status(400).json({ error: "Invalid student id" });
    if (!TRAINING_YEARS.includes(trainingYear)) return res.status(400).json({ error: "year must be 1-4" });

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

    const existing = await getPaymentsRow(db, studentId, trainingYear);
    let paymentId;
    if (existing) {
      await db.query(
        `UPDATE payments SET total_fee_cents = ?, discount_cents = ?, payment_plan = ?, next_due_date = ?, updated_at = NOW()
         WHERE id = ?`,
        [totalFeeCents, discountCents, paymentPlan, nextDueDate, existing.id]
      );
      paymentId = existing.id;
    } else {
      // Two genuinely concurrent "set the fee for this year" requests (the
      // first ever for this student+year) can both see "no row yet" before
      // either commits -- payments(student_id, training_year) has its own
      // UNIQUE constraint (uq_payments_student_year), so the loser's INSERT
      // fails there. Falling back to UPDATE on that row (rather than just
      // re-fetching and discarding this request's values) means whichever
      // request actually finishes last still wins, matching normal
      // last-write-wins semantics instead of silently dropping it.
      try {
        const { insertId } = await db.query(
          `INSERT INTO payments (student_id, training_year, total_fee_cents, discount_cents, payment_plan, next_due_date)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [studentId, trainingYear, totalFeeCents, discountCents, paymentPlan, nextDueDate]
        );
        paymentId = insertId;
      } catch (err) {
        if (err.code !== "ER_DUP_ENTRY") throw err;
        // The race winner's row exists and is committed, but under
        // REPEATABLE READ (MySQL's default) a plain SELECT in this
        // transaction is still bound to the snapshot taken by the
        // getPaymentsRow call above -- before the winner committed -- and
        // would return nothing even though the row is really there now.
        // Updating by (student_id, training_year) directly, rather than
        // first fetching the id via another plain SELECT, sidesteps that
        // stale-snapshot trap entirely.
        await db.query(
          `UPDATE payments SET total_fee_cents = ?, discount_cents = ?, payment_plan = ?, next_due_date = ?, updated_at = NOW()
           WHERE student_id = ? AND training_year = ?`,
          [totalFeeCents, discountCents, paymentPlan, nextDueDate, studentId, trainingYear]
        );
        const { rows: raceWinnerRows } = await db.query(
          "SELECT id FROM payments WHERE student_id = ? AND training_year = ? FOR UPDATE",
          [studentId, trainingYear]
        );
        paymentId = raceWinnerRows[0].id;
      }
    }

    await recomputeStoredStatus(db, paymentId);
    const { rows: nameRows } = await db.query(
      "SELECT uc.member_code, st.full_name FROM user_credentials uc JOIN students st ON st.id = uc.id WHERE uc.id = ?",
      [studentId]
    );
    const { years, activeYear } = await getYearlyPayments(db, studentId, nameRows[0].full_name, nameRows[0].member_code);

    res.json({ fullName: nameRows[0].full_name, memberCode: nameRows[0].member_code, activeYear, years });
  })
);

// POST /api/admin/payments/:studentId/years/:year/transactions  { amount, date, method, notes }
router.post(
  "/payments/:studentId/years/:year/transactions",
  asyncRoute(async (req, res, db) => {
    const studentId = parseIdParam(req.params.studentId);
    const trainingYear = Number(req.params.year);
    if (!studentId) return res.status(400).json({ error: "Invalid student id" });
    if (!TRAINING_YEARS.includes(trainingYear)) return res.status(400).json({ error: "year must be 1-4" });

    const { rows: studentRows } = await db.query("SELECT id FROM students WHERE id = ?", [studentId]);
    if (!studentRows.length) return res.status(404).json({ error: "Trainee not found" });

    const { amount, date, method, notes } = req.body || {};
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount === 0) {
      return res.status(400).json({ error: "amount must be a non-zero number" });
    }
    if (!date) return res.status(400).json({ error: "date is required" });
    const amountCents = Math.round(numericAmount * 100);

    // A year's payments row may not exist yet if the admin records a
    // payment before ever setting a total fee for it -- create it with a
    // $0 fee so the ledger entry always has a year to attach to. Two
    // genuinely concurrent first-ever-payment requests for the same
    // student+year can both see "no row yet" before either commits;
    // payments(student_id, training_year) has its own UNIQUE constraint
    // (uq_payments_student_year), so the loser's INSERT fails there --
    // caught here and treated as "someone else just created it", not an
    // error, since that's exactly what happened.
    let paymentsRow = await getPaymentsRow(db, studentId, trainingYear);
    if (!paymentsRow) {
      try {
        await db.query("INSERT INTO payments (student_id, training_year, total_fee_cents) VALUES (?, ?, 0)", [
          studentId,
          trainingYear,
        ]);
        paymentsRow = await getPaymentsRow(db, studentId, trainingYear);
      } catch (err) {
        if (err.code !== "ER_DUP_ENTRY") throw err;
        // The race winner's row exists and is committed, but under
        // REPEATABLE READ (MySQL's default) a plain SELECT in this
        // transaction is still bound to the snapshot from the getPaymentsRow
        // call above -- taken before the winner committed -- and would
        // return NULL again even though the row is really there now. A
        // locking read forces a fresh read of the latest committed data
        // instead of that stale snapshot.
        const { rows: raceWinnerRows } = await db.query(
          "SELECT * FROM payments WHERE student_id = ? AND training_year = ? FOR UPDATE",
          [studentId, trainingYear]
        );
        paymentsRow = raceWinnerRows[0];
      }
    }

    // Locks this payment year's row for the rest of the transaction --
    // without it, the duplicate check below is a plain SELECT-then-INSERT
    // with no lock, so two genuinely concurrent requests (not just a
    // sequential double-click) could both pass the check before either
    // commits. Every transaction for this student+year attaches to this
    // one payments row, so locking it serializes concurrent attempts to
    // record one, the same way id_counters (idGenerator.js) uses
    // SELECT ... FOR UPDATE to serialize concurrent ID generation.
    await db.query("SELECT id FROM payments WHERE id = ? FOR UPDATE", [paymentsRow.id]);

    // Duplicate-submission guard (same year/amount/date/method within
    // the last 10 seconds) -- catches accidental double-clicks without
    // blocking legitimate repeat payments made later. FOR UPDATE here
    // isn't just about locking: under REPEATABLE READ (MySQL's default),
    // a plain SELECT stays bound to this transaction's snapshot from
    // BEFORE the FOR UPDATE above unblocked it, so it would miss a
    // concurrent request's transaction that just committed -- only a
    // locking read forces MySQL to fetch the latest committed data
    // instead of that stale snapshot.
    const { rows: dupeRows } = await db.query(
      `SELECT id FROM payment_transactions
       WHERE payment_id = ? AND amount_cents = ? AND payment_date = ? AND COALESCE(method,'') = COALESCE(?,'')
         AND created_at >= NOW() - INTERVAL 10 SECOND
       FOR UPDATE`,
      [paymentsRow.id, amountCents, date, method || null]
    );
    if (dupeRows.length) {
      return res.status(409).json({
        error: "This looks like a duplicate of a payment just submitted. Refresh and check the history before retrying.",
      });
    }

    await db.query(
      `INSERT INTO payment_transactions (student_id, payment_id, amount_cents, transaction_type, payment_date, method, added_by, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        studentId,
        paymentsRow.id,
        amountCents,
        amountCents < 0 ? "refund" : "payment",
        date,
        method || null,
        req.user.id,
        notes || null,
      ]
    );
    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, new_values) VALUES (?, 'payment_recorded', 'payment_transactions', ?, ?)",
      [req.user.id, studentId, JSON.stringify({ amountCents, date, method, trainingYear })]
    );

    await recomputeStoredStatus(db, paymentsRow.id);
    const { rows: nameRows } = await db.query(
      "SELECT uc.member_code, st.full_name FROM user_credentials uc JOIN students st ON st.id = uc.id WHERE uc.id = ?",
      [studentId]
    );
    const { years, activeYear } = await getYearlyPayments(db, studentId, nameRows[0].full_name, nameRows[0].member_code);

    res.status(201).json({ fullName: nameRows[0].full_name, memberCode: nameRows[0].member_code, activeYear, years });
  })
);

// PUT /api/admin/payments/:studentId/years/:year/status  { periodStatus: 'active'|'completed' }
router.put(
  "/payments/:studentId/years/:year/status",
  asyncRoute(async (req, res, db) => {
    const studentId = parseIdParam(req.params.studentId);
    const trainingYear = Number(req.params.year);
    if (!studentId) return res.status(400).json({ error: "Invalid student id" });
    if (!TRAINING_YEARS.includes(trainingYear)) return res.status(400).json({ error: "year must be 1-4" });

    const periodStatus = req.body?.periodStatus;
    if (!["active", "completed"].includes(periodStatus)) {
      return res.status(400).json({ error: "periodStatus must be 'active' or 'completed'" });
    }

    const { rows: studentRows } = await db.query("SELECT id FROM students WHERE id = ?", [studentId]);
    if (!studentRows.length) return res.status(404).json({ error: "Trainee not found" });

    const existing = await getPaymentsRow(db, studentId, trainingYear);
    if (existing) {
      await db.query("UPDATE payments SET period_status = ?, updated_at = NOW() WHERE id = ?", [
        periodStatus,
        existing.id,
      ]);
    } else {
      await db.query("INSERT INTO payments (student_id, training_year, total_fee_cents, period_status) VALUES (?, ?, 0, ?)", [
        studentId,
        trainingYear,
        periodStatus,
      ]);
    }
    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, new_values) VALUES (?, 'payment_year_status_changed', 'payments', ?, ?)",
      [req.user.id, studentId, JSON.stringify({ trainingYear, periodStatus })]
    );

    const { rows: nameRows } = await db.query(
      "SELECT uc.member_code, st.full_name FROM user_credentials uc JOIN students st ON st.id = uc.id WHERE uc.id = ?",
      [studentId]
    );
    const { years, activeYear } = await getYearlyPayments(db, studentId, nameRows[0].full_name, nameRows[0].member_code);

    res.json({ fullName: nameRows[0].full_name, memberCode: nameRows[0].member_code, activeYear, years });
  })
);

// ---- Training Milestone definitions --------------------------------------
// Admin defines the real curriculum stages here (seeded with an illustrative
// starting set by migration 002) -- never hardcoded in route/frontend logic.
// Trainers (ToT) mark trainee progress against these via
// routes/supervisor.js; the Master Trainer's view is read-only.

// GET /api/admin/milestones — every definition, active and inactive
router.get(
  "/milestones",
  asyncRoute(async (req, res, db) => {
    const { rows } = await db.query(
      "SELECT id, code, name_en, name_ar, description_en, description_ar, sort_order, is_active, created_at FROM training_milestones ORDER BY sort_order ASC"
    );
    res.json({ milestones: rows });
  })
);

// POST /api/admin/milestones  { code, nameEn, nameAr?, descriptionEn?, descriptionAr?, sortOrder? }
router.post(
  "/milestones",
  asyncRoute(async (req, res, db) => {
    const { code, nameEn, nameAr, descriptionEn, descriptionAr, sortOrder } = req.body || {};
    const cleanCode = String(code || "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
    if (!cleanCode) return res.status(400).json({ error: "Code is required" });
    if (!nameEn || !String(nameEn).trim()) return res.status(400).json({ error: "English name is required" });

    const { rows: existing } = await db.query("SELECT id FROM training_milestones WHERE code = ?", [cleanCode]);
    if (existing.length) return res.status(409).json({ error: `Code "${cleanCode}" is already in use` });

    const result = await db.query(
      `INSERT INTO training_milestones (code, name_en, name_ar, description_en, description_ar, sort_order, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [cleanCode, nameEn.trim(), nameAr || null, descriptionEn || null, descriptionAr || null, Number(sortOrder) || 0, req.user.id]
    );

    res.status(201).json({ id: result.insertId, code: cleanCode });
  })
);

// PUT /api/admin/milestones/:id  { nameEn?, nameAr?, descriptionEn?, descriptionAr?, sortOrder?, isActive? }
router.put(
  "/milestones/:id",
  asyncRoute(async (req, res, db) => {
    const id = parseIdParam(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid milestone id" });

    const { nameEn, nameAr, descriptionEn, descriptionAr, sortOrder, isActive } = req.body || {};
    const updates = [];
    const params = [];
    if (nameEn !== undefined) { updates.push("name_en = ?"); params.push(nameEn); }
    if (nameAr !== undefined) { updates.push("name_ar = ?"); params.push(nameAr || null); }
    if (descriptionEn !== undefined) { updates.push("description_en = ?"); params.push(descriptionEn || null); }
    if (descriptionAr !== undefined) { updates.push("description_ar = ?"); params.push(descriptionAr || null); }
    if (sortOrder !== undefined) { updates.push("sort_order = ?"); params.push(Number(sortOrder) || 0); }
    if (isActive !== undefined) { updates.push("is_active = ?"); params.push(!!isActive); }
    if (!updates.length) return res.status(400).json({ error: "No fields to update" });

    params.push(id);
    const { affectedRows } = await db.query(
      `UPDATE training_milestones SET ${updates.join(", ")}, updated_at = NOW() WHERE id = ?`,
      params
    );
    if (!affectedRows) return res.status(404).json({ error: "Milestone not found" });

    res.json({ success: true });
  })
);

module.exports = router;
