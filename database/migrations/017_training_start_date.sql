-- Introduces an official, calendar-based Training Start Date for Trainees
-- and Supervisors (Master Trainer + ToT). Training End Date, Training Year,
-- and Training Status are all DERIVED at read time from this one date (see
-- backend/src/utils/trainingTimeline.js) -- none of them are stored, so
-- there is nothing to keep in sync or drift out of date.
--
-- Purely additive: nullable column, no existing data touched beyond a
-- one-time backfill of a field that never existed before this migration
-- (there is no pre-existing "official start date" anywhere in the system
-- today -- current_year/cohorts are unrelated, unaffected concepts).

ALTER TABLE students ADD COLUMN training_start_date DATE NULL DEFAULT '2026-09-15';
ALTER TABLE supervisors ADD COLUMN training_start_date DATE NULL DEFAULT '2026-09-15';

-- Explicit, not relying on the storage engine's own ADD COLUMN default-fill
-- behavior for pre-existing rows (this has already differed between this
-- dev DB and production MariaDB 11.8.8 for other migrations this session).
UPDATE students SET training_start_date = '2026-09-15' WHERE training_start_date IS NULL;
UPDATE supervisors SET training_start_date = '2026-09-15' WHERE training_start_date IS NULL;
