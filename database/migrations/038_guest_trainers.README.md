# Migration 038: Guest Trainers

Files:
- `038_guest_trainers.sql`: the migration, with pre-flight (STEP 0) and post-migration (STEP 3) checks built in.
- `038_guest_trainers.rollback.sql`: the rollback. It is lossless only before any guest data exists; see below.
- `../reframe_mhs_schema.CURRENT.sql`: the schema reference. The 7 affected tables were re-taken from the dev database after this migration was applied there.

## What it models

The application keeps four relationships separate. None of them replaces another:

| Relationship | Where it is stored | Changed by 038? |
|---|---|---|
| Who created or entered the session | `supervisor_id` / `master_trainer_id` on each session table | No |
| Who actually delivered it | `provided_by_supervisor_id` (internal, migration 035) **or** `provided_by_guest_trainer_id` (external, new) | New column |
| Who is responsible for the Group | `supervisors.group_id` + `supervisor_type = 'primary'` | No |
| Who is associated with the Group as a Guest Trainer | `group_guest_trainers` | New table |

## Objects introduced

### `guest_trainers` (new table)
One row per external trainer. These people have no `user_credentials` row and cannot log in.

| Column | Type | Notes |
|---|---|---|
| `id` | BIGINT PK | |
| `full_name` | VARCHAR(255) NOT NULL | Trimmed, whitespace-collapsed, NFC-normalized (Arabic and Latin alike) |
| `name_key` | VARCHAR(255) NOT NULL | Lower-cased normalized name, used for duplicate detection |
| `email` | VARCHAR(255) NULL | Lower-cased; validated by the app |
| `phone`, `organization`, `specialization` | NULL | Optional details |
| `owner_group_id` | BIGINT NULL, FK `trainer_groups` ON DELETE SET NULL | The Group the record was entered for. Only that Group can reuse or edit it; other Groups never see it. |
| `created_by` | BIGINT NULL, FK `user_credentials` ON DELETE SET NULL | Audit only |
| `created_at`, `updated_at` | DATETIME | |

- `UNIQUE (owner_group_id, name_key)`: the same person entered twice for one Group resolves to one row, even under concurrent requests.
- `INDEX (owner_group_id, email)`: supports the same-email duplicate lookup.

### `group_guest_trainers` (new table)
Associates a guest with a Group (use case A). Each row sets exactly one of:
- `guest_trainer_id` (FK `guest_trainers`, CASCADE): an external person.
- `supervisor_id` (FK `supervisors`, CASCADE): an existing Reframe trainer from another Group.

The application enforces "exactly one". A CHECK constraint is not possible here: MySQL rejects a CHECK on columns that have FK referential actions (error 3823), and production runs MariaDB, which handles CHECK differently.

Other columns and constraints:
- `group_id`: FK `trainer_groups`, CASCADE.
- `added_by`: FK `user_credentials`, SET NULL.
- `UNIQUE (group_id, guest_trainer_id)` and `UNIQUE (group_id, supervisor_id)`: prevent duplicate associations. Multiple NULLs are allowed, so the unused column of each row never collides.

An association grants no access of any kind. It only makes the person selectable as "Hours Provided By" on that Group's sessions.

### `provided_by_guest_trainer_id` (new column on 5 tables)
Added to `sessions`, `session_occasions`, `session_series`, `tot_training_sessions` and `tot_session_occasions`:
- BIGINT NULL, FK `guest_trainers` **ON DELETE RESTRICT**.
- The FK automatically creates one index per table.
- RESTRICT is deliberate. If a guest row could be deleted, the column would become NULL, and migration 035's `COALESCE(provided_by_supervisor_id, creator)` would then silently re-credit the hours to the creator. The application never deletes guest rows.
- At most one of `provided_by_supervisor_id` / `provided_by_guest_trainer_id` is set on any row. `src/utils/guestTrainers.js` and `src/utils/groupSessions.js` enforce this; they are the only write paths.
- Every hours and attribution query now reads the internal provider as `IF(provided_by_guest_trainer_id IS NULL, COALESCE(provided_by_supervisor_id, creator), NULL)`.

## Records and relationships that must stay unchanged

The migration only adds. It changes no data:
- Every existing session row ends up with `provided_by_guest_trainer_id = NULL`. Every query treats that exactly as before, so no trainee, ToT or Master Trainer total changes. STEP 3.3 verifies this (result must be 0).
- No change to: `supervisors` (roles, `group_id`, `primary_supervisor_id`), `students`, `supervisor_students` (caseloads), `user_credentials`, `attendance`, `tot_training_attendance`, `training_hours`, `supervision_hours`, the adjustment ledgers, `hour_types`, or any existing column or constraint.
- `provided_by_supervisor_id` values from migration 035 are untouched.

## Applying it safely

1. Do this only on the database you intend to change, and only after an authorized, verified backup of that database. **Do not assume the dev database is production**; schemas have drifted before (see migration 033).
2. Confirm the target: `SELECT DATABASE();`
3. Run STEP 0 from `038_guest_trainers.sql`:
   - 0.2 must return 0 rows.
   - 0.3 must return 5 rows. If it doesn't, migration 035 hasn't been applied; stop.
4. Run STEP 1 and STEP 2. Through phpMyAdmin, run them as one SQL import, or statement by statement.
5. Run STEP 3. Expected results: 2 rows, then 5 rows, then `0`.
6. Deploy the application release that includes Guest Trainers. The old application code also runs against the migrated schema: the change is additive and old code never writes the new columns.

## Rollback

- **Before any guest data exists:** first roll back the application code, then run `038_guest_trainers.rollback.sql`. Its STEP 0.2 must return all zeros.
- **After guest data exists:** the rollback permanently deletes every Guest Trainer, every association, and the delivery attribution of every guest-delivered session. Those sessions would then be credited to their creators, inflating the creators' totals. Instead:
  - export `guest_trainers`, `group_guest_trainers`, and all session rows where `provided_by_guest_trainer_id IS NOT NULL`;
  - decide with the program owner how those sessions should be attributed;
  - only then roll back.
- Restoring from the pre-migration backup is the only lossless way back, and it also discards everything else recorded since the backup.

## Status

- Applied to **local dev only** (`127.0.0.1` / `reframe_dev`), after a `mysqldump` backup.
- **Not applied to production.**
