-- A Trainee's "Share with My Group" document must not become visible to the
-- rest of the group immediately -- it starts pending, visible only to the
-- uploader and the group's ToTs, until any ONE of those ToTs approves it.
-- Purely additive; DEFAULT 'approved' means every existing row (and every
-- Admin/Supervisor-authored row, and every "My ToT" share) is completely
-- unaffected -- only the new group-share insert path ever writes 'pending'.

ALTER TABLE documents ADD COLUMN approval_status VARCHAR(20) NOT NULL DEFAULT 'approved';

ALTER TABLE documents ADD CONSTRAINT chk_document_approval_status
  CHECK (approval_status IN ('pending', 'approved'));

ALTER TABLE documents ADD COLUMN approved_by BIGINT NULL;

ALTER TABLE documents ADD CONSTRAINT fk_documents_approved_by
  FOREIGN KEY (approved_by) REFERENCES supervisors(id) ON DELETE SET NULL;

ALTER TABLE documents ADD COLUMN approved_at DATETIME NULL;
