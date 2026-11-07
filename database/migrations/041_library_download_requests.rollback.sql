-- Rollback for migration 041 (Library download approval).
--
-- Roll the APPLICATION CODE back first. The pre-041 code ignores this
-- table and lets every signed-in account download every Library book again.
--
-- This DESTROYS the approval history. Export it first:
--   SELECT * FROM library_download_requests;   (phpMyAdmin: Export -> CSV/SQL)

-- 0.1 -- requests that will be lost (export them if not 0)
SELECT status, COUNT(*) AS c FROM library_download_requests GROUP BY status;

DROP TABLE IF EXISTS library_download_requests;
DELETE FROM admin_permissions WHERE permission_code = 'library.approve_downloads';

-- Verify: 0 and 0
SELECT COUNT(*) AS table_left FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'library_download_requests';
SELECT COUNT(*) AS permission_rows_left FROM admin_permissions WHERE permission_code = 'library.approve_downloads';
