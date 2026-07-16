-- Reframe MHS backend schema (SQLite)

PRAGMA foreign_keys = ON;

-- Tracks the last number used for each ID prefix, so IDs (TTR001, TTR002, ...)
-- are generated atomically and never collide, no matter how many users exist.
CREATE TABLE IF NOT EXISTS id_counters (
  prefix      TEXT PRIMARY KEY,
  last_number INTEGER NOT NULL DEFAULT 0
);

-- Every account: trainees, supervisors, and admins all live in one table,
-- distinguished by `role`. This keeps login and ID generation uniform for
-- "many users, no fixed number" as requested.
CREATE TABLE IF NOT EXISTS users (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  member_code           TEXT NOT NULL UNIQUE,        -- e.g. TTR001
  password_hash         TEXT NOT NULL,
  role                  TEXT NOT NULL DEFAULT 'trainee'
                          CHECK (role IN ('trainee', 'supervisor', 'admin')),
  status                TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'suspended')),
  must_change_password  INTEGER NOT NULL DEFAULT 1,  -- 1 = true, 0 = false

  full_name             TEXT NOT NULL,
  email                 TEXT UNIQUE,
  gender                TEXT,
  date_of_birth         TEXT,                        -- ISO date string
  marital_status        TEXT,
  phone                 TEXT,
  address               TEXT,

  highest_degree        TEXT,
  institution            TEXT,
  certifications        TEXT,

  cohort                TEXT,
  current_year          INTEGER,

  cv_file               TEXT,                        -- stored filename in uploads/cv
  photo                 TEXT,                        -- stored filename in uploads/photos

  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Many-to-many: a trainee can have one or more supervisors, and a supervisor
-- can supervise many trainees.
CREATE TABLE IF NOT EXISTS user_supervisors (
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  supervisor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, supervisor_id)
);

-- Simple audit trail, shown on the profile page's "Security & Activity" list.
CREATE TABLE IF NOT EXISTS activity_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_log(user_id, created_at DESC);

-- Everything a supervisor logs for an assigned student: attendance, training
-- sessions, supervision sessions, clinical hours, assignments, notes, and
-- evaluations. One flexible table (distinguished by record_type) keeps the
-- API small while still covering every category the student's My Profile
-- page needs to display.
CREATE TABLE IF NOT EXISTS student_records (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  supervisor_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  record_type       TEXT NOT NULL CHECK (record_type IN (
                        'attendance', 'training_session', 'supervision_session',
                        'clinical_hours', 'assignment', 'note', 'evaluation'
                      )),
  record_date       TEXT,                 -- date the record applies to
  record_time       TEXT,                 -- optional time (HH:MM), used for scheduling sessions
  duration_minutes  INTEGER,              -- sessions / clinical hours
  status            TEXT,                 -- attendance: present/absent/excused; assignment: pending/completed
  title             TEXT,
  content           TEXT,                 -- notes, descriptions, feedback
  score             REAL,                 -- evaluations
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_records_student ON student_records(student_id, record_type, record_date DESC);
CREATE INDEX IF NOT EXISTS idx_records_supervisor ON student_records(supervisor_id);

-- Files a supervisor uploads for a specific student (feedback docs, forms, etc.)
CREATE TABLE IF NOT EXISTS documents (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  uploaded_by    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename       TEXT NOT NULL,
  original_name  TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_documents_student ON documents(student_id, created_at DESC);

-- Direct messages between a supervisor and one of their assigned students.
CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content       TEXT NOT NULL,
  is_read       INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_participants ON messages(sender_id, recipient_id, created_at DESC);

-- Resources a supervisor shares with ALL of their currently-assigned
-- students at once (not tied to one student), e.g. a reading or a
-- worksheet the whole caseload should see.
CREATE TABLE IF NOT EXISTS learning_materials (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  supervisor_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  description    TEXT,
  material_type  TEXT NOT NULL CHECK (material_type IN (
                     'document', 'image', 'video', 'audio', 'link',
                     'assignment', 'worksheet', 'reading'
                   )),
  filename       TEXT,              -- set when uploaded (document/image/video/audio/worksheet)
  original_name  TEXT,
  external_url   TEXT,              -- set when material_type = 'link'
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_materials_supervisor ON learning_materials(supervisor_id, created_at DESC);

-- Broadcast announcements from a supervisor to their whole caseload.
CREATE TABLE IF NOT EXISTS announcements (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  supervisor_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  content        TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_announcements_supervisor ON announcements(supervisor_id, created_at DESC);

-- Events shown on the public events.html page. Replaces the old static
-- content/events.json file -- admins manage these from the dashboard,
-- and the public page fetches them live from GET /api/events.
CREATE TABLE IF NOT EXISTS events (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  event_date          TEXT NOT NULL,       -- ISO datetime string
  image               TEXT,
  status              TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming', 'concluded')),
  fee                 TEXT,
  register_url        TEXT,

  title_en            TEXT,
  format_en           TEXT,
  facilitator_en      TEXT,
  about_en            TEXT,
  learn_en            TEXT,                -- JSON array of strings
  who_en              TEXT,                -- JSON array of strings
  outcomes_en         TEXT,                -- JSON array of strings
  facilitator_bio_en  TEXT,

  title_ar            TEXT,
  format_ar           TEXT,
  facilitator_ar      TEXT,
  about_ar            TEXT,
  learn_ar            TEXT,
  who_ar              TEXT,
  outcomes_ar         TEXT,
  facilitator_bio_ar  TEXT,

  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_date ON events(event_date DESC);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);

-- Payment management. Money is stored in cents (integers) everywhere to
-- avoid floating-point rounding errors -- the standard approach for
-- financial data. Divide by 100 only when displaying to a person.
CREATE TABLE IF NOT EXISTS payment_profiles (
  user_id         INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  total_fee_cents INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Append-only payment ledger. Transactions are never edited or deleted
-- once created -- corrections are made by adding a new transaction (a
-- refund/adjustment with a negative amount and an explanatory note),
-- so the financial history is always complete and trustworthy.
CREATE TABLE IF NOT EXISTS payment_transactions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents  INTEGER NOT NULL,
  payment_date  TEXT NOT NULL,
  method        TEXT,
  added_by      INTEGER NOT NULL REFERENCES users(id),
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payment_tx_user ON payment_transactions(user_id, payment_date DESC);