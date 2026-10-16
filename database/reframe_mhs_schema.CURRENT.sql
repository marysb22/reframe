-- =============================================================================
-- Reframe MHS -- CURRENT schema (structure only, no data, no seed inserts),
-- generated directly from the live local dev database (reframe_dev) via
-- mysqldump --no-data, during a full-system audit. Verified accurate: this
-- is the exact schema that the app's full test suite (208/208) and server
-- actually ran against, not hand-transcribed from the migrations.
--
-- Generated because reframe_mhs_schema.sql (the hand-curated, documented
-- bootstrap script) was found to be stale -- missing at least 8 tables added
-- by later migrations (session_occasions, session_series,
-- tot_session_occasions, excuse_reasons, admin_permissions, ai_conversations,
-- ai_messages, training_materials_notice_acceptances -- roughly migrations
-- 023-037) plus columns added to existing tables by the same migrations
-- (e.g. provided_by_supervisor_id, migration 035). That file's own header
-- says "Import against an empty database, top to bottom" -- as written,
-- doing so today would produce a database missing all of that, and the
-- application would fail wherever it touches any of those tables (every
-- Group/Multi-day Session, the AI assistant, admin permission-gating, the
-- Training Materials Notice feature).
--
-- This file is a verified reference for the CURRENT structure, not a
-- replacement bootstrap script -- it has no seed data (no default hour_types,
-- no bootstrap Admin account, no training_milestones), which
-- reframe_mhs_schema.sql's own Section 13 provides and this intentionally
-- does not duplicate. See that file's header for the seed-data section and
-- its design-notes documentation, which are still accurate and worth
-- keeping; only its table/column list was out of date.
-- =============================================================================

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `admin_notes` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `student_id` bigint NOT NULL,
  `admin_id` bigint NOT NULL,
  `content` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `fk_adminnotes_admin` (`admin_id`),
  KEY `idx_admin_notes_student` (`student_id`,`created_at` DESC),
  CONSTRAINT `fk_adminnotes_admin` FOREIGN KEY (`admin_id`) REFERENCES `admin_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_adminnotes_student` FOREIGN KEY (`student_id`) REFERENCES `students` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Internal administrative notes about a student -- distinct from supervisor_notes. Admin-only: not shown to the supervisor or the student.';
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `admin_permissions` (
  `admin_id` bigint NOT NULL,
  `permission_code` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `granted_by` bigint DEFAULT NULL,
  `granted_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`admin_id`,`permission_code`),
  KEY `fk_adminperm_granted_by` (`granted_by`),
  CONSTRAINT `fk_adminperm_admin` FOREIGN KEY (`admin_id`) REFERENCES `admin_users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_adminperm_granted_by` FOREIGN KEY (`granted_by`) REFERENCES `user_credentials` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `admin_users` (
  `id` bigint NOT NULL,
  `full_name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `email` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `phone` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `photo` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `email` (`email`),
  CONSTRAINT `fk_admin_users_credentials` FOREIGN KEY (`id`) REFERENCES `user_credentials` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Profile extension of user_credentials for role = admin. One static/seeded admin account per requirement #5; more can be added later, still Admin-only creatable.';
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `ai_conversations` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `user_id` bigint NOT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_ai_conversations_user` (`user_id`),
  CONSTRAINT `fk_ai_conv_user` FOREIGN KEY (`user_id`) REFERENCES `user_credentials` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='One running AI Assistant thread per user. See backend/src/routes/ai.js.';
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `ai_messages` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `conversation_id` bigint NOT NULL,
  `role` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `content` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_ai_msg_conv_created` (`conversation_id`,`created_at`),
  CONSTRAINT `fk_ai_msg_conv` FOREIGN KEY (`conversation_id`) REFERENCES `ai_conversations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `ai_messages_chk_1` CHECK ((`role` in (_utf8mb4'user',_utf8mb4'assistant')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Turns in an AI Assistant conversation. role=user is the human message, role=assistant is DeepSeek''s reply.';
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `announcements` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `supervisor_id` bigint NOT NULL,
  `cohort_id` int DEFAULT NULL,
  `title` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `content` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_announcements_supervisor` (`supervisor_id`,`created_at` DESC),
  KEY `idx_announcements_cohort` (`cohort_id`),
  CONSTRAINT `fk_announce_cohort` FOREIGN KEY (`cohort_id`) REFERENCES `cohorts` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_announce_supervisor` FOREIGN KEY (`supervisor_id`) REFERENCES `supervisors` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB AUTO_INCREMENT=285 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `assignment_submissions` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `assignment_id` bigint NOT NULL,
  `student_id` bigint NOT NULL,
  `filename` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `original_name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `notes` text COLLATE utf8mb4_unicode_ci,
  `submitted_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `score` decimal(5,2) DEFAULT NULL,
  `feedback` text COLLATE utf8mb4_unicode_ci,
  `graded_by` bigint DEFAULT NULL,
  `graded_at` datetime DEFAULT NULL,
  `status` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'submitted',
  PRIMARY KEY (`id`),
  KEY `fk_asub_graded_by` (`graded_by`),
  KEY `idx_assignment_submissions_assignment` (`assignment_id`),
  KEY `idx_assignment_submissions_student` (`student_id`),
  CONSTRAINT `fk_asub_assignment` FOREIGN KEY (`assignment_id`) REFERENCES `assignments` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_asub_graded_by` FOREIGN KEY (`graded_by`) REFERENCES `supervisors` (`id`),
  CONSTRAINT `fk_asub_student` FOREIGN KEY (`student_id`) REFERENCES `students` (`id`) ON DELETE CASCADE,
  CONSTRAINT `assignment_submissions_chk_1` CHECK ((`status` in (_utf8mb4'submitted',_utf8mb4'graded',_utf8mb4'returned')))
) ENGINE=InnoDB AUTO_INCREMENT=199 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Fills the "students can submit assignments" gap -- previously unmodeled, flagged in earlier dashboard builds.';
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `assignments` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `student_id` bigint NOT NULL,
  `supervisor_id` bigint NOT NULL,
  `title` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` text COLLATE utf8mb4_unicode_ci,
  `attachment_filename` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `content_url` varchar(2048) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `due_date` date DEFAULT NULL,
  `status` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending',
  `max_score` decimal(5,2) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_assignments_student` (`student_id`,`due_date`),
  KEY `idx_assignments_supervisor` (`supervisor_id`),
  CONSTRAINT `fk_assignments_student` FOREIGN KEY (`student_id`) REFERENCES `students` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_assignments_supervisor` FOREIGN KEY (`supervisor_id`) REFERENCES `supervisors` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `assignments_chk_1` CHECK ((`status` in (_utf8mb4'pending',_utf8mb4'submitted',_utf8mb4'completed',_utf8mb4'overdue')))
) ENGINE=InnoDB AUTO_INCREMENT=1649 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `attendance` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `student_id` bigint NOT NULL,
  `supervisor_id` bigint NOT NULL,
  `session_id` bigint DEFAULT NULL,
  `attendance_date` date NOT NULL,
  `status` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `notes` text COLLATE utf8mb4_unicode_ci,
  `recorded_by` bigint NOT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `minutes_completed` int DEFAULT NULL,
  `excuse_reason_code` varchar(30) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `updated_by` bigint DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_attendance_session` (`session_id`),
  KEY `fk_attendance_recorded_by` (`recorded_by`),
  KEY `idx_attendance_student_date` (`student_id`,`attendance_date` DESC),
  KEY `idx_attendance_supervisor_date` (`supervisor_id`,`attendance_date` DESC),
  KEY `fk_attendance_excuse_reason` (`excuse_reason_code`),
  KEY `fk_attendance_updated_by` (`updated_by`),
  CONSTRAINT `fk_attendance_excuse_reason` FOREIGN KEY (`excuse_reason_code`) REFERENCES `excuse_reasons` (`code`) ON UPDATE CASCADE,
  CONSTRAINT `fk_attendance_recorded_by` FOREIGN KEY (`recorded_by`) REFERENCES `user_credentials` (`id`),
  CONSTRAINT `fk_attendance_session` FOREIGN KEY (`session_id`) REFERENCES `sessions` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_attendance_student` FOREIGN KEY (`student_id`) REFERENCES `students` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_attendance_supervisor` FOREIGN KEY (`supervisor_id`) REFERENCES `supervisors` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_attendance_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user_credentials` (`id`),
  CONSTRAINT `attendance_chk_1` CHECK ((`status` in (_utf8mb4'present',_utf8mb4'absent',_utf8mb4'excused',_utf8mb4'partial')))
) ENGINE=InnoDB AUTO_INCREMENT=21070 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `audit_logs` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `actor_id` bigint DEFAULT NULL,
  `action` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `entity_type` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `entity_id` bigint DEFAULT NULL,
  `old_values` json DEFAULT NULL,
  `new_values` json DEFAULT NULL,
  `ip_address` varchar(45) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_audit_logs_actor` (`actor_id`,`created_at` DESC),
  KEY `idx_audit_logs_entity` (`entity_type`,`entity_id`),
  CONSTRAINT `fk_audit_actor` FOREIGN KEY (`actor_id`) REFERENCES `user_credentials` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=3910 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Structured before/after diffs for a real audit trail.';
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `calendar_events` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `owner_id` bigint NOT NULL,
  `student_id` bigint DEFAULT NULL,
  `event_type` varchar(30) COLLATE utf8mb4_unicode_ci NOT NULL,
  `title` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` text COLLATE utf8mb4_unicode_ci,
  `event_date` date NOT NULL,
  `event_time` time DEFAULT NULL,
  `related_session_id` bigint DEFAULT NULL,
  `related_meeting_id` bigint DEFAULT NULL,
  `related_assignment_id` bigint DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `fk_calevents_session` (`related_session_id`),
  KEY `fk_calevents_meeting` (`related_meeting_id`),
  KEY `fk_calevents_assignment` (`related_assignment_id`),
  KEY `idx_calendar_events_date` (`event_date`),
  KEY `idx_calendar_events_student_date` (`student_id`,`event_date`),
  KEY `idx_calevents_owner_date` (`owner_id`,`event_date`),
  KEY `idx_calevents_student_date` (`student_id`,`event_date`),
  CONSTRAINT `fk_calevents_assignment` FOREIGN KEY (`related_assignment_id`) REFERENCES `assignments` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_calevents_meeting` FOREIGN KEY (`related_meeting_id`) REFERENCES `meetings` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_calevents_owner` FOREIGN KEY (`owner_id`) REFERENCES `user_credentials` (`id`),
  CONSTRAINT `fk_calevents_session` FOREIGN KEY (`related_session_id`) REFERENCES `sessions` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_calevents_student` FOREIGN KEY (`student_id`) REFERENCES `students` (`id`) ON DELETE CASCADE,
  CONSTRAINT `calendar_events_chk_1` CHECK ((`event_type` in (_utf8mb4'session',_utf8mb4'meeting',_utf8mb4'assignment_deadline',_utf8mb4'custom',_utf8mb4'holiday')))
) ENGINE=InnoDB AUTO_INCREMENT=115 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Denormalized, queryable calendar. Populate on insert of sessions/meetings/assignment due dates at the application layer.';
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `chat_room_members` (
  `room_id` bigint NOT NULL,
  `user_id` bigint NOT NULL,
  `added_by` bigint DEFAULT NULL,
  `joined_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_read_at` datetime DEFAULT NULL,
  PRIMARY KEY (`room_id`,`user_id`),
  KEY `fk_crm_added_by` (`added_by`),
  KEY `idx_crm_user` (`user_id`),
  CONSTRAINT `fk_crm_added_by` FOREIGN KEY (`added_by`) REFERENCES `user_credentials` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_crm_room` FOREIGN KEY (`room_id`) REFERENCES `chat_rooms` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_crm_user` FOREIGN KEY (`user_id`) REFERENCES `user_credentials` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Who is actually in a chat room -- independent of trainer_group/supervisor_students membership.';
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `chat_room_messages` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `room_id` bigint NOT NULL,
  `sender_id` bigint NOT NULL,
  `content` text COLLATE utf8mb4_unicode_ci,
  `attachment_filename` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `attachment_original_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `attachment_mime` varchar(150) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `attachment_size` int DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `fk_crmsg_sender` (`sender_id`),
  KEY `idx_crmsg_room_created` (`room_id`,`created_at`),
  CONSTRAINT `fk_crmsg_room` FOREIGN KEY (`room_id`) REFERENCES `chat_rooms` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_crmsg_sender` FOREIGN KEY (`sender_id`) REFERENCES `user_credentials` (`id`),
  CONSTRAINT `chk_crmsg_has_content` CHECK (((`content` is not null) or (`attachment_filename` is not null)))
) ENGINE=InnoDB AUTO_INCREMENT=1097 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Group chat messages, optionally carrying a single attachment. See backend/src/routes/chatRooms.js.';
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `chat_rooms` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_by` bigint NOT NULL,
  `group_id` bigint NOT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `is_direct` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `fk_chat_rooms_group` (`group_id`),
  KEY `fk_chat_rooms_creator` (`created_by`),
  CONSTRAINT `fk_chat_rooms_creator` FOREIGN KEY (`created_by`) REFERENCES `user_credentials` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_chat_rooms_group` FOREIGN KEY (`group_id`) REFERENCES `trainer_groups` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=212 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='A Master Trainer-curated group chat room. Membership lives in chat_room_members, not derived automatically from the group.';
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `chats` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `supervisor_id` bigint NOT NULL,
  `student_id` bigint DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_message_at` datetime DEFAULT NULL,
  `target_supervisor_id` bigint DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_chats_supervisor_student` (`supervisor_id`,`student_id`),
  UNIQUE KEY `uq_chats_supervisor_target` (`supervisor_id`,`target_supervisor_id`),
  KEY `idx_chats_student` (`student_id`),
  KEY `idx_chats_target_supervisor` (`target_supervisor_id`),
  CONSTRAINT `fk_chats_student` FOREIGN KEY (`student_id`) REFERENCES `students` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_chats_supervisor` FOREIGN KEY (`supervisor_id`) REFERENCES `supervisors` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_chats_target_supervisor` FOREIGN KEY (`target_supervisor_id`) REFERENCES `supervisors` (`id`) ON DELETE CASCADE,
  CONSTRAINT `chk_chats_exactly_one_target` CHECK ((((`student_id` is not null) and (`target_supervisor_id` is null)) or ((`student_id` is null) and (`target_supervisor_id` is not null))))
) ENGINE=InnoDB AUTO_INCREMENT=392 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='One persistent thread per supervisor-student pair.';
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `cohorts` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `start_date` date DEFAULT NULL,
  `end_date` date DEFAULT NULL,
  `description` text COLLATE utf8mb4_unicode_ci,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `name` (`name`),
  CONSTRAINT `cohorts_chk_1` CHECK (((`end_date` is null) or (`start_date` is null) or (`end_date` >= `start_date`)))
) ENGINE=InnoDB AUTO_INCREMENT=79 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `designers` (
  `id` bigint NOT NULL,
  `full_name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `email` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `phone` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `photo` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `email` (`email`),
  CONSTRAINT `fk_designers_credentials` FOREIGN KEY (`id`) REFERENCES `user_credentials` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Profile extension of user_credentials for role = designer. Owns the public-site events they create (see events.created_by). Not created by Admin through the Groups flow -- a separate, self-contained account with its own login and password change, no access to trainee/finance/account-management features.';
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `documents` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `student_id` bigint DEFAULT NULL,
  `group_id` bigint DEFAULT NULL,
  `uploaded_by` bigint NOT NULL,
  `document_type` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'general',
  `filename` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `original_name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `shared_with_supervisor_id` bigint DEFAULT NULL,
  `approval_status` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'approved',
  `approved_by` bigint DEFAULT NULL,
  `approved_at` datetime DEFAULT NULL,
  `idempotency_key` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_documents_idempotency_key` (`idempotency_key`),
  KEY `fk_documents_uploaded_by` (`uploaded_by`),
  KEY `idx_documents_student` (`student_id`,`created_at` DESC),
  KEY `fk_documents_group` (`group_id`),
  KEY `idx_documents_shared_supervisor` (`shared_with_supervisor_id`),
  KEY `fk_documents_approved_by` (`approved_by`),
  CONSTRAINT `fk_documents_approved_by` FOREIGN KEY (`approved_by`) REFERENCES `supervisors` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_documents_group` FOREIGN KEY (`group_id`) REFERENCES `trainer_groups` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_documents_shared_supervisor` FOREIGN KEY (`shared_with_supervisor_id`) REFERENCES `supervisors` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_documents_student` FOREIGN KEY (`student_id`) REFERENCES `students` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_documents_uploaded_by` FOREIGN KEY (`uploaded_by`) REFERENCES `user_credentials` (`id`),
  CONSTRAINT `chk_document_approval_status` CHECK ((`approval_status` in (_utf8mb4'pending',_utf8mb4'approved'))),
  CONSTRAINT `documents_chk_1` CHECK ((`document_type` in (_utf8mb4'general',_utf8mb4'cv',_utf8mb4'certificate',_utf8mb4'assignment')))
) ENGINE=InnoDB AUTO_INCREMENT=86 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `evaluations` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `student_id` bigint NOT NULL,
  `supervisor_id` bigint NOT NULL,
  `session_id` bigint DEFAULT NULL,
  `evaluation_date` date DEFAULT NULL,
  `title` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `score` decimal(5,2) DEFAULT NULL,
  `content` text COLLATE utf8mb4_unicode_ci,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `fk_evaluations_supervisor` (`supervisor_id`),
  KEY `fk_evaluations_session` (`session_id`),
  KEY `idx_evaluations_student` (`student_id`,`evaluation_date` DESC),
  CONSTRAINT `fk_evaluations_session` FOREIGN KEY (`session_id`) REFERENCES `sessions` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_evaluations_student` FOREIGN KEY (`student_id`) REFERENCES `students` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_evaluations_supervisor` FOREIGN KEY (`supervisor_id`) REFERENCES `supervisors` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `evaluations_chk_1` CHECK (((`score` is null) or ((`score` >= 0) and (`score` <= 100))))
) ENGINE=InnoDB AUTO_INCREMENT=15 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `event_agenda_items` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `event_id` bigint NOT NULL,
  `item_date` date DEFAULT NULL,
  `start_time` time DEFAULT NULL,
  `end_time` time DEFAULT NULL,
  `title_en` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `title_ar` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `description_en` text COLLATE utf8mb4_unicode_ci,
  `description_ar` text COLLATE utf8mb4_unicode_ci,
  `speaker_id` bigint DEFAULT NULL,
  `sort_order` int NOT NULL DEFAULT '0',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `fk_event_agenda_event` (`event_id`),
  KEY `fk_event_agenda_speaker` (`speaker_id`),
  KEY `ix_event_agenda_date` (`item_date`),
  CONSTRAINT `fk_event_agenda_event` FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_event_agenda_speaker` FOREIGN KEY (`speaker_id`) REFERENCES `event_speakers` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=20 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `event_gallery` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `event_id` bigint NOT NULL,
  `image` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `caption_en` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `caption_ar` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `sort_order` int NOT NULL DEFAULT '0',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `fk_event_gallery_event` (`event_id`),
  CONSTRAINT `fk_event_gallery_event` FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `event_registrations` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `event_id` bigint NOT NULL,
  `first_name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `last_name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `email` varchar(190) COLLATE utf8mb4_unicode_ci NOT NULL,
  `phone` varchar(40) COLLATE utf8mb4_unicode_ci NOT NULL,
  `location` varchar(150) COLLATE utf8mb4_unicode_ci NOT NULL,
  `email_sent` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_event_registrations_event_id` (`event_id`),
  CONSTRAINT `fk_event_registrations_event` FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=4 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `event_speakers` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `event_id` bigint NOT NULL,
  `name_en` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `name_ar` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `title_en` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `title_ar` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `bio_en` text COLLATE utf8mb4_unicode_ci,
  `bio_ar` text COLLATE utf8mb4_unicode_ci,
  `photo` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `sort_order` int NOT NULL DEFAULT '0',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `fk_event_speakers_event` (`event_id`),
  CONSTRAINT `fk_event_speakers_event` FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `event_sponsors` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `event_id` bigint NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `logo` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `url` varchar(2048) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `sort_order` int NOT NULL DEFAULT '0',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `fk_event_sponsors_event` (`event_id`),
  CONSTRAINT `fk_event_sponsors_event` FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `events` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `created_by` bigint DEFAULT NULL,
  `event_date` datetime NOT NULL,
  `image` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `status` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'upcoming',
  `fee` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `credits_en` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `credits_ar` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `register_url` varchar(2048) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `title_en` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `format_en` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `facilitator_en` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `about_en` text COLLATE utf8mb4_unicode_ci,
  `learn_en` json DEFAULT NULL,
  `who_en` json DEFAULT NULL,
  `outcomes_en` json DEFAULT NULL,
  `facilitator_bio_en` text COLLATE utf8mb4_unicode_ci,
  `title_ar` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `format_ar` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `facilitator_ar` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `about_ar` text COLLATE utf8mb4_unicode_ci,
  `learn_ar` json DEFAULT NULL,
  `who_ar` json DEFAULT NULL,
  `outcomes_ar` json DEFAULT NULL,
  `facilitator_bio_ar` text COLLATE utf8mb4_unicode_ci,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `slug` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `show_speakers` tinyint(1) NOT NULL DEFAULT '0',
  `show_agenda` tinyint(1) NOT NULL DEFAULT '0',
  `show_sponsors` tinyint(1) NOT NULL DEFAULT '0',
  `show_gallery` tinyint(1) NOT NULL DEFAULT '0',
  `show_registration` tinyint(1) NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_events_slug` (`slug`),
  KEY `idx_events_date` (`event_date` DESC),
  KEY `idx_events_status` (`status`),
  KEY `idx_events_created_by` (`created_by`),
  CONSTRAINT `fk_events_created_by` FOREIGN KEY (`created_by`) REFERENCES `user_credentials` (`id`) ON DELETE SET NULL,
  CONSTRAINT `events_chk_1` CHECK ((`status` in (_utf8mb4'upcoming',_utf8mb4'concluded')))
) ENGINE=InnoDB AUTO_INCREMENT=97 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Public events.html page content. created_by is the owning Designer (Admin-authored legacy rows have created_by pointing at the Admin account, or NULL). A Designer may only manage rows where created_by = their own id -- enforced at the Express route layer. learn_en/who_en/outcomes_en etc. are JSON arrays of strings.';
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `excuse_reasons` (
  `code` varchar(30) COLLATE utf8mb4_unicode_ci NOT NULL,
  `label` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `hour_types` (
  `code` varchar(30) COLLATE utf8mb4_unicode_ci NOT NULL,
  `label` varchar(60) COLLATE utf8mb4_unicode_ci NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `is_primary` tinyint(1) NOT NULL DEFAULT '0',
  `sort_order` int NOT NULL DEFAULT '0',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `id_counters` (
  `prefix` varchar(10) COLLATE utf8mb4_unicode_ci NOT NULL,
  `last_number` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`prefix`),
  CONSTRAINT `id_counters_chk_1` CHECK ((`last_number` >= 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Tracks the last number issued per member_code prefix so IDs (TTR001, TTR002, ...) never collide. Increment atomically inside the same transaction that inserts the new user_credentials row.';
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `invoices` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `student_id` bigint NOT NULL,
  `invoice_number` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `amount_cents` int NOT NULL,
  `issue_date` date NOT NULL DEFAULT (curdate()),
  `due_date` date DEFAULT NULL,
  `status` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'draft',
  `notes` text COLLATE utf8mb4_unicode_ci,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `invoice_number` (`invoice_number`),
  KEY `idx_invoices_student` (`student_id`),
  CONSTRAINT `fk_invoices_student` FOREIGN KEY (`student_id`) REFERENCES `students` (`id`) ON DELETE CASCADE,
  CONSTRAINT `invoices_chk_1` CHECK ((`amount_cents` >= 0)),
  CONSTRAINT `invoices_chk_2` CHECK ((`status` in (_utf8mb4'draft',_utf8mb4'sent',_utf8mb4'paid',_utf8mb4'overdue',_utf8mb4'cancelled')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `learning_materials` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `supervisor_id` bigint DEFAULT NULL,
  `admin_id` bigint DEFAULT NULL,
  `student_id` bigint DEFAULT NULL,
  `title` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` text COLLATE utf8mb4_unicode_ci,
  `material_type` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `filename` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `original_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `external_url` varchar(2048) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `author` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `category` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `cover_image` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `publisher` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `publication_location` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `publication_year` smallint DEFAULT NULL,
  `resource_type` varchar(30) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `file_hash` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `idempotency_key` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `book_hash_key` varchar(64) COLLATE utf8mb4_unicode_ci GENERATED ALWAYS AS ((case when (`material_type` = _utf8mb4'book') then `file_hash` else NULL end)) VIRTUAL,
  `group_id` bigint DEFAULT NULL,
  `shared_with_supervisor_id` bigint DEFAULT NULL,
  `country` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `doi` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `isbn` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `oclc_number` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_materials_idempotency_key` (`idempotency_key`),
  UNIQUE KEY `uniq_materials_book_hash` (`book_hash_key`),
  KEY `idx_materials_supervisor` (`supervisor_id`,`created_at` DESC),
  KEY `idx_materials_student` (`student_id`),
  KEY `fk_material_admin` (`admin_id`),
  KEY `idx_materials_type_created` (`material_type`,`created_at`),
  KEY `idx_materials_file_hash` (`file_hash`),
  KEY `idx_materials_group` (`group_id`),
  KEY `idx_materials_shared_supervisor` (`shared_with_supervisor_id`),
  CONSTRAINT `fk_material_admin` FOREIGN KEY (`admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_material_group` FOREIGN KEY (`group_id`) REFERENCES `trainer_groups` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_material_shared_supervisor` FOREIGN KEY (`shared_with_supervisor_id`) REFERENCES `supervisors` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_material_student` FOREIGN KEY (`student_id`) REFERENCES `students` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_material_supervisor` FOREIGN KEY (`supervisor_id`) REFERENCES `supervisors` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `chk_material_has_file` CHECK (((`filename` is not null) or (`external_url` is not null))),
  CONSTRAINT `chk_publication_year` CHECK (((`publication_year` is null) or (`publication_year` between 1000 and 2100))),
  CONSTRAINT `chk_resource_type` CHECK (((`resource_type` is null) or (`resource_type` in (_utf8mb4'book',_utf8mb4'article',_utf8mb4'research_paper',_utf8mb4'academic_paper',_utf8mb4'thesis',_utf8mb4'ebook',_utf8mb4'reference',_utf8mb4'guide',_utf8mb4'report',_utf8mb4'other')))),
  CONSTRAINT `learning_materials_chk_1` CHECK ((`material_type` in (_utf8mb4'document',_utf8mb4'image',_utf8mb4'video',_utf8mb4'audio',_utf8mb4'link',_utf8mb4'assignment',_utf8mb4'worksheet',_utf8mb4'reading',_utf8mb4'book')))
) ENGINE=InnoDB AUTO_INCREMENT=596 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `meetings` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `supervisor_id` bigint NOT NULL,
  `student_id` bigint DEFAULT NULL,
  `title` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `platform` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `meeting_url` varchar(2048) COLLATE utf8mb4_unicode_ci NOT NULL,
  `scheduled_at` datetime DEFAULT NULL,
  `duration_minutes` int DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `target_group_id` bigint DEFAULT NULL,
  `target_supervisor_id` bigint DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_meetings_supervisor` (`supervisor_id`,`scheduled_at`),
  KEY `idx_meetings_student` (`student_id`),
  KEY `idx_meetings_target_group` (`target_group_id`),
  KEY `idx_meetings_target_supervisor` (`target_supervisor_id`),
  CONSTRAINT `fk_meetings_student` FOREIGN KEY (`student_id`) REFERENCES `students` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_meetings_supervisor` FOREIGN KEY (`supervisor_id`) REFERENCES `supervisors` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_meetings_target_group` FOREIGN KEY (`target_group_id`) REFERENCES `trainer_groups` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_meetings_target_supervisor` FOREIGN KEY (`target_supervisor_id`) REFERENCES `supervisors` (`id`) ON DELETE SET NULL,
  CONSTRAINT `meetings_chk_1` CHECK ((`platform` in (_utf8mb4'zoom',_utf8mb4'teams',_utf8mb4'meet',_utf8mb4'other'))),
  CONSTRAINT `meetings_chk_2` CHECK (((`duration_minutes` is null) or (`duration_minutes` >= 0)))
) ENGINE=InnoDB AUTO_INCREMENT=101 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Fills the "no meetings table exists" gap flagged in earlier Supervisor/Student dashboard builds.';
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `messages` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `chat_id` bigint NOT NULL,
  `sender_id` bigint NOT NULL,
  `content` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `is_read` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `fk_messages_sender` (`sender_id`),
  KEY `idx_messages_chat_created` (`chat_id`,`created_at` DESC),
  CONSTRAINT `fk_messages_chat` FOREIGN KEY (`chat_id`) REFERENCES `chats` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_messages_sender` FOREIGN KEY (`sender_id`) REFERENCES `user_credentials` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=1582 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `notifications` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `recipient_id` bigint NOT NULL,
  `notification_type` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `title` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `body` text COLLATE utf8mb4_unicode_ci,
  `related_entity_type` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `related_entity_id` bigint DEFAULT NULL,
  `is_read` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_notifications_recipient_unread` (`recipient_id`,`is_read`,`created_at` DESC),
  CONSTRAINT `fk_notifications_recipient` FOREIGN KEY (`recipient_id`) REFERENCES `user_credentials` (`id`) ON DELETE CASCADE,
  CONSTRAINT `notifications_chk_1` CHECK ((`notification_type` in (_utf8mb4'message',_utf8mb4'assignment',_utf8mb4'session',_utf8mb4'meeting',_utf8mb4'payment',_utf8mb4'announcement',_utf8mb4'document',_utf8mb4'system')))
) ENGINE=InnoDB AUTO_INCREMENT=3582 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `password_reset_tokens` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `user_id` bigint NOT NULL,
  `code_hash` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `expires_at` datetime NOT NULL,
  `used_at` datetime DEFAULT NULL,
  `attempt_count` int NOT NULL DEFAULT '0',
  `ip_address` varchar(45) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_password_reset_user` (`user_id`,`created_at`),
  KEY `idx_password_reset_ip` (`ip_address`,`created_at`),
  CONSTRAINT `fk_password_reset_user` FOREIGN KEY (`user_id`) REFERENCES `user_credentials` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=52 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Single-use, short-lived, hashed reset codes for the self-service Forgot Password flow. See backend/src/utils/passwordReset.js.';
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `payment_transactions` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `student_id` bigint NOT NULL,
  `payment_id` bigint NOT NULL,
  `invoice_id` bigint DEFAULT NULL,
  `amount_cents` int NOT NULL,
  `transaction_type` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'payment',
  `payment_date` date NOT NULL,
  `method` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `added_by` bigint NOT NULL,
  `notes` text COLLATE utf8mb4_unicode_ci,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `fk_paytx_added_by` (`added_by`),
  KEY `idx_payment_tx_student_date` (`student_id`,`payment_date` DESC),
  KEY `idx_payment_tx_invoice` (`invoice_id`),
  KEY `idx_paytx_payment` (`payment_id`),
  CONSTRAINT `fk_paytx_added_by` FOREIGN KEY (`added_by`) REFERENCES `user_credentials` (`id`),
  CONSTRAINT `fk_paytx_invoice` FOREIGN KEY (`invoice_id`) REFERENCES `invoices` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_paytx_payment` FOREIGN KEY (`payment_id`) REFERENCES `payments` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_paytx_student` FOREIGN KEY (`student_id`) REFERENCES `students` (`id`) ON DELETE CASCADE,
  CONSTRAINT `payment_transactions_chk_1` CHECK ((`transaction_type` in (_utf8mb4'payment',_utf8mb4'refund',_utf8mb4'adjustment')))
) ENGINE=InnoDB AUTO_INCREMENT=93 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Append-only ledger -- never UPDATE or DELETE a transaction. Corrections are new rows with transaction_type = refund/adjustment and an explanatory note, preserving full financial history permanently.';
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `payments` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `student_id` bigint NOT NULL,
  `training_year` tinyint unsigned NOT NULL DEFAULT '1',
  `total_fee_cents` int NOT NULL DEFAULT '0',
  `discount_cents` int NOT NULL DEFAULT '0',
  `payment_plan` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `next_due_date` date DEFAULT NULL,
  `status` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'unpaid',
  `period_status` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'active',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_payments_student_year` (`student_id`,`training_year`),
  CONSTRAINT `fk_payments_student` FOREIGN KEY (`student_id`) REFERENCES `students` (`id`) ON DELETE CASCADE,
  CONSTRAINT `chk_payments_period_status` CHECK ((`period_status` in (_utf8mb4'active',_utf8mb4'completed'))),
  CONSTRAINT `chk_payments_training_year` CHECK ((`training_year` between 1 and 4)),
  CONSTRAINT `payments_chk_1` CHECK ((`total_fee_cents` >= 0)),
  CONSTRAINT `payments_chk_2` CHECK ((`discount_cents` >= 0)),
  CONSTRAINT `payments_chk_3` CHECK ((`payment_plan` in (_utf8mb4'full',_utf8mb4'installment',_utf8mb4'custom'))),
  CONSTRAINT `payments_chk_4` CHECK ((`status` in (_utf8mb4'unpaid',_utf8mb4'partial',_utf8mb4'paid')))
) ENGINE=InnoDB AUTO_INCREMENT=199 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='One fee agreement per student. status and remaining balance are recomputed by the application whenever payment_transactions changes for this student (SUM(amount_cents) vs total_fee_cents - discount_cents).';
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `privacy_preferences` (
  `user_id` bigint NOT NULL,
  `show_photo_to_others` tinyint(1) NOT NULL DEFAULT '1',
  `share_progress_with_cohort` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`user_id`),
  CONSTRAINT `fk_privacy_credentials` FOREIGN KEY (`user_id`) REFERENCES `user_credentials` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `session_occasions` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `supervisor_id` bigint NOT NULL,
  `provided_by_supervisor_id` bigint DEFAULT NULL,
  `session_type` varchar(30) COLLATE utf8mb4_unicode_ci NOT NULL,
  `title` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `session_date` date NOT NULL,
  `session_time` time DEFAULT NULL,
  `duration_minutes` int NOT NULL,
  `notes` text COLLATE utf8mb4_unicode_ci,
  `attachment_filename` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `attachment_original_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `series_id` bigint DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `fk_socc_supervisor` (`supervisor_id`),
  KEY `fk_socc_hour_type` (`session_type`),
  KEY `fk_socc_series` (`series_id`),
  KEY `fk_socc_provided_by` (`provided_by_supervisor_id`),
  CONSTRAINT `fk_socc_hour_type` FOREIGN KEY (`session_type`) REFERENCES `hour_types` (`code`) ON UPDATE CASCADE,
  CONSTRAINT `fk_socc_provided_by` FOREIGN KEY (`provided_by_supervisor_id`) REFERENCES `supervisors` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_socc_series` FOREIGN KEY (`series_id`) REFERENCES `session_series` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_socc_supervisor` FOREIGN KEY (`supervisor_id`) REFERENCES `supervisors` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `session_occasions_chk_1` CHECK ((`duration_minutes` >= 0))
) ENGINE=InnoDB AUTO_INCREMENT=2370 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `session_series` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `supervisor_id` bigint NOT NULL,
  `provided_by_supervisor_id` bigint DEFAULT NULL,
  `session_type` varchar(30) COLLATE utf8mb4_unicode_ci NOT NULL,
  `title` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `notes` text COLLATE utf8mb4_unicode_ci,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `fk_sseries_supervisor` (`supervisor_id`),
  KEY `fk_sseries_hour_type` (`session_type`),
  KEY `fk_sseries_provided_by` (`provided_by_supervisor_id`),
  CONSTRAINT `fk_sseries_hour_type` FOREIGN KEY (`session_type`) REFERENCES `hour_types` (`code`) ON UPDATE CASCADE,
  CONSTRAINT `fk_sseries_provided_by` FOREIGN KEY (`provided_by_supervisor_id`) REFERENCES `supervisors` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_sseries_supervisor` FOREIGN KEY (`supervisor_id`) REFERENCES `supervisors` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB AUTO_INCREMENT=412 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Groups multiple session_occasions rows (one per day) into a single multi-day Session. NULL series_id on session_occasions = an ordinary single-day Session, unchanged from before this migration.';
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `sessions` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `student_id` bigint NOT NULL,
  `supervisor_id` bigint NOT NULL,
  `provided_by_supervisor_id` bigint DEFAULT NULL,
  `session_type` varchar(30) COLLATE utf8mb4_unicode_ci NOT NULL,
  `title` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `session_date` date NOT NULL,
  `session_time` time DEFAULT NULL,
  `duration_minutes` int DEFAULT NULL,
  `location` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `notes` text COLLATE utf8mb4_unicode_ci,
  `status` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'scheduled',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `attachment_filename` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `attachment_original_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `occasion_id` bigint DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sessions_occasion_student` (`occasion_id`,`student_id`),
  KEY `idx_sessions_student_date` (`student_id`,`session_date` DESC),
  KEY `idx_sessions_supervisor_date` (`supervisor_id`,`session_date` DESC),
  KEY `fk_sessions_hour_type` (`session_type`),
  KEY `fk_sessions_provided_by` (`provided_by_supervisor_id`),
  CONSTRAINT `fk_sessions_hour_type` FOREIGN KEY (`session_type`) REFERENCES `hour_types` (`code`) ON UPDATE CASCADE,
  CONSTRAINT `fk_sessions_occasion` FOREIGN KEY (`occasion_id`) REFERENCES `session_occasions` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_sessions_provided_by` FOREIGN KEY (`provided_by_supervisor_id`) REFERENCES `supervisors` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_sessions_student` FOREIGN KEY (`student_id`) REFERENCES `students` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_sessions_supervisor` FOREIGN KEY (`supervisor_id`) REFERENCES `supervisors` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `sessions_chk_2` CHECK (((`duration_minutes` is null) or (`duration_minutes` >= 0))),
  CONSTRAINT `sessions_chk_3` CHECK ((`status` in (_utf8mb4'scheduled',_utf8mb4'completed',_utf8mb4'cancelled')))
) ENGINE=InnoDB AUTO_INCREMENT=22216 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `settings` (
  `user_id` bigint NOT NULL,
  `language` varchar(5) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'en',
  `theme` varchar(10) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'light',
  `timezone` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT 'Asia/Beirut',
  `notify_messages` tinyint(1) NOT NULL DEFAULT '1',
  `notify_assignments` tinyint(1) NOT NULL DEFAULT '1',
  `notify_sessions` tinyint(1) NOT NULL DEFAULT '1',
  `notify_payments` tinyint(1) NOT NULL DEFAULT '1',
  `notify_announcements` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`user_id`),
  CONSTRAINT `fk_settings_credentials` FOREIGN KEY (`user_id`) REFERENCES `user_credentials` (`id`) ON DELETE CASCADE,
  CONSTRAINT `settings_chk_1` CHECK ((`language` in (_utf8mb4'en',_utf8mb4'ar'))),
  CONSTRAINT `settings_chk_2` CHECK ((`theme` in (_utf8mb4'light',_utf8mb4'dark')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='One row per account. Replaces the localStorage-only notification-preference stopgap used before this table existed.';
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `student_health_info` (
  `student_id` bigint NOT NULL,
  `medical_conditions` text COLLATE utf8mb4_unicode_ci,
  `emergency_contact_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `emergency_contact_relationship` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `emergency_contact_phone` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `consent_given` tinyint(1) NOT NULL DEFAULT '0',
  `consent_given_at` datetime DEFAULT NULL,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `emergency_contact_phone_2` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`student_id`),
  CONSTRAINT `fk_health_student` FOREIGN KEY (`student_id`) REFERENCES `students` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Restricted medical/emergency data. Only Admin (full access), the trainee themself, and their assigned Master Trainer/Trainers (read-only) may access this -- enforced at the Express route layer (see backend/src/routes), not by the database, since MySQL has no Row-Level Security.';
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `students` (
  `id` bigint NOT NULL,
  `full_name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `email` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `gender` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `date_of_birth` date DEFAULT NULL,
  `marital_status` varchar(30) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `phone` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `address` text COLLATE utf8mb4_unicode_ci,
  `highest_degree` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `institution` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `certifications` text COLLATE utf8mb4_unicode_ci,
  `cohort_id` int DEFAULT NULL,
  `current_year` int DEFAULT NULL,
  `cv_file` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `photo` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `group_id` bigint DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `training_start_date` date DEFAULT '2026-09-15',
  `training_duration_years` int DEFAULT NULL,
  `lifecycle_status` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'active',
  PRIMARY KEY (`id`),
  UNIQUE KEY `email` (`email`),
  KEY `idx_students_cohort` (`cohort_id`),
  KEY `idx_students_group` (`group_id`),
  CONSTRAINT `fk_students_cohort` FOREIGN KEY (`cohort_id`) REFERENCES `cohorts` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_students_credentials` FOREIGN KEY (`id`) REFERENCES `user_credentials` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_students_group` FOREIGN KEY (`group_id`) REFERENCES `trainer_groups` (`id`) ON DELETE SET NULL,
  CONSTRAINT `students_chk_1` CHECK (((`current_year` is null) or (`current_year` between 1 and 10))),
  CONSTRAINT `students_chk_2` CHECK ((`lifecycle_status` in (_utf8mb4'active',_utf8mb4'inactive',_utf8mb4'on_hold',_utf8mb4'withdrawn',_utf8mb4'in_progress',_utf8mb4'completed')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Profile extension of user_credentials for role = trainee (displayed as Trainee in the Admin UI). Only Admin creates these rows, as part of creating a Group; group_id ties a trainee to their Group.';
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `supervision_hours` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `student_id` bigint NOT NULL,
  `supervisor_id` bigint NOT NULL,
  `session_id` bigint DEFAULT NULL,
  `hours` decimal(6,2) NOT NULL,
  `hour_date` date NOT NULL,
  `hour_type` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `description` text COLLATE utf8mb4_unicode_ci,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `fk_svhours_session` (`session_id`),
  KEY `idx_supervision_hours_student` (`student_id`,`hour_date` DESC),
  KEY `idx_supervision_hours_supervisor_date` (`supervisor_id`,`hour_date` DESC),
  CONSTRAINT `fk_svhours_session` FOREIGN KEY (`session_id`) REFERENCES `sessions` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_svhours_student` FOREIGN KEY (`student_id`) REFERENCES `students` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_svhours_supervisor` FOREIGN KEY (`supervisor_id`) REFERENCES `supervisors` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `supervision_hours_chk_1` CHECK ((`hours` >= 0)),
  CONSTRAINT `supervision_hours_chk_2` CHECK ((`hour_type` in (_utf8mb4'individual',_utf8mb4'group')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `supervisor_notes` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `student_id` bigint NOT NULL,
  `supervisor_id` bigint NOT NULL,
  `note_date` date DEFAULT NULL,
  `content` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `attachment_filename` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `attachment_original_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `fk_svnotes_supervisor` (`supervisor_id`),
  KEY `idx_supervisor_notes_student` (`student_id`,`note_date` DESC),
  CONSTRAINT `fk_svnotes_student` FOREIGN KEY (`student_id`) REFERENCES `students` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_svnotes_supervisor` FOREIGN KEY (`supervisor_id`) REFERENCES `supervisors` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB AUTO_INCREMENT=5 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Freeform notes about a student not tied to a specific session, assignment, or evaluation. Visible to the supervisor who wrote them and the student the note is about.';
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `supervisor_students` (
  `supervisor_id` bigint NOT NULL,
  `student_id` bigint NOT NULL,
  `assigned_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `assigned_by` bigint DEFAULT NULL,
  PRIMARY KEY (`supervisor_id`,`student_id`),
  KEY `fk_supstu_assigned_by` (`assigned_by`),
  KEY `idx_supervisor_students_student` (`student_id`),
  CONSTRAINT `fk_supstu_assigned_by` FOREIGN KEY (`assigned_by`) REFERENCES `user_credentials` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_supstu_student` FOREIGN KEY (`student_id`) REFERENCES `students` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_supstu_supervisor` FOREIGN KEY (`supervisor_id`) REFERENCES `supervisors` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Many-to-many caseload assignment. A supervisor can only read/manage students present in this table for them.';
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `supervisors` (
  `id` bigint NOT NULL,
  `full_name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `email` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `phone` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `photo` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `cv_file` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `bio` text COLLATE utf8mb4_unicode_ci,
  `specialization` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `supervisor_type` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'primary',
  `primary_supervisor_id` bigint DEFAULT NULL,
  `group_id` bigint DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `training_start_date` date DEFAULT '2026-09-15',
  `training_duration_years` int DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `email` (`email`),
  KEY `idx_supervisors_primary` (`primary_supervisor_id`),
  KEY `idx_supervisors_group` (`group_id`),
  CONSTRAINT `fk_supervisors_credentials` FOREIGN KEY (`id`) REFERENCES `user_credentials` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_supervisors_group` FOREIGN KEY (`group_id`) REFERENCES `trainer_groups` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_supervisors_primary` FOREIGN KEY (`primary_supervisor_id`) REFERENCES `supervisors` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `chk_supervisor_hierarchy` CHECK ((((`supervisor_type` = _utf8mb4'primary') and (`primary_supervisor_id` is null)) or ((`supervisor_type` = _utf8mb4'in_training') and (`primary_supervisor_id` is not null)))),
  CONSTRAINT `supervisors_chk_1` CHECK ((`supervisor_type` in (_utf8mb4'primary',_utf8mb4'in_training')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Profile extension of user_credentials for role = supervisor (displayed as Master Trainer / Trainer (ToT) in the Admin UI). Only Admin creates these rows, as part of creating a Group. supervisor_type/primary_supervisor_id encode the Master Trainer + 2 Trainers-in-Training hierarchy; group_id ties them to their Group.';
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `tot_hour_adjustments` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `tot_id` bigint NOT NULL,
  `hours` decimal(6,2) NOT NULL,
  `reason` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `notes` text COLLATE utf8mb4_unicode_ci,
  `added_by` bigint NOT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `fk_totadj_added_by` (`added_by`),
  KEY `idx_totadj_tot` (`tot_id`),
  CONSTRAINT `fk_totadj_added_by` FOREIGN KEY (`added_by`) REFERENCES `user_credentials` (`id`),
  CONSTRAINT `fk_totadj_tot` FOREIGN KEY (`tot_id`) REFERENCES `supervisors` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Append-only manual hour-adjustment ledger for a ToT, Master-Trainer-added only. Never UPDATE/DELETE -- a correction is a new row with a negative hours value and an explanatory reason, mirroring payment_transactions.';
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `tot_session_occasions` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `master_trainer_id` bigint NOT NULL,
  `provided_by_supervisor_id` bigint DEFAULT NULL,
  `title` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `session_date` date NOT NULL,
  `session_time` time DEFAULT NULL,
  `duration_minutes` int NOT NULL,
  `notes` text COLLATE utf8mb4_unicode_ci,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `fk_tsocc_mt` (`master_trainer_id`),
  KEY `fk_tsocc_provided_by` (`provided_by_supervisor_id`),
  CONSTRAINT `fk_tsocc_mt` FOREIGN KEY (`master_trainer_id`) REFERENCES `supervisors` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_tsocc_provided_by` FOREIGN KEY (`provided_by_supervisor_id`) REFERENCES `supervisors` (`id`) ON DELETE SET NULL,
  CONSTRAINT `tot_session_occasions_chk_1` CHECK ((`duration_minutes` >= 0))
) ENGINE=InnoDB AUTO_INCREMENT=5 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='One Master-Trainer-to-Group Session event (ToTs, optionally including the Master Trainer herself). Mirrors session_occasions for the tot_training_sessions/tot_training_attendance pair.';
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `tot_training_attendance` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `session_id` bigint NOT NULL,
  `tot_id` bigint NOT NULL,
  `status` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `notes` text COLLATE utf8mb4_unicode_ci,
  `recorded_by` bigint NOT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `minutes_completed` int DEFAULT NULL,
  `excuse_reason_code` varchar(30) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `updated_by` bigint DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_totatt_session` (`session_id`),
  KEY `fk_totatt_recorded_by` (`recorded_by`),
  KEY `idx_totatt_tot` (`tot_id`),
  KEY `fk_totatt_excuse_reason` (`excuse_reason_code`),
  KEY `fk_totatt_updated_by` (`updated_by`),
  CONSTRAINT `fk_totatt_excuse_reason` FOREIGN KEY (`excuse_reason_code`) REFERENCES `excuse_reasons` (`code`) ON UPDATE CASCADE,
  CONSTRAINT `fk_totatt_recorded_by` FOREIGN KEY (`recorded_by`) REFERENCES `user_credentials` (`id`),
  CONSTRAINT `fk_totatt_session` FOREIGN KEY (`session_id`) REFERENCES `tot_training_sessions` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_totatt_tot` FOREIGN KEY (`tot_id`) REFERENCES `supervisors` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_totatt_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `user_credentials` (`id`),
  CONSTRAINT `tot_training_attendance_chk_1` CHECK ((`status` in (_utf8mb4'present',_utf8mb4'absent',_utf8mb4'excused',_utf8mb4'partial')))
) ENGINE=InnoDB AUTO_INCREMENT=18 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Always created together with its tot_training_sessions row (session_id is NOT NULL and unique, unlike the legacy attendance table) so hours are always traceable to a real session, never freeform.';
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `tot_training_sessions` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `tot_id` bigint NOT NULL,
  `master_trainer_id` bigint NOT NULL,
  `provided_by_supervisor_id` bigint DEFAULT NULL,
  `title` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `session_date` date NOT NULL,
  `session_time` time DEFAULT NULL,
  `duration_minutes` int NOT NULL,
  `location` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `notes` text COLLATE utf8mb4_unicode_ci,
  `status` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'completed',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `occasion_id` bigint DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_totsess_occasion_tot` (`occasion_id`,`tot_id`),
  KEY `idx_totsess_tot` (`tot_id`),
  KEY `idx_totsess_mt` (`master_trainer_id`),
  KEY `fk_totsess_provided_by` (`provided_by_supervisor_id`),
  CONSTRAINT `fk_totsess_mt` FOREIGN KEY (`master_trainer_id`) REFERENCES `supervisors` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_totsess_occasion` FOREIGN KEY (`occasion_id`) REFERENCES `tot_session_occasions` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_totsess_provided_by` FOREIGN KEY (`provided_by_supervisor_id`) REFERENCES `supervisors` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_totsess_tot` FOREIGN KEY (`tot_id`) REFERENCES `supervisors` (`id`) ON DELETE CASCADE,
  CONSTRAINT `tot_training_sessions_chk_1` CHECK ((`duration_minutes` >= 0)),
  CONSTRAINT `tot_training_sessions_chk_2` CHECK ((`status` in (_utf8mb4'scheduled',_utf8mb4'completed',_utf8mb4'cancelled')))
) ENGINE=InnoDB AUTO_INCREMENT=21 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Master Trainer -> ToT training sessions. Mirrors the sessions table shape for a relationship the existing student-only sessions table cannot represent.';
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `trainee_hour_adjustments` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `student_id` bigint NOT NULL,
  `hour_type` varchar(30) COLLATE utf8mb4_unicode_ci NOT NULL,
  `hours` decimal(6,2) NOT NULL,
  `reason` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `notes` text COLLATE utf8mb4_unicode_ci,
  `added_by` bigint NOT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `fk_traineeadj_added_by` (`added_by`),
  KEY `idx_traineeadj_student` (`student_id`),
  KEY `fk_traineeadj_hour_type` (`hour_type`),
  CONSTRAINT `fk_traineeadj_added_by` FOREIGN KEY (`added_by`) REFERENCES `user_credentials` (`id`),
  CONSTRAINT `fk_traineeadj_hour_type` FOREIGN KEY (`hour_type`) REFERENCES `hour_types` (`code`) ON UPDATE CASCADE,
  CONSTRAINT `fk_traineeadj_student` FOREIGN KEY (`student_id`) REFERENCES `students` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Append-only manual hour-adjustment ledger for a Trainee, added by whichever supervisor (Master Trainer or ToT) currently has them in their supervisor_students caseload. Never UPDATE/DELETE.';
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `trainee_milestone_progress` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `student_id` bigint NOT NULL,
  `milestone_id` bigint NOT NULL,
  `status` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'not_started',
  `completed_at` datetime DEFAULT NULL,
  `marked_by` bigint DEFAULT NULL,
  `notes` text COLLATE utf8mb4_unicode_ci,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_student_milestone` (`student_id`,`milestone_id`),
  KEY `fk_tmp_marked_by` (`marked_by`),
  KEY `idx_milestone_progress_student` (`student_id`),
  KEY `idx_milestone_progress_milestone` (`milestone_id`),
  CONSTRAINT `fk_tmp_marked_by` FOREIGN KEY (`marked_by`) REFERENCES `supervisors` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_tmp_milestone` FOREIGN KEY (`milestone_id`) REFERENCES `training_milestones` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_tmp_student` FOREIGN KEY (`student_id`) REFERENCES `students` (`id`) ON DELETE CASCADE,
  CONSTRAINT `trainee_milestone_progress_chk_1` CHECK ((`status` in (_utf8mb4'not_started',_utf8mb4'in_progress',_utf8mb4'completed')))
) ENGINE=InnoDB AUTO_INCREMENT=64 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='One row per trainee per milestone the Trainer (ToT) has touched.';
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `trainer_groups` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `name` (`name`)
) ENGINE=InnoDB AUTO_INCREMENT=1118 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='A Group = 1 Master Trainer + 2 Trainers (ToT) + their Trainees, created together as one unit by Admin. See supervisors.group_id / students.group_id. Named trainer_groups, not groups, because GROUPS is a reserved word in MySQL 8.';
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `training_hours` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `student_id` bigint NOT NULL,
  `supervisor_id` bigint NOT NULL,
  `session_id` bigint DEFAULT NULL,
  `hours` decimal(6,2) NOT NULL,
  `hour_date` date NOT NULL,
  `description` text COLLATE utf8mb4_unicode_ci,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `fk_trghours_session` (`session_id`),
  KEY `idx_training_hours_student` (`student_id`,`hour_date` DESC),
  KEY `idx_training_hours_supervisor_date` (`supervisor_id`,`hour_date` DESC),
  CONSTRAINT `fk_trghours_session` FOREIGN KEY (`session_id`) REFERENCES `sessions` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_trghours_student` FOREIGN KEY (`student_id`) REFERENCES `students` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_trghours_supervisor` FOREIGN KEY (`supervisor_id`) REFERENCES `supervisors` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `training_hours_chk_1` CHECK ((`hours` >= 0))
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Kept separate from supervision_hours because clinical training programs typically report these to accreditation bodies as distinct totals.';
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `training_materials_notice_acceptances` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `user_id` bigint NOT NULL,
  `notice_version` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `accepted_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `ip_address` varchar(45) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `user_agent` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_tmna_user_version` (`user_id`,`notice_version`),
  KEY `idx_tmna_user` (`user_id`),
  CONSTRAINT `fk_tmna_user` FOREIGN KEY (`user_id`) REFERENCES `user_credentials` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=99 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `training_milestones` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `code` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name_en` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name_ar` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `description_en` text COLLATE utf8mb4_unicode_ci,
  `description_ar` text COLLATE utf8mb4_unicode_ci,
  `sort_order` int NOT NULL DEFAULT '0',
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `created_by` bigint DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `code` (`code`),
  KEY `fk_milestone_creator` (`created_by`),
  CONSTRAINT `fk_milestone_creator` FOREIGN KEY (`created_by`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=52 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Admin-defined curriculum milestones -- not hardcoded in application code.';
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `user_credentials` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `member_code` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `password_hash` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `role` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `status` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'active',
  `must_change_password` tinyint(1) NOT NULL DEFAULT '1',
  `last_login_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `member_code` (`member_code`),
  KEY `idx_user_credentials_role_status` (`role`,`status`),
  CONSTRAINT `user_credentials_chk_1` CHECK ((`role` in (_utf8mb4'trainee',_utf8mb4'supervisor',_utf8mb4'admin',_utf8mb4'designer'))),
  CONSTRAINT `user_credentials_chk_2` CHECK ((`status` in (_utf8mb4'active',_utf8mb4'suspended')))
) ENGINE=InnoDB AUTO_INCREMENT=6231 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Single auth table for every role. Login always starts here; role determines which profile table (admin_users/supervisors/students/designers) to join.';
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `videos` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `supervisor_id` bigint NOT NULL,
  `student_id` bigint DEFAULT NULL,
  `session_id` bigint DEFAULT NULL,
  `title` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` text COLLATE utf8mb4_unicode_ci,
  `filename` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `external_url` varchar(2048) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `thumbnail_filename` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `duration_seconds` int DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `fk_video_student` (`student_id`),
  KEY `fk_video_session` (`session_id`),
  KEY `idx_videos_supervisor` (`supervisor_id`,`created_at` DESC),
  CONSTRAINT `fk_video_session` FOREIGN KEY (`session_id`) REFERENCES `sessions` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_video_student` FOREIGN KEY (`student_id`) REFERENCES `students` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_video_supervisor` FOREIGN KEY (`supervisor_id`) REFERENCES `supervisors` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `chk_video_has_file` CHECK (((`filename` is not null) or (`external_url` is not null))),
  CONSTRAINT `videos_chk_1` CHECK (((`duration_seconds` is null) or (`duration_seconds` >= 0)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Distinct from learning_materials: purpose-built for session recordings and lecture video, with duration/thumbnail metadata a generic file share does not need.';
/*!40101 SET character_set_client = @saved_cs_client */;
