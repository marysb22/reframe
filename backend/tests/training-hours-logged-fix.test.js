// "Training hours logged" (the top KPI strip, GET /supervisor/me/
// caseload-summary) used to sum every currently-assigned trainee's own
// attendance-derived hours -- which multiplies a Group Session's real
// duration by its attendee count (a 5h session with 17 trainees
// contributed 85 "hours", not 5). Business rule, explicit: this KPI must
// represent the actual DURATION of training/supervision delivered by this
// ToT -- a session's duration counts once, regardless of how many
// trainees attended it, and a multi-day Session's days sum once each.
//
// Fixed by reusing computeHoursByType's supervisorId branch (the same
// occasion/series-deduplicated formula "Training Delivery -- Total hours"
// already used) instead of a third hand-written, differently-scoped copy.
//
// Six scenarios, matching exactly what was requested:
//  1. One 5h session, 15 trainees present -> 5h, not 75.
//  2. One 5h session, 17 trainees present -> 5h, not 85.
//  3. Four 5h sessions, varying attendance -> 20h, not 315.
//  4. A 5-day x 5h Session -> 25h, not multiplied by trainee count.
//  5. Deleting a session decreases the total by exactly its own duration,
//     with zero orphaned rows left contributing.
//  6. The full existing regression suite (run via npm test alongside this file).
//
// Run: node tests/training-hours-logged-fix.test.js (dev server must be running)

const http = require("http");
const jwt = require("jsonwebtoken");
const path = require("path");
const cfg = require(path.join(__dirname, "..", "src", "config"));
const { pool } = require(path.join(__dirname, "..", "src", "db"));

const BASE = "http://localhost:3000/api";

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message}`);
  }
}
function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || "not equal"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function request(method, urlPath, token) {
  return new Promise((resolve, reject) => {
    const req = http.request(BASE + urlPath, { method, headers: { Authorization: `Bearer ${token}` } }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        let json = null;
        try {
          json = raw ? JSON.parse(raw) : null;
        } catch {}
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on("error", reject);
    req.end();
  });
}
function tokenFor(id, role) {
  return jwt.sign({ id, role }, cfg.jwtSecret, { expiresIn: "1h" });
}

let fx = { groupId: null, totId: null, studentIds: [], occasionIds: [], seriesId: null, seriesOccasionIds: [] };

async function precleanup() {
  await pool.query("DELETE FROM supervisors WHERE id IN (SELECT id FROM user_credentials WHERE member_code = 'ZZTTHLTOT')");
  await pool.query("DELETE FROM students WHERE id IN (SELECT id FROM user_credentials WHERE member_code LIKE 'ZZTTHL%')");
  await pool.query("DELETE FROM user_credentials WHERE member_code LIKE 'ZZTTHL%'");
  await pool.query("DELETE FROM trainer_groups WHERE name LIKE 'ZZTTHL%'");
}

async function setup() {
  await precleanup();
  const grp = await pool.query("INSERT INTO trainer_groups (name) VALUES ('ZZTTHL Group')");
  fx.groupId = grp.insertId;

  const cred = await pool.query(
    "INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES ('ZZTTHLTOT', 'x', 'supervisor', 'active')"
  );
  fx.totId = cred.insertId;
  await pool.query("INSERT INTO supervisors (id, full_name, supervisor_type, group_id) VALUES (?, 'ZZTTHL ToT', 'primary', ?)", [
    fx.totId,
    fx.groupId,
  ]);

  // 17 trainees -- enough to test both a 15-present and a 17-present occasion.
  for (let i = 1; i <= 17; i++) {
    const c = await pool.query(
      "INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES (?, 'x', 'trainee', 'active')",
      [`ZZTTHLS${i}`]
    );
    const id = c.insertId;
    fx.studentIds.push(id);
    await pool.query("INSERT INTO students (id, full_name, group_id) VALUES (?, ?, ?)", [id, `ZZTTHL Trainee ${i}`, fx.groupId]);
    await pool.query("INSERT INTO supervisor_students (supervisor_id, student_id) VALUES (?, ?)", [fx.totId, id]);
  }
}

async function mkOccasion({ title, dayOffset, durationMinutes, presentCount }) {
  const occ = await pool.query(
    "INSERT INTO session_occasions (supervisor_id, session_type, title, session_date, duration_minutes) VALUES (?, 'training', ?, DATE_SUB(CURDATE(), INTERVAL ? DAY), ?)",
    [fx.totId, title, dayOffset, durationMinutes]
  );
  const statuses = [...Array(presentCount).fill("present"), ...Array(17 - presentCount).fill("absent")];
  for (let i = 0; i < 17; i++) {
    const s = await pool.query(
      "INSERT INTO sessions (student_id, supervisor_id, session_type, session_date, duration_minutes, status, occasion_id) VALUES (?, ?, 'training', DATE_SUB(CURDATE(), INTERVAL ? DAY), ?, 'completed', ?)",
      [fx.studentIds[i], fx.totId, dayOffset, durationMinutes, occ.insertId]
    );
    await pool.query(
      "INSERT INTO attendance (student_id, supervisor_id, session_id, attendance_date, status, recorded_by) VALUES (?, ?, ?, DATE_SUB(CURDATE(), INTERVAL ? DAY), ?, ?)",
      [fx.studentIds[i], fx.totId, s.insertId, dayOffset, statuses[i], fx.totId]
    );
  }
  return occ.insertId;
}

async function teardown() {
  const inList = fx.studentIds.map(() => "?").join(",");
  if (fx.studentIds.length) {
    await pool.query(`DELETE FROM attendance WHERE student_id IN (${inList})`, fx.studentIds);
    await pool.query(`DELETE FROM sessions WHERE student_id IN (${inList})`, fx.studentIds);
  }
  await pool.query("DELETE FROM session_occasions WHERE supervisor_id = ?", [fx.totId]);
  await pool.query("DELETE FROM session_series WHERE supervisor_id = ?", [fx.totId]);
  if (fx.studentIds.length) {
    await pool.query(`DELETE FROM supervisor_students WHERE student_id IN (${inList})`, fx.studentIds);
    await pool.query(`DELETE FROM students WHERE id IN (${inList})`, fx.studentIds);
    await pool.query(`DELETE FROM user_credentials WHERE id IN (${inList})`, fx.studentIds);
  }
  if (fx.totId) {
    await pool.query("DELETE FROM supervisors WHERE id = ?", [fx.totId]);
    await pool.query("DELETE FROM user_credentials WHERE id = ?", [fx.totId]);
  }
  if (fx.groupId) await pool.query("DELETE FROM trainer_groups WHERE id = ?", [fx.groupId]);
}

async function run() {
  console.log("Setting up isolated ZZTTHL fixtures...");
  await setup();

  try {
    const token = tokenFor(fx.totId, "supervisor");

    console.log("\n[Test 1] One 5h session, 15 trainees present -> 5h, not 75");
    const occ1 = await mkOccasion({ title: "ZZTTHL Session A", dayOffset: 30, durationMinutes: 300, presentCount: 15 });
    await test("totalHours = 5", async () => {
      const r = await request("GET", "/supervisor/me/caseload-summary", token);
      assertEqual(r.status, 200, "status");
      assertEqual(r.body.totalHours, 5, "totalHours");
    });

    console.log("\n[Test 2] Add a second 5h session, 17 trainees present -> total 10h (5+5), not 90 (5+85)");
    const occ2 = await mkOccasion({ title: "ZZTTHL Session B", dayOffset: 29, durationMinutes: 300, presentCount: 17 });
    await test("totalHours = 10", async () => {
      const r = await request("GET", "/supervisor/me/caseload-summary", token);
      assertEqual(r.status, 200, "status");
      assertEqual(r.body.totalHours, 10, "totalHours");
    });

    console.log("\n[Test 3] Two more 5h sessions (varying attendance) -> 20h total, not 315");
    const occ3 = await mkOccasion({ title: "ZZTTHL Session C", dayOffset: 28, durationMinutes: 300, presentCount: 16 });
    const occ4 = await mkOccasion({ title: "ZZTTHL Session D", dayOffset: 27, durationMinutes: 300, presentCount: 12 });
    await test("totalHours = 20 (4 x 5h), regardless of attendance counts (15+17+16+12)", async () => {
      const r = await request("GET", "/supervisor/me/caseload-summary", token);
      assertEqual(r.status, 200, "status");
      assertEqual(r.body.totalHours, 20, "totalHours");
    });

    console.log("\n[Test 4] Add a 5-day x 5h Session -> total becomes 45h (20+25), not multiplied by trainee count");
    const series = await pool.query(
      "INSERT INTO session_series (supervisor_id, session_type, title) VALUES (?, 'training', 'ZZTTHL Multi-day')",
      [fx.totId]
    );
    fx.seriesId = series.insertId;
    for (let day = 0; day < 5; day++) {
      const occ = await pool.query(
        "INSERT INTO session_occasions (supervisor_id, session_type, title, session_date, duration_minutes, series_id) VALUES (?, 'training', ?, DATE_ADD(CURDATE(), INTERVAL ? DAY), 300, ?)",
        [fx.totId, `ZZTTHL Multi-day Day ${day + 1}`, day, fx.seriesId]
      );
      fx.seriesOccasionIds.push(occ.insertId);
      for (let i = 0; i < 17; i++) {
        const s = await pool.query(
          "INSERT INTO sessions (student_id, supervisor_id, session_type, session_date, duration_minutes, status, occasion_id) VALUES (?, ?, 'training', DATE_ADD(CURDATE(), INTERVAL ? DAY), 300, 'completed', ?)",
          [fx.studentIds[i], fx.totId, day, occ.insertId]
        );
        await pool.query(
          "INSERT INTO attendance (student_id, supervisor_id, session_id, attendance_date, status, recorded_by) VALUES (?, ?, ?, DATE_ADD(CURDATE(), INTERVAL ? DAY), 'present', ?)",
          [fx.studentIds[i], fx.totId, s.insertId, day, fx.totId]
        );
      }
    }
    await test("totalHours = 45 (20 standalone + 25 from the 5-day Session, not x17)", async () => {
      const r = await request("GET", "/supervisor/me/caseload-summary", token);
      assertEqual(r.status, 200, "status");
      assertEqual(r.body.totalHours, 45, "totalHours");
    });
    await test("Training Delivery's own totalHours (55h scenario's analog) agrees: also 45h -- single source of truth", async () => {
      const r = await request("GET", "/supervisor/me/training-delivered", token);
      assertEqual(r.status, 200, "status");
      assertEqual(r.body.totalHours, 45, "totalHours");
    });

    console.log("\n[Test 5] Delete one standalone session -> total drops by exactly its own duration (5h), no orphans");
    await test("delete Session D (occ4, 5h)", async () => {
      const r = await request("DELETE", `/supervisor/session-occasions/${occ4}`, token);
      assertEqual(r.status, 200, "status");
    });
    await test("totalHours drops from 45 to 40, exactly -5h", async () => {
      const r = await request("GET", "/supervisor/me/caseload-summary", token);
      assertEqual(r.status, 200, "status");
      assertEqual(r.body.totalHours, 40, "totalHours");
    });
    await test("zero orphaned attendance/sessions rows remain for the deleted occasion", async () => {
      const { rows: orphanAttendance } = await pool.query(
        "SELECT COUNT(*) c FROM attendance WHERE session_id IN (SELECT id FROM sessions WHERE occasion_id = ?)",
        [occ4]
      );
      assertEqual(Number(orphanAttendance[0].c), 0, "orphaned attendance");
      const { rows: orphanSessions } = await pool.query("SELECT COUNT(*) c FROM sessions WHERE occasion_id = ?", [occ4]);
      assertEqual(Number(orphanSessions[0].c), 0, "orphaned sessions");
    });

    console.log("\n[Test 5b] Delete the 5-day Session -> total drops by exactly 25h (back to 15: the 3 remaining standalone)");
    await test("delete the multi-day Session", async () => {
      const r = await request("DELETE", `/supervisor/session-series/${fx.seriesId}`, token);
      assertEqual(r.status, 200, "status");
    });
    await test("totalHours = 15 (Session A + B + C only), zero contribution from the deleted 5-day Session", async () => {
      const r = await request("GET", "/supervisor/me/caseload-summary", token);
      assertEqual(r.status, 200, "status");
      assertEqual(r.body.totalHours, 15, "totalHours");
    });
    fx.seriesId = null;
  } finally {
    console.log("\nCleaning up ZZTTHL fixtures...");
    await teardown();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
