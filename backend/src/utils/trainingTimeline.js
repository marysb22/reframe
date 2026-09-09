// Training Start Date / Training Year / Training Status -- single source of
// truth for where a Trainee or Supervisor (Master Trainer/ToT) is in the
// 4-year training program. Every part of the app that needs this (a
// person's own profile, Admin's user view, a Supervisor's view of one
// assigned student) reads it from toProfileResponse() in serializers.js,
// which calls this module -- nothing computes it a second, different way.
//
// Same timezone-safe convention as weekPeriod.js: every date here is a
// plain 'YYYY-MM-DD' string, all arithmetic uses Date.UTC() on the Y/M/D
// components directly (never new Date()'s local-timezone parsing, never a
// fixed 1460-day approximation), and "today" is expected to come from
// MySQL's own CURDATE() -- the same reference clock weekPeriod.js already
// established as this app's canonical "today", since every existing
// `created_at DEFAULT CURRENT_TIMESTAMP` value was already written against
// it. Callers select `CURDATE() AS training_today` alongside the person's
// own row rather than using Node's `new Date()`.

const TRAINING_DURATION_YEARS = 4;

/**
 * Adds whole calendar years to a 'YYYY-MM-DD' date -- NOT a fixed number of
 * days, so this correctly spans leap years the same way a calendar or
 * spreadsheet would (a Feb 29 start rolls to Mar 1 in a non-leap target
 * year via Date.UTC's own day-overflow normalization, and lands exactly on
 * Feb 29 when the target year is itself a leap year).
 */
function addCalendarYears(yyyyMmDd, years) {
  const [y, m, d] = yyyyMmDd.split("-").map(Number);
  return new Date(Date.UTC(y + years, m - 1, d)).toISOString().slice(0, 10);
}

/** Training End Date = Start Date + 4 calendar years. Derived, never stored. */
function calculateTrainingEndDate(startDate) {
  return startDate ? addCalendarYears(startDate, TRAINING_DURATION_YEARS) : null;
}

/**
 * Where a person is in the program right now, purely as a function of
 * their Start Date and "today" -- both plain 'YYYY-MM-DD' strings, safe to
 * compare lexicographically exactly like Date objects would sort.
 *
 * Each training year is a half-open window [yearStart, yearEnd) -- e.g. for
 * a 2026-09-15 start, Year 1 is [2026-09-15, 2027-09-15), so 2027-09-14 is
 * still Year 1 and 2027-09-15 is already Year 2. The overall end date
 * (2030-09-15 for that same start) is the same kind of boundary: reaching
 * it means the LAST year's window has closed, so the person is Completed
 * from that exact date onward, not still "in Year 4."
 *
 * Returns { status: 'scheduled'|'active'|'completed'|null, trainingYear: 1-4|null, endDate }.
 * status/trainingYear are null when startDate itself is null (nothing to compute).
 */
function calculateTrainingProgress(startDate, today) {
  if (!startDate) return { status: null, trainingYear: null, endDate: null };

  const endDate = calculateTrainingEndDate(startDate);
  if (today < startDate) return { status: "scheduled", trainingYear: null, endDate };
  if (today >= endDate) return { status: "completed", trainingYear: null, endDate };

  for (let year = 1; year <= TRAINING_DURATION_YEARS; year++) {
    if (today < addCalendarYears(startDate, year)) {
      return { status: "active", trainingYear: year, endDate };
    }
  }
  // Unreachable given the `today >= endDate` check above (year
  // TRAINING_DURATION_YEARS's window ends exactly at endDate), kept as a
  // safe fallback rather than ever returning undefined.
  return { status: "completed", trainingYear: null, endDate };
}

module.exports = {
  TRAINING_DURATION_YEARS,
  addCalendarYears,
  calculateTrainingEndDate,
  calculateTrainingProgress,
};
