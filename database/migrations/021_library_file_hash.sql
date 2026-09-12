-- Adds a content hash to learning_materials so a duplicate Library book
-- upload (the exact same file, possibly renamed) can be detected reliably
-- by content rather than by filename -- see backend/src/routes/library.js's
-- POST /books. Scoped in application code to material_type='book' rows
-- only; Materials (non-book) legitimately can share identical file content
-- (e.g. the same handout shared more than once) so this is not a unique
-- constraint, just an indexed lookup column.
--
-- Purely additive: one new nullable column + index. Existing rows keep
-- file_hash = NULL and are never mistakenly flagged as duplicates of
-- each other or of a new upload.

ALTER TABLE learning_materials
  ADD COLUMN file_hash VARCHAR(64) NULL,
  ADD INDEX idx_materials_file_hash (file_hash);
