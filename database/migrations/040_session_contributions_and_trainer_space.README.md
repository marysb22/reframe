# Migration 040: Several trainers per day, trainer titles, private Trainer Space

Requires migrations 035 (session providers), 038 (Guest Trainers) and 039 (External Trainers), plus `tot_session_occasions`. STEP 0.3 checks for them and stops you if one is missing.

Files:
- `040_session_contributions_and_trainer_space.sql`: the migration. STEP 0 is pre-flight checks, STEPs 1–3 make the changes, STEP 4 verifies them.
- `040_session_contributions_and_trainer_space.rollback.sql`: undoes the migration. See "Rollback" below for what it loses.

## Apply order

1. Take a verified backup of the target database.
2. Run STEP 0 and read every result. 0.2 must say 040 is not applied yet. 0.3 must list all prerequisites. Write down the count 0.4 gives you.
3. Run STEPs 1–3.
4. Run STEP 4. 4.3 must equal the count from 0.4.
5. **Only then** deploy the backend and dashboards. The new code reads `session_contributions`, `trainer_titles` and `learning_materials.visibility`, so deploying it before the migration fails on every session, hours and materials query. That is the same failure 039 caused when the code went out first.

Never import a local schema dump into production in place of this migration.

## What it adds

### `trainer_titles` (new table)
Professional titles shown next to a trainer's name on a training day: Master Trainer, Trainer, ToT, Guest Trainer, External Trainer. Admins manage the list in Admin > Trainer Titles: add, rename, deactivate.

A title is a label. It grants no permission. Permissions still come only from the account's role (`supervisors.supervisor_type`, admin flags). A person whose title says "Master Trainer" gets no Master Trainer access.

| Column | Notes |
|---|---|
| `code` | PK, a stable slug such as `master_trainer` |
| `label` | The displayed name, which can be renamed |
| `is_active` | New contributions can't pick an inactive title. Existing rows keep theirs. |
| `sort_order`, `created_at`, `updated_at` | |

### `session_contributions` (new table)
One row per trainer per training day: who delivered, under which title, and for how many minutes.

| Column | Notes |
|---|---|
| `occasion_id` / `session_id` / `tot_occasion_id` / `tot_session_id` | The parent. Exactly one is set: a Group Session day, a standalone session record, a Group ToT Session day, or a single ToT session. The parent FKs are `ON DELETE CASCADE`. |
| `supervisor_id` / `guest_trainer_id` / `external_trainer_id` | The provider. The application enforces exactly one. These FKs are `ON DELETE RESTRICT`, so deleting a trainer can't silently remove credited hours. |
| `title_code` | FK `trainer_titles(code)`, `ON UPDATE CASCADE ON DELETE RESTRICT` |
| `minutes` | `CHECK (minutes >= 0)`. The API also requires a whole number greater than 0. |
| `sort_order` | Display order. Row 0 is the day's lead trainer. |

There are 12 UNIQUE keys, one for each parent × provider pair. The same trainer can't be listed twice on the same day.

**Rules the code follows:**
- A day with **no** contribution rows is a legacy day. Its single provider is still read from the parent's `provided_by_*` columns (035/038/039), exactly as before. **No backfill is done.** No historical trainer assignment is guessed or invented.
- A day **with** contribution rows has duration = SUM(minutes). The parent's `provided_by_*` columns mirror the first contributor, so older screens keep working. Hours are credited **only** from the contribution rows, so a day is never counted twice.
- For a standalone session record with several trainers, each trainer is credited minutes × (attended share), the same way the legacy single-provider record was.

### `learning_materials` (3 new columns)
| Column | Notes |
|---|---|
| `visibility` | `'trainees'` (default, the existing behaviour) or `'training_team'` (private Trainer Space / Trainer Reports content) |
| `team_section` | `documents`, `materials`, `feedback` or `reports`. Set only for `training_team` items. |
| `updated_at` | Set when a Trainer Space item is edited |

The migration also adds an index `(visibility, group_id)` and CHECK constraints for both columns.

**Backfill (STEP 3):** existing materials that were already shared only with trainers (`group_id` or `shared_with_supervisor_id` set) are marked `visibility = 'training_team'`, `team_section = 'materials'`. On the original code, a trainee could download those files by URL. That leak was reproduced and is now closed. Every other material stays `'trainees'`, so no trainee loses access to anything they could legitimately see.

## Relationships

```
trainer_titles.code  <-- session_contributions.title_code
session_occasions / sessions / tot_session_occasions / tot_training_sessions
                     <-- session_contributions.(occasion_id | session_id | tot_occasion_id | tot_session_id)   [CASCADE]
supervisors / guest_trainers / external_trainers
                     <-- session_contributions.(supervisor_id | guest_trainer_id | external_trainer_id)       [RESTRICT]
learning_materials.visibility = 'training_team'  -> served only to trainers of the item's Group (or the one shared trainer) and to Admin
```

## Rollback

`040_..._rollback.sql` drops `session_contributions`, `trainer_titles` and the three `learning_materials` columns. It uses `DROP CONSTRAINT`, so it also runs on MariaDB. Roll the application code back **first**, and take a backup.

It is lossless only before the new features are used:
- **Multi-trainer days.** Its STEP 0.2 counts the contribution rows. If that count is not 0, export the table first. After rollback, each such day keeps its total duration and its first trainer in `provided_by_*`, so the old code credits the whole day to that first trainer.
- **Private items.** Its STEP 0.3 must be 0. That count is Trainer Space items with no Group and no recipient, which the old code would show to trainees.
- **File downloads.** The pre-040 file route let a trainee download a group-shared material by URL. Rolling back restores that known leak.

## Applied where

- Local development database: applied and verified. 0.4 = 0 trainer-only materials and 5 titles seeded.
- Production: **not applied.** Apply it yourself, following the order above.
