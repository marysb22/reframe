-- Makes the "hour type" (previously hardcoded to exactly 'training'/
-- 'supervision' via CHECK constraints) Admin-configurable. Adding a new
-- usable hour type (e.g. "Application Hours") becomes a pure data change
-- via the new hour_types table -- sessions.session_type and
-- trainee_hour_adjustments.hour_type now FK to hour_types.code instead of
-- being restricted to a fixed 2-value list. Seeded with the two existing
-- real values first, so every existing row keeps satisfying the new FK
-- with zero data changes -- this is purely additive/widening, safe to
-- run against live data.
--
-- Legacy training_hours/supervision_hours tables are intentionally left
-- untouched -- they're frozen (no new inserts), and the table itself
-- already IS the type, so there's nothing to widen. supervision_hours'
-- own unrelated hour_type column (individual/group sub-classification)
-- is also untouched. tot_training_sessions/tot_hour_adjustments (the
-- Master Trainer -> ToT hours feature) have no type column and are out
-- of scope for this change.

CREATE TABLE hour_types (
  code        VARCHAR(30) PRIMARY KEY,
  label       VARCHAR(60) NOT NULL,
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  is_primary  TINYINT(1) NOT NULL DEFAULT 0,
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Admin-managed list of hour categories (Training, Supervision, and whatever else Admin adds). sessions.session_type and trainee_hour_adjustments.hour_type FK to this table''s code -- adding a new usable hour type is purely a data change, never a code change. At most one row has is_primary=1 (enforced at the application layer) -- that is the type shown on a Trainee''s own dashboard headline.';

INSERT INTO hour_types (code, label, is_active, is_primary, sort_order) VALUES
  ('training', 'Training Hours', 1, 1, 1),
  ('supervision', 'Supervision Hours', 1, 0, 2);

ALTER TABLE sessions
  DROP CHECK sessions_chk_1,
  MODIFY session_type VARCHAR(30) NOT NULL,
  ADD CONSTRAINT fk_sessions_hour_type FOREIGN KEY (session_type) REFERENCES hour_types(code) ON UPDATE CASCADE;

ALTER TABLE trainee_hour_adjustments
  DROP CHECK trainee_hour_adjustments_chk_1,
  MODIFY hour_type VARCHAR(30) NOT NULL,
  ADD CONSTRAINT fk_traineeadj_hour_type FOREIGN KEY (hour_type) REFERENCES hour_types(code) ON UPDATE CASCADE;
