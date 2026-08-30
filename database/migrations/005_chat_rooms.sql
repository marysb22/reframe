-- =============================================================================
-- Migration 005: Group Chats (chat rooms, membership, messages)
-- =============================================================================
-- Run this whole file in phpMyAdmin's SQL tab against the live database.
-- Purely additive -- three new tables, no backfill required, safe to run
-- standalone. The existing 1:1 chat (`chats`/`messages`) is untouched.
--
-- WHY: a Master Trainer needs to create and curate their own chat rooms
-- (name, member list) rather than being locked to exactly one auto-chat per
-- trainer_group -- so this is a genuinely separate membership list
-- (chat_room_members), not derived from supervisor_students/group_id.
-- `group_id` on chat_rooms only records which team's roster the room's
-- add-member picker draws candidates from; it is not the room's member list.

CREATE TABLE chat_rooms (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(255) NOT NULL,
  created_by  BIGINT NOT NULL,          -- the Master Trainer (supervisors.id)
  group_id    BIGINT NOT NULL,          -- which team's roster this room's members are drawn from
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_chat_rooms_creator FOREIGN KEY (created_by) REFERENCES supervisors(id) ON DELETE CASCADE,
  CONSTRAINT fk_chat_rooms_group FOREIGN KEY (group_id) REFERENCES trainer_groups(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='A Master Trainer-curated group chat room. Membership lives in chat_room_members, not derived automatically from the group.';

CREATE TABLE chat_room_members (
  room_id       BIGINT NOT NULL,
  user_id       BIGINT NOT NULL,        -- user_credentials.id (a supervisor or a student)
  added_by      BIGINT,
  joined_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_read_at  DATETIME,               -- NULL = never opened -- doubles as the unread-count marker
  PRIMARY KEY (room_id, user_id),
  CONSTRAINT fk_crm_room FOREIGN KEY (room_id) REFERENCES chat_rooms(id) ON DELETE CASCADE,
  CONSTRAINT fk_crm_user FOREIGN KEY (user_id) REFERENCES user_credentials(id) ON DELETE CASCADE,
  CONSTRAINT fk_crm_added_by FOREIGN KEY (added_by) REFERENCES user_credentials(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Who is actually in a chat room -- independent of trainer_group/supervisor_students membership.';

CREATE TABLE chat_room_messages (
  id                        BIGINT AUTO_INCREMENT PRIMARY KEY,
  room_id                   BIGINT NOT NULL,
  sender_id                 BIGINT NOT NULL,
  content                   TEXT,
  attachment_filename       VARCHAR(255),
  attachment_original_name  VARCHAR(255),
  attachment_mime           VARCHAR(150),
  attachment_size           INT,
  created_at                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_crmsg_room FOREIGN KEY (room_id) REFERENCES chat_rooms(id) ON DELETE CASCADE,
  CONSTRAINT fk_crmsg_sender FOREIGN KEY (sender_id) REFERENCES user_credentials(id),
  CONSTRAINT chk_crmsg_has_content CHECK (content IS NOT NULL OR attachment_filename IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Group chat messages, optionally carrying a single attachment. See backend/src/routes/chatRooms.js.';

CREATE INDEX idx_crmsg_room_created ON chat_room_messages(room_id, created_at);
CREATE INDEX idx_crm_user ON chat_room_members(user_id);
