// Trainee Profile / Trainees section audit -- automated regression suite.
//
// This project has no test framework wired up (package.json's "test"
// script is a stub, no jest/mocha dependency, no existing test files) --
// rather than bolt on a framework as a side effect of this audit, this is
// a small, dependency-free runner: plain Node, real HTTP calls against the
// dev server (must already be running on :3000), real queries against the
// dev DB via the app's own pool. Each test creates its own isolated
// fixtures (ZZTAUDIT-prefixed) and the suite deletes every one of them in
// a `finally` block, whether tests pass or fail, so a run never leaves
// residue in the dev DB and never touches real data.
//
// Run: node tests/trainee-profile-audit.test.js
// Requires: dev server running on http://localhost:3000

const http = require("http");
const jwt = require("jsonwebtoken");
const path = require("path");
const cfg = require(path.join(__dirname, "..", "src", "config"));
const { pool } = require(path.join(__dirname, "..", "src", "db"));

const BASE = "http://localhost:3000/api";

// ---- tiny test runner ------------------------------------------------
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
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}
function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || "not equal"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ---- HTTP helper -------------------------------------------------------
function request(method, urlPath, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      BASE + urlPath,
      {
        method,
        headers: {
          Authorization: token ? `Bearer ${token}` : undefined,
          "Content-Type": "application/json",
          "Content-Length": data ? Buffer.byteLength(data) : 0,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            /* non-JSON response (e.g. an unmatched route's HTML 404) */
          }
          resolve({ status: res.statusCode, body: json, raw });
        });
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function tokenFor(id, role) {
  return jwt.sign({ id, role }, cfg.jwtSecret, { expiresIn: "1h" });
}

// ---- fixture setup -------------------------------------------------------
// All test rows use member codes prefixed ZZTAUDIT so they're trivially
// identifiable and never collide with real data or other ZZTest fixtures
// already living in this dev DB from earlier manual testing.

let fixtures = {
  groupId: null,
  supervisorId: null, // reused: ZZTest PayMT (id 326), a supervisor_type='primary' fixture already used throughout this session
  studentComplete: null, // real cohort, real year, real hours/attendance
  studentNoCohort: null, // training_start_date set, cohort_id null
  studentNoYearStarted: null, // training_start_date in the future (not started)
  studentCompleted: null, // training already finished
  studentOtherSupervisor: null, // NOT assigned to fixtures.supervisorId -- isolation/scoping check
  otherSupervisorId: null,
};

async function setup() {
  const grp = await pool.query("INSERT INTO trainer_groups (name) VALUES ('ZZTAUDIT Group')");
  fixtures.groupId = grp.insertId;

  fixtures.supervisorId = 326; // pre-existing 'primary' supervisor fixture, reused across this whole session
  await pool.query("UPDATE supervisors SET group_id = ? WHERE id = ?", [fixtures.groupId, fixtures.supervisorId]);

  const mkTrainee = async (code, name, { startDate, durationYears, cohortName, assign = true } = {}) => {
    const cred = await pool.query(
      "INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES (?, 'x', 'trainee', 'active')",
      [code]
    );
    const id = cred.insertId;
    let cohortId = null;
    if (cohortName) {
      const c = await pool.query("INSERT INTO cohorts (name) VALUES (?)", [cohortName]);
      cohortId = c.insertId;
    }
    await pool.query(
      "INSERT INTO students (id, full_name, group_id, cohort_id, training_start_date, training_duration_years) VALUES (?, ?, ?, ?, ?, ?)",
      [id, name, fixtures.groupId, cohortId, startDate || null, durationYears || null]
    );
    if (assign) {
      await pool.query("INSERT INTO supervisor_students (supervisor_id, student_id) VALUES (?, ?)", [
        fixtures.supervisorId,
        id,
      ]);
    }
    return id;
  };

  fixtures.studentComplete = await mkTrainee("ZZTAUDIT1", "ZZTAudit Complete", {
    startDate: "2026-01-01",
    durationYears: 2,
    cohortName: "ZZTAUDIT Cohort A",
  });
  fixtures.studentNoCohort = await mkTrainee("ZZTAUDIT2", "ZZTAudit NoCohort", {
    startDate: "2025-06-01",
    durationYears: 4,
  });
  fixtures.studentNoYearStarted = await mkTrainee("ZZTAUDIT3", "ZZTAudit NotStarted", {
    startDate: "2099-01-01",
    durationYears: 4,
  });
  fixtures.studentCompleted = await mkTrainee("ZZTAUDIT4", "ZZTAudit Completed", {
    startDate: "2010-01-01",
    durationYears: 4,
  });

  // A second, unrelated supervisor + trainee pair -- used to prove no
  // cross-trainee/cross-supervisor leakage (section 3's "incorrect
  // tenant/group/MT/ToT scoping" and "no accidental cross-trainee data").
  const otherCred = await pool.query(
    "INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES ('ZZTAUDITSUP', 'x', 'supervisor', 'active')"
  );
  fixtures.otherSupervisorId = otherCred.insertId;
  await pool.query("INSERT INTO supervisors (id, full_name, supervisor_type) VALUES (?, 'ZZTAudit Other Supervisor', 'primary')", [
    fixtures.otherSupervisorId,
  ]);
  fixtures.studentOtherSupervisor = await mkTrainee("ZZTAUDIT5", "ZZTAudit OtherSup", {
    startDate: "2026-01-01",
    durationYears: 4,
    assign: false,
  });
  await pool.query("INSERT INTO supervisor_students (supervisor_id, student_id) VALUES (?, ?)", [
    fixtures.otherSupervisorId,
    fixtures.studentOtherSupervisor,
  ]);

  // Real hours + attendance for studentComplete, so hours/attendance
  // calculations have real, non-zero data to check consistency against.
  const occ = await pool.query(
    "INSERT INTO session_occasions (supervisor_id, session_type, title, session_date, duration_minutes) VALUES (?, 'training', 'ZZTAUDIT Session', '2026-09-20', 300)",
    [fixtures.supervisorId]
  );
  const sess = await pool.query(
    "INSERT INTO sessions (student_id, supervisor_id, session_type, session_date, duration_minutes, status, occasion_id) VALUES (?, ?, 'training', '2026-09-20', 300, 'completed', ?)",
    [fixtures.studentComplete, fixtures.supervisorId, occ.insertId]
  );
  await pool.query(
    "INSERT INTO attendance (student_id, supervisor_id, session_id, attendance_date, status, recorded_by) VALUES (?, ?, ?, '2026-09-20', 'present', ?)",
    [fixtures.studentComplete, fixtures.supervisorId, sess.insertId, fixtures.supervisorId]
  );
  fixtures.occasionId = occ.insertId;
}

async function teardown() {
  const ids = [
    fixtures.studentComplete,
    fixtures.studentNoCohort,
    fixtures.studentNoYearStarted,
    fixtures.studentCompleted,
    fixtures.studentOtherSupervisor,
  ].filter(Boolean);
  if (ids.length) {
    await pool.query(`DELETE FROM attendance WHERE student_id IN (${ids.map(() => "?").join(",")})`, ids);
    await pool.query(`DELETE FROM sessions WHERE student_id IN (${ids.map(() => "?").join(",")})`, ids);
  }
  if (fixtures.occasionId) await pool.query("DELETE FROM session_occasions WHERE id = ?", [fixtures.occasionId]);
  if (ids.length) {
    await pool.query(`DELETE FROM supervisor_students WHERE student_id IN (${ids.map(() => "?").join(",")})`, ids);
    await pool.query(`DELETE FROM students WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
    await pool.query(
      `DELETE FROM user_credentials WHERE id IN (${ids.map(() => "?").join(",")})`,
      ids
    );
  }
  if (fixtures.otherSupervisorId) {
    await pool.query("DELETE FROM supervisors WHERE id = ?", [fixtures.otherSupervisorId]);
    await pool.query("DELETE FROM user_credentials WHERE id = ?", [fixtures.otherSupervisorId]);
  }
  await pool.query("DELETE FROM cohorts WHERE name LIKE 'ZZTAUDIT%'");
  if (fixtures.supervisorId) await pool.query("UPDATE supervisors SET group_id = NULL WHERE id = ?", [fixtures.supervisorId]);
  if (fixtures.groupId) await pool.query("DELETE FROM trainer_groups WHERE id = ?", [fixtures.groupId]);
}

// ---- the actual test scenarios -------------------------------------------

async function run() {
  console.log("Setting up isolated ZZTAUDIT fixtures...");
  await setup();

  try {
    const supToken = tokenFor(fixtures.supervisorId, "supervisor");
    const adminToken = tokenFor(1, "admin"); // ADM001, the seeded static Admin account

    console.log("\nBackend/API -- Trainees list (GET /supervisor/students)");
    await test("full data trainee: cohort and year are real values, not '--'/null", async () => {
      const r = await request("GET", "/supervisor/students", supToken);
      assertEqual(r.status, 200);
      const s = r.body.students.find((x) => x.id === fixtures.studentComplete);
      assert(s, "trainee not found in list");
      assertEqual(s.cohort, "ZZTAUDIT Cohort A", "cohort mismatch");
      assertEqual(s.currentYear, 1, "currentYear should be computed Year 1 (2026-01-01 start, 2yr program, tested at 2026-09-30)");
    });
    await test("no-cohort trainee: cohort null, year still computed", async () => {
      const r = await request("GET", "/supervisor/students", supToken);
      const s = r.body.students.find((x) => x.id === fixtures.studentNoCohort);
      assert(s, "trainee not found");
      assertEqual(s.cohort, null, "cohort should be null (genuinely unset), not a placeholder");
      assertEqual(s.currentYear, 2, "2025-06-01 start, 4yr program -> Year 2 as of 2026-09-30");
    });
    await test("not-yet-started trainee: year is null (not 0, not a fake '1')", async () => {
      const r = await request("GET", "/supervisor/students", supToken);
      const s = r.body.students.find((x) => x.id === fixtures.studentNoYearStarted);
      assertEqual(s.currentYear, null);
    });
    await test("completed trainee: year is null (program already finished)", async () => {
      const r = await request("GET", "/supervisor/students", supToken);
      const s = r.body.students.find((x) => x.id === fixtures.studentCompleted);
      assertEqual(s.currentYear, null);
    });
    await test("cross-supervisor isolation: a ToT's list never includes another ToT's trainee", async () => {
      const r = await request("GET", "/supervisor/students", supToken);
      const leaked = r.body.students.find((x) => x.id === fixtures.studentOtherSupervisor);
      assert(!leaked, "another supervisor's trainee leaked into this supervisor's list");
    });

    console.log("\nBackend/API -- Trainee Profile detail (GET /supervisor/students/:id)");
    await test("detail view matches list view for the same trainee (cohort/year)", async () => {
      const list = await request("GET", "/supervisor/students", supToken);
      const listRow = list.body.students.find((x) => x.id === fixtures.studentComplete);
      const detail = await request("GET", `/supervisor/students/${fixtures.studentComplete}`, supToken);
      assertEqual(detail.status, 200);
      assertEqual(detail.body.student.cohort, listRow.cohort, "cohort differs between list and detail views");
      assertEqual(detail.body.student.currentYear, listRow.currentYear, "currentYear differs between list and detail views");
    });
    await test("attendance rate and training hours reflect the real recorded session", async () => {
      const detail = await request("GET", `/supervisor/students/${fixtures.studentComplete}`, supToken);
      assertEqual(detail.body.progress.clinicalHours, 5, "5h session, present -> 5 clinical hours");
      assertEqual(detail.body.progress.attendanceRate, 100, "1 of 1 attendance record present -> 100%");
      assertEqual(detail.body.progress.trainingSessions, 1);
    });
    await test("unauthorized: a supervisor cannot open a trainee they aren't assigned to", async () => {
      const r = await request("GET", `/supervisor/students/${fixtures.studentOtherSupervisor}`, supToken);
      assertEqual(r.status, 403);
    });
    await test("invalid trainee id: not silently ignored, not another trainee's data", async () => {
      const r = await request("GET", "/supervisor/students/9999999", supToken);
      assert(r.status === 403 || r.status === 404, `expected 403/404 for a non-existent id, got ${r.status}`);
    });

    console.log("\nCross-system consistency -- Admin vs ToT vs the trainee's own My Profile");
    await test("Admin's deduplicated hours computation matches computeProgressSummary exactly", async () => {
      const adminProfile = await request("GET", `/admin/students/${fixtures.studentComplete}/profile`, adminToken);
      assertEqual(adminProfile.status, 200);
      assertEqual(adminProfile.body.progress.clinicalHours, 5);
      assertEqual(
        adminProfile.body.trainingHours.trainee.hours,
        adminProfile.body.progress.clinicalHours,
        "getTrainersAndHours' trainingHours.trainee.hours must equal progress.clinicalHours -- same trainee, same formula, single source of truth"
      );
    });
    await test("trainee's own My Profile shows the identical hours total as ToT/Admin views", async () => {
      const traineeToken = tokenFor(fixtures.studentComplete, "trainee");
      const own = await request("GET", "/profile/progress", traineeToken);
      assertEqual(own.status, 200);
      assertEqual(own.body.clinicalHours, 5);
      assertEqual(own.body.attendanceRate, 100);
    });
    await test("Admin's trainee list also shows the same computed cohort/year (not the dead current_year column)", async () => {
      const r = await request("GET", `/admin/users?role=trainee&pageSize=200`, adminToken);
      const u = r.body.users.find((x) => x.id === fixtures.studentComplete);
      assert(u, "trainee not in admin list");
      assertEqual(u.cohort, "ZZTAUDIT Cohort A");
      assertEqual(u.currentYear, 1);
    });

    console.log("\nDatabase/query -- no duplicate or leaking records");
    await test("no duplicate attendance rows were created by fixture setup (sanity check on the harness itself)", async () => {
      const { rows } = await pool.query("SELECT COUNT(*) c FROM attendance WHERE student_id = ?", [
        fixtures.studentComplete,
      ]);
      assertEqual(Number(rows[0].c), 1);
    });
    await test("deleting a session leaves no orphaned attendance row (regression check for the earlier delete-cascade fix)", async () => {
      await request("DELETE", `/supervisor/session-occasions/${fixtures.occasionId}`, supToken);
      const { rows } = await pool.query("SELECT COUNT(*) c FROM attendance WHERE student_id = ? AND session_id IS NULL", [
        fixtures.studentComplete,
      ]);
      assertEqual(Number(rows[0].c), 0, "orphaned attendance row survived the session delete");
      fixtures.occasionId = null; // already deleted, don't try again in teardown
    });

    console.log("\nRegression -- adjacent functionality still works");
    await test("health info endpoint still responds for an assigned trainee (Health & Emergency tab)", async () => {
      const r = await request("GET", `/supervisor/students/${fixtures.studentComplete}/health`, supToken);
      assertEqual(r.status, 200);
    });
    await test("milestones endpoint still responds for an assigned trainee (Milestones tab)", async () => {
      const r = await request("GET", `/supervisor/students/${fixtures.studentComplete}/milestones`, supToken);
      assertEqual(r.status, 200);
      assert(Array.isArray(r.body.milestones));
    });
  } finally {
    console.log("\nTearing down ZZTAUDIT fixtures...");
    await teardown();
    const { rows: leftoverAtt } = await pool.query(
      "SELECT COUNT(*) c FROM attendance a JOIN user_credentials uc ON uc.id = a.student_id WHERE uc.member_code LIKE 'ZZTAUDIT%'"
    );
    const { rows: leftoverStudents } = await pool.query(
      "SELECT COUNT(*) c FROM user_credentials WHERE member_code LIKE 'ZZTAUDIT%'"
    );
    console.log(`Teardown verification: ${leftoverStudents[0].c} leftover ZZTAUDIT accounts, ${leftoverAtt[0].c} leftover attendance rows (both should be 0).`);
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
