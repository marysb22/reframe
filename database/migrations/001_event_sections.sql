-- =============================================================================
-- Migration 001: Event sections (Speakers/Agenda/Sponsors/Gallery/Registration
-- on-off toggles) + shareable per-event slug.
-- =============================================================================
-- Run this whole file in phpMyAdmin's SQL tab against the live database, in
-- order top to bottom. Steps 1-2 are schema-only and safe to run standalone;
-- step 3 (slug backfill) must be done via backend/scripts/backfill-event-slugs.js
-- BEFORE running step 4 (which requires every row to already have a slug).

-- -----------------------------------------------------------------------------
-- STEP 1: New columns on events
-- -----------------------------------------------------------------------------
-- show_registration defaults TRUE: the public site renders the Register
-- button unconditionally today (no existing conditional on fee/register_url),
-- so TRUE for every existing row is the accurate backward-compatible mapping.
-- The other 4 toggles default FALSE: no existing row has any speaker/agenda/
-- sponsor/gallery data, so nothing is lost and no empty section can appear.
ALTER TABLE events
  ADD COLUMN slug              VARCHAR(255) NULL,
  ADD COLUMN show_speakers     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN show_agenda       BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN show_sponsors     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN show_gallery      BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN show_registration BOOLEAN NOT NULL DEFAULT TRUE;

-- -----------------------------------------------------------------------------
-- STEP 2: New child tables
-- -----------------------------------------------------------------------------
CREATE TABLE event_speakers (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  event_id    BIGINT NOT NULL,
  name_en     VARCHAR(255),
  name_ar     VARCHAR(255),
  title_en    VARCHAR(255),   -- role/position, e.g. "Clinical Director"
  title_ar    VARCHAR(255),
  bio_en      TEXT,
  bio_ar      TEXT,
  photo       VARCHAR(255),   -- same /uploads/events/... convention as events.image
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_event_speakers_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Speaker cards shown on an event detail page when events.show_speakers is true. Replace-all on save (see designer.js) -- ids are not stable across edits.';

CREATE TABLE event_sponsors (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  event_id    BIGINT NOT NULL,
  name        VARCHAR(255),
  logo        VARCHAR(255),
  url         VARCHAR(2048),
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_event_sponsors_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Sponsor logos shown on an event detail page when events.show_sponsors is true. Replace-all on save.';

CREATE TABLE event_gallery (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  event_id     BIGINT NOT NULL,
  image        VARCHAR(255) NOT NULL,
  caption_en   VARCHAR(255),
  caption_ar   VARCHAR(255),
  sort_order   INT NOT NULL DEFAULT 0,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_event_gallery_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Gallery images shown on an event detail page when events.show_gallery is true. Replace-all on save.';

CREATE TABLE event_agenda_items (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  event_id       BIGINT NOT NULL,
  item_date      DATE,           -- nullable: NULL means "same day as events.event_date"
  start_time     TIME,
  end_time       TIME,
  title_en       VARCHAR(255),
  title_ar       VARCHAR(255),
  description_en TEXT,
  description_ar TEXT,
  speaker_id     BIGINT,         -- optional link to event_speakers.id
  sort_order     INT NOT NULL DEFAULT 0,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_event_agenda_event   FOREIGN KEY (event_id)   REFERENCES events(id) ON DELETE CASCADE,
  CONSTRAINT fk_event_agenda_speaker FOREIGN KEY (speaker_id) REFERENCES event_speakers(id) ON DELETE SET NULL,
  INDEX ix_event_agenda_date (item_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Per-event schedule shown when events.show_agenda is true. Structured with real date/time columns (not a JSON blob) so a future site-wide Agenda page could query across events without a redesign -- that page is out of scope for now. Replace-all on save.';

-- -----------------------------------------------------------------------------
-- STEP 3: Slug backfill -- DO NOT run manually here.
-- -----------------------------------------------------------------------------
-- Run `node backend/scripts/backfill-event-slugs.js` against this database
-- (it uses the same DATABASE_URL the app already uses) BEFORE step 4. It
-- needs per-row collision handling that plain SQL can't express cleanly.

-- -----------------------------------------------------------------------------
-- STEP 4: Lock the slug column down -- run this ONLY after step 3 completes
-- and every row has a non-null slug (the backfill script verifies this
-- itself and prints a warning if not, but double-check with:
--   SELECT COUNT(*) FROM events WHERE slug IS NULL;   -- must be 0
-- before running the ALTER below).
-- -----------------------------------------------------------------------------
ALTER TABLE events
  MODIFY slug VARCHAR(255) NOT NULL,
  ADD UNIQUE INDEX ux_events_slug (slug);
