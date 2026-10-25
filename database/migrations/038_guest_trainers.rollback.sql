-- Rollback for migration 038 (Guest Trainers).
--
-- LOSSLESS ONLY BEFORE ANY GUEST DATA EXISTS. Dropping these columns and
-- tables permanently erases every Guest Trainer, every Group association,
-- and -- most importantly -- the "Hours Provided By" attribution of every
-- session a Guest Trainer delivered. After a rollback those sessions would
-- fall back (via migration 035's COALESCE) to being credited to whoever
-- CREATED them, silently inflating that person's delivered-hours totals.
--
-- Therefore: run STEP 0 first. If 0.2 returns anything other than 0, do
-- NOT run this rollback -- export guest_trainers, group_guest_trainers and
-- every session row with provided_by_guest_trainer_id IS NOT NULL first,
-- and decide with the program owner how those sessions should be
-- attributed. Roll back the application code (the release that introduced
-- Guest Trainers) BEFORE running this file, or the running app will error
-- on the missing columns.

-- =============================================================================
-- STEP 0: Checks
-- =============================================================================
SELECT DATABASE() AS target_database;

-- 0.2 -- must be 0 to roll back losslessly.
SELECT
  (SELECT COUNT(*) FROM guest_trainers) AS guest_trainers,
  (SELECT COUNT(*) FROM group_guest_trainers) AS group_associations,
  (SELECT COUNT(*) FROM sessions WHERE provided_by_guest_trainer_id IS NOT NULL) +
  (SELECT COUNT(*) FROM session_occasions WHERE provided_by_guest_trainer_id IS NOT NULL) +
  (SELECT COUNT(*) FROM session_series WHERE provided_by_guest_trainer_id IS NOT NULL) +
  (SELECT COUNT(*) FROM tot_training_sessions WHERE provided_by_guest_trainer_id IS NOT NULL) +
  (SELECT COUNT(*) FROM tot_session_occasions WHERE provided_by_guest_trainer_id IS NOT NULL) AS guest_attributed_session_rows;

-- =============================================================================
-- STEP 1: Drop (reverse order of creation)
-- =============================================================================
ALTER TABLE tot_session_occasions DROP FOREIGN KEY fk_tsocc_provided_by_guest, DROP COLUMN provided_by_guest_trainer_id;
ALTER TABLE tot_training_sessions DROP FOREIGN KEY fk_totsess_provided_by_guest, DROP COLUMN provided_by_guest_trainer_id;
ALTER TABLE session_series DROP FOREIGN KEY fk_sseries_provided_by_guest, DROP COLUMN provided_by_guest_trainer_id;
ALTER TABLE session_occasions DROP FOREIGN KEY fk_socc_provided_by_guest, DROP COLUMN provided_by_guest_trainer_id;
ALTER TABLE sessions DROP FOREIGN KEY fk_sessions_provided_by_guest, DROP COLUMN provided_by_guest_trainer_id;

DROP TABLE group_guest_trainers;
DROP TABLE guest_trainers;
