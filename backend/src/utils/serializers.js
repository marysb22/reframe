/**
 * All of these expect the *joined* row shape produced by the queries in
 * routes/admin.js (user_credentials LEFT JOIN supervisors LEFT JOIN
 * students LEFT JOIN cohorts), not a raw single-table row -- see the
 * SELECT list in admin.js's `USER_SELECT` constant for the exact columns
 * these read.
 */

/** Event forms send either a real array or newline-separated bullet text -- normalize to an array either way. Shared by admin.js and designer.js, both of which manage the `events` table. */
function toArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    return value.split("\n").map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

// USER_SELECT's `supervisors` column is a JSON_ARRAYAGG(JSON_OBJECT(...))
// result. On real MySQL that comes back already parsed into a JS array;
// on MariaDB (what production runs) the JSON type is really just LONGTEXT,
// so mysql2 hands it back as a raw JSON string that still needs parsing.
// Handles both, and sorts alphabetically here since neither engine
// supports an inline ORDER BY on JSON_ARRAYAGG.
function parseSupervisorsField(value) {
  let arr = value;
  if (typeof arr === "string") {
    try {
      arr = JSON.parse(arr);
    } catch {
      arr = [];
    }
  }
  if (!Array.isArray(arr)) arr = [];
  return [...arr].sort((a, b) => String(a.full_name || "").localeCompare(String(b.full_name || "")));
}

function toPublicUser(row) {
  return {
    id: row.id,
    memberCode: row.member_code,
    role: row.role,
    status: row.status,
    full_name: row.full_name, // NOTE: snake_case deliberately -- the Admin
    // Dashboard reads u.full_name, u.created_at, u.must_change_password
    // directly (confirmed by grepping dashboard.html), same mixed
    // convention as toStudentSummary's full_name field. Sending fullName
    // here produced a blank Name column; sending createdAt/
    // mustChangePassword camelCase produced "Invalid Date" everywhere
    // and a broken "First login pending" indicator.
    email: row.email,
    must_change_password: row.must_change_password,
    created_at: row.created_at,
    supervisors: parseSupervisorsField(row.supervisors), // [] for supervisors/admins, real list for trainees
    supervisorType: row.supervisor_type, // 'primary' (Master Trainer) | 'in_training' (Trainer/ToT); null for trainees/admins
  };
}

function toProfileResponse(row) {
  return {
    ...toPublicUser(row),
    phone: row.phone,
    photo: row.photo,
    updatedAt: row.updated_at,
    // Student-only fields (null for a supervisor/admin row)
    gender: row.gender,
    dateOfBirth: row.date_of_birth,
    maritalStatus: row.marital_status,
    address: row.address,
    cohort: row.cohort_name,
    cohortId: row.cohort_id,
    currentYear: row.current_year,
    highestDegree: row.highest_degree,
    institution: row.institution,
    certifications: row.certifications,
    cvFile: row.cv_file,
    // Supervisor-only fields (null for a student/admin row)
    specialization: row.specialization,
    bio: row.bio,
  };
}

/**
 * Converts an `events` row (JSONB columns already arrive as real JS
 * arrays via node-postgres -- no JSON.parse needed, unlike the old
 * SQLite-era TEXT-storing-JSON columns) into the nested
 * { date, image, status, fee, register, english: {...}, arabic: {...} }
 * shape that both events.html (public site) and the Admin Dashboard's
 * event list already expect. The create/edit FORM still posts flat
 * field names (englishTitle, arabicTitle, ...) -- see the route handlers.
 */
function toPublicEvent(row) {
  return {
    id: row.id,
    slug: row.slug,
    date: row.event_date,
    image: row.image,
    status: row.status,
    fee: row.fee,
    register: row.register_url,
    english: {
      title: row.title_en,
      format: row.format_en,
      facilitator: row.facilitator_en,
      about: row.about_en,
      learn: row.learn_en || [],
      who: row.who_en || [],
      outcomes: row.outcomes_en || [],
      facilitatorBio: row.facilitator_bio_en,
    },
    arabic: {
      title: row.title_ar,
      format: row.format_ar,
      facilitator: row.facilitator_ar,
      about: row.about_ar,
      learn: row.learn_ar || [],
      who: row.who_ar || [],
      outcomes: row.outcomes_ar || [],
      facilitatorBio: row.facilitator_bio_ar,
    },
  };
}

/**
 * Full single-event shape for the authenticated designer/admin editor --
 * unlike toPublicEvent, always includes every child collection (speakers/
 * agenda/sponsors/gallery) regardless of the show_* toggles, so switching a
 * section back on in the editor never loses previously-entered data. The
 * public single-event route (GET /api/events/:slug) starts from this same
 * shape and then deletes whichever child keys correspond to an OFF toggle --
 * see routes/public.js.
 */
function toEventDetail(row, children) {
  return {
    ...toPublicEvent(row),
    toggles: {
      speakers: !!row.show_speakers,
      agenda: !!row.show_agenda,
      sponsors: !!row.show_sponsors,
      gallery: !!row.show_gallery,
      registration: !!row.show_registration,
    },
    speakers: children.speakers,
    agenda: children.agenda,
    sponsors: children.sponsors,
    gallery: children.gallery,
  };
}

/**
 * `transactions` is an array of raw payment_transactions rows (amount_cents
 * as signed integers -- refunds/adjustments are negative). Computes paid/
 * remaining/status live from the ledger rather than trusting the stored
 * payments.status column, which the route handlers also keep in sync but
 * shouldn't be the source of truth for a value this cheap to recompute.
 */
function toPaymentSummary(userRow, paymentsRow, transactions) {
  const totalFeeCents = paymentsRow?.total_fee_cents || 0;
  const discountCents = paymentsRow?.discount_cents || 0;
  const paidCents = transactions.reduce((sum, t) => sum + t.amount_cents, 0);
  const netFeeCents = Math.max(totalFeeCents - discountCents, 0);
  const remainingCents = netFeeCents - paidCents;

  let status = "unpaid";
  if (paidCents > 0 && remainingCents <= 0) status = "paid";
  else if (paidCents > 0) status = "partial";

  return {
    userId: userRow.id,
    fullName: userRow.full_name,
    memberCode: userRow.member_code,
    totalFee: totalFeeCents / 100,
    discount: discountCents / 100,
    paid: paidCents / 100,
    remaining: Math.max(remainingCents, 0) / 100,
    status,
    paymentPlan: paymentsRow?.payment_plan || null,
    nextDueDate: paymentsRow?.next_due_date || null,
  };
}

function toPaymentTransaction(row) {
  return {
    id: row.id,
    amount: row.amount_cents / 100,
    transactionType: row.transaction_type,
    date: row.payment_date,
    method: row.method,
    notes: row.notes,
    addedByName: row.added_by_name,
    invoiceId: row.invoice_id,
    createdAt: row.created_at,
  };
}

function toRecord(row) {
  return {
    id: row.id,
    recordType: row.record_type,
    date: row.record_date,
    time: row.record_time,
    durationMinutes: row.duration_minutes,
    status: row.status,
    title: row.title,
    content: row.content,
    score: row.score,
    supervisorId: row.supervisor_id,
    supervisorName: row.supervisor_name,
    createdAt: row.created_at,
  };
}

function toDocument(row) {
  return {
    id: row.id,
    filename: row.filename,
    originalName: row.original_name,
    uploadedByName: row.uploaded_by_name,
    createdAt: row.created_at,
  };
}

function toMessage(row, viewerId) {
  return {
    id: row.id,
    content: row.content,
    senderName: row.sender_name,
    isMine: Number(row.sender_id) === Number(viewerId),
    isRead: row.is_read,
    createdAt: row.created_at,
  };
}

function toMaterial(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    materialType: row.material_type,
    filename: row.filename,
    originalName: row.original_name,
    externalUrl: row.external_url,
    supervisorName: row.supervisor_name,
    createdAt: row.created_at,
  };
}

function toAnnouncement(row) {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    supervisorName: row.supervisor_name,
    createdAt: row.created_at,
  };
}

function toStudentSummary(row) {
  return {
    id: row.id,
    memberCode: row.member_code,
    full_name: row.full_name, // NOTE: snake_case here deliberately -- the
    // Supervisor Dashboard frontend (already built, not something to
    // change here) consistently reads `s.full_name` in this one spot
    // (student list, assign-by-ID toast, session/assignment/document
    // panels), even though every other field on this object is
    // camelCase. Sending `fullName` instead produced "undefined added
    // to your students" on assignment -- reproduced and confirmed live.
    status: row.status,
    cohort: row.cohort_name,
    currentYear: row.current_year,
  };
}

/**
 * Computes the numbers behind the profile-completion / progress cards via
 * SQL aggregates against the normalized tables, rather than fetching every
 * row and reducing in JS like the old flexible-table version did.
 */
async function computeProgressSummary(db, studentId) {
  // MySQL has no FILTER (WHERE ...) clause (Postgres-only) -- every
  // COUNT(*) FILTER (WHERE cond) below becomes COUNT(CASE WHEN cond THEN 1 END),
  // which only counts rows where cond is true, same result.
  const [hoursRes, attendanceRes, sessionsRes, assignmentsRes, evalRes] = await Promise.all([
    db.query(
      `SELECT
         COALESCE((SELECT SUM(hours) FROM training_hours WHERE student_id = ?), 0) AS training,
         COALESCE((SELECT SUM(hours) FROM supervision_hours WHERE student_id = ?), 0) AS supervision`,
      [studentId, studentId]
    ),
    db.query(
      `SELECT
         COUNT(CASE WHEN status = 'present' THEN 1 END) AS present,
         COUNT(*) AS total
       FROM attendance WHERE student_id = ?`,
      [studentId]
    ),
    db.query(
      `SELECT
         COUNT(CASE WHEN session_type = 'training' THEN 1 END) AS training_sessions,
         COUNT(CASE WHEN session_type = 'supervision' THEN 1 END) AS supervision_sessions
       FROM sessions WHERE student_id = ?`,
      [studentId]
    ),
    db.query(
      `SELECT COUNT(*) AS total, COUNT(CASE WHEN status = 'completed' THEN 1 END) AS completed
       FROM assignments WHERE student_id = ?`,
      [studentId]
    ),
    db.query(`SELECT AVG(score) AS avg_score FROM evaluations WHERE student_id = ? AND score IS NOT NULL`, [
      studentId,
    ]),
  ]);

  const hours = hoursRes.rows[0];
  const attendance = attendanceRes.rows[0];
  const sessions = sessionsRes.rows[0];
  const assignments = assignmentsRes.rows[0];
  const avgScore = evalRes.rows[0].avg_score;

  return {
    clinicalHours: Number(hours.training) + Number(hours.supervision),
    attendanceRate: Number(attendance.total) > 0 ? Math.round((Number(attendance.present) / Number(attendance.total)) * 100) : null,
    trainingSessions: Number(sessions.training_sessions),
    supervisionSessions: Number(sessions.supervision_sessions),
    assignmentsTotal: Number(assignments.total),
    assignmentsCompleted: Number(assignments.completed),
    averageEvaluationScore: avgScore != null ? Math.round(Number(avgScore) * 10) / 10 : null,
  };
}

module.exports = {
  toArray,
  toPublicUser,
  toProfileResponse,
  toPublicEvent,
  toEventDetail,
  toPaymentSummary,
  toPaymentTransaction,
  toRecord,
  toDocument,
  toMessage,
  toMaterial,
  toAnnouncement,
  toStudentSummary,
  computeProgressSummary,
};