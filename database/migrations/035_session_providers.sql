-- "Hours Provided By" -- separates WHO CREATED a session (existing
-- supervisor_id/master_trainer_id, unchanged, still used by every existing
-- ownership/edit/delete check) from WHOSE DELIVERED HOURS it should count
-- toward (new provided_by_supervisor_id). A ToT can now log a session on
-- her Master Trainer's behalf; the hours attribute to the Master Trainer,
-- not the ToT, without losing the record of who actually entered it.
--
-- Purely additive: five new nullable columns, same idiom as every prior
-- migration in this file set (005/025/029/031/034) -- no existing column
-- altered, no existing row deleted. ON DELETE SET NULL (not RESTRICT like
-- the creator FK) so removing a supervisor account never blocks on an old
-- session's provider attribution; application code reads
-- COALESCE(provided_by_supervisor_id, supervisor_id) everywhere, so a NULL
-- provider silently falls back to the creator -- exactly the backfilled
-- value every existing row gets below.

ALTER TABLE sessions
  ADD COLUMN provided_by_supervisor_id BIGINT NULL AFTER supervisor_id,
  ADD CONSTRAINT fk_sessions_provided_by FOREIGN KEY (provided_by_supervisor_id) REFERENCES supervisors(id) ON DELETE SET NULL;

ALTER TABLE session_occasions
  ADD COLUMN provided_by_supervisor_id BIGINT NULL AFTER supervisor_id,
  ADD CONSTRAINT fk_socc_provided_by FOREIGN KEY (provided_by_supervisor_id) REFERENCES supervisors(id) ON DELETE SET NULL;

ALTER TABLE session_series
  ADD COLUMN provided_by_supervisor_id BIGINT NULL AFTER supervisor_id,
  ADD CONSTRAINT fk_sseries_provided_by FOREIGN KEY (provided_by_supervisor_id) REFERENCES supervisors(id) ON DELETE SET NULL;

ALTER TABLE tot_training_sessions
  ADD COLUMN provided_by_supervisor_id BIGINT NULL AFTER master_trainer_id,
  ADD CONSTRAINT fk_totsess_provided_by FOREIGN KEY (provided_by_supervisor_id) REFERENCES supervisors(id) ON DELETE SET NULL;

ALTER TABLE tot_session_occasions
  ADD COLUMN provided_by_supervisor_id BIGINT NULL AFTER master_trainer_id,
  ADD CONSTRAINT fk_tsocc_provided_by FOREIGN KEY (provided_by_supervisor_id) REFERENCES supervisors(id) ON DELETE SET NULL;

-- Backfill: every existing row's provider = its existing creator, so no
-- existing hour total (trainee, ToT, or Master Trainer) changes by even one
-- minute the moment this migration runs.
UPDATE sessions SET provided_by_supervisor_id = supervisor_id WHERE provided_by_supervisor_id IS NULL;
UPDATE session_occasions SET provided_by_supervisor_id = supervisor_id WHERE provided_by_supervisor_id IS NULL;
UPDATE session_series SET provided_by_supervisor_id = supervisor_id WHERE provided_by_supervisor_id IS NULL;
UPDATE tot_training_sessions SET provided_by_supervisor_id = master_trainer_id WHERE provided_by_supervisor_id IS NULL;
UPDATE tot_session_occasions SET provided_by_supervisor_id = master_trainer_id WHERE provided_by_supervisor_id IS NULL;
