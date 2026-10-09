// Training Materials Usage & Distribution Notice -- the exact bilingual
// text is fixed per the business requirement ("Do not rewrite or weaken
// this notice without approval") and served from this single source of
// truth so the one-time acceptance modal and the read-only "Read Usage
// Notice" view on each dashboard can never drift apart.
//
// Bumping CURRENT_VERSION is the whole "version management" mechanism:
// every non-exempt user whose latest acceptance row (if any) doesn't match
// this string will be asked to accept again. Intentionally a code
// constant, not an admin-editable DB setting -- this app has no general
// precedent for admin-editable business copy, and the notice's own text is
// meant to change rarely and under explicit review ("without approval"),
// which a deploy-time constant already enforces better than a free-text DB
// field would.
const CURRENT_VERSION = "training-materials-v1";

const NOTICE = {
  version: CURRENT_VERSION,
  en: {
    title: "Training Materials: Use and Distribution",
    body:
      "All scientific and training materials available in this section are provided exclusively for the use of registered students during the training period.\n\n" +
      "Any reproduction, copying, sharing, or dissemination of these materials outside the framework of the training is strictly prohibited without prior authorization.",
  },
  ar: {
    title: "مواد التدريب: الاستخدام والتوزيع",
    body:
      "جميع المواد العلمية والتدريبية المتاحة في هذا القسم مخصصة حصراً لاستخدام الطلاب المسجلين خلال فترة التدريب.\n\n" +
      "يُمنع منعاً باتاً نسخ هذه المواد أو إعادة إنتاجها أو مشاركتها أو توزيعها أو نشرها خارج إطار التدريب، ما لم يتم الحصول على إذن مسبق.",
  },
};

// Dashboard warning banner copy (shorter, distinct from the full modal
// text per the business requirement's section 5).
const BANNER = {
  en: {
    title: "Training Materials: Restricted Use",
    body:
      "Training materials are for registered students during the training period only. Copying, sharing, or distributing them outside the training framework is prohibited without prior authorization.",
  },
  ar: {
    title: "مواد التدريب: استخدام مقيّد",
    body: "مواد التدريب مخصصة للطلاب المسجلين خلال فترة التدريب فقط. يُمنع نسخها أو مشاركتها أو توزيعها خارج إطار التدريب دون إذن مسبق.",
  },
};

// Admin (oversight, not a materials consumer) and Designer (a fully
// separate account type with no access to trainee/training features at
// all -- confirmed by inspecting DesignerDashboard.html, which has no
// Materials concept whatsoever) are the only two roles exempt from this
// notice. The business requirement's own role matrix only ever names
// Master Trainer/ToT/Trainee as required to accept.
function noticeRequiredForRole(role) {
  return role === "trainee" || role === "supervisor";
}

async function hasAcceptedCurrentVersion(db, userId) {
  const { rows } = await db.query(
    "SELECT 1 FROM training_materials_notice_acceptances WHERE user_id = ? AND notice_version = ?",
    [userId, CURRENT_VERSION]
  );
  return rows.length > 0;
}

/** Records acceptance for `userId` + CURRENT_VERSION. Idempotent: a second
 * call for the same user+version is a silent no-op (the UNIQUE constraint
 * would otherwise throw ER_DUP_ENTRY on a double-submit/retry). */
async function recordAcceptance(db, userId, { ipAddress, userAgent } = {}) {
  try {
    await db.query(
      "INSERT INTO training_materials_notice_acceptances (user_id, notice_version, ip_address, user_agent) VALUES (?, ?, ?, ?)",
      [userId, CURRENT_VERSION, ipAddress || null, (userAgent || "").slice(0, 255) || null]
    );
    return true;
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") return false;
    throw err;
  }
}

module.exports = {
  CURRENT_VERSION,
  NOTICE,
  BANNER,
  noticeRequiredForRole,
  hasAcceptedCurrentVersion,
  recordAcceptance,
};
