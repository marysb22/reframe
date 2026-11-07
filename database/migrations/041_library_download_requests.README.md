# Migration 041: Library download approval

Requires migration 040 (STEP 0.3 checks for it). Purely additive: one new table plus new `admin_permissions` rows. No existing column changes and no existing row is updated or deleted.

Files:
- `041_library_download_requests.sql`: the migration, using `DATABASE()`.
- `041_library_download_requests.phpmyadmin.sql`: the same statements with every table qualified as `u340416395_reframe_mhs.…`, for phpMyAdmin. Safe to re-run.
- `041_library_download_requests.rollback.sql`: drops the table and the permission rows. It **destroys the approval history**, so export the table first.

## Apply order

1. Take a verified backup of the target database.
2. Run STEP 0 and read every result:
   - 0.2 returns no row.
   - 0.3 returns one row.
   - Write down the 0.4 number.
3. Run STEP 1 and STEP 2.
4. Run STEP 3:
   - `table_exists = 1`
   - `admins_with_approve_downloads` = the 0.4 number
   - `requests = 0`
5. **Only then** deploy the code. The new code reads `library_download_requests` on every Library page load and every book-file request, so deploying before the table exists breaks the Library. That is the same failure 039 and 040 caused when the code went out first.

Never import a local schema dump into production in place of this migration.

## `library_download_requests`

One row per request. The application never deletes a row. A decided row is the audit record. Asking again after a rejection creates a **new** row and keeps the rejected one.

| Column | Meaning |
|---|---|
| `id` | Request id |
| `material_id` | FK → `learning_materials.id`, `ON DELETE SET NULL`. Becomes NULL if the book is removed, so the history survives. |
| `requested_material_id` | Immutable copy of the requested book id, with no FK. History still says which item was asked for after a removal. |
| `material_title`, `material_original_name` | Snapshot of the book title and file name when it was requested |
| `file_hash` | SHA-256 of the file when it was requested. An approval only serves a file whose current `learning_materials.file_hash` is equal. |
| `requester_id` | FK → `user_credentials.id`, `ON DELETE SET NULL` (the history outlives a deleted account) |
| `requester_name`, `requester_role` | Snapshot. Role is one of `trainee`, `tot`, `designer`. |
| `group_id` | FK → `trainer_groups.id`, `ON DELETE SET NULL`. The requester's Group when they asked, which decides which Master Trainer reviews. NULL means Admin-only. |
| `status` | `pending`, `approved`, `rejected` or `cancelled` (CHECK). `cancelled` is set only when the book is removed while the request is pending. |
| `reviewer_id`, `reviewer_name` | Who decided. `reviewer_id` is an FK to `user_credentials` with `ON DELETE SET NULL`. |
| `rejection_reason` | Optional, up to 500 characters, shown to the requester |
| `created_at`, `decided_at` | A CHECK enforces that `decided_at` is NULL exactly while the request is pending. |
| `pending_key` | Generated (VIRTUAL): equals `requested_material_id` while pending, otherwise NULL |

### Indexes

| Index | Purpose |
|---|---|
| `uniq_ldr_one_pending (requester_id, pending_key)` | **Duplicate prevention in the database.** One pending request per user per file, even under concurrent clicks. Decided rows have `pending_key` NULL and never collide. |
| `idx_ldr_requester_material` | Book list and file check: "does this user hold an approval for this file". |
| `idx_ldr_status_created`, `idx_ldr_group_status` | Reviewer lists and pending counts, for Admin and per Group. |
| `idx_ldr_material`, `idx_ldr_reviewer` | FK lookups. |

### Why the generated column is on `requested_material_id`

MySQL forbids `ON DELETE SET NULL` on the base column of a generated column. `material_id` needs SET NULL so the history survives a book removal. The uniqueness rule is therefore built on the immutable copy, which has no FK.

## `admin_permissions`: `library.approve_downloads`

A new granular Admin permission, listed in Admin > Library > Permissions as "Approve Download Requests". STEP 2 grants it to every Admin who **already** holds `library.view`, so the people who manage the Library today can review from day one. A new admin account still starts with nothing, as before.

## Rules the code enforces

These live in `backend/src/utils/libraryAccess.js` and are enforced on the bytes in `backend/src/routes/files.js`.

- Download without a request:
  - Admin
  - Master Trainer (`supervisor_type = 'primary'`)
  - The book's own uploader
- Everyone else (ToT, Trainee, Designer) needs an `approved` row with **their** `requester_id`, for **that** book, with a matching `file_hash`.
- Reviewers:
  - An Admin with `library.approve_downloads`, for any request.
  - A Master Trainer only for requests whose `group_id` equals their own Group.
- The first decision wins. The decision locks the row (`SELECT … FOR UPDATE`) and updates `WHERE status = 'pending'`. A second decision gets 409 and changes nothing.

## Backward compatibility

- Library browsing, covers, search and Add/Edit/Remove work as before.
- Admin and Master Trainer download as before. A ToT can always download the books they uploaded.
- **Behaviour change (intended):**
  - Trainees and ToTs can no longer open or download someone else's book without an approval.
  - This covers Download, Open & Read, the inline PDF/image/video reader and the Google Docs Viewer preview link.
  - Old copied `/uploads/materials/<file>?token=…` URLs are refused for them too. The check runs on every request, so an old link has no special standing.
- No existing data is touched. Nobody starts with an approval.

## Rollback

1. Roll the code back **first**. The old code ignores this table and lets every account download every book again.
2. Export `library_download_requests`. The rollback drops it, and the history is lost.
3. Run `041_library_download_requests.rollback.sql`.

## Applied where

- Local development database (`reframe_dev`, MySQL): applied and verified on 2026-11-07. 0.4 = 1, 3.2 = 1, 3.3 = 0.
- Production: **not applied.** Apply it yourself, following the order above.
- Not tested on MariaDB. The DDL uses features MariaDB 10.2+ supports: a VIRTUAL generated column with a UNIQUE index, CHECK constraints, and `INSERT IGNORE … SELECT` from the same table. Run STEP 0 and STEP 3 to confirm on the real server.
