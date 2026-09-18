-- Mirrors migration 026 (students.training_duration_years) for
-- Supervisors (Master Trainer/ToT), so their own Training Information on
-- My Profile can be a real, required, per-person editable field exactly
-- like a Trainee's -- instead of only ever showing the hardcoded 4-year
-- constant. trainingTimeline.js already accepts an optional duration
-- override; serializers.js's toProfileResponse already reads
-- row.training_duration_years generically (whichever table the caller's
-- query selected it from), so no code changes are needed there.
--
-- Purely additive: nullable column, no default, no backfill -- no
-- Supervisor has ever had an explicit duration before this column existed.

ALTER TABLE supervisors ADD COLUMN training_duration_years INT NULL AFTER training_start_date;
