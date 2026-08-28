-- =============================================================================
-- Reframe MHS System -- MySQL 8.0 Database Schema
-- =============================================================================
-- Target: MySQL 8.0+ (Hostinger / phpMyAdmin compatible). No PostgreSQL
-- dependencies of any kind -- no extensions, no Row-Level Security, no
-- Postgres-only types or functions.
-- Scope: SQL ONLY. No routes, controllers, or application logic.
-- Import against an empty database, top to bottom, e.g.:
--   mysql -u <user> -p <database> < reframe_mhs_schema.sql
-- or via Hostinger's phpMyAdmin "Import" tab.
--
-- DESIGN NOTES (read before altering):
--
-- 1. IDENTITY MODEL
--    `user_credentials` is the single authentication table for every human
--    in the system (admin, master trainer / trainer-in-training, trainee,
--    designer). Login always starts here. `admin_users`, `supervisors`,
--    `students`, and `designers` each 1:1-extend a credential row and
--    SHARE ITS PRIMARY KEY (students.id IS user_credentials.id for that
--    person, not a separate surrogate key). This means:
--      - Any "who did this" column (message sender, payment recorder,
--        document uploader, audit actor) can be a single FK to
--        user_credentials(id), regardless of that person's role.
--      - Any "whose training data is this" column (sessions, assignments,
--        attendance) is a FK to the specific role table (students.id),
--        since only trainees have training records.
--    INVARIANT (enforced by convention, not a DB constraint): a
--    user_credentials row with role = 'trainee' must have exactly one
--    matching row in `students` with the same id, created in the same
--    transaction. Same for 'supervisor' -> supervisors, 'admin' ->
--    admin_users, 'designer' -> designers. A cross-table CHECK isn't
--    expressible in vanilla SQL; enforce this at the application's
--    account-creation transaction.
--
-- 2. MONEY
--    All monetary columns are integer *_cents to avoid floating-point
--    rounding, matching the convention already used in this system's
--    application code. Divide by 100 only when displaying.
--
-- 3. IDS
--    Internal primary keys are AUTO_INCREMENT integers. The human-facing
--    login ID (e.g. "TTR001", "SUP004", "ADM001") lives in
--    user_credentials.member_code and is generated via id_counters.
--
-- 4. NAMING: `groups` is a RESERVED WORD in MySQL 8 (added for window-frame
--    syntax) -- an unquoted `CREATE TABLE groups (...)` fails outright.
--    Renamed to `trainer_groups` throughout the schema and application
--    rather than backtick-quoting every reference, which is easy to miss
--    in application code. A "Group" is still 1 Master Trainer + 2 Trainers
--    (ToT) + their Trainees, created together as one unit by Admin.
--
-- 5. CALENDAR
--    `calendar_events` is a real, queryable table (not a view) so a single
--    date-range query can drive a month calendar without UNIONing
--    sessions + meetings + assignment deadlines at query time. Populating
--    it when a session/meeting/assignment is created is an application
--    responsibility (or add triggers later) -- deliberately not built
--    here to keep this script pure schema, not business logic.
--
-- 6. AUTHORIZATION (no Row-Level Security)
--    MySQL has no RLS equivalent, and Hostinger's shared MySQL doesn't
--    support one anyway. Every route that touches payments/health-info/
--    account-management tables is gated at the Express layer instead
--    (requireAuth + requireAdmin/requireSupervisor middleware, plus
--    explicit `WHERE student_id = ...` / caseload-membership checks in
--    the query itself for a Master Trainer/Trainer's own students). This
--    was already how authorization was actually enforced even under the
--    old Postgres+RLS design (RLS was documented there as
--    "additional... not a replacement for application-level checks") --
--    so nothing about the real access-control behavior changes here.
--
-- 7. updated_at AUTO-MAINTENANCE
--    Every `updated_at` column uses MySQL's native
--    `DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP` instead of a
--    trigger -- simpler than Postgres's per-table trigger function and
--    requires no procedural SQL block.
--
-- 8. CHECK CONSTRAINTS
--    MySQL enforces CHECK constraints as of 8.0.16 (Hostinger's MySQL 8.0
--    offerings are all newer than this). If your specific host runs an
--    older 8.0.x below .16, CHECK clauses are parsed but silently not
--    enforced -- validate critical values (roles, statuses) at the
--    application layer too, which this codebase already does.
-- =============================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;


-- =============================================================================
-- SECTION 1: ID GENERATION
-- =============================================================================

CREATE TABLE id_counters (
  prefix       VARCHAR(10) PRIMARY KEY,        -- 'TTR', 'SUP', 'ADM', 'DES'
  last_number  INT NOT NULL DEFAULT 0 CHECK (last_number >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Tracks the last number issued per member_code prefix so IDs (TTR001, TTR002, ...) never collide. Increment atomically inside the same transaction that inserts the new user_credentials row.';


-- =============================================================================
-- SECTION 2: IDENTITY & AUTHENTICATION
-- =============================================================================

CREATE TABLE user_credentials (
  id                     BIGINT AUTO_INCREMENT PRIMARY KEY,
  member_code            VARCHAR(20) NOT NULL UNIQUE,
  password_hash          VARCHAR(255) NOT NULL,
  role                   VARCHAR(20) NOT NULL CHECK (role IN ('trainee', 'supervisor', 'admin', 'designer')),
  status                 VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  must_change_password   BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at          DATETIME,
  created_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Single auth table for every role. Login always starts here; role determines which profile table (admin_users/supervisors/students/designers) to join.';

CREATE TABLE cohorts (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(255) NOT NULL UNIQUE,
  start_date    DATE,
  end_date      DATE,
  description   TEXT,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE admin_users (
  id            BIGINT PRIMARY KEY,
  full_name     VARCHAR(255) NOT NULL,
  email         VARCHAR(255) UNIQUE,
  phone         VARCHAR(50),
  photo         VARCHAR(255),                  -- stored filename in uploads/photos
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_admin_users_credentials FOREIGN KEY (id) REFERENCES user_credentials(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Profile extension of user_credentials for role = admin. One static/seeded admin account per requirement #5; more can be added later, still Admin-only creatable.';

CREATE TABLE designers (
  id            BIGINT PRIMARY KEY,
  full_name     VARCHAR(255) NOT NULL,
  email         VARCHAR(255) UNIQUE,
  phone         VARCHAR(50),
  photo         VARCHAR(255),
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_designers_credentials FOREIGN KEY (id) REFERENCES user_credentials(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Profile extension of user_credentials for role = designer. Owns the public-site events they create (see events.created_by). Not created by Admin through the Groups flow -- a separate, self-contained account with its own login and password change, no access to trainee/finance/account-management features.';

-- supervisor_type / primary_supervisor_id encode the required hierarchy
-- (the "supervisor" role is displayed everywhere in the UI as either
-- Master Trainer or Trainer (ToT) -- the word "Supervisor" itself is
-- internal-only, never user-facing):
--   Admin
--     -> Master Trainer     (supervisor_type = 'primary', primary_supervisor_id IS NULL)
--          -> Trainer 1 (ToT)  (supervisor_type = 'in_training', primary_supervisor_id = the Master Trainer's id)
--          -> Trainer 2 (ToT)  (supervisor_type = 'in_training', primary_supervisor_id = the Master Trainer's id)
-- Both Trainers (ToT) point directly at the same Master Trainer row --
-- never at each other -- so there is no way to represent one reporting to
-- the other. A trainer_group is the unit Admin actually creates: 1 Master
-- Trainer + 2 Trainers (ToT) + their Trainees, all in one operation, all
-- sharing this group_id.
CREATE TABLE trainer_groups (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(255) NOT NULL UNIQUE,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='A Group = 1 Master Trainer + 2 Trainers (ToT) + their Trainees, created together as one unit by Admin. See supervisors.group_id / students.group_id. Named trainer_groups, not groups, because GROUPS is a reserved word in MySQL 8.';

CREATE TABLE supervisors (
  id                     BIGINT PRIMARY KEY,
  full_name              VARCHAR(255) NOT NULL,
  email                  VARCHAR(255) UNIQUE,
  phone                  VARCHAR(50),
  photo                  VARCHAR(255),
  bio                    TEXT,
  specialization         VARCHAR(255),
  supervisor_type        VARCHAR(20) NOT NULL DEFAULT 'primary' CHECK (supervisor_type IN ('primary', 'in_training')),
  -- RESTRICT, not SET NULL: setting this NULL on delete would violate the
  -- CHECK below for an 'in_training' row. A Master Trainer with Trainers
  -- (ToT) assigned must be reassigned (or the Trainers deleted/reassigned
  -- first) before they can be deleted -- suspend instead.
  primary_supervisor_id  BIGINT,
  group_id               BIGINT,
  created_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_supervisors_credentials FOREIGN KEY (id) REFERENCES user_credentials(id) ON DELETE CASCADE,
  CONSTRAINT fk_supervisors_primary FOREIGN KEY (primary_supervisor_id) REFERENCES supervisors(id) ON DELETE RESTRICT,
  CONSTRAINT fk_supervisors_group FOREIGN KEY (group_id) REFERENCES trainer_groups(id) ON DELETE SET NULL,
  CONSTRAINT chk_supervisor_hierarchy CHECK (
    (supervisor_type = 'primary' AND primary_supervisor_id IS NULL) OR
    (supervisor_type = 'in_training' AND primary_supervisor_id IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Profile extension of user_credentials for role = supervisor (displayed as Master Trainer / Trainer (ToT) in the Admin UI). Only Admin creates these rows, as part of creating a Group. supervisor_type/primary_supervisor_id encode the Master Trainer + 2 Trainers-in-Training hierarchy; group_id ties them to their Group.';

CREATE TABLE students (
  id                  BIGINT PRIMARY KEY,
  full_name           VARCHAR(255) NOT NULL,
  email               VARCHAR(255) UNIQUE,
  gender              VARCHAR(20),
  date_of_birth       DATE,
  marital_status      VARCHAR(30),
  phone               VARCHAR(50),
  address             TEXT,
  highest_degree      VARCHAR(255),
  institution         VARCHAR(255),
  certifications      TEXT,
  cohort_id           INT,
  current_year        INT CHECK (current_year IS NULL OR current_year BETWEEN 1 AND 10),
  cv_file             VARCHAR(255),             -- stored filename in uploads/cv
  photo               VARCHAR(255),             -- stored filename in uploads/photos
  group_id            BIGINT,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_students_credentials FOREIGN KEY (id) REFERENCES user_credentials(id) ON DELETE CASCADE,
  CONSTRAINT fk_students_cohort FOREIGN KEY (cohort_id) REFERENCES cohorts(id) ON DELETE SET NULL,
  CONSTRAINT fk_students_group FOREIGN KEY (group_id) REFERENCES trainer_groups(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Profile extension of user_credentials for role = trainee (displayed as Trainee in the Admin UI). Only Admin creates these rows, as part of creating a Group; group_id ties a trainee to their Group.';

CREATE TABLE supervisor_students (
  supervisor_id   BIGINT NOT NULL,
  student_id      BIGINT NOT NULL,
  assigned_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  assigned_by     BIGINT,                       -- who performed the assignment (supervisor or admin)
  PRIMARY KEY (supervisor_id, student_id),
  CONSTRAINT fk_supstu_supervisor FOREIGN KEY (supervisor_id) REFERENCES supervisors(id) ON DELETE RESTRICT,
  CONSTRAINT fk_supstu_student FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  CONSTRAINT fk_supstu_assigned_by FOREIGN KEY (assigned_by) REFERENCES user_credentials(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Many-to-many caseload assignment. A supervisor can only read/manage students present in this table for them.';


-- =============================================================================
-- SECTION 3: ACCOUNT SETTINGS & PRIVACY
-- =============================================================================

CREATE TABLE settings (
  user_id               BIGINT PRIMARY KEY,
  language              VARCHAR(5) NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'ar')),
  theme                 VARCHAR(10) NOT NULL DEFAULT 'light' CHECK (theme IN ('light', 'dark')),
  timezone              VARCHAR(50) DEFAULT 'Asia/Beirut',
  notify_messages       BOOLEAN NOT NULL DEFAULT TRUE,
  notify_assignments    BOOLEAN NOT NULL DEFAULT TRUE,
  notify_sessions       BOOLEAN NOT NULL DEFAULT TRUE,
  notify_payments       BOOLEAN NOT NULL DEFAULT TRUE,
  notify_announcements  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_settings_credentials FOREIGN KEY (user_id) REFERENCES user_credentials(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='One row per account. Replaces the localStorage-only notification-preference stopgap used before this table existed.';

CREATE TABLE privacy_preferences (
  user_id                       BIGINT PRIMARY KEY,
  show_photo_to_others          BOOLEAN NOT NULL DEFAULT TRUE,
  share_progress_with_cohort    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at                    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_privacy_credentials FOREIGN KEY (user_id) REFERENCES user_credentials(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE student_health_info (
  student_id                      BIGINT PRIMARY KEY,
  medical_conditions              TEXT,
  emergency_contact_name          VARCHAR(255),
  emergency_contact_relationship  VARCHAR(100),
  emergency_contact_phone         VARCHAR(50),
  consent_given                   BOOLEAN NOT NULL DEFAULT FALSE,
  consent_given_at                DATETIME,
  updated_at                      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_health_student FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Restricted medical/emergency data. Only Admin (full access), the trainee themself, and their assigned Master Trainer/Trainers (read-only) may access this -- enforced at the Express route layer (see backend/src/routes), not by the database, since MySQL has no Row-Level Security.';


-- =============================================================================
-- SECTION 4: SESSIONS, ATTENDANCE, HOURS
-- =============================================================================

CREATE TABLE sessions (
  id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id         BIGINT NOT NULL,
  supervisor_id      BIGINT NOT NULL,
  session_type       VARCHAR(20) NOT NULL CHECK (session_type IN ('training', 'supervision')),
  title              VARCHAR(255),
  session_date       DATE NOT NULL,
  session_time       TIME,
  duration_minutes   INT CHECK (duration_minutes IS NULL OR duration_minutes >= 0),
  location           VARCHAR(255),
  notes              TEXT,
  status             VARCHAR(20) NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled')),
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_sessions_student FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  CONSTRAINT fk_sessions_supervisor FOREIGN KEY (supervisor_id) REFERENCES supervisors(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE attendance (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id      BIGINT NOT NULL,
  supervisor_id   BIGINT NOT NULL,
  session_id      BIGINT,                       -- optional link to a specific session
  attendance_date DATE NOT NULL,
  status          VARCHAR(20) NOT NULL CHECK (status IN ('present', 'absent', 'excused')),
  notes           TEXT,
  recorded_by     BIGINT NOT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_attendance_student FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  CONSTRAINT fk_attendance_supervisor FOREIGN KEY (supervisor_id) REFERENCES supervisors(id) ON DELETE RESTRICT,
  CONSTRAINT fk_attendance_session FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL,
  CONSTRAINT fk_attendance_recorded_by FOREIGN KEY (recorded_by) REFERENCES user_credentials(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE training_hours (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id     BIGINT NOT NULL,
  supervisor_id  BIGINT NOT NULL,
  session_id     BIGINT,
  hours          DECIMAL(6,2) NOT NULL CHECK (hours >= 0),
  hour_date      DATE NOT NULL,
  description    TEXT,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_trghours_student FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  CONSTRAINT fk_trghours_supervisor FOREIGN KEY (supervisor_id) REFERENCES supervisors(id) ON DELETE RESTRICT,
  CONSTRAINT fk_trghours_session FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Kept separate from supervision_hours because clinical training programs typically report these to accreditation bodies as distinct totals.';

CREATE TABLE supervision_hours (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id     BIGINT NOT NULL,
  supervisor_id  BIGINT NOT NULL,
  session_id     BIGINT,
  hours          DECIMAL(6,2) NOT NULL CHECK (hours >= 0),
  hour_date      DATE NOT NULL,
  hour_type      VARCHAR(20) CHECK (hour_type IN ('individual', 'group')),
  description    TEXT,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_svhours_student FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  CONSTRAINT fk_svhours_supervisor FOREIGN KEY (supervisor_id) REFERENCES supervisors(id) ON DELETE RESTRICT,
  CONSTRAINT fk_svhours_session FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- =============================================================================
-- SECTION 5: ASSIGNMENTS
-- =============================================================================

CREATE TABLE assignments (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id          BIGINT NOT NULL,
  supervisor_id       BIGINT NOT NULL,
  title               VARCHAR(255) NOT NULL,
  description         TEXT,
  attachment_filename VARCHAR(255),             -- optional file the supervisor attaches (instructions, template)
  content_url         VARCHAR(2048),             -- added in migration 003: optional video/resource link
  due_date            DATE,
  status              VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'submitted', 'completed', 'overdue')),
  max_score           DECIMAL(5,2),
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_assignments_student FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  CONSTRAINT fk_assignments_supervisor FOREIGN KEY (supervisor_id) REFERENCES supervisors(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE assignment_submissions (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  assignment_id   BIGINT NOT NULL,
  student_id      BIGINT NOT NULL,
  filename        VARCHAR(255) NOT NULL,
  original_name   VARCHAR(255) NOT NULL,
  notes           TEXT,
  submitted_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  score           DECIMAL(5,2),
  feedback        TEXT,
  graded_by       BIGINT,
  graded_at       DATETIME,
  status          VARCHAR(20) NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'graded', 'returned')),
  CONSTRAINT fk_asub_assignment FOREIGN KEY (assignment_id) REFERENCES assignments(id) ON DELETE CASCADE,
  CONSTRAINT fk_asub_student FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  CONSTRAINT fk_asub_graded_by FOREIGN KEY (graded_by) REFERENCES supervisors(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Fills the "students can submit assignments" gap -- previously unmodeled, flagged in earlier dashboard builds.';


-- =============================================================================
-- SECTION 6: MATERIALS, VIDEOS, DOCUMENTS
-- =============================================================================

CREATE TABLE learning_materials (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  supervisor_id  BIGINT NOT NULL,
  student_id     BIGINT,                        -- NULL = shared with whole caseload
  title          VARCHAR(255) NOT NULL,
  description    TEXT,
  material_type  VARCHAR(20) NOT NULL CHECK (material_type IN (
                     'document', 'image', 'video', 'audio', 'link',
                     'assignment', 'worksheet', 'reading'
                   )),
  filename       VARCHAR(255),
  original_name  VARCHAR(255),
  external_url   VARCHAR(2048),
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_material_supervisor FOREIGN KEY (supervisor_id) REFERENCES supervisors(id) ON DELETE RESTRICT,
  CONSTRAINT fk_material_student FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  CONSTRAINT chk_material_has_file CHECK (filename IS NOT NULL OR external_url IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE videos (
  id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
  supervisor_id      BIGINT NOT NULL,
  student_id         BIGINT,                     -- NULL = whole caseload
  session_id         BIGINT,                     -- e.g. a recorded session
  title              VARCHAR(255) NOT NULL,
  description        TEXT,
  filename           VARCHAR(255),
  external_url       VARCHAR(2048),               -- e.g. YouTube/Vimeo embed
  thumbnail_filename VARCHAR(255),
  duration_seconds   INT CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_video_supervisor FOREIGN KEY (supervisor_id) REFERENCES supervisors(id) ON DELETE RESTRICT,
  CONSTRAINT fk_video_student FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  CONSTRAINT fk_video_session FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL,
  CONSTRAINT chk_video_has_file CHECK (filename IS NOT NULL OR external_url IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Distinct from learning_materials: purpose-built for session recordings and lecture video, with duration/thumbnail metadata a generic file share does not need.';

CREATE TABLE documents (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id     BIGINT NOT NULL,
  uploaded_by    BIGINT NOT NULL,
  document_type  VARCHAR(20) NOT NULL DEFAULT 'general' CHECK (document_type IN ('general', 'cv', 'certificate', 'assignment')),
  filename       VARCHAR(255) NOT NULL,
  original_name  VARCHAR(255) NOT NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_documents_student FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  CONSTRAINT fk_documents_uploaded_by FOREIGN KEY (uploaded_by) REFERENCES user_credentials(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- =============================================================================
-- SECTION 7: ANNOUNCEMENTS, CHAT, MEETINGS
-- =============================================================================

CREATE TABLE announcements (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  supervisor_id  BIGINT NOT NULL,
  cohort_id      INT,                           -- NULL = entire caseload
  title          VARCHAR(255) NOT NULL,
  content        TEXT NOT NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_announce_supervisor FOREIGN KEY (supervisor_id) REFERENCES supervisors(id) ON DELETE RESTRICT,
  CONSTRAINT fk_announce_cohort FOREIGN KEY (cohort_id) REFERENCES cohorts(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE chats (
  id               BIGINT AUTO_INCREMENT PRIMARY KEY,
  supervisor_id    BIGINT NOT NULL,
  student_id       BIGINT NOT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_message_at  DATETIME,
  UNIQUE KEY uq_chats_supervisor_student (supervisor_id, student_id),
  CONSTRAINT fk_chats_supervisor FOREIGN KEY (supervisor_id) REFERENCES supervisors(id) ON DELETE RESTRICT,
  CONSTRAINT fk_chats_student FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='One persistent thread per supervisor-student pair.';

CREATE TABLE messages (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  chat_id      BIGINT NOT NULL,
  sender_id    BIGINT NOT NULL,                 -- either party in the chat
  content      TEXT NOT NULL,
  is_read      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_messages_chat FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
  CONSTRAINT fk_messages_sender FOREIGN KEY (sender_id) REFERENCES user_credentials(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE meetings (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  supervisor_id     BIGINT NOT NULL,
  student_id        BIGINT,                      -- NULL = whole caseload
  title             VARCHAR(255) NOT NULL,
  platform          VARCHAR(20) NOT NULL CHECK (platform IN ('zoom', 'teams', 'meet', 'other')),
  meeting_url       VARCHAR(2048) NOT NULL,
  scheduled_at      DATETIME,
  duration_minutes  INT CHECK (duration_minutes IS NULL OR duration_minutes >= 0),
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_meetings_supervisor FOREIGN KEY (supervisor_id) REFERENCES supervisors(id) ON DELETE RESTRICT,
  CONSTRAINT fk_meetings_student FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Fills the "no meetings table exists" gap flagged in earlier Supervisor/Student dashboard builds.';


-- =============================================================================
-- SECTION 8: EVALUATIONS & FREEFORM NOTES
-- =============================================================================

CREATE TABLE evaluations (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id      BIGINT NOT NULL,
  supervisor_id   BIGINT NOT NULL,
  session_id      BIGINT,
  evaluation_date DATE,
  title           VARCHAR(255),
  score           DECIMAL(5,2) CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
  content         TEXT,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_evaluations_student FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  CONSTRAINT fk_evaluations_supervisor FOREIGN KEY (supervisor_id) REFERENCES supervisors(id) ON DELETE RESTRICT,
  CONSTRAINT fk_evaluations_session FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE supervisor_notes (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id     BIGINT NOT NULL,
  supervisor_id  BIGINT NOT NULL,
  note_date      DATE,
  content        TEXT NOT NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_svnotes_student FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  CONSTRAINT fk_svnotes_supervisor FOREIGN KEY (supervisor_id) REFERENCES supervisors(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Freeform notes about a student not tied to a specific session, assignment, or evaluation. Visible to the supervisor who wrote them and the student the note is about.';

CREATE TABLE admin_notes (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id  BIGINT NOT NULL,
  admin_id    BIGINT NOT NULL,
  content     TEXT NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_adminnotes_student FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  CONSTRAINT fk_adminnotes_admin FOREIGN KEY (admin_id) REFERENCES admin_users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Internal administrative notes about a student -- distinct from supervisor_notes. Admin-only: not shown to the supervisor or the student.';

CREATE TABLE calendar_events (
  id                    BIGINT AUTO_INCREMENT PRIMARY KEY,
  owner_id              BIGINT NOT NULL,        -- who created/owns this entry
  student_id            BIGINT,                 -- target audience, NULL = broader
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
  COMMENT='Denormalized, queryable calendar. Populate on insert of sessions/meetings/assignment due dates at the application layer.';


-- =============================================================================
-- SECTION 9: PAYMENTS
-- =============================================================================

CREATE TABLE payments (
  id               BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id       BIGINT NOT NULL UNIQUE,
  total_fee_cents  INT NOT NULL DEFAULT 0 CHECK (total_fee_cents >= 0),
  discount_cents   INT NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  payment_plan     VARCHAR(20) CHECK (payment_plan IN ('full', 'installment', 'custom')),
  next_due_date    DATE,
  status           VARCHAR(20) NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid', 'partial', 'paid')),
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_payments_student FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='One fee agreement per student. status and remaining balance are recomputed by the application whenever payment_transactions changes for this student (SUM(amount_cents) vs total_fee_cents - discount_cents).';

CREATE TABLE invoices (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id      BIGINT NOT NULL,
  invoice_number  VARCHAR(50) NOT NULL UNIQUE,
  amount_cents    INT NOT NULL CHECK (amount_cents >= 0),
  issue_date      DATE NOT NULL DEFAULT (CURRENT_DATE),
  due_date        DATE,
  status          VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'paid', 'overdue', 'cancelled')),
  notes           TEXT,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_invoices_student FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE payment_transactions (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id        BIGINT NOT NULL,
  invoice_id        BIGINT,
  amount_cents      INT NOT NULL,               -- negative = refund/adjustment, per append-only ledger convention
  transaction_type  VARCHAR(20) NOT NULL DEFAULT 'payment' CHECK (transaction_type IN ('payment', 'refund', 'adjustment')),
  payment_date      DATE NOT NULL,
  method            VARCHAR(50),
  added_by          BIGINT NOT NULL,            -- Admin only, enforced at the Express route layer
  notes             TEXT,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_paytx_student FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  CONSTRAINT fk_paytx_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE SET NULL,
  CONSTRAINT fk_paytx_added_by FOREIGN KEY (added_by) REFERENCES user_credentials(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Append-only ledger -- never UPDATE or DELETE a transaction. Corrections are new rows with transaction_type = refund/adjustment and an explanatory note, preserving full financial history permanently.';


-- =============================================================================
-- SECTION 10: NOTIFICATIONS
-- =============================================================================

CREATE TABLE notifications (
  id                   BIGINT AUTO_INCREMENT PRIMARY KEY,
  recipient_id         BIGINT NOT NULL,
  notification_type    VARCHAR(20) NOT NULL CHECK (notification_type IN (
                           'message', 'assignment', 'session', 'meeting',
                           'payment', 'announcement', 'document', 'system'
                         )),
  title                VARCHAR(255) NOT NULL,
  body                 TEXT,
  related_entity_type  VARCHAR(50),             -- e.g. 'assignment', 'chat', 'payment_transaction'
  related_entity_id    BIGINT,
  is_read              BOOLEAN NOT NULL DEFAULT FALSE,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_notifications_recipient FOREIGN KEY (recipient_id) REFERENCES user_credentials(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- =============================================================================
-- SECTION 11: EVENTS (public site) & AUDIT LOG
-- =============================================================================

CREATE TABLE events (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  created_by          BIGINT,                   -- the owning Designer (or Admin for legacy rows)
  event_date          DATETIME NOT NULL,
  image               VARCHAR(255),
  status              VARCHAR(20) NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming', 'concluded')),
  fee                 VARCHAR(50),
  register_url        VARCHAR(2048),
  slug                VARCHAR(255) NOT NULL UNIQUE,  -- shareable /events/{slug} URL, see utils/eventChildren.js generateUniqueSlug
  show_speakers       BOOLEAN NOT NULL DEFAULT FALSE,
  show_agenda         BOOLEAN NOT NULL DEFAULT FALSE,
  show_sponsors       BOOLEAN NOT NULL DEFAULT FALSE,
  show_gallery        BOOLEAN NOT NULL DEFAULT FALSE,
  show_registration   BOOLEAN NOT NULL DEFAULT TRUE,

  title_en            VARCHAR(255),
  format_en           VARCHAR(255),
  facilitator_en      VARCHAR(255),
  about_en            TEXT,
  learn_en            JSON,
  who_en              JSON,
  outcomes_en         JSON,
  facilitator_bio_en  TEXT,

  title_ar            VARCHAR(255),
  format_ar           VARCHAR(255),
  facilitator_ar      VARCHAR(255),
  about_ar            TEXT,
  learn_ar            JSON,
  who_ar              JSON,
  outcomes_ar         JSON,
  facilitator_bio_ar  TEXT,

  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_events_created_by FOREIGN KEY (created_by) REFERENCES user_credentials(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Public events.html page content. created_by is the owning Designer (Admin-authored legacy rows have created_by pointing at the Admin account, or NULL). A Designer may only manage rows where created_by = their own id -- enforced at the Express route layer. learn_en/who_en/outcomes_en etc. are JSON arrays of strings.';

-- Optional content sections for an event, each only rendered on the public
-- event-detail page when the matching events.show_* column is TRUE (enforced
-- server-side in routes/public.js, not just hidden client-side). All four are
-- replace-all on every designer/admin save (see utils/eventChildren.js) --
-- row ids are not stable across edits, so nothing else should reference them
-- long-term except within the same save request (see event_agenda_items.speaker_id).
CREATE TABLE event_speakers (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  event_id    BIGINT NOT NULL,
  name_en     VARCHAR(255),
  name_ar     VARCHAR(255),
  title_en    VARCHAR(255),
  title_ar    VARCHAR(255),
  bio_en      TEXT,
  bio_ar      TEXT,
  photo       VARCHAR(255),
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_event_speakers_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE event_gallery (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  event_id     BIGINT NOT NULL,
  image        VARCHAR(255) NOT NULL,
  caption_en   VARCHAR(255),
  caption_ar   VARCHAR(255),
  sort_order   INT NOT NULL DEFAULT 0,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_event_gallery_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Structured with real date/time columns (not a JSON blob) so a future
-- site-wide Agenda page could query across events by date without a
-- redesign -- that page doesn't exist yet and isn't built by this schema.
CREATE TABLE event_agenda_items (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  event_id       BIGINT NOT NULL,
  item_date      DATE,
  start_time     TIME,
  end_time       TIME,
  title_en       VARCHAR(255),
  title_ar       VARCHAR(255),
  description_en TEXT,
  description_ar TEXT,
  speaker_id     BIGINT,
  sort_order     INT NOT NULL DEFAULT 0,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_event_agenda_event   FOREIGN KEY (event_id)   REFERENCES events(id) ON DELETE CASCADE,
  CONSTRAINT fk_event_agenda_speaker FOREIGN KEY (speaker_id) REFERENCES event_speakers(id) ON DELETE SET NULL,
  INDEX ix_event_agenda_date (item_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE audit_logs (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  actor_id     BIGINT,                          -- NULL = system action
  action       VARCHAR(100) NOT NULL,           -- e.g. 'user.created', 'payment.recorded', 'password_changed'
  entity_type  VARCHAR(50),                     -- e.g. 'students', 'payment_transactions'
  entity_id    BIGINT,
  old_values   JSON,
  new_values   JSON,
  ip_address   VARCHAR(45),
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_audit_actor FOREIGN KEY (actor_id) REFERENCES user_credentials(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Structured before/after diffs for a real audit trail.';

-- Added in migration 002 -- see that file's header for why this exists as
-- Admin-configurable definitions rather than hardcoded stage names.
CREATE TABLE training_milestones (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  code            VARCHAR(50) NOT NULL UNIQUE,
  name_en         VARCHAR(255) NOT NULL,
  name_ar         VARCHAR(255),
  description_en  TEXT,
  description_ar  TEXT,
  sort_order      INT NOT NULL DEFAULT 0,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_by      BIGINT,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_milestone_creator FOREIGN KEY (created_by) REFERENCES admin_users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Admin-defined curriculum milestones -- not hardcoded in application code.';

CREATE TABLE trainee_milestone_progress (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id     BIGINT NOT NULL,
  milestone_id   BIGINT NOT NULL,
  status         VARCHAR(20) NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'completed')),
  completed_at   DATETIME,
  marked_by      BIGINT,
  notes          TEXT,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_student_milestone (student_id, milestone_id),
  CONSTRAINT fk_tmp_student FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  CONSTRAINT fk_tmp_milestone FOREIGN KEY (milestone_id) REFERENCES training_milestones(id) ON DELETE CASCADE,
  CONSTRAINT fk_tmp_marked_by FOREIGN KEY (marked_by) REFERENCES supervisors(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='One row per trainee per milestone the Trainer (ToT) has touched. Rows created lazily, not pre-seeded -- see migration 002.';


-- =============================================================================
-- SECTION 12: INDEXES
-- =============================================================================

CREATE INDEX idx_user_credentials_role_status ON user_credentials(role, status);

CREATE INDEX idx_students_cohort ON students(cohort_id);
CREATE INDEX idx_students_group ON students(group_id);
CREATE INDEX idx_supervisor_students_student ON supervisor_students(student_id);
CREATE INDEX idx_supervisors_primary ON supervisors(primary_supervisor_id);
CREATE INDEX idx_supervisors_group ON supervisors(group_id);

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
CREATE INDEX idx_events_created_by ON events(created_by);

CREATE INDEX idx_audit_logs_actor ON audit_logs(actor_id, created_at DESC);
CREATE INDEX idx_audit_logs_entity ON audit_logs(entity_type, entity_id);

CREATE INDEX idx_milestone_progress_student ON trainee_milestone_progress(student_id);
CREATE INDEX idx_milestone_progress_milestone ON trainee_milestone_progress(milestone_id);


-- =============================================================================
-- SECTION 13: SEED DATA (bootstrap Admin account only)
-- =============================================================================
-- Only the one real account needed to bootstrap the system: nobody can log
-- in and create Groups/Trainers/Trainees/Designer accounts through the app
-- until an Admin account exists. No demo Group, Trainer, Trainee, or
-- Designer rows are seeded here -- those are created for real through the
-- app's own account-creation flows, not hard-coded into the schema.
--
-- The password hash below is a placeholder, NOT a valid bcrypt hash --
-- replace it with a real hash before deploying (e.g. run
-- backend/seed-password.js against this database, or hash a real password
-- and UPDATE this row directly) before anyone can log in as ADM001.
-- must_change_password is TRUE so the very first login forces a real
-- password to be set.

INSERT INTO id_counters (prefix, last_number) VALUES
  ('ADM', 1), ('SUP', 0), ('TTR', 0), ('DES', 0);

-- Admin
INSERT INTO user_credentials (id, member_code, password_hash, role, status, must_change_password)
VALUES (1, 'ADM001', '$2a$10$zS7yqUKB9w4w9Jn7IlBJ9ucnh9UKQQ9112.EkN3adi1922KxiXtZq', 'admin', 'active', TRUE);
INSERT INTO admin_users (id, full_name, email)
VALUES (1, 'System Administrator', 'admin@reframe-mhs.org');

-- Keep the AUTO_INCREMENT counter in sync with the manually-specified id above
ALTER TABLE user_credentials AUTO_INCREMENT = 2;

INSERT INTO settings (user_id) VALUES (1);
INSERT INTO privacy_preferences (user_id) VALUES (1);

-- Starting curriculum milestone definitions (see migration 002) -- Admin can
-- edit/add/deactivate these later; this seed only bootstraps a usable set.
INSERT INTO training_milestones (code, name_en, name_ar, sort_order, is_active) VALUES
  ('foundation',          'Foundation',                'الأساسيات',            1, TRUE),
  ('module_training',     'Module Training',            'تدريب الوحدات',        2, TRUE),
  ('practical_training',  'Practical Training',         'التدريب العملي',       3, TRUE),
  ('assessment',          'Assessment',                 'التقييم',              4, TRUE),
  ('final_certification', 'Final Certification',        'الشهادة النهائية',     5, TRUE);

SET FOREIGN_KEY_CHECKS = 1;

-- =============================================================================
-- END OF SCRIPT
-- =============================================================================
