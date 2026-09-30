// Reproduces the exact reported discrepancy: Training Activities page says
// 5 activities, ToT Dashboard's "Training activities conducted" said 9.
// Root cause: the Dashboard's activities-conducted COUNT queried
// session_occasions with no series_id filter, so each DAY of a multi-day
// Session counted as its OWN activity instead of the whole Session
// counting once -- 4 standalone Group Sessions + 5 days of one Session =
// 9, while the Activities page (activitiesQuery.js's UNION_BASE) already
// correctly counted the Session once = 5.
//
// This test builds exactly that fixture (4 single-day occasions + 1
// five-day series, matching the reported numbers) and asserts both views
// now agree, the 55h total reconciles, and a deleted Session's days are
// fully excluded from every aggregate afterward (no orphaned
// contribution).
//
// Run: node tests/activities-count-reconciliation.test.js (dev server must be running)

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
  await pool.query("DELETE FROM supervisors WHERE id IN (SELECT id FROM user_credentials WHERE member_code = 'ZZTRECONTOT')");
  await pool.query("DELETE FROM students WHERE id IN (SELECT id FROM user_credentials WHERE member_code LIKE 'ZZTRECON%')");
  await pool.query("DELETE FROM user_credentials WHERE member_code LIKE 'ZZTRECON%'");
  await pool.query("DELETE FROM trainer_groups WHERE name LIKE 'ZZTRECON%'");
}

async function setup() {
  await precleanup();
  const grp = await pool.query("INSERT INTO trainer_groups (name) VALUES ('ZZTRECON Group')");
  fx.groupId = grp.insertId;

  const cred = await pool.query(
    "INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES ('ZZTRECONTOT', 'x', 'supervisor', 'active')"
  );
  fx.totId = cred.insertId;
  await pool.query("INSERT INTO supervisors (id, full_name, supervisor_type, group_id) VALUES (?, 'ZZTRECON ToT', 'primary', ?)", [
    fx.totId,
    fx.groupId,
  ]);

  for (let i = 1; i <= 17; i++) {
    const c = await pool.query(
      "INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES (?, 'x', 'trainee', 'active')",
      [`ZZTRECONS${i}`]
    );
    const id = c.insertId;
    fx.studentIds.push(id);
    await pool.query("INSERT INTO students (id, full_name, group_id) VALUES (?, ?, ?)", [id, `ZZTRECON Trainee ${i}`, fx.groupId]);
    await pool.query("INSERT INTO supervisor_students (supervisor_id, student_id) VALUES (?, ?)", [fx.totId, id]);
  }

  // 4 standalone single-day Group Session occasions, 5h each, 17 trainees,
  // fully present (matching "Structural Approach", "Complex Grief", and
  // "History..." x2 from the report -- exact titles don't matter, only the
  // shape: 4 single-day occasions).
  for (let i = 0; i < 4; i++) {
    const occ = await pool.query(
      "INSERT INTO session_occasions (supervisor_id, session_type, title, session_date, duration_minutes) VALUES (?, 'training', ?, DATE_SUB(CURDATE(), INTERVAL ? DAY), 300)",
      [fx.totId, `ZZTRECON Single ${i + 1}`, i + 10]
    );
    fx.occasionIds.push(occ.insertId);
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

  // 1 five-day Session ("Systemique Therapy"), 7h/day = 35h total, 15/17
  // present each day (matching the reported 75/85 = 88.24%).
  const series = await pool.query(
    "INSERT INTO session_series (supervisor_id, session_type, title) VALUES (?, 'training', 'ZZTRECON Multi-day')",
    [fx.totId]
  );
  fx.seriesId = series.insertId;
  for (let day = 0; day < 5; day++) {
    const occ = await pool.query(
      "INSERT INTO session_occasions (supervisor_id, session_type, title, session_date, duration_minutes, series_id) VALUES (?, 'training', ?, DATE_ADD(CURDATE(), INTERVAL ? DAY), 420, ?)",
      [fx.totId, `ZZTRECON Multi-day Day ${day + 1}`, day, fx.seriesId]
    );
    fx.seriesOccasionIds.push(occ.insertId);
    const statuses = [...Array(15).fill("present"), ...Array(2).fill("absent")];
    for (let i = 0; i < 17; i++) {
      const s = await pool.query(
        "INSERT INTO sessions (student_id, supervisor_id, session_type, session_date, duration_minutes, status, occasion_id) VALUES (?, ?, 'training', DATE_ADD(CURDATE(), INTERVAL ? DAY), 420, 'completed', ?)",
        [fx.studentIds[i], fx.totId, day, occ.insertId]
      );
      await pool.query(
        "INSERT INTO attendance (student_id, supervisor_id, session_id, attendance_date, status, recorded_by) VALUES (?, ?, ?, DATE_ADD(CURDATE(), INTERVAL ? DAY), ?, ?)",
        [fx.studentIds[i], fx.totId, s.insertId, day, statuses[i], fx.totId]
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
  if (fx.occasionIds.length) await pool.query(`DELETE FROM session_occasions WHERE id IN (${fx.occasionIds.map(() => "?").join(",")})`, fx.occasionIds);
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
  console.log("Setting up isolated ZZTRECON fixtures (reproducing the exact reported scenario)...");
  await setup();

  try {
    const token = tokenFor(fx.totId, "supervisor");

    console.log("\n[1] Training Activities page -- buildActivitiesSummary");
    let pageTotal;
    await test("Activities page shows 5 total activities (4 single-day + 1 series counted once)", async () => {
      const r = await request("GET", "/supervisor/activities/summary", token);
      assertEqual(r.status, 200, "status");
      pageTotal = r.body.totalActivities;
      assertEqual(pageTotal, 5, "totalActivities");
      assertEqual(r.body.trainingHours, 55, "trainingHours");
    });

    console.log("\n[2] ToT Dashboard -- GET /supervisor/me/training-delivered (the reported '9' bug)");
    let dashboardCount;
    await test("Dashboard now also reports 5 activities conducted, matching the Activities page (was 9 before the fix)", async () => {
      const r = await request("GET", "/supervisor/me/training-delivered", token);
      assertEqual(r.status, 200, "status");
      dashboardCount = r.body.sessionsConducted;
      assertEqual(dashboardCount, 5, "sessionsConducted");
    });
    await test("Dashboard total hours reconcile exactly with the Activities page: 55h both places", async () => {
      const r = await request("GET", "/supervisor/me/training-delivered", token);
      assertEqual(r.status, 200, "status");
      assertEqual(r.body.totalHours, 55, "totalHours");
    });
    await test("the two views agree (5 === 5) -- this was the core reported discrepancy", async () => {
      assertEqual(dashboardCount, pageTotal, "sessionsConducted must equal totalActivities");
    });

    console.log("\n[3] Multi-day attendance math -- 75/85 = 88.24%");
    await test("the 5-day Session: 15 present + 2 absent each day -> 75/85 attended trainee-days", async () => {
      const r = await request("GET", `/supervisor/session-series/${fx.seriesId}`, token);
      assertEqual(r.status, 200, "status");
      const totalPresent = r.body.days.reduce((s, d) => s + d.presentCount, 0);
      const totalSlots = r.body.days.reduce((s, d) => s + d.traineeCount, 0);
      assertEqual(totalPresent, 75, "75 attended trainee-days");
      assertEqual(totalSlots, 85, "85 expected trainee-days");
    });

    console.log("\n[4] Deletion audit -- deleting the multi-day Session must drop ALL 5 days from every aggregate, no orphans");
    await test("delete the 5-day Session", async () => {
      const r = await request("DELETE", `/supervisor/session-series/${fx.seriesId}`, token);
      assertEqual(r.status, 200, "status");
    });
    await test("no orphaned attendance rows survive for any of the 5 deleted days", async () => {
      const { rows } = await pool.query(
        `SELECT COUNT(*) c FROM attendance WHERE session_id IN (SELECT id FROM sessions WHERE occasion_id IN (${fx.seriesOccasionIds.map(() => "?").join(",")}))`,
        fx.seriesOccasionIds
      );
      assertEqual(Number(rows[0].c), 0, "zero orphaned attendance rows");
    });
    await test("no orphaned sessions rows survive for any of the 5 deleted days", async () => {
      const { rows } = await pool.query(
        `SELECT COUNT(*) c FROM sessions WHERE occasion_id IN (${fx.seriesOccasionIds.map(() => "?").join(",")})`,
        fx.seriesOccasionIds
      );
      assertEqual(Number(rows[0].c), 0, "zero orphaned sessions rows");
    });
    await test("Activities page now shows only 4 activities (the 5-day Session is gone, not partially)", async () => {
      const r = await request("GET", "/supervisor/activities/summary", token);
      assertEqual(r.status, 200, "status");
      assertEqual(r.body.totalActivities, 4, "totalActivities after delete");
      assertEqual(r.body.trainingHours, 20, "trainingHours after delete (4 x 5h, the 35h Session gone)");
    });
    await test("Dashboard also drops to 4 activities and 20h -- the deleted Session contributes NOTHING, not even partially", async () => {
      const r = await request("GET", "/supervisor/me/training-delivered", token);
      assertEqual(r.status, 200, "status");
      assertEqual(r.body.sessionsConducted, 4, "sessionsConducted after delete");
      assertEqual(r.body.totalHours, 20, "totalHours after delete");
    });
    fx.seriesId = null; // already deleted, teardown must not try again
    fx.seriesOccasionIds = [];
  } finally {
    console.log("\nCleaning up ZZTRECON fixtures...");
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
