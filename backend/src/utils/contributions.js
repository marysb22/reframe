// Several trainers on ONE training day (migration 040). A day's trainers
// are sequential: each contribution is { provider, title, minutes } and the
// day's duration is the SUM of its contributions. Every session shape has
// a parent kind here; a parent with NO contribution rows is a legacy
// record and keeps its single provided_by_* provider credited with its
// whole duration -- nothing is backfilled or guessed.
//
// This module is the single place that:
//   - normalizes/validates a submitted contribution list,
//   - writes it (replace-all, inside the caller's transaction),
//   - loads it back for display, and
//   - builds the "who delivered how many hours" credit rows every
//     hours/attribution query reads (creditRowsSql), so an hour is always
//     credited exactly once: from contributions when a parent has them,
//     from the legacy provider otherwise -- never both.

const { resolveProviders, providerNameSql } = require("./guestTrainers");

const PARENTS = {
  occasion: { col: "occasion_id", table: "session_occasions" },
  session: { col: "session_id", table: "sessions" },
  tot_occasion: { col: "tot_occasion_id", table: "tot_session_occasions" },
  tot_session: { col: "tot_session_id", table: "tot_training_sessions" },
};
const MAX_CONTRIBUTIONS = 20;

function parseList(raw) {
  if (raw == null || raw === "") return undefined;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return { error: "contributions must be valid JSON" };
    }
  }
  return raw;
}

function toPositiveIntOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : NaN;
}

/**
 * Normalizes a submitted contribution list. Returns undefined when the
 * request didn't send one (legacy single-provider request), a normalized
 * array, or { error }. Each entry: exactly one of providedBySupervisorId /
 * providedByGuestTrainerId / providedByExternalTrainerId, an optional
 * titleCode, and minutes > 0. The same trainer can't appear twice.
 */
function normalizeContributions(raw) {
  const list = parseList(raw);
  if (list === undefined) return undefined;
  if (list && list.error) return list;
  if (!Array.isArray(list)) return { error: "contributions must be an array" };
  if (!list.length) return { error: "Add at least one trainer for this day" };
  if (list.length > MAX_CONTRIBUTIONS) return { error: `At most ${MAX_CONTRIBUTIONS} trainers per day` };

  const out = [];
  const seen = new Set();
  for (const [i, c] of list.entries()) {
    const n = i + 1;
    if (!c || typeof c !== "object") return { error: `Trainer ${n}: invalid entry` };
    const sup = toPositiveIntOrNull(c.providedBySupervisorId);
    const guest = toPositiveIntOrNull(c.providedByGuestTrainerId);
    const ext = toPositiveIntOrNull(c.providedByExternalTrainerId);
    if ([sup, guest, ext].some(Number.isNaN)) return { error: `Trainer ${n}: invalid trainer` };
    const set = [sup, guest, ext].filter((v) => v != null);
    if (set.length !== 1) return { error: `Trainer ${n}: choose exactly one trainer` };
    const minutes = Number(c.minutes);
    if (!Number.isInteger(minutes) || minutes <= 0) return { error: `Trainer ${n}: hours must be greater than 0` };
    const titleCode = c.titleCode == null || c.titleCode === "" ? null : String(c.titleCode).trim().slice(0, 30);
    const entry = { supervisorId: sup, guestTrainerId: guest, externalTrainerId: ext, titleCode, minutes };
    const key = keyOf(entry);
    if (seen.has(key)) return { error: `Trainer ${n}: the same trainer is listed twice on this day` };
    seen.add(key);
    out.push(entry);
  }
  return out;
}

function keyOf(c) {
  if (c.externalTrainerId != null) return `e:${Number(c.externalTrainerId)}`;
  if (c.guestTrainerId != null) return `g:${Number(c.guestTrainerId)}`;
  return `s:${Number(c.supervisorId)}`;
}

function sumMinutes(list) {
  return list.reduce((t, c) => t + c.minutes, 0);
}

/** The provider fields of a list's first (lead) contributor -- mirrored onto the parent's provided_by_* columns. */
function leadProvider(list) {
  const c = list[0];
  return {
    providedBySupervisorId: c.supervisorId ?? null,
    providedByGuestTrainerId: c.guestTrainerId ?? null,
    providedByExternalTrainerId: c.externalTrainerId ?? null,
  };
}

/**
 * Validates every trainer in one or more contribution lists against the
 * Group's eligible providers (resolveProviders -- same rule as a single
 * provider) and every title against the active trainer_titles. `existing`
 * contributions/titles of the record being edited stay valid unchanged
 * (a trainer who has since left the Group, a title since deactivated).
 * `extraCheck(choice)` lets a caller forbid specific providers (e.g. a
 * ToT session's own audience).
 */
async function validateContributionLists(db, { groupId, lists, existing = [], extraCheck }) {
  const flat = lists.flat();
  if (!flat.length) return { ok: true };
  const providers = await resolveProviders(db, {
    groupId,
    body: null,
    days: flat.map((c) => ({
      providedBySupervisorId: c.supervisorId,
      providedByGuestTrainerId: c.guestTrainerId,
      providedByExternalTrainerId: c.externalTrainerId,
    })),
    existing,
  });
  if (providers.error) return { error: providers.error };
  if (extraCheck) {
    for (const c of flat) {
      const msg = await extraCheck(c);
      if (msg) return { error: msg };
    }
  }
  const codes = [...new Set(flat.map((c) => c.titleCode).filter(Boolean))];
  if (codes.length) {
    const existingCodes = new Set(existing.map((e) => e && e.titleCode).filter(Boolean));
    const { rows } = await db.query(`SELECT code, is_active FROM trainer_titles WHERE code IN (${codes.map(() => "?").join(",")})`, codes);
    const known = new Map(rows.map((r) => [r.code, r.is_active === true || Number(r.is_active) === 1]));
    for (const code of codes) {
      if (!known.has(code)) return { error: `Unknown trainer title "${code}"` };
      if (!known.get(code) && !existingCodes.has(code)) return { error: `The title "${code}" is no longer active` };
    }
  }
  return { ok: true };
}

/**
 * Route helper for Group Session create/edit requests: normalizes the
 * single-day `body.contributions` and every `days[i].contributions`,
 * validates every trainer/title in one pass, and returns days with their
 * normalized lists attached. `existing` = the edited record's current
 * contributions (see existingContributionChoices).
 * Returns { error } or { top: array|undefined, days: array|undefined }.
 */
async function prepareSessionContributions(db, { groupId, body, days, existing = [], extraCheck }) {
  const top = normalizeContributions(body && body.contributions);
  if (top && top.error) return { error: top.error };
  let outDays = days;
  const lists = top ? [top] : [];
  if (Array.isArray(days)) {
    outDays = [];
    for (const day of days) {
      const list = normalizeContributions(day && day.contributions);
      if (list && list.error) return { error: `Day ${day && day.date ? day.date : "?"}: ${list.error}` };
      if (list) lists.push(list);
      outDays.push(list ? { ...day, contributions: list } : { ...day, contributions: undefined });
    }
  }
  if (lists.length) {
    const checked = await validateContributionLists(db, { groupId, lists, existing, extraCheck });
    if (checked.error) return { error: checked.error };
  }
  return { top, days: outDays };
}

/** Replaces a parent's contributions (caller's transaction). An empty list just clears them. */
async function writeContributions(db, parentKind, parentId, list) {
  const { col } = PARENTS[parentKind];
  await db.query(`DELETE FROM session_contributions WHERE ${col} = ?`, [parentId]);
  for (const [i, c] of (list || []).entries()) {
    await db.query(
      `INSERT INTO session_contributions (${col}, supervisor_id, guest_trainer_id, external_trainer_id, title_code, minutes, sort_order)
       VALUES (?,?,?,?,?,?,?)`,
      [parentId, c.supervisorId ?? null, c.guestTrainerId ?? null, c.externalTrainerId ?? null, c.titleCode ?? null, c.minutes, i]
    );
  }
}

/**
 * Loads contributions for many parents of one kind, for display:
 * Map<parentId, Array<{key, kind, supervisorId, guestTrainerId,
 * externalTrainerId, name, titleCode, titleLabel, minutes, hours}>>.
 */
async function loadContributions(db, parentKind, ids) {
  const out = new Map();
  const unique = [...new Set((ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!unique.length) return out;
  const { col } = PARENTS[parentKind];
  const { rows } = await db.query(
    `SELECT sc.${col} AS parent_id, sc.supervisor_id, sc.guest_trainer_id, sc.external_trainer_id, sc.title_code, sc.minutes,
            tt.label AS title_label,
            COALESCE(gt.full_name, et.full_name, sp.full_name) AS name
       FROM session_contributions sc
       LEFT JOIN trainer_titles tt ON tt.code = sc.title_code
       LEFT JOIN guest_trainers gt ON gt.id = sc.guest_trainer_id
       LEFT JOIN external_trainers et ON et.id = sc.external_trainer_id
       LEFT JOIN supervisors sp ON sp.id = sc.supervisor_id
      WHERE sc.${col} IN (${unique.map(() => "?").join(",")})
      ORDER BY sc.${col}, sc.sort_order, sc.id`,
    unique
  );
  for (const r of rows) {
    const pid = Number(r.parent_id);
    if (!out.has(pid)) out.set(pid, []);
    const kind = r.external_trainer_id != null ? "external" : r.guest_trainer_id != null ? "guest" : "internal";
    out.get(pid).push({
      key: kind === "external" ? `e:${r.external_trainer_id}` : kind === "guest" ? `g:${r.guest_trainer_id}` : `s:${r.supervisor_id}`,
      kind,
      supervisorId: r.supervisor_id != null ? Number(r.supervisor_id) : null,
      guestTrainerId: r.guest_trainer_id != null ? Number(r.guest_trainer_id) : null,
      externalTrainerId: r.external_trainer_id != null ? Number(r.external_trainer_id) : null,
      name: r.name,
      titleCode: r.title_code,
      titleLabel: r.title_label,
      minutes: Number(r.minutes),
      hours: Math.round((Number(r.minutes) / 60) * 100) / 100,
    });
  }
  return out;
}

/** "Karim, Habib" for display, or null when there are no contributions. */
function contributorNames(list) {
  return list && list.length ? list.map((c) => c.name).join(", ") : null;
}

/** Stored pairs of a parent's current contributions -- the `existing` input for validation on an edit. */
async function existingContributionChoices(db, parentKind, parentIds) {
  const map = await loadContributions(db, parentKind, parentIds);
  return [...map.values()].flat().map((c) => ({
    supervisorId: c.supervisorId,
    guestTrainerId: c.guestTrainerId,
    externalTrainerId: c.externalTrainerId,
    titleCode: c.titleCode,
  }));
}

// ---- Delivered-hours credit rows -------------------------------------------

const ATTENDED = "CASE WHEN a.status = 'present' THEN s.duration_minutes ELSE COALESCE(a.minutes_completed, 0) END";
const legacyKind = (x) =>
  `CASE WHEN ${x}.provided_by_external_trainer_id IS NOT NULL THEN 'e' WHEN ${x}.provided_by_guest_trainer_id IS NOT NULL THEN 'g' ELSE 's' END`;
const legacyId = (x, creator) =>
  `CASE WHEN ${x}.provided_by_external_trainer_id IS NOT NULL THEN ${x}.provided_by_external_trainer_id
        WHEN ${x}.provided_by_guest_trainer_id IS NOT NULL THEN ${x}.provided_by_guest_trainer_id
        ELSE COALESCE(${x}.provided_by_supervisor_id, ${x}.${creator}) END`;
const legacyInternal = (x, creator) =>
  `${x}.provided_by_guest_trainer_id IS NULL AND ${x}.provided_by_external_trainer_id IS NULL AND COALESCE(${x}.provided_by_supervisor_id, ${x}.${creator})`;
const contribKind = "CASE WHEN sc.external_trainer_id IS NOT NULL THEN 'e' WHEN sc.guest_trainer_id IS NOT NULL THEN 'g' ELSE 's' END";
const contribId = "COALESCE(sc.external_trainer_id, sc.guest_trainer_id, sc.supervisor_id)";

/**
 * Every "who delivered how many hours" credit row for trainee-facing
 * sessions, as a UNION ALL yielding (kind 's'|'g'|'e', provider_id, code,
 * hours) -- the one source every delivered-hours total reads:
 *   - standalone session (occasion_id IS NULL): attendance-weighted; with
 *     contributions each trainer gets their share of the attended time
 *     (minutes * attended / duration), else the legacy provider gets it all
 *   - Group Session day (session_occasions): counted once (not per
 *     attendee) when at least one attendee was present/partial; with
 *     contributions each trainer gets their own minutes, else the legacy
 *     provider gets the whole duration
 * No branch uses an outer-correlated derived table (MariaDB loses those
 * correlations -- see memberListSql), so it is safe to wrap and GROUP BY.
 *
 * filters (all optional):
 *   internalProviderId: true  -> only this internal trainer (param)
 *   internalProviderGroup: true -> only internal trainers of this Group (param)
 *   studentGroup: true -> only trainees of this Group (param)
 * Returns { sql, params } -- params already repeated per branch.
 */
function creditRowsSql(filters = {}, values = {}) {
  const branches = [];

  // A: standalone, legacy provider
  {
    const where = ["s.status != 'cancelled'", "s.occasion_id IS NULL", "NOT EXISTS (SELECT 1 FROM session_contributions scx WHERE scx.session_id = s.id)"];
    const params = [];
    let join = "";
    if (filters.studentGroup) {
      join = "JOIN students st ON st.id = s.student_id AND st.group_id = ?";
      params.push(values.studentGroup);
    }
    if (filters.internalProviderId) {
      where.push(`${legacyInternal("s", "supervisor_id")} = ?`);
      params.push(values.internalProviderId);
    }
    if (filters.internalProviderGroup) {
      where.push(`${legacyInternal("s", "supervisor_id")} IN (SELECT id FROM supervisors WHERE group_id = ?)`);
      params.push(values.internalProviderGroup);
    }
    branches.push({
      sql: `SELECT ${legacyKind("s")} AS kind, ${legacyId("s", "supervisor_id")} AS provider_id, s.session_type AS code, (${ATTENDED}) / 60 AS hours
            FROM sessions s JOIN attendance a ON a.session_id = s.id AND a.status IN ('present', 'partial') ${join}
            WHERE ${where.join(" AND ")}`,
      params,
    });
  }

  // B: standalone, with contributions
  {
    const where = ["s.status != 'cancelled'", "s.occasion_id IS NULL"];
    const params = [];
    let join = "";
    if (filters.studentGroup) {
      join = "JOIN students st ON st.id = s.student_id AND st.group_id = ?";
      params.push(values.studentGroup);
    }
    if (filters.internalProviderId) {
      where.push("sc.supervisor_id = ?");
      params.push(values.internalProviderId);
    }
    if (filters.internalProviderGroup) {
      where.push("sc.supervisor_id IN (SELECT id FROM supervisors WHERE group_id = ?)");
      params.push(values.internalProviderGroup);
    }
    branches.push({
      sql: `SELECT ${contribKind} AS kind, ${contribId} AS provider_id, s.session_type AS code,
                   sc.minutes * (${ATTENDED}) / NULLIF(s.duration_minutes, 0) / 60 AS hours
            FROM session_contributions sc
            JOIN sessions s ON s.id = sc.session_id
            JOIN attendance a ON a.session_id = s.id AND a.status IN ('present', 'partial') ${join}
            WHERE ${where.join(" AND ")}`,
      params,
    });
  }

  const attendedOccasion = (params) => {
    if (filters.studentGroup) params.push(values.studentGroup);
    return `EXISTS (SELECT 1 FROM sessions s2
                   ${filters.studentGroup ? "JOIN students st2 ON st2.id = s2.student_id AND st2.group_id = ?" : ""}
                   JOIN attendance a2 ON a2.session_id = s2.id AND a2.status IN ('present', 'partial')
                   WHERE s2.occasion_id = so.id AND s2.status != 'cancelled')`;
  };

  // C: Group Session day, legacy provider
  {
    const params = [];
    const where = ["NOT EXISTS (SELECT 1 FROM session_contributions scx WHERE scx.occasion_id = so.id)"];
    if (filters.internalProviderId) {
      where.push(`${legacyInternal("so", "supervisor_id")} = ?`);
      params.push(values.internalProviderId);
    }
    if (filters.internalProviderGroup) {
      where.push(`${legacyInternal("so", "supervisor_id")} IN (SELECT id FROM supervisors WHERE group_id = ?)`);
      params.push(values.internalProviderGroup);
    }
    where.push(attendedOccasion(params));
    branches.push({
      sql: `SELECT ${legacyKind("so")} AS kind, ${legacyId("so", "supervisor_id")} AS provider_id, so.session_type AS code, so.duration_minutes / 60 AS hours
            FROM session_occasions so
            WHERE ${where.join(" AND ")}`,
      params,
    });
  }

  // D: Group Session day, with contributions
  {
    const params = [];
    const where = [];
    if (filters.internalProviderId) {
      where.push("sc.supervisor_id = ?");
      params.push(values.internalProviderId);
    }
    if (filters.internalProviderGroup) {
      where.push("sc.supervisor_id IN (SELECT id FROM supervisors WHERE group_id = ?)");
      params.push(values.internalProviderGroup);
    }
    where.push(attendedOccasion(params));
    branches.push({
      sql: `SELECT ${contribKind} AS kind, ${contribId} AS provider_id, so.session_type AS code, sc.minutes / 60 AS hours
            FROM session_contributions sc
            JOIN session_occasions so ON so.id = sc.occasion_id
            WHERE ${where.join(" AND ")}`,
      params,
    });
  }

  return {
    sql: branches.map((b) => b.sql).join("\nUNION ALL\n"),
    params: branches.flatMap((b) => b.params),
  };
}

/**
 * Attaches contributions to API items. `parentOf(item)` returns
 * [parentKind, parentId] (or null). Each item gets `contributions` (array,
 * possibly empty) and, when it has any, `providedByName` becomes the
 * joined contributor names and the guest/external flags are cleared for a
 * multi-trainer day (no single provider).
 */
async function attachContributions(db, items, parentOf) {
  const byKind = new Map();
  for (const it of items) {
    const p = parentOf(it);
    if (!p || p[1] == null) continue;
    if (!byKind.has(p[0])) byKind.set(p[0], []);
    byKind.get(p[0]).push(p[1]);
  }
  const loaded = new Map();
  for (const [kind, ids] of byKind) loaded.set(kind, await loadContributions(db, kind, ids));
  return items.map((it) => {
    const p = parentOf(it);
    const list = (p && loaded.get(p[0]) && loaded.get(p[0]).get(Number(p[1]))) || [];
    // Where this item's trainers live: "occasion" = its Group Session day
    // (edited there, not on the trainee's own row), "session" = itself.
    const contributionsFrom = p ? p[0] : null;
    if (!list.length) return { ...it, contributions: [], contributionsFrom };
    const single = list.length === 1 ? list[0] : null;
    return {
      ...it,
      contributions: list,
      contributionsFrom,
      providedByName: contributorNames(list),
      providedByIsGuest: !!single && single.kind === "guest",
      providedByIsExternal: !!single && single.kind === "external",
    };
  });
}

/**
 * attachContributions for lists made of `sessions` rows (one per trainee):
 * a row under a Group Session day takes that DAY's trainers, a standalone
 * session its own. `sessionIdOf(item)` returns the sessions.id (or null
 * for items that aren't sessions, e.g. assignments in a records feed).
 */
async function attachToSessionRows(db, items, sessionIdOf) {
  const ids = [...new Set(items.map(sessionIdOf).filter((v) => v != null).map(Number))];
  const occasionOf = new Map();
  if (ids.length) {
    const { rows } = await db.query(`SELECT id, occasion_id FROM sessions WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
    for (const r of rows) occasionOf.set(Number(r.id), r.occasion_id != null ? Number(r.occasion_id) : null);
  }
  return attachContributions(db, items, (it) => {
    const sid = sessionIdOf(it);
    if (sid == null) return null;
    const occ = occasionOf.get(Number(sid));
    return occ ? ["occasion", occ] : ["session", Number(sid)];
  });
}

module.exports = {
  PARENTS,
  attachToSessionRows,
  normalizeContributions,
  validateContributionLists,
  prepareSessionContributions,
  writeContributions,
  loadContributions,
  contributorNames,
  existingContributionChoices,
  attachContributions,
  creditRowsSql,
  sumMinutes,
  leadProvider,
  keyOf,
  providerNameSql,
};
