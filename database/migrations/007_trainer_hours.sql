-- Trainer/ToT Hours & Training-Time Tracking.
--
-- Two gaps this closes:
-- 1. A Master Trainer training a ToT had no representation at all -- a ToT
--    is a row in `supervisors` (supervisor_type='in_training'), not
--    `students`, and every existing hours/attendance/session table FKs to
--    students(id) only. tot_training_sessions/tot_training_attendance
--    mirror the existing sessions/attendance shape for this relationship.
-- 2. Hours were never actually derived from attendance anywhere --
--    training_hours/supervision_hours are freeform typed numbers with an
--    unpopulated session_id. Going forward (see app-layer changes in
--    supervisor.js/Mastertrainer.js), hours are computed from
--    session.duration_minutes + attendance.status, with these two new
--    audited ledgers reserved for genuine manual exceptions only --
--    modeled directly on this codebase's payment_transactions convention
--    (append-only, never UPDATE/DELETE, negative value = correction).
--
-- Fully additive: no existing table is altered, so there is zero migration
-- risk to current session/attendance/hours data.

CREATE TABLE tot_training_sessions (
  id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
  tot_id             BIGINT NOT NULL,
  master_trainer_id  BIGINT NOT NULL,
  title              VARCHAR(255),
  session_date       DATE NOT NULL,
  session_time       TIME,
  duration_minutes   INT NOT NULL CHECK (duration_minutes >= 0),
  location           VARCHAR(255),
  notes              TEXT,
  status             VARCHAR(20) NOT NULL DEFAULT 'completed' CHECK (status IN ('scheduled', 'completed', 'cancelled')),
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_totsess_tot FOREIGN KEY (tot_id) REFERENCES supervisors(id) ON DELETE CASCADE,
  CONSTRAINT fk_totsess_mt FOREIGN KEY (master_trainer_id) REFERENCES supervisors(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Master Trainer -> ToT training sessions. Mirrors the sessions table shape for a relationship the existing student-only sessions table cannot represent.';

CREATE TABLE tot_training_attendance (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id    BIGINT NOT NULL,
  tot_id        BIGINT NOT NULL,
  status        VARCHAR(20) NOT NULL CHECK (status IN ('present', 'absent', 'excused')),
  notes         TEXT,
  recorded_by   BIGINT NOT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_totatt_session FOREIGN KEY (session_id) REFERENCES tot_training_sessions(id) ON DELETE CASCADE,
  CONSTRAINT fk_totatt_tot FOREIGN KEY (tot_id) REFERENCES supervisors(id) ON DELETE CASCADE,
  CONSTRAINT fk_totatt_recorded_by FOREIGN KEY (recorded_by) REFERENCES user_credentials(id),
  CONSTRAINT uq_totatt_session UNIQUE (session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Always created together with its tot_training_sessions row (session_id is NOT NULL and unique, unlike the legacy attendance table) so hours are always traceable to a real session, never freeform.';

CREATE TABLE tot_hour_adjustments (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  tot_id      BIGINT NOT NULL,
  hours       DECIMAL(6,2) NOT NULL,
  reason      VARCHAR(255) NOT NULL,
  notes       TEXT,
  added_by    BIGINT NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_totadj_tot FOREIGN KEY (tot_id) REFERENCES supervisors(id) ON DELETE CASCADE,
  CONSTRAINT fk_totadj_added_by FOREIGN KEY (added_by) REFERENCES user_credentials(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Append-only manual hour-adjustment ledger for a ToT, Master-Trainer-added only. Never UPDATE/DELETE -- a correction is a new row with a negative hours value and an explanatory reason, mirroring payment_transactions.';

CREATE TABLE trainee_hour_adjustments (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id  BIGINT NOT NULL,
  hour_type   VARCHAR(20) NOT NULL CHECK (hour_type IN ('training', 'supervision')),
  hours       DECIMAL(6,2) NOT NULL,
  reason      VARCHAR(255) NOT NULL,
  notes       TEXT,
  added_by    BIGINT NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_traineeadj_student FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  CONSTRAINT fk_traineeadj_added_by FOREIGN KEY (added_by) REFERENCES user_credentials(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Append-only manual hour-adjustment ledger for a Trainee, added by whichever supervisor (Master Trainer or ToT) currently has them in their supervisor_students caseload. Never UPDATE/DELETE.';

CREATE INDEX idx_totsess_tot ON tot_training_sessions(tot_id);
CREATE INDEX idx_totsess_mt ON tot_training_sessions(master_trainer_id);
CREATE INDEX idx_totatt_tot ON tot_training_attendance(tot_id);
CREATE INDEX idx_totadj_tot ON tot_hour_adjustments(tot_id);
CREATE INDEX idx_traineeadj_student ON trainee_hour_adjustments(student_id);
