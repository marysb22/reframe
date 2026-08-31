-- Composite indexes on attendance/training_hours/supervision_hours keyed
-- by (supervisor_id, date), mirroring the (student_id, date) indexes that
-- already exist on all three tables (see reframe_mhs_schema.sql). Every
-- Trainer-facing dashboard/report query filters these tables by
-- supervisor_id + a date range (Weekly Reports, the Master Trainer's
-- per-ToT stats, hours breakdowns) -- the student-side equivalent was
-- indexed, the supervisor-side case was missed. No query behavior
-- changes; this only speeds up lookups that already happen today and
-- protects against them slowing down as years of sessions/hours
-- accumulate per Trainer.

CREATE INDEX idx_attendance_supervisor_date ON attendance(supervisor_id, attendance_date DESC);
CREATE INDEX idx_training_hours_supervisor_date ON training_hours(supervisor_id, hour_date DESC);
CREATE INDEX idx_supervision_hours_supervisor_date ON supervision_hours(supervisor_id, hour_date DESC);
