const db = require("../../db");

/** Small, safe summary used in login response / admin lists. */
function toPublicUser(user) {
  return {
    id: user.id,
    memberCode: user.member_code,
    full_name: user.full_name,
    role: user.role,
    status: user.status,
    must_change_password: !!user.must_change_password,
    email: user.email,
    cohort: user.cohort,
    currentYear: user.current_year,
    created_at: user.created_at,
  };
}

/** Shape expected by profile.html's loadProfile(). */
function toProfileResponse(user) {
  const supervisors = db
    .prepare(
      `SELECT u.id, u.member_code, u.full_name
       FROM user_supervisors us
       JOIN users u ON u.id = us.supervisor_id
       WHERE us.user_id = ?`
    )
    .all(user.id);

  return {
    id: user.id,
    memberCode: user.member_code,
    full_name: user.full_name,
    role: user.role,
    email: user.email,
    gender: user.gender,
    dateOfBirth: user.date_of_birth,
    maritalStatus: user.marital_status,
    phone: user.phone,
    address: user.address,
    highestDegree: user.highest_degree,
    institution: user.institution,
    certifications: user.certifications,
    cohort: user.cohort,
    currentYear: user.current_year,
    cvFile: user.cv_file,
    photo: user.photo,
    must_change_password: !!user.must_change_password,
    supervisors,
  };
}

/** Row shown in a supervisor's "my students" list. */
function toStudentSummary(user) {
  return {
    id: user.id,
    memberCode: user.member_code,
    full_name: user.full_name,
    email: user.email,
    cohort: user.cohort,
    currentYear: user.current_year,
    status: user.status,
  };
}

function toRecord(row) {
  return {
    id: row.id,
    studentId: row.student_id,
    supervisorId: row.supervisor_id,
    supervisorName: row.supervisor_name,
    recordType: row.record_type,
    date: row.record_date,
    time: row.record_time,
    durationMinutes: row.duration_minutes,
    status: row.status,
    title: row.title,
    content: row.content,
    score: row.score,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toDocument(row) {
  return {
    id: row.id,
    studentId: row.student_id,
    uploadedBy: row.uploaded_by,
    uploadedByName: row.uploaded_by_name,
    filename: row.filename,
    originalName: row.original_name,
    createdAt: row.created_at,
  };
}

function toMessage(row, currentUserId) {
  return {
    id: row.id,
    senderId: row.sender_id,
    senderName: row.sender_name,
    recipientId: row.recipient_id,
    content: row.content,
    isRead: !!row.is_read,
    isMine: row.sender_id === currentUserId,
    createdAt: row.created_at,
  };
}

/** Rolls a student's records up into the numbers My Profile/progress needs. */
function toProgressSummary(records) {
  const clinicalHours = records
    .filter((r) => r.record_type === "clinical_hours")
    .reduce((sum, r) => sum + (r.duration_minutes || 0), 0) / 60;

  const attendanceRows = records.filter((r) => r.record_type === "attendance");
  const presentCount = attendanceRows.filter((r) => r.status === "present").length;
  const attendanceRate = attendanceRows.length ? Math.round((presentCount / attendanceRows.length) * 100) : null;

  const assignments = records.filter((r) => r.record_type === "assignment");
  const completedAssignments = assignments.filter((r) => r.status === "completed").length;

  const evaluations = records.filter((r) => r.record_type === "evaluation" && r.score != null);
  const averageEvaluationScore = evaluations.length
    ? Math.round((evaluations.reduce((sum, r) => sum + r.score, 0) / evaluations.length) * 10) / 10
    : null;

  const trainingSessions = records.filter((r) => r.record_type === "training_session").length;
  const supervisionSessions = records.filter((r) => r.record_type === "supervision_session").length;

  return {
    clinicalHours: Math.round(clinicalHours * 10) / 10,
    attendanceRate,
    trainingSessions,
    supervisionSessions,
    assignmentsTotal: assignments.length,
    assignmentsCompleted: completedAssignments,
    averageEvaluationScore,
  };
}

function toMaterial(row) {
  return {
    id: row.id,
    supervisorId: row.supervisor_id,
    supervisorName: row.supervisor_name,
    title: row.title,
    description: row.description,
    materialType: row.material_type,
    filename: row.filename,
    originalName: row.original_name,
    externalUrl: row.external_url,
    createdAt: row.created_at,
  };
}

function toAnnouncement(row) {
  return {
    id: row.id,
    supervisorId: row.supervisor_id,
    supervisorName: row.supervisor_name,
    title: row.title,
    content: row.content,
    createdAt: row.created_at,
  };
}

function safeJsonArray(str) {
  try {
    const parsed = JSON.parse(str || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toPublicEvent(row) {
  return {
    id: row.id,
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
      learn: safeJsonArray(row.learn_en),
      who: safeJsonArray(row.who_en),
      outcomes: safeJsonArray(row.outcomes_en),
      facilitatorBio: row.facilitator_bio_en,
    },
    arabic: {
      title: row.title_ar,
      format: row.format_ar,
      facilitator: row.facilitator_ar,
      about: row.about_ar,
      learn: safeJsonArray(row.learn_ar),
      who: safeJsonArray(row.who_ar),
      outcomes: safeJsonArray(row.outcomes_ar),
      facilitatorBio: row.facilitator_bio_ar,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

module.exports = {
  toPublicUser,
  toProfileResponse,
  toStudentSummary,
  toRecord,
  toDocument,
  toMessage,
  toProgressSummary,
  toMaterial,
  toAnnouncement,
  toPublicEvent,
};