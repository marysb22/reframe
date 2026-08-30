// Professional email copy for the internal training system's automated
// notifications. Every function here is pure (no DB/network access) --
// it just turns { recipientName, ...eventData } into { subject, text, html }.
// notifications.js resolves who the recipient is and calls these; this
// file only knows how to word an email.

function formatDate(value) {
  if (!value) return "Not specified";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function wrap(recipientName, bodyLines, signOff = "Training System") {
  const text = [`Hello ${recipientName},`, "", ...bodyLines, "", "Please log in to your account to view the details.", "", "Regards,", signOff].join("\n");

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#16211F;line-height:1.6;max-width:520px;">
      <p>Hello ${escapeHtml(recipientName)},</p>
      ${bodyLines.map((line) => `<p style="margin:0 0 8px;">${line}</p>`).join("\n")}
      <p style="margin-top:16px;">Please log in to your account to view the details.</p>
      <p style="margin-top:24px;color:#5D6C6A;">Regards,<br>${escapeHtml(signOff)}</p>
    </div>
  `.trim();

  return { text, html };
}

function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function field(label, value) {
  return `<strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}`;
}

const TEMPLATES = {
  newAssignment({ recipientName, assignmentTitle, trainerName, dueDate }) {
    const { text, html } = wrap(recipientName, [
      "A new assignment has been added to your training account.",
      "",
      field("Assignment", assignmentTitle),
      field("Created by", trainerName),
      field("Due date", formatDate(dueDate)),
    ]);
    return { subject: "New Assignment Added", text, html };
  },

  newMeeting({ recipientName, meetingTitle, trainerName, platform, scheduledAt }) {
    const { text, html } = wrap(recipientName, [
      "A new meeting has been scheduled on your training account.",
      "",
      field("Meeting", meetingTitle),
      field("Scheduled by", trainerName),
      field("Platform", platform),
      field("Date & time", scheduledAt ? new Date(scheduledAt).toLocaleString("en-US") : "Not specified"),
    ]);
    return { subject: "New Meeting Scheduled", text, html };
  },

  newSession({ recipientName, sessionTitle, trainerName, sessionType, date }) {
    const { text, html } = wrap(recipientName, [
      "A new session has been logged on your training account.",
      "",
      field("Session", sessionTitle || (sessionType === "training" ? "Training session" : "Supervision session")),
      field("Scheduled by", trainerName),
      field("Date", formatDate(date)),
    ]);
    return { subject: "New Session Scheduled", text, html };
  },

  newMaterial({ recipientName, materialTitle, trainerName }) {
    const { text, html } = wrap(recipientName, [
      "New training material has been shared with you.",
      "",
      field("Material", materialTitle),
      field("Shared by", trainerName),
    ]);
    return { subject: "New Training Material Added", text, html };
  },

  newAnnouncement({ recipientName, announcementTitle, announcementContent, trainerName }) {
    const lines = [
      "A new announcement has been posted to your training account.",
      "",
      field("Title", announcementTitle),
      field("Posted by", trainerName),
    ];
    if (announcementContent) lines.push("", escapeHtml(announcementContent));
    const { text, html } = wrap(recipientName, lines);
    return { subject: "New Announcement", text, html };
  },

  assignmentSubmitted({ recipientName, assignmentTitle, traineeName }) {
    const { text, html } = wrap(recipientName, [
      "A trainee has submitted an assignment for your review.",
      "",
      field("Assignment", assignmentTitle),
      field("Submitted by", traineeName),
    ]);
    return { subject: "Assignment Submitted", text, html };
  },

  assignmentGraded({ recipientName, assignmentTitle, score, feedback }) {
    const lines = [
      "Your assignment has been graded.",
      "",
      field("Assignment", assignmentTitle),
      field("Score", score != null ? score : "Not scored"),
    ];
    if (feedback) lines.push(field("Feedback", feedback));
    const { text, html } = wrap(recipientName, lines);
    return { subject: "Assignment Graded", text, html };
  },

  // Deliberately does NOT use wrap() -- its "log in to view details" footer
  // doesn't apply to a pre-authentication email, and a reset code needs to
  // stand out visually rather than read like a routine activity notice.
  passwordReset({ recipientName, code, expiresInMinutes }) {
    const text = [
      `Hello ${recipientName},`,
      "",
      "We received a request to reset your password.",
      "",
      `Your verification code is: ${code}`,
      "",
      `This code expires in ${expiresInMinutes} minutes.`,
      "",
      "If you did not request this password reset, you can safely ignore this email -- your password will not be changed.",
      "",
      "Regards,",
      "Training System",
    ].join("\n");

    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#16211F;line-height:1.6;max-width:480px;">
        <p>Hello ${escapeHtml(recipientName)},</p>
        <p style="margin:0 0 8px;">We received a request to reset your password.</p>
        <p style="margin:20px 0;text-align:center;">
          <span style="display:inline-block;background:#E4F5EA;color:#1D7A4C;font-size:28px;font-weight:700;letter-spacing:4px;padding:14px 28px;border-radius:12px;">${escapeHtml(code)}</span>
        </p>
        <p style="margin:0 0 8px;color:#5D6C6A;">This code expires in ${expiresInMinutes} minutes.</p>
        <p style="margin:16px 0 0;color:#5D6C6A;">If you did not request this password reset, you can safely ignore this email -- your password will not be changed.</p>
        <p style="margin-top:24px;color:#5D6C6A;">Regards,<br>Training System</p>
      </div>
    `.trim();

    return { subject: "Your Password Reset Code", text, html };
  },
};

/** Returns { subject, text, html } for a known template name, or null if unknown (never throws -- an unrecognized template must not break the caller). */
function renderEmailTemplate(name, data) {
  const fn = TEMPLATES[name];
  if (!fn) {
    console.error(`[emailTemplates] Unknown template "${name}" -- email not sent.`);
    return null;
  }
  return fn(data || {});
}

module.exports = { renderEmailTemplate };
