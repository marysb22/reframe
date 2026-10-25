-- Rollback for migration 039 (External Trainers). Does not touch anything
-- from migration 038 (Guest Trainers).
--
-- LOSSLESS ONLY BEFORE ANY EXTERNAL TRAINER DATA EXISTS. Dropping these
-- erases every External Trainer and the "Hours Provided By" attribution of
-- every session one delivered -- those sessions would then fall back to
-- being credited to whoever CREATED them. If STEP 0.2 is not all zeros,
-- export external_trainers and every row with
-- provided_by_external_trainer_id IS NOT NULL first and decide with the
-- program owner how to attribute them. Roll back the application code
-- BEFORE running this file.

-- STEP 0
SELECT DATABASE() AS target_database;

-- 0.2 -- must be 0 to roll back losslessly.
SELECT
  (SELECT COUNT(*) FROM external_trainers) AS external_trainers,
  (SELECT COUNT(*) FROM sessions WHERE provided_by_external_trainer_id IS NOT NULL) +
  (SELECT COUNT(*) FROM session_occasions WHERE provided_by_external_trainer_id IS NOT NULL) +
  (SELECT COUNT(*) FROM session_series WHERE provided_by_external_trainer_id IS NOT NULL) +
  (SELECT COUNT(*) FROM tot_training_sessions WHERE provided_by_external_trainer_id IS NOT NULL) +
  (SELECT COUNT(*) FROM tot_session_occasions WHERE provided_by_external_trainer_id IS NOT NULL) AS external_attributed_session_rows;

-- STEP 1
ALTER TABLE tot_session_occasions DROP FOREIGN KEY fk_tsocc_provided_by_external, DROP COLUMN provided_by_external_trainer_id;
ALTER TABLE tot_training_sessions DROP FOREIGN KEY fk_totsess_provided_by_external, DROP COLUMN provided_by_external_trainer_id;
ALTER TABLE session_series DROP FOREIGN KEY fk_sseries_provided_by_external, DROP COLUMN provided_by_external_trainer_id;
ALTER TABLE session_occasions DROP FOREIGN KEY fk_socc_provided_by_external, DROP COLUMN provided_by_external_trainer_id;
ALTER TABLE sessions DROP FOREIGN KEY fk_sessions_provided_by_external, DROP COLUMN provided_by_external_trainer_id;

DROP TABLE external_trainers;
