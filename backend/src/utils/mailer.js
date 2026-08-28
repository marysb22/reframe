// Reusable SMTP mail transport. Nothing in here knows about assignments,
// trainees, or any other app concept -- see emailTemplates.js for content
// and notifications.js for who gets emailed and when. Kept intentionally
// silent-by-default: if SMTP isn't configured, the app must keep working
// exactly as it did before this feature existed (in-app notifications
// only), not crash or block the action that triggered the email.
const nodemailer = require("nodemailer");

const REQUIRED_ENV_VARS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS"];

let transporter = null;
let warnedNotConfigured = false;

function isEmailConfigured() {
  return REQUIRED_ENV_VARS.every((key) => !!process.env[key]);
}

function getTransporter() {
  if (!isEmailConfigured()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT),
      secure: process.env.SMTP_SECURE === "true", // true for port 465, false for 587/25 (STARTTLS)
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transporter;
}

/**
 * Sends one email. Never throws -- a failed or unconfigured email must
 * never break the database action that triggered it (creating an
 * assignment, grading a submission, etc. always succeeds regardless of
 * email delivery). Callers that care can inspect the returned `sent` flag;
 * nothing in this codebase currently needs to.
 */
async function sendEmail({ to, subject, text, html }) {
  if (!to) return { sent: false, reason: "no_recipient" };

  const t = getTransporter();
  if (!t) {
    if (!warnedNotConfigured) {
      console.warn(
        `[mailer] Email notifications are disabled: set ${REQUIRED_ENV_VARS.join(", ")} ` +
          "(and optionally SMTP_SECURE, SMTP_FROM) to enable outbound email."
      );
      warnedNotConfigured = true;
    }
    return { sent: false, reason: "not_configured" };
  }

  try {
    await t.sendMail({
      from: process.env.SMTP_FROM || `"Training System" <${process.env.SMTP_USER}>`,
      to,
      subject,
      text,
      html,
    });
    return { sent: true };
  } catch (err) {
    console.error(`[mailer] Failed to send email to ${to}:`, err.message);
    return { sent: false, reason: "send_error", error: err.message };
  }
}

module.exports = { sendEmail, isEmailConfigured };
