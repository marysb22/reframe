// ToT Console dashboard audit -- automated regression suite for the top
// KPI strip (Assigned trainees / Training hours logged / Avg. attendance /
// Open assignments), "Academic Training -- Delivered by Master Trainer",
// "Training Delivery -- To Trainees", and "Today & upcoming activities".
//
// Same pattern as tests/trainee-profile-audit.test.js: no framework, real
// HTTP calls against the running dev server, real DB queries via the
// app's own pool, isolated ZZTCONS-prefixed fixtures, guaranteed cleanup.
//
// Run: node tests/tot-console-audit.test.js  (dev server must be running)

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
    const req = http.request(
      BASE + urlPath,
      { method, headers: { Authorization: token ? `Bearer ${token}` : undefined } },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {}
          resolve({ status: res.statusCode, body: json });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}
function tokenFor(id, role) {
  return jwt.sign({ id, role }, cfg.jwtSecret, { expiresIn: "1h" });
}

const SUP_ID = 326; // reused fixture supervisor (supervisor_type='primary'), used throughout this session
let fx = { groupId: null, otherSupervisorId: null, otherStudentId: null, studentIds: [], occasionId: null, cancelledSessionId: null, scheduledSessionId: null };

async function setup() {
  const grp = await pool.query("INSERT INTO trainer_groups (name) VALUES ('ZZTCONS Group')");
  fx.groupId = grp.insertId;
  await pool.query("UPDATE supervisors SET group_id = ? WHERE id = ?", [fx.groupId, SUP_ID]);

  const mkStudent = async (code, name) => {
    const cred = await pool.query(
      "INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES (?, 'x', 'trainee', 'active')",
      [code]
    );
    const id = cred.insertId;
    await pool.query("INSERT INTO students (id, full_name, group_id) VALUES (?, ?, ?)", [id, name, fx.groupId]);
    await pool.query("INSERT INTO supervisor_students (supervisor_id, student_id) VALUES (?, ?)", [SUP_ID, id]);
    return id;
  };

  const t1 = await mkStudent("ZZTCONS1", "ZZTCons Present");
  const t2 = await mkStudent("ZZTCONS2", "ZZTCons Partial");
  const t3 = await mkStudent("ZZTCONS3", "ZZTCons Absent");
  const t4 = await mkStudent("ZZTCONS4", "ZZTCons GroupOnly");
  const t5 = await mkStudent("ZZTCONS5", "ZZTCons ScheduledOnly");
  fx.studentIds = [t1, t2, t3, t4, t5];

  // T1: standalone training session, 5h, Present.
  const s1 = await pool.query(
    "INSERT INTO sessions (student_id, supervisor_id, session_type, session_date, duration_minutes, status) VALUES (?, ?, 'training', CURDATE(), 300, 'completed')",
    [t1, SUP_ID]
  );
  await pool.query(
    "INSERT INTO attendance (student_id, supervisor_id, session_id, attendance_date, status, recorded_by) VALUES (?, ?, ?, CURDATE(), 'present', ?)",
    [t1, SUP_ID, s1.insertId, SUP_ID]
  );

  // T2: standalone training session, 4h duration, Partial (1.5h completed).
  const s2 = await pool.query(
    "INSERT INTO sessions (student_id, supervisor_id, session_type, session_date, duration_minutes, status) VALUES (?, ?, 'training', CURDATE(), 240, 'completed')",
    [t2, SUP_ID]
  );
  await pool.query(
    "INSERT INTO attendance (student_id, supervisor_id, session_id, attendance_date, status, minutes_completed, recorded_by) VALUES (?, ?, ?, CURDATE(), 'partial', 90, ?)",
    [t2, SUP_ID, s2.insertId, SUP_ID]
  );

  // T3: standalone training session, 3h, Absent.
  const s3 = await pool.query(
    "INSERT INTO sessions (student_id, supervisor_id, session_type, session_date, duration_minutes, status) VALUES (?, ?, 'training', CURDATE(), 180, 'completed')",
    [t3, SUP_ID]
  );
  await pool.query(
    "INSERT INTO attendance (student_id, supervisor_id, session_id, attendance_date, status, recorded_by) VALUES (?, ?, ?, CURDATE(), 'absent', ?)",
    [t3, SUP_ID, s3.insertId, SUP_ID]
  );

  // Group Session occasion, 2h, attendees T1 (present, again) + T4 (present, first time).
  const occ = await pool.query(
    "INSERT INTO session_occasions (supervisor_id, session_type, title, session_date, duration_minutes) VALUES (?, 'training', 'ZZTCONS Group Session', CURDATE(), 120)",
    [SUP_ID]
  );
  fx.occasionId = occ.insertId;
  const gs1 = await pool.query(
    "INSERT INTO sessions (student_id, supervisor_id, session_type, session_date, duration_minutes, status, occasion_id) VALUES (?, ?, 'training', CURDATE(), 120, 'completed', ?)",
    [t1, SUP_ID, fx.occasionId]
  );
  await pool.query(
    "INSERT INTO attendance (student_id, supervisor_id, session_id, attendance_date, status, recorded_by) VALUES (?, ?, ?, CURDATE(), 'present', ?)",
    [t1, SUP_ID, gs1.insertId, SUP_ID]
  );
  const gs4 = await pool.query(
    "INSERT INTO sessions (student_id, supervisor_id, session_type, session_date, duration_minutes, status, occasion_id) VALUES (?, ?, 'training', CURDATE(), 120, 'completed', ?)",
    [t4, SUP_ID, fx.occasionId]
  );
  await pool.query(
    "INSERT INTO attendance (student_id, supervisor_id, session_id, attendance_date, status, recorded_by) VALUES (?, ?, ?, CURDATE(), 'present', ?)",
    [t4, SUP_ID, gs4.insertId, SUP_ID]
  );

  // A cancelled session dated today (must never appear in "today", never count toward hours/sessionsConducted).
  const cancelled = await pool.query(
    "INSERT INTO sessions (student_id, supervisor_id, session_type, session_date, duration_minutes, status) VALUES (?, ?, 'training', CURDATE(), 600, 'cancelled')",
    [t1, SUP_ID]
  );
  fx.cancelledSessionId = cancelled.insertId;

  // T5: only a future *scheduled* session, no attendance recorded yet --
  // must NOT count as "trained" and must NOT count in sessionsConducted.
  const scheduled = await pool.query(
    "INSERT INTO sessions (student_id, supervisor_id, session_type, session_date, duration_minutes, status) VALUES (?, ?, 'training', DATE_ADD(CURDATE(), INTERVAL 3 DAY), 300, 'scheduled')",
    [t5, SUP_ID]
  );
  fx.scheduledSessionId = scheduled.insertId;

  // Assignments: one open (pending), one completed -- open count must be 1.
  await pool.query("INSERT INTO assignments (student_id, supervisor_id, title, due_date, status) VALUES (?, ?, 'ZZTCONS A1', CURDATE(), 'pending')", [t1, SUP_ID]);
  await pool.query("INSERT INTO assignments (student_id, supervisor_id, title, due_date, status) VALUES (?, ?, 'ZZTCONS A2', CURDATE(), 'completed')", [t2, SUP_ID]);

  // A completely unrelated supervisor + trainee, to prove no cross-tenant leakage.
  const otherCred = await pool.query(
    "INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES ('ZZTCONSSUP', 'x', 'supervisor', 'active')"
  );
  fx.otherSupervisorId = otherCred.insertId;
  await pool.query("INSERT INTO supervisors (id, full_name, supervisor_type) VALUES (?, 'ZZTCons Other Supervisor', 'primary')", [fx.otherSupervisorId]);
  fx.otherStudentId = await mkOtherStudent();

  async function mkOtherStudent() {
    const cred = await pool.query(
      "INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES ('ZZTCONS6', 'x', 'trainee', 'active')"
    );
    const id = cred.insertId;
    await pool.query("INSERT INTO students (id, full_name) VALUES (?, 'ZZTCons OtherSup Trainee')", [id]);
    await pool.query("INSERT INTO supervisor_students (supervisor_id, student_id) VALUES (?, ?)", [fx.otherSupervisorId, id]);
    const s = await pool.query(
      "INSERT INTO sessions (student_id, supervisor_id, session_type, session_date, duration_minutes, status) VALUES (?, ?, 'training', CURDATE(), 6000, 'completed')",
      [id, fx.otherSupervisorId]
    );
    await pool.query(
      "INSERT INTO attendance (student_id, supervisor_id, session_id, attendance_date, status, recorded_by) VALUES (?, ?, ?, CURDATE(), 'present', ?)",
      [id, fx.otherSupervisorId, s.insertId, fx.otherSupervisorId]
    );
    return id;
  }
}

async function teardown() {
  const ids = [...fx.studentIds, fx.otherStudentId].filter(Boolean);
  if (ids.length) {
    await pool.query(`DELETE FROM assignments WHERE student_id IN (${ids.map(() => "?").join(",")})`, ids);
    await pool.query(`DELETE FROM attendance WHERE student_id IN (${ids.map(() => "?").join(",")})`, ids);
    await pool.query(`DELETE FROM sessions WHERE student_id IN (${ids.map(() => "?").join(",")})`, ids);
  }
  if (fx.occasionId) await pool.query("DELETE FROM session_occasions WHERE id = ?", [fx.occasionId]);
  if (ids.length) {
    await pool.query(`DELETE FROM supervisor_students WHERE student_id IN (${ids.map(() => "?").join(",")})`, ids);
    await pool.query(`DELETE FROM students WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
    await pool.query(`DELETE FROM user_credentials WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
  }
  if (fx.otherSupervisorId) {
    await pool.query("DELETE FROM supervisors WHERE id = ?", [fx.otherSupervisorId]);
    await pool.query("DELETE FROM user_credentials WHERE id = ?", [fx.otherSupervisorId]);
  }
  await pool.query("UPDATE supervisors SET group_id = NULL WHERE id = ?", [SUP_ID]);
  if (fx.groupId) await pool.query("DELETE FROM trainer_groups WHERE id = ?", [fx.groupId]);
}

async function run() {
  console.log("Setting up isolated ZZTCONS fixtures...");
  await setup();

  try {
    const token = tokenFor(SUP_ID, "supervisor");
    const otherToken = tokenFor(fx.otherSupervisorId, "supervisor");

    console.log("\nTop KPI strip -- GET /supervisor/me/caseload-summary (pooled, not averaged)");
    await test("training hours logged: 8.5h -- actual session DURATION delivered (6.5 standalone + 2h group session counted ONCE), not attendee-multiplied trainee-hours", async () => {
      const r = await request("GET", "/supervisor/me/caseload-summary", token);
      assertEqual(r.status, 200);
      assertEqual(r.body.totalHours, 8.5);
    });
    await test("avg attendance: true pooled rate 80% (4 present/partial of 5 records), not an average of per-trainee %", async () => {
      const r = await request("GET", "/supervisor/me/caseload-summary", token);
      assertEqual(r.body.attendanceRate, 80);
    });
    await test("open assignments: 1 (2 total, 1 completed)", async () => {
      const r = await request("GET", "/supervisor/me/caseload-summary", token);
      assertEqual(r.body.openAssignments, 1);
    });
    await test("assigned trainees: 5 (via /supervisor/students, already-verified route)", async () => {
      const r = await request("GET", "/supervisor/students", token);
      const mine = r.body.students.filter((s) => fx.studentIds.includes(s.id));
      assertEqual(mine.length, 5);
    });

    console.log("\nAcademic Training -- Delivered by Master Trainer (GET /supervisor/me/training-received)");
    await test("zero is genuinely correct: no tot_training_sessions row exists for this ToT", async () => {
      const r = await request("GET", "/supervisor/me/training-received", token);
      assertEqual(r.status, 200);
      assertEqual(r.body.totalHours, 0);
      assertEqual(r.body.attendanceRate, null);
      assertEqual(r.body.sessionsAttended, 0);
      assertEqual(r.body.sessionsMissed, 0);
    });

    console.log("\nTraining Delivery -- To Trainees (GET /supervisor/me/training-delivered)");
    await test("total hours: 8.5h (6.5 standalone + 2h group session counted ONCE, not per-attendee)", async () => {
      const r = await request("GET", "/supervisor/me/training-delivered", token);
      assertEqual(r.status, 200);
      assertEqual(r.body.totalHours, 8.5);
    });
    await test("trainee attendance: 80%, now correctly includes Partial as attended", async () => {
      const r = await request("GET", "/supervisor/me/training-delivered", token);
      assertEqual(r.body.traineeAttendanceRate, 80);
    });
    await test("activities conducted: 4 (3 standalone completed + 1 group occasion, NOT the future scheduled one)", async () => {
      const r = await request("GET", "/supervisor/me/training-delivered", token);
      assertEqual(r.body.sessionsConducted, 4);
    });
    await test("trainees trained: 3 (T1, T2, T4 actually attended -- T3 was absent, T5 only has a future scheduled session)", async () => {
      const r = await request("GET", "/supervisor/me/training-delivered", token);
      assertEqual(r.body.traineesTrained, 3);
    });

    console.log("\nToday & upcoming activities (GET /supervisor/schedule)");
    await test("cancelled session never appears in today's list", async () => {
      const r = await request("GET", "/supervisor/schedule", token);
      assertEqual(r.status, 200);
      const leaked = r.body.today.find((i) => i.id === fx.cancelledSessionId);
      assertEqual(leaked, undefined, "a cancelled session appeared in the schedule");
    });
    await test("the future scheduled session appears in upcoming, not today", async () => {
      const r = await request("GET", "/supervisor/schedule", token);
      const inUpcoming = r.body.upcoming.some((i) => i.id === fx.scheduledSessionId);
      const inToday = r.body.today.some((i) => i.id === fx.scheduledSessionId);
      assertEqual(inUpcoming, true, "scheduled session missing from upcoming");
      assertEqual(inToday, false, "scheduled session wrongly counted as today");
    });

    console.log("\nSecurity / data isolation");
    await test("caseload-summary never includes another supervisor's trainee hours/attendance", async () => {
      const r = await request("GET", "/supervisor/me/caseload-summary", token);
      // The other supervisor's fixture session is 100h (6000 min) -- if it
      // leaked in, totalHours would jump far past 8.5.
      assertEqual(r.body.totalHours, 8.5);
    });
    await test("training-delivered never includes another supervisor's sessions", async () => {
      const r = await request("GET", "/supervisor/me/training-delivered", token);
      assertEqual(r.body.totalHours, 8.5);
      assertEqual(r.body.traineesTrained, 3);
    });
    await test("the other supervisor's own dashboard sees only their own data (not zero, not this ToT's data)", async () => {
      const r = await request("GET", "/supervisor/me/caseload-summary", otherToken);
      assertEqual(r.body.totalHours, 100); // 6000 min / 60, present
      assertEqual(r.body.attendanceRate, 100);
    });
    await test("a supervisor cannot list a trainee that isn't theirs via /supervisor/students", async () => {
      const r = await request("GET", "/supervisor/students", token);
      const leaked = r.body.students.find((s) => s.id === fx.otherStudentId);
      assertEqual(leaked, undefined);
    });
  } finally {
    console.log("\nTearing down ZZTCONS fixtures...");
    await teardown();
    const { rows } = await pool.query("SELECT COUNT(*) c FROM user_credentials WHERE member_code LIKE 'ZZTCONS%'");
    console.log(`Teardown verification: ${rows[0].c} leftover ZZTCONS accounts (should be 0).`);
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${"=".repeat(60)}`);
  console.log(`${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ""}`);
  console.log("=".repeat(60));
  process.exit(failed ? 1 : 0);
}

run().catch((err) => {
  console.error("Suite crashed:", err);
  teardown()
    .catch(() => {})
    .finally(() => process.exit(1));
});
