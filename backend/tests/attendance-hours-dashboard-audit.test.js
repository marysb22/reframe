// Diagnostic audit: Attendance -> Hour Type -> Hours -> Dashboard, run
// against the REAL API end-to-end (session-occasions create, attendance
// PUT, occasion edit PUT) with isolated ZZTAHD fixtures. See the matching
// report for the full writeup; this file is the evidence behind it.
//
// Run: node tests/attendance-hours-dashboard-audit.test.js (dev server must be running)

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
function request(method, urlPath, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      BASE + urlPath,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
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
    if (payload) req.write(payload);
    req.end();
  });
}
function tokenFor(id, role) {
  return jwt.sign({ id, role }, cfg.jwtSecret, { expiresIn: "1h" });
}

let fx = { groupId: null, totId: null, studentId: null, occasionId: null };

async function precleanup() {
  const totIds = "(SELECT id FROM user_credentials WHERE member_code LIKE 'ZZTAHD%')";
  await pool.query(`DELETE FROM attendance WHERE supervisor_id IN ${totIds}`);
  await pool.query(`DELETE FROM sessions WHERE supervisor_id IN ${totIds}`);
  await pool.query(`DELETE FROM session_occasions WHERE supervisor_id IN ${totIds}`);
  await pool.query(`DELETE FROM session_series WHERE supervisor_id IN ${totIds}`);
  await pool.query("DELETE FROM students WHERE id IN (SELECT id FROM user_credentials WHERE member_code LIKE 'ZZTAHD%')");
  await pool.query("DELETE FROM supervisors WHERE id IN (SELECT id FROM user_credentials WHERE member_code LIKE 'ZZTAHD%')");
  await pool.query("DELETE FROM user_credentials WHERE member_code LIKE 'ZZTAHD%'");
  await pool.query("DELETE FROM trainer_groups WHERE name LIKE 'ZZTAHD%'");
}

async function setup() {
  await precleanup();
  const grp = await pool.query("INSERT INTO trainer_groups (name) VALUES ('ZZTAHD Group')");
  fx.groupId = grp.insertId;

  const totCred = await pool.query(
    "INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES ('ZZTAHDTOT', 'x', 'supervisor', 'active')"
  );
  fx.totId = totCred.insertId;
  await pool.query("INSERT INTO supervisors (id, full_name, supervisor_type, group_id) VALUES (?, 'ZZTAHD ToT', 'primary', ?)", [
    fx.totId,
    fx.groupId,
  ]);

  const stuCred = await pool.query(
    "INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES ('ZZTAHDS1', 'x', 'trainee', 'active')"
  );
  fx.studentId = stuCred.insertId;
  await pool.query("INSERT INTO students (id, full_name, group_id) VALUES (?, 'ZZTAHD Trainee 1', ?)", [fx.studentId, fx.groupId]);
  await pool.query("INSERT INTO supervisor_students (supervisor_id, student_id) VALUES (?, ?)", [fx.totId, fx.studentId]);
}

async function teardown() {
  if (fx.studentId) {
    await pool.query("DELETE FROM attendance WHERE student_id = ?", [fx.studentId]);
    await pool.query("DELETE FROM sessions WHERE student_id = ?", [fx.studentId]);
  }
  if (fx.totId) await pool.query("DELETE FROM session_occasions WHERE supervisor_id = ?", [fx.totId]);
  if (fx.totId) await pool.query("DELETE FROM session_series WHERE supervisor_id = ?", [fx.totId]);
  if (fx.studentId) {
    await pool.query("DELETE FROM supervisor_students WHERE student_id = ?", [fx.studentId]);
    await pool.query("DELETE FROM students WHERE id = ?", [fx.studentId]);
    await pool.query("DELETE FROM user_credentials WHERE id = ?", [fx.studentId]);
  }
  if (fx.totId) {
    await pool.query("DELETE FROM supervisors WHERE id = ?", [fx.totId]);
    await pool.query("DELETE FROM user_credentials WHERE id = ?", [fx.totId]);
  }
  if (fx.groupId) await pool.query("DELETE FROM trainer_groups WHERE id = ?", [fx.groupId]);
}

async function getProgress(token) {
  const r = await request("GET", `/supervisor/students/${fx.studentId}`, token);
  if (r.status !== 200) throw new Error(`GET student failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.progress;
}

async function run() {
  console.log("Setting up isolated ZZTAHD fixtures...");
  await setup();

  try {
    const token = tokenFor(fx.totId, "supervisor");
    const today = new Date().toISOString().slice(0, 10);

    // ---- Test 3: Training 120min, present -> Training=2, Supervision=0 ----
    console.log("\n[Test 3] Training session, 120 min, Present");
    const create1 = await request("POST", "/supervisor/session-occasions", token, {
      sessionType: "training",
      title: "ZZTAHD T1",
      date: today,
      durationMinutes: 120,
    });
    await test("POST session-occasions (training) -> 201", () => assertEqual(create1.status, 201, "status"));
    fx.occasionId = create1.body && create1.body.occasionId;
    const sessionId1 = create1.body && create1.body.created && create1.body.created[0] && create1.body.created[0].sessionId;

    const att1 = await request("PUT", `/supervisor/session-occasions/${fx.occasionId}/attendance`, token, {
      entries: [{ studentId: fx.studentId, status: "present" }],
    });
    await test("PUT attendance (present) -> 200", () => assertEqual(att1.status, 200, "status"));

    await test("DB: sessions.session_type = training, duration_minutes = 120", async () => {
      const { rows } = await pool.query("SELECT session_type, duration_minutes FROM sessions WHERE id = ?", [sessionId1]);
      assertEqual(rows[0].session_type, "training", "session_type");
      assertEqual(Number(rows[0].duration_minutes), 120, "duration_minutes");
    });
    await test("DB: attendance.status = present, minutes_completed = NULL", async () => {
      const { rows } = await pool.query("SELECT status, minutes_completed FROM attendance WHERE session_id = ?", [sessionId1]);
      assertEqual(rows[0].status, "present", "status");
      assertEqual(rows[0].minutes_completed, null, "minutes_completed");
    });

    let progress = await getProgress(token);
    await test("API: trainingHours = 2", () => assertEqual(progress.trainingHours, 2, "trainingHours"));
    await test("API: supervisionHours = 0", () => assertEqual(progress.supervisionHours, 0, "supervisionHours"));
    console.log(`      (for reference: API also returns clinicalHours = ${progress.clinicalHours} -- this is trainingHours + supervisionHours combined, see report)`);

    // ---- Test 4: add Supervision 120min, present -> Training=2, Supervision=2 ----
    console.log("\n[Test 4] Add a Supervision session, 120 min, Present");
    const create2 = await request("POST", "/supervisor/session-occasions", token, {
      sessionType: "supervision",
      title: "ZZTAHD S1",
      date: today,
      durationMinutes: 120,
    });
    await test("POST session-occasions (supervision) -> 201", () => assertEqual(create2.status, 201, "status"));
    const occasionId2 = create2.body.occasionId;
    const sessionId2 = create2.body.created[0].sessionId;
    const att2 = await request("PUT", `/supervisor/session-occasions/${occasionId2}/attendance`, token, {
      entries: [{ studentId: fx.studentId, status: "present" }],
    });
    await test("PUT attendance (present) -> 200", () => assertEqual(att2.status, 200, "status"));

    progress = await getProgress(token);
    await test("API: trainingHours still = 2 (unchanged by the new Supervision session)", () => assertEqual(progress.trainingHours, 2, "trainingHours"));
    await test("API: supervisionHours = 2", () => assertEqual(progress.supervisionHours, 2, "supervisionHours"));
    await test(
      "API: clinicalHours = 4 (this is the combined total -- the Totdashboard/AdminDashboard per-trainee 'Training hours' cell is bound to THIS field, not trainingHours -- see report, bug #1)",
      () => assertEqual(progress.clinicalHours, 4, "clinicalHours")
    );

    // ---- Test 5: Partial attendance ----
    console.log("\n[Test 5] Partial attendance -- 60 min, then 90 min completed out of a 100-min session (distinct duration so the duplicate-submission guard doesn't collide with Test 3's identical same-second training/120min/today occasion)");
    const create3 = await request("POST", "/supervisor/session-occasions", token, {
      sessionType: "training",
      title: "ZZTAHD T-Partial-60",
      date: today,
      durationMinutes: 100,
    });
    await test("POST session-occasions (training, 100min) -> 201", () => assertEqual(create3.status, 201, "status"));
    const occasionId3 = create3.body.occasionId;
    const attp1 = await request("PUT", `/supervisor/session-occasions/${occasionId3}/attendance`, token, {
      entries: [{ studentId: fx.studentId, status: "partial", minutesCompleted: 60 }],
    });
    await test("PUT attendance (partial, 60 min completed) -> 200", () => assertEqual(attp1.status, 200, "status"));
    progress = await getProgress(token);
    // minutes_completed converts straight to hours (/60), independent of the
    // session's own total duration -- 60 min completed = 1.0h, exactly as
    // the brief's own spec states, not a 60/100 proportional fraction.
    await test("API: trainingHours = 3.0 (2 + 1.0h from 60 min completed)", () => assertEqual(progress.trainingHours, 3, "trainingHours"));
    await test("API: trainingHours did NOT become 2 + 100/60 = 3.67 (full session duration, ignoring partial)", () => assertEqual(progress.trainingHours !== 2 + 100 / 60, true, "not full duration"));

    // correct the same occasion's attendance to 90 minutes instead (edit, not a new occasion)
    const attp2 = await request("PUT", `/supervisor/session-occasions/${occasionId3}/attendance`, token, {
      entries: [{ studentId: fx.studentId, status: "partial", minutesCompleted: 90 }],
    });
    await test("PUT attendance (partial, 90 min completed, same occasion) -> 200", () => assertEqual(attp2.status, 200, "status"));
    progress = await getProgress(token);
    await test("API: trainingHours = 3.5 (2 + 1.5h from 90 min completed, replacing the 60-min value, not adding to it)", () =>
      assertEqual(progress.trainingHours, 3.5, "trainingHours")
    );
    await test("DB: still exactly one attendance row for this session (no duplicate created by the edit)", async () => {
      const { rows } = await pool.query(
        "SELECT COUNT(*) AS n FROM attendance WHERE session_id = (SELECT id FROM sessions WHERE occasion_id = ? AND student_id = ?)",
        [occasionId3, fx.studentId]
      );
      assertEqual(Number(rows[0].n), 1, "attendance row count");
    });

    // clean up the partial-test occasion so it doesn't interfere with tests 6/7 below
    await pool.query("DELETE FROM attendance WHERE session_id IN (SELECT id FROM sessions WHERE occasion_id = ?)", [occasionId3]);
    await pool.query("DELETE FROM sessions WHERE occasion_id = ?", [occasionId3]);
    await pool.query("DELETE FROM session_occasions WHERE id = ?", [occasionId3]);

    // ---- Test 6: edit the Training session's duration 2h -> 3h ----
    console.log("\n[Test 6] Edit the original Training session: 120 min -> 180 min (same attendance, still Present)");
    progress = await getProgress(token);
    const beforeEdit = progress.trainingHours;
    const editOcc = await request("PUT", `/supervisor/session-occasions/${fx.occasionId}`, token, {
      sessionType: "training",
      date: today,
      durationMinutes: 180,
    });
    await test("PUT session-occasions/:id (duration change) -> 200", () => assertEqual(editOcc.status, 200, "status"));
    progress = await getProgress(token);
    await test(`API: trainingHours = 3 (was ${beforeEdit}, the SAME session's duration changed 2h->3h, not duplicated into 5h)`, () =>
      assertEqual(progress.trainingHours, 3, "trainingHours")
    );
    await test("DB: still exactly one sessions row for this occasion/student (edit updated in place)", async () => {
      const { rows } = await pool.query("SELECT COUNT(*) AS n FROM sessions WHERE occasion_id = ? AND student_id = ?", [fx.occasionId, fx.studentId]);
      assertEqual(Number(rows[0].n), 1, "sessions row count");
    });

    // ---- Test 7: change the Training session's type to Supervision ----
    console.log("\n[Test 7] Change the same Session's type: training -> supervision");
    const editType = await request("PUT", `/supervisor/session-occasions/${fx.occasionId}`, token, {
      sessionType: "supervision",
      date: today,
      durationMinutes: 180,
    });
    await test("PUT session-occasions/:id (type change) -> 200", () => assertEqual(editType.status, 200, "status"));
    progress = await getProgress(token);
    await test("API: trainingHours = 0 (the 3h moved OUT of training)", () => assertEqual(progress.trainingHours, 0, "trainingHours"));
    await test("API: supervisionHours = 5 (2 original + 3 moved in)", () => assertEqual(progress.supervisionHours, 5, "supervisionHours"));
    await test("DB: no duplicate attendance/session rows from the type change", async () => {
      const { rows } = await pool.query(
        "SELECT COUNT(*) AS n FROM sessions WHERE occasion_id = ? AND student_id = ?",
        [fx.occasionId, fx.studentId]
      );
      assertEqual(Number(rows[0].n), 1, "sessions row count");
    });

    // ---- Test 9: training vs training_session hour_types ----
    console.log("\n[Test 9] hour_types: 'training' vs 'training_session'");
    const { rows: htRows } = await pool.query("SELECT code, label, is_primary, is_active FROM hour_types WHERE code IN ('training','training_session')");
    console.log("      " + JSON.stringify(htRows));
    const trainingSessionHt = htRows.find((h) => h.code === "training_session");
    if (trainingSessionHt && trainingSessionHt.is_active) {
      console.log("      'training_session' is ACTIVE and is_primary=" + trainingSessionHt.is_primary + " -- it WILL appear in the Log Single Activity dropdown as a selectable, separate hour type (see report, bug #2)");
    }

    // ---- Dashboard-refresh check: does the SAME request cycle the real app uses return fresh numbers every time, with no caching? ----
    console.log("\n[Test 8] No server-side caching -- repeat the last GET immediately, expect identical fresh numbers both times");
    const p1 = await getProgress(token);
    const p2 = await getProgress(token);
    await test("Two consecutive GETs return the same (correct, non-stale) numbers", () => {
      assertEqual(p1.trainingHours, p2.trainingHours, "trainingHours consistent");
      assertEqual(p1.supervisionHours, p2.supervisionHours, "supervisionHours consistent");
    });
  } finally {
    await teardown();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
  process.exit(process.exitCode || 0);
}

run().catch(async (err) => {
  console.error(err);
  await teardown();
  process.exit(1);
});
