-- Lets a document be shared with an entire trainer_group instead of just one
-- trainee. student_id becomes nullable (mirrors the existing
-- learning_materials.student_id NULL = "whole caseload" pattern); group_id
-- is the new alternative target. Every existing row keeps student_id set
-- and group_id NULL, so chk_documents_target is satisfied with no data
-- changes -- fully backward compatible.
--
-- NOTE: constraint name `documents_chk_1` below was confirmed via
-- `SHOW CREATE TABLE documents` on the LOCAL DEV DB only (it's the
-- pre-existing document_type CHECK, untouched by this migration -- included
-- here only as a sanity reference, not dropped). Auto-generated constraint
-- names can differ between environments (confirmed earlier this session
-- with sessions_chk_1/trainee_hour_adjustments_chk_1) -- always confirm
-- via SHOW CREATE TABLE on the actual target DB before running elsewhere.

ALTER TABLE documents MODIFY student_id BIGINT NULL;

ALTER TABLE documents ADD COLUMN group_id BIGINT NULL AFTER student_id;

ALTER TABLE documents
  ADD CONSTRAINT fk_documents_group FOREIGN KEY (group_id) REFERENCES trainer_groups(id) ON DELETE SET NULL;

-- No CHECK(student_id IS NOT NULL OR group_id IS NOT NULL) here: MySQL
-- rejects a CHECK on a column that also has an ON DELETE SET NULL FK action
-- ("needed in a foreign key constraint's referential action"). Enforced at
-- the application layer instead (supervisor.js's upload route always sets
-- exactly one of the two).
