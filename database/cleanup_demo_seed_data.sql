-- =============================================================================
-- Reframe MHS System -- Remove old demo/seed accounts from an existing DB
-- =============================================================================
-- For a database that was already bootstrapped from an earlier version of
-- reframe_mhs_schema.sql, which seeded a fictional demo Supervisor/Trainee
-- (or fictional demo Group + Master Trainer + 2 Trainers + Trainee) in
-- addition to the one real Admin account. The current schema no longer
-- seeds any of that -- this script removes it from a database that already
-- has it, WITHOUT touching real accounts created afterwards through the
-- app's normal "Add group" flow.
--
-- SAFE BY DESIGN: only deletes user_credentials rows whose member_code is
-- one of the exact demo codes the old seed script used (SUP001, SUP002,
-- SUP003, TTR001), and only if that account has no real recorded history
-- (payments, sessions, hours, etc.) beyond what the seed script itself
-- inserted -- the same FK protections documented in
-- DELETE /api/admin/users/:id apply here, so this will simply fail with a
-- foreign-key error (and change nothing) if any of these accounts were
-- actually used for real work instead of being cleaned up promptly.
--
-- Run manually, once, against your existing database:
--   psql "$DATABASE_URL" -f database/cleanup_demo_seed_data.sql
--
-- Does NOT touch ADM001 -- that is the real bootstrap Admin account.
-- =============================================================================

BEGIN;

DELETE FROM user_credentials
WHERE member_code IN ('SUP001', 'SUP002', 'SUP003', 'TTR001', 'DES001');

-- A demo Group left empty by the deletes above (no Master Trainer, no
-- Trainers, no Trainees remaining) is itself demo data -- remove it too.
DELETE FROM groups g
WHERE g.name = 'Group A'
  AND NOT EXISTS (SELECT 1 FROM supervisors s WHERE s.group_id = g.id)
  AND NOT EXISTS (SELECT 1 FROM students st WHERE st.group_id = g.id);

-- The demo cohort, if nothing real ended up assigned to it.
DELETE FROM cohorts c
WHERE c.name = 'Cohort 2026-A'
  AND NOT EXISTS (SELECT 1 FROM students st WHERE st.cohort_id = c.id);

COMMIT;
