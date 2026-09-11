-- Adds partial-attendance support to Master Trainer -> ToT training
-- (tot_training_attendance), matching the trainee-side `attendance` table's
-- existing present/partial/absent shape (attendance.minutes_completed).
-- Needed for the new group-based "Add Session" flow that lets a Master
-- Trainer log one session for multiple ToTs at once, each with their own
-- actual hours attended -- see backend/src/utils/groupTotSessions.js.
--
-- Purely additive: widens the existing status CHECK to include 'partial'
-- and adds one new nullable column. No existing rows/values are touched.

ALTER TABLE tot_training_attendance
  DROP CONSTRAINT tot_training_attendance_chk_1;

ALTER TABLE tot_training_attendance
  ADD CONSTRAINT tot_training_attendance_chk_1 CHECK (status IN ('present', 'absent', 'excused', 'partial')),
  ADD COLUMN minutes_completed INT NULL;
