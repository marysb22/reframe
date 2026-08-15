-- =============================================================================
-- Reframe MHS System -- PostgreSQL Database Schema
-- =============================================================================
-- Target: PostgreSQL 14+
-- Scope: SQL ONLY. No routes, controllers, or application logic.
-- Run against an empty database, top to bottom.
--
-- DESIGN NOTES (read before altering):
--
-- 1. IDENTITY MODEL
--    `user_credentials` is the single authentication table for every human
--    in the system (admin, supervisor, student). Login always starts here.
--    `admin_users`, `supervisors`, and `students` each 1:1-extend a
--    credential row and SHARE ITS PRIMARY KEY (students.id IS
--    user_credentials.id for that person, not a separate surrogate key).
--    This means:
--      - Any "who did this" column (message sender, payment recorder,
--        document uploader, audit actor) can be a single FK to
--        user_credentials(id), regardless of that person's role.
--      - Any "whose training data is this" column (sessions, assignments,
--        attendance) is a FK to the specific role table (students.id),
--        since only students have training records.
--    INVARIANT (enforced by convention, not a DB constraint): a
--    user_credentials row with role = 'trainee' must have exactly one
--    matching row in `students` with the same id, created in the same
--    transaction. Same for 'supervisor' -> supervisors, 'admin' ->
--    admin_users. A cross-table CHECK isn't expressible in vanilla SQL;
--    enforce this at the application's account-creation transaction.
--
-- 2. MONEY
--    All monetary columns are integer *_cents to avoid floating-point
--    rounding, matching the convention already used in this system's
--    existing application code. Divide by 100 only when displaying.
--
-- 3. IDS
--    Internal primary keys are BIGSERIAL/SERIAL integers. The human-facing
--    login ID (e.g. "TTR001", "SUP004", "ADM001") lives in
--    user_credentials.member_code and is generated via id_counters.
--
-- 4. CALENDAR
--    `calendar_events` is a real, queryable table (not a view) so a single
--    date-range query can drive a month calendar without UNIONing
--    sessions + meetings + assignment deadlines at query time. Populating
--    it when a session/meeting/assignment is created is an application
--    responsibility (or add triggers later) -- deliberately not built
--    here to keep this script pure schema, not business logic.
--
-- 5. ROW-LEVEL SECURITY
--    RLS policies are included at the bottom for payment and health-info
--    tables (requirement: payments = Admin only, Student = read-only,
--    Supervisor = no access; health info = restricted). These are inert
--    until the application sets `app.current_user_id` and `app.user_role`
--    per session/transaction -- see the RLS section for the exact calls
--    required. The schema is fully correct and usable without RLS enabled;
--    it's an additional defense-in-depth layer, not a replacement for
--    application-level authorization checks.
-- =============================================================================


-- =============================================================================
-- SECTION 0: EXTENSIONS
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid() available if ever needed


-- =============================================================================
-- SECTION 1: ID GENERATION
-- =============================================================================

CREATE TABLE id_counters (
  prefix       TEXT PRIMARY KEY,             -- 'TTR', 'SUP', 'ADM'
  last_number  INTEGER NOT NULL DEFAULT 0 CHECK (last_number >= 0)
);
COMMENT ON TABLE id_counters IS
  'Tracks the last number issued per member_code prefix so IDs (TTR001, TTR002, ...) never collide. Increment atomically inside the same transaction that inserts the new user_credentials row.';


-- =============================================================================
-- SECTION 2: IDENTITY & AUTHENTICATION
-- =============================================================================

CREATE TABLE user_credentials (
  id                     BIGSERIAL PRIMARY KEY,
  member_code            TEXT NOT NULL UNIQUE,
  password_hash          TEXT NOT NULL,
  role                   TEXT NOT NULL CHECK (role IN ('trainee', 'supervisor', 'admin', 'designer')),
  status                 TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  must_change_password   BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at          TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE user_credentials IS
  'Single auth table for every role. Login always starts here; role determines which profile table (admin_users/supervisors/students) to join.';

CREATE TABLE cohorts (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  start_date    DATE,
  end_date      DATE,
  description   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);

CREATE TABLE admin_users (
  id            BIGINT PRIMARY KEY REFERENCES user_credentials(id) ON DELETE CASCADE,
  full_name     TEXT NOT NULL,
  email         TEXT UNIQUE,
  phone         TEXT,
  photo         TEXT,                        -- stored filename in uploads/photos
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE admin_users IS
  'Profile extension of user_credentials for role = admin. One static/seeded admin account per requirement #5; more can be added later, still Admin-only creatable.';

CREATE TABLE designers (
  id            BIGINT PRIMARY KEY REFERENCES user_credentials(id) ON DELETE CASCADE,
  full_name     TEXT NOT NULL,
  email         TEXT UNIQUE,
  phone         TEXT,
  photo         TEXT,                        -- stored filename in uploads/photos
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE designers IS
  'Profile extension of user_credentials for role = designer. Owns the events they create (see events.created_by); only Admin creates these accounts.';

-- supervisor_type / primary_supervisor_id encode the required hierarchy:
--   Admin
--     -> Primary Supervisor            (supervisor_type = 'primary', primary_supervisor_id IS NULL)
--          -> Supervisor in Training 1  (supervisor_type = 'in_training', primary_supervisor_id = the primary's id)
--          -> Supervisor in Training 2  (supervisor_type = 'in_training', primary_supervisor_id = the primary's id)
-- Both Supervisors in Training point directly at the same Primary row --
-- never at each other -- so there is no way to represent one SIT reporting
-- to another. Only Admin ever writes these columns (routes/admin.js); a
-- Primary Supervisor has no account-creation or reassignment route of its
-- own, so it can't create or move its own trainees.
CREATE TABLE supervisors (
  id                     BIGINT PRIMARY KEY REFERENCES user_credentials(id) ON DELETE CASCADE,
  full_name              TEXT NOT NULL,
  email                  TEXT UNIQUE,
  phone                  TEXT,
  photo                  TEXT,
  bio                    TEXT,
  specialization         TEXT,
  supervisor_type        TEXT NOT NULL DEFAULT 'primary' CHECK (supervisor_type IN ('primary', 'in_training')),
  -- RESTRICT, not SET NULL: setting this NULL on delete would violate the
  -- CHECK below for an 'in_training' row. A Primary Supervisor with
  -- trainees assigned must be reassigned (or the trainees deleted/
  -- reassigned first) before they can be deleted -- suspend instead, same
  -- as every other non-trainee role with dependent history in this schema.
  primary_supervisor_id  BIGINT REFERENCES supervisors(id) ON DELETE RESTRICT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (supervisor_type = 'primary' AND primary_supervisor_id IS NULL) OR
    (supervisor_type = 'in_training' AND primary_supervisor_id IS NOT NULL)
  )
);
COMMENT ON TABLE supervisors IS
  'Profile extension of user_credentials for role = supervisor. Only Admin creates these rows. supervisor_type/primary_supervisor_id encode the required 1 Primary + 2 Supervisors-in-Training hierarchy -- see the comment above the table.';

CREATE TABLE students (
  id                  BIGINT PRIMARY KEY REFERENCES user_credentials(id) ON DELETE CASCADE,
  full_name           TEXT NOT NULL,
  email               TEXT UNIQUE,
  gender              TEXT,
  date_of_birth       DATE,
  marital_status      TEXT,
  phone               TEXT,
  address             TEXT,
  highest_degree      TEXT,
  institution         TEXT,
  certifications      TEXT,
  cohort_id           INTEGER REFERENCES cohorts(id) ON DELETE SET NULL,
  current_year        INTEGER CHECK (current_year IS NULL OR current_year BETWEEN 1 AND 10),
  cv_file             TEXT,                  -- stored filename in uploads/cv
  photo               TEXT,                  -- stored filename in uploads/photos
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE students IS
  'Profile extension of user_credentials for role = trainee. Only Admin creates these rows; Supervisors may only assign existing students, never create new ones.';

CREATE TABLE supervisor_students (
  supervisor_id   BIGINT NOT NULL REFERENCES supervisors(id) ON DELETE RESTRICT,
  student_id      BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  assigned_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_by     BIGINT REFERENCES user_credentials(id) ON DELETE SET NULL,  -- who performed the assignment (supervisor or admin)
  PRIMARY KEY (supervisor_id, student_id)
);
COMMENT ON TABLE supervisor_students IS
  'Many-to-many caseload assignment. A supervisor can only read/manage students present in this table for them.';


-- =============================================================================
-- SECTION 3: ACCOUNT SETTINGS & PRIVACY
-- =============================================================================

CREATE TABLE settings (
  user_id               BIGINT PRIMARY KEY REFERENCES user_credentials(id) ON DELETE CASCADE,
  language              TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'ar')),
  theme                 TEXT NOT NULL DEFAULT 'light' CHECK (theme IN ('light', 'dark')),
  timezone              TEXT DEFAULT 'Asia/Beirut',
  notify_messages       BOOLEAN NOT NULL DEFAULT TRUE,
  notify_assignments    BOOLEAN NOT NULL DEFAULT TRUE,
  notify_sessions       BOOLEAN NOT NULL DEFAULT TRUE,
  notify_payments       BOOLEAN NOT NULL DEFAULT TRUE,
  notify_announcements  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE settings IS
  'One row per account. Replaces the localStorage-only notification-preference stopgap used before this table existed.';

CREATE TABLE privacy_preferences (
  user_id                       BIGINT PRIMARY KEY REFERENCES user_credentials(id) ON DELETE CASCADE,
  show_photo_to_others          BOOLEAN NOT NULL DEFAULT TRUE,
  share_progress_with_cohort    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE student_health_info (
  student_id                      BIGINT PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,
  medical_conditions              TEXT,
  emergency_contact_name          TEXT,
  emergency_contact_relationship  TEXT,
  emergency_contact_phone         TEXT,
  consent_given                   BOOLEAN NOT NULL DEFAULT FALSE,
  consent_given_at                TIMESTAMPTZ,
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE student_health_info IS
  'Restricted medical/emergency data (requirement #6). Only authorized staff should read this -- see RLS policy at the bottom of this script. Not in the originally enumerated table list but required by "Restricted medical/privacy information" in the requirements doc.';


-- =============================================================================
-- SECTION 4: SESSIONS, ATTENDANCE, HOURS
-- =============================================================================

CREATE TABLE sessions (
  id                 BIGSERIAL PRIMARY KEY,
  student_id         BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  supervisor_id      BIGINT NOT NULL REFERENCES supervisors(id) ON DELETE RESTRICT,
  session_type       TEXT NOT NULL CHECK (session_type IN ('training', 'supervision')),
  title              TEXT,
  session_date       DATE NOT NULL,
  session_time       TIME,
  duration_minutes   INTEGER CHECK (duration_minutes IS NULL OR duration_minutes >= 0),
  location           TEXT,
  notes              TEXT,
  status             TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE attendance (
  id             BIGSERIAL PRIMARY KEY,
  student_id     BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  supervisor_id  BIGINT NOT NULL REFERENCES supervisors(id) ON DELETE RESTRICT,
  session_id     BIGINT REFERENCES sessions(id) ON DELETE SET NULL,  -- optional link to a specific session
  attendance_date DATE NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('present', 'absent', 'excused')),
  notes          TEXT,
  recorded_by    BIGINT NOT NULL REFERENCES user_credentials(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE training_hours (
  id             BIGSERIAL PRIMARY KEY,
  student_id     BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  supervisor_id  BIGINT NOT NULL REFERENCES supervisors(id) ON DELETE RESTRICT,
  session_id     BIGINT REFERENCES sessions(id) ON DELETE SET NULL,
  hours          NUMERIC(6,2) NOT NULL CHECK (hours >= 0),
  hour_date      DATE NOT NULL,
  description    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE supervision_hours (
  id             BIGSERIAL PRIMARY KEY,
  student_id     BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  supervisor_id  BIGINT NOT NULL REFERENCES supervisors(id) ON DELETE RESTRICT,
  session_id     BIGINT REFERENCES sessions(id) ON DELETE SET NULL,
  hours          NUMERIC(6,2) NOT NULL CHECK (hours >= 0),
  hour_date      DATE NOT NULL,
  hour_type      TEXT CHECK (hour_type IN ('individual', 'group')),
  description    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE training_hours IS 'Kept separate from supervision_hours because clinical training programs typically report these to accreditation bodies as distinct totals.';


-- =============================================================================
-- SECTION 5: ASSIGNMENTS
-- =============================================================================

CREATE TABLE assignments (
  id                  BIGSERIAL PRIMARY KEY,
  student_id          BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  supervisor_id       BIGINT NOT NULL REFERENCES supervisors(id) ON DELETE RESTRICT,
  title               TEXT NOT NULL,
  description         TEXT,
  attachment_filename TEXT,                  -- optional file the supervisor attaches (instructions, template)
  due_date            DATE,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'submitted', 'completed', 'overdue')),
  max_score           NUMERIC(5,2),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE assignment_submissions (
  id              BIGSERIAL PRIMARY KEY,
  assignment_id   BIGINT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  student_id      BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  filename        TEXT NOT NULL,
  original_name   TEXT NOT NULL,
  notes           TEXT,
  submitted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  score           NUMERIC(5,2),
  feedback        TEXT,
  graded_by       BIGINT REFERENCES supervisors(id),
  graded_at       TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'graded', 'returned'))
);
COMMENT ON TABLE assignment_submissions IS
  'Fills the "students can submit assignments" gap -- previously unmodeled, flagged in earlier dashboard builds.';


-- =============================================================================
-- SECTION 6: MATERIALS, VIDEOS, DOCUMENTS
-- =============================================================================

CREATE TABLE learning_materials (
  id             BIGSERIAL PRIMARY KEY,
  supervisor_id  BIGINT NOT NULL REFERENCES supervisors(id) ON DELETE RESTRICT,
  student_id     BIGINT REFERENCES students(id) ON DELETE CASCADE,  -- NULL = shared with whole caseload
  title          TEXT NOT NULL,
  description    TEXT,
  material_type  TEXT NOT NULL CHECK (material_type IN (
                     'document', 'image', 'video', 'audio', 'link',
                     'assignment', 'worksheet', 'reading'
                   )),
  filename       TEXT,
  original_name  TEXT,
  external_url   TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (filename IS NOT NULL OR external_url IS NOT NULL)
);

CREATE TABLE videos (
  id                 BIGSERIAL PRIMARY KEY,
  supervisor_id      BIGINT NOT NULL REFERENCES supervisors(id) ON DELETE RESTRICT,
  student_id         BIGINT REFERENCES students(id) ON DELETE CASCADE,  -- NULL = whole caseload
  session_id         BIGINT REFERENCES sessions(id) ON DELETE SET NULL, -- e.g. a recorded session
  title              TEXT NOT NULL,
  description        TEXT,
  filename           TEXT,
  external_url       TEXT,          -- e.g. YouTube/Vimeo embed
  thumbnail_filename TEXT,
  duration_seconds   INTEGER CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (filename IS NOT NULL OR external_url IS NOT NULL)
);
COMMENT ON TABLE videos IS
  'Distinct from learning_materials: purpose-built for session recordings and lecture video, with duration/thumbnail metadata a generic file share does not need.';

CREATE TABLE documents (
  id             BIGSERIAL PRIMARY KEY,
  student_id     BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  uploaded_by    BIGINT NOT NULL REFERENCES user_credentials(id),
  document_type  TEXT NOT NULL DEFAULT 'general' CHECK (document_type IN ('general', 'cv', 'certificate', 'assignment')),
  filename       TEXT NOT NULL,
  original_name  TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- =============================================================================
-- SECTION 7: ANNOUNCEMENTS, CHAT, MEETINGS
-- =============================================================================

CREATE TABLE announcements (
  id             BIGSERIAL PRIMARY KEY,
  supervisor_id  BIGINT NOT NULL REFERENCES supervisors(id) ON DELETE RESTRICT,
  cohort_id      INTEGER REFERENCES cohorts(id) ON DELETE SET NULL,  -- NULL = entire caseload
  title          TEXT NOT NULL,
  content        TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE chats (
  id             BIGSERIAL PRIMARY KEY,
  supervisor_id  BIGINT NOT NULL REFERENCES supervisors(id) ON DELETE RESTRICT,
  student_id     BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_message_at TIMESTAMPTZ,
  UNIQUE (supervisor_id, student_id)
);
COMMENT ON TABLE chats IS 'One persistent thread per supervisor-student pair.';

CREATE TABLE messages (
  id           BIGSERIAL PRIMARY KEY,
  chat_id      BIGINT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sender_id    BIGINT NOT NULL REFERENCES user_credentials(id),  -- either party in the chat
  content      TEXT NOT NULL,
  is_read      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE meetings (
  id                BIGSERIAL PRIMARY KEY,
  supervisor_id     BIGINT NOT NULL REFERENCES supervisors(id) ON DELETE RESTRICT,
  student_id        BIGINT REFERENCES students(id) ON DELETE CASCADE,  -- NULL = whole caseload
  title             TEXT NOT NULL,
  platform          TEXT NOT NULL CHECK (platform IN ('zoom', 'teams', 'meet', 'other')),
  meeting_url       TEXT NOT NULL,
  scheduled_at      TIMESTAMPTZ,
  duration_minutes  INTEGER CHECK (duration_minutes IS NULL OR duration_minutes >= 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE meetings IS
  'Fills the "no meetings table exists" gap flagged in earlier Supervisor/Student dashboard builds.';


-- =============================================================================
-- SECTION 8: CALENDAR
-- =============================================================================

-- =============================================================================
-- SECTION 4b: EVALUATIONS & FREEFORM NOTES
-- =============================================================================
-- Gap found while building the Profile/Supervisor routes: the old schema's
-- flexible student_records table supported 'note' and 'evaluation' as
-- record types, and the already-built Supervisor/Student dashboards both
-- have UI tabs for them, but no table for either was carried into this
-- normalized schema (they weren't on the originally requested table list).
-- Adding them now rather than silently dropping the feature.

CREATE TABLE evaluations (
  id             BIGSERIAL PRIMARY KEY,
  student_id     BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  supervisor_id  BIGINT NOT NULL REFERENCES supervisors(id) ON DELETE RESTRICT,
  session_id     BIGINT REFERENCES sessions(id) ON DELETE SET NULL,
  evaluation_date DATE,
  title          TEXT,
  score          NUMERIC(5,2) CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
  content        TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE supervisor_notes (
  id             BIGSERIAL PRIMARY KEY,
  student_id     BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  supervisor_id  BIGINT NOT NULL REFERENCES supervisors(id) ON DELETE RESTRICT,
  note_date      DATE,
  content        TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE supervisor_notes IS
  'Freeform notes about a student not tied to a specific session, assignment, or evaluation -- e.g. general observations. Visible to the supervisor who wrote them and the student the note is about, same access pattern as everything else supervisor-authored.';

CREATE TABLE admin_notes (
  id          BIGSERIAL PRIMARY KEY,
  student_id  BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  admin_id    BIGINT NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE admin_notes IS
  'Internal administrative notes about a student -- distinct from supervisor_notes, which are clinical/training observations visible to the student. These are Admin-only: not shown to the supervisor or the student, matching how the "Notes" field was described in the Admin Dashboard requirements (an internal admin annotation, not a shared training record).';

CREATE TABLE calendar_events (
  id                    BIGSERIAL PRIMARY KEY,
  owner_id              BIGINT NOT NULL REFERENCES user_credentials(id),  -- who created/owns this entry
  student_id            BIGINT REFERENCES students(id) ON DELETE CASCADE, -- target audience, NULL = broader
  event_type            TEXT NOT NULL CHECK (event_type IN (
                            'session', 'meeting', 'assignment_deadline', 'custom', 'holiday'
                          )),
  title                 TEXT NOT NULL,
  description           TEXT,
  event_date            DATE NOT NULL,
  event_time            TIME,
  related_session_id    BIGINT REFERENCES sessions(id) ON DELETE CASCADE,
  related_meeting_id    BIGINT REFERENCES meetings(id) ON DELETE CASCADE,
  related_assignment_id BIGINT REFERENCES assignments(id) ON DELETE CASCADE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE calendar_events IS
  'Denormalized, queryable calendar. Populate on insert of sessions/meetings/assignment due dates at the application layer (or add triggers later) so month-range calendar queries stay a single indexed SELECT instead of a UNION across source tables.';


-- =============================================================================
-- SECTION 9: PAYMENTS
-- =============================================================================

CREATE TABLE payments (
  id               BIGSERIAL PRIMARY KEY,
  student_id       BIGINT NOT NULL UNIQUE REFERENCES students(id) ON DELETE CASCADE,
  total_fee_cents  INTEGER NOT NULL DEFAULT 0 CHECK (total_fee_cents >= 0),
  discount_cents   INTEGER NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  payment_plan     TEXT CHECK (payment_plan IN ('full', 'installment', 'custom')),
  next_due_date    DATE,
  status           TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid', 'partial', 'paid')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE payments IS
  'One fee agreement per student. `status` and remaining balance should be recomputed by the application whenever payment_transactions changes for this student (SUM(amount_cents) vs total_fee_cents - discount_cents). Includes next_due_date, which was previously a documented gap.';

CREATE TABLE invoices (
  id              BIGSERIAL PRIMARY KEY,
  student_id      BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  invoice_number  TEXT NOT NULL UNIQUE,
  amount_cents    INTEGER NOT NULL CHECK (amount_cents >= 0),
  issue_date      DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date        DATE,
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'paid', 'overdue', 'cancelled')),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE payment_transactions (
  id                BIGSERIAL PRIMARY KEY,
  student_id        BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  invoice_id        BIGINT REFERENCES invoices(id) ON DELETE SET NULL,
  amount_cents      INTEGER NOT NULL,  -- negative = refund/adjustment, per append-only ledger convention
  transaction_type  TEXT NOT NULL DEFAULT 'payment' CHECK (transaction_type IN ('payment', 'refund', 'adjustment')),
  payment_date      DATE NOT NULL,
  method            TEXT,
  added_by          BIGINT NOT NULL REFERENCES user_credentials(id),  -- Admin only, enforced at app layer + RLS below
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE payment_transactions IS
  'Append-only ledger -- never UPDATE or DELETE a transaction. Corrections are new rows with transaction_type = refund/adjustment and an explanatory note, preserving full financial history permanently per requirement #8.';


-- =============================================================================
-- SECTION 10: NOTIFICATIONS
-- =============================================================================

CREATE TABLE notifications (
  id                  BIGSERIAL PRIMARY KEY,
  recipient_id        BIGINT NOT NULL REFERENCES user_credentials(id) ON DELETE CASCADE,
  notification_type   TEXT NOT NULL CHECK (notification_type IN (
                          'message', 'assignment', 'session', 'meeting',
                          'payment', 'announcement', 'document', 'system'
                        )),
  title               TEXT NOT NULL,
  body                TEXT,
  related_entity_type TEXT,   -- e.g. 'assignment', 'chat', 'payment_transaction'
  related_entity_id   BIGINT,
  is_read             BOOLEAN NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- =============================================================================
-- SECTION 11: EVENTS (public site) & AUDIT LOG
-- =============================================================================

CREATE TABLE events (
  id                  BIGSERIAL PRIMARY KEY,
  created_by          BIGINT REFERENCES user_credentials(id) ON DELETE SET NULL,
  event_date          TIMESTAMPTZ NOT NULL,
  image               TEXT,
  status              TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming', 'concluded')),
  fee                 TEXT,
  register_url        TEXT,

  title_en            TEXT,
  format_en           TEXT,
  facilitator_en      TEXT,
  about_en            TEXT,
  learn_en            JSONB,
  who_en              JSONB,
  outcomes_en         JSONB,
  facilitator_bio_en  TEXT,

  title_ar            TEXT,
  format_ar           TEXT,
  facilitator_ar      TEXT,
  about_ar            TEXT,
  learn_ar            JSONB,
  who_ar              JSONB,
  outcomes_ar         JSONB,
  facilitator_bio_ar  TEXT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE events IS 'Public events.html page content, managed by Designer accounts. created_by is the owning designer (or NULL for legacy/admin-authored rows); a designer may only manage rows where created_by = their own id. learn_en/who_en/outcomes_en etc. are JSON arrays of strings (native JSONB in Postgres, vs. JSON-in-TEXT in the original SQLite version).';

CREATE TABLE audit_logs (
  id           BIGSERIAL PRIMARY KEY,
  actor_id     BIGINT REFERENCES user_credentials(id) ON DELETE SET NULL,  -- NULL = system action
  action       TEXT NOT NULL,             -- e.g. 'user.created', 'payment.recorded', 'password_changed'
  entity_type  TEXT,                      -- e.g. 'students', 'payment_transactions'
  entity_id    BIGINT,
  old_values   JSONB,
  new_values   JSONB,
  ip_address   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE audit_logs IS 'Generalizes the old activity_log table with structured before/after diffs for a real audit trail, per requirement #7.';


-- =============================================================================
-- SECTION 12: INDEXES
-- =============================================================================

CREATE INDEX idx_user_credentials_role_status ON user_credentials(role, status);

CREATE INDEX idx_students_cohort ON students(cohort_id);
CREATE INDEX idx_supervisor_students_student ON supervisor_students(student_id);
CREATE INDEX idx_supervisors_primary ON supervisors(primary_supervisor_id);

CREATE INDEX idx_sessions_student_date ON sessions(student_id, session_date DESC);
CREATE INDEX idx_sessions_supervisor_date ON sessions(supervisor_id, session_date DESC);

CREATE INDEX idx_attendance_student_date ON attendance(student_id, attendance_date DESC);
CREATE INDEX idx_training_hours_student ON training_hours(student_id, hour_date DESC);
CREATE INDEX idx_supervision_hours_student ON supervision_hours(student_id, hour_date DESC);

CREATE INDEX idx_assignments_student ON assignments(student_id, due_date);
CREATE INDEX idx_assignments_supervisor ON assignments(supervisor_id);
CREATE INDEX idx_assignment_submissions_assignment ON assignment_submissions(assignment_id);
CREATE INDEX idx_assignment_submissions_student ON assignment_submissions(student_id);

CREATE INDEX idx_evaluations_student ON evaluations(student_id, evaluation_date DESC);
CREATE INDEX idx_supervisor_notes_student ON supervisor_notes(student_id, note_date DESC);
CREATE INDEX idx_admin_notes_student ON admin_notes(student_id, created_at DESC);

CREATE INDEX idx_materials_supervisor ON learning_materials(supervisor_id, created_at DESC);
CREATE INDEX idx_materials_student ON learning_materials(student_id);
CREATE INDEX idx_videos_supervisor ON videos(supervisor_id, created_at DESC);
CREATE INDEX idx_documents_student ON documents(student_id, created_at DESC);

CREATE INDEX idx_announcements_supervisor ON announcements(supervisor_id, created_at DESC);
CREATE INDEX idx_announcements_cohort ON announcements(cohort_id);

CREATE INDEX idx_chats_student ON chats(student_id);
CREATE INDEX idx_messages_chat_created ON messages(chat_id, created_at DESC);

CREATE INDEX idx_meetings_supervisor ON meetings(supervisor_id, scheduled_at);
CREATE INDEX idx_meetings_student ON meetings(student_id);

CREATE INDEX idx_calendar_events_date ON calendar_events(event_date);
CREATE INDEX idx_calendar_events_student_date ON calendar_events(student_id, event_date);

CREATE INDEX idx_invoices_student ON invoices(student_id);
CREATE INDEX idx_payment_tx_student_date ON payment_transactions(student_id, payment_date DESC);
CREATE INDEX idx_payment_tx_invoice ON payment_transactions(invoice_id);

CREATE INDEX idx_notifications_recipient_unread ON notifications(recipient_id, is_read, created_at DESC);

CREATE INDEX idx_events_date ON events(event_date DESC);
CREATE INDEX idx_events_status ON events(status);

CREATE INDEX idx_audit_logs_actor ON audit_logs(actor_id, created_at DESC);
CREATE INDEX idx_audit_logs_entity ON audit_logs(entity_type, entity_id);


-- =============================================================================
-- SECTION 13: updated_at AUTO-MAINTENANCE
-- =============================================================================
-- Small, generic trigger so every table with an updated_at column keeps it
-- current automatically -- this is schema housekeeping, not business logic.

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN
    SELECT table_name FROM information_schema.columns
    WHERE column_name = 'updated_at' AND table_schema = 'public'
  LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at();',
      t
    );
  END LOOP;
END $$;


-- =============================================================================
-- SECTION 14: SEED DATA (1 Admin, 1 Supervisor, 1 Student)
-- =============================================================================
-- Passwords below are bcrypt hashes of the literal string 'password123'
-- purely as a placeholder -- replace with real hashes generated by your
-- application before using this in any real environment. Every seeded
-- account has must_change_password = TRUE, so first login forces a reset
-- regardless.

INSERT INTO id_counters (prefix, last_number) VALUES
  ('ADM', 1), ('SUP', 1), ('TTR', 1);

INSERT INTO cohorts (id, name, start_date, description) VALUES
  (1, 'Cohort 2026-A', '2026-01-01', 'Inaugural systemic psychotherapy training cohort');

-- Admin
INSERT INTO user_credentials (id, member_code, password_hash, role, status, must_change_password)
VALUES (1, 'ADM001', '$2b$10$CHANGE_ME_PLACEHOLDER_HASH_xxxxxxxxxxxxxxxxxxxxxxxxxx', 'admin', 'active', TRUE);
INSERT INTO admin_users (id, full_name, email)
VALUES (1, 'System Administrator', 'admin@reframe-mhs.org');

-- Primary Supervisor
INSERT INTO user_credentials (id, member_code, password_hash, role, status, must_change_password)
VALUES (2, 'SUP001', '$2b$10$CHANGE_ME_PLACEHOLDER_HASH_xxxxxxxxxxxxxxxxxxxxxxxxxx', 'supervisor', 'active', TRUE);
INSERT INTO supervisors (id, full_name, email, specialization, supervisor_type)
VALUES (2, 'Dr. Layla Haddad', 'l.haddad@reframe-mhs.org', 'Systemic Psychotherapy', 'primary');

-- Supervisors in Training -- both report directly to the Primary Supervisor
-- above (id 2), never to each other
INSERT INTO user_credentials (id, member_code, password_hash, role, status, must_change_password)
VALUES (5, 'SUP002', '$2b$10$CHANGE_ME_PLACEHOLDER_HASH_xxxxxxxxxxxxxxxxxxxxxxxxxx', 'supervisor', 'active', TRUE);
INSERT INTO supervisors (id, full_name, email, supervisor_type, primary_supervisor_id)
VALUES (5, 'Karim Aoun', 'k.aoun@reframe-mhs.org', 'in_training', 2);

INSERT INTO user_credentials (id, member_code, password_hash, role, status, must_change_password)
VALUES (6, 'SUP003', '$2b$10$CHANGE_ME_PLACEHOLDER_HASH_xxxxxxxxxxxxxxxxxxxxxxxxxx', 'supervisor', 'active', TRUE);
INSERT INTO supervisors (id, full_name, email, supervisor_type, primary_supervisor_id)
VALUES (6, 'Dana Khalil', 'd.khalil@reframe-mhs.org', 'in_training', 2);

-- Student
INSERT INTO user_credentials (id, member_code, password_hash, role, status, must_change_password)
VALUES (3, 'TTR001', '$2b$10$CHANGE_ME_PLACEHOLDER_HASH_xxxxxxxxxxxxxxxxxxxxxxxxxx', 'trainee', 'active', TRUE);
INSERT INTO students (id, full_name, email, cohort_id, current_year)
VALUES (3, 'Mary Sbeity', 'mary.sbeity@example.com', 1, 1);

-- Designer (owns Events; Admin has no Event read/write access -- see routes/designer.js)
INSERT INTO user_credentials (id, member_code, password_hash, role, status, must_change_password)
VALUES (4, 'DES001', '$2b$10$CHANGE_ME_PLACEHOLDER_HASH_xxxxxxxxxxxxxxxxxxxxxxxxxx', 'designer', 'active', TRUE);
INSERT INTO designers (id, full_name, email)
VALUES (4, 'Rana Fakhoury', 'r.fakhoury@reframe-mhs.org');

-- Keep the sequences in sync with the manually-specified ids above
SELECT setval('user_credentials_id_seq', 6, true);
SELECT setval('cohorts_id_seq', 1, true);

-- Assign the seeded student to the seeded (primary) supervisor
INSERT INTO supervisor_students (supervisor_id, student_id, assigned_by)
VALUES (2, 3, 1);

-- Baseline settings/privacy rows for all six seeded accounts
INSERT INTO settings (user_id) VALUES (1), (2), (3), (4), (5), (6);
INSERT INTO privacy_preferences (user_id) VALUES (1), (2), (3), (4), (5), (6);

-- Empty fee agreement for the seeded student so the Payments page has
-- something to display rather than a missing row
INSERT INTO payments (student_id, total_fee_cents, status)
VALUES (3, 150000, 'unpaid');  -- $1,500.00 total fee, nothing paid yet


-- =============================================================================
-- SECTION 15 (OPTIONAL): ROW-LEVEL SECURITY
-- =============================================================================
-- Defense-in-depth for the two most sensitive data categories: payments and
-- health info. This is ADDITIONAL to application-level authorization checks,
-- not a replacement for them.
--
-- REQUIRED APP INTEGRATION: your API layer must run, per request/transaction,
-- before touching these tables:
--   SET LOCAL app.current_user_id = '<the logged-in user_credentials.id>';
--   SET LOCAL app.user_role    = '<admin|supervisor|trainee>';
-- and connect as a Postgres role that is NOT a superuser / does not have
-- BYPASSRLS (superusers bypass RLS entirely regardless of policy).
--
-- If you're not ready to wire this up yet, these statements are safe to
-- skip -- the tables function normally without RLS enabled.
-- =============================================================================

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_health_info ENABLE ROW LEVEL SECURITY;

-- Payments: Admin full access; Student read-only on their own record; Supervisor no access.
CREATE POLICY payments_admin_all ON payments
  FOR ALL
  USING (current_setting('app.user_role', true) = 'admin')
  WITH CHECK (current_setting('app.user_role', true) = 'admin');

CREATE POLICY payments_student_read_own ON payments
  FOR SELECT
  USING (
    current_setting('app.user_role', true) = 'trainee'
    AND student_id = current_setting('app.current_user_id', true)::BIGINT
  );

CREATE POLICY payment_tx_admin_all ON payment_transactions
  FOR ALL
  USING (current_setting('app.user_role', true) = 'admin')
  WITH CHECK (current_setting('app.user_role', true) = 'admin');

CREATE POLICY payment_tx_student_read_own ON payment_transactions
  FOR SELECT
  USING (
    current_setting('app.user_role', true) = 'trainee'
    AND student_id = current_setting('app.current_user_id', true)::BIGINT
  );

CREATE POLICY invoices_admin_all ON invoices
  FOR ALL
  USING (current_setting('app.user_role', true) = 'admin')
  WITH CHECK (current_setting('app.user_role', true) = 'admin');

CREATE POLICY invoices_student_read_own ON invoices
  FOR SELECT
  USING (
    current_setting('app.user_role', true) = 'trainee'
    AND student_id = current_setting('app.current_user_id', true)::BIGINT
  );

-- Health info: Admin full access; Supervisor read-only for their assigned
-- students only; Student can read/update their own record.
CREATE POLICY health_admin_all ON student_health_info
  FOR ALL
  USING (current_setting('app.user_role', true) = 'admin')
  WITH CHECK (current_setting('app.user_role', true) = 'admin');

CREATE POLICY health_supervisor_read_assigned ON student_health_info
  FOR SELECT
  USING (
    current_setting('app.user_role', true) = 'supervisor'
    AND EXISTS (
      SELECT 1 FROM supervisor_students ss
      WHERE ss.student_id = student_health_info.student_id
        AND ss.supervisor_id = current_setting('app.current_user_id', true)::BIGINT
    )
  );

CREATE POLICY health_student_own ON student_health_info
  FOR ALL
  USING (
    current_setting('app.user_role', true) = 'trainee'
    AND student_id = current_setting('app.current_user_id', true)::BIGINT
  )
  WITH CHECK (
    current_setting('app.user_role', true) = 'trainee'
    AND student_id = current_setting('app.current_user_id', true)::BIGINT
  );

-- =============================================================================
-- END OF SCRIPT
-- =============================================================================