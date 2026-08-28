// Real, database-backed notifications -- the `notifications` table and the
// `settings.notify_*` preference columns already existed in the schema
// (seeded on every account since account creation) but were never wired up
// by any application code until now. This is the one place that creates a
// notification row, so every call site (assignment published/submitted/
// graded, and anything added later) goes through the same preference check
// and the same shape.

const NOTIFICATION_PREFERENCE_COLUMN = {
  message: "notify_messages",
  assignment: "notify_assignments",
  session: "notify_sessions",
  meeting: "notify_sessions",
  payment: "notify_payments",
  announcement: "notify_announcements",
  document: "notify_messages",
  system: null, // system notifications are never preference-gated
};

/**
 * Creates a notification row for one recipient, unless they've turned that
 * notification type off in their own settings. Returns the inserted row's
 * id, or null if the notification was suppressed by preference (not an
 * error -- the caller doesn't need to treat this differently from success).
 *
 * @param {object} db - transactional db client (from asyncRoute)
 * @param {object} params
 * @param {number} params.recipientId
 * @param {'message'|'assignment'|'session'|'meeting'|'payment'|'announcement'|'document'|'system'} params.type
 * @param {string} params.title
 * @param {string} [params.body]
 * @param {string} [params.relatedEntityType]
 * @param {number} [params.relatedEntityId]
 */
async function createNotification(db, { recipientId, type, title, body, relatedEntityType, relatedEntityId }) {
  const prefColumn = NOTIFICATION_PREFERENCE_COLUMN[type];
  if (prefColumn) {
    const { rows } = await db.query(`SELECT ${prefColumn} AS enabled FROM settings WHERE user_id = ?`, [recipientId]);
    // No settings row at all is not expected (every account gets one on
    // creation) but defaults to sending rather than silently swallowing a
    // real event if that ever happens.
    if (rows.length && !rows[0].enabled) return null;
  }

  const result = await db.query(
    `INSERT INTO notifications (recipient_id, notification_type, title, body, related_entity_type, related_entity_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [recipientId, type, title, body || null, relatedEntityType || null, relatedEntityId || null]
  );
  return result.insertId;
}

module.exports = { createNotification };
