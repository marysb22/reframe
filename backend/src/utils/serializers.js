const db = require("../../db");

/**
 * A Trainer's full list of Master Trainers is the union of the direct
 * self-service link (trainer_master_trainers) and whichever Group they
 * belong to (group_leadership for that Group). Used by the admin roster,
 * the Trainer's own profile, and anywhere else that needs to show "who is
 * responsible for this Trainer" without caring which path created the link.
 */
function getMasterTrainersForTrainer(trainerId) {
  const direct = db
    .prepare(
      `SELECT u.id, u.member_code, u.full_name, NULL AS group_role, NULL AS group_id
       FROM trainer_master_trainers tmt
       JOIN users u ON u.id = tmt.master_trainer_id
       WHERE tmt.trainer_id = ?`
    )
    .all(trainerId);

  const viaGroup = db
    .prepare(
      `SELECT u.id, u.member_code, u.full_name, gl.role AS group_role, gl.group_id AS group_id
       FROM users t
       JOIN group_leadership gl ON gl.group_id = t.group_id
       JOIN users u ON u.id = gl.master_trainer_id
       WHERE t.id = ?`
    )
    .all(trainerId);

  const byId = new Map();
  for (const row of [...direct, ...viaGroup]) {
    if (!byId.has(row.id)) {
      byId.set(row.id, {
        id: row.id,
        memberCode: row.member_code,
        fullName: row.full_name,
        groupRole: row.group_role, // 'master' | 'tot' | null (null = direct assignment, not via a Group)
        groupId: row.group_id,
      });
    }
  }
  return Array.from(byId.values());
}

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
    groupId: user.group_id,
    created_at: user.created_at,
    masterTrainers: user.role === "trainer" ? getMasterTrainersForTrainer(user.id) : undefined,
  };
}

/** Shape expected by PersonalProfile.html's loadProfile(). */
function toProfileResponse(user) {
  const masterTrainers =
    user.role === "trainer"
      ? getMasterTrainersForTrainer(user.id)
      : db
          .prepare(
            `SELECT u.id, u.member_code, u.full_name
             FROM trainer_master_trainers tmt
             JOIN users u ON u.id = tmt.trainer_id
             WHERE tmt.master_trainer_id = ?`
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
    groupId: user.group_id,
    cvFile: user.cv_file,
    photo: user.photo,
    must_change_password: !!user.must_change_password,
    masterTrainers,
  };
}

/** Row shown in a Master Trainer's "my trainers" list. */
function toTrainerSummary(user) {
  return {
    id: user.id,
    memberCode: user.member_code,
    full_name: user.full_name,
    email: user.email,
    cohort: user.cohort,
    currentYear: user.current_year,
    groupId: user.group_id,
    status: user.status,
  };
}

function toRecord(row) {
  return {
    id: row.id,
    trainerId: row.trainer_id,
    masterTrainerId: row.master_trainer_id,
    masterTrainerName: row.master_trainer_name,
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
    trainerId: row.trainer_id,
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

/** Rolls a Trainer's records up into the numbers My Profile/progress needs. */
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
    masterTrainerId: row.master_trainer_id,
    masterTrainerName: row.master_trainer_name,
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
    masterTrainerId: row.master_trainer_id,
    masterTrainerName: row.master_trainer_name,
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

/** Converts a raw payment_profiles row + its transactions into the
 * dollars-and-cents summary both the admin and Trainer pages display. */
function toPaymentSummary(user, totalFeeCents, transactions) {
  const paidCents = transactions.reduce((sum, t) => sum + t.amount_cents, 0);
  const remainingCents = totalFeeCents - paidCents;

  let status = "unpaid";
  if (paidCents >= totalFeeCents && totalFeeCents > 0) status = "paid";
  else if (paidCents > totalFeeCents) status = "overpaid";
  else if (paidCents > 0) status = "partial";

  return {
    userId: user.id,
    memberCode: user.member_code,
    fullName: user.full_name,
    totalFee: totalFeeCents / 100,
    paid: paidCents / 100,
    remaining: remainingCents / 100,
    status,
    transactionCount: transactions.length,
  };
}

function toPaymentTransaction(row) {
  return {
    id: row.id,
    userId: row.user_id,
    amount: row.amount_cents / 100,
    date: row.payment_date,
    method: row.method,
    addedBy: row.added_by,
    addedByName: row.added_by_name,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

/** A Group's leadership team (Master Trainer + 2 TOTs) plus its Trainer roster. */
function toGroupSummary(group, leadershipRows, trainerRows) {
  const master = leadershipRows.find((r) => r.role === "master") || null;
  const tots = leadershipRows.filter((r) => r.role === "tot");

  return {
    id: group.id,
    name: group.name,
    masterTrainer: master
      ? { id: master.id, memberCode: master.member_code, fullName: master.full_name }
      : null,
    trainersInTraining: tots.map((t) => ({ id: t.id, memberCode: t.member_code, fullName: t.full_name })),
    trainerCount: trainerRows.length,
    trainers: trainerRows.map((t) => ({ id: t.id, memberCode: t.member_code, fullName: t.full_name })),
    createdAt: group.created_at,
    updatedAt: group.updated_at,
  };
}

module.exports = {
  toPublicUser,
  toProfileResponse,
  toTrainerSummary,
  toRecord,
  toDocument,
  toMessage,
  toProgressSummary,
  toMaterial,
  toAnnouncement,
  toPublicEvent,
  toPaymentSummary,
  toPaymentTransaction,
  toGroupSummary,
  getMasterTrainersForTrainer,
};
