// Who actually delivered a multi-day Session (session_series), computed
// from its DAYS -- each session_occasions row carries its own provider and
// duration (migrations 030/035/038/039) -- rather than from the one
// provider column on the session_series row itself.
//
// session_series.provided_by_* is only the Session-wide default a day
// falls back to when it names no provider of its own. Reading it as "who
// delivered this Session" is what made a Session delivered by Karim on
// some days and Habib on others look as if one trainer delivered all of it
// in every Session-level view (Session lists, the Activities feed, the
// Session detail header). Day rows, hour totals and provider breakdowns
// already read each day's own provider and were never affected.
//
// Nothing here is stored or backfilled: a day with no stored provider
// (pre-migration-035 data) resolves to its creator exactly as every
// hours query already does -- no trainer is ever guessed.

const { providerSupervisorIdSql, providerNameSql } = require("./guestTrainers");

/**
 * @param {object} db
 * @param {Array<number>} seriesIds
 * @returns {Promise<Map<number, {providers: Array<{key:string, kind:string, supervisorId:number|null, guestTrainerId:number|null, externalTrainerId:number|null, name:string, hours:number, dayCount:number}>, mixedProviders:boolean, providedByName:string|null, providedByIsGuest:boolean, providedByIsExternal:boolean}>>}
 */
async function summarizeSeriesProviders(db, seriesIds) {
  const ids = [...new Set((seriesIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const out = new Map();
  if (!ids.length) return out;

  const { rows } = await db.query(
    `SELECT so.series_id,
            ${providerSupervisorIdSql("so")} AS supervisor_id,
            so.provided_by_guest_trainer_id AS guest_id,
            so.provided_by_external_trainer_id AS external_id,
            so.duration_minutes,
            ${providerNameSql("so")} AS name
       FROM session_occasions so
      WHERE so.series_id IN (${ids.map(() => "?").join(",")})
      ORDER BY so.session_date, so.id`,
    ids
  );

  const bySeries = new Map();
  for (const r of rows) {
    const seriesId = Number(r.series_id);
    if (!bySeries.has(seriesId)) bySeries.set(seriesId, new Map());
    const providers = bySeries.get(seriesId);
    const kind = r.external_id != null ? "external" : r.guest_id != null ? "guest" : "internal";
    const key = kind === "external" ? `e:${r.external_id}` : kind === "guest" ? `g:${r.guest_id}` : `s:${r.supervisor_id}`;
    if (!providers.has(key)) {
      providers.set(key, {
        key,
        kind,
        supervisorId: kind === "internal" && r.supervisor_id != null ? Number(r.supervisor_id) : null,
        guestTrainerId: r.guest_id != null ? Number(r.guest_id) : null,
        externalTrainerId: r.external_id != null ? Number(r.external_id) : null,
        name: r.name,
        minutes: 0,
        dayCount: 0,
      });
    }
    const p = providers.get(key);
    p.minutes += Number(r.duration_minutes) || 0;
    p.dayCount += 1;
  }

  for (const [seriesId, providersMap] of bySeries) {
    // Most hours first, then name -- the trainer who delivered most of the
    // Session leads the summary; ties fall back to a stable alphabetical order.
    const providers = [...providersMap.values()]
      .map(({ minutes, ...p }) => ({ ...p, hours: Math.round((minutes / 60) * 100) / 100 }))
      .sort((a, b) => b.hours - a.hours || String(a.name).localeCompare(String(b.name)));
    const single = providers.length === 1 ? providers[0] : null;
    out.set(seriesId, {
      providers,
      mixedProviders: providers.length > 1,
      providedByName: providers.map((p) => p.name).join(", ") || null,
      providedByIsGuest: !!single && single.kind === "guest",
      providedByIsExternal: !!single && single.kind === "external",
    });
  }
  return out;
}

/**
 * Overwrites a Session-level row's provider fields with the per-day
 * summary (keeps the row's own values when the Session has no days yet).
 */
function applySeriesSummary(item, summary) {
  if (!summary) return { ...item, providers: [], mixedProviders: false };
  return {
    ...item,
    providedByName: summary.providedByName ?? item.providedByName,
    providedByIsGuest: summary.providedByIsGuest,
    providedByIsExternal: summary.providedByIsExternal,
    // Single-provider ids only -- a mixed Session has no one provider.
    providedByGuestTrainerId: summary.providers.length === 1 ? summary.providers[0].guestTrainerId : null,
    providedByExternalTrainerId: summary.providers.length === 1 ? summary.providers[0].externalTrainerId : null,
    providers: summary.providers,
    mixedProviders: summary.mixedProviders,
  };
}

module.exports = { summarizeSeriesProviders, applySeriesSummary };
