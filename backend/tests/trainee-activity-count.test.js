// Follow-up to activities-count-reconciliation.test.js: the ToT Dashboard's
// "activities conducted" count was fixed there, but the SAME multi-day
// Session double-counting bug turned out to exist in two more places,
// discovered live on production (a trainee's own profile still showed
// "Training activities: 9" after the first fix deployed):
//
//  1. computeProgressSummary (serializers.js) -- used by a trainee's own
//     "My Profile", the ToT's view of that trainee, and Admin's view --
//     counted raw `sessions` rows for that student, so a 5-day Session
//     they attended contributed 5 instead of 1 (one `sessions` row per
//     day, each its own occasion).
//
//  2. Mastertrainer.js's GET /tots/:totId stats -- counted raw `sessions`
//     rows for that ToT with NO de-duplication at all, so a single
//     17-trainee Group Session occasion contributed 17, not 1, on top of
//     the same multi-day problem.
//
// This test reproduces the exact reported shape (4 single-day occasions +
// 1 five-day series, one trainee who attended everything) and asserts
// both views now report 5, not 9 or 17x-inflated.
//
// Run: node tests/trainee-activity-count.test.js (dev server must be running)

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

let fx = { groupId: null, mtId: null, totId: null, studentIds: [] };

async function precleanup() {
  await pool.query("DELETE FROM supervisors WHERE supervisor_type = 'in_training' AND id IN (SELECT id FROM user_credentials WHERE member_code LIKE 'ZZTTAC%')");
  await pool.query("DELETE FROM supervisors WHERE supervisor_type = 'primary' AND id IN (SELECT id FROM user_credentials WHERE member_code LIKE 'ZZTTAC%')");
  await pool.query("DELETE FROM students WHERE id IN (SELECT id FROM user_credentials WHERE member_code LIKE 'ZZTTAC%')");
  await pool.query("DELETE FROM user_credentials WHERE member_code LIKE 'ZZTTAC%'");
  await pool.query("DELETE FROM trainer_groups WHERE name LIKE 'ZZTTAC%'");
}

async function setup() {
  await precleanup();
  const grp = await pool.query("INSERT INTO trainer_groups (name) VALUES ('ZZTTAC Group')");
  fx.groupId = grp.insertId;

  const mtCred = await pool.query(
    "INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES ('ZZTTACMT', 'x', 'supervisor', 'active')"
  );
  fx.mtId = mtCred.insertId;
  await pool.query("INSERT INTO supervisors (id, full_name, supervisor_type, group_id) VALUES (?, 'ZZTTAC MT', 'primary', ?)", [
    fx.mtId,
    fx.groupId,
  ]);

  const totCred = await pool.query(
    "INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES ('ZZTTACTOT', 'x', 'supervisor', 'active')"
  );
  fx.totId = totCred.insertId;
  await pool.query(
    "INSERT INTO supervisors (id, full_name, supervisor_type, group_id, primary_supervisor_id) VALUES (?, 'ZZTTAC ToT', 'in_training', ?, ?)",
    [fx.totId, fx.groupId, fx.mtId]
  );

  // 4 trainees is enough -- only trainee #1 needs to attend everything,
  // the rest just fill out a realistic small roster.
  for (let i = 1; i <= 4; i++) {
    const c = await pool.query(
      "INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES (?, 'x', 'trainee', 'active')",
      [`ZZTTACS${i}`]
    );
    const id = c.insertId;
    fx.studentIds.push(id);
    await pool.query("INSERT INTO students (id, full_name, group_id) VALUES (?, ?, ?)", [id, `ZZTTAC Trainee ${i}`, fx.groupId]);
    await pool.query("INSERT INTO supervisor_students (supervisor_id, student_id) VALUES (?, ?)", [fx.totId, id]);
  }
  const trainee = fx.studentIds[0];

  // 4 standalone single-day occasions -- the trainee attends (present) all 4.
  for (let i = 0; i < 4; i++) {
    const occ = await pool.query(
      "INSERT INTO session_occasions (supervisor_id, session_type, title, session_date, duration_minutes) VALUES (?, 'training', ?, DATE_SUB(CURDATE(), INTERVAL ? DAY), 300)",
      [fx.totId, `ZZTTAC Single ${i + 1}`, i + 10]
    );
    for (const studentId of fx.studentIds) {
      const s = await pool.query(
        "INSERT INTO sessions (student_id, supervisor_id, session_type, session_date, duration_minutes, status, occasion_id) VALUES (?, ?, 'training', DATE_SUB(CURDATE(), INTERVAL ? DAY), 300, 'completed', ?)",
        [studentId, fx.totId, i + 10, occ.insertId]
      );
      await pool.query(
        "INSERT INTO attendance (student_id, supervisor_id, session_id, attendance_date, status, recorded_by) VALUES (?, ?, ?, DATE_SUB(CURDATE(), INTERVAL ? DAY), 'present', ?)",
        [studentId, fx.totId, s.insertId, i + 10, fx.totId]
      );
    }
  }

  // 1 five-day Session -- the trainee attends (present) all 5 days.
  const series = await pool.query(
    "INSERT INTO session_series (supervisor_id, session_type, title) VALUES (?, 'training', 'ZZTTAC Multi-day')",
    [fx.totId]
  );
  fx.seriesId = series.insertId;
  for (let day = 0; day < 5; day++) {
    const occ = await pool.query(
      "INSERT INTO session_occasions (supervisor_id, session_type, title, session_date, duration_minutes, series_id) VALUES (?, 'training', ?, DATE_ADD(CURDATE(), INTERVAL ? DAY), 420, ?)",
      [fx.totId, `ZZTTAC Multi-day Day ${day + 1}`, day, fx.seriesId]
    );
    for (const studentId of fx.studentIds) {
      const s = await pool.query(
        "INSERT INTO sessions (student_id, supervisor_id, session_type, session_date, duration_minutes, status, occasion_id) VALUES (?, ?, 'training', DATE_ADD(CURDATE(), INTERVAL ? DAY), 420, 'completed', ?)",
        [studentId, fx.totId, day, occ.insertId]
      );
      await pool.query(
        "INSERT INTO attendance (student_id, supervisor_id, session_id, attendance_date, status, recorded_by) VALUES (?, ?, ?, DATE_ADD(CURDATE(), INTERVAL ? DAY), 'present', ?)",
        [studentId, fx.totId, s.insertId, day, fx.totId]
      );
    }
  }
}

async function teardown() {
  const inList = fx.studentIds.map(() => "?").join(",");
  if (fx.studentIds.length) {
    await pool.query(`DELETE FROM attendance WHERE student_id IN (${inList})`, fx.studentIds);
    await pool.query(`DELETE FROM sessions WHERE student_id IN (${inList})`, fx.studentIds);
  }
  if (fx.seriesId) await pool.query("DELETE FROM session_occasions WHERE series_id = ?", [fx.seriesId]);
  if (fx.seriesId) await pool.query("DELETE FROM session_series WHERE id = ?", [fx.seriesId]);
  await pool.query("DELETE FROM session_occasions WHERE supervisor_id = ?", [fx.totId]);
  if (fx.studentIds.length) {
    await pool.query(`DELETE FROM supervisor_students WHERE student_id IN (${inList})`, fx.studentIds);
    await pool.query(`DELETE FROM students WHERE id IN (${inList})`, fx.studentIds);
    await pool.query(`DELETE FROM user_credentials WHERE id IN (${inList})`, fx.studentIds);
  }
  if (fx.totId) await pool.query("DELETE FROM supervisors WHERE id = ?", [fx.totId]);
  if (fx.mtId) await pool.query("DELETE FROM supervisors WHERE id = ?", [fx.mtId]);
  const supIds = [fx.totId, fx.mtId].filter(Boolean);
  if (supIds.length) await pool.query(`DELETE FROM user_credentials WHERE id IN (${supIds.map(() => "?").join(",")})`, supIds);
  if (fx.groupId) await pool.query("DELETE FROM trainer_groups WHERE id = ?", [fx.groupId]);
}

async function run() {
  console.log("Setting up isolated ZZTTAC fixtures...");
  await setup();

  try {
    const trainee = fx.studentIds[0];
    const traineeToken = tokenFor(trainee, "trainee");
    const mtToken = tokenFor(fx.mtId, "supervisor");

    console.log("\n[1] Trainee's own profile (computeProgressSummary via GET /profile/progress)");
    await test("Training activities = 5 (4 standalone + 1 five-day Session counted once), not 9", async () => {
      const r = await request("GET", "/profile/progress", traineeToken);
      assertEqual(r.status, 200, "status");
      assertEqual(r.body.trainingSessions, 5, "trainingSessions");
    });

    console.log("\n[2] Master Trainer's view of the ToT (GET /master-trainer/tots/:totId)");
    await test("Training activities = 5, not 9 and not inflated by the 4-trainee roster (e.g. not 20)", async () => {
      const r = await request("GET", `/master-trainer/tots/${fx.totId}`, mtToken);
      assertEqual(r.status, 200, "status");
      assertEqual(r.body.stats.training_sessions, 5, "stats.training_sessions");
    });
  } finally {
    console.log("\nCleaning up ZZTTAC fixtures...");
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
