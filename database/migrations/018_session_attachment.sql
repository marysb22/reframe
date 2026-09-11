-- Adds an optional single-file attachment to a training/supervision
-- activity (the `sessions` table), for the new group-based "Add Session"
-- flow in Trainee Profiles. Mirrors the existing assignments.attachment_filename
-- pattern (backend/src/utils/uploads.js's assignmentAttachmentUpload +
-- backend/src/routes/files.js's AUTHORIZERS.assignments).
--
-- Purely additive: two new nullable columns, no existing data touched, no
-- change to any existing session/attendance/hours calculation.

ALTER TABLE sessions
  ADD COLUMN attachment_filename VARCHAR(255) NULL,
  ADD COLUMN attachment_original_name VARCHAR(255) NULL;
