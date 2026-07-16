const db = require("../../db");
const { verifyToken } = require("../utils/authUtils");

/**
 * Requires a valid "Authorization: Bearer <token>" header.
 * Loads the fresh user row from the DB (not just the JWT payload) so that
 * a suspended/deleted account is rejected immediately, even with a
 * still-valid token.
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ error: "Missing or malformed Authorization header" });
  }

  let payload;
  try {
    payload = verifyToken(token);
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(payload.sub);
  if (!user) {
    return res.status(401).json({ error: "Account no longer exists" });
  }
  if (user.status !== "active") {
    return res.status(403).json({ error: "Account is suspended" });
  }

  req.user = user; // full DB row, password_hash included — never send this back as-is
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

// Admins are allowed everywhere a supervisor is, since they oversee the
// whole program; a plain trainee can never reach supervisor routes.
function requireSupervisor(req, res, next) {
  if (!req.user || !["supervisor", "admin"].includes(req.user.role)) {
    return res.status(403).json({ error: "Supervisor access required" });
  }
  next();
}

/**
 * Loads :studentId from the route, confirms it's an active trainee, and
 * confirms the logged-in supervisor is actually assigned to them (admins
 * bypass the assignment check). This is what keeps a supervisor from ever
 * touching a student who isn't theirs.
 */
function requireAssignedStudent(req, res, next) {
  const db = require("../../db");
  const studentId = Number(req.params.studentId);

  const student = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'trainee'").get(studentId);
  if (!student) {
    return res.status(404).json({ error: "Student not found" });
  }

  if (req.user.role !== "admin") {
    const assigned = db
      .prepare("SELECT 1 FROM user_supervisors WHERE user_id = ? AND supervisor_id = ?")
      .get(studentId, req.user.id);
    if (!assigned) {
      return res.status(403).json({ error: "You are not assigned to this student" });
    }
  }

  req.student = student;
  next();
}

module.exports = { requireAuth, requireAdmin, requireSupervisor, requireAssignedStudent };