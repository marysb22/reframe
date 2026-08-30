// Friday -> Thursday weekly period helpers for Notifications + Activity.
//
// The boundary is computed from MySQL's own local clock (CURDATE()/
// WEEKDAY()) rather than Node's or the browser's -- every existing
// `created_at DEFAULT CURRENT_TIMESTAMP` value in this database was
// already written against that same clock, so this is the one reference
// frame guaranteed to agree with the data instead of introducing a new,
// possibly-mismatched timezone source. No date library is needed; all
// arithmetic below is done with Date.UTC() on plain 'YYYY-MM-DD' strings
// so it never drifts by a day depending on the Node process's own
// timezone.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function shiftDate(yyyyMmDd, days) {
  const [y, m, d] = yyyyMmDd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

function isValidDateString(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + "T00:00:00Z"));
}

/**
 * The current Friday-anchored week, as { weekStart, weekEnd } (weekEnd is
 * exclusive). Computed from a single lightweight MySQL query so it always
 * reflects the DB server's own "today" -- the moment that clock crosses
 * into Friday, callers automatically see a new week with no cron job.
 */
async function getCurrentWeekRange(db) {
  const { rows } = await db.query("SELECT CURDATE() AS today, WEEKDAY(CURDATE()) AS wd");
  const { today, wd } = rows[0]; // MySQL WEEKDAY(): Mon=0 .. Sun=6, Fri=4
  const daysSinceFriday = (Number(wd) - 4 + 7) % 7;
  const weekStart = shiftDate(today, -daysSinceFriday);
  const weekEnd = shiftDate(weekStart, 7);
  return { weekStart, weekEnd };
}

/**
 * Resolves the week a request should be scoped to: an explicit
 * `?week=YYYY-MM-DD` from the caller (any malformed/missing value falls
 * back to the current week rather than erroring, since this only ever
 * narrows a read), or the current week if none was given.
 */
async function resolveWeekRange(db, weekStartParam) {
  if (isValidDateString(weekStartParam)) {
    return { weekStart: weekStartParam, weekEnd: shiftDate(weekStartParam, 7) };
  }
  return getCurrentWeekRange(db);
}

function formatWeekLabel(weekStart, weekEnd) {
  const lastDay = shiftDate(weekEnd, -1);
  const fmt = (s) => {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  };
  return `${fmt(weekStart)} – ${fmt(lastDay)}`;
}

/** Pure date math, no DB access -- the last `count` weeks including the current one, newest first. */
function listRecentWeeks(currentWeekStart, count = 8) {
  const weeks = [];
  for (let i = 0; i < count; i++) {
    const weekStart = shiftDate(currentWeekStart, -7 * i);
    const weekEnd = shiftDate(weekStart, 7);
    weeks.push({ weekStart, weekEnd, label: formatWeekLabel(weekStart, weekEnd) });
  }
  return weeks;
}

module.exports = { getCurrentWeekRange, resolveWeekRange, listRecentWeeks, formatWeekLabel, shiftDate };
