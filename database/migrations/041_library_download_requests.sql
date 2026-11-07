-- Library download approval (migration 041).
--
-- Until now every signed-in account could open or download any Library
-- book file. This migration adds the records behind a request/approve
-- workflow: a Trainee, ToT or Designer asks for one specific file, an
-- authorized Admin or Master Trainer accepts or rejects that request,
-- and the file route (backend/src/routes/files.js) serves the bytes only
-- when an APPROVED request exists for that exact user AND that exact
-- file AND that exact file content (file_hash).
--
-- (1) library_download_requests -- one row per request. Rows are never
--     deleted by the application: a decided request stays as the audit
--     record. A new request after a rejection is a NEW row; the rejected
--     row is kept.
--
--     pending_key is a generated column that equals requested_material_id
--     only while status = 'pending' (NULL otherwise). Together with
--     requester_id it is UNIQUE, so the database itself refuses a second
--     pending request by the same user for the same file, even under
--     concurrent submissions. Decided rows have pending_key = NULL and
--     never collide.
--
--     requested_material_id is a plain, immutable copy of the file id:
--     material_id (the FK) becomes NULL if the book is later removed,
--     but the history still says which item was requested. The generated
--     column is built on requested_material_id, not on the FK column,
--     because MySQL forbids SET NULL on a generated column's base column.
--
-- (2) admin_permissions gets a new code, library.approve_downloads. It is
--     granted to every Admin who ALREADY holds library.view, so the admins
--     who manage the Library today can review requests from day one. A
--     new admin account still starts with nothing (deny by default), as
--     before. This only INSERTs rows; nothing is revoked or changed.
--
-- Purely additive. No existing column altered, no existing row changed
-- or deleted.
--
-- HOW TO APPLY: verified backup of the TARGET database first; then STEP 0,
-- 1, 2, 3 in order. See 041_library_download_requests.README.md.
-- phpMyAdmin: use 041_library_download_requests.phpmyadmin.sql instead
-- (same statements, every table name schema-qualified).

-- =============================================================================
-- STEP 0: Pre-flight checks -- review every result
-- =============================================================================
SELECT DATABASE() AS target_database;

-- 0.2 -- must return 0 rows (not applied yet)
SELECT TABLE_NAME FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'library_download_requests';

-- 0.3 -- prerequisites: must return 1 row (migration 040 applied)
SELECT COLUMN_NAME FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'learning_materials' AND COLUMN_NAME = 'visibility';

-- 0.4 -- admins who will receive library.approve_downloads in STEP 2 (keep this number)
SELECT COUNT(*) AS admins_with_library_view FROM admin_permissions WHERE permission_code = 'library.view';

-- =============================================================================
-- STEP 1: Download requests
-- =============================================================================
CREATE TABLE IF NOT EXISTS library_download_requests (
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
  CONSTRAINT fk_ldr_material  FOREIGN KEY (material_id)  REFERENCES learning_materials (id) ON DELETE SET NULL,
  CONSTRAINT fk_ldr_requester FOREIGN KEY (requester_id) REFERENCES user_credentials (id)   ON DELETE SET NULL,
  CONSTRAINT fk_ldr_reviewer  FOREIGN KEY (reviewer_id)  REFERENCES user_credentials (id)   ON DELETE SET NULL,
  CONSTRAINT fk_ldr_group     FOREIGN KEY (group_id)     REFERENCES trainer_groups (id)     ON DELETE SET NULL,
  CONSTRAINT chk_ldr_status CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  CONSTRAINT chk_ldr_decision CHECK (
    (status = 'pending' AND decided_at IS NULL) OR (status <> 'pending' AND decided_at IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Library download approval requests (migration 041). One row per request; decided rows are the audit trail and are never deleted by the app.';

-- =============================================================================
-- STEP 2: Reviewer permission for existing Library admins
-- =============================================================================
INSERT IGNORE INTO admin_permissions (admin_id, permission_code, granted_by)
SELECT admin_id, 'library.approve_downloads', NULL
  FROM admin_permissions
 WHERE permission_code = 'library.view';

-- =============================================================================
-- STEP 3: Verification
-- =============================================================================
-- 3.1 -- must return 1 row
SELECT TABLE_NAME FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'library_download_requests';
-- 3.2 -- must equal STEP 0.4's number
SELECT COUNT(*) AS admins_with_approve_downloads FROM admin_permissions WHERE permission_code = 'library.approve_downloads';
-- 3.3 -- must return 0 (new table starts empty)
SELECT COUNT(*) AS requests FROM library_download_requests;
