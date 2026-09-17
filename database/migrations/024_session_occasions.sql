-- Session Occasions + Excuse Reasons.
--
-- Both Totdashboard.html (ToT) and masterDashborad.html (Master Trainer)
-- already ship a "Add Session for the whole caseload/Group at once, then
-- record Attendance separately through its own modal" UI (a Group Sessions
-- list + a shared Attendance modal, both referencing this migration by
-- number in their own comments). The previous group-logging routes
-- (createGroupSession / createGroupTotSession) required every attendee's
-- attendance status up front in the same submission; the shipped UI
-- instead creates the session(s) first and records Attendance afterward,
-- so it needs a way to group the individual per-trainee/per-ToT session
-- rows created together into one listable, one-Attendance-modal unit.
-- All additive: new tables and new nullable columns only, no existing
-- column altered, no existing row touched.

CREATE TABLE session_occasions (
  id                        BIGINT AUTO_INCREMENT PRIMARY KEY,
  supervisor_id             BIGINT NOT NULL,
  session_type              VARCHAR(30) NOT NULL,
  title                     VARCHAR(255),
  session_date              DATE NOT NULL,
  session_time              TIME,
  duration_minutes          INT NOT NULL CHECK (duration_minutes >= 0),
  notes                     TEXT,
  attachment_filename       VARCHAR(255),
  attachment_original_name  VARCHAR(255),
  created_at                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_socc_supervisor FOREIGN KEY (supervisor_id) REFERENCES supervisors(id) ON DELETE RESTRICT,
  CONSTRAINT fk_socc_hour_type FOREIGN KEY (session_type) REFERENCES hour_types(code) ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='One "Add Session" submission covering a whole caseload/Group at once. Each trainee still gets their own sessions row (occasion_id below) -- this row is only the shared metadata + what the Group Sessions list and Attendance modal address as a unit. No status of its own -- each trainee''s own sessions row already carries scheduled/completed/cancelled individually.';

ALTER TABLE sessions
  ADD COLUMN occasion_id BIGINT NULL,
  ADD CONSTRAINT fk_sessions_occasion FOREIGN KEY (occasion_id) REFERENCES session_occasions(id) ON DELETE CASCADE,
  ADD UNIQUE KEY uq_sessions_occasion_student (occasion_id, student_id);

-- Same grouping shape, for the ToT-training equivalent. No session_type/
-- hour_types link, matching tot_training_sessions' own existing design --
-- Master-Trainer-to-ToT training was never typed by hour bucket. "Group
-- Session event" here may include the Master Trainer's own attendance
-- (tot_id may equal the delivering master_trainer_id) when she opts to log
-- herself as an attendee of her own delivered training.
CREATE TABLE tot_session_occasions (
  id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
  master_trainer_id  BIGINT NOT NULL,
  title              VARCHAR(255),
  session_date       DATE NOT NULL,
  session_time       TIME,
  duration_minutes   INT NOT NULL CHECK (duration_minutes >= 0),
  notes              TEXT,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_tsocc_mt FOREIGN KEY (master_trainer_id) REFERENCES supervisors(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='One Master-Trainer-to-Group Session event (ToTs, optionally including the Master Trainer herself). Mirrors session_occasions for the tot_training_sessions/tot_training_attendance pair.';

ALTER TABLE tot_training_sessions
  ADD COLUMN occasion_id BIGINT NULL,
  ADD CONSTRAINT fk_totsess_occasion FOREIGN KEY (occasion_id) REFERENCES tot_session_occasions(id) ON DELETE CASCADE,
  ADD UNIQUE KEY uq_totsess_occasion_tot (occasion_id, tot_id);

-- Excuse reasons: a shared, system-wide lookup (mirrors hour_types' own
-- shape) so an "Excused" attendance entry can carry a real, reportable
-- reason instead of only a freeform notes field.
CREATE TABLE excuse_reasons (
  code        VARCHAR(30) PRIMARY KEY,
  label       VARCHAR(100) NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO excuse_reasons (code, label, sort_order) VALUES
  ('medical', 'Medical', 1),
  ('university_conflict', 'University conflict', 2),
  ('approved_leave', 'Approved leave', 3),
  ('other', 'Other', 4);

-- excuse_reason_code + an editable-audit trail (updated_by/updated_at) --
-- attendance recorded through the deferred Attendance modal is routinely
-- corrected afterward (a trainee's status/hours revised once the real
-- outcome is known), so who last touched it and when is now tracked
-- explicitly rather than left to created_at alone.
ALTER TABLE attendance
  ADD COLUMN excuse_reason_code VARCHAR(30) NULL,
  ADD COLUMN updated_by BIGINT NULL,
  ADD COLUMN updated_at DATETIME NULL,
  ADD CONSTRAINT fk_attendance_excuse_reason FOREIGN KEY (excuse_reason_code) REFERENCES excuse_reasons(code) ON UPDATE CASCADE,
  ADD CONSTRAINT fk_attendance_updated_by FOREIGN KEY (updated_by) REFERENCES user_credentials(id);

ALTER TABLE tot_training_attendance
  ADD COLUMN excuse_reason_code VARCHAR(30) NULL,
  ADD COLUMN updated_by BIGINT NULL,
  ADD COLUMN updated_at DATETIME NULL,
  ADD CONSTRAINT fk_totatt_excuse_reason FOREIGN KEY (excuse_reason_code) REFERENCES excuse_reasons(code) ON UPDATE CASCADE,
  ADD CONSTRAINT fk_totatt_updated_by FOREIGN KEY (updated_by) REFERENCES user_credentials(id);
