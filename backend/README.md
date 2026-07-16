# Reframe MHS — Backend

Node.js + Express + SQLite backend for the login/profile/admin system. Matches
the endpoints your existing `login.html` and `profile.html` already call.

## 1. Setup

```bash
cd reframe-backend
npm install
cp .env.example .env
```

Open `.env` and set:
- `JWT_SECRET` — a long random string (`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`)
- `SEED_ADMIN_PASSWORD` — the password for the very first admin account
- `ID_PREFIX` — defaults to `TTR` (change if you want a different prefix)

## 2. Create the database + first admin

```bash
npm run seed:admin
```

This creates the SQLite file at `db/reframe.sqlite` (auto-created, tables
included) and one admin account using `SEED_ADMIN_ID` / `SEED_ADMIN_PASSWORD`
from `.env`. You need this first admin to log in and start creating everyone
else — there's no public sign-up, matching your login page's "Accounts are
issued by program administration" note.

## 3. Run the server

```bash
npm start        # production
npm run dev       # auto-restarts on file changes
```

Server listens on `http://localhost:3000` (or `PORT` from `.env`).

Point your frontend's `API_BASE` / `API` constants at this URL — they
already are, in the two HTML files you shared.

## How user IDs work

Every new account gets the next sequential code (`TTR001`, `TTR002`,
`TTR003`, ...) generated inside `src/utils/idGenerator.js`. The last-used
number is stored in the `id_counters` table and incremented inside a single
database transaction, so it's safe even if two admins create users at the
exact same moment — no collisions, no gaps skipped. There's no upper limit:
once you pass `TTR999` it just continues as `TTR1000`, `TTR1001`, etc.

## Database structure

| Table | Purpose |
|---|---|
| `users` | One row per account (trainee/supervisor/admin). Stores `member_code` (the login ID), `password_hash`, role, status, and all profile fields. |
| `id_counters` | One row per ID prefix, tracking the last number issued. |
| `user_supervisors` | Many-to-many link between trainees and supervisors. |
| `activity_log` | Simple audit trail shown on the profile page. |

Passwords are never stored in plain text — they're hashed with bcrypt
(12 salt rounds) before being written to `password_hash`.

## API reference

All endpoints except `/api/auth/login` and `/api/health` require
`Authorization: Bearer <token>`.

### Auth
| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/api/auth/login` | `{ username, password }` | `username` is the member code, e.g. `TTR001`. Returns `{ token, user }`. |

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
| POST | `/api/admin/users` | `{ full_name, email?, role?, cohort?, currentYear?, tempPassword? }` | Auto-generates the next member code. Returns the temp password **once** — save it, it can't be retrieved again. |
| GET | `/api/admin/users?search=&role=&status=&page=&pageSize=` | — | Paginated list. |
| GET | `/api/admin/users/:id` | — | Full profile for one user. |
| PUT | `/api/admin/users/:id` | `{ cohort?, currentYear?, role?, status?, supervisorIds? }` | Admin-only fields (a user can't change their own role/cohort). |
| POST | `/api/admin/users/:id/reset-password` | — | Issues and returns a new temp password; forces change on next login. |
| DELETE | `/api/admin/users/:id` | — | Soft delete — sets status to `suspended`, keeps history and the ID reserved (never reused). |

## New account flow

1. Admin calls `POST /api/admin/users` with the new person's name (and
   optionally email/cohort/year).
2. The response includes the generated ID (`TTR004`) and a one-time temp
   password — give these to the person however you normally distribute
   credentials.
3. They log in with that ID + temp password. `must_change_password` is
   `true`, so your frontend should prompt them to call
   `POST /api/profile/change-password` before letting them continue
   (the `login.html` you shared already has a comment marking where to add
   this redirect).

## Next steps you may want

- **Rate limiting** on `/api/auth/login` (e.g. `express-rate-limit`) to slow
  down password-guessing.
- **HTTPS** in production — JWTs and passwords must never travel over plain HTTP.
- **Email delivery** for temp passwords instead of returning them directly
  in the API response, if admins shouldn't see raw passwords either.
- A **build-your-own admin UI** page (the frontend you shared only has the
  end-user profile page, not an admin dashboard) — happy to help build that
  next if useful.
