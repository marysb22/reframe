-- =============================================================================
-- Migration 002: Training Milestones (Master Trainer dashboard, Phase C)
-- =============================================================================
-- Run this whole file in phpMyAdmin's SQL tab against the live database.
-- Purely additive -- two new tables, no changes to any existing table, no
-- backfill required. Safe to run standalone.
--
-- WHY two tables instead of hardcoded stage names: the brief's illustrative
-- list (Foundation/Module/Practical Training/Assessment/Final) is explicitly
-- an example, not a verified curriculum -- there is no existing courses/
-- curriculum/modules table anywhere in this schema to key off. Admin defines
-- the real stages once here (seeded below with that same illustrative list
-- as an editable starting point), and every place that shows "training
-- progress" (Master Trainer dashboard, weekly reports, later phases) reads
-- from these same two tables instead of re-inventing stage names locally.

-- -----------------------------------------------------------------------------
-- STEP 1: Milestone definitions (Admin-managed)
-- -----------------------------------------------------------------------------
CREATE TABLE training_milestones (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  code            VARCHAR(50) NOT NULL UNIQUE,   -- stable machine key, e.g. 'foundation'
  name_en         VARCHAR(255) NOT NULL,
  name_ar         VARCHAR(255),
  description_en  TEXT,
  description_ar  TEXT,
  sort_order      INT NOT NULL DEFAULT 0,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_by      BIGINT,                        -- admin_users.id who defined it
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_milestone_creator FOREIGN KEY (created_by) REFERENCES admin_users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Admin-defined curriculum milestones -- not hardcoded in application code. See migration 002 header for why.';

-- -----------------------------------------------------------------------------
-- STEP 2: Per-trainee progress against each milestone
-- -----------------------------------------------------------------------------
-- Rows are created lazily (upserted) the first time a Trainer (ToT) marks
-- progress on a trainee for a given milestone -- NOT pre-seeded for every
-- trainee at creation time. A trainee with zero rows here simply has 0 of
-- however-many-active-milestones completed; that's computed with a COUNT/
-- LEFT JOIN, not by a placeholder row. This avoids a bulk backfill INSERT
-- every time Admin adds a new milestone stage.
CREATE TABLE trainee_milestone_progress (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id     BIGINT NOT NULL,
  milestone_id   BIGINT NOT NULL,
  status         VARCHAR(20) NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'completed')),
  completed_at   DATETIME,
  marked_by      BIGINT,                         -- supervisors.id (ToT) who last updated this row
  notes          TEXT,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_student_milestone (student_id, milestone_id),
  CONSTRAINT fk_tmp_student FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  CONSTRAINT fk_tmp_milestone FOREIGN KEY (milestone_id) REFERENCES training_milestones(id) ON DELETE CASCADE,
  CONSTRAINT fk_tmp_marked_by FOREIGN KEY (marked_by) REFERENCES supervisors(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='One row per trainee per milestone the Trainer (ToT) has touched. Marking completed writes an audit_logs row (action=milestone_marked_completed).';

-- -----------------------------------------------------------------------------
-- STEP 3: Seed the illustrative starting definitions (editable by Admin
-- afterward -- these are a starting point, not a locked-in enum).
-- -----------------------------------------------------------------------------
INSERT INTO training_milestones (code, name_en, name_ar, sort_order, is_active) VALUES
  ('foundation',          'Foundation',                'الأساسيات',            1, TRUE),
  ('module_training',     'Module Training',            'تدريب الوحدات',        2, TRUE),
  ('practical_training',  'Practical Training',         'التدريب العملي',       3, TRUE),
  ('assessment',          'Assessment',                 'التقييم',              4, TRUE),
  ('final_certification', 'Final Certification',        'الشهادة النهائية',     5, TRUE);
