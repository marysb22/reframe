-- Rollback for migration 040. Roll back the application code FIRST.
--
-- LOSSLESS ONLY BEFORE IT IS USED:
--   * Dropping session_contributions erases every multi-trainer day's
--     per-trainer split. Those days' parents keep their duration and their
--     first contributor in provided_by_*, so after rollback the WHOLE day
--     would be credited to that first trainer -- other trainers' hours
--     would move to them. Export the table first if 0.2 is not zero.
--   * Dropping learning_materials.visibility does NOT expose anything that
--     was trainer-only before 040 (those rows still have group_id /
--     shared_with_supervisor_id, which the pre-040 code already hides).
--     BUT any private Trainer Space item created after 040 WITHOUT a group
--     or recipient would become trainee-visible under the old code. 0.3
--     must be 0, or delete/reassign those rows first.

-- STEP 0
SELECT DATABASE() AS target_database;
-- 0.2
SELECT COUNT(*) AS contribution_rows FROM session_contributions;
-- 0.3 -- must be 0
SELECT COUNT(*) AS private_items_without_group_or_recipient FROM learning_materials
 WHERE visibility = 'training_team' AND group_id IS NULL AND shared_with_supervisor_id IS NULL;

-- STEP 1
ALTER TABLE learning_materials
  DROP CONSTRAINT chk_material_visibility,
  DROP CONSTRAINT chk_material_team_section,
  DROP INDEX idx_materials_visibility_group,
  DROP COLUMN visibility,
  DROP COLUMN team_section,
  DROP COLUMN updated_at;
DROP TABLE session_contributions;
DROP TABLE trainer_titles;
