-- Guest Trainers -- an external (or other-Group) trainer who can be
-- associated with a Group and/or recorded as the person who actually
-- DELIVERED a training/supervision session, without becoming a ToT, a
-- Master Trainer, or any kind of privileged account.
--
-- Two distinct use cases, deliberately kept as two distinct relationships:
--
--   (A) GROUP ASSOCIATION -- group_guest_trainers. "This person is one of
--       this Group's Guest Trainers." Either an EXTERNAL person with no
--       Reframe login (guest_trainer_id -> guest_trainers) or an EXISTING
--       Reframe trainer account from another Group (supervisor_id ->
--       supervisors). Exactly one of the two is set per row (enforced in
--       application code, see below for why not a CHECK). Being associated
--       grants NO access to anything -- it only makes the person selectable
--       as "Hours Provided By" on this Group's sessions. Removing the
--       association deletes only that row; the person and every historical
--       session they delivered are untouched.
--
--   (B) SESSION PROVIDER -- provided_by_guest_trainer_id on every session
--       table that already carries provided_by_supervisor_id (migration
--       035). An external person can be recorded as a session's actual
--       provider whether or not they were ever associated with the Group
--       ("session-only" external trainer). For an INTERNAL guest (another
--       Group's trainer) the existing provided_by_supervisor_id column is
--       used as-is -- they are a real supervisors row, so their delivered
--       hours attribute to their own account exactly like any other
--       provider's.
--
-- The four relationships the app keeps separate, and where each lives:
--   created/entered the session  -> supervisor_id / master_trainer_id (unchanged)
--   actually delivered it        -> provided_by_supervisor_id XOR provided_by_guest_trainer_id
--   responsible for the Group    -> supervisors.group_id + supervisor_type='primary' (unchanged)
--   associated with the Group    -> group_guest_trainers (new)
--
-- At most one of provided_by_supervisor_id / provided_by_guest_trainer_id
-- is non-NULL on any row. Every hours/attribution query reads the internal
-- provider as
--   IF(provided_by_guest_trainer_id IS NULL,
--      COALESCE(provided_by_supervisor_id, <creator>), NULL)
-- so a guest-delivered row is never silently credited to its creator via
-- migration 035's COALESCE fallback, and is never counted twice.
--
-- Why no CHECK constraints for the "exactly one"/"at most one" rules:
-- MySQL rejects a CHECK on any column that is also used by a foreign key
-- with a referential action (ON DELETE SET NULL/CASCADE) -- error 3823 --
-- and every column involved here needs one. Production runs MariaDB, whose
-- CHECK handling also differs (see migration 033). Both rules are enforced
-- in src/utils/guestTrainers.js, the single write path for these columns.
--
-- Purely additive: two new tables, five new nullable columns, no existing
-- column altered, no existing row updated or deleted. Every existing row
-- gets provided_by_guest_trainer_id = NULL, which every query treats
-- exactly as before this migration -- no existing hour total changes.
--
-- =============================================================================
-- HOW TO APPLY (read fully first -- see 038_guest_trainers.README.md)
-- =============================================================================
-- 1. Take a verified backup of the TARGET database and confirm you are
--    connected to the database you intend to change (SELECT DATABASE();).
-- 2. Run the STEP 0 checks below and read every result.
-- 3. Run STEP 1 and STEP 2 in order.
-- 4. Run the STEP 3 verification queries.
-- Rollback: 038_guest_trainers.rollback.sql (read its header -- rollback
-- is only lossless before any guest data has been created).

-- =============================================================================
-- STEP 0: Pre-flight checks -- run first, review every result
-- =============================================================================

-- 0.1 -- must return the database you intend to migrate.
SELECT DATABASE() AS target_database;

-- 0.2 -- must return 0 rows (this migration has not been applied yet).
SELECT TABLE_NAME FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('guest_trainers', 'group_guest_trainers');
SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'provided_by_guest_trainer_id';

-- 0.3 -- every prerequisite from migration 035 must exist: must return 5 rows.
SELECT TABLE_NAME FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'provided_by_supervisor_id'
   AND TABLE_NAME IN ('sessions', 'session_occasions', 'session_series', 'tot_training_sessions', 'tot_session_occasions');

-- =============================================================================
-- STEP 1: New tables
-- =============================================================================

-- One row per EXTERNAL trainer (no Reframe login, no user_credentials row).
-- owner_group_id scopes the record to the Group it was entered for: that
-- Group's Master Trainer/ToTs can reuse it as a session provider; other
-- Groups never see it (a guest's name/email is not shared across Groups).
-- name_key is the normalized (NFC, trimmed, whitespace-collapsed,
-- lowercased) name, so "Dr. Rana  Haddad" and "dr. rana haddad" entered
-- twice for the same Group resolve to the same person instead of two.
CREATE TABLE guest_trainers (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  full_name       VARCHAR(255) NOT NULL,
  name_key        VARCHAR(255) NOT NULL,
  email           VARCHAR(255) NULL,
  phone           VARCHAR(50)  NULL,
  organization    VARCHAR(255) NULL,
  specialization  VARCHAR(255) NULL,
  owner_group_id  BIGINT NULL,
  created_by      BIGINT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_guest_owner_group FOREIGN KEY (owner_group_id) REFERENCES trainer_groups(id) ON DELETE SET NULL,
  CONSTRAINT fk_guest_created_by FOREIGN KEY (created_by) REFERENCES user_credentials(id) ON DELETE SET NULL,
  CONSTRAINT uq_guest_owner_name UNIQUE (owner_group_id, name_key),
  INDEX idx_guest_owner_email (owner_group_id, email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='External Guest Trainers (no Reframe login). Never deleted by the application -- sessions reference them ON DELETE RESTRICT so historical provider attribution is always preserved. See migration 038.';

-- Group <-> Guest Trainer association (use case A). Exactly one of
-- guest_trainer_id (external person) / supervisor_id (existing trainer
-- account from another Group) is set -- enforced in application code.
-- The two UNIQUE keys make a repeated or concurrent "Add Guest Trainer"
-- for the same person+Group fail cleanly instead of creating a duplicate
-- (MySQL/MariaDB allow multiple NULLs in a UNIQUE key, so the unused
-- column of each row never collides).
CREATE TABLE group_guest_trainers (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  group_id          BIGINT NOT NULL,
  guest_trainer_id  BIGINT NULL,
  supervisor_id     BIGINT NULL,
  added_by          BIGINT NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_ggt_group FOREIGN KEY (group_id) REFERENCES trainer_groups(id) ON DELETE CASCADE,
  CONSTRAINT fk_ggt_guest FOREIGN KEY (guest_trainer_id) REFERENCES guest_trainers(id) ON DELETE CASCADE,
  CONSTRAINT fk_ggt_supervisor FOREIGN KEY (supervisor_id) REFERENCES supervisors(id) ON DELETE CASCADE,
  CONSTRAINT fk_ggt_added_by FOREIGN KEY (added_by) REFERENCES user_credentials(id) ON DELETE SET NULL,
  CONSTRAINT uq_ggt_group_guest UNIQUE (group_id, guest_trainer_id),
  CONSTRAINT uq_ggt_group_supervisor UNIQUE (group_id, supervisor_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Guest Trainers associated with a Group (migration 038). Association only -- grants no access and is not used for session delivery attribution, which lives on each session row.';

-- =============================================================================
-- STEP 2: Session-provider columns (use case B)
-- =============================================================================
-- ON DELETE RESTRICT (not SET NULL like provided_by_supervisor_id): a NULL
-- here would silently re-credit a guest-delivered session to its creator
-- via the COALESCE fallback. The application never deletes guest_trainers
-- rows, so RESTRICT only ever guards against a manual DELETE wiping history.

ALTER TABLE sessions
  ADD COLUMN provided_by_guest_trainer_id BIGINT NULL AFTER provided_by_supervisor_id,
  ADD CONSTRAINT fk_sessions_provided_by_guest FOREIGN KEY (provided_by_guest_trainer_id) REFERENCES guest_trainers(id) ON DELETE RESTRICT;

ALTER TABLE session_occasions
  ADD COLUMN provided_by_guest_trainer_id BIGINT NULL AFTER provided_by_supervisor_id,
  ADD CONSTRAINT fk_socc_provided_by_guest FOREIGN KEY (provided_by_guest_trainer_id) REFERENCES guest_trainers(id) ON DELETE RESTRICT;

ALTER TABLE session_series
  ADD COLUMN provided_by_guest_trainer_id BIGINT NULL AFTER provided_by_supervisor_id,
  ADD CONSTRAINT fk_sseries_provided_by_guest FOREIGN KEY (provided_by_guest_trainer_id) REFERENCES guest_trainers(id) ON DELETE RESTRICT;

ALTER TABLE tot_training_sessions
  ADD COLUMN provided_by_guest_trainer_id BIGINT NULL AFTER provided_by_supervisor_id,
  ADD CONSTRAINT fk_totsess_provided_by_guest FOREIGN KEY (provided_by_guest_trainer_id) REFERENCES guest_trainers(id) ON DELETE RESTRICT;

ALTER TABLE tot_session_occasions
  ADD COLUMN provided_by_guest_trainer_id BIGINT NULL AFTER provided_by_supervisor_id,
  ADD CONSTRAINT fk_tsocc_provided_by_guest FOREIGN KEY (provided_by_guest_trainer_id) REFERENCES guest_trainers(id) ON DELETE RESTRICT;

-- No backfill: NULL is the correct value for every existing row (no
-- existing session was delivered by a Guest Trainer).

-- =============================================================================
-- STEP 3: Post-migration verification -- run and review
-- =============================================================================

-- 3.1 -- must return 2 rows.
SELECT TABLE_NAME FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('guest_trainers', 'group_guest_trainers');

-- 3.2 -- must return 5 rows.
SELECT TABLE_NAME FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'provided_by_guest_trainer_id';

-- 3.3 -- must return 0 (nothing existing was touched).
SELECT
  (SELECT COUNT(*) FROM sessions WHERE provided_by_guest_trainer_id IS NOT NULL) +
  (SELECT COUNT(*) FROM session_occasions WHERE provided_by_guest_trainer_id IS NOT NULL) +
  (SELECT COUNT(*) FROM session_series WHERE provided_by_guest_trainer_id IS NOT NULL) +
  (SELECT COUNT(*) FROM tot_training_sessions WHERE provided_by_guest_trainer_id IS NOT NULL) +
  (SELECT COUNT(*) FROM tot_session_occasions WHERE provided_by_guest_trainer_id IS NOT NULL) AS guest_attributed_rows;
