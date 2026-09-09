-- Lets a document be shared directly with one specific supervisor (used for
-- a Trainee sharing with their assigned ToT) -- previously `documents` could
-- only target one trainee (student_id) or a whole group (group_id). Purely
-- additive; every existing row keeps its current meaning (NULL here).

ALTER TABLE documents ADD COLUMN shared_with_supervisor_id BIGINT NULL;

ALTER TABLE documents ADD CONSTRAINT fk_documents_shared_supervisor
  FOREIGN KEY (shared_with_supervisor_id) REFERENCES supervisors(id) ON DELETE SET NULL;

ALTER TABLE documents ADD INDEX idx_documents_shared_supervisor (shared_with_supervisor_id);
