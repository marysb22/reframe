// Trainee cohort at creation time and for a whole Group at once. Trainees
// created through Create Group / Create Member had no way to get a cohort
// except one-by-one Edit Member afterward, so most showed "—" everywhere.
//
// Run: node tests/trainee-cohort.test.js (dev server must be running)

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
  if (actual !== expected) throw new Error(`${msg || "not equal"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function request(method, urlPath, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      BASE + urlPath,
      { method, headers: { Authorization: `Bearer ${token}`, ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}) } },
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
const tokenFor = (id, role) => jwt.sign({ id, role }, cfg.jwtSecret, { expiresIn: "1h" });

async function cleanup() {
  const ids = "SELECT id FROM user_credentials WHERE member_code LIKE 'ZZTCOH%'";
  await pool.query(`DELETE FROM supervisor_students WHERE supervisor_id IN (${ids}) OR student_id IN (${ids})`);
  await pool.query(`DELETE FROM payments WHERE student_id IN (${ids})`);
  await pool.query(`DELETE FROM students WHERE id IN (${ids})`);
  await pool.query(`DELETE FROM supervisors WHERE supervisor_type = 'in_training' AND id IN (${ids})`);
  await pool.query(`DELETE FROM supervisors WHERE supervisor_type = 'primary' AND id IN (${ids})`);
  await pool.query("DELETE FROM user_credentials WHERE member_code LIKE 'ZZTCOH%'");
  await pool.query("DELETE FROM trainer_groups WHERE name LIKE 'ZZTCOH%'");
  await pool.query("DELETE FROM cohorts WHERE name LIKE 'ZZTCOH%'");
}
async function cohortOf(memberCode) {
  const { rows } = await pool.query(
    "SELECT c.name FROM user_credentials uc JOIN students st ON st.id = uc.id LEFT JOIN cohorts c ON c.id = st.cohort_id WHERE uc.member_code = ?",
    [memberCode]
  );
  return rows.length ? rows[0].name : undefined;
}

async function main() {
  await cleanup();
  const adminId = (await pool.query("INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES ('ZZTCOHADM', 'x', 'admin', 'active')")).insertId;
  const admin = tokenFor(adminId, "admin");
  let groupId;
  let mtId;

  console.log("Cohort at creation");

  await test("Create Group with a trainees' cohort: every trainee gets it", async () => {
    const res = await request("POST", "/admin/groups", admin, {
      name: "ZZTCOH Group A",
      masterTrainer: { fullName: "ZZTCOH MT", memberCode: "ZZTCOHMT1" },
      trainers: [],
      trainees: [
        { fullName: "ZZTCOH Trainee 1", memberCode: "ZZTCOHS1" },
        { fullName: "ZZTCOH Trainee 2", memberCode: "ZZTCOHS2" },
      ],
      traineeCohort: "ZZTCOH 2026A",
    });
    assertEqual(res.status, 201, "create group");
    groupId = res.body.group.id;
    mtId = res.body.masterTrainer.id;
    assertEqual(await cohortOf("ZZTCOHS1"), "ZZTCOH 2026A", "trainee 1");
    assertEqual(await cohortOf("ZZTCOHS2"), "ZZTCOH 2026A", "trainee 2");
  });

  await test("The cohort shows in the trainer's Trainee Profiles list", async () => {
    const res = await request("GET", "/master-trainer/trainees", tokenFor(mtId, "supervisor"));
    assertEqual(res.status, 200, "status");
    const list = res.body.trainees || [];
    const t = list.find((x) => (x.full_name || x.fullName) === "ZZTCOH Trainee 1");
    const shown = t && (t.cohort ?? t.cohort_name);
    assertEqual(shown, "ZZTCOH 2026A", "cohort returned to the dashboard");
  });

  await test("Create Group without a cohort behaves exactly as before (no cohort)", async () => {
    const res = await request("POST", "/admin/groups", admin, {
      name: "ZZTCOH Group B",
      masterTrainer: { fullName: "ZZTCOH MT B", memberCode: "ZZTCOHMT2" },
      trainers: [],
      trainees: [{ fullName: "ZZTCOH Trainee B1", memberCode: "ZZTCOHB1" }],
    });
    assertEqual(res.status, 201, "create group");
    assertEqual(await cohortOf("ZZTCOHB1"), null, "no cohort");
  });

  await test("Create Member (Trainee) with a cohort", async () => {
    const res = await request("POST", "/admin/trainers", admin, {
      fullName: "ZZTCOH Trainee 3",
      role: "trainee",
      groupId,
      memberCode: "ZZTCOHS3",
      cohort: "ZZTCOH 2026B",
    });
    assertEqual(res.status, 201, "create member");
    assertEqual(await cohortOf("ZZTCOHS3"), "ZZTCOH 2026B", "cohort set");
  });

  await test("Create Member (Trainee) without a cohort still works", async () => {
    const res = await request("POST", "/admin/trainers", admin, { fullName: "ZZTCOH Trainee 4", role: "trainee", groupId, memberCode: "ZZTCOHS4" });
    assertEqual(res.status, 201, "create member");
    assertEqual(await cohortOf("ZZTCOHS4"), null, "no cohort");
  });

  console.log("\nSet cohort for a whole Group");

  await test("Default: only trainees WITHOUT a cohort are filled in", async () => {
    const res = await request("PATCH", `/admin/groups/${groupId}/cohort`, admin, { cohort: "ZZTCOH 2026C" });
    assertEqual(res.status, 200, "status");
    assertEqual(res.body.updated, 1, "only the one empty trainee");
    assertEqual(await cohortOf("ZZTCOHS4"), "ZZTCOH 2026C", "empty one filled");
    assertEqual(await cohortOf("ZZTCOHS1"), "ZZTCOH 2026A", "existing cohort kept");
    assertEqual(await cohortOf("ZZTCOHS3"), "ZZTCOH 2026B", "existing cohort kept");
    assertEqual(await cohortOf("ZZTCOHB1"), null, "another Group untouched");
  });

  await test("overwrite: true replaces every trainee's cohort in that Group only", async () => {
    const res = await request("PATCH", `/admin/groups/${groupId}/cohort`, admin, { cohort: "ZZTCOH 2026D", overwrite: true });
    assertEqual(res.status, 200, "status");
    assertEqual(res.body.updated, 4, "all four trainees");
    for (const c of ["ZZTCOHS1", "ZZTCOHS2", "ZZTCOHS3", "ZZTCOHS4"]) assertEqual(await cohortOf(c), "ZZTCOH 2026D", c);
    assertEqual(await cohortOf("ZZTCOHB1"), null, "another Group untouched");
  });

  await test("Validation and authorization", async () => {
    assertEqual((await request("PATCH", `/admin/groups/${groupId}/cohort`, admin, { cohort: "  " })).status, 400, "empty name");
    assertEqual((await request("PATCH", `/admin/groups/999999999/cohort`, admin, { cohort: "X" })).status, 404, "unknown group");
    assertEqual((await request("PATCH", `/admin/groups/${groupId}/cohort`, tokenFor(mtId, "supervisor"), { cohort: "X" })).status, 403, "non-admin");
  });

  await cleanup();
  const passed = results.filter((r) => r.ok).length;
  console.log("\n" + "=".repeat(60));
  console.log(`${passed}/${results.length} passed`);
  console.log("=".repeat(60));
  process.exit(passed === results.length ? 0 : 1);
}

main().catch(async (err) => {
  console.error("Test run crashed:", err);
  try {
    await cleanup();
  } catch {}
  process.exit(1);
});
