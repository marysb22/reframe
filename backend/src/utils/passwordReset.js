// Reusable Forgot Password service, shared by all four roles (admin,
// supervisor, student, designer all authenticate through the same
// user_credentials table -- see auth.js) so there is exactly one
// implementation of the reset flow instead of one per role.
//
// Security posture (see database/migrations/004_password_reset.sql and
// backend/src/routes/auth.js for the routes that call this):
//  - The 6-digit code is generated with crypto.randomInt (CSPRNG), never
//    stored raw -- only a bcrypt hash of it (the same hashPassword() used
//    for real account passwords).
//  - Every public entry point (requestReset) always resolves successfully
//    and never reveals whether the identifier matched a real account --
//    callers (auth.js) always send back the same generic response.
//  - Rate limiting lives entirely in the password_reset_tokens table
//    (resend cooldown, per-user request cap, per-IP cap, per-code attempt
//    cap) -- no new dependency, matches how the rest of this codebase
//    avoids adding infrastructure that isn't already there.
//  - Nothing in this file ever logs a code or password.

const crypto = require("crypto");
const { hashPassword, verifyPassword } = require("./authUtils");
const { sendEmail, isEmailConfigured } = require("./mailer");
const { renderEmailTemplate } = require("./emailTemplates");
const { getUserContactInfo } = require("./notifications");

const CODE_EXPIRY_MINUTES = 10;
const RESEND_COOLDOWN_SECONDS = 45;
const MAX_REQUESTS_PER_USER_WINDOW = 3;
const USER_WINDOW_MINUTES = 15;
const MAX_REQUESTS_PER_IP_WINDOW = 10;
const IP_WINDOW_MINUTES = 60;
const MAX_VERIFY_ATTEMPTS = 5;

const GENERIC_SENT_MESSAGE = "If an account matches the information provided, a verification code has been sent.";
const EMAIL_UNAVAILABLE_MESSAGE =
  "Password reset via email is currently unavailable. Please contact your administrator for help resetting your password.";

/**
 * Resolves a Member ID or email address to an account, across every role
 * table -- the same COALESCE-across-role-tables shape used by
 * notifications.js's getUserContactInfo and profile.js's PROFILE_SELECT.
 */
async function findUserByIdentifier(db, identifier) {
  const raw = String(identifier || "").trim();
  if (!raw) return null;

  const { rows } = await db.query(
    `SELECT uc.id, uc.role,
            COALESCE(a.email, sup.email, st.email, d.email) AS email
       FROM user_credentials uc
       LEFT JOIN admin_users a ON a.id = uc.id
       LEFT JOIN supervisors sup ON sup.id = uc.id
       LEFT JOIN students st ON st.id = uc.id
       LEFT JOIN designers d ON d.id = uc.id
      WHERE uc.member_code = ? OR COALESCE(a.email, sup.email, st.email, d.email) = ?`,
    [raw.toUpperCase(), raw]
  );
  return rows[0] || null;
}

function generateCode() {
  return String(crypto.randomInt(100000, 1000000));
}

/**
 * Step 1: request a reset code. ALWAYS resolves (never throws for "not
 * found") -- the caller (auth.js) sends the same response either way. Only
 * actually creates a code + sends an email when every check passes:
 * identifier resolves to a real account, that account has an email on
 * file, and none of the rate limits are currently tripped.
 */
async function requestReset(db, { identifier, ip }) {
  if (!isEmailConfigured()) {
    return { message: EMAIL_UNAVAILABLE_MESSAGE };
  }

  const user = await findUserByIdentifier(db, identifier);
  if (!user || !user.email) {
    return { message: GENERIC_SENT_MESSAGE };
  }

  const { rows: recentForUser } = await db.query(
    `SELECT created_at FROM password_reset_tokens
      WHERE user_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL ? MINUTE)
      ORDER BY created_at DESC`,
    [user.id, USER_WINDOW_MINUTES]
  );
  if (recentForUser.length >= MAX_REQUESTS_PER_USER_WINDOW) {
    return { message: GENERIC_SENT_MESSAGE };
  }
  if (recentForUser.length) {
    const lastCreated = new Date(recentForUser[0].created_at).getTime();
    if (Date.now() - lastCreated < RESEND_COOLDOWN_SECONDS * 1000) {
      return { message: GENERIC_SENT_MESSAGE };
    }
  }

  if (ip) {
    const { rows: recentForIp } = await db.query(
      `SELECT COUNT(*) AS n FROM password_reset_tokens
        WHERE ip_address = ? AND created_at > DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
      [ip, IP_WINDOW_MINUTES]
    );
    if (Number(recentForIp[0].n) >= MAX_REQUESTS_PER_IP_WINDOW) {
      return { message: GENERIC_SENT_MESSAGE };
    }
  }

  const code = generateCode();
  const codeHash = await hashPassword(code);
  const expiresAt = new Date(Date.now() + CODE_EXPIRY_MINUTES * 60 * 1000);

  // A fresh request invalidates whatever unconsumed code already existed
  // for this user, so only the newest code can ever verify.
  await db.query("DELETE FROM password_reset_tokens WHERE user_id = ? AND used_at IS NULL", [user.id]);
  await db.query(
    "INSERT INTO password_reset_tokens (user_id, code_hash, expires_at, ip_address) VALUES (?, ?, ?, ?)",
    [user.id, codeHash, expiresAt, ip || null]
  );
  await db.query(
    "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES (?, 'password_reset_requested', 'user_credentials', ?)",
    [user.id, user.id]
  );

  try {
    const contact = await getUserContactInfo(db, user.id);
    const rendered = renderEmailTemplate("passwordReset", {
      recipientName: (contact && contact.fullName) || "there",
      code,
      expiresInMinutes: CODE_EXPIRY_MINUTES,
    });
    if (rendered && contact && contact.email) {
      sendEmail({ to: contact.email, subject: rendered.subject, text: rendered.text, html: rendered.html }).catch(() => {});
    }
  } catch (err) {
    console.error("[passwordReset] Could not send reset email:", err.message);
  }

  return { message: GENERIC_SENT_MESSAGE };
}

/**
 * Shared by verify-reset-code and reset-password so a wrong guess through
 * either endpoint counts against the same attempt limit. Returns one of:
 * 'valid' | 'no_active_code' | 'expired' | 'too_many_attempts' | 'invalid'
 */
async function checkCode(db, { identifier, code }) {
  const user = await findUserByIdentifier(db, identifier);
  if (!user) return { result: "invalid", userId: null };

  const { rows } = await db.query(
    `SELECT id, code_hash, expires_at, attempt_count FROM password_reset_tokens
      WHERE user_id = ? AND used_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [user.id]
  );
  const token = rows[0];
  if (!token) return { result: "no_active_code", userId: user.id };

  if (token.attempt_count >= MAX_VERIFY_ATTEMPTS) {
    return { result: "too_many_attempts", userId: user.id };
  }
  if (new Date(token.expires_at).getTime() < Date.now()) {
    return { result: "expired", userId: user.id };
  }

  const matches = await verifyPassword(String(code || ""), token.code_hash);
  if (!matches) {
    const nextCount = token.attempt_count + 1;
    if (nextCount >= MAX_VERIFY_ATTEMPTS) {
      await db.query("UPDATE password_reset_tokens SET attempt_count = ?, used_at = NOW() WHERE id = ?", [nextCount, token.id]);
      return { result: "too_many_attempts", userId: user.id };
    }
    await db.query("UPDATE password_reset_tokens SET attempt_count = ? WHERE id = ?", [nextCount, token.id]);
    return { result: "invalid", userId: user.id };
  }

  return { result: "valid", userId: user.id, tokenId: token.id };
}

/**
 * Step 3: re-validates the code (never trusts a prior verify-reset-code
 * call) and, only if still valid, sets the new password and consumes the
 * token.
 */
async function completeReset(db, { identifier, code, newPassword }) {
  const check = await checkCode(db, { identifier, code });
  if (check.result !== "valid") return check;

  const passwordHash = await hashPassword(newPassword);
  await db.query("UPDATE user_credentials SET password_hash = ?, updated_at = NOW() WHERE id = ?", [passwordHash, check.userId]);
  await db.query("UPDATE password_reset_tokens SET used_at = NOW() WHERE id = ?", [check.tokenId]);
  await db.query(
    "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES (?, 'password_reset_completed', 'user_credentials', ?)",
    [check.userId, check.userId]
  );

  return { result: "valid", userId: check.userId };
}

module.exports = { requestReset, checkCode, completeReset, findUserByIdentifier };
