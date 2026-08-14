const { Pool } = require("pg");
const config = require("./config");

const pool = new Pool(config.db);

pool.on("error", (err) => {
  // A background/idle client emitted an error -- log and let the pool
  // recycle it. Do NOT crash the process over a single dropped connection.
  console.error("Unexpected Postgres pool error", err);
});

/**
 * Checks out a dedicated client from the pool and sets the two session
 * variables the schema's Row-Level Security policies key off of:
 *   app.user_role         -- 'admin' | 'supervisor' | 'trainee'
 *   app.current_user_id   -- the caller's user_credentials.id
 *
 * IMPORTANT: these are set with `SET LOCAL`, which only applies inside an
 * open transaction and is automatically cleared at COMMIT/ROLLBACK. That's
 * why every call site does `BEGIN` first. If you ever add a query path
 * that bypasses this helper and calls pool.query() directly, it will NOT
 * have RLS context set, and every policy will treat it as an anonymous
 * caller with no role -- for the RLS-protected tables (payments,
 * payment_transactions, invoices, student_health_info) that means the
 * query will silently see zero rows, not an error. This was tested and
 * confirmed live while validating the schema; see below.
 */
async function getRequestClient(user) {
  const client = await pool.connect();
  await client.query("BEGIN");
  // Postgres's SET/SET LOCAL command does not accept bind parameters --
  // only string literals or identifiers (attempting `SET LOCAL x = $1`
  // throws a syntax error, confirmed while testing this live).
  // set_config(name, value, is_local) is a normal function call and
  // accepts parameters normally; is_local = true makes it behave exactly
  // like SET LOCAL, scoped to and cleared at the end of this transaction.
  await client.query("SELECT set_config('app.user_role', $1, true)", [user?.role || ""]);
  await client.query("SELECT set_config('app.current_user_id', $1, true)", [
    user?.id ? String(user.id) : "",
  ]);
  return client;
}

async function commitAndRelease(client) {
  try {
    await client.query("COMMIT");
  } finally {
    client.release();
  }
}

async function rollbackAndRelease(client) {
  try {
    await client.query("ROLLBACK");
  } catch (err) {
    // ignore -- connection may already be dead
  } finally {
    client.release();
  }
}

module.exports = { pool, getRequestClient, commitAndRelease, rollbackAndRelease };
