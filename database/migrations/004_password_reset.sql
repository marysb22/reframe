-- =============================================================================
-- Migration 004: Password reset tokens (Forgot Password self-service flow)
-- =============================================================================
-- Run this whole file in phpMyAdmin's SQL tab against the live database.
-- Purely additive -- one new table, no backfill required, safe to run
-- standalone.
--
-- WHY: self-service password reset needs somewhere to keep a short-lived,
-- single-use verification code per account. No existing table covers this.
-- The raw 6-digit code is never stored -- only a bcrypt hash of it (same
-- hashing helper used for real passwords, see backend/src/utils/authUtils.js)
-- -- so a database leak alone can't be used to complete a reset.
--
-- A user requesting a new code deletes any prior unconsumed row for that
-- user first (see backend/src/utils/passwordReset.js), so at most one active
-- row exists per user at a time; old/expired/used rows are left in place
-- as a lightweight history rather than being purged, since the table is
-- expected to stay small.

CREATE TABLE password_reset_tokens (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id        BIGINT NOT NULL,
  code_hash      VARCHAR(255) NOT NULL,
  expires_at     DATETIME NOT NULL,
  used_at        DATETIME,
  attempt_count  INT NOT NULL DEFAULT 0,
  ip_address     VARCHAR(45),
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_password_reset_user FOREIGN KEY (user_id) REFERENCES user_credentials(id) ON DELETE CASCADE,
  INDEX idx_password_reset_user (user_id, created_at),
  INDEX idx_password_reset_ip (ip_address, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Single-use, short-lived, hashed reset codes for the self-service Forgot Password flow. See backend/src/utils/passwordReset.js.';
