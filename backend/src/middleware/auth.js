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
      "SELECT id, role, status, must_change_password, member_code FROM user_credentials WHERE id = ?",
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
const requireDesigner = requireRole("designer");

/**
 * Loads the calling user's own Master Trainer row (must be
 * supervisor_type='primary'), attaches req.masterTrainer = { id, groupId,
 * fullName }, or responds 403/404. Moved here (was previously local to
 * Mastertrainer.js) so other route files -- e.g. chatRooms.js -- can reuse
 * the exact same permission check instead of duplicating it.
 */
async function requireMasterTrainer(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT sup.id, sup.full_name, sup.group_id, sup.supervisor_type
         FROM supervisors sup
        WHERE sup.id = ?`,
      [req.user.id]
    );
    if (!rows.length || rows[0].supervisor_type !== "primary") {
      return res.status(403).json({ error: "Master Trainer access only" });
    }
    req.masterTrainer = { id: rows[0].id, groupId: rows[0].group_id, fullName: rows[0].full_name };
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Wraps a route handler in its own MySQL transaction. Commits on success,
 * rolls back and forwards to the error handler on any thrown error.
 *
 * Usage: router.get("/x", requireAuth, requireAdmin, asyncRoute(async (req, res, db) => { ... }));
 * `db` is the transactional client -- use it instead of importing `pool`
 * directly inside route handlers so multi-statement writes stay atomic.
 * Authorization (who's allowed to do this) is enforced by the middleware
 * chain in front of this (requireAuth/requireAdmin/requireSupervisor) and
 * by explicit WHERE/caseload checks inside each handler -- MySQL has no
 * Row-Level Security to lean on the way the previous Postgres schema did.
 */
function asyncRoute(handler) {
  return async (req, res, next) => {
    let client;
    // Every handler calls res.json(...) directly as part of doing its
    // work -- previously that sent the HTTP response immediately, with
    // commitAndRelease() only running afterward. That left a real (if
    // narrow, sub-millisecond-to-a-few-ms) window where a client could be
    // told "success" and immediately read back stale data, because the
    // transaction hadn't actually committed yet. Intercepting res.json
    // here holds the real send until after commit succeeds, making
    // "the client is told it worked" and "it's actually durable" atomic,
    // with no change needed in any individual route handler. This also
    // fixes a second latent bug for free: if commitAndRelease() itself
    // threw, the old code had already sent a success response, so the
    // catch block's next(err) would crash with ERR_HTTP_HEADERS_SENT
    // instead of the client ever seeing the failure.
    const originalJson = res.json.bind(res);
    let pendingBody;
    let responded = false;
    res.json = (body) => {
      pendingBody = body;
      responded = true;
      return res;
    };
    try {
      client = await getRequestClient();
      await handler(req, res, client);
      await commitAndRelease(client);
      if (responded) originalJson(pendingBody);
    } catch (err) {
      if (client) await rollbackAndRelease(client);
      res.json = originalJson;
      next(err);
    }
  };
}

module.exports = { requireAuth, requireAdmin, requireSupervisor, requireDesigner, requireRole, requireMasterTrainer, asyncRoute };
