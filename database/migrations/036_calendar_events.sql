-- calendar_events ("Notes" on the unified Calendar) -- this table already
-- exists in database/reframe_mhs_schema.sql and in this app's local dev
-- database, but was never captured in a numbered migration file, so
-- production almost certainly does not have it yet (every other table in
-- this app reached production through a numbered migration; this is the
-- one exception, discovered while building the unified Calendar feature).
-- Confirm first with:
--   SELECT 1 FROM information_schema.TABLES
--   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'calendar_events';
-- If that returns a row, skip this file entirely -- the table already
-- exists on production and this would otherwise fail with "table already
-- exists".

CREATE TABLE calendar_events (
  id                    BIGINT AUTO_INCREMENT PRIMARY KEY,
  owner_id              BIGINT NOT NULL,        -- who created/owns this entry (Admin/Master Trainer/ToT)
  student_id            BIGINT,                 -- target audience, NULL = broader (whole caseload/Group)
  event_type            VARCHAR(30) NOT NULL CHECK (event_type IN (
                            'session', 'meeting', 'assignment_deadline', 'custom', 'holiday'
                          )),
  title                 VARCHAR(255) NOT NULL,
  description           TEXT,
  event_date            DATE NOT NULL,
  event_time            TIME,
  related_session_id    BIGINT,
  related_meeting_id    BIGINT,
  related_assignment_id BIGINT,
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_calevents_owner FOREIGN KEY (owner_id) REFERENCES user_credentials(id),
  CONSTRAINT fk_calevents_student FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  CONSTRAINT fk_calevents_session FOREIGN KEY (related_session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  CONSTRAINT fk_calevents_meeting FOREIGN KEY (related_meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
  CONSTRAINT fk_calevents_assignment FOREIGN KEY (related_assignment_id) REFERENCES assignments(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Manual Calendar notes/reminders -- the "Add Notes" feature. event_type=custom is a plain manual note; the other types are reserved for a future auto-generated entry, not used by the Add Notes UI itself.';

CREATE INDEX idx_calevents_owner_date ON calendar_events(owner_id, event_date);
CREATE INDEX idx_calevents_student_date ON calendar_events(student_id, event_date);
