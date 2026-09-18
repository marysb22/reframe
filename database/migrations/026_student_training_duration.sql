-- Adds a per-Trainee Training Duration (in years), settable from the
-- Trainee's own My Profile alongside Training Start Date. Training End
-- Date/Year/Status remain fully derived (see trainingTimeline.js) -- this
-- is the only new stored value, and it's optional/per-trainee instead of
-- the previous hardcoded 4-year constant, which stays as the fallback for
-- Supervisors and any Trainee who hasn't set one yet (nothing else changes
-- for them).
--
-- Purely additive: nullable column, no default, no backfill -- an existing
-- Trainee simply has no Duration set until they fill it in via My Profile,
-- exactly like Training Start Date had no real value before migration 017
-- introduced it.

ALTER TABLE students ADD COLUMN training_duration_years INT NULL AFTER training_start_date;
