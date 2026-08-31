// Shared by routes/supervisor.js (a Trainer's own assignments) and
// routes/profile.js (a Trainee's own assignments) -- one query shape, one
// mapping function, so the two "assignment + its latest submission" views
// can never drift out of sync with each other.

const ASSIGNMENT_WITH_SUBMISSION_SELECT = `
  SELECT a.*, st.full_name AS student_name, sup.full_name AS trainer_name,
         sub.id AS submission_id, sub.filename AS submission_filename, sub.original_name AS submission_original_name,
         sub.notes AS submission_notes, sub.submitted_at, sub.score, sub.feedback, sub.status AS submission_status
  FROM assignments a
  JOIN students st ON st.id = a.student_id
  JOIN supervisors sup ON sup.id = a.supervisor_id
  LEFT JOIN assignment_submissions sub ON sub.id = (
    -- id DESC as a tiebreaker: submitted_at has only second-level
    -- precision, so two submissions landing in the same second would
    -- otherwise make "which one is latest" non-deterministic.
    SELECT id FROM assignment_submissions WHERE assignment_id = a.id ORDER BY submitted_at DESC, id DESC LIMIT 1
  )
`;

/** Maps one row from ASSIGNMENT_WITH_SUBMISSION_SELECT into the API shape,
 *  including a live-computed status (nothing in the app ever sets
 *  status='overdue' in the DB, same convention used on the Master Trainer
 *  dashboard's assignment overview). */
function assignmentRowToApi(r) {
  const item = {
    id: r.id,
    title: r.title,
    description: r.description,
    dueDate: r.due_date,
    attachmentFilename: r.attachment_filename,
    contentUrl: r.content_url,
    status: r.status,
    maxScore: r.max_score,
    studentId: r.student_id,
    studentName: r.student_name,
    trainerName: r.trainer_name,
    createdAt: r.created_at,
    submission: r.submission_id
      ? {
          id: r.submission_id,
          filename: r.submission_filename,
          originalName: r.submission_original_name,
          notes: r.submission_notes,
          submittedAt: r.submitted_at,
          score: r.score,
          feedback: r.feedback,
          status: r.submission_status,
        }
      : null,
  };

  const todayStr = new Date().toISOString().slice(0, 10);
  if (item.status !== "completed" && item.dueDate && String(item.dueDate).slice(0, 10) < todayStr) {
    item.status = item.submission ? "submitted" : "overdue";
  } else if (item.submission && item.status === "pending") {
    item.status = "submitted";
  }
  return item;
}

/**
 * Attaches full submission history (`.submissions`, oldest first, each
 * flagged `isCurrent` for the latest) to every item in `items`, via one
 * batched query rather than one per assignment. Every resubmission
 * INSERTs a new assignment_submissions row instead of overwriting the
 * previous one, so a prior grade/feedback is never actually lost in the
 * database -- but `submission` above only ever shows the latest attempt,
 * which made an earlier grade effectively invisible the moment a trainee
 * resubmitted. Both the list and single-assignment routes call this (the
 * frontend reads assignment detail out of the already-fetched list, not a
 * separate per-assignment request, so the list is where this has to live
 * to actually reach the UI).
 */
async function attachSubmissionHistories(db, items) {
  if (!items.length) return items;
  const ids = items.map((i) => i.id);
  const { sql: inSql, params: inParams } = { sql: ids.map(() => "?").join(","), params: ids };
  // id ASC as a tiebreaker alongside submitted_at ASC, matching
  // ASSIGNMENT_WITH_SUBMISSION_SELECT's own tiebreak exactly -- otherwise
  // the two queries could disagree on which submission is "current" when
  // two attempts land in the same second (submitted_at has no
  // sub-second precision).
  const { rows } = await db.query(
    `SELECT * FROM assignment_submissions WHERE assignment_id IN (${inSql}) ORDER BY assignment_id, submitted_at ASC, id ASC`,
    inParams
  );
  const byAssignment = {};
  rows.forEach((r) => {
    (byAssignment[r.assignment_id] = byAssignment[r.assignment_id] || []).push(r);
  });
  items.forEach((item) => {
    const subs = byAssignment[item.id] || [];
    item.submissions = subs.map((r, i) => ({
      id: r.id,
      filename: r.filename,
      originalName: r.original_name,
      notes: r.notes,
      submittedAt: r.submitted_at,
      score: r.score,
      feedback: r.feedback,
      status: r.status,
      isCurrent: i === subs.length - 1,
    }));
  });
  return items;
}

module.exports = { ASSIGNMENT_WITH_SUBMISSION_SELECT, assignmentRowToApi, attachSubmissionHistories };
