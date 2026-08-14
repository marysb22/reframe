# Reframe MHS — Backend

Node.js + Express + SQLite backend for the login/profile/admin system. Matches
the endpoints `login.html`, `PersonalProfile.html`, `admin-dashboard.html`,
and `master-trainer-dashboard.html` call.

## Roles & the Group hierarchy

Three account types share the `users` table, distinguished by `role`:

- **`trainer`** — the person going through the program (ID prefix `TRN`).
- **`master_trainer`** — an account that can be assigned to Groups, either
  as the Group's one **Master Trainer** or as one of its two **Trainers in
  Training (TOT)** (ID prefix `MT`).
- **`admin`** — full program administration. Seeded once via `npm run seed:admin`.

Every **Group** has exactly one Master Trainer and exactly two Trainers in
Training, all working with the same set of Trainers. A `master_trainer`
account's role is per-Group — the same person can be the Master Trainer on
one Group and a TOT on another — so it's stored on the assignment
(`group_leadership.role`), not on the account itself. See `GET/PUT
/api/admin/groups/:id/leadership` below.

A Trainer's caseload of Master Trainers is the union of two independent
paths: a direct self-service link (`trainer_master_trainers`, created when a
Master Trainer "assigns a trainer by ID") and Group membership
(`users.group_id` + `group_leadership`). Either path is enough to be
"assigned" to a Trainer for the purposes of logging records, messaging, etc.

## 1. Setup

```bash
cd backend
npm install
cp .env.example .env
```

Open `.env` and set:
- `JWT_SECRET` — a long random string (`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`)
- `SEED_ADMIN_PASSWORD` — the password for the very first admin account
- `ID_PREFIX` — used only as a fallback prefix; Trainer/Master Trainer IDs
  auto-generate as `TRN001.../MT001...` regardless of this setting.

## 2. Create the database + first admin

```bash
npm run seed:admin
```

This creates the SQLite file at `db/reframe.sqlite` (auto-created, tables
included) and one admin account using `SEED_ADMIN_ID` / `SEED_ADMIN_PASSWORD`
from `.env`. You need this first admin to log in and start creating everyone
else — there's no public sign-up, matching the login page's "Accounts are
issued by program administration" note.

If `db/reframe.sqlite` already exists from before the Group hierarchy
feature (role values `trainee`/`supervisor`, tables `student_records`/
`user_supervisors`), the very first boot automatically migrates it in place
to the current shape — see the top of `db/index.js`. No data is lost.

## 3. Run the server

```bash
npm start        # production
npm run dev       # auto-restarts on file changes
```

Server listens on `http://localhost:3000` (or `PORT` from `.env`).

## How user IDs work

Every new account gets the next sequential code for its role (`TRN001`,
`TRN002`, ... for Trainers; `MT001`, `MT002`, ... for Master Trainers)
generated inside `src/utils/idGenerator.js`. The last-used number per prefix
is stored in the `id_counters` table and incremented inside a single
database transaction, so it's safe even if two admins create users at the
exact same moment — no collisions, no gaps skipped.

## Database structure

| Table | Purpose |
|---|---|
| `users` | One row per account (trainer/master_trainer/admin). Stores `member_code` (the login ID), `password_hash`, role, status, all profile fields, and `group_id` (a Trainer's Group, if any). |
| `id_counters` | One row per ID prefix, tracking the last number issued. |
| `groups` | A Group of Trainers under a 3-person Master Trainer / TOT leadership team. |
| `group_leadership` | Which `master_trainer` account fills the `'master'` or `'tot'` seat on a Group. A partial unique index guarantees at most one `'master'` row per Group. |
| `trainer_master_trainers` | Many-to-many direct/self-service link between Trainers and Master Trainers, independent of any Group. |
| `trainer_records` | Attendance, sessions, clinical hours, assignments, notes, and evaluations a Master Trainer logs for a Trainer. |
| `documents` | Files a Master Trainer uploads for a specific Trainer. |
| `activity_log` | Simple audit trail shown on the profile page. |

Passwords are never stored in plain text — they're hashed with bcrypt
(12 salt rounds) before being written to `password_hash`.

## API reference

All endpoints except `/api/auth/login` and `/api/health` require
`Authorization: Bearer <token>`.

### Auth
| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/api/auth/login` | `{ username, password }` | `username` is the member code, e.g. `TRN001`. Returns `{ token, user }`. |

### Profile (self-service, any logged-in user)
| Method | Path | Body |
|---|---|---|
| GET | `/api/profile/me` | — |
| PUT | `/api/profile/me` | `{ full_name, email, gender, dateOfBirth, maritalStatus, phone, address, highestDegree, institution, certifications }` |
| POST | `/api/profile/change-password` | `{ currentPassword, newPassword }` |
| POST | `/api/profile/photo` | multipart, field `photo` |
| POST | `/api/profile/cv` | multipart, field `cv` (PDF only) |
| GET | `/api/profile/activity` | — recent account activity |

### Admin (requires `role: admin`)
| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/api/admin/users` | `{ full_name, email?, role?, cohort?, currentYear?, tempPassword? }` | `role` is `trainer` or `master_trainer`. Auto-generates the next member code. Returns the temp password **once**. |
| GET | `/api/admin/users?search=&role=&status=&page=&pageSize=` | — | Paginated list. |
| GET | `/api/admin/users/:id` | — | Full profile for one user. |
| PUT | `/api/admin/users/:id` | `{ cohort?, currentYear?, role?, status?, masterTrainerIds?, groupId? }` | Admin-only fields. |
| PATCH | `/api/admin/users/:id/status` | `{ status }` | `'active'` or `'suspended'`. |
| POST | `/api/admin/users/:id/reset-password` | — | Issues and returns a new temp password; forces change on next login. |
| DELETE | `/api/admin/users/:id?force=true` | — | A Trainer with no history deletes outright; a Trainer with history needs `?force=true` (409 otherwise). A Master Trainer/Admin is always just suspended, never hard-deleted. |
| GET | `/api/admin/trainers/:id/profile` | — | Full profile + records + documents + payments for one Trainer. |
| DELETE | `/api/admin/documents/:id` | — | Deletes a document row and its file. |

### Groups (requires `role: admin`)
| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/api/admin/groups` | — | Every Group with its current leadership + Trainer count. |
| POST | `/api/admin/groups` | `{ name }` | Create a Group (no hierarchy yet). |
| GET / PUT / DELETE | `/api/admin/groups/:id` | `{ name }` on PUT | Read, rename, or delete a Group. |
| PUT | `/api/admin/groups/:id/leadership` | `{ masterTrainerId, totIds: [id, id] }` | Atomically sets the 3-person hierarchy. Rejects anything but exactly 1 Master Trainer + 2 distinct TOTs, all `master_trainer` accounts. |
| PUT | `/api/admin/groups/:id/trainers` | `{ trainerIds: [...] }` | Replaces the Group's Trainer roster (a Trainer belongs to at most one Group). |

### Master Trainer (requires `role: master_trainer` or `admin`)
Mounted at `/api/master-trainer`. Mirrors the old per-Trainer endpoints
(`/trainers`, `/trainers/:trainerId/records`, `/materials`,
`/announcements`, `/schedule`, `/activity`, ...) plus:

| Method | Path | Notes |
|---|---|---|
| GET | `/api/master-trainer/groups` | Every Group this account is part of, `myRole` (`'master'`/`'tot'`), the Group's other leadership seats, and its Trainer roster. |

## New account flow

1. Admin calls `POST /api/admin/users` with the new person's name, role,
   and (optionally) email/cohort/year.
2. The response includes the generated ID (`TRN004` / `MT004`) and a
   one-time temp password — give these to the person however you normally
   distribute credentials.
3. They log in with that ID + temp password. `must_change_password` is
   `true`, so the frontend prompts them to call
   `POST /api/profile/change-password` before continuing.
4. For a `master_trainer` account, an admin assigns them to a Group's
   Master Trainer or TOT seat from the Groups section of the admin
   dashboard.

## Next steps you may want

- **Rate limiting** on `/api/auth/login` (e.g. `express-rate-limit`) to slow
  down password-guessing.
- **HTTPS** in production — JWTs and passwords must never travel over plain HTTP.
- **Email delivery** for temp passwords instead of returning them directly
  in the API response, if admins shouldn't see raw passwords either.
- A **Meetings** table + routes — the Master Trainer dashboard's Meetings
  section is already built against `/api/master-trainer/meetings`, which
  doesn't exist in the schema yet.
