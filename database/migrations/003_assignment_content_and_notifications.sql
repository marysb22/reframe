-- =============================================================================
-- Migration 003: Assignment content link (Assignments + Notifications redesign)
-- =============================================================================
-- Run this whole file in phpMyAdmin's SQL tab against the live database.
-- Purely additive -- one new nullable column, no backfill required, safe to
-- run standalone.
--
-- WHY: the redesigned Assignment creation flow needs an optional video/
-- resource link alongside the existing file attachment. `attachment_filename`
-- already exists on `assignments` (previously dead -- nothing ever wrote or
-- read it); this migration only adds the missing second field rather than
-- duplicating the separate `learning_materials`/`videos` tables' relational
-- structure for a single optional URL.
--
-- Note: this redesign's Notifications system needs NO migration -- the
-- `notifications` table and `settings.notify_*` columns already exist live
-- in the database (confirmed via direct inspection: 0 rows in `notifications`,
-- full CHECK-constrained schema already in place, including a
-- `notification_type` value of 'assignment' anticipating exactly this
-- feature). They were part of the original baseline schema and were simply
-- never wired up by any application code until now.

ALTER TABLE assignments
  ADD COLUMN content_url VARCHAR(2048) NULL AFTER attachment_filename;
