const jwt = require("jsonwebtoken");
const config = require("../config");
const { pool, getRequestClient, commitAndRelease, rollbackAndRelease } = require("../db");

/**
 * Verifies the bearer token, then re-checks the account's live status in
 * the database (not just what the token claims) so a suspended account's
 * existing token stops working immediately rather than staying valid
 * until it expires.
 */
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Not authenticated" });

  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired session" });
  }

  try {
    const { rows } = await pool.query(
      "SELECT id, role, status, must_change_password, member_code FROM user_credentials WHERE id = $1",
      [payload.id]
    );
    const user = rows[0];
    if (!user) return res.status(401).json({ error: "Account no longer exists" });
    if (user.status !== "active") {
      return res.status(403).json({ error: "This account has been suspended. Contact your administrator." });
    }
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "You don't have permission to do that" });
    }
    next();
  };
}

const requireAdmin = requireRole("admin");
const requireSupervisor = requireRole("supervisor");

/**
 * Wraps a route handler in its own Postgres transaction with the RLS
 * session variables (app.user_role / app.current_user_id) set for the
 * calling user -- see db.js for why this matters. Commits on success,
 * rolls back and forwards to the error handler on any thrown error.
 *
 * Usage: router.get("/x", requireAuth, requireAdmin, asyncRoute(async (req, res, db) => { ... }));
 * `db` is the transactional client -- use it instead of importing `pool`
 * directly inside route handlers so RLS context is always correct.
 */
function asyncRoute(handler) {
  return async (req, res, next) => {
    let client;
    try {
      client = await getRequestClient(req.user);
      await handler(req, res, client);
      await commitAndRelease(client);
    } catch (err) {
      if (client) await rollbackAndRelease(client);
      next(err);
    }
  };
}

module.exports = { requireAuth, requireAdmin, requireSupervisor, requireRole, asyncRoute };
