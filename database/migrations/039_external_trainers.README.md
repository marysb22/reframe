# Migration 039: External Trainers

Requires migration 038 (Guest Trainers). Changes nothing that 038 created.

Files:
- `039_external_trainers.sql`: the migration, with STEP 0 pre-flight checks and STEP 3 verification.
- `039_external_trainers.rollback.sql`: lossless only before any External Trainer data exists.
- `../reframe_mhs_schema.CURRENT.sql`: re-taken from the dev database after applying the migration.

## Three independent provider kinds

| Kind | Who | Stored in | On a Group roster? | Managed by |
|---|---|---|---|---|
| Internal Trainer | A Reframe trainer account: the Group's Master Trainer/ToT, or another Group's trainer linked as a Guest | `provided_by_supervisor_id` (migration 035) | Yes | Admin |
| Guest Trainer | A person on the Group's Guest Trainers list, plus Guest's own session-only records | `provided_by_guest_trainer_id` (038) | Yes (`group_guest_trainers`) | Master Trainer / Admin |
| **External Trainer** | Someone from outside the organization, recorded on a session | `provided_by_external_trainer_id` (039) | **No, never** | Recorded by whoever logs the session; edited by the Master Trainer / Admin |

The application enforces that at most one of the three is set on any session row. No hour is ever credited to the session's creator when a Guest or External Trainer delivered it.

## Objects introduced

### `external_trainers` (new table)
Same shape and normalization rules as `guest_trainers`, kept in a separate table so the two kinds can never be mixed or counted against each other.

| Column | Notes |
|---|---|
| `full_name`, `name_key` | `name_key` is the normalized name (NFC, trimmed, whitespace-collapsed, lower-cased), used for duplicate detection |
| `organization`, `specialization`, `email`, `phone` | Optional details |
| `owner_group_id` | FK `trainer_groups`, SET NULL. Scopes the record to the Group it was entered for. |
| `created_by` | FK `user_credentials`, SET NULL |

- `UNIQUE (owner_group_id, name_key)`: the same person recorded twice for one Group reuses the same row, including under concurrent requests.
- `INDEX (owner_group_id, email)`: supports the same-email lookup.

### `provided_by_external_trainer_id` (new column on 5 tables)
Added to `sessions`, `session_occasions`, `session_series`, `tot_training_sessions` and `tot_session_occasions`:
- FK `external_trainers` **ON DELETE RESTRICT**: an External Trainer who has delivered a session can't be deleted, so that session's attribution can't silently revert to the creator.
- The application never deletes External Trainers.

## What stays unchanged
- `guest_trainers`, `group_guest_trainers`, every `provided_by_guest_trainer_id` value, and every `provided_by_supervisor_id` value.
- Every existing session row ends up with `provided_by_external_trainer_id = NULL`. Every query treats that exactly as before.
- STEP 3.3 must return 0.
- STEP 3.4 (the Guest counts) must match the same query run before the migration.

## Applying it
1. Take an authorized, verified backup of the target database. Don't assume dev and production are the same.
2. `SELECT DATABASE();`
3. STEP 0:
   - 0.2 must return 0 rows.
   - 0.3 must return 5 rows (migration 038 is present).
   - Also run the STEP 3.4 query now and keep its result.
4. STEP 1, then STEP 2.
5. STEP 3:
   - 3.1: 1 row.
   - 3.2: 5 rows.
   - 3.3: `0`.
   - 3.4: identical to before.
6. Deploy the matching application release. Code from before 039 also runs against this schema, because the change is purely additive.

## Rollback
Roll back the application code first, then run `039_external_trainers.rollback.sql`. Its STEP 0.2 must be all zeros.

If External Trainer data already exists, the rollback erases those trainers and the attribution of every session they delivered. In that case, export the data and decide on attribution with the program owner first.

The rollback does not touch Guest Trainers.

## Status
- Applied to **local dev only** (`127.0.0.1` / `reframe_dev`), after a `mysqldump` backup.
- **Not applied to production.**
