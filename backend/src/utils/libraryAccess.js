// Library download approval (migration 041) -- the ONE place that decides
// whether an account may receive a Library book's file bytes, and who may
// review a download request. Used by routes/library.js (listing, requests,
// decisions) and routes/files.js (the only route that serves the bytes),
// so the button state shown in the UI and the real file check can never
// disagree.
//
// Who downloads WITHOUT a request (existing permissions, not new ones):
//   - Admin            -- full Library access already (library.* codes)
//   - Master Trainer   -- supervisors.supervisor_type = 'primary'
//   - the book's own uploader (a ToT who added it already holds the file)
// Everyone else (ToT / Trainee / Designer) needs an APPROVED request for
// that exact file, filed under their own account, and the file's content
// (file_hash) must still be the content that was approved.
//
// Who reviews a request:
//   - an Admin holding admin_permissions 'library.approve_downloads'
//   - a Master Trainer whose own group_id equals the request's group_id
//     (the requester's Group when they asked). A request with no Group
//     (an ungrouped account) is reviewable by Admin only.
// A reviewer can never be the requester (Admin/Master Trainer never need
// to request in the first place, and the check is explicit anyway).

const ROLE_LABELS = { trainee: "Trainee", tot: "Trainer (ToT)", master_trainer: "Master Trainer", designer: "Designer", admin: "Admin" };

/** Resolves the caller's effective Library role + Group. */
async function describeUser(db, user) {
  if (user.role === "admin") {
    const { rows } = await db.query("SELECT full_name FROM admin_users WHERE id = ?", [user.id]);
    return { kind: "admin", name: (rows[0] && rows[0].full_name) || user.member_code, groupId: null };
  }
  if (user.role === "supervisor") {
    const { rows } = await db.query(
      `SELECT s.full_name, s.supervisor_type, s.group_id, mt.group_id AS mt_group_id
         FROM supervisors s LEFT JOIN supervisors mt ON mt.id = s.primary_supervisor_id
        WHERE s.id = ?`,
      [user.id]
    );
    const r = rows[0] || {};
    const isMaster = r.supervisor_type === "primary";
    return {
      kind: isMaster ? "master_trainer" : "tot",
      name: r.full_name || user.member_code,
      groupId: r.group_id != null ? Number(r.group_id) : r.mt_group_id != null ? Number(r.mt_group_id) : null,
    };
  }
  if (user.role === "trainee") {
    const { rows } = await db.query("SELECT full_name, group_id FROM students WHERE id = ?", [user.id]);
    const r = rows[0] || {};
    return { kind: "trainee", name: r.full_name || user.member_code, groupId: r.group_id != null ? Number(r.group_id) : null };
  }
  if (user.role === "designer") {
    const { rows } = await db.query("SELECT full_name FROM designers WHERE id = ?", [user.id]);
    return { kind: "designer", name: (rows[0] && rows[0].full_name) || user.member_code, groupId: null };
  }
  return { kind: "other", name: user.member_code, groupId: null };
}

/** True if this account downloads every Library book without a request. */
function bypassesApproval(who) {
  return who.kind === "admin" || who.kind === "master_trainer";
}

/**
 * Library access for one account on many books at once (the list view).
 * Returns Map(bookId -> { required, status, requestId, rejectionReason, requestedAt, decidedAt }).
 *   status: 'granted' (no approval needed) | 'approved' | 'pending' | 'rejected' | 'none'
 * Only the account's LATEST request per book counts, and an approval whose
 * file_hash no longer matches the book's current file is ignored.
 */
async function accessForBooks(db, user, who, books) {
  const out = new Map();
  if (!books.length) return out;
  if (bypassesApproval(who)) {
    for (const b of books) out.set(Number(b.id), { required: false, status: "granted" });
    return out;
  }
  const ids = books.map((b) => Number(b.id));
  const { rows } = await db.query(
    `SELECT r.id, r.requested_material_id, r.status, r.file_hash, r.rejection_reason, r.created_at, r.decided_at
       FROM library_download_requests r
      WHERE r.requester_id = ? AND r.requested_material_id IN (?)
      ORDER BY r.id DESC`,
    [user.id, ids]
  );
  const byBook = new Map();
  for (const r of rows) {
    const key = Number(r.requested_material_id);
    if (!byBook.has(key)) byBook.set(key, []);
    byBook.get(key).push(r);
  }
  for (const b of books) {
    const id = Number(b.id);
    if (b.supervisor_id != null && Number(b.supervisor_id) === Number(user.id)) {
      out.set(id, { required: false, status: "granted" });
      continue;
    }
    const list = byBook.get(id) || [];
    // An approval only counts for the content it was given for.
    const approved = list.find((r) => r.status === "approved" && sameHash(r.file_hash, b.file_hash));
    const latest = list.find((r) => r.status !== "cancelled" && !(r.status === "approved" && !sameHash(r.file_hash, b.file_hash)));
    const pick = approved || latest;
    if (!pick) {
      out.set(id, { required: true, status: "none" });
      continue;
    }
    out.set(id, {
      required: true,
      status: pick.status,
      requestId: pick.id,
      rejectionReason: pick.status === "rejected" ? pick.rejection_reason : null,
      requestedAt: pick.created_at,
      decidedAt: pick.decided_at,
    });
  }
  return out;
}

function sameHash(a, b) {
  return (a || null) === (b || null);
}

/**
 * The file-route check. `book` is a learning_materials row (material_type
 * 'book'). True only for a bypass role, the uploader, or an approved
 * request by THIS user for THIS book whose file_hash still matches.
 */
async function canReceiveBookFile(db, user, book) {
  if (user.role === "admin") return true;
  if (user.role === "supervisor") {
    if (book.supervisor_id != null && Number(book.supervisor_id) === Number(user.id)) return true;
    const { rows } = await db.query("SELECT supervisor_type FROM supervisors WHERE id = ?", [user.id]);
    if (rows.length && rows[0].supervisor_type === "primary") return true;
  }
  const { rows } = await db.query(
    `SELECT 1 FROM library_download_requests
      WHERE requester_id = ? AND material_id = ? AND status = 'approved'
        AND (file_hash <=> ?)
      LIMIT 1`,
    [user.id, book.id, book.file_hash || null]
  );
  return rows.length > 0;
}

/** Admin reviewer permission (granular, like every library.* code). */
async function adminCanReview(db, adminId) {
  const { rows } = await db.query(
    "SELECT 1 FROM admin_permissions WHERE admin_id = ? AND permission_code = 'library.approve_downloads'",
    [adminId]
  );
  return rows.length > 0;
}

/**
 * The reviewer's scope as a SQL fragment over alias `r`, or null when the
 * account may not review anything. Used for the list, the count, the
 * detail view and the decision itself, so all four agree.
 */
async function reviewerScope(db, user, who) {
  if (who.kind === "admin") {
    return (await adminCanReview(db, user.id)) ? { sql: "1 = 1", params: [] } : null;
  }
  if (who.kind === "master_trainer") {
    if (who.groupId == null) return null;
    return { sql: "r.group_id = ?", params: [who.groupId] };
  }
  return null;
}

/** Every account that should get a notification for a new request. */
async function reviewersFor(db, groupId) {
  const { rows: admins } = await db.query(
    `SELECT ap.admin_id AS id FROM admin_permissions ap
       JOIN user_credentials uc ON uc.id = ap.admin_id AND uc.status = 'active'
      WHERE ap.permission_code = 'library.approve_downloads'`
  );
  let masters = [];
  if (groupId != null) {
    const { rows } = await db.query(
      `SELECT s.id FROM supervisors s JOIN user_credentials uc ON uc.id = s.id AND uc.status = 'active'
        WHERE s.supervisor_type = 'primary' AND s.group_id = ?`,
      [groupId]
    );
    masters = rows;
  }
  return [...new Set([...admins, ...masters].map((r) => Number(r.id)))];
}

module.exports = {
  ROLE_LABELS,
  describeUser,
  bypassesApproval,
  accessForBooks,
  canReceiveBookFile,
  reviewerScope,
  reviewersFor,
};
