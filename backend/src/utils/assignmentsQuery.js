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
    SELECT id FROM assignment_submissions WHERE assignment_id = a.id ORDER BY submitted_at DESC LIMIT 1
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

module.exports = { ASSIGNMENT_WITH_SUBMISSION_SELECT, assignmentRowToApi };
