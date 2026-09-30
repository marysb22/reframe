// Announcement Edit feature -- PUT /api/supervisor/announcements/:id.
// Verifies: editing updates the existing row in place (never creates a
// new one), persists across a fresh read, and is ownership-scoped exactly
// like create/delete already are (an unauthorized edit is rejected
// directly against the API, not just hidden in the UI).
//
// Same pattern as the other suites: no framework, real HTTP against the
// running dev server, real DB via the app's own pool, isolated
// ZZTANNEDIT-prefixed fixtures, guaranteed cleanup.
//
// Run: node tests/announcement-edit.test.js  (dev server must be running)

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
function tokenFor(id, role) {
  return jwt.sign({ id, role }, cfg.jwtSecret, { expiresIn: "1h" });
}

let fx = { groupId: null, totAId: null, totBId: null, studentId: null, announcementId: null };

async function precleanup() {
  await pool.query("DELETE FROM supervisors WHERE id IN (SELECT id FROM user_credentials WHERE member_code LIKE 'ZZTANNEDIT%')");
  await pool.query("DELETE FROM students WHERE id IN (SELECT id FROM user_credentials WHERE member_code LIKE 'ZZTANNEDIT%')");
  await pool.query("DELETE FROM user_credentials WHERE member_code LIKE 'ZZTANNEDIT%'");
  await pool.query("DELETE FROM trainer_groups WHERE name LIKE 'ZZTANNEDIT%'");
}

async function setup() {
  await precleanup();
  const grp = await pool.query("INSERT INTO trainer_groups (name) VALUES ('ZZTANNEDIT Group')");
  fx.groupId = grp.insertId;

  const mkSup = async (code, name) => {
    const cred = await pool.query(
      "INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES (?, 'x', 'supervisor', 'active')",
      [code]
    );
    const id = cred.insertId;
    // 'primary' (no primary_supervisor_id needed) -- supervisor.js's
    // announcement routes don't care about supervisor_type, and this
    // avoids needing a separate Master Trainer fixture just to satisfy
    // chk_supervisor_hierarchy.
    await pool.query("INSERT INTO supervisors (id, full_name, supervisor_type, group_id) VALUES (?, ?, 'primary', ?)", [
      id,
      name,
      fx.groupId,
    ]);
    return id;
  };
  fx.totAId = await mkSup("ZZTANNEDITTA", "ZZTAnnEdit ToT A");
  fx.totBId = await mkSup("ZZTANNEDITTB", "ZZTAnnEdit ToT B");

  const cred = await pool.query(
    "INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES ('ZZTANNEDITS1', 'x', 'trainee', 'active')"
  );
  fx.studentId = cred.insertId;
  await pool.query("INSERT INTO students (id, full_name, group_id) VALUES (?, 'ZZTAnnEdit Trainee', ?)", [fx.studentId, fx.groupId]);
  await pool.query("INSERT INTO supervisor_students (supervisor_id, student_id) VALUES (?, ?)", [fx.totAId, fx.studentId]);

  const ann = await pool.query(
    "INSERT INTO announcements (supervisor_id, title, content) VALUES (?, 'ZZTANNEDIT Original Title', 'Original content')",
    [fx.totAId]
  );
  fx.announcementId = ann.insertId;
}

async function teardown() {
  if (fx.announcementId) await pool.query("DELETE FROM announcements WHERE id = ?", [fx.announcementId]);
  if (fx.studentId) {
    await pool.query("DELETE FROM supervisor_students WHERE student_id = ?", [fx.studentId]);
    await pool.query("DELETE FROM students WHERE id = ?", [fx.studentId]);
    await pool.query("DELETE FROM user_credentials WHERE id = ?", [fx.studentId]);
  }
  const totIds = [fx.totAId, fx.totBId].filter(Boolean);
  if (totIds.length) {
    await pool.query(`DELETE FROM supervisors WHERE id IN (${totIds.map(() => "?").join(",")})`, totIds);
    await pool.query(`DELETE FROM user_credentials WHERE id IN (${totIds.map(() => "?").join(",")})`, totIds);
  }
  if (fx.groupId) await pool.query("DELETE FROM trainer_groups WHERE id = ?", [fx.groupId]);
}

async function run() {
  console.log("Setting up isolated ZZTANNEDIT fixtures...");
  await setup();

  try {
    const totAToken = tokenFor(fx.totAId, "supervisor");
    const totBToken = tokenFor(fx.totBId, "supervisor");

    await test("missing title/content is rejected with 400", async () => {
      const r = await request("PUT", `/supervisor/announcements/${fx.announcementId}`, totAToken, { title: "", content: "" });
      assertEqual(r.status, 400, "status");
    });

    await test("an unrelated ToT cannot edit -- rejected directly against the API (404), not just hidden in the UI", async () => {
      const r = await request("PUT", `/supervisor/announcements/${fx.announcementId}`, totBToken, {
        title: "Hijacked title",
        content: "Hijacked content",
      });
      assertEqual(r.status, 404, "status");
      const { rows } = await pool.query("SELECT title FROM announcements WHERE id = ?", [fx.announcementId]);
      assertEqual(rows[0].title, "ZZTANNEDIT Original Title", "content must be unchanged after a rejected edit");
    });

    await test("an unauthenticated request is rejected", async () => {
      const r = await request("PUT", `/supervisor/announcements/${fx.announcementId}`, null, { title: "x", content: "y" });
      if (r.status === 200) throw new Error("unauthenticated edit succeeded");
    });

    await test("the owning ToT edits it -- updates the SAME row (no new row created)", async () => {
      const before = await pool.query("SELECT COUNT(*) c FROM announcements WHERE supervisor_id = ?", [fx.totAId]);
      assertEqual(Number(before.rows[0].c), 1, "starts at 1 row");

      const r = await request("PUT", `/supervisor/announcements/${fx.announcementId}`, totAToken, {
        title: "مذكرة محدثة - Updated 10:00",
        content: "غداً لدينا جلسة الساعة 10:00 AM",
      });
      assertEqual(r.status, 200, "status");
      assertEqual(r.body.id, fx.announcementId, "same id returned, not a new one");

      const after = await pool.query("SELECT COUNT(*) c FROM announcements WHERE supervisor_id = ?", [fx.totAId]);
      assertEqual(Number(after.rows[0].c), 1, "still exactly 1 row -- edit did not create a duplicate");
    });

    await test("persists across a fresh read (simulates refresh), Arabic content stored and returned intact", async () => {
      const r = await request("GET", "/supervisor/announcements", totAToken);
      assertEqual(r.status, 200, "status");
      const found = r.body.announcements.find((a) => a.id === fx.announcementId);
      if (!found) throw new Error("announcement not found on fresh read");
      assertEqual(found.title, "مذكرة محدثة - Updated 10:00", "Arabic title persisted exactly, mixed with the Latin 10:00");
      assertEqual(found.content, "غداً لدينا جلسة الساعة 10:00 AM", "Arabic content persisted exactly, mixed with Latin/numbers");
    });

    await test("the trainee assigned to this ToT sees the updated content (not the old one)", async () => {
      const r = await request("GET", "/profile/announcements", tokenFor(fx.studentId, "trainee"));
      assertEqual(r.status, 200, "status");
      const found = r.body.announcements.find((a) => a.id === fx.announcementId);
      if (!found) throw new Error("trainee should still see this announcement");
      assertEqual(found.title, "مذكرة محدثة - Updated 10:00", "trainee sees the edited version");
    });
  } finally {
    console.log("\nCleaning up ZZTANNEDIT fixtures...");
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
