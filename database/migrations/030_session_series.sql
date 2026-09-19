-- Multi-day Sessions: a "Session" a Master Trainer/ToT logs for their
-- trainees can now span several dates (e.g. a 25-hour Session delivered as
-- 5 days x 5 hours), each day keeping its own date/duration/attendance --
-- rather than being forced into session_occasions' original one-row-per-
-- date shape.
--
-- session_series is the new grouping parent, one level above the existing
-- session_occasions/sessions grouping (which already groups one date
-- across multiple trainees via occasion_id) -- the same pattern repeated
-- one level up, grouping multiple dates under one named Session.
--
-- Every EXISTING session_occasions row keeps series_id = NULL forever:
-- a single-day Session is simply a series-less occasion, exactly as it
-- has always worked. No existing row is touched, no data is migrated or
-- backfilled -- this is purely additive.
CREATE TABLE session_series (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  supervisor_id  BIGINT NOT NULL,
  session_type   VARCHAR(30) NOT NULL,
  title          VARCHAR(255),
  notes          TEXT,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_sseries_supervisor FOREIGN KEY (supervisor_id) REFERENCES supervisors(id) ON DELETE RESTRICT,
  CONSTRAINT fk_sseries_hour_type FOREIGN KEY (session_type) REFERENCES hour_types(code) ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Groups multiple session_occasions rows (one per day) into a single multi-day Session. NULL series_id on session_occasions = an ordinary single-day Session, unchanged from before this migration.';

ALTER TABLE session_occasions
  ADD COLUMN series_id BIGINT NULL,
  ADD CONSTRAINT fk_socc_series FOREIGN KEY (series_id) REFERENCES session_series(id) ON DELETE CASCADE;
