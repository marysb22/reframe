-- Gives the Master Trainer real (not just read-only) Meetings/Documents/
-- Materials/Chat capability, scoped strictly to their own Group -- never
-- an arbitrary ToT, Group, or user elsewhere in the system. All additive:
-- new nullable columns/indexes only, no existing column altered, no
-- existing row touched.

-- meetings: today a meeting only ever has one owning supervisor_id plus an
-- optional student_id ("NULL = that supervisor's whole caseload"). Neither
-- expresses "this meeting is for a whole Group" or "this meeting is with
-- one specific ToT" (a Master Trainer/ToT meeting has no trainee at all).
-- Mirrors documents' existing student_id/group_id/shared_with_supervisor_id
-- three-way-exclusive pattern instead of overloading student_id further.
ALTER TABLE meetings
  ADD COLUMN target_group_id BIGINT NULL,
  ADD COLUMN target_supervisor_id BIGINT NULL,
  ADD CONSTRAINT fk_meetings_target_group FOREIGN KEY (target_group_id) REFERENCES trainer_groups(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_meetings_target_supervisor FOREIGN KEY (target_supervisor_id) REFERENCES supervisors(id) ON DELETE SET NULL,
  ADD INDEX idx_meetings_target_group (target_group_id),
  ADD INDEX idx_meetings_target_supervisor (target_supervisor_id);

-- learning_materials: had no group_id at all, and no way to target one
-- specific supervisor (only student_id, always a trainee). Adds the same
-- two columns documents already has for exactly this purpose.
ALTER TABLE learning_materials
  ADD COLUMN group_id BIGINT NULL,
  ADD COLUMN shared_with_supervisor_id BIGINT NULL,
  ADD CONSTRAINT fk_material_group FOREIGN KEY (group_id) REFERENCES trainer_groups(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_material_shared_supervisor FOREIGN KEY (shared_with_supervisor_id) REFERENCES supervisors(id) ON DELETE SET NULL,
  ADD INDEX idx_materials_group (group_id),
  ADD INDEX idx_materials_shared_supervisor (shared_with_supervisor_id);

-- chat_rooms: Direct Chat reuses this existing, already-generic (any
-- user_credentials pair) room/membership/message infrastructure instead of
-- extending the separate chats/messages tables, whose supervisor_id/
-- student_id columns are typed FKs that structurally cannot hold a
-- supervisor-to-supervisor (Master Trainer <-> ToT) pair. A "direct" room
-- is just an ordinary 2-member chat_rooms row with this flag set, found by
-- membership rather than a synthetic composite key.
ALTER TABLE chat_rooms
  ADD COLUMN is_direct BOOLEAN NOT NULL DEFAULT FALSE;
