// "Hours Provided By" (migration 035) -- a session's CREATOR (supervisor_id/
// master_trainer_id, unchanged) can now differ from whose delivered hours
// it counts toward (provided_by_supervisor_id). A ToT can log a session on
// her Master Trainer's behalf; the hours must attribute to the Master
// Trainer's delivered-hours total, not the ToT's, while the trainee's own
// total stays exactly the same either way.
//
// Run: node tests/session-provider.test.js (dev server must be running)

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
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
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

let fx = { groupId: null, mtId: null, totId: null, tot2Id: null, studentIds: [] };

async function precleanup() {
  const idSubquery = "SELECT id FROM user_credentials WHERE member_code LIKE 'ZZTPROV%'";
  // Everything that could still reference one of these supervisors/students
  // (from a prior run's teardown failing partway through) must go first --
  // attendance/sessions/occasions/series, then supervisor_students, then
  // the supervisors themselves (in_training before primary, since a ToT
  // references her Master Trainer via primary_supervisor_id, ON DELETE
  // RESTRICT), then students, then the login rows, then the Group.
  await pool.query(`DELETE FROM attendance WHERE supervisor_id IN (${idSubquery}) OR student_id IN (${idSubquery})`);
  await pool.query(`DELETE FROM sessions WHERE supervisor_id IN (${idSubquery}) OR student_id IN (${idSubquery})`);
  await pool.query(`DELETE FROM session_occasions WHERE supervisor_id IN (${idSubquery})`);
  await pool.query(`DELETE FROM session_series WHERE supervisor_id IN (${idSubquery})`);
  await pool.query(`DELETE FROM supervisor_students WHERE supervisor_id IN (${idSubquery}) OR student_id IN (${idSubquery})`);
  await pool.query(`DELETE FROM supervisors WHERE supervisor_type = 'in_training' AND id IN (${idSubquery})`);
  await pool.query(`DELETE FROM supervisors WHERE supervisor_type = 'primary' AND id IN (${idSubquery})`);
  await pool.query(`DELETE FROM students WHERE id IN (${idSubquery})`);
  await pool.query("DELETE FROM user_credentials WHERE member_code LIKE 'ZZTPROV%'");
  await pool.query("DELETE FROM trainer_groups WHERE name LIKE 'ZZTPROV%'");
}

async function setup() {
  await precleanup();
  const grp = await pool.query("INSERT INTO trainer_groups (name) VALUES ('ZZTPROV Group')");
  fx.groupId = grp.insertId;

  const mtCred = await pool.query(
    "INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES ('ZZTPROVMT', 'x', 'supervisor', 'active')"
  );
  fx.mtId = mtCred.insertId;
  await pool.query("INSERT INTO supervisors (id, full_name, supervisor_type, group_id) VALUES (?, 'ZZTPROV Master Trainer', 'primary', ?)", [
    fx.mtId,
    fx.groupId,
  ]);

  const totCred = await pool.query(
    "INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES ('ZZTPROVTOT', 'x', 'supervisor', 'active')"
  );
  fx.totId = totCred.insertId;
  await pool.query(
    "INSERT INTO supervisors (id, full_name, supervisor_type, primary_supervisor_id, group_id) VALUES (?, 'ZZTPROV ToT Mary', 'in_training', ?, ?)",
    [fx.totId, fx.mtId, fx.groupId]
  );

  // A second ToT, outside this Group -- used to confirm an unauthorized
  // providedBySupervisorId is rejected.
  const grp2 = await pool.query("INSERT INTO trainer_groups (name) VALUES ('ZZTPROV Outside Group')");
  const mt2Cred = await pool.query(
    "INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES ('ZZTPROVMT2', 'x', 'supervisor', 'active')"
  );
  await pool.query("INSERT INTO supervisors (id, full_name, supervisor_type, group_id) VALUES (?, 'ZZTPROV Outside MT', 'primary', ?)", [
    mt2Cred.insertId,
    grp2.insertId,
  ]);
  const tot2Cred = await pool.query(
    "INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES ('ZZTPROVTOT2', 'x', 'supervisor', 'active')"
  );
  fx.tot2Id = tot2Cred.insertId;
  await pool.query(
    "INSERT INTO supervisors (id, full_name, supervisor_type, primary_supervisor_id, group_id) VALUES (?, 'ZZTPROV Outside ToT', 'in_training', ?, ?)",
    [fx.tot2Id, mt2Cred.insertId, grp2.insertId]
  );

  for (let i = 1; i <= 2; i++) {
    const c = await pool.query(
      "INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES (?, 'x', 'trainee', 'active')",
      [`ZZTPROVS${i}`]
    );
    const id = c.insertId;
    fx.studentIds.push(id);
    await pool.query("INSERT INTO students (id, full_name, group_id) VALUES (?, ?, ?)", [id, `ZZTPROV Trainee ${i}`, fx.groupId]);
    await pool.query("INSERT INTO supervisor_students (supervisor_id, student_id) VALUES (?, ?)", [fx.totId, id]);
  }
}

async function teardown() {
  const inList = fx.studentIds.map(() => "?").join(",");
  if (fx.studentIds.length) {
    await pool.query(`DELETE FROM attendance WHERE student_id IN (${inList})`, fx.studentIds);
    await pool.query(`DELETE FROM sessions WHERE student_id IN (${inList})`, fx.studentIds);
  }
  await precleanup();
}

async function main() {
  console.log("Setting up isolated ZZTPROV fixtures...\n");
  await setup();
  const totToken = tokenFor(fx.totId, "supervisor");
  const mtToken = tokenFor(fx.mtId, "supervisor");
  const traineeToken = tokenFor(fx.studentIds[0], "trainee");

  console.log("\nHours Provided By -- creation + attribution");

  let occasionId;
  await test("ToT creates a session with providedBySupervisorId = her Master Trainer", async () => {
    const res = await request("POST", "/supervisor/session-occasions", totToken, {
      sessionType: "training",
      title: "ZZTPROV On MT's behalf",
      date: new Date().toISOString().slice(0, 10),
      durationMinutes: 300, // 5h
      providedBySupervisorId: fx.mtId,
    });
    assertEqual(res.status, 201, "expected 201");
    occasionId = res.body.occasionId;
    assert(occasionId, "expected an occasionId back");
    // Mark both trainees present so the hours actually land somewhere.
    await pool.query(
      "UPDATE sessions SET status='completed' WHERE occasion_id = ?",
      [occasionId]
    );
    for (const sid of fx.studentIds) {
      const { rows: sessRows } = await pool.query("SELECT id FROM sessions WHERE occasion_id = ? AND student_id = ?", [occasionId, sid]);
      const sess = sessRows[0];
      await pool.query(
        "INSERT INTO attendance (student_id, supervisor_id, session_id, attendance_date, status, recorded_by) VALUES (?, ?, ?, CURDATE(), 'present', ?)",
        [sid, fx.totId, sess.id, fx.totId]
      );
    }
  });

  await test("Master Trainer receives the 5 hours in the Group breakdown, not the ToT", async () => {
    const res = await request("GET", "/supervisor/me/group-training-breakdown", mtToken);
    assertEqual(res.status, 200, "expected 200");
    const mtRow = res.body.breakdown.find((b) => b.supervisorId === fx.mtId);
    const totRow = res.body.breakdown.find((b) => b.supervisorId === fx.totId);
    assert(mtRow, "Master Trainer should appear in the breakdown");
    assertEqual(mtRow.hours, 5, "Master Trainer should show exactly the 5 provided hours");
    assertEqual(totRow.hours, 0, "ToT should show 0 -- she created it, but didn't provide the hours");
  });

  await test("The ToT's own /me/training-delivered total does NOT include those 5 hours", async () => {
    const res = await request("GET", "/supervisor/me/training-delivered", totToken);
    assertEqual(res.status, 200, "expected 200");
    assertEqual(res.body.totalHours, 0, "the ToT created the session but isn't its provider -- her own delivered total must stay 0");
  });

  await test("Trainees' own total hours include the session regardless of provider", async () => {
    for (const sid of fx.studentIds) {
      const res = await request("GET", "/profile/progress", tokenFor(sid, "trainee"));
      assertEqual(res.status, 200, "expected 200");
      assert(res.body.trainingHours >= 5, "trainee's training hours should include the 5h session regardless of who provided it");
    }
  });

  await test("Omitted providedBySupervisorId defaults to the creator (regression guard)", async () => {
    const res = await request("POST", "/supervisor/session-occasions", totToken, {
      sessionType: "training",
      title: "ZZTPROV Default provider",
      date: new Date().toISOString().slice(0, 10),
      durationMinutes: 180, // 3h
    });
    assertEqual(res.status, 201, "expected 201");
    const { rows } = await pool.query("SELECT supervisor_id, provided_by_supervisor_id FROM session_occasions WHERE id = ?", [
      res.body.occasionId,
    ]);
    assertEqual(Number(rows[0].provided_by_supervisor_id), Number(rows[0].supervisor_id), "provider should default to creator");
    await pool.query("DELETE FROM sessions WHERE occasion_id = ?", [res.body.occasionId]);
    await pool.query("DELETE FROM session_occasions WHERE id = ?", [res.body.occasionId]);
  });

  await test("providedBySupervisorId for someone outside the Group is rejected (400)", async () => {
    const res = await request("POST", "/supervisor/session-occasions", totToken, {
      sessionType: "training",
      title: "ZZTPROV Unauthorized provider",
      date: new Date().toISOString().slice(0, 10),
      durationMinutes: 60,
      providedBySupervisorId: fx.tot2Id,
    });
    assertEqual(res.status, 400, "expected 400 rejecting an out-of-Group provider");
  });

  await test("A trainee token cannot hit the session-occasions route at all (role gate)", async () => {
    const res = await request("POST", "/supervisor/session-occasions", traineeToken, {
      sessionType: "training",
      title: "ZZTPROV Trainee attempt",
      date: new Date().toISOString().slice(0, 10),
      durationMinutes: 60,
      providedBySupervisorId: fx.mtId,
    });
    assertEqual(res.status, 403, "expected 403 -- trainees have no access to this route at all");
  });

  console.log("\nMulti-day Session -- provider cascades to every day");

  let seriesId;
  await test("Multi-day Session: providedBySupervisorId cascades to every day", async () => {
    const today = new Date();
    const d1 = new Date(today.getTime() - 2 * 86400000).toISOString().slice(0, 10);
    const d2 = new Date(today.getTime() - 1 * 86400000).toISOString().slice(0, 10);
    const res = await request("POST", "/supervisor/session-occasions", totToken, {
      sessionType: "training",
      title: "ZZTPROV Multi-day",
      days: [
        { date: d1, durationMinutes: 120 },
        { date: d2, durationMinutes: 120 },
      ],
      providedBySupervisorId: fx.mtId,
    });
    assertEqual(res.status, 201, "expected 201");
    seriesId = res.body.seriesId;
    const { rows } = await pool.query(
      "SELECT provided_by_supervisor_id FROM session_occasions WHERE series_id = ?",
      [seriesId]
    );
    assertEqual(rows.length, 2, "expected 2 days");
    rows.forEach((r) => assertEqual(Number(r.provided_by_supervisor_id), fx.mtId, "every day should carry the series' provider"));
  });

  await test("Editing the series' provider updates every day consistently", async () => {
    const { rows: dayRows } = await pool.query("SELECT id, session_date, duration_minutes FROM session_occasions WHERE series_id = ? ORDER BY session_date", [
      seriesId,
    ]);
    const days = dayRows.map((d) => ({
      occasionId: d.id,
      date: String(d.session_date).slice(0, 10),
      durationMinutes: d.duration_minutes,
    }));
    const res = await request("PUT", `/supervisor/session-series/${seriesId}`, totToken, {
      title: "ZZTPROV Multi-day",
      days,
      providedBySupervisorId: fx.totId,
    });
    assertEqual(res.status, 200, "expected 200");
    const { rows } = await pool.query("SELECT provided_by_supervisor_id FROM session_occasions WHERE series_id = ?", [seriesId]);
    rows.forEach((r) => assertEqual(Number(r.provided_by_supervisor_id), fx.totId, "every day should reflect the updated provider"));
  });

  console.log("\nCleaning up ZZTPROV fixtures...");
  await teardown();

  const passed = results.filter((r) => r.ok).length;
  console.log("\n" + "=".repeat(60));
  console.log(`${passed}/${results.length} passed`);
  console.log("=".repeat(60));
  if (passed !== results.length) process.exit(1);
}

main().catch(async (err) => {
  console.error("FATAL:", err);
  try {
    await teardown();
  } catch {}
  process.exit(1);
});
