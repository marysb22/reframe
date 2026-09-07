-- Adds the storage needed for the new, standalone "Library" (Books) feature.
-- Reuses learning_materials as pure storage (material_type='book') rather
-- than a new table -- Library is a separate FEATURE (its own router, its
-- own UI section), not a separate database. Existing Materials rows and
-- queries are completely unaffected: every new column is nullable and only
-- ever populated by the new Library routes.
--
-- supervisor_id becomes nullable because an Admin-authored book has no
-- supervisor at all; admin_id is the alternative creator column for that
-- case (mirrors the documents.group_id-alongside-student_id precedent from
-- earlier this session). Exactly one of supervisor_id/admin_id is set per
-- row -- enforced at the application layer only (a CHECK can't reference a
-- column that also carries an ON DELETE SET NULL FK action, same MySQL
-- limitation hit before).
--
-- NOTE: constraint name `learning_materials_chk_1` confirmed via
-- `SHOW CREATE TABLE learning_materials` on the LOCAL DEV DB only.
-- Auto-generated constraint names can differ between environments
-- (confirmed multiple times earlier this session) -- always confirm via
-- SHOW CREATE TABLE on the actual target DB before running elsewhere.

ALTER TABLE learning_materials MODIFY supervisor_id BIGINT NULL;

ALTER TABLE learning_materials ADD COLUMN admin_id BIGINT NULL AFTER supervisor_id;

ALTER TABLE learning_materials
  ADD CONSTRAINT fk_material_admin FOREIGN KEY (admin_id) REFERENCES admin_users(id) ON DELETE SET NULL;

ALTER TABLE learning_materials ADD COLUMN author VARCHAR(255) NULL;
ALTER TABLE learning_materials ADD COLUMN category VARCHAR(100) NULL;
ALTER TABLE learning_materials ADD COLUMN cover_image VARCHAR(255) NULL;

ALTER TABLE learning_materials DROP CHECK learning_materials_chk_1;

ALTER TABLE learning_materials
  ADD CONSTRAINT learning_materials_chk_1 CHECK (material_type IN (
    'document', 'image', 'video', 'audio', 'link', 'assignment', 'worksheet', 'reading', 'book'
  ));
