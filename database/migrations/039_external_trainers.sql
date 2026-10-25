-- External Trainers -- a trainer from OUTSIDE the organization (or the
-- Group) recorded as the person who actually delivered a training/
-- supervision session. A third, independent provider kind alongside:
--
--   Internal Trainer -> provided_by_supervisor_id      (migration 035, unchanged)
--   Guest Trainer    -> provided_by_guest_trainer_id   (migration 038, unchanged)
--   External Trainer -> provided_by_external_trainer_id (this migration)
--
-- How External differs from Guest (migration 038):
--   - A Guest Trainer is a person tied to a Group's Guest Trainers roster
--     (group_guest_trainers), managed by the Group's Master Trainer/Admin,
--     including Guest Trainer's own session-only records. That feature,
--     its tables, and every row in them are untouched by this migration.
--   - An External Trainer is never on any Group roster. It is a record of
--     an outside provider (typically with an organization), entered from a
--     session form by whoever logs the session, and reusable only for that
--     same Group's sessions (owner_group_id). It has no login, no access,
--     and no association concept at all.
--
-- At most ONE of the three provider columns is non-NULL on any session
-- row (enforced in src/utils/guestTrainers.js / groupSessions.js, the only
-- write paths -- a CHECK isn't possible on FK-action columns, MySQL error
-- 3823, and production runs MariaDB; same reasoning as migration 038).
-- Every hours/attribution query reads the internal provider as
--   IF(guest IS NULL AND external IS NULL, COALESCE(provided_by_supervisor_id, <creator>), NULL)
-- so an external-delivered row is never credited to its creator and never
-- counted twice.
--
-- Purely additive: one new table, five new nullable columns. No existing
-- column altered, no existing row updated or deleted; every existing row
-- gets provided_by_external_trainer_id = NULL, which every query treats
-- exactly as before. Requires migration 038.
--
-- HOW TO APPLY: verified backup of the TARGET database first, then STEP 0,
-- STEP 1, STEP 2, STEP 3 in order. See 039_external_trainers.README.md.

-- =============================================================================
-- STEP 0: Pre-flight checks
-- =============================================================================

-- 0.1 -- must return the database you intend to migrate.
SELECT DATABASE() AS target_database;

-- 0.2 -- must return 0 rows (not applied yet).
SELECT TABLE_NAME FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'external_trainers';
SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'provided_by_external_trainer_id';

-- 0.3 -- migration 038 must already be applied: must return 5 rows.
SELECT TABLE_NAME FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'provided_by_guest_trainer_id'
   AND TABLE_NAME IN ('sessions', 'session_occasions', 'session_series', 'tot_training_sessions', 'tot_session_occasions');

-- =============================================================================
-- STEP 1: New table
-- =============================================================================

-- Same normalization/duplicate rules as guest_trainers (name_key = NFC,
-- trimmed, whitespace-collapsed, lowercased name), deliberately a separate
-- table so the two provider kinds can never be confused, merged, or
-- counted against each other.
CREATE TABLE external_trainers (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  full_name       VARCHAR(255) NOT NULL,
  name_key        VARCHAR(255) NOT NULL,
  organization    VARCHAR(255) NULL,
  email           VARCHAR(255) NULL,
  phone           VARCHAR(50)  NULL,
  specialization  VARCHAR(255) NULL,
  owner_group_id  BIGINT NULL,
  created_by      BIGINT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_ext_owner_group FOREIGN KEY (owner_group_id) REFERENCES trainer_groups(id) ON DELETE SET NULL,
  CONSTRAINT fk_ext_created_by FOREIGN KEY (created_by) REFERENCES user_credentials(id) ON DELETE SET NULL,
  CONSTRAINT uq_ext_owner_name UNIQUE (owner_group_id, name_key),
  INDEX idx_ext_owner_email (owner_group_id, email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='External Trainers (outside the organization/Group, no Reframe login, never on a Group roster). Never deleted by the application -- sessions reference them ON DELETE RESTRICT. See migration 039.';

-- =============================================================================
-- STEP 2: Session-provider columns
-- =============================================================================
-- ON DELETE RESTRICT for the same reason as migration 038: a NULL here
-- would silently re-credit an external-delivered session to its creator.

ALTER TABLE sessions
  ADD COLUMN provided_by_external_trainer_id BIGINT NULL AFTER provided_by_guest_trainer_id,
  ADD CONSTRAINT fk_sessions_provided_by_external FOREIGN KEY (provided_by_external_trainer_id) REFERENCES external_trainers(id) ON DELETE RESTRICT;

ALTER TABLE session_occasions
  ADD COLUMN provided_by_external_trainer_id BIGINT NULL AFTER provided_by_guest_trainer_id,
  ADD CONSTRAINT fk_socc_provided_by_external FOREIGN KEY (provided_by_external_trainer_id) REFERENCES external_trainers(id) ON DELETE RESTRICT;

ALTER TABLE session_series
  ADD COLUMN provided_by_external_trainer_id BIGINT NULL AFTER provided_by_guest_trainer_id,
  ADD CONSTRAINT fk_sseries_provided_by_external FOREIGN KEY (provided_by_external_trainer_id) REFERENCES external_trainers(id) ON DELETE RESTRICT;

ALTER TABLE tot_training_sessions
  ADD COLUMN provided_by_external_trainer_id BIGINT NULL AFTER provided_by_guest_trainer_id,
  ADD CONSTRAINT fk_totsess_provided_by_external FOREIGN KEY (provided_by_external_trainer_id) REFERENCES external_trainers(id) ON DELETE RESTRICT;

ALTER TABLE tot_session_occasions
  ADD COLUMN provided_by_external_trainer_id BIGINT NULL AFTER provided_by_guest_trainer_id,
  ADD CONSTRAINT fk_tsocc_provided_by_external FOREIGN KEY (provided_by_external_trainer_id) REFERENCES external_trainers(id) ON DELETE RESTRICT;

-- No backfill: NULL is correct for every existing row.

-- =============================================================================
-- STEP 3: Post-migration verification
-- =============================================================================

-- 3.1 -- must return 1 row.
SELECT TABLE_NAME FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'external_trainers';

-- 3.2 -- must return 5 rows.
SELECT TABLE_NAME FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'provided_by_external_trainer_id';

-- 3.3 -- must return 0 (nothing existing touched).
SELECT
  (SELECT COUNT(*) FROM sessions WHERE provided_by_external_trainer_id IS NOT NULL) +
  (SELECT COUNT(*) FROM session_occasions WHERE provided_by_external_trainer_id IS NOT NULL) +
  (SELECT COUNT(*) FROM session_series WHERE provided_by_external_trainer_id IS NOT NULL) +
  (SELECT COUNT(*) FROM tot_training_sessions WHERE provided_by_external_trainer_id IS NOT NULL) +
  (SELECT COUNT(*) FROM tot_session_occasions WHERE provided_by_external_trainer_id IS NOT NULL) AS external_attributed_rows;

-- 3.4 -- Guest Trainer data is untouched: compare with the same query run
-- BEFORE this migration; the numbers must be identical.
SELECT
  (SELECT COUNT(*) FROM guest_trainers) AS guest_trainers,
  (SELECT COUNT(*) FROM group_guest_trainers) AS guest_associations,
  (SELECT COUNT(*) FROM session_occasions WHERE provided_by_guest_trainer_id IS NOT NULL) AS guest_attributed_occasions;
