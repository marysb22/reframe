// Admin's per-trainee "Logged by supervisor" hours card (GET /admin/
// students/:id/profile -> trainingHours.masterTrainer/totTrainers, fed by
// routes/admin.js's getTrainersAndHours) used to group a trainee's
// supervision hours by s.supervisor_id (the session's CREATOR) instead of
// COALESCE(s.provided_by_supervisor_id, s.supervisor_id) (migration 035's
// PROVIDER) -- every other provider-attributed view in the app (Master
// Trainer/ToT dashboards, /me/group-training-breakdown, /me/training-
// delivered) already used the provider; this card was the one place left
// disagreeing, found during a full production audit. Confirmed live repro
// before the fix: MT creates/ToT B provides, 2h supervision -> card showed
// MT=2h, ToT B=0h (exactly backwards).
//
// This test independently computes the expected attribution from the
// fixture's own known inputs (never copies the fix's own SQL) and asserts
// against the live API response -- it must fail again if this card is ever
// reverted to creator-based attribution.
//
// Run: node tests/admin-provider-attribution.test.js (dev server must be running)

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
        try { json = raw ? JSON.parse(raw) : null; } catch {}
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on("error", reject);
    req.end();
  });
}
function tokenFor(id, role) { return jwt.sign({ id, role }, cfg.jwtSecret, { expiresIn: "1h" }); }

let fx = { groupId: null, mtId: null, totId: null, studentId: null, adminId: null };

async function precleanup() {
  const idSub = "SELECT id FROM user_credentials WHERE member_code LIKE 'ZZTADMPROV%'";
  await pool.query(`DELETE FROM attendance WHERE supervisor_id IN (${idSub}) OR student_id IN (${idSub})`);
  await pool.query(`DELETE FROM sessions WHERE supervisor_id IN (${idSub}) OR student_id IN (${idSub})`);
  await pool.query(`DELETE FROM supervisor_students WHERE supervisor_id IN (${idSub}) OR student_id IN (${idSub})`);
  await pool.query(`DELETE FROM supervisors WHERE supervisor_type = 'in_training' AND id IN (${idSub})`);
  await pool.query(`DELETE FROM supervisors WHERE supervisor_type = 'primary' AND id IN (${idSub})`);
  await pool.query(`DELETE FROM students WHERE id IN (${idSub})`);
  await pool.query("DELETE FROM user_credentials WHERE member_code LIKE 'ZZTADMPROV%'");
  await pool.query("DELETE FROM trainer_groups WHERE name LIKE 'ZZTADMPROV%'");
}

async function setup() {
  await precleanup();
  const grp = await pool.query("INSERT INTO trainer_groups (name) VALUES ('ZZTADMPROV Group')");
  fx.groupId = grp.insertId;

  const mt = await pool.query("INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES ('ZZTADMPROVMT', 'x', 'supervisor', 'active')");
  fx.mtId = mt.insertId;
  await pool.query("INSERT INTO supervisors (id, full_name, supervisor_type, group_id) VALUES (?, 'ZZTADMPROV MT', 'primary', ?)", [fx.mtId, fx.groupId]);

  const tot = await pool.query("INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES ('ZZTADMPROVTOT', 'x', 'supervisor', 'active')");
  fx.totId = tot.insertId;
  await pool.query("INSERT INTO supervisors (id, full_name, supervisor_type, primary_supervisor_id, group_id) VALUES (?, 'ZZTADMPROV ToT', 'in_training', ?, ?)", [fx.totId, fx.mtId, fx.groupId]);

  const stu = await pool.query("INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES ('ZZTADMPROVS1', 'x', 'trainee', 'active')");
  fx.studentId = stu.insertId;
  await pool.query("INSERT INTO students (id, full_name, group_id) VALUES (?, 'ZZTADMPROV Trainee', ?)", [fx.studentId, fx.groupId]);
  // Trainee assigned to BOTH supervisors -- getTrainersAndHours only shows
  // supervisors the trainee is actually assigned to via supervisor_students,
  // so both must be assigned for this card to render either of them at all.
  await pool.query("INSERT INTO supervisor_students (supervisor_id, student_id) VALUES (?, ?)", [fx.mtId, fx.studentId]);
  await pool.query("INSERT INTO supervisor_students (supervisor_id, student_id) VALUES (?, ?)", [fx.totId, fx.studentId]);

  const { rows: adminRows } = await pool.query("SELECT id FROM user_credentials WHERE role='admin' AND status='active' LIMIT 1");
  if (!adminRows.length) throw new Error("No active admin account exists in this DB -- this test needs one to borrow a real, valid id from");
  fx.adminId = adminRows[0].id;
}

async function teardown() {
  const inList = `(${fx.studentId})`;
  await pool.query(`DELETE FROM attendance WHERE student_id IN ${inList}`);
  await pool.query(`DELETE FROM sessions WHERE student_id IN ${inList}`);
  await precleanup();
}

/** Creates one standalone session+attendance row directly via SQL, with an
 *  explicit (possibly different) creator and provider, status=present. */
async function mkSession({ creatorId, providedBy, durationMinutes, sessionType = "supervision" }) {
  const s = await pool.query(
    "INSERT INTO sessions (student_id, supervisor_id, provided_by_supervisor_id, session_type, session_date, duration_minutes, status) VALUES (?,?,?,?,CURDATE(),?,'completed')",
    [fx.studentId, creatorId, providedBy, sessionType, durationMinutes]
  );
  await pool.query(
    "INSERT INTO attendance (student_id, supervisor_id, session_id, attendance_date, status, recorded_by) VALUES (?,?,?,CURDATE(),'present',?)",
    [fx.studentId, creatorId, s.insertId, creatorId]
  );
  return s.insertId;
}

async function clearSessions() {
  await pool.query(`DELETE FROM attendance WHERE student_id = ?`, [fx.studentId]);
  await pool.query(`DELETE FROM sessions WHERE student_id = ?`, [fx.studentId]);
}

async function getAdminCardHours(adminToken) {
  const res = await request("GET", `/admin/students/${fx.studentId}/profile`, adminToken);
  if (res.status !== 200) throw new Error(`GET /admin/students/:id/profile failed: ${res.status} ${JSON.stringify(res.body)}`);
  const th = res.body.trainingHours || {};
  const totEntry = (th.totTrainers || []).find((t) => t.fullName === "ZZTADMPROV ToT");
  return {
    mt: th.masterTrainer ? Number(th.masterTrainer.hours) : null,
    tot: totEntry ? Number(totEntry.hours) : null,
  };
}

async function main() {
  console.log("Setting up isolated ZZTADMPROV fixtures...\n");
  await setup();
  const adminToken = tokenFor(fx.adminId, "admin");

  console.log("Admin trainee-profile hours card -- provider attribution\n");

  await test("MT creates, ToT provides, 2h supervision -> card shows MT=0h, ToT=2h", async () => {
    await mkSession({ creatorId: fx.mtId, providedBy: fx.totId, durationMinutes: 120 });
    const h = await getAdminCardHours(adminToken);
    assertEqual(h.mt, 0, "Master Trainer card hours");
    assertEqual(h.tot, 2, "ToT card hours");
    await clearSessions();
  });

  await test("Reversed: ToT creates, MT provides, 2h supervision -> card shows MT=2h, ToT=0h", async () => {
    await mkSession({ creatorId: fx.totId, providedBy: fx.mtId, durationMinutes: 120 });
    const h = await getAdminCardHours(adminToken);
    assertEqual(h.mt, 2, "Master Trainer card hours");
    assertEqual(h.tot, 0, "ToT card hours");
    await clearSessions();
  });

  await test("MT creates, MT provides, 1.5h -> card shows MT=1.5h, ToT=0h", async () => {
    await mkSession({ creatorId: fx.mtId, providedBy: fx.mtId, durationMinutes: 90 });
    const h = await getAdminCardHours(adminToken);
    assertEqual(h.mt, 1.5, "Master Trainer card hours");
    assertEqual(h.tot, 0, "ToT card hours");
    await clearSessions();
  });

  await test("ToT creates, ToT provides, 0.75h -> card shows MT=0h, ToT=0.75h", async () => {
    await mkSession({ creatorId: fx.totId, providedBy: fx.totId, durationMinutes: 45 });
    const h = await getAdminCardHours(adminToken);
    assertEqual(h.mt, 0, "Master Trainer card hours");
    assertEqual(h.tot, 0.75, "ToT card hours");
    await clearSessions();
  });

  await test("Pre-migration row (NULL provider) falls back to creator -- ToT created it, NULL provider -> card shows ToT=1h", async () => {
    const id = await mkSession({ creatorId: fx.totId, providedBy: fx.totId, durationMinutes: 60 });
    await pool.query("UPDATE sessions SET provided_by_supervisor_id = NULL WHERE id = ?", [id]);
    const h = await getAdminCardHours(adminToken);
    assertEqual(h.mt, 0, "Master Trainer card hours");
    assertEqual(h.tot, 1, "ToT card hours (fallback to creator)");
    await clearSessions();
  });

  await test("Editing a session's provider updates the card immediately -- old provider loses it, new provider gains it", async () => {
    const id = await mkSession({ creatorId: fx.totId, providedBy: fx.totId, durationMinutes: 60 });
    let h = await getAdminCardHours(adminToken);
    assertEqual(h.tot, 1, "ToT card hours before reassignment");
    assertEqual(h.mt, 0, "MT card hours before reassignment");
    await pool.query("UPDATE sessions SET provided_by_supervisor_id = ? WHERE id = ?", [fx.mtId, id]);
    h = await getAdminCardHours(adminToken);
    assertEqual(h.tot, 0, "ToT card hours after reassignment (lost it)");
    assertEqual(h.mt, 1, "MT card hours after reassignment (gained it)");
    await clearSessions();
  });

  await test("Deleting a session removes its hours from the card", async () => {
    const id = await mkSession({ creatorId: fx.mtId, providedBy: fx.totId, durationMinutes: 120 });
    let h = await getAdminCardHours(adminToken);
    assertEqual(h.tot, 2, "ToT card hours before delete");
    await pool.query("DELETE FROM attendance WHERE session_id = ?", [id]);
    await pool.query("DELETE FROM sessions WHERE id = ?", [id]);
    h = await getAdminCardHours(adminToken);
    assertEqual(h.tot, 0, "ToT card hours after delete");
  });

  await test("Multi-day Session (occasion-based): 3 days, 1h+1h+0.5h, MT creates/ToT provides -> card shows ToT=2.5h", async () => {
    const occ1 = await pool.query(
      "INSERT INTO session_occasions (supervisor_id, provided_by_supervisor_id, session_type, session_date, duration_minutes) VALUES (?,?,?,CURDATE(),?)",
      [fx.mtId, fx.totId, "supervision", 60]
    );
    const occ2 = await pool.query(
      "INSERT INTO session_occasions (supervisor_id, provided_by_supervisor_id, session_type, session_date, duration_minutes) VALUES (?,?,?,CURDATE(),?)",
      [fx.mtId, fx.totId, "supervision", 60]
    );
    const occ3 = await pool.query(
      "INSERT INTO session_occasions (supervisor_id, provided_by_supervisor_id, session_type, session_date, duration_minutes) VALUES (?,?,?,CURDATE(),?)",
      [fx.mtId, fx.totId, "supervision", 30]
    );
    for (const occId of [occ1.insertId, occ2.insertId, occ3.insertId]) {
      const s = await pool.query(
        "INSERT INTO sessions (student_id, supervisor_id, provided_by_supervisor_id, session_type, session_date, duration_minutes, status, occasion_id) VALUES (?,?,?,?,CURDATE(),(SELECT duration_minutes FROM session_occasions WHERE id=?),'completed',?)",
        [fx.studentId, fx.mtId, fx.totId, "supervision", occId, occId]
      );
      await pool.query(
        "INSERT INTO attendance (student_id, supervisor_id, session_id, attendance_date, status, recorded_by) VALUES (?,?,?,CURDATE(),'present',?)",
        [fx.studentId, fx.mtId, s.insertId, fx.mtId]
      );
    }
    const h = await getAdminCardHours(adminToken);
    assertEqual(h.tot, 2.5, "ToT card hours across the 3-day Session (occasion-based, this card's formula has no occasion-dedup, so each day's own row sums individually -- correct here since each occasion has exactly 1 trainee/1 session row, not fanned out)");
    assertEqual(h.mt, 0, "MT card hours (she only created these, didn't provide)");
    await clearSessions();
    await pool.query("DELETE FROM session_occasions WHERE id IN (?,?,?)", [occ1.insertId, occ2.insertId, occ3.insertId]);
  });

  console.log("\nTearing down ZZTADMPROV fixtures...");
  await teardown();
  const { rows: leftover } = await pool.query("SELECT COUNT(*) AS c FROM user_credentials WHERE member_code LIKE 'ZZTADMPROV%'");
  console.log(`Teardown verification: ${leftover[0].c} leftover ZZTADMPROV accounts (should be 0).`);

  const passed = results.filter((r) => r.ok).length;
  console.log("\n" + "=".repeat(60));
  console.log(`${passed}/${results.length} passed`);
  console.log("=".repeat(60));
  if (passed !== results.length) process.exit(1);
}

main().catch(async (err) => {
  console.error("FATAL:", err);
  try { await teardown(); } catch {}
  process.exit(1);
});
