-- Several trainers per training day + Admin-managed trainer titles +
-- private Trainer Space / Trainer Reports on top of Learning Materials.
-- Requires migrations 035, 038 and 039.
--
-- (1) trainer_titles -- a professional TITLE shown next to a trainer's
--     contribution ("Master Trainer", "External Trainer", ...). Purely
--     descriptive: a title never grants an account role, a Group
--     membership, or any permission. Admin-managed like hour_types
--     (rows are deactivated, never deleted, so history keeps its label).
--
-- (2) session_contributions -- WHO delivered HOW MANY minutes of ONE
--     training day, one row per trainer. A day's trainers are SEQUENTIAL:
--     the day's duration is the SUM of its contributions, and each
--     trainer is credited only with their own minutes. Works for every
--     session shape, via exactly one parent column:
--       occasion_id      -> session_occasions      (group Session day, single- or multi-day)
--       session_id       -> sessions               (standalone one-trainee session; occasion_id IS NULL)
--       tot_occasion_id  -> tot_session_occasions  (Master Trainer -> all ToTs session)
--       tot_session_id   -> tot_training_sessions  (Master Trainer -> one ToT session; occasion_id IS NULL)
--     and exactly one provider column (supervisor_id / guest_trainer_id /
--     external_trainer_id -- the same three provider kinds as migrations
--     035/038/039).
--
--     A parent with NO contribution rows keeps working exactly as before:
--     its single provided_by_* provider is credited with its whole
--     duration. Nothing is backfilled -- every existing record keeps its
--     current meaning, and no trainer assignment is invented. When a
--     parent HAS contribution rows, those rows are the only source of
--     attribution (the parent's provided_by_* columns then just mirror the
--     first contributor, for older read paths), so no hour is ever counted
--     twice.
--
--     "Exactly one parent" / "exactly one provider" are enforced by the
--     application (src/utils/contributions.js, the only write path) -- a
--     CHECK is impossible on columns that carry FK referential actions
--     (MySQL error 3823), same reasoning as migrations 038/039. The
--     UNIQUE keys below make the same trainer impossible to list twice on
--     the same day at the database level.
--
-- (3) learning_materials.visibility / team_section -- makes "who may see
--     this" an explicit column instead of an implicit combination of
--     NULLs. 'trainees' = ordinary trainee-facing material (unchanged
--     behavior); 'training_team' = private Trainer Space / Trainer Reports
--     content, visible only to the Group's Master Trainer + ToTs (or the
--     one trainer it was shared with), never to trainees -- enforced in
--     every trainee query AND in the file-download authorization.
--     Existing Group/ToT shares (group_id or shared_with_supervisor_id
--     set) were ALREADY trainer-only by design (excluded from every
--     trainee feed) -- they are backfilled to 'training_team', which makes
--     that existing meaning explicit without changing it.
--
-- Purely additive except that one backfill of the new column. No existing
-- column altered, no row deleted.
--
-- HOW TO APPLY: verified backup of the TARGET database first; then STEP 0,
-- 1, 2, 3, 4 in order. See 040_session_contributions_and_trainer_space.README.md.

-- =============================================================================
-- STEP 0: Pre-flight checks -- review every result
-- =============================================================================
SELECT DATABASE() AS target_database;

-- 0.2 -- must return 0 rows (not applied yet)
SELECT TABLE_NAME FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('trainer_titles', 'session_contributions');
SELECT COLUMN_NAME FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'learning_materials' AND COLUMN_NAME IN ('visibility', 'team_section');

-- 0.3 -- prerequisites: must return 3 rows (guest_trainers, external_trainers, tot_session_occasions)
SELECT TABLE_NAME FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('guest_trainers', 'external_trainers', 'tot_session_occasions');

-- 0.4 -- how many existing materials will become 'training_team' in STEP 3
-- (these are ALREADY hidden from trainees today; keep this number).
SELECT COUNT(*) AS existing_trainer_only_materials FROM learning_materials
 WHERE group_id IS NOT NULL OR shared_with_supervisor_id IS NOT NULL;

-- =============================================================================
-- STEP 1: Trainer titles
-- =============================================================================
CREATE TABLE trainer_titles (
  code        VARCHAR(30) NOT NULL PRIMARY KEY,
  label       VARCHAR(80) NOT NULL,
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Professional titles shown on a trainer''s session contribution (migration 040). Descriptive only -- never an account role or permission. Admin-managed; deactivated, never deleted.';

INSERT INTO trainer_titles (code, label, sort_order) VALUES
  ('master_trainer',   'Master Trainer',   10),
  ('trainer',          'Trainer',          20),
  ('tot',              'ToT',              30),
  ('guest_trainer',    'Guest Trainer',    40),
  ('external_trainer', 'External Trainer', 50);

-- =============================================================================
-- STEP 2: Per-day trainer contributions
-- =============================================================================
CREATE TABLE session_contributions (
  id                   BIGINT AUTO_INCREMENT PRIMARY KEY,
  occasion_id          BIGINT NULL,
  session_id           BIGINT NULL,
  tot_occasion_id      BIGINT NULL,
  tot_session_id       BIGINT NULL,
  supervisor_id        BIGINT NULL,
  guest_trainer_id     BIGINT NULL,
  external_trainer_id  BIGINT NULL,
  title_code           VARCHAR(30) NULL,
  minutes              INT NOT NULL,
  sort_order           INT NOT NULL DEFAULT 0,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_scontrib_occasion FOREIGN KEY (occasion_id) REFERENCES session_occasions(id) ON DELETE CASCADE,
  CONSTRAINT fk_scontrib_session FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  CONSTRAINT fk_scontrib_tot_occasion FOREIGN KEY (tot_occasion_id) REFERENCES tot_session_occasions(id) ON DELETE CASCADE,
  CONSTRAINT fk_scontrib_tot_session FOREIGN KEY (tot_session_id) REFERENCES tot_training_sessions(id) ON DELETE CASCADE,
  -- RESTRICT: a trainer who delivered hours can't be hard-deleted out from
  -- under that history (same rule as migrations 038/039).
  CONSTRAINT fk_scontrib_supervisor FOREIGN KEY (supervisor_id) REFERENCES supervisors(id) ON DELETE RESTRICT,
  CONSTRAINT fk_scontrib_guest FOREIGN KEY (guest_trainer_id) REFERENCES guest_trainers(id) ON DELETE RESTRICT,
  CONSTRAINT fk_scontrib_external FOREIGN KEY (external_trainer_id) REFERENCES external_trainers(id) ON DELETE RESTRICT,
  CONSTRAINT fk_scontrib_title FOREIGN KEY (title_code) REFERENCES trainer_titles(code) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT chk_scontrib_minutes CHECK (minutes >= 0),
  -- The same trainer can't appear twice on the same day.
  CONSTRAINT uq_scontrib_occ_sup UNIQUE (occasion_id, supervisor_id),
  CONSTRAINT uq_scontrib_occ_guest UNIQUE (occasion_id, guest_trainer_id),
  CONSTRAINT uq_scontrib_occ_ext UNIQUE (occasion_id, external_trainer_id),
  CONSTRAINT uq_scontrib_ses_sup UNIQUE (session_id, supervisor_id),
  CONSTRAINT uq_scontrib_ses_guest UNIQUE (session_id, guest_trainer_id),
  CONSTRAINT uq_scontrib_ses_ext UNIQUE (session_id, external_trainer_id),
  CONSTRAINT uq_scontrib_tocc_sup UNIQUE (tot_occasion_id, supervisor_id),
  CONSTRAINT uq_scontrib_tocc_guest UNIQUE (tot_occasion_id, guest_trainer_id),
  CONSTRAINT uq_scontrib_tocc_ext UNIQUE (tot_occasion_id, external_trainer_id),
  CONSTRAINT uq_scontrib_tses_sup UNIQUE (tot_session_id, supervisor_id),
  CONSTRAINT uq_scontrib_tses_guest UNIQUE (tot_session_id, guest_trainer_id),
  CONSTRAINT uq_scontrib_tses_ext UNIQUE (tot_session_id, external_trainer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='One row per trainer per training day (migration 040). Sequential: a day''s duration = SUM(minutes). A parent with no rows uses its legacy single provided_by_* provider.';

-- =============================================================================
-- STEP 3: Private Trainer Space visibility on Learning Materials
-- =============================================================================
ALTER TABLE learning_materials
  ADD COLUMN visibility VARCHAR(20) NOT NULL DEFAULT 'trainees',
  ADD COLUMN team_section VARCHAR(30) NULL,
  ADD COLUMN updated_at DATETIME NULL,
  ADD CONSTRAINT chk_material_visibility CHECK (visibility IN ('trainees', 'training_team')),
  ADD CONSTRAINT chk_material_team_section CHECK (team_section IS NULL OR team_section IN ('documents', 'materials', 'feedback', 'reports')),
  ADD INDEX idx_materials_visibility_group (visibility, group_id);

-- Existing Group / single-ToT shares were already trainer-only (every
-- trainee feed excludes them) -- make that explicit, unchanged in meaning.
UPDATE learning_materials
   SET visibility = 'training_team', team_section = 'materials'
 WHERE group_id IS NOT NULL OR shared_with_supervisor_id IS NOT NULL;

-- =============================================================================
-- STEP 4: Verification
-- =============================================================================
-- 4.1 -- must return 2 rows
SELECT TABLE_NAME FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('trainer_titles', 'session_contributions');
-- 4.2 -- must return 5
SELECT COUNT(*) AS seeded_titles FROM trainer_titles;
-- 4.3 -- must equal STEP 0.4's number
SELECT COUNT(*) AS training_team_materials FROM learning_materials WHERE visibility = 'training_team';
-- 4.4 -- must return 0 (no trainee-targeted material became private)
SELECT COUNT(*) AS should_be_zero FROM learning_materials WHERE visibility = 'training_team' AND student_id IS NOT NULL;
