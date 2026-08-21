const mysql = require("mysql2/promise");
const config = require("./config");

const pool = mysql.createPool({
  uri: config.db.connectionString,
  waitForConnections: true,
  connectionLimit: 10,
  // Without this, mysql2 auto-converts DATE columns to JS Date objects in
  // the caller's local timezone, which then serializes to a shifted
  // calendar date over JSON for anyone not in UTC (a DATE column has no
  // timezone of its own). Every route in this codebase already treats
  // date/datetime columns as plain strings (e.g. new Date(row.created_at)
  // is only ever called client-side, in the browser), so keeping them as
  // strings here matches what the rest of the app already expects.
  dateStrings: true,
  // Every BOOLEAN column in the schema is actually TINYINT(1), and mysql2
  // returns TINYINT as a plain JS number (0/1) by default -- node-postgres
  // returned real true/false for its BOOLEAN columns, and the whole app
  // (route responses, `mustChangePassword: user.must_change_password`,
  // JSON sent to the frontend) was written expecting that. Casting
  // TINYINT(1) to a real boolean here, once, means no route or frontend
  // code needs to change to keep working the same way it did under
  // Postgres.
  typeCast: (field, next) => {
    if (field.type === "TINY" && field.length === 1) {
      const value = field.string();
      return value === null ? null : value === "1";
    }
    return next();
  },
});

pool.on("error", (err) => {
  // A background/idle connection emitted an error -- log and let the pool
  // recycle it. Do NOT crash the process over a single dropped connection.
  console.error("Unexpected MySQL pool error", err);
});

/**
 * Wraps a raw mysql2 connection/pool so callers can keep using
 * `const { rows } = await db.query(sql, params)`, the same shape
 * node-postgres returned. mysql2 natively returns `[rows, fields]` for
 * SELECT (rows is an array) but `[ResultSetHeader, undefined]` for
 * INSERT/UPDATE/DELETE (insertId/affectedRows/changedRows, no array of
 * rows at all) -- this normalizes both into one shape:
 *   SELECT               -> { rows: [...], insertId: undefined, affectedRows: undefined }
 *   INSERT/UPDATE/DELETE  -> { rows: [], insertId, affectedRows, changedRows }
 * MySQL has no RETURNING clause, so every call site that used to read
 * `rows[0].id` off an `INSERT ... RETURNING id` now reads `insertId`
 * instead (see route files for the actual conversions).
 */
function wrap(connOrPool) {
  return {
    query: async (sql, params) => {
      const [result] = await connOrPool.query(sql, params);
      if (Array.isArray(result)) {
        return { rows: result };
      }
      return {
        rows: [],
        insertId: result.insertId,
        affectedRows: result.affectedRows,
        changedRows: result.changedRows,
      };
    },
    // Only present on a transactional client (see getRequestClient) --
    // route code should never need this directly, but asyncRoute does.
    _raw: connOrPool,
  };
}

/**
 * Checks out a dedicated connection from the pool and starts a
 * transaction on it. There is no Row-Level Security equivalent in MySQL
 * (and Hostinger's shared MySQL wouldn't support one if there were) --
 * authorization is enforced entirely at the Express route layer
 * (requireAuth/requireAdmin/requireSupervisor middleware, plus explicit
 * caseload-membership checks in the query itself). That was already true
 * even under the previous Postgres+RLS design, which documented RLS as
 * "additional... not a replacement for application-level checks" -- so
 * removing it here doesn't change any actual access-control behavior.
 */
async function getRequestClient() {
  const conn = await pool.getConnection();
  await conn.beginTransaction();
  return wrap(conn);
}

async function commitAndRelease(client) {
  try {
    await client._raw.commit();
  } finally {
    client._raw.release();
  }
}

async function rollbackAndRelease(client) {
  try {
    await client._raw.rollback();
  } catch (err) {
    // ignore -- connection may already be dead
  } finally {
    client._raw.release();
  }
}

module.exports = { pool: wrap(pool), getRequestClient, commitAndRelease, rollbackAndRelease };
