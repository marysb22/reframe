// Private Trainer Space / Trainer Reports (migration 040): training-team
// content shared only between a Group's Master Trainer and ToTs (or with
// one specific trainer), never reachable by a trainee -- not through any
// list, the API, or a direct file URL -- and never across Groups. Also
// covers the file-download hole this closes (a trainee of the author used
// to be able to download a trainer-only file by URL) and that ordinary
// trainee-facing materials keep working exactly as before.
//
// Run: node tests/trainer-space.test.js (dev server running, migration 040 applied)

const http = require("http");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cfg = require(path.join(__dirname, "..", "src", "config"));
const { pool } = require(path.join(__dirname, "..", "src", "db"));
const { CURRENT_VERSION } = require(path.join(__dirname, "..", "src", "utils", "trainingMaterialsNotice"));

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
function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || "not equal"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}
function request(method, urlPath, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      BASE + urlPath,
      { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}) } },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {}
          resolve({ status: res.statusCode, body: json, raw });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const api = (m, p, t, b) => request(m, "/api" + p, t, b);
const download = (filename, token) => request("GET", `/uploads/materials/${filename}?token=${encodeURIComponent(token)}`);
const tokenFor = (id, role) => jwt.sign({ id, role }, cfg.jwtSecret, { expiresIn: "1h" });

const fx = { files: [] };
async function cleanup() {
  const ids = "SELECT id FROM user_credentials WHERE member_code LIKE 'ZZTTS%'";
  await pool.query(`DELETE FROM notifications WHERE recipient_id IN (${ids})`);
  await pool.query(`DELETE FROM learning_materials WHERE supervisor_id IN (${ids})`);
  await pool.query(`DELETE FROM training_materials_notice_acceptances WHERE user_id IN (${ids})`);
  await pool.query(`DELETE FROM supervisor_students WHERE supervisor_id IN (${ids}) OR student_id IN (${ids})`);
  await pool.query(`DELETE FROM supervisors WHERE supervisor_type = 'in_training' AND id IN (${ids})`);
  await pool.query(`DELETE FROM supervisors WHERE supervisor_type = 'primary' AND id IN (${ids})`);
  await pool.query(`DELETE FROM students WHERE id IN (${ids})`);
  await pool.query("DELETE FROM user_credentials WHERE member_code LIKE 'ZZTTS%'");
  await pool.query("DELETE FROM trainer_groups WHERE name LIKE 'ZZTTS%'");
  for (const f of fx.files) fs.rmSync(path.join(cfg.uploadsDir, "materials", f), { force: true });
}
async function cred(code, role) {
  const id = (await pool.query("INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES (?, 'x', ?, 'active')", [code, role])).insertId;
  await pool.query("INSERT INTO training_materials_notice_acceptances (user_id, notice_version) VALUES (?, ?)", [id, CURRENT_VERSION]);
  return id;
}
async function setup() {
  await cleanup();
  fx.groupA = (await pool.query("INSERT INTO trainer_groups (name) VALUES ('ZZTTS Group A')")).insertId;
  fx.groupB = (await pool.query("INSERT INTO trainer_groups (name) VALUES ('ZZTTS Group B')")).insertId;
  fx.mt = await cred("ZZTTSMT", "supervisor");
  await pool.query("INSERT INTO supervisors (id, full_name, supervisor_type, group_id) VALUES (?, 'ZZTTS Master Trainer', 'primary', ?)", [fx.mt, fx.groupA]);
  fx.tot1 = await cred("ZZTTSTOT1", "supervisor");
  await pool.query("INSERT INTO supervisors (id, full_name, supervisor_type, primary_supervisor_id, group_id) VALUES (?, 'ZZTTS ToT One', 'in_training', ?, ?)", [fx.tot1, fx.mt, fx.groupA]);
  fx.tot2 = await cred("ZZTTSTOT2", "supervisor");
  await pool.query("INSERT INTO supervisors (id, full_name, supervisor_type, primary_supervisor_id, group_id) VALUES (?, 'ZZTTS ToT Two', 'in_training', ?, ?)", [fx.tot2, fx.mt, fx.groupA]);
  fx.mtB = await cred("ZZTTSMTB", "supervisor");
  await pool.query("INSERT INTO supervisors (id, full_name, supervisor_type, group_id) VALUES (?, 'ZZTTS Other MT', 'primary', ?)", [fx.mtB, fx.groupB]);
  fx.trainee = await cred("ZZTTSS1", "trainee");
  await pool.query("INSERT INTO students (id, full_name, group_id) VALUES (?, 'ZZTTS Trainee', ?)", [fx.trainee, fx.groupA]);
  // In the Master Trainer's AND ToT One's caseload -- exactly the case the
  // old download rule let through.
  await pool.query("INSERT INTO supervisor_students (supervisor_id, student_id) VALUES (?, ?), (?, ?)", [fx.mt, fx.trainee, fx.tot1, fx.trainee]);
}
/** A real file on disk + its learning_materials row (the upload route's own result shape). */
async function fileMaterial({ author, visibility, groupId = null, sharedWith = null, studentId = null, section = null, title }) {
  const filename = `zztts-${crypto.randomBytes(8).toString("hex")}.pdf`;
  fs.mkdirSync(path.join(cfg.uploadsDir, "materials"), { recursive: true });
  fs.writeFileSync(path.join(cfg.uploadsDir, "materials", filename), "%PDF-1.4\n% ZZTTS test file\n");
  fx.files.push(filename);
  const id = (
    await pool.query(
      `INSERT INTO learning_materials (supervisor_id, student_id, group_id, shared_with_supervisor_id, visibility, team_section, title, material_type, filename, original_name)
       VALUES (?,?,?,?,?,?,?,'document',?,?)`,
      [author, studentId, groupId, sharedWith, visibility, section, title, filename, `${title}.pdf`]
    )
  ).insertId;
  return { id, filename };
}

async function main() {
  console.log("Setting up isolated ZZTTS fixtures...\n");
  await setup();
  const T = {
    mt: tokenFor(fx.mt, "supervisor"),
    tot1: tokenFor(fx.tot1, "supervisor"),
    tot2: tokenFor(fx.tot2, "supervisor"),
    mtB: tokenFor(fx.mtB, "supervisor"),
    trainee: tokenFor(fx.trainee, "trainee"),
  };

  let feedbackId;
  console.log("Sharing within the training team");
  await test("Master Trainer shares feedback with the whole training team (private)", async () => {
    const res = await api("POST", "/supervisor/materials", T.mt, {
      title: "ZZTTS Feedback for the team",
      description: "Notes after week 3",
      materialType: "link",
      externalUrl: "https://example.org/zztts-feedback",
      teamSection: "feedback",
    });
    assertEqual(res.status, 201, `create (${JSON.stringify(res.body)})`);
    feedbackId = res.body.id || (await pool.query("SELECT id FROM learning_materials WHERE title = 'ZZTTS Feedback for the team'")).rows[0].id;
    const { rows } = await pool.query("SELECT visibility, team_section, group_id, student_id FROM learning_materials WHERE id = ?", [feedbackId]);
    assertEqual(rows[0].visibility, "training_team", "private");
    assertEqual(rows[0].team_section, "feedback", "section");
    assertEqual(Number(rows[0].group_id), fx.groupA, "this Group's team");
    assertEqual(rows[0].student_id, null, "no trainee target");
  });

  await test("Both ToTs of the Group see it; another Group's Master Trainer doesn't", async () => {
    for (const t of [T.tot1, T.tot2, T.mt]) {
      const res = await api("GET", "/supervisor/team-space?section=feedback", t);
      assert(res.body.items.some((i) => i.id === feedbackId), "visible to the team");
    }
    const other = await api("GET", "/supervisor/team-space", T.mtB);
    assert(!other.body.items.some((i) => i.id === feedbackId), "not across Groups");
  });

  await test("Trainees can't see it anywhere: feed, Trainer Space API, notifications", async () => {
    const feed = await api("GET", "/profile/materials-feed", T.trainee);
    assert(!feed.body.materials.some((m) => m.id === feedbackId), "not in the trainee feed");
    const space = await api("GET", "/supervisor/team-space", T.trainee);
    assertEqual(space.status, 403, "Trainer Space API refused");
    const { rows } = await pool.query("SELECT COUNT(*) AS n FROM notifications WHERE recipient_id = ? AND related_entity_id = ?", [fx.trainee, feedbackId]);
    assertEqual(Number(rows[0].n), 0, "trainee not notified");
  });

  let docId;
  await test("Share a private document with ONE trainer (the ToT shares with her Master Trainer)", async () => {
    const res = await api("POST", "/supervisor/materials", T.tot1, {
      title: "ZZTTS For my Master Trainer",
      materialType: "link",
      externalUrl: "https://example.org/zztts-doc",
      teamSection: "documents",
      targetSupervisorId: fx.mt,
    });
    assertEqual(res.status, 201, `create (${JSON.stringify(res.body)})`);
    docId = (await pool.query("SELECT id FROM learning_materials WHERE title = 'ZZTTS For my Master Trainer'")).rows[0].id;
    const mtView = await api("GET", "/supervisor/team-space?section=documents", T.mt);
    assert(mtView.body.items.some((i) => i.id === docId), "recipient sees it");
    const tot2View = await api("GET", "/supervisor/team-space", T.tot2);
    assert(!tot2View.body.items.some((i) => i.id === docId), "other ToT doesn't");
    const cross = await api("POST", "/supervisor/materials", T.tot1, { title: "x", materialType: "link", externalUrl: "https://example.org/x", teamSection: "documents", targetSupervisorId: fx.mtB });
    assertEqual(cross.status, 403, "can't share with another Group's trainer");
  });

  await test("Trainer Reports is its own section", async () => {
    const res = await api("POST", "/supervisor/materials", T.mt, { title: "ZZTTS Monthly report", materialType: "link", externalUrl: "https://example.org/r", teamSection: "reports" });
    assertEqual(res.status, 201, "create");
    const reports = await api("GET", "/supervisor/team-space?section=reports", T.tot1);
    assert(reports.body.items.every((i) => i.section === "reports"), "only reports");
    assert(reports.body.items.some((i) => i.title === "ZZTTS Monthly report"), "listed");
    const feedback = await api("GET", "/supervisor/team-space?section=feedback", T.tot1);
    assert(!feedback.body.items.some((i) => i.title === "ZZTTS Monthly report"), "not under feedback");
    const bad = await api("GET", "/supervisor/team-space?section=secret", T.tot1);
    assertEqual(bad.status, 400, "unknown section");
  });

  await test("Edit and delete: only the uploader", async () => {
    assertEqual((await api("PATCH", `/supervisor/team-space/${feedbackId}`, T.tot1, { title: "hijack" })).status, 404, "other trainer can't edit");
    assertEqual((await api("PATCH", `/supervisor/team-space/${feedbackId}`, T.mt, { title: "ZZTTS Feedback (edited)", section: "reports" })).status, 200, "uploader edits");
    const { rows } = await pool.query("SELECT title, team_section, visibility FROM learning_materials WHERE id = ?", [feedbackId]);
    assertEqual(rows[0].title, "ZZTTS Feedback (edited)", "title saved");
    assertEqual(rows[0].team_section, "reports", "moved section");
    assertEqual(rows[0].visibility, "training_team", "still private");
    assertEqual((await api("DELETE", `/supervisor/materials/${feedbackId}`, T.tot2)).status, 404, "other trainer can't delete");
    assertEqual((await api("DELETE", `/supervisor/materials/${feedbackId}`, T.mt)).status, 200, "uploader deletes");
  });

  console.log("\nFile downloads");
  await test("A trainee of the author can NOT download a private Group file by URL (was allowed before)", async () => {
    const f = await fileMaterial({ author: fx.mt, visibility: "training_team", groupId: fx.groupA, section: "documents", title: "ZZTTS private file" });
    assertEqual((await download(f.filename, T.trainee)).status, 403, "trainee refused");
    assertEqual((await download(f.filename, T.tot2)).status, 200, "a ToT of the Group can download");
    assertEqual((await download(f.filename, T.mt)).status, 200, "uploader can download");
    assertEqual((await download(f.filename, T.mtB)).status, 403, "another Group's trainer refused");
    assertEqual((await request("GET", `/uploads/materials/${f.filename}`)).status, 401, "no token refused");
  });

  await test("A file shared with one trainer: that trainer can download it (was refused before), others can't", async () => {
    const f = await fileMaterial({ author: fx.mt, visibility: "training_team", sharedWith: fx.tot1, section: "documents", title: "ZZTTS one-trainer file" });
    assertEqual((await download(f.filename, T.tot1)).status, 200, "recipient");
    assertEqual((await download(f.filename, T.tot2)).status, 403, "other ToT");
    assertEqual((await download(f.filename, T.trainee)).status, 403, "trainee");
  });

  await test("Trainee-facing materials keep their original access", async () => {
    const all = await fileMaterial({ author: fx.mt, visibility: "trainees", title: "ZZTTS for my trainees" });
    assertEqual((await download(all.filename, T.trainee)).status, 200, "caseload material downloadable by the trainee");
    const feed = await api("GET", "/profile/materials-feed", T.trainee);
    assert(feed.body.materials.some((m) => m.id === all.id), "in the trainee feed");
    const mine = await fileMaterial({ author: fx.tot1, visibility: "trainees", studentId: fx.trainee, title: "ZZTTS just for you" });
    assertEqual((await download(mine.filename, T.trainee)).status, 200, "targeted material downloadable");
    assertEqual((await download(mine.filename, T.tot2)).status, 403, "another ToT still refused (unchanged rule)");
  });

  await test("Even a mislabelled row (group/recipient set, visibility 'trainees') stays private", async () => {
    const f = await fileMaterial({ author: fx.mt, visibility: "trainees", groupId: fx.groupA, title: "ZZTTS legacy group share" });
    assertEqual((await download(f.filename, T.trainee)).status, 403, "trainee refused");
    const feed = await api("GET", "/profile/materials-feed", T.trainee);
    assert(!feed.body.materials.some((m) => m.id === f.id), "not in feed");
  });

  console.log("\nCleaning up ZZTTS fixtures...");
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
