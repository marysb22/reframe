-- Adds a 'partial' attendance status plus the actual minutes completed for
-- that case. present/absent/excused are unaffected -- minutes_completed
-- stays NULL for every existing row and is only ever read when
-- status='partial'.
--
-- NOTE: constraint name `attendance_chk_1` confirmed via
-- `SHOW CREATE TABLE attendance` on the LOCAL DEV DB only. Auto-generated
-- constraint names can differ between environments (confirmed earlier this
-- session) -- always confirm via SHOW CREATE TABLE on the actual target DB
-- before running this elsewhere.

ALTER TABLE attendance ADD COLUMN minutes_completed INT NULL;

ALTER TABLE attendance DROP CHECK attendance_chk_1;

ALTER TABLE attendance
  ADD CONSTRAINT attendance_chk_1 CHECK (status IN ('present', 'absent', 'excused', 'partial'));
