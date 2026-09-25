-- A Notes record's own optional "Memo" file attachment (upload/replace/
-- remove/view/download from a Notes record in the ToT dashboard). Purely
-- additive -- two new nullable columns, no existing rows affected.
--
-- Verified applied on the local dev DB already; NOT yet applied to
-- production as of 2026-09-25 (production's learning_materials/documents/
-- sessions tables already have this attachment_filename/
-- attachment_original_name pattern -- supervisor_notes never got it).

ALTER TABLE supervisor_notes
  ADD COLUMN attachment_filename VARCHAR(255) NULL,
  ADD COLUMN attachment_original_name VARCHAR(255) NULL;
