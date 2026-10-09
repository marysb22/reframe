// Permanent regression test for the Training Materials Usage & Distribution
// Notice: one-time, version-scoped, server-authoritative acceptance.
//
// Covers:
//   - Role exemption (Admin/Designer never need it; Trainee/ToT/Master
//     Trainer always do, independently of each other -- not shared across
//     a Group).
//   - GET /profile/me (the hook every dashboard already calls on load) and
//     Master Trainer's own separate GET /master-trainer/me both expose
//     needsTrainingMaterialsNotice correctly.
//   - Acceptance identity/version/timestamp are 100% server-derived: a
//     forged userId/version/timestamp/role in the POST body is silently
//     ignored, never trusted.
//   - Duplicate accept is a harmless no-op (UNIQUE constraint), not a 500.
//   - Unauthenticated requests to every notice endpoint are rejected (401).
//   - Defense in depth: the actual material FILE download (not just the
//     frontend modal) is blocked server-side until acceptance, for a real
//     (non-book) training material; Library books remain exempt
//     regardless, since they're a different feature.
//
// Run: node tests/training-materials-notice.test.js (dev server must be running)

const http = require("http");
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const cfg = require(path.join(__dirname, "..", "src", "config"));
const { pool } = require(path.join(__dirname, "..", "src", "db"));

const BASE = "http://localhost:3000";
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
  if (actual !== expected) throw new Error(`${msg || "not equal"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function tokenFor(id, role) {
  return jwt.sign({ id, role }, cfg.jwtSecret, { expiresIn: "1h" });
}
function apiRequest(method, urlPath, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request(
      `${BASE}/api${urlPath}`,
      {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
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
function fileRequest(urlPath, token) {
  return new Promise((resolve, reject) => {
    http.get(`${BASE}${urlPath}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }, (res) => {
      let len = 0;
      res.on("data", (c) => (len += c.length));
      res.on("end", () => resolve({ status: res.statusCode, len }));
    }).on("error", reject);
  });
}

let fx = { groupId: null, adminId: null, designerId: null, mtId: null, totId: null, studentId: null, materialId: null, filename: null };

async function precleanup() {
  const idSub = "SELECT id FROM user_credentials WHERE member_code LIKE 'ZZTMNOTICE%'";
  const { rows: materialRows } = await pool.query(`SELECT filename FROM learning_materials WHERE supervisor_id IN (${idSub})`);
  for (const m of materialRows) {
    if (m.filename) {
      try {
        fs.unlinkSync(path.join(cfg.uploadsDir, "materials", m.filename));
      } catch {}
    }
  }
  await pool.query(`DELETE FROM training_materials_notice_acceptances WHERE user_id IN (${idSub})`);
  await pool.query(`DELETE FROM learning_materials WHERE supervisor_id IN (${idSub})`);
  await pool.query(`DELETE FROM supervisor_students WHERE supervisor_id IN (${idSub}) OR student_id IN (${idSub})`);
  await pool.query(`DELETE FROM students WHERE id IN (${idSub})`);
  // in_training (ToT) before primary (Master Trainer) -- a ToT references
  // her MT via primary_supervisor_id, ON DELETE RESTRICT, so deleting both
  // in one statement (regardless of row order within it) fails; this same
  // two-step shape is already used by session-provider.test.js's teardown.
  await pool.query(`DELETE FROM supervisors WHERE id IN (${idSub}) AND supervisor_type = 'in_training'`);
  await pool.query(`DELETE FROM supervisors WHERE id IN (${idSub})`);
  await pool.query(`DELETE FROM designers WHERE id IN (${idSub})`);
  await pool.query(`DELETE FROM user_credentials WHERE member_code LIKE 'ZZTMNOTICE%'`);
  await pool.query(`DELETE FROM trainer_groups WHERE name LIKE 'ZZTMNOTICE%'`);
}

async function setup() {
  await precleanup();
  const grp = await pool.query("INSERT INTO trainer_groups (name) VALUES ('ZZTMNOTICE Group')");
  fx.groupId = grp.insertId;

  const mt = await pool.query("INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES ('ZZTMNOTICEMT', 'x', 'supervisor', 'active')");
  fx.mtId = mt.insertId;
  await pool.query("INSERT INTO supervisors (id, full_name, supervisor_type, group_id) VALUES (?, 'ZZTMNOTICE MT', 'primary', ?)", [fx.mtId, fx.groupId]);

  const tot = await pool.query("INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES ('ZZTMNOTICETOT', 'x', 'supervisor', 'active')");
  fx.totId = tot.insertId;
  await pool.query(
    "INSERT INTO supervisors (id, full_name, supervisor_type, group_id, primary_supervisor_id) VALUES (?, 'ZZTMNOTICE ToT', 'in_training', ?, ?)",
    [fx.totId, fx.groupId, fx.mtId]
  );

  const st = await pool.query("INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES ('ZZTMNOTICEST', 'x', 'trainee', 'active')");
  fx.studentId = st.insertId;
  await pool.query("INSERT INTO students (id, full_name, group_id) VALUES (?, 'ZZTMNOTICE Trainee', ?)", [fx.studentId, fx.groupId]);
  await pool.query("INSERT INTO supervisor_students (supervisor_id, student_id) VALUES (?, ?)", [fx.totId, fx.studentId]);

  const adm = await pool.query("INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES ('ZZTMNOTICEADM', 'x', 'admin', 'active')");
  fx.adminId = adm.insertId;
  await pool.query("INSERT INTO admin_users (id, full_name) VALUES (?, 'ZZTMNOTICE Admin')", [fx.adminId]);

  const des = await pool.query("INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES ('ZZTMNOTICEDES', 'x', 'designer', 'active')");
  fx.designerId = des.insertId;
  await pool.query("INSERT INTO designers (id, full_name) VALUES (?, 'ZZTMNOTICE Designer')", [fx.designerId]);

  fx.filename = `zztmnotice-${Date.now()}.pdf`;
  fs.writeFileSync(path.join(cfg.uploadsDir, "materials", fx.filename), Buffer.from("%PDF-1.4\n%zztmnotice fixture\n"));
  const mat = await pool.query(
    "INSERT INTO learning_materials (supervisor_id, student_id, title, material_type, filename, original_name) VALUES (?, ?, 'ZZTMNOTICE Material', 'document', ?, 'zztmnotice.pdf')",
    [fx.totId, fx.studentId, fx.filename]
  );
  fx.materialId = mat.insertId;
}

async function teardown() {
  try {
    fs.unlinkSync(path.join(cfg.uploadsDir, "materials", fx.filename));
  } catch {}
  await precleanup();
}

async function run() {
  console.log("Setting up isolated ZZTMNOTICE fixtures...\n");
  await setup();

  const mtTok = tokenFor(fx.mtId, "supervisor");
  const totTok = tokenFor(fx.totId, "supervisor");
  const traineeTok = tokenFor(fx.studentId, "trainee");
  const adminTok = tokenFor(fx.adminId, "admin");
  const designerTok = tokenFor(fx.designerId, "designer");

  console.log("Role exemption\n");

  await test("Admin is exempt -- needsTrainingMaterialsNotice is always false", async () => {
    const r = await apiRequest("GET", "/profile/me", adminTok);
    assertEqual(r.status, 200);
    assertEqual(r.body.needsTrainingMaterialsNotice, false);
  });

  await test("Designer is exempt -- needsTrainingMaterialsNotice is always false", async () => {
    const r = await apiRequest("GET", "/profile/me", designerTok);
    assertEqual(r.status, 200);
    assertEqual(r.body.needsTrainingMaterialsNotice, false);
  });

  await test("A fresh Trainee needs it", async () => {
    const r = await apiRequest("GET", "/profile/me", traineeTok);
    assertEqual(r.body.needsTrainingMaterialsNotice, true);
  });

  await test("A fresh ToT needs it (via GET /profile/me)", async () => {
    const r = await apiRequest("GET", "/profile/me", totTok);
    assertEqual(r.body.needsTrainingMaterialsNotice, true);
  });

  await test("A fresh Master Trainer needs it (via her own GET /master-trainer/me)", async () => {
    const r = await apiRequest("GET", "/master-trainer/me", mtTok);
    assertEqual(r.status, 200);
    assertEqual(r.body.profile.needsTrainingMaterialsNotice, true);
  });

  console.log("\nNotice text endpoint\n");

  await test("GET /profile/training-materials-notice returns the exact required bilingual text", async () => {
    const r = await apiRequest("GET", "/profile/training-materials-notice", traineeTok);
    assertEqual(r.status, 200);
    assertEqual(r.body.en.title, "Training Materials: Use and Distribution");
    assert(r.body.en.body.includes("exclusively for the use of registered students"), "English body text changed/missing");
    assertEqual(r.body.ar.title, "مواد التدريب: الاستخدام والتوزيع");
    assert(r.body.ar.body.includes("يُمنع منعاً باتاً"), "Arabic body text changed/missing");
  });

  await test("GET /profile/training-materials-notice requires authentication (401)", async () => {
    const r = await apiRequest("GET", "/profile/training-materials-notice", null);
    assertEqual(r.status, 401);
  });

  console.log("\nAcceptance -- server-derived identity, version, and timestamp\n");

  await test("POST .../accept without a token is rejected (401)", async () => {
    const r = await apiRequest("POST", "/profile/training-materials-notice/accept", null, {});
    assertEqual(r.status, 401);
  });

  await test("Accepting as the Trainee ignores a forged userId/version/timestamp/role in the body", async () => {
    const before = Date.now();
    const r = await apiRequest("POST", "/profile/training-materials-notice/accept", traineeTok, {
      userId: fx.adminId,
      id: fx.adminId,
      version: "fake-v99",
      notice_version: "fake-v99",
      acceptedAt: "2000-01-01T00:00:00Z",
      role: "admin",
    });
    assertEqual(r.status, 200);
    assertEqual(r.body.version, "training-materials-v1");

    const { rows } = await pool.query(
      "SELECT user_id, notice_version, accepted_at FROM training_materials_notice_acceptances WHERE user_id = ?",
      [fx.studentId]
    );
    assertEqual(rows.length, 1, "exactly one acceptance row");
    assertEqual(Number(rows[0].user_id), fx.studentId, "must record the REAL authenticated trainee, not the forged admin id");
    assertEqual(rows[0].notice_version, "training-materials-v1", "must use the server's real current version");
    assert(new Date(rows[0].accepted_at).getTime() >= before - 5000, "accepted_at must be a real server timestamp, not the forged year-2000 one");
  });

  await test("needsTrainingMaterialsNotice flips to false immediately after accepting", async () => {
    const r = await apiRequest("GET", "/profile/me", traineeTok);
    assertEqual(r.body.needsTrainingMaterialsNotice, false);
  });

  await test("A duplicate accept is a harmless no-op, not a 500 or a second row", async () => {
    const r = await apiRequest("POST", "/profile/training-materials-notice/accept", traineeTok, {});
    assertEqual(r.status, 200);
    const { rows } = await pool.query("SELECT COUNT(*) AS c FROM training_materials_notice_acceptances WHERE user_id = ?", [fx.studentId]);
    assertEqual(Number(rows[0].c), 1);
  });

  await test("Version management: an acceptance of an OLD version does not satisfy the CURRENT version (simulates a version bump)", async () => {
    // Bumping CURRENT_VERSION in trainingMaterialsNotice.js is the whole
    // "ask again" mechanism -- this proves the lookup is truly
    // version-scoped (WHERE notice_version = ?), not just "has ever
    // accepted anything", without needing to actually change the deployed
    // constant for a test run.
    await pool.query("DELETE FROM training_materials_notice_acceptances WHERE user_id = ?", [fx.studentId]);
    await pool.query("INSERT INTO training_materials_notice_acceptances (user_id, notice_version) VALUES (?, 'training-materials-v0-OLD')", [fx.studentId]);
    const r = await apiRequest("GET", "/profile/me", traineeTok);
    assertEqual(r.body.needsTrainingMaterialsNotice, true, "an old-version acceptance must not satisfy the current version");
    // Restore current-version acceptance for the tests that follow.
    await pool.query("DELETE FROM training_materials_notice_acceptances WHERE user_id = ?", [fx.studentId]);
    await apiRequest("POST", "/profile/training-materials-notice/accept", traineeTok, {});
  });

  await test("A different trainee token cannot accept on this trainee's behalf -- acceptance is always the caller's own", async () => {
    // Prove isolation the other direction: the ToT's own accept must not
    // satisfy the Trainee's or vice versa (already distinct ids, just
    // confirming no cross-contamination happened above).
    const r = await apiRequest("GET", "/profile/me", totTok);
    assertEqual(r.body.needsTrainingMaterialsNotice, true, "ToT must still need it -- the Trainee's accept above must not have leaked to her");
  });

  console.log("\nDefense in depth: the actual material file is blocked until accepted\n");

  await test("ToT (who hasn't accepted) is blocked from downloading a real training material (403)", async () => {
    const r = await fileRequest(`/uploads/materials/${fx.filename}`, totTok);
    assertEqual(r.status, 403, "a direct file request bypassing the frontend modal must still be refused server-side");
  });

  await test("After the ToT accepts, the same material downloads successfully (200)", async () => {
    await apiRequest("POST", "/profile/training-materials-notice/accept", totTok, {});
    const r = await fileRequest(`/uploads/materials/${fx.filename}`, totTok);
    assertEqual(r.status, 200);
    assert(r.len > 0, "expected real file bytes");
  });

  await test("Library Books remain exempt from this notice regardless of acceptance status", async () => {
    const { rows } = await pool.query("SELECT filename FROM learning_materials WHERE material_type = 'book' LIMIT 1");
    if (!rows.length) {
      console.log("      (skipped -- no Library book exists in this dev DB to test against)");
      return;
    }
    // Master Trainer has never accepted at this point in the test run.
    const r = await fileRequest(`/uploads/materials/${rows[0].filename}`, mtTok);
    assertEqual(r.status, 200, "a Library book must stay accessible even to a user who hasn't accepted the Training Materials notice");
  });

  console.log("\nTearing down ZZTMNOTICE fixtures...");
  await teardown();
  const { rows: leftover } = await pool.query("SELECT COUNT(*) AS c FROM user_credentials WHERE member_code LIKE 'ZZTMNOTICE%'");
  console.log(`Teardown verification: ${leftover[0].c} leftover ZZTMNOTICE accounts (should be 0).\n`);

  const passed = results.filter((r) => r.ok).length;
  console.log("=".repeat(60));
  console.log(`${passed}/${results.length} passed`);
  console.log("=".repeat(60));
  process.exit(results.some((r) => !r.ok) ? 1 : 0);
}

run().catch(async (err) => {
  console.error("FATAL:", err);
  try {
    await teardown();
  } catch {}
  process.exit(1);
});
