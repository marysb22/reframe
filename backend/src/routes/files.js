// Authenticated, ownership-checked file serving. Previously every upload
// (documents, CVs, chat attachments, assignment submissions, learning
// materials) was served by a plain express.static mount with zero
// authentication -- anyone who obtained a URL (leaked link, browser
// history, a screenshot) had permanent, unrevocable access to a private
// file. This replaces that for every upload type EXCEPT event images,
// which stay genuinely public (they're shown on the public marketing
// site, which requires no login at all).
//
// A browser <img src>/<a href> can't attach a custom Authorization
// header, so the token is also accepted as a `?token=` query parameter --
// the same JWT the app already issues at login, just carried differently
// for this one class of request. It still expires on the app's normal
// 12-hour schedule and still re-checks the account's live status on every
// request, exactly like requireAuth.
const express = require("express");
const path = require("path");
const jwt = require("jsonwebtoken");
const config = require("../config");
const { pool } = require("../db");

const router = express.Router();

async function authenticateForFile(req, res, next) {
  const header = req.headers.authorization || "";
  const headerToken = header.startsWith("Bearer ") ? header.slice(7) : null;
  const token = headerToken || req.query.token;
  if (!token) return res.status(401).json({ error: "Not authenticated" });

  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired session" });
  }

  try {
    const { rows } = await pool.query("SELECT id, role, status FROM user_credentials WHERE id = ?", [payload.id]);
    const user = rows[0];
    if (!user || user.status !== "active") {
      return res.status(403).json({ error: "This account has been suspended. Contact your administrator." });
    }
    req.fileUser = user;
    next();
  } catch (err) {
    next(err);
  }
}

/** True if this supervisor (Master Trainer or ToT) currently has this
 *  trainee in their caseload -- a Master Trainer is always auto-linked to
 *  every trainee in their own group at group-creation time, so this same
 *  check also correctly covers their monitoring access, with no separate
 *  group_id-based path needed. */
async function isCaseloadMatch(supervisorId, studentId) {
  const { rows } = await pool.query(
    "SELECT 1 FROM supervisor_students WHERE supervisor_id = ? AND student_id = ?",
    [supervisorId, studentId]
  );
  return rows.length > 0;
}

// One authorizer per upload subfolder -- (user, filename) -> boolean.
// Each mirrors the exact same ownership/caseload rule already enforced by
// the route that lists or manages that file type elsewhere in the app.
const AUTHORIZERS = {
  // Profile photos are shown broadly as avatars across chat, group
  // rosters, and tables throughout the app for every role -- low
  // sensitivity, and a real per-file ownership check would break normal
  // identification UI. Any authenticated, active account may view any
  // photo; this still closes the "no login at all" gap.
  photos: async () => true,

  cv: async (user, filename) => {
    const { rows } = await pool.query("SELECT id FROM students WHERE cv_file = ?", [filename]);
    if (!rows.length) return false;
    const studentId = rows[0].id;
    if (user.role === "admin") return true;
    if (user.role === "trainee") return Number(user.id) === studentId;
    if (user.role === "supervisor") return isCaseloadMatch(user.id, studentId);
    return false;
  },

  documents: async (user, filename) => {
    const { rows } = await pool.query(
      "SELECT student_id, group_id, shared_with_supervisor_id, uploaded_by FROM documents WHERE filename = ?",
      [filename]
    );
    if (!rows.length) return false;
    const { student_id: studentId, group_id: groupId, shared_with_supervisor_id: sharedWithSupervisorId, uploaded_by: uploadedBy } = rows[0];
    if (user.role === "admin") return true;
    // The uploader can always reach their own file, regardless of who they
    // shared it with -- closes the gap a Trainee-uploaded, ToT-only-shared
    // document would otherwise fall into (matches neither branch below).
    if (Number(user.id) === Number(uploadedBy)) return true;
    if (user.role === "trainee") {
      // NULL student_id = shared with the whole group instead of one
      // trainee -- authorized if this trainee actually belongs to it.
      if (studentId) return Number(user.id) === studentId;
      if (!groupId) return false;
      const { rows: srows } = await pool.query("SELECT 1 FROM students WHERE id = ? AND group_id = ?", [user.id, groupId]);
      return srows.length > 0;
    }
    if (user.role === "supervisor") {
      // A Trainee -> ToT share: only the exact supervisor it was shared
      // with may access it -- never inferred from caseload or group.
      if (sharedWithSupervisorId) return Number(user.id) === Number(sharedWithSupervisorId);
      if (studentId) return isCaseloadMatch(user.id, studentId);
      if (!groupId) return false;
      const { rows: srows } = await pool.query("SELECT 1 FROM supervisors WHERE id = ? AND group_id = ?", [user.id, groupId]);
      return srows.length > 0;
    }
    return false;
  },

  materials: async (user, filename) => {
    // A row's cover_image is a second, independent filename (the Library
    // feature's book cover) -- matched here too, since it's served from
    // this same /uploads/materials/ folder.
    const { rows } = await pool.query(
      "SELECT material_type, supervisor_id, admin_id, student_id FROM learning_materials WHERE filename = ? OR cover_image = ?",
      [filename, filename]
    );
    if (!rows.length) return false;
    const { material_type: materialType, supervisor_id: supervisorId, admin_id: adminId, student_id: studentId } = rows[0];
    // Books (the standalone Library feature) have no per-student/caseload
    // targeting at all -- every authenticated user may read one, matching
    // the Library route's own "one shared list" rule.
    if (materialType === "book" || adminId) return true;
    if (user.role === "admin") return true;
    if (user.role === "supervisor") return Number(user.id) === supervisorId;
    if (user.role === "trainee") {
      // NULL student_id = shared with the whole caseload, not one specific
      // trainee -- authorized if this trainee is currently assigned to
      // the authoring supervisor.
      if (studentId) return Number(user.id) === studentId;
      return isCaseloadMatch(supervisorId, user.id);
    }
    return false;
  },

  submissions: async (user, filename) => {
    const { rows } = await pool.query(
      `SELECT a.student_id, a.supervisor_id FROM assignment_submissions s
       JOIN assignments a ON a.id = s.assignment_id WHERE s.filename = ?`,
      [filename]
    );
    if (!rows.length) return false;
    const { student_id: studentId, supervisor_id: supervisorId } = rows[0];
    if (user.role === "admin") return true;
    if (user.role === "trainee") return Number(user.id) === studentId;
    if (user.role === "supervisor") return Number(user.id) === supervisorId;
    return false;
  },

  assignments: async (user, filename) => {
    const { rows } = await pool.query(
      "SELECT student_id, supervisor_id FROM assignments WHERE attachment_filename = ?",
      [filename]
    );
    if (!rows.length) return false;
    const { student_id: studentId, supervisor_id: supervisorId } = rows[0];
    if (user.role === "admin") return true;
    if (user.role === "trainee") return Number(user.id) === studentId;
    if (user.role === "supervisor") return Number(user.id) === supervisorId;
    return false;
  },

  chat: async (user, filename) => {
    const { rows } = await pool.query("SELECT room_id FROM chat_room_messages WHERE attachment_filename = ?", [
      filename,
    ]);
    if (!rows.length) return false;
    if (user.role === "admin") return true;
    const { rows: memberRows } = await pool.query(
      "SELECT 1 FROM chat_room_members WHERE room_id = ? AND user_id = ?",
      [rows[0].room_id, user.id]
    );
    return memberRows.length > 0;
  },
};

// GET /uploads/preview-link?subfolder=X&filename=Y -- issues a short-lived,
// single-file signed link so an external renderer (Google Docs Viewer,
// which needs a URL its own servers can fetch with no session/cookie) can
// read one specific, already-authorized file without making it permanently
// public. Reuses the exact same per-subfolder authorization check as the
// private download route above -- this never grants access the private
// route wouldn't already allow, it only relays it to a URL a third party
// can reach for 5 minutes.
router.get("/preview-link", authenticateForFile, async (req, res) => {
  const { subfolder, filename } = req.query;
  if (!subfolder || !filename || !/^[A-Za-z0-9._-]+$/.test(filename)) {
    return res.status(400).json({ error: "Invalid request" });
  }
  const authorizer = AUTHORIZERS[subfolder];
  if (!authorizer) return res.status(404).json({ error: "Not found" });

  try {
    const allowed = await authorizer(req.fileUser, filename);
    if (!allowed) return res.status(403).json({ error: "You don't have access to this file" });
  } catch (err) {
    console.error("[files] preview-link authorization check failed:", err);
    return res.status(500).json({ error: "Internal server error" });
  }

  const token = jwt.sign({ purpose: "file-preview", subfolder, filename }, config.jwtSecret, { expiresIn: "5m" });
  res.json({ url: `/uploads/preview/${token}` });
});

// GET /uploads/preview/:token -- deliberately NOT behind authenticateForFile:
// this is the one URL a non-logged-in fetch (Google's own server) must be
// able to reach. The token itself carries and proves the authorization --
// signed, single-file-scoped, and expires in 5 minutes, so this never
// leaves a file permanently or broadly exposed.
router.get("/preview/:token", async (req, res) => {
  let payload;
  try {
    payload = jwt.verify(req.params.token, config.jwtSecret);
  } catch (err) {
    return res.status(403).json({ error: "This preview link is invalid or has expired" });
  }
  if (payload.purpose !== "file-preview" || !payload.subfolder || !payload.filename) {
    return res.status(403).json({ error: "This preview link is invalid" });
  }

  const filePath = path.join(config.uploadsDir, payload.subfolder, payload.filename);
  res.sendFile(filePath, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "File not found" });
  });
});

router.get("/:subfolder/:filename", authenticateForFile, async (req, res) => {
  const { subfolder, filename } = req.params;
  // multer only ever generates `<timestamp>-<hex><ext>` -- anything with a
  // path separator or ".." is not a real upload and must never be used to
  // build a filesystem path.
  if (!/^[A-Za-z0-9._-]+$/.test(filename)) {
    return res.status(400).json({ error: "Invalid filename" });
  }

  const authorizer = AUTHORIZERS[subfolder];
  if (!authorizer) return res.status(404).json({ error: "Not found" });

  try {
    const allowed = await authorizer(req.fileUser, filename);
    if (!allowed) return res.status(403).json({ error: "You don't have access to this file" });
  } catch (err) {
    console.error("[files] authorization check failed:", err);
    return res.status(500).json({ error: "Internal server error" });
  }

  // "private" (not "public") so only the requesting browser's own cache may
  // store this response -- it still skips re-downloading the same file on
  // every view within a day, without letting a shared/proxy cache serve one
  // user's private file to a different user who happens to guess the URL.
  res.set("Cache-Control", "private, max-age=86400");

  const filePath = path.join(config.uploadsDir, subfolder, filename);
  res.sendFile(filePath, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "File not found" });
  });
});

module.exports = router;
