// Guest Trainers (migration 038) -- the one place that knows how a
// session's "Hours Provided By" is resolved, validated, and written now
// that a provider can be either an internal trainer account
// (provided_by_supervisor_id) or an external Guest Trainer with no login
// (provided_by_guest_trainer_id). Every route that creates/edits a session
// validates through resolveProviders() below, and every query that
// attributes hours reads the internal provider through
// providerSupervisorIdSql(), so the two columns can never drift into
// "both set" or "guest set but still credited to the creator".
//
// Association with a Group (group_guest_trainers) and delivering a session
// are deliberately separate concepts -- see the migration's header comment.
// Neither one grants the guest any access to anything.

const MAX_NAME_LENGTH = 255;
const MAX_FIELD_LENGTH = 255;
const MAX_PHONE_LENGTH = 50;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * SQL expression for a row's INTERNAL provider (a supervisors.id), or NULL
 * when the row was delivered by an external Guest Trainer (migration 038)
 * or an External Trainer (migration 039). Replaces the bare
 * COALESCE(provided_by_supervisor_id, <creator>) migration 035 introduced
 * -- that fallback must never fire for a guest- or external-delivered row,
 * whose provided_by_supervisor_id is NULL on purpose.
 */
function providerSupervisorIdSql(alias, creatorCol = "supervisor_id") {
  return `IF(${alias}.provided_by_guest_trainer_id IS NULL AND ${alias}.provided_by_external_trainer_id IS NULL, COALESCE(${alias}.provided_by_supervisor_id, ${alias}.${creatorCol}), NULL)`;
}

/** SQL expression for a row's provider display name (guest, external, or internal). */
function providerNameSql(alias, creatorCol = "supervisor_id") {
  return `COALESCE(
    (SELECT gt_name.full_name FROM guest_trainers gt_name WHERE gt_name.id = ${alias}.provided_by_guest_trainer_id),
    (SELECT et_name.full_name FROM external_trainers et_name WHERE et_name.id = ${alias}.provided_by_external_trainer_id),
    (SELECT sp_name.full_name FROM supervisors sp_name WHERE sp_name.id = ${providerSupervisorIdSql(alias, creatorCol)})
  )`;
}

/** Trim, collapse internal whitespace, NFC-normalize (Arabic/Latin mixed names alike). */
function normalizeName(raw) {
  return String(raw == null ? "" : raw)
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim();
}
function nameKey(name) {
  return normalizeName(name).toLocaleLowerCase();
}
function optionalText(raw, max) {
  const v = normalizeName(raw);
  if (!v) return null;
  return v.length > max ? { error: true } : v;
}

/**
 * Validates/normalizes an external Guest Trainer's details. Returns
 * { value } or { error }.
 */
function validateGuestInput(input) {
  const body = input || {};
  const fullName = normalizeName(body.fullName);
  if (fullName.length < 2) return { error: "Guest Trainer name is required (at least 2 characters)" };
  if (fullName.length > MAX_NAME_LENGTH) return { error: "Guest Trainer name is too long" };

  let email = null;
  if (body.email != null && String(body.email).trim()) {
    email = String(body.email).trim().toLowerCase();
    if (email.length > MAX_FIELD_LENGTH || !EMAIL_RE.test(email)) return { error: "Please enter a valid email address" };
  }
  const phone = optionalText(body.phone, MAX_PHONE_LENGTH);
  const organization = optionalText(body.organization, MAX_FIELD_LENGTH);
  const specialization = optionalText(body.specialization, MAX_FIELD_LENGTH);
  if ((phone && phone.error) || (organization && organization.error) || (specialization && specialization.error)) {
    return { error: "One of the fields is too long" };
  }
  return { value: { fullName, nameKey: nameKey(fullName), email, phone, organization, specialization } };
}

/**
 * Finds this Group's existing external guest matching the same person
 * (same normalized name, or same email when one was given), or creates
 * one. Idempotent: a repeated/concurrent submission for the same person
 * resolves to the same row (uq_guest_owner_name backs the race).
 * Returns { guest, created } or { error }.
 */
async function findOrCreateGroupGuest(db, { groupId, createdBy, input }) {
  const checked = validateGuestInput(input);
  if (checked.error) return { error: checked.error };
  const g = checked.value;

  const findExisting = async () => {
    const { rows } = await db.query(
      `SELECT * FROM guest_trainers
        WHERE owner_group_id = ? AND (name_key = ? OR (? IS NOT NULL AND email = ?))
        ORDER BY (name_key = ?) DESC, id ASC LIMIT 1`,
      [groupId, g.nameKey, g.email, g.email, g.nameKey]
    );
    return rows[0] || null;
  };

  const existing = await findExisting();
  if (existing) return { guest: existing, created: false };

  try {
    const ins = await db.query(
      `INSERT INTO guest_trainers (full_name, name_key, email, phone, organization, specialization, owner_group_id, created_by)
       VALUES (?,?,?,?,?,?,?,?)`,
      [g.fullName, g.nameKey, g.email, g.phone, g.organization, g.specialization, groupId, createdBy || null]
    );
    const { rows } = await db.query("SELECT * FROM guest_trainers WHERE id = ?", [ins.insertId]);
    return { guest: rows[0], created: true };
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      const raced = await findExisting();
      if (raced) return { guest: raced, created: false };
    }
    throw err;
  }
}

/** Updates an external guest's details. Caller has already authorized access to this row. */
async function updateGuestDetails(db, guestId, input) {
  const checked = validateGuestInput(input);
  if (checked.error) return { error: checked.error };
  const g = checked.value;
  try {
    await db.query(
      `UPDATE guest_trainers SET full_name = ?, name_key = ?, email = ?, phone = ?, organization = ?, specialization = ? WHERE id = ?`,
      [g.fullName, g.nameKey, g.email, g.phone, g.organization, g.specialization, guestId]
    );
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") return { error: "Another Guest Trainer in this Group already has that name", status: 409 };
    throw err;
  }
  return { updated: true };
}

/**
 * Adds an association row. Returns { association } or { error, status }.
 * A duplicate (same person already associated with this Group) is a clean
 * 409, never a second row.
 */
async function addGroupAssociation(db, { groupId, guestTrainerId = null, supervisorId = null, addedBy }) {
  if ((guestTrainerId == null) === (supervisorId == null)) {
    return { error: "Exactly one of guestTrainerId / supervisorId is required", status: 400 };
  }
  try {
    const ins = await db.query(
      "INSERT INTO group_guest_trainers (group_id, guest_trainer_id, supervisor_id, added_by) VALUES (?,?,?,?)",
      [groupId, guestTrainerId, supervisorId, addedBy || null]
    );
    return { association: { id: ins.insertId, groupId, guestTrainerId, supervisorId } };
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") return { error: "This person is already a Guest Trainer for this Group", status: 409 };
    throw err;
  }
}

/**
 * Every Guest Trainer associated with a Group, external and internal, in
 * one normalized shape. Internal guests' member/role info is limited to
 * what a Group roster already shows (name, member code, status) -- no
 * contact details of another Group's trainer leak through this list.
 */
async function listGroupGuests(db, groupId, { includeContact = true } = {}) {
  const { rows } = await db.query(
    `SELECT ggt.id AS association_id, ggt.created_at AS associated_at,
            gt.id AS guest_trainer_id, gt.full_name AS guest_name, gt.email, gt.phone, gt.organization, gt.specialization,
            sup.id AS supervisor_id, sup.full_name AS supervisor_name, sup.supervisor_type, uc.member_code, uc.status AS account_status,
            home.name AS home_group_name
       FROM group_guest_trainers ggt
       LEFT JOIN guest_trainers gt ON gt.id = ggt.guest_trainer_id
       LEFT JOIN supervisors sup ON sup.id = ggt.supervisor_id
       LEFT JOIN user_credentials uc ON uc.id = sup.id
       LEFT JOIN trainer_groups home ON home.id = sup.group_id
      WHERE ggt.group_id = ?
      ORDER BY COALESCE(gt.full_name, sup.full_name)`,
    [groupId]
  );
  return rows.map((r) =>
    r.guest_trainer_id != null
      ? {
          associationId: r.association_id,
          kind: "external",
          guestTrainerId: r.guest_trainer_id,
          fullName: r.guest_name,
          email: includeContact ? r.email : undefined,
          phone: includeContact ? r.phone : undefined,
          organization: r.organization,
          specialization: r.specialization,
          associatedAt: r.associated_at,
        }
      : {
          associationId: r.association_id,
          kind: "internal",
          supervisorId: r.supervisor_id,
          fullName: r.supervisor_name,
          memberCode: r.member_code,
          accountStatus: r.account_status,
          role: r.supervisor_type === "primary" ? "Master Trainer" : "ToT",
          homeGroupName: r.home_group_name,
          associatedAt: r.associated_at,
        }
  );
}

/**
 * Everyone who may be selected as "Hours Provided By" on a session of this
 * Group, as option keys ("s:<supervisorId>" / "g:<guestTrainerId>"):
 *   - the Group's own Master Trainer + ToTs (unchanged from migration 035)
 *   - internal Guest Trainers associated with the Group
 *   - external Guest Trainers associated with the Group
 *   - external "session-only" trainers entered for this Group's sessions
 *     (owner_group_id = Group) who are not (or no longer) associated
 *   - External Trainers recorded for this Group (migration 039), key "e:<id>"
 */
async function getEligibleProviders(db, groupId) {
  if (!groupId) return [];
  const [membersRes, internalRes, externalRes, outsideRes] = await Promise.all([
    db.query(
      "SELECT id, full_name, supervisor_type FROM supervisors WHERE group_id = ? ORDER BY supervisor_type = 'primary' DESC, full_name",
      [groupId]
    ),
    db.query(
      `SELECT sup.id, sup.full_name FROM group_guest_trainers ggt JOIN supervisors sup ON sup.id = ggt.supervisor_id
        WHERE ggt.group_id = ? AND (sup.group_id IS NULL OR sup.group_id != ?) ORDER BY sup.full_name`,
      [groupId, groupId]
    ),
    db.query(
      `SELECT gt.id, gt.full_name, gt.organization,
              EXISTS (SELECT 1 FROM group_guest_trainers ggt WHERE ggt.group_id = ? AND ggt.guest_trainer_id = gt.id) AS associated
         FROM guest_trainers gt
        WHERE gt.owner_group_id = ? OR gt.id IN (SELECT guest_trainer_id FROM group_guest_trainers WHERE group_id = ? AND guest_trainer_id IS NOT NULL)
        ORDER BY gt.full_name`,
      [groupId, groupId, groupId]
    ),
    // External Trainers (migration 039) -- a separate provider kind, never
    // on a Group roster; scoped to the Group they were recorded for.
    db.query("SELECT id, full_name, organization FROM external_trainers WHERE owner_group_id = ? ORDER BY full_name", [groupId]),
  ]);
  const out = membersRes.rows.map((r) => ({
    key: `s:${r.id}`,
    kind: "member",
    supervisorId: Number(r.id),
    name: r.full_name,
    role: r.supervisor_type === "primary" ? "Master Trainer" : "ToT",
  }));
  for (const r of internalRes.rows) {
    out.push({ key: `s:${r.id}`, kind: "internal_guest", supervisorId: Number(r.id), name: r.full_name, role: "Guest Trainer" });
  }
  for (const r of externalRes.rows) {
    const associated = r.associated === true || Number(r.associated) === 1;
    out.push({
      key: `g:${r.id}`,
      kind: associated ? "external_guest" : "session_only",
      guestTrainerId: Number(r.id),
      name: r.full_name,
      organization: r.organization,
      role: associated ? "Guest Trainer" : "External Trainer",
    });
  }
  for (const r of outsideRes.rows) {
    out.push({
      key: `e:${r.id}`,
      kind: "external",
      externalTrainerId: Number(r.id),
      name: r.full_name,
      organization: r.organization,
      role: "External Trainer",
    });
  }
  return out;
}

function toPositiveIntOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : NaN;
}

/** Reads one provider choice off an object ({providedBySupervisorId, providedByGuestTrainerId, providedByExternalTrainerId}). */
function readChoice(obj) {
  if (!obj) return null;
  const sup = toPositiveIntOrNull(obj.providedBySupervisorId);
  const guest = toPositiveIntOrNull(obj.providedByGuestTrainerId);
  const ext = toPositiveIntOrNull(obj.providedByExternalTrainerId);
  if (Number.isNaN(sup) || Number.isNaN(guest) || Number.isNaN(ext)) return { invalid: true };
  if ([sup, guest, ext].filter((v) => v != null).length > 1) return { invalid: true, both: true };
  if (sup != null) return { supervisorId: sup, guestTrainerId: null, externalTrainerId: null };
  if (guest != null) return { supervisorId: null, guestTrainerId: guest, externalTrainerId: null };
  if (ext != null) return { supervisorId: null, guestTrainerId: null, externalTrainerId: ext };
  return null;
}

/** "s:<id>" / "g:<id>" / "e:<id>" for a provider choice. */
function choiceKey(c) {
  if (c.externalTrainerId != null) return `e:${Number(c.externalTrainerId)}`;
  if (c.guestTrainerId != null) return `g:${Number(c.guestTrainerId)}`;
  return `s:${Number(c.supervisorId)}`;
}

/**
 * Validates every provider referenced by a create/edit request -- the
 * top-level one and each day's own override -- against the Group's
 * eligible providers, BEFORE anything is written.
 *
 * `existing` lists provider choices already stored on the record being
 * edited ({supervisorId, guestTrainerId} pairs); re-submitting one of those
 * unchanged is always allowed, so editing an old session's date never
 * fails just because its provider has since left the Group or had their
 * Guest association removed -- removing an association must never block
 * or rewrite historical attribution.
 *
 * Returns { top, days } (each a {supervisorId, guestTrainerId, externalTrainerId} or null =
 * "not specified") or { error }.
 */
async function resolveProviders(db, { groupId, body, days, existing = [] }) {
  const top = readChoice(body);
  if (top && top.invalid) {
    return { error: top.both ? "Choose only one provider: an internal trainer, a Guest Trainer, or an External Trainer" : "Invalid provider" };
  }
  const dayChoices = [];
  if (Array.isArray(days)) {
    for (const day of days) {
      const c = readChoice(day);
      if (c && c.invalid) {
        return { error: c.both ? "Choose only one provider: an internal trainer, a Guest Trainer, or an External Trainer" : "Invalid provider" };
      }
      dayChoices.push(c);
    }
  }

  const all = [top, ...dayChoices].filter(Boolean);
  if (!all.length) return { top: null, days: dayChoices };

  const eligible = new Set((await getEligibleProviders(db, groupId)).map((p) => p.key));
  for (const e of existing) {
    if (!e) continue;
    if (e.externalTrainerId != null) eligible.add(`e:${Number(e.externalTrainerId)}`);
    else if (e.guestTrainerId != null) eligible.add(`g:${Number(e.guestTrainerId)}`);
    else if (e.supervisorId != null) eligible.add(`s:${Number(e.supervisorId)}`);
  }
  for (const c of all) {
    if (!eligible.has(choiceKey(c))) return { error: "That person isn't an authorized provider for this Group" };
  }
  return { top, days: dayChoices };
}

/**
 * Copies `days` with each day's provider replaced by its validated choice
 * (from resolveProviders), so the write path only ever sees normalized,
 * already-authorized ids -- never the raw client values.
 */
function applyDayProviders(days, dayChoices) {
  return days.map((day, i) => {
    const c = dayChoices[i];
    return {
      ...day,
      providedBySupervisorId: c ? c.supervisorId : null,
      providedByGuestTrainerId: c ? c.guestTrainerId : null,
      providedByExternalTrainerId: c ? c.externalTrainerId : null,
    };
  });
}

/**
 * Stored provider pairs on an occasion (and, when it belongs to a series,
 * on the series and every sibling day) -- the `existing` input for
 * resolveProviders on an edit. Only rows the caller created are read.
 */
async function existingProvidersForOccasion(db, occasionId, creatorId) {
  const { rows } = await db.query(
    `SELECT provided_by_supervisor_id AS s, provided_by_guest_trainer_id AS g, provided_by_external_trainer_id AS e FROM session_occasions WHERE id = ? AND supervisor_id = ?`,
    [occasionId, creatorId]
  );
  return rows.map((r) => ({ supervisorId: r.s, guestTrainerId: r.g, externalTrainerId: r.e }));
}
async function existingProvidersForSeries(db, seriesId, creatorId) {
  const { rows } = await db.query(
    `SELECT provided_by_supervisor_id AS s, provided_by_guest_trainer_id AS g, provided_by_external_trainer_id AS e FROM session_series WHERE id = ? AND supervisor_id = ?
     UNION ALL
     SELECT so.provided_by_supervisor_id, so.provided_by_guest_trainer_id, so.provided_by_external_trainer_id FROM session_occasions so
       JOIN session_series ss ON ss.id = so.series_id
      WHERE so.series_id = ? AND ss.supervisor_id = ?`,
    [seriesId, creatorId, seriesId, creatorId]
  );
  return rows.map((r) => ({ supervisorId: r.s, guestTrainerId: r.g, externalTrainerId: r.e }));
}

/** Consistent API shape for a stored provider. */
function providerPayload(row, prefix = "provided_by") {
  const guestId = row[`${prefix}_guest_id`];
  const externalId = row[`${prefix}_external_id`];
  return {
    id: guestId != null || externalId != null ? null : row[`${prefix}_id`],
    guestTrainerId: guestId != null ? guestId : null,
    isGuest: guestId != null,
    externalTrainerId: externalId != null ? externalId : null,
    isExternal: externalId != null,
    name: row[`${prefix}_name`],
  };
}

// ---- External Trainers (migration 039) -------------------------------------
// A separate provider kind from Guest Trainers: a person from outside the
// organization/Group, recorded from a session form, never on any Group
// roster, with no login and no access. Same validation/normalization and
// Group-scoped, idempotent find-or-create as Guest Trainers, but its own
// table -- the Guest Trainer functions above are not used or changed here.

/** Finds this Group's matching External Trainer (normalized name, or email) or creates one. */
async function findOrCreateGroupExternal(db, { groupId, createdBy, input }) {
  const checked = validateGuestInput(input);
  if (checked.error) return { error: checked.error.replace("Guest Trainer", "External Trainer") };
  const g = checked.value;
  const findExisting = async () => {
    const { rows } = await db.query(
      `SELECT * FROM external_trainers
        WHERE owner_group_id = ? AND (name_key = ? OR (? IS NOT NULL AND email = ?))
        ORDER BY (name_key = ?) DESC, id ASC LIMIT 1`,
      [groupId, g.nameKey, g.email, g.email, g.nameKey]
    );
    return rows[0] || null;
  };
  const existing = await findExisting();
  if (existing) return { external: existing, created: false };
  try {
    const ins = await db.query(
      `INSERT INTO external_trainers (full_name, name_key, organization, email, phone, specialization, owner_group_id, created_by)
       VALUES (?,?,?,?,?,?,?,?)`,
      [g.fullName, g.nameKey, g.organization, g.email, g.phone, g.specialization, groupId, createdBy || null]
    );
    const { rows } = await db.query("SELECT * FROM external_trainers WHERE id = ?", [ins.insertId]);
    return { external: rows[0], created: true };
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      const raced = await findExisting();
      if (raced) return { external: raced, created: false };
    }
    throw err;
  }
}

/** Updates an External Trainer's details. Caller has already authorized access to this row. */
async function updateExternalDetails(db, externalTrainerId, input) {
  const checked = validateGuestInput(input);
  if (checked.error) return { error: checked.error.replace("Guest Trainer", "External Trainer") };
  const g = checked.value;
  try {
    await db.query(
      `UPDATE external_trainers SET full_name = ?, name_key = ?, organization = ?, email = ?, phone = ?, specialization = ? WHERE id = ?`,
      [g.fullName, g.nameKey, g.organization, g.email, g.phone, g.specialization, externalTrainerId]
    );
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") return { error: "Another External Trainer in this Group already has that name", status: 409 };
    throw err;
  }
  return { updated: true };
}

/** Every External Trainer recorded for a Group, with how many Session rows (days) they delivered. */
async function listGroupExternals(db, groupId) {
  const { rows } = await db.query(
    `SELECT et.id, et.full_name, et.organization, et.email, et.phone, et.specialization, et.created_at,
            (SELECT COUNT(*) FROM session_occasions so WHERE so.provided_by_external_trainer_id = et.id) +
            (SELECT COUNT(*) FROM sessions s WHERE s.provided_by_external_trainer_id = et.id AND s.occasion_id IS NULL) +
            (SELECT COUNT(*) FROM tot_session_occasions tso WHERE tso.provided_by_external_trainer_id = et.id) AS sessions_delivered
       FROM external_trainers et
      WHERE et.owner_group_id = ?
      ORDER BY et.full_name`,
    [groupId]
  );
  return rows.map((r) => ({
    externalTrainerId: r.id,
    fullName: r.full_name,
    organization: r.organization,
    email: r.email,
    phone: r.phone,
    specialization: r.specialization,
    sessionsDelivered: Number(r.sessions_delivered),
    createdAt: r.created_at,
  }));
}

module.exports = {
  providerSupervisorIdSql,
  providerNameSql,
  normalizeName,
  nameKey,
  validateGuestInput,
  findOrCreateGroupGuest,
  updateGuestDetails,
  addGroupAssociation,
  listGroupGuests,
  getEligibleProviders,
  resolveProviders,
  applyDayProviders,
  existingProvidersForOccasion,
  existingProvidersForSeries,
  providerPayload,
  findOrCreateGroupExternal,
  updateExternalDetails,
  listGroupExternals,
};
