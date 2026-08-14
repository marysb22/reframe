const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const config = require("../src/config");

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });

const db = new Database(config.dbFile);
db.pragma("journal_mode = WAL");

function tableExists(name) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}
function columnExists(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

// ---------------------------------------------------------------------
// One-time migration: rename the pre-"Group hierarchy" schema (role
// values 'trainee'/'supervisor', tables `student_records` /
// `user_supervisors`, columns like `student_id` / `supervisor_id`) to the
// current Trainer / Master Trainer / Group terminology. Safe to run on
// every boot -- it only fires when it detects the old shape (users table
// exists but has no `group_id` column yet), and a brand-new database
// skips it entirely since `users` doesn't exist yet.
// ---------------------------------------------------------------------
const needsTerminologyMigration = tableExists("users") && !columnExists("users", "group_id");

if (needsTerminologyMigration) {
  db.pragma("foreign_keys = OFF");
  // Without this, `ALTER TABLE users RENAME TO users_legacy` makes SQLite
  // silently rewrite every OTHER table's "REFERENCES users(id)" clause to
  // say "REFERENCES users_legacy(id)" instead. Since users_legacy is
  // dropped a few statements later (once the new `users` table exists
  // under the original name), that rewrite would leave every table with a
  // dangling foreign key. legacy_alter_table suppresses the rewrite, so
  // those untouched tables keep saying "REFERENCES users(id)" the whole
  // time -- which is exactly right, since a table named `users` exists
  // again by the time this transaction commits.
  db.pragma("legacy_alter_table = ON");

  const migrate = db.transaction(() => {
    // `groups` has to exist before we can add users.group_id as a
    // foreign key into it.
    db.exec(`
      CREATE TABLE IF NOT EXISTS groups (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Rebuild `users` under the new role vocabulary. SQLite enforces CHECK
    // constraints on write, so the old rows (role='trainee'/'supervisor')
    // have to land in a freshly-defined table rather than being UPDATEd
    // in place against the old CHECK.
    db.exec("ALTER TABLE users RENAME TO users_legacy");
    db.exec(`
      CREATE TABLE users (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        member_code           TEXT NOT NULL UNIQUE,
        password_hash         TEXT NOT NULL,
        role                  TEXT NOT NULL DEFAULT 'trainer'
                                CHECK (role IN ('trainer', 'master_trainer', 'admin')),
        status                TEXT NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active', 'suspended')),
        must_change_password  INTEGER NOT NULL DEFAULT 1,
        full_name             TEXT NOT NULL,
        email                 TEXT UNIQUE,
        gender                TEXT,
        date_of_birth         TEXT,
        marital_status        TEXT,
        phone                 TEXT,
        address               TEXT,
        highest_degree        TEXT,
        institution            TEXT,
        certifications        TEXT,
        cohort                TEXT,
        current_year          INTEGER,
        group_id              INTEGER REFERENCES groups(id) ON DELETE SET NULL,
        cv_file               TEXT,
        photo                 TEXT,
        created_at            TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.exec(`
      INSERT INTO users (
        id, member_code, password_hash, role, status, must_change_password,
        full_name, email, gender, date_of_birth, marital_status, phone, address,
        highest_degree, institution, certifications, cohort, current_year, group_id,
        cv_file, photo, created_at, updated_at
      )
      SELECT
        id, member_code, password_hash,
        CASE role WHEN 'trainee' THEN 'trainer' WHEN 'supervisor' THEN 'master_trainer' ELSE role END,
        status, must_change_password,
        full_name, email, gender, date_of_birth, marital_status, phone, address,
        highest_degree, institution, certifications, cohort, current_year, NULL,
        cv_file, photo, created_at, updated_at
      FROM users_legacy;
    `);
    db.exec("DROP TABLE users_legacy");

    if (tableExists("user_supervisors")) {
      db.exec("ALTER TABLE user_supervisors RENAME TO trainer_master_trainers");
      db.exec("ALTER TABLE trainer_master_trainers RENAME COLUMN user_id TO trainer_id");
      db.exec("ALTER TABLE trainer_master_trainers RENAME COLUMN supervisor_id TO master_trainer_id");
    }

    if (tableExists("student_records")) {
      db.exec("ALTER TABLE student_records RENAME TO trainer_records");
      db.exec("ALTER TABLE trainer_records RENAME COLUMN student_id TO trainer_id");
      db.exec("ALTER TABLE trainer_records RENAME COLUMN supervisor_id TO master_trainer_id");
    }
    if (tableExists("documents") && columnExists("documents", "student_id")) {
      db.exec("ALTER TABLE documents RENAME COLUMN student_id TO trainer_id");
    }
    if (tableExists("learning_materials") && columnExists("learning_materials", "supervisor_id")) {
      db.exec("ALTER TABLE learning_materials RENAME COLUMN supervisor_id TO master_trainer_id");
    }
    if (tableExists("announcements") && columnExists("announcements", "supervisor_id")) {
      db.exec("ALTER TABLE announcements RENAME COLUMN supervisor_id TO master_trainer_id");
    }

    // Drop indexes still carrying the old names -- schema.sql below
    // recreates them under the new names. Harmless either way, just tidy.
    [
      "idx_records_student", "idx_records_supervisor", "idx_documents_student",
      "idx_materials_supervisor", "idx_announcements_supervisor",
    ].forEach((name) => db.exec(`DROP INDEX IF EXISTS ${name}`));
  });

  migrate();
  db.pragma("legacy_alter_table = OFF");
  db.pragma("foreign_keys = ON");
}

db.pragma("foreign_keys = ON");

const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
db.exec(schema);

module.exports = db;
