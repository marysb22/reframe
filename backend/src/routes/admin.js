const express = require("express");
const fs = require("fs");
const path = require("path");
const { requireAuth, requireAdmin, asyncRoute } = require("../middleware/auth");
const { generateNextId } = require("../utils/idGenerator");
const { hashPassword, generateTempPassword } = require("../utils/authUtils");
const {
  toPublicUser,
  toProfileResponse,
  toPaymentSummary,
  toPaymentTransaction,
  toRecord,
  toDocument,
  computeProgressSummary,
} = require("../utils/serializers");
const { buildRecordsQuery } = require("../utils/recordsQuery");

const router = express.Router();

router.use(requireAuth, requireAdmin);

// Every account-management query joins the three profile tables and their
// cohort, so a single row shape covers both a student and a supervisor
// (the columns that don't apply to that role just come back NULL).
const USER_SELECT = `
  SELECT
    uc.id, uc.member_code, uc.role, uc.status, uc.must_change_password,
    uc.created_at, uc.updated_at,
    COALESCE(sup.full_name, st.full_name) AS full_name,
    COALESCE(sup.email, st.email) AS email,
    COALESCE(sup.phone, st.phone) AS phone,
    COALESCE(sup.photo, st.photo) AS photo,
    sup.specialization, sup.bio,
    sup.supervisor_type, sup.primary_supervisor_id, psup.full_name AS primary_supervisor_name,
    st.gender, st.date_of_birth, st.marital_status, st.address, st.certifications, st.cv_file,
    st.cohort_id, c.name AS cohort_name, st.current_year, st.highest_degree, st.institution,
    COALESCE(
      (SELECT json_agg(json_build_object('id', sup2.id, 'full_name', sup2.full_name) ORDER BY sup2.full_name)
       FROM supervisor_students ss JOIN supervisors sup2 ON sup2.id = ss.supervisor_id
       WHERE ss.student_id = uc.id),
      '[]'
    ) AS supervisors,
    COALESCE(
      (SELECT json_agg(json_build_object('id', tot.id, 'full_name', tot.full_name) ORDER BY tot.full_name)
       FROM supervisors tot WHERE tot.primary_supervisor_id = sup.id),
      '[]'
    ) AS trainees_in_training
  FROM user_credentials uc
  LEFT JOIN supervisors sup ON sup.id = uc.id
  LEFT JOIN supervisors psup ON psup.id = sup.primary_supervisor_id
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
  const existing = await db.query("SELECT id FROM cohorts WHERE name = $1", [name]);
  if (existing.rows.length) return existing.rows[0].id;
  const created = await db.query("INSERT INTO cohorts (name) VALUES ($1) RETURNING id", [name]);
  return created.rows[0].id;
}

/**
 * Enforces the required Supervisor hierarchy: exactly 1 Primary Supervisor
 * with up to 2 Supervisors in Training reporting directly to it (never to
 * each other). Returns { supervisorType, primarySupervisorId } on success,
 * or { error } with an HTTP status to send back. `excludeSupervisorId` is
 * used on update, so a Primary being edited doesn't count itself as its
 * own trainee-limit check.
 */
async function validateSupervisorHierarchy(db, rawType, rawPrimaryId, excludeSupervisorId) {
  const supervisorType = rawType === "in_training" ? "in_training" : "primary";

  if (supervisorType === "primary") {
    return { supervisorType, primarySupervisorId: null };
  }

  const primarySupervisorId = parseIdParam(rawPrimaryId);
  if (!primarySupervisorId) {
    return { status: 400, error: "A Supervisor in Training must be assigned to a Primary Supervisor" };
  }

  const { rows } = await db.query(
    "SELECT id, supervisor_type FROM supervisors WHERE id = $1",
    [primarySupervisorId]
  );
  if (!rows.length || rows[0].supervisor_type !== "primary") {
    return { status: 400, error: "primarySupervisorId must refer to an existing Primary Supervisor" };
  }

  const countParams = [primarySupervisorId];
  let countQuery = "SELECT COUNT(*) AS n FROM supervisors WHERE primary_supervisor_id = $1";
  if (excludeSupervisorId) {
    countParams.push(excludeSupervisorId);
    countQuery += " AND id != $2";
  }
  const { rows: countRows } = await db.query(countQuery, countParams);
  if (Number(countRows[0].n) >= 2) {
    return {
      status: 409,
      error: "This Primary Supervisor already has 2 Supervisors in Training assigned -- the hierarchy allows exactly 2.",
    };
  }

  return { supervisorType, primarySupervisorId };
}

// ---- Accounts (Students + Supervisors) ---------------------------------

// POST /api/admin/users
// Creates a Student or Supervisor account. Admin accounts are never
// created through this route -- there is exactly one, seeded directly in
// the database, per the "one static Admin account" requirement.
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
      supervisorType,
      primarySupervisorId,
    } = req.body || {};

    if (!full_name || !String(full_name).trim()) {
      return res.status(400).json({ error: "Full name is required" });
    }

    const allowedRoles = ["trainee", "supervisor"];
    if (role === "admin") {
      return res.status(400).json({
        error: "Admin accounts can't be created here. The admin account is fixed and seeded separately.",
      });
    }
    const finalRole = allowedRoles.includes(role) ? role : "trainee";

    let hierarchy = { supervisorType: "primary", primarySupervisorId: null };
    if (finalRole === "supervisor") {
      hierarchy = await validateSupervisorHierarchy(db, supervisorType, primarySupervisorId);
      if (hierarchy.error) return res.status(hierarchy.status).json({ error: hierarchy.error });
    }

    if (email) {
      const emailCol = finalRole === "trainee" ? "students" : "supervisors";
      const existing = await db.query(`SELECT id FROM ${emailCol} WHERE email = $1`, [email]);
      if (existing.rows.length) return res.status(409).json({ error: "That email is already in use" });
    }

    let memberCode;
    if (manualCode && String(manualCode).trim()) {
      memberCode = String(manualCode).trim().toUpperCase();
      const taken = await db.query("SELECT id FROM user_credentials WHERE member_code = $1", [memberCode]);
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
       VALUES ($1, $2, $3, TRUE) RETURNING id`,
      [memberCode, passwordHash, finalRole]
    );
    const newId = credInsert.rows[0].id;

    if (finalRole === "trainee") {
      const cohortId = await resolveCohortId(db, cohort);
      await db.query(
        `INSERT INTO students (id, full_name, email, cohort_id, current_year)
         VALUES ($1, $2, $3, $4, $5)`,
        [newId, full_name.trim(), email || null, cohortId, currentYear || null]
      );
    } else {
      await db.query(
        `INSERT INTO supervisors (id, full_name, email, supervisor_type, primary_supervisor_id) VALUES ($1, $2, $3, $4, $5)`,
        [newId, full_name.trim(), email || null, hierarchy.supervisorType, hierarchy.primarySupervisorId]
      );
    }

    // Every account gets baseline settings/privacy rows so those pages
    // never have to special-case "row doesn't exist yet."
    await db.query("INSERT INTO settings (user_id) VALUES ($1)", [newId]);
    await db.query("INSERT INTO privacy_preferences (user_id) VALUES ($1)", [newId]);
    if (finalRole === "trainee") {
      await db.query("INSERT INTO payments (student_id, total_fee_cents) VALUES ($1, 0)", [newId]);
    }

    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES ($1, 'account_created', 'user_credentials', $2)",
      [req.user.id, newId]
    );

    const { rows } = await db.query(`${USER_SELECT} WHERE uc.id = $1`, [newId]);

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

    const clauses = ["uc.role != 'admin'"]; // this list is Students + Supervisors only
    const params = [];

    if (search) {
      params.push(`%${search}%`);
      clauses.push(
        `(COALESCE(sup.full_name, st.full_name) ILIKE $${params.length} OR uc.member_code ILIKE $${params.length})`
      );
    }
    if (role && ["trainee", "supervisor"].includes(role)) {
      params.push(role);
      clauses.push(`uc.role = $${params.length}`);
    }
    if (status && ["active", "suspended"].includes(status)) {
      params.push(status);
      clauses.push(`uc.status = $${params.length}`);
    }

    const where = `WHERE ${clauses.join(" AND ")}`;
    const limit = Math.min(Number(pageSize) || 25, 100);
    const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;

    params.push(limit, offset);
    const { rows } = await db.query(
      `${USER_SELECT} ${where} ORDER BY uc.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const countParams = params.slice(0, params.length - 2);
    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) AS total FROM user_credentials uc
       LEFT JOIN supervisors sup ON sup.id = uc.id
       LEFT JOIN students st ON st.id = uc.id
       ${where}`,
      countParams
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

    const { rows } = await db.query(`${USER_SELECT} WHERE uc.id = $1`, [id]);
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
      "SELECT id, role, status FROM user_credentials WHERE id = $1",
      [id]
    );
    const existing = existingRows[0];
    if (!existing) return res.status(404).json({ error: "Account not found" });

    const {
      cohort,
      currentYear,
      status,
      supervisorIds,
      fullName,
      email,
      phone,
      supervisorType,
      primarySupervisorId,
    } = req.body || {};
    const allowedStatus = ["active", "suspended"];

    if (status !== undefined && !allowedStatus.includes(status)) {
      return res.status(400).json({ error: "Status must be 'active' or 'suspended'" });
    }
    if (status !== undefined) {
      await db.query("UPDATE user_credentials SET status = $1, updated_at = now() WHERE id = $2", [status, id]);
    }

    if (existing.role === "supervisor" && supervisorType !== undefined) {
      if (supervisorType === "primary") {
        const { rows: dependents } = await db.query(
          "SELECT id FROM supervisors WHERE primary_supervisor_id = $1 LIMIT 1",
          [id]
        );
        if (dependents.length) {
          return res.status(409).json({
            error: "Can't change this Primary Supervisor to Supervisor in Training while they still have Supervisors in Training assigned to them. Reassign those first.",
          });
        }
        await db.query(
          "UPDATE supervisors SET supervisor_type = 'primary', primary_supervisor_id = NULL, updated_at = now() WHERE id = $1",
          [id]
        );
      } else {
        const hierarchy = await validateSupervisorHierarchy(db, supervisorType, primarySupervisorId, id);
        if (hierarchy.error) return res.status(hierarchy.status).json({ error: hierarchy.error });
        if (Number(primarySupervisorId) === id) {
          return res.status(400).json({ error: "A supervisor can't be their own Primary Supervisor" });
        }
        await db.query(
          "UPDATE supervisors SET supervisor_type = 'in_training', primary_supervisor_id = $1, updated_at = now() WHERE id = $2",
          [hierarchy.primarySupervisorId, id]
        );
      }
    }

    const profileTable = existing.role === "trainee" ? "students" : "supervisors";
    const profileUpdates = [];
    const profileParams = [];
    if (fullName !== undefined) {
      profileParams.push(fullName);
      profileUpdates.push(`full_name = $${profileParams.length}`);
    }
    if (email !== undefined) {
      profileParams.push(email || null);
      profileUpdates.push(`email = $${profileParams.length}`);
    }
    if (phone !== undefined) {
      profileParams.push(phone || null);
      profileUpdates.push(`phone = $${profileParams.length}`);
    }
    if (existing.role === "trainee" && currentYear !== undefined) {
      profileParams.push(currentYear || null);
      profileUpdates.push(`current_year = $${profileParams.length}`);
    }
    if (existing.role === "trainee" && cohort !== undefined) {
      const cohortId = await resolveCohortId(db, cohort);
      profileParams.push(cohortId);
      profileUpdates.push(`cohort_id = $${profileParams.length}`);
    }
    if (profileUpdates.length) {
      profileParams.push(id);
      await db.query(
        `UPDATE ${profileTable} SET ${profileUpdates.join(", ")}, updated_at = now() WHERE id = $${profileParams.length}`,
        profileParams
      );
    }

    if (existing.role === "trainee" && Array.isArray(supervisorIds)) {
      await db.query("DELETE FROM supervisor_students WHERE student_id = $1", [id]);
      for (const supId of supervisorIds) {
        await db.query(
          "INSERT INTO supervisor_students (supervisor_id, student_id, assigned_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
          [supId, id, req.user.id]
        );
      }
    }

    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES ($1, 'account_updated', 'user_credentials', $2)",
      [req.user.id, id]
    );

    const { rows } = await db.query(`${USER_SELECT} WHERE uc.id = $1`, [id]);
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

    const { rowCount } = await db.query(
      "UPDATE user_credentials SET status = $1, updated_at = now() WHERE id = $2",
      [status, id]
    );
    if (!rowCount) return res.status(404).json({ error: "Account not found" });

    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES ($1, $2, 'user_credentials', $3)",
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

    const { rows } = await db.query("SELECT member_code FROM user_credentials WHERE id = $1", [id]);
    if (!rows.length) return res.status(404).json({ error: "Account not found" });

    const tempPassword = generateTempPassword();
    const passwordHash = await hashPassword(tempPassword);

    await db.query(
      "UPDATE user_credentials SET password_hash = $1, must_change_password = TRUE, updated_at = now() WHERE id = $2",
      [passwordHash, id]
    );
    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES ($1, 'password_reset_by_admin', 'user_credentials', $2)",
      [req.user.id, id]
    );

    res.json({ success: true, memberCode: rows[0].member_code, tempPassword });
  })
);

// DELETE /api/admin/users/:id
// Attempts a REAL delete (not a cosmetic status flip). The schema blocks
// this with a foreign key violation (Postgres error 23503) if the account
// has any history that must be preserved permanently -- sessions, hours,
// payments recorded, etc. When that happens, this returns a clear 409
// telling the admin to suspend instead. An account with zero history
// (e.g. created by mistake) deletes cleanly. This was reproduced and
// verified live while validating the schema.
router.delete(
  "/users/:id",
  asyncRoute(async (req, res, db) => {
    const id = parseIdParam(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid account id" });
    const force = req.query.force === "true";

    const { rows } = await db.query("SELECT id, role FROM user_credentials WHERE id = $1", [id]);
    if (!rows.length) return res.status(404).json({ error: "Account not found" });
    const targetRole = rows[0].role;

    // Payment transactions are a financial audit trail and are never
    // force-deletable, for anyone, regardless of role -- this is a hard
    // boundary, not a preference.
    const { rows: paymentRows } = await db.query(
      "SELECT 1 FROM payment_transactions WHERE added_by = $1 LIMIT 1",
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
      // deleting them would silently destroy other students' real
      // training records, which is exactly the data-loss bug this
      // schema's RESTRICT constraints exist to prevent. Force delete is
      // therefore only offered for students, whose own history is
      // self-contained to their own account.
      return res.status(409).json({
        error: "Force delete isn't available for supervisor or admin accounts with recorded history -- their records belong to other people's training history too. Suspend the account instead.",
      });
    }

    if (force && targetRole === "trainee") {
      // Students can send chat messages (messages.sender_id has no
      // cascade), which is the one realistic blocker for a student
      // account. Everything else about a student (sessions, attendance,
      // hours, assignments, documents, payments, evaluations, notes) is
      // already ON DELETE CASCADE via student_id and will be removed
      // automatically by the DELETE below.
      await db.query("DELETE FROM messages WHERE sender_id = $1", [id]);
    }

    try {
      await db.query("DELETE FROM user_credentials WHERE id = $1", [id]);
    } catch (err) {
      if (err.code === "23503") {
        return res.status(409).json({
          error: force
            ? "This account still has protected history that can't be force-deleted. Suspend it instead."
            : "This account has recorded history (sessions, hours, payments, or messages) and can't be deleted. Suspend it instead, or use permanent delete if you specifically need to erase this student's data.",
        });
      }
      throw err;
    }

    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, new_values) VALUES ($1, $2, 'user_credentials', $3, $4)",
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
// what the Admin/Supervisor/Student dashboards all already call. Two
// endpoints doing the same thing is a maintenance trap waiting to diverge.

// ---- Student Profiles (full detail view, admin-only) --------------------
// Unlike routes/supervisor.js's GET /students/:id, this has NO
// supervisor_students assignment check -- Admin can view ANY student's
// complete profile, not just ones they're personally assigned to.

// GET /api/admin/students/:id/profile
router.get(
  "/students/:id/profile",
  asyncRoute(async (req, res, db) => {
    const id = parseIdParam(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid student id" });

    const { rows: userRows } = await db.query(`${USER_SELECT} WHERE uc.id = $1 AND uc.role = 'trainee'`, [id]);
    if (!userRows.length) return res.status(404).json({ error: "Student not found" });
    const profile = toProfileResponse(userRows[0]);

    const { rows: recordRows } = await db.query(buildRecordsQuery(null), [id]);
    const supIds = [...new Set(recordRows.map((r) => r.supervisor_id))];
    let supNames = {};
    if (supIds.length) {
      const { rows: supRows } = await db.query("SELECT id, full_name FROM supervisors WHERE id = ANY($1)", [supIds]);
      supRows.forEach((r) => (supNames[r.id] = r.full_name));
    }
    const records = recordRows.map((r) => toRecord({ ...r, supervisor_name: supNames[r.supervisor_id] }));

    const { rows: documentRows } = await db.query(
      `SELECT d.*, COALESCE(a.full_name, sup.full_name) AS uploaded_by_name FROM documents d
       LEFT JOIN admin_users a ON a.id = d.uploaded_by
       LEFT JOIN supervisors sup ON sup.id = d.uploaded_by
       WHERE d.student_id = $1 ORDER BY d.created_at DESC`,
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

    res.json({
      profile,
      records,
      documents,
      progress,
      payment,
      paymentTransactions: transactions.map(toPaymentTransaction),
    });
  })
);

// DELETE /api/admin/documents/:id
// Removes a student document -- both the DB row AND the file on disk.
// Works for any student's document, no assignment restriction (Admin-wide).
router.delete(
  "/documents/:id",
  asyncRoute(async (req, res, db) => {
    const id = parseIdParam(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid document id" });

    const { rows } = await db.query("SELECT filename FROM documents WHERE id = $1", [id]);
    if (!rows.length) return res.status(404).json({ error: "Document not found" });

    await db.query("DELETE FROM documents WHERE id = $1", [id]);

    const filePath = path.join(__dirname, "../../uploads/documents", rows[0].filename);
    fs.unlink(filePath, (err) => {
      // A missing file on disk shouldn't fail the request -- the DB row
      // (the source of truth for "does this document exist") is already
      // gone; log and move on rather than leaving an orphaned DB state.
      if (err && err.code !== "ENOENT") console.error("Failed to delete document file:", err);
    });

    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES ($1, 'document_deleted', 'documents', $2)",
      [req.user.id, id]
    );

    res.json({ success: true });
  })
);

// NOTE: Event management used to live here (upload-image, GET/POST/PUT/
// DELETE /events). It has been moved to routes/designer.js, scoped to
// `created_by = <the calling designer>` -- Admin no longer has any Event
// read/write access, enforced at the route level (requireDesigner), not
// just hidden in the UI. The public site reads events via the new
// unauthenticated routes/events.js (mounted at /api/events).

// ---- Designers (account management) --------------------------------------
// Deliberately NOT folded into USER_SELECT/toPublicUser above -- those are
// built around the students/supervisors profile-table join and reused by
// the existing Students/Supervisors admin UI. Designers are a distinct,
// much simpler profile shape, so this is a small parallel set of routes
// rather than retrofitting the shared query. Suspend/activate, password
// reset, and delete for a designer account already work via the existing
// role-agnostic /users/:id/status, /users/:id/reset-password, and
// /users/:id routes below -- no need to duplicate those here.

const DESIGNER_SELECT = `
  SELECT uc.id, uc.member_code, uc.role, uc.status, uc.must_change_password, uc.created_at,
         d.full_name, d.email, d.phone, d.photo
  FROM user_credentials uc
  JOIN designers d ON d.id = uc.id
`;

// POST /api/admin/designers  { full_name, email?, memberCode?, tempPassword? }
router.post(
  "/designers",
  asyncRoute(async (req, res, db) => {
    const { full_name, email, tempPassword, memberCode: manualCode } = req.body || {};

    if (!full_name || !String(full_name).trim()) {
      return res.status(400).json({ error: "Full name is required" });
    }

    if (email) {
      const existing = await db.query("SELECT id FROM designers WHERE email = $1", [email]);
      if (existing.rows.length) return res.status(409).json({ error: "That email is already in use" });
    }

    let memberCode;
    if (manualCode && String(manualCode).trim()) {
      memberCode = String(manualCode).trim().toUpperCase();
      const taken = await db.query("SELECT id FROM user_credentials WHERE member_code = $1", [memberCode]);
      if (taken.rows.length) return res.status(409).json({ error: `ID "${memberCode}" is already in use` });
    } else {
      memberCode = await generateNextId(db, "DES");
    }

    const plainTempPassword =
      tempPassword && String(tempPassword).length >= 8 ? tempPassword : generateTempPassword();
    const passwordHash = await hashPassword(plainTempPassword);

    const credInsert = await db.query(
      `INSERT INTO user_credentials (member_code, password_hash, role, must_change_password)
       VALUES ($1, $2, 'designer', TRUE) RETURNING id`,
      [memberCode, passwordHash]
    );
    const newId = credInsert.rows[0].id;

    await db.query(`INSERT INTO designers (id, full_name, email) VALUES ($1, $2, $3)`, [
      newId,
      full_name.trim(),
      email || null,
    ]);

    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES ($1, 'account_created', 'user_credentials', $2)",
      [req.user.id, newId]
    );

    const { rows } = await db.query(`${DESIGNER_SELECT} WHERE uc.id = $1`, [newId]);
    res.status(201).json({
      designer: toPublicUser(rows[0]),
      memberCode,
      tempPassword: plainTempPassword,
    });
  })
);

// GET /api/admin/designers
router.get(
  "/designers",
  asyncRoute(async (req, res, db) => {
    const { rows } = await db.query(`${DESIGNER_SELECT} ORDER BY uc.id DESC`);
    res.json({ designers: rows.map(toPublicUser) });
  })
);

// ---- Payments (financial ledger, admin-managed) -------------------------
// Every query below runs inside asyncRoute's transactional client, which
// has already run `SET LOCAL app.user_role = 'admin'` for this request --
// required for these tables' Row-Level Security policies to grant access
// at all. Verified live: without that session variable set, these queries
// silently return zero rows instead of erroring.

async function getPaymentsRow(db, studentId) {
  const { rows } = await db.query("SELECT * FROM payments WHERE student_id = $1", [studentId]);
  return rows[0] || null;
}
async function getTransactions(db, studentId) {
  const { rows } = await db.query(
    `SELECT pt.*, uc.member_code AS added_by_code, COALESCE(a.full_name, sup.full_name) AS added_by_name
     FROM payment_transactions pt
     JOIN user_credentials uc ON uc.id = pt.added_by
     LEFT JOIN admin_users a ON a.id = pt.added_by
     LEFT JOIN supervisors sup ON sup.id = pt.added_by
     WHERE pt.student_id = $1
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
  await db.query("UPDATE payments SET status = $1, updated_at = now() WHERE student_id = $2", [status, studentId]);
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
      params.push(`%${search}%`);
      where = `WHERE st.full_name ILIKE $1 OR uc.member_code ILIKE $1`;
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
      "SELECT uc.id, uc.member_code, st.full_name FROM user_credentials uc JOIN students st ON st.id = uc.id WHERE uc.id = $1",
      [studentId]
    );
    if (!rows.length) return res.status(404).json({ error: "Student not found" });

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

    const { rows: studentRows } = await db.query("SELECT id FROM students WHERE id = $1", [studentId]);
    if (!studentRows.length) return res.status(404).json({ error: "Student not found" });

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
        `UPDATE payments SET total_fee_cents = $1, discount_cents = $2, payment_plan = $3, next_due_date = $4, updated_at = now()
         WHERE student_id = $5`,
        [totalFeeCents, discountCents, paymentPlan, nextDueDate, studentId]
      );
    } else {
      await db.query(
        `INSERT INTO payments (student_id, total_fee_cents, discount_cents, payment_plan, next_due_date)
         VALUES ($1, $2, $3, $4, $5)`,
        [studentId, totalFeeCents, discountCents, paymentPlan, nextDueDate]
      );
    }

    const { paymentsRow, transactions } = await recomputeStoredStatus(db, studentId);
    const { rows: nameRows } = await db.query(
      "SELECT uc.member_code, st.full_name FROM user_credentials uc JOIN students st ON st.id = uc.id WHERE uc.id = $1",
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

    const { rows: studentRows } = await db.query("SELECT id FROM students WHERE id = $1", [studentId]);
    if (!studentRows.length) return res.status(404).json({ error: "Student not found" });

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
       WHERE student_id = $1 AND amount_cents = $2 AND payment_date = $3 AND COALESCE(method,'') = COALESCE($4,'')
         AND created_at >= now() - interval '10 seconds'`,
      [studentId, amountCents, date, method || null]
    );
    if (dupeRows.length) {
      return res.status(409).json({
        error: "This looks like a duplicate of a payment just submitted. Refresh and check the history before retrying.",
      });
    }

    await db.query(
      `INSERT INTO payment_transactions (student_id, amount_cents, transaction_type, payment_date, method, added_by, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [studentId, amountCents, amountCents < 0 ? "refund" : "payment", date, method || null, req.user.id, notes || null]
    );
    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, new_values) VALUES ($1, 'payment_recorded', 'payment_transactions', $2, $3)",
      [req.user.id, studentId, JSON.stringify({ amountCents, date, method })]
    );

    const { paymentsRow, transactions } = await recomputeStoredStatus(db, studentId);
    const { rows: nameRows } = await db.query(
      "SELECT uc.member_code, st.full_name FROM user_credentials uc JOIN students st ON st.id = uc.id WHERE uc.id = $1",
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