-- Training Materials Usage & Distribution Notice -- one-time acceptance
-- record per user per notice version. A new row is NEVER needed for an
-- existing version a user already accepted (UNIQUE below enforces that);
-- bumping the version constant in src/utils/trainingMaterialsNotice.js is
-- what makes every non-Admin, non-Designer user see the modal again.

CREATE TABLE training_materials_notice_acceptances (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id         BIGINT NOT NULL,
  notice_version  VARCHAR(50) NOT NULL,
  accepted_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- server-generated, never client-supplied
  ip_address      VARCHAR(45),                                  -- audit trail (IPv4 or IPv6)
  user_agent      VARCHAR(255),
  CONSTRAINT fk_tmna_user FOREIGN KEY (user_id) REFERENCES user_credentials(id) ON DELETE CASCADE,
  CONSTRAINT uq_tmna_user_version UNIQUE (user_id, notice_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='One-time acceptance of the Training Materials Usage & Distribution Notice, per user per notice version. Admin and Designer roles are exempt and never get a row here.';

CREATE INDEX idx_tmna_user ON training_materials_notice_acceptances(user_id);
