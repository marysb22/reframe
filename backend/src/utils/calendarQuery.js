const { createNotification, getUserContactInfo } = require("./notifications");

// Shared "activities in a date range, for the Calendar" queries -- one
// implementation reused by all four roles (ToT/ Master Trainer/ Admin/
// Trainee), each calling in with a different `scope`, rather than four
// independent copies of the same SQL with four different WHERE clauses to
// keep in sync. Every function returns plain rows shaped for the Calendar
// widget's own calItems array (date/title/type + enough identifying info
// to navigate to the real resource on click) -- never a new, separate
// "calendar record" table; this only ever reads the existing tables that
// already are each activity's real source of truth.
//
// Date semantics (confirmed from the actual schema before writing this,
// not assumed): Materials and Documents have no business-relevant date
// other than `created_at` -- there is no due/scheduled date column on
// either table, so "the date it was added" is the only real date, not an
// invented one. Assignments do have a real `due_date`, which is what's
// used here (not `created_at`) -- a due date is what's actually relevant
// to see on a calendar. Sessions use `session_date` (already the
// business date, handled below with the Group-Session occasion-vs-
// standalone split every other hours/activity query in this app already
// uses, so a multi-day Session's days each land on their own real date and
// a Group Session is never double-counted).

/** scope: { kind: 'supervisor'|'group'|'system'|'student', id?, groupId? } */
function scopeSql(column, scope) {
  if (scope.kind === "supervisor") return { clause: `${column} = ?`, params: [scope.id] };
  if (scope.kind === "group") return { clause: `${column} IN (SELECT id FROM supervisors WHERE group_id = ?)`, params: [scope.groupId] };
  if (scope.kind === "student") return { clause: `${column} = ?`, params: [scope.id] };
  return { clause: "1=1", params: [] }; // system: no restriction, Admin sees everything
}

async function getSessionsInRange(db, scope, start, end) {
  const supCol = "supervisor_id";
  if (scope.kind === "student") {
    const { rows } = await db.query(
      `SELECT s.id, s.session_type, s.title, s.session_date AS date, s.session_time AS time, s.duration_minutes
       FROM sessions s
       WHERE s.student_id = ? AND s.status != 'cancelled' AND s.session_date BETWEEN ? AND ?`,
      [scope.id, start, end]
    );
    return rows.map((r) => ({ type: "session", id: r.id, date: String(r.date), time: r.time, title: r.title || "Training activity" }));
  }
  const { clause, params } = scopeSql(supCol, scope);
  const [occasionsRes, standaloneRes] = await Promise.all([
    db.query(
      `SELECT so.id, so.title, so.session_date AS date, so.session_time AS time, so.series_id, so.supervisor_id
       FROM session_occasions so WHERE ${clause.replace(supCol, "so." + supCol)} AND so.session_date BETWEEN ? AND ?`,
      [...params, start, end]
    ),
    db.query(
      `SELECT s.id, s.title, s.session_date AS date, s.session_time AS time, s.supervisor_id
       FROM sessions s WHERE ${clause.replace(supCol, "s." + supCol)} AND s.occasion_id IS NULL AND s.status != 'cancelled' AND s.session_date BETWEEN ? AND ?`,
      [...params, start, end]
    ),
  ]);
  return [
    // kind/seriesId tell the caller whether a click should open the single-
    // day occasion editor or the whole multi-day series editor; supervisorId
    // lets a Master Trainer's group-wide view tell her own Group Sessions
    // apart from a ToT's (only the former has an edit UI on her dashboard).
    ...occasionsRes.rows.map((r) => ({
      type: "session",
      id: r.id,
      date: String(r.date),
      time: r.time,
      title: r.title || "Group Session",
      kind: r.series_id ? "series_day" : "occasion",
      seriesId: r.series_id || null,
      supervisorId: r.supervisor_id,
    })),
    ...standaloneRes.rows.map((r) => ({
      type: "session",
      id: r.id,
      date: String(r.date),
      time: r.time,
      title: r.title || "Training activity",
      kind: "single",
      seriesId: null,
      supervisorId: r.supervisor_id,
    })),
  ];
}

async function getMaterialsInRange(db, scope, start, end) {
  const col = scope.kind === "student" ? "student_id" : "supervisor_id";
  const { clause, params } = scopeSql(col, scope);
  const { rows } = await db.query(
    `SELECT id, title, DATE(created_at) AS date FROM learning_materials
     WHERE ${clause} AND material_type != 'book' AND DATE(created_at) BETWEEN ? AND ?`,
    [...params, start, end]
  );
  return rows.map((r) => ({ type: "material", id: r.id, date: String(r.date), title: r.title || "Learning material" }));
}

// documents has no `title` column (it's an uploaded file) -- original_name
// is the closest real field to show, falling back to document_type.
async function getDocumentsInRange(db, scope, start, end) {
  if (scope.kind === "group") {
    // A document can be targeted at one specific trainee (student_id set,
    // its OWN group_id reached via that trainee) or shared at the whole
    // Group level directly (documents.group_id set, student_id NULL) --
    // matches both shapes, same as routes/files.js's own authorizer for
    // this exact table.
    const { rows } = await db.query(
      `SELECT d.id, COALESCE(d.original_name, d.document_type) AS title, DATE(d.created_at) AS date FROM documents d
       LEFT JOIN students st ON st.id = d.student_id
       WHERE (st.group_id = ? OR d.group_id = ?) AND DATE(d.created_at) BETWEEN ? AND ?`,
      [scope.groupId, scope.groupId, start, end]
    );
    return rows.map((r) => ({ type: "document", id: r.id, date: String(r.date), title: r.title || "Document" }));
  }
  const col = scope.kind === "student" ? "student_id" : "uploaded_by";
  const { clause, params } = scopeSql(col, scope);
  const { rows } = await db.query(
    `SELECT id, COALESCE(original_name, document_type) AS title, DATE(created_at) AS date FROM documents WHERE ${clause} AND DATE(created_at) BETWEEN ? AND ?`,
    [...params, start, end]
  );
  return rows.map((r) => ({ type: "document", id: r.id, date: String(r.date), title: r.title || "Document" }));
}

async function getAssignmentsInRange(db, scope, start, end) {
  const col = scope.kind === "student" ? "student_id" : "supervisor_id";
  const { clause, params } = scopeSql(col, scope);
  const { rows } = await db.query(
    `SELECT id, title, due_date AS date FROM assignments
     WHERE ${clause} AND due_date IS NOT NULL AND due_date BETWEEN ? AND ?`,
    [...params, start, end]
  );
  return rows.map((r) => ({ type: "assignment", id: r.id, date: String(r.date), title: r.title || "Assignment" }));
}

async function getMeetingsInRange(db, scope, start, end) {
  let where, params;
  if (scope.kind === "supervisor") {
    where = "(m.supervisor_id = ? OR m.target_supervisor_id = ? OR m.target_group_id = (SELECT group_id FROM supervisors WHERE id = ?))";
    params = [scope.id, scope.id, scope.id];
  } else if (scope.kind === "group") {
    where = "(m.target_group_id = ? OR m.supervisor_id IN (SELECT id FROM supervisors WHERE group_id = ?))";
    params = [scope.groupId, scope.groupId];
  } else if (scope.kind === "student") {
    where = "m.student_id = ?";
    params = [scope.id];
  } else {
    where = "1=1";
    params = [];
  }
  const { rows } = await db.query(
    `SELECT m.id, m.title, DATE(m.scheduled_at) AS date FROM meetings m
     WHERE ${where} AND m.scheduled_at IS NOT NULL AND DATE(m.scheduled_at) BETWEEN ? AND ?`,
    [...params, start, end]
  );
  return rows.map((r) => ({ type: "meeting", id: r.id, date: String(r.date), title: r.title || "Meeting" }));
}

/** calendar_events ("Notes") -- read scope mirrors the existing
 *  per-role convention already established for this table before this
 *  feature (Master Trainer already sees her whole Group's notes, a ToT
 *  only her own) -- Admin/system sees every note, a trainee sees notes
 *  either targeted at them specifically or at their whole caseload/group
 *  (student_id IS NULL, owned by their own assigned supervisor(s)). */
async function getNotesInRange(db, scope, start, end) {
  let where, params;
  if (scope.kind === "supervisor") {
    where = "ce.owner_id = ?";
    params = [scope.id];
  } else if (scope.kind === "group") {
    where = "ce.owner_id IN (SELECT id FROM supervisors WHERE group_id = ?)";
    params = [scope.groupId];
  } else if (scope.kind === "student") {
    where = "(ce.student_id = ? OR (ce.student_id IS NULL AND ce.owner_id IN (SELECT supervisor_id FROM supervisor_students WHERE student_id = ?)))";
    params = [scope.id, scope.id];
  } else {
    where = "1=1";
    params = [];
  }
  const { rows } = await db.query(
    `SELECT ce.id, ce.title, ce.event_date AS date FROM calendar_events ce
     WHERE ${where} AND ce.event_date BETWEEN ? AND ?`,
    [...params, start, end]
  );
  return rows.map((r) => ({ type: "note", id: r.id, date: String(r.date), title: r.title }));
}

/**
 * Notifies (in-app + email, same as notifyMaterialRecipients in
 * supervisor.js) whichever trainee(s) would actually SEE this Note on
 * their own Calendar -- recipient resolution deliberately mirrors
 * getNotesInRange's student-scope WHERE clause above exactly, so "who
 * gets notified" never drifts from "who can see it":
 *   - studentId set -> that one trainee.
 *   - studentId null, owner is a supervisor (ToT or Master Trainer) ->
 *     every trainee assigned to that supervisor (their whole caseload --
 *     matches getNotesInRange's `ce.owner_id IN (SELECT supervisor_id
 *     FROM supervisor_students ...)` check).
 *   - studentId null, owner is Admin -> no trainee could see this note
 *     via getNotesInRange's own rule either (Admin never appears in
 *     supervisor_students), so there is nothing to notify -- not a bug,
 *     just nobody to tell.
 * Called from inside each POST /calendar-events handler (supervisor.js,
 * Mastertrainer.js, admin.js), with `db` = the request's own transactional
 * client, awaited before the handler returns -- same convention every
 * other createNotification call site in this app already uses.
 */
async function notifyCalendarNoteRecipients(db, ownerId, studentId, title, noteId, eventDate) {
  let recipientIds;
  if (studentId) {
    recipientIds = [Number(studentId)];
  } else {
    const { rows } = await db.query("SELECT student_id FROM supervisor_students WHERE supervisor_id = ?", [ownerId]);
    recipientIds = rows.map((r) => r.student_id);
  }
  if (!recipientIds.length) return;

  const owner = await getUserContactInfo(db, ownerId);
  const trainerName = (owner && owner.fullName) || "Your trainer";
  const results = await Promise.allSettled(
    recipientIds.map((recipientId) =>
      createNotification(db, {
        recipientId,
        type: "document",
        title: `New Calendar note: ${title}`,
        relatedEntityType: "calendar_event",
        relatedEntityId: noteId,
        email: { template: "newCalendarNote", data: { noteTitle: title, trainerName, noteDate: eventDate } },
      })
    )
  );
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length) {
    console.error(`notifyCalendarNoteRecipients: ${failed.length}/${recipientIds.length} notifications failed for note ${noteId}`, failed.map((f) => f.reason));
  }
}

module.exports = {
  getSessionsInRange,
  getMaterialsInRange,
  getDocumentsInRange,
  getAssignmentsInRange,
  getMeetingsInRange,
  getNotesInRange,
  notifyCalendarNoteRecipients,
};
