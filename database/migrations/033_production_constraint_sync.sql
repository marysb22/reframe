-- Syncs production's schema with constraints that already exist on the
-- local dev DB but were never fully applied to production. Confirmed by
-- diffing `SHOW CREATE TABLE` on every table, local vs. a production
-- phpMyAdmin export dated 2026-09-25.
--
-- Two different situations, handled differently below:
--   (A) Migrations 001/006/011/016/005 already ran on production for their
--       CREATE TABLE / ADD COLUMN / ADD FOREIGN KEY statements (confirmed:
--       those columns/tables already exist in the export) -- only their
--       ADD CONSTRAINT ... CHECK (...) lines were apparently skipped and
--       never re-run. This file re-issues just those CHECK statements.
--   (B) A handful of constraints exist on local dev but were never written
--       into any numbered migration file at all (added ad hoc during
--       earlier development). This file adds them for the first time.
--
-- Run the STEP 0 verification block first and read every result. Every
-- query must return 0 rows before you run the ALTER in the matching step
-- below it -- if any query returns rows, STOP and handle those rows first
-- (see the note in that step); do not run that step's ALTER yet.

-- =============================================================================
-- STEP 0: Verification queries -- run first, review every result
-- =============================================================================

-- 0.1 (backs step 1) -- must be 0 rows
SELECT id, status FROM attendance WHERE status NOT IN ('present','absent','excused');

-- 0.2 (backs step 2) -- must be 0 rows. If any appear: do NOT delete/merge
-- them yourself -- inspect each session_id's rows first
-- (SELECT * FROM attendance WHERE session_id = <value>) and decide case by
-- case which row is the real one.
SELECT session_id, COUNT(*) c FROM attendance
WHERE session_id IS NOT NULL GROUP BY session_id HAVING c > 1;

-- 0.3 (backs step 3) -- must be 0 rows
SELECT id, supervisor_type, primary_supervisor_id FROM supervisors
WHERE (supervisor_type = 'primary' AND primary_supervisor_id IS NOT NULL)
   OR (supervisor_type = 'in_training' AND primary_supervisor_id IS NULL);

-- 0.4 (backs step 4) -- must be 0 rows
SELECT id FROM chats
WHERE (student_id IS NOT NULL AND target_supervisor_id IS NOT NULL)
   OR (student_id IS NULL AND target_supervisor_id IS NULL);

-- 0.5 (backs step 5) -- must be 0 rows
SELECT id FROM chat_room_messages WHERE content IS NULL AND attachment_filename IS NULL;

-- 0.6 (backs step 6) -- both must be 0 rows
SELECT id, training_year FROM payments WHERE training_year NOT BETWEEN 1 AND 4;
SELECT id, period_status FROM payments WHERE period_status NOT IN ('active','completed');

-- 0.7 (backs step 7) -- must be 0 rows
SELECT id, approval_status FROM documents WHERE approval_status NOT IN ('pending','approved');

-- 0.8 (backs step 8) -- must be 0 rows
SELECT DISTINCT tha.hour_type FROM trainee_hour_adjustments tha
LEFT JOIN hour_types ht ON ht.code = tha.hour_type
WHERE ht.code IS NULL;

-- 0.9 (backs step 9) -- all three must be 0 rows
SELECT id FROM learning_materials WHERE filename IS NULL AND external_url IS NULL;
SELECT id, publication_year FROM learning_materials
  WHERE publication_year IS NOT NULL AND publication_year NOT BETWEEN 1000 AND 2100;
SELECT id, resource_type FROM learning_materials WHERE resource_type IS NOT NULL
  AND resource_type NOT IN ('book','article','research_paper','academic_paper','thesis','ebook','reference','guide','report','other');

-- 0.10 (backs step 10) -- SKIP this whole step if this returns any rows or
-- any NULL/blank slug -- events.slug needs manual cleanup first, see step 10.
SELECT slug, COUNT(*) c FROM events GROUP BY slug HAVING c > 1;
SELECT id, title_en FROM events WHERE slug IS NULL OR slug = '';


-- =============================================================================
-- STEP 1: attendance.status -- add 'partial' (Migration 011's CHECK line,
-- never applied -- the column it also adds, minutes_completed, is already
-- on production)
--
-- NOTE: production's actual constraint name is `status` (auto-named after
-- the column, since it was declared inline with no CONSTRAINT name), not
-- `attendance_chk_1` as on local dev -- confirmed via:
--   SELECT tc.CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS tc
--   WHERE tc.TABLE_SCHEMA = 'u340416395_reframe_mhs' AND tc.TABLE_NAME = 'attendance'
--     AND tc.CONSTRAINT_TYPE = 'CHECK';
-- Production also already has a second CHECK, chk_attendance_minutes_completed_nonnegative
-- (not present on local dev) -- untouched here, it's a fine extra safeguard.
-- =============================================================================
ALTER TABLE attendance DROP CONSTRAINT `status`;
ALTER TABLE attendance
  ADD CONSTRAINT attendance_chk_1 CHECK (status IN ('present','absent','excused','partial'));

-- =============================================================================
-- STEP 2: attendance -- one row per session, not previously constrained
-- =============================================================================
ALTER TABLE attendance ADD UNIQUE KEY uq_attendance_session (session_id);

-- =============================================================================
-- STEP 3: supervisors -- Master Trainer / ToT hierarchy must be consistent
-- =============================================================================
ALTER TABLE supervisors ADD CONSTRAINT chk_supervisor_hierarchy
  CHECK (
    (supervisor_type = 'primary' AND primary_supervisor_id IS NULL)
    OR (supervisor_type = 'in_training' AND primary_supervisor_id IS NOT NULL)
  );

-- =============================================================================
-- STEP 4: chats -- exactly one target (a trainee thread XOR a supervisor
-- thread), never both, never neither
-- =============================================================================
ALTER TABLE chats ADD CONSTRAINT chk_chats_exactly_one_target CHECK (
  (student_id IS NOT NULL AND target_supervisor_id IS NULL)
  OR (student_id IS NULL AND target_supervisor_id IS NOT NULL)
);

-- =============================================================================
-- STEP 5: chat_room_messages -- Migration 005's CHECK line, never applied
-- (the table itself already exists on production)
-- =============================================================================
ALTER TABLE chat_room_messages
  ADD CONSTRAINT chk_crmsg_has_content CHECK (content IS NOT NULL OR attachment_filename IS NOT NULL);

-- =============================================================================
-- STEP 6: payments -- Migration 006's two CHECK lines, never applied (the
-- columns they guard, training_year/period_status, are already on production)
-- =============================================================================
ALTER TABLE payments ADD CONSTRAINT chk_payments_training_year CHECK (training_year BETWEEN 1 AND 4);
ALTER TABLE payments ADD CONSTRAINT chk_payments_period_status CHECK (period_status IN ('active','completed'));

-- =============================================================================
-- STEP 7: documents -- Migration 016's CHECK line, never applied (the
-- approval_status column it guards is already on production)
-- =============================================================================
ALTER TABLE documents ADD CONSTRAINT chk_document_approval_status
  CHECK (approval_status IN ('pending','approved'));

-- =============================================================================
-- STEP 8: trainee_hour_adjustments.hour_type -- widen from a hardcoded
-- 2-value CHECK to a real foreign key against hour_types, so a manual hour
-- adjustment can use any Admin-added hour type, not just training/supervision
-- =============================================================================
-- Same naming caveat as step 1 -- confirm the real name first:
--   SELECT tc.CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS tc
--   WHERE tc.TABLE_SCHEMA = 'u340416395_reframe_mhs' AND tc.TABLE_NAME = 'trainee_hour_adjustments'
--     AND tc.CONSTRAINT_TYPE = 'CHECK';
-- likely `hour_type` (same inline-declared, auto-named-after-column pattern as attendance.status)
ALTER TABLE trainee_hour_adjustments DROP CONSTRAINT `hour_type`;
ALTER TABLE trainee_hour_adjustments MODIFY hour_type VARCHAR(30) NOT NULL;
ALTER TABLE trainee_hour_adjustments
  ADD CONSTRAINT fk_traineeadj_hour_type FOREIGN KEY (hour_type) REFERENCES hour_types(code) ON UPDATE CASCADE;

-- =============================================================================
-- STEP 9: learning_materials -- three integrity checks present on local dev
-- =============================================================================
ALTER TABLE learning_materials
  ADD CONSTRAINT chk_material_has_file CHECK (filename IS NOT NULL OR external_url IS NOT NULL);
ALTER TABLE learning_materials
  ADD CONSTRAINT chk_publication_year CHECK (publication_year IS NULL OR publication_year BETWEEN 1000 AND 2100);
ALTER TABLE learning_materials
  ADD CONSTRAINT chk_resource_type CHECK (resource_type IS NULL OR resource_type IN
    ('book','article','research_paper','academic_paper','thesis','ebook','reference','guide','report','other'));

-- =============================================================================
-- STEP 10: events.slug -- lock down uniqueness (Migration 001's own step 4).
-- ONLY run this step if BOTH queries in verification 0.10 returned 0 rows.
-- If either returned rows: give every NULL/blank slug a real unique value
-- first (matching how backend/src/utils/eventChildren.js's
-- generateUniqueSlug would generate one), then re-run 0.10, then this step.
-- =============================================================================
ALTER TABLE events
  MODIFY slug VARCHAR(255) NOT NULL,
  ADD UNIQUE INDEX ux_events_slug (slug);
