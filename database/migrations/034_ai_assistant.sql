-- =============================================================================
-- Migration 034: AI Assistant (DeepSeek-backed) -- separate from human chat
-- =============================================================================
-- Run this whole file in phpMyAdmin's SQL tab against the live database.
-- Purely additive -- two new tables, no backfill required, safe to run
-- standalone. The existing chat tables (chats/messages, chat_rooms/
-- chat_room_members/chat_room_messages) are untouched.
--
-- WHY a separate pair of tables instead of reusing chat_room_messages: that
-- table's sender_id is NOT NULL FOREIGN KEY REFERENCES user_credentials(id)
-- -- there is no "AI" row in user_credentials, so an AI-authored turn
-- cannot be inserted there without either a fake user row (pollutes every
-- other query joining that table expecting a real supervisor/student) or a
-- schema change to the live human-chat feature. A dedicated, purely-
-- additive pair of tables avoids touching that feature at all.
--
-- Each user has at most one ai_conversations row (their own running AI
-- Assistant thread) -- enforced by the UNIQUE key on user_id, same
-- "find-or-create" idiom as chat_rooms' is_direct threads.

CREATE TABLE ai_conversations (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id     BIGINT NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ai_conversations_user (user_id),
  CONSTRAINT fk_ai_conv_user FOREIGN KEY (user_id) REFERENCES user_credentials(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='One running AI Assistant thread per user. See backend/src/routes/ai.js.';

CREATE TABLE ai_messages (
  id               BIGINT AUTO_INCREMENT PRIMARY KEY,
  conversation_id  BIGINT NOT NULL,
  role             VARCHAR(20) NOT NULL CHECK (role IN ('user','assistant')),
  content          TEXT NOT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_ai_msg_conv FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Turns in an AI Assistant conversation. role=user is the human message, role=assistant is DeepSeek''s reply.';

CREATE INDEX idx_ai_msg_conv_created ON ai_messages(conversation_id, created_at);
