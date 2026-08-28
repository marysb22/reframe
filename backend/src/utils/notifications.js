// Real, database-backed notifications -- the `notifications` table and the
// `settings.notify_*` preference columns already existed in the schema
// (seeded on every account since account creation) but were never wired up
// by any application code until now. This is the one place that creates a
// notification row, so every call site (assignment published/submitted/
// graded, and anything added later) goes through the same preference check
// and the same shape.
//
// Email delivery reuses this exact same preference gate -- there is no
// separate "email notifications" setting. If a user turned assignment
// notifications off, they get neither the in-app row nor the email.

const { sendEmail } = require("./mailer");
const { renderEmailTemplate } = require("./emailTemplates");

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
 * Looks up a user's display name + email across whichever role table they
 * actually belong to. Same COALESCE-across-role-tables shape used by
 * profile.js's PROFILE_SELECT -- duplicated here (rather than imported)
 * because it's a 6-line, dependency-free query and this file has no other
 * reason to depend on routes/profile.js.
 */
async function getUserContactInfo(db, userId) {
  const { rows } = await db.query(
    `SELECT
       COALESCE(a.full_name, sup.full_name, st.full_name, d.full_name) AS full_name,
       COALESCE(a.email, sup.email, st.email, d.email) AS email
     FROM user_credentials uc
     LEFT JOIN admin_users a ON a.id = uc.id
     LEFT JOIN supervisors sup ON sup.id = uc.id
     LEFT JOIN students st ON st.id = uc.id
     LEFT JOIN designers d ON d.id = uc.id
     WHERE uc.id = ?`,
    [userId]
  );
  if (!rows.length) return null;
  return { fullName: rows[0].full_name, email: rows[0].email };
}

/**
 * Creates a notification row for one recipient, unless they've turned that
 * notification type off in their own settings. Returns the inserted row's
 * id, or null if the notification was suppressed by preference (not an
 * error -- the caller doesn't need to treat this differently from success).
 *
 * Pass `email: { template, data }` to also send a templated email to the
 * same recipient (their address is looked up automatically -- callers
 * never pass an email address in). Email delivery is fire-and-forget: it
 * never delays the response and a failed/unconfigured send never throws,
 * so creating a notification always succeeds regardless of email status.
 *
 * @param {object} db - transactional db client (from asyncRoute)
 * @param {object} params
 * @param {number} params.recipientId
 * @param {'message'|'assignment'|'session'|'meeting'|'payment'|'announcement'|'document'|'system'} params.type
 * @param {string} params.title
 * @param {string} [params.body]
 * @param {string} [params.relatedEntityType]
 * @param {number} [params.relatedEntityId]
 * @param {{template: string, data?: object}} [params.email]
 */
async function createNotification(db, { recipientId, type, title, body, relatedEntityType, relatedEntityId, email }) {
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

  if (email) {
    // The contact lookup runs now, on `db`, while the request's transaction
    // is still open -- `asyncRoute` commits and releases this connection
    // the instant the route handler returns, so nothing after that point
    // may touch `db` again. The actual SMTP send is the slow part and is
    // deliberately NOT awaited (fire-and-forget) so a slow or unconfigured
    // mail server never adds latency to the request; it only ever uses the
    // already-resolved `contact`/`rendered` data, never `db`.
    try {
      const contact = await getUserContactInfo(db, recipientId);
      if (contact && contact.email) {
        const rendered = renderEmailTemplate(email.template, { recipientName: contact.fullName || "there", ...email.data });
        if (rendered) {
          sendEmail({ to: contact.email, subject: rendered.subject, text: rendered.text, html: rendered.html }).catch(() => {});
        }
      }
    } catch (err) {
      console.error("[notifications] Could not resolve recipient contact info for email:", err.message);
    }
  }

  return result.insertId;
}

module.exports = { createNotification, getUserContactInfo };
