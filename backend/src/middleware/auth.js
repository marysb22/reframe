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

// Admins are allowed everywhere a Master Trainer is, since they oversee the
// whole program; a plain Trainer can never reach Master Trainer routes.
function requireMasterTrainer(req, res, next) {
  if (!req.user || !["master_trainer", "admin"].includes(req.user.role)) {
    return res.status(403).json({ error: "Master Trainer access required" });
  }
  next();
}

// A Trainer is "assigned" to a Master Trainer either directly (self-service
// trainer_master_trainers link) or via a shared Group -- the Master
// Trainer/TOT holds a group_leadership row for the Group the Trainer
// belongs to (users.group_id).
function isTrainerAssignedToMasterTrainer(trainerId, masterTrainerId) {
  const direct = db
    .prepare("SELECT 1 FROM trainer_master_trainers WHERE trainer_id = ? AND master_trainer_id = ?")
    .get(trainerId, masterTrainerId);
  if (direct) return true;

  const viaGroup = db
    .prepare(
      `SELECT 1 FROM users t
       JOIN group_leadership gl ON gl.group_id = t.group_id
       WHERE t.id = ? AND gl.master_trainer_id = ?`
    )
    .get(trainerId, masterTrainerId);
  return !!viaGroup;
}

/**
 * Loads :trainerId from the route, confirms it's an active Trainer, and
 * confirms the logged-in Master Trainer is actually assigned to them --
 * directly or through a shared Group (admins bypass the assignment check).
 * This is what keeps a Master Trainer from ever touching a Trainer who
 * isn't theirs.
 */
function requireAssignedTrainer(req, res, next) {
  const trainerId = Number(req.params.trainerId);

  const trainer = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'trainer'").get(trainerId);
  if (!trainer) {
    return res.status(404).json({ error: "Trainer not found" });
  }

  if (req.user.role !== "admin" && !isTrainerAssignedToMasterTrainer(trainerId, req.user.id)) {
    return res.status(403).json({ error: "You are not assigned to this trainer" });
  }

  req.trainer = trainer;
  next();
}

module.exports = {
  requireAuth,
  requireAdmin,
  requireMasterTrainer,
  requireAssignedTrainer,
  isTrainerAssignedToMasterTrainer,
};
