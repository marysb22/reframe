/**
 * Atomically generates the next member_code for a given prefix (TTR, SUP,
 * ADM) using SELECT ... FOR UPDATE to lock the counter row for the
 * duration of the caller's transaction -- two concurrent "create student"
 * requests can't ever be handed the same ID, because the second request's
 * FOR UPDATE blocks until the first transaction commits or rolls back.
 *
 * NOTE ON PREFIXES: the old SQLite-era route file used "ST" for trainees.
 * Every other artifact in this project (the schema's seed data, the
 * Supervisor Dashboard's "assign student by ID" placeholder, the
 * validation audit) already uses "TTR" instead. Standardized on "TTR"
 * here to match the majority convention and the schema as shipped --
 * flagging in case "ST" was actually the intended standard and it's this
 * file that should change instead.
 *
 * Must be called with the request's transactional client (see
 * middleware/auth.js -> asyncRoute) so the increment is part of the same
 * transaction as whatever INSERT uses the resulting ID.
 */
async function generateNextId(client, prefix) {
  const { rows } = await client.query(
    "SELECT last_number FROM id_counters WHERE prefix = ? FOR UPDATE",
    [prefix]
  );

  if (!rows.length) {
    // First ID ever issued for this prefix -- seed the counter row.
    await client.query("INSERT INTO id_counters (prefix, last_number) VALUES (?, 0)", [prefix]);
  }

  // MySQL has no RETURNING clause -- UPDATE, then SELECT the row back.
  // Still race-safe: the FOR UPDATE above already holds this row's lock
  // for the rest of the transaction.
  await client.query("UPDATE id_counters SET last_number = last_number + 1 WHERE prefix = ?", [prefix]);
  const { rows: updated } = await client.query("SELECT last_number FROM id_counters WHERE prefix = ?", [prefix]);

  const number = updated[0].last_number;
  return `${prefix}${String(number).padStart(3, "0")}`;
}

module.exports = { generateNextId };
