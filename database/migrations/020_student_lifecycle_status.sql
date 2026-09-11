-- Adds a manually-set training lifecycle status to a Trainee, replacing the
-- previous per-trainee "Completion" figure (an assignment-completion
-- percentage that was misleading as a lifecycle indicator) with an explicit
-- administrative field. Named `lifecycle_status` (not `status`) to avoid
-- colliding with the existing, unrelated user_credentials.status (account
-- active/suspended) and the existing, unrelated computed `trainingStatus`
-- timeline concept (scheduled/active/completed, from trainingTimeline.js) --
-- neither of those changes. Only Admin/Master Trainer may set this (see
-- PATCH /admin/students/:id/status and PATCH /master-trainer/trainees/:id/status).
--
-- Purely additive: one new column, defaulted so every existing trainee
-- starts 'active' with zero data loss.

ALTER TABLE students
  ADD COLUMN lifecycle_status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (lifecycle_status IN ('active', 'inactive', 'on_hold', 'withdrawn', 'in_progress', 'completed'));
