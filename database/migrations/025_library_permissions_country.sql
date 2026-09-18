-- Library module: granular per-admin permissions, a Country field, and
-- ISBN/OCLC identifiers for the online book-search feature. All additive:
-- new table + new nullable columns only, no existing column altered, no
-- existing row touched or deleted.
--
-- Granular admin permissions are a genuinely new concept in this codebase
-- (confirmed by inspection: today every account with role='admin' has
-- identical, all-or-nothing privileges via requireAdmin -- see
-- middleware/auth.js). Rather than a single admin_users column per
-- permission (which doesn't scale as more permissioned actions get added
-- later, in Library or elsewhere), this is one row per (admin, granted
-- permission) -- presence of a row means granted, absence means denied.
-- Deliberately admin-only (never referenced by supervisor/trainee/designer
-- authorization, which are untouched) and deliberately NOT Library-specific
-- in shape (permission_code is a free string, "library.view" etc. here,
-- so a future non-Library admin permission reuses this same table).
CREATE TABLE admin_permissions (
  admin_id         BIGINT NOT NULL,
  permission_code  VARCHAR(50) NOT NULL,
  granted_by       BIGINT NULL,
  granted_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (admin_id, permission_code),
  CONSTRAINT fk_adminperm_admin FOREIGN KEY (admin_id) REFERENCES admin_users(id) ON DELETE CASCADE,
  CONSTRAINT fk_adminperm_granted_by FOREIGN KEY (granted_by) REFERENCES user_credentials(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Presence of a row = this admin has this permission. Granted-by-default for every admin_users row that already existed when this migration ran (see seed below), so nothing existing changes until someone explicitly revokes one.';

-- Every admin account that exists right now keeps exactly the access it
-- already has today (full Library access) -- this is what makes the
-- feature backward-compatible rather than a silent lockout on deploy.
-- Restricting a specific admin is then an explicit, deliberate revoke
-- through the new UI, never an accidental side effect of this migration.
INSERT INTO admin_permissions (admin_id, permission_code)
SELECT id, code
FROM admin_users
CROSS JOIN (
  SELECT 'library.view' AS code UNION ALL
  SELECT 'library.add' UNION ALL
  SELECT 'library.edit' UNION ALL
  SELECT 'library.delete'
) codes;

ALTER TABLE learning_materials
  ADD COLUMN country VARCHAR(100) NULL,
  ADD COLUMN isbn VARCHAR(20) NULL,
  ADD COLUMN oclc_number VARCHAR(20) NULL;
