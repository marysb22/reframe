-- Migration 041 (Library download approval) -- phpMyAdmin version.
-- Same statements as 041_library_download_requests.sql, with every table
-- schema-qualified for the production database u340416395_reframe_mhs,
-- because phpMyAdmin's SQL tab can run against information_schema and
-- ignore USE. Safe to re-run: CREATE TABLE IF NOT EXISTS / INSERT IGNORE.
--
-- Take a verified backup first. Run STEP 0, read the results, then STEP 1-3.

-- =============================================================================
-- STEP 0: Pre-flight checks
-- =============================================================================
-- 0.2 -- must return 0 rows (not applied yet)
SELECT TABLE_NAME FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = 'u340416395_reframe_mhs' AND TABLE_NAME = 'library_download_requests';

-- 0.3 -- must return 1 row (migration 040 applied)
SELECT COLUMN_NAME FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = 'u340416395_reframe_mhs' AND TABLE_NAME = 'learning_materials' AND COLUMN_NAME = 'visibility';

-- 0.4 -- write this number down
SELECT COUNT(*) AS admins_with_library_view
  FROM u340416395_reframe_mhs.admin_permissions WHERE permission_code = 'library.view';

-- =============================================================================
-- STEP 1: Download requests table
-- =============================================================================
CREATE TABLE IF NOT EXISTS u340416395_reframe_mhs.library_download_requests (
  id                     BIGINT NOT NULL AUTO_INCREMENT,
  material_id            BIGINT NULL,
  requested_material_id  BIGINT NOT NULL,
  material_title         VARCHAR(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  material_original_name VARCHAR(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  file_hash              VARCHAR(64)  COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  requester_id           BIGINT NULL,
  requester_name         VARCHAR(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  requester_role         VARCHAR(30)  COLLATE utf8mb4_unicode_ci NOT NULL,
  group_id               BIGINT NULL,
  status                 VARCHAR(20)  COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending',
  reviewer_id            BIGINT NULL,
  reviewer_name          VARCHAR(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  rejection_reason       VARCHAR(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  created_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at             DATETIME NULL,
  pending_key            BIGINT GENERATED ALWAYS AS (CASE WHEN status = 'pending' THEN requested_material_id ELSE NULL END) VIRTUAL,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_ldr_one_pending (requester_id, pending_key),
  KEY idx_ldr_requester_material (requester_id, requested_material_id, status),
  KEY idx_ldr_status_created (status, created_at),
  KEY idx_ldr_group_status (group_id, status),
  KEY idx_ldr_material (material_id),
  KEY idx_ldr_reviewer (reviewer_id),
  CONSTRAINT fk_ldr_material  FOREIGN KEY (material_id)  REFERENCES u340416395_reframe_mhs.learning_materials (id) ON DELETE SET NULL,
  CONSTRAINT fk_ldr_requester FOREIGN KEY (requester_id) REFERENCES u340416395_reframe_mhs.user_credentials (id)   ON DELETE SET NULL,
  CONSTRAINT fk_ldr_reviewer  FOREIGN KEY (reviewer_id)  REFERENCES u340416395_reframe_mhs.user_credentials (id)   ON DELETE SET NULL,
  CONSTRAINT fk_ldr_group     FOREIGN KEY (group_id)     REFERENCES u340416395_reframe_mhs.trainer_groups (id)     ON DELETE SET NULL,
  CONSTRAINT chk_ldr_status CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  CONSTRAINT chk_ldr_decision CHECK (
    (status = 'pending' AND decided_at IS NULL) OR (status <> 'pending' AND decided_at IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Library download approval requests (migration 041). One row per request; decided rows are the audit trail and are never deleted by the app.';

-- =============================================================================
-- STEP 2: Reviewer permission for the Admins who manage the Library today
-- =============================================================================
INSERT IGNORE INTO u340416395_reframe_mhs.admin_permissions (admin_id, permission_code, granted_by)
SELECT admin_id, 'library.approve_downloads', NULL
  FROM u340416395_reframe_mhs.admin_permissions
 WHERE permission_code = 'library.view';

-- =============================================================================
-- STEP 3: Verification -- one row, read the three numbers
--   table_exists = 1
--   admins_with_approve_downloads = the number from STEP 0.4
--   requests = 0
-- =============================================================================
SELECT
  (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = 'u340416395_reframe_mhs' AND TABLE_NAME = 'library_download_requests') AS table_exists,
  (SELECT COUNT(*) FROM u340416395_reframe_mhs.admin_permissions
    WHERE permission_code = 'library.approve_downloads') AS admins_with_approve_downloads,
  (SELECT COUNT(*) FROM u340416395_reframe_mhs.library_download_requests) AS requests;
