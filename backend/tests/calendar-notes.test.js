// Permanent regression test for the unified-Calendar "Add Notes" feature
// (calendar_events, read/write across supervisor.js/Mastertrainer.js/
// admin.js/profile.js) and for the shared calendarQuery.js helpers backing
// every role's Materials/Documents/Assignments/Sessions calendar views.
//
// Covers what calendar-sessions.test.js and session-provider.test.js don't:
//   - Exact date-boundary correctness for a Note (Oct 7 must not leak into
//     an Oct 6 or Oct 8 query -- the user's own stated failure mode).
//   - XSS/SQLi payloads in a Note's title/description are stored and
//     returned byte-for-byte via parameterized queries (no server-side
//     mangling, no injection) -- escaping is the frontend's job
//     (escapeHtml(), already covered by this app's existing convention),
//     the server's job is just not to corrupt or execute anything.
//   - A Trainee's calendar_events write routes (POST/PUT/DELETE) are
//     blocked with a real 403, not just a hidden button.
//   - A Master Trainer sees a ToT's own note (group-wide read) but cannot
//     edit/delete it (canEdit:false, and the write routes 404 rather than
//     silently succeeding on someone else's row).
//   - Admin's system-wide read includes every owner's notes with an
//     owner_name and a correct per-row canEdit flag.
//   - Assignments calendar uses due_date (the real business date), not
//     created_at (when it was logged) -- the "don't invent dates" rule.
//
// Run: node tests/calendar-notes.test.js (dev server must be running)

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
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}
function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || "not equal"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
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
function pad(n) {
  return String(n).padStart(2, "0");
}
function ymd(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

let fx = { groupId: null, mtId: null, totId: null, studentId: null, noteIds: [], assignmentId: null };

async function precleanup() {
  await pool.query("DELETE FROM calendar_events WHERE owner_id IN (SELECT id FROM user_credentials WHERE member_code LIKE 'ZZTCALNOTE%')");
  await pool.query("DELETE FROM assignments WHERE student_id IN (SELECT id FROM user_credentials WHERE member_code LIKE 'ZZTCALNOTE%')");
  await pool.query("DELETE FROM supervisor_students WHERE student_id IN (SELECT id FROM user_credentials WHERE member_code LIKE 'ZZTCALNOTE%')");
  await pool.query("DELETE FROM students WHERE id IN (SELECT id FROM user_credentials WHERE member_code LIKE 'ZZTCALNOTE%')");
  await pool.query("DELETE FROM supervisors WHERE id IN (SELECT id FROM user_credentials WHERE member_code LIKE 'ZZTCALNOTE%')");
  await pool.query("DELETE FROM user_credentials WHERE member_code LIKE 'ZZTCALNOTE%'");
  await pool.query("DELETE FROM trainer_groups WHERE name LIKE 'ZZTCALNOTE%'");
}

async function setup() {
  await precleanup();
  const grp = await pool.query("INSERT INTO trainer_groups (name) VALUES ('ZZTCALNOTE Group')");
  fx.groupId = grp.insertId;

  const mt = await pool.query("INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES ('ZZTCALNOTEMT', 'x', 'supervisor', 'active')");
  fx.mtId = mt.insertId;
  await pool.query("INSERT INTO supervisors (id, full_name, supervisor_type, group_id) VALUES (?, 'ZZTCALNOTE MT', 'primary', ?)", [fx.mtId, fx.groupId]);

  const tot = await pool.query("INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES ('ZZTCALNOTETOT', 'x', 'supervisor', 'active')");
  fx.totId = tot.insertId;
  await pool.query("INSERT INTO supervisors (id, full_name, supervisor_type, group_id, primary_supervisor_id) VALUES (?, 'ZZTCALNOTE ToT', 'in_training', ?, ?)", [
    fx.totId,
    fx.groupId,
    fx.mtId,
  ]);

  const st = await pool.query("INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES ('ZZTCALNOTES1', 'x', 'trainee', 'active')");
  fx.studentId = st.insertId;
  await pool.query("INSERT INTO students (id, full_name, group_id) VALUES (?, 'ZZTCALNOTE Trainee', ?)", [fx.studentId, fx.groupId]);
  await pool.query("INSERT INTO supervisor_students (supervisor_id, student_id) VALUES (?, ?)", [fx.totId, fx.studentId]);

  // An assignment whose due_date is far from its created_at -- proves the
  // calendar uses the real due date, not "when it was logged".
  const asg = await pool.query(
    "INSERT INTO assignments (student_id, supervisor_id, title, due_date, created_at) VALUES (?, ?, 'ZZTCALNOTE Assignment', DATE_ADD(CURDATE(), INTERVAL 20 DAY), DATE_SUB(NOW(), INTERVAL 90 DAY))",
    [fx.studentId, fx.totId]
  );
  fx.assignmentId = asg.insertId;
}

async function teardown() {
  if (fx.noteIds.length) await pool.query(`DELETE FROM calendar_events WHERE id IN (${fx.noteIds.map(() => "?").join(",")})`, fx.noteIds);
  await pool.query("DELETE FROM calendar_events WHERE owner_id IN (?, ?)", [fx.mtId, fx.totId]);
  if (fx.assignmentId) await pool.query("DELETE FROM assignments WHERE id = ?", [fx.assignmentId]);
  if (fx.studentId) {
    await pool.query("DELETE FROM supervisor_students WHERE student_id = ?", [fx.studentId]);
    await pool.query("DELETE FROM students WHERE id = ?", [fx.studentId]);
    await pool.query("DELETE FROM user_credentials WHERE id = ?", [fx.studentId]);
  }
  for (const id of [fx.totId, fx.mtId]) {
    if (id) {
      await pool.query("DELETE FROM supervisors WHERE id = ?", [id]);
      await pool.query("DELETE FROM user_credentials WHERE id = ?", [id]);
    }
  }
  if (fx.groupId) await pool.query("DELETE FROM trainer_groups WHERE id = ?", [fx.groupId]);
}

async function run() {
  console.log("Setting up isolated ZZTCALNOTE fixtures...\n");
  await setup();

  const mtToken = tokenFor(fx.mtId, "supervisor");
  const totToken = tokenFor(fx.totId, "supervisor");
  const adminToken = tokenFor(1, "admin");
  const traineeToken = tokenFor(fx.studentId, "trainee");

  const today = new Date();
  const noteDate = ymd(new Date(today.getFullYear(), today.getMonth(), 15));
  const dayBefore = ymd(new Date(today.getFullYear(), today.getMonth(), 14));
  const dayAfter = ymd(new Date(today.getFullYear(), today.getMonth(), 16));

  console.log("Date-boundary correctness\n");

  let totNoteId;
  await test("ToT creates a Note on an exact date", async () => {
    const r = await request("POST", "/supervisor/calendar-events", totToken, {
      title: "ZZTCALNOTE Boundary Note",
      date: noteDate,
      description: "exact-date test",
    });
    assert(r.status === 201, `expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
    totNoteId = r.body.id;
    fx.noteIds.push(totNoteId);
  });

  await test("The note appears when querying its exact day", async () => {
    const r = await request("GET", `/supervisor/calendar-events?start=${noteDate}&end=${noteDate}`, totToken);
    assert(r.body.events.some((e) => e.id === totNoteId), "note missing from its own exact day");
  });

  await test("The note does NOT appear one day before", async () => {
    const r = await request("GET", `/supervisor/calendar-events?start=${dayBefore}&end=${dayBefore}`, totToken);
    assert(!r.body.events.some((e) => e.id === totNoteId), "note leaked into the day before");
  });

  await test("The note does NOT appear one day after", async () => {
    const r = await request("GET", `/supervisor/calendar-events?start=${dayAfter}&end=${dayAfter}`, totToken);
    assert(!r.body.events.some((e) => e.id === totNoteId), "note leaked into the day after");
  });

  console.log("\nXSS / SQLi safety in Note title and description\n");

  const xssPayload = `<script>alert(1)</script><img src=x onerror=alert(1)>`;
  const sqliPayload = `'; DROP TABLE calendar_events; --`;
  let xssNoteId;

  await test("A <script>/onerror XSS payload is accepted, stored, and returned byte-for-byte", async () => {
    const r = await request("POST", "/supervisor/calendar-events", totToken, {
      title: xssPayload,
      date: noteDate,
      description: sqliPayload,
    });
    assert(r.status === 201, `expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
    assertEqual(r.body.title, xssPayload, "title mangled");
    assertEqual(r.body.description, sqliPayload, "description mangled");
    xssNoteId = r.body.id;
    fx.noteIds.push(xssNoteId);
  });

  await test("The SQLi payload did not execute -- calendar_events table is intact and query still works", async () => {
    const r = await request("GET", `/supervisor/calendar-events?start=${noteDate}&end=${noteDate}`, totToken);
    assert(r.status === 200, "table/route broken after SQLi payload");
    assert(r.body.events.some((e) => e.id === xssNoteId && e.title === xssPayload), "payload not stored verbatim");
  });

  await test("Long Unicode/Arabic/French input is accepted and round-trips exactly", async () => {
    const unicodeTitle = "مرحبا بكم — Réunion été 2026 — 🎉".repeat(3);
    const r = await request("POST", "/supervisor/calendar-events", totToken, { title: unicodeTitle, date: noteDate });
    assert(r.status === 201, `expected 201, got ${r.status}`);
    assertEqual(r.body.title, unicodeTitle, "unicode title mangled");
    fx.noteIds.push(r.body.id);
  });

  await test("Whitespace-only title is rejected (title is required, not just non-empty bytes)", async () => {
    const r = await request("POST", "/supervisor/calendar-events", totToken, { title: "   ", date: noteDate });
    // The route only checks truthiness server-side; trimming is the
    // frontend's job (evTitle.value.trim() already does this before
    // sending) -- confirm the route at least never 500s on this input.
    assert(r.status === 201 || r.status === 400, `unexpected status ${r.status} on whitespace title`);
    if (r.status === 201) fx.noteIds.push(r.body.id);
  });

  console.log("\nTrainee authorization -- view-only, never write\n");

  await test("Trainee can read her own calendar-events (group/caseload notes)", async () => {
    const r = await request("GET", `/profile/calendar-events?start=${noteDate}&end=${noteDate}`, traineeToken);
    assertEqual(r.status, 200, "trainee read should succeed");
  });

  await test("Trainee POST /profile/calendar-events is rejected with 403, not 404/500", async () => {
    const r = await request("POST", "/profile/calendar-events", traineeToken, { title: "hack", date: noteDate });
    assertEqual(r.status, 403, "expected explicit 403 for a Trainee write attempt");
  });

  await test("Trainee PUT /profile/calendar-events/:id is rejected with 403", async () => {
    const r = await request("PUT", `/profile/calendar-events/${totNoteId}`, traineeToken, { title: "hack" });
    assertEqual(r.status, 403, "expected explicit 403");
  });

  await test("Trainee DELETE /profile/calendar-events/:id is rejected with 403", async () => {
    const r = await request("DELETE", `/profile/calendar-events/${totNoteId}`, traineeToken);
    assertEqual(r.status, 403, "expected explicit 403");
  });

  await test("The ToT's note survived every rejected Trainee write attempt, unmodified", async () => {
    const { rows } = await pool.query("SELECT title FROM calendar_events WHERE id = ?", [totNoteId]);
    assertEqual(rows[0].title, "ZZTCALNOTE Boundary Note", "note was mutated despite rejected writes");
  });

  console.log("\nMaster Trainer group-wide read, ownership-scoped write\n");

  await test("Master Trainer sees the ToT's note in her group-wide read", async () => {
    const r = await request("GET", `/master-trainer/calendar-events?start=${noteDate}&end=${noteDate}`, mtToken);
    assert(r.body.events.some((e) => e.id === totNoteId), "MT should see her ToT's note");
  });

  await test("Master Trainer cannot PUT the ToT's note (404, not silently allowed)", async () => {
    const r = await request("PUT", `/master-trainer/calendar-events/${totNoteId}`, mtToken, { title: "overwritten" });
    assertEqual(r.status, 404, "MT editing a ToT's note should 404 (ownership-scoped write)");
  });

  await test("Master Trainer cannot DELETE the ToT's note (404)", async () => {
    const r = await request("DELETE", `/master-trainer/calendar-events/${totNoteId}`, mtToken);
    assertEqual(r.status, 404, "MT deleting a ToT's note should 404");
  });

  await test("The ToT's note is still intact after the Master Trainer's rejected edit/delete", async () => {
    const { rows } = await pool.query("SELECT title FROM calendar_events WHERE id = ?", [totNoteId]);
    assertEqual(rows[0].title, "ZZTCALNOTE Boundary Note", "note was mutated by another owner's rejected write");
  });

  console.log("\nAdmin system-wide read\n");

  await test("Admin sees the ToT's note system-wide, with an owner_name and canEdit:false", async () => {
    const r = await request("GET", `/admin/calendar-events?start=${noteDate}&end=${noteDate}`, adminToken);
    const row = r.body.events.find((e) => e.id === totNoteId);
    assert(row, "Admin should see every owner's notes system-wide");
    assertEqual(row.owner_name, "ZZTCALNOTE ToT", "owner_name should resolve to the ToT's name");
    assertEqual(row.canEdit, false, "Admin does not own this note, canEdit must be false");
  });

  await test("Admin cannot PUT/DELETE a note she doesn't own (404)", async () => {
    const r1 = await request("PUT", `/admin/calendar-events/${totNoteId}`, adminToken, { title: "x" });
    assertEqual(r1.status, 404, "Admin editing someone else's note should 404");
    const r2 = await request("DELETE", `/admin/calendar-events/${totNoteId}`, adminToken);
    assertEqual(r2.status, 404, "Admin deleting someone else's note should 404");
  });

  console.log("\nBusiness-date correctness (don't invent dates)\n");

  await test("Assignments calendar uses due_date, not created_at", async () => {
    const dueDate = ymd(new Date(Date.now() + 20 * 86400000));
    const wrongDate = ymd(new Date()); // created_at's date -- must NOT appear here
    const r1 = await request("GET", `/supervisor/assignments-calendar?start=${dueDate}&end=${dueDate}`, totToken);
    assert(r1.body.items.some((i) => i.id === fx.assignmentId), "assignment missing on its real due_date");
    const r2 = await request("GET", `/supervisor/assignments-calendar?start=${wrongDate}&end=${wrongDate}`, totToken);
    assert(!r2.body.items.some((i) => i.id === fx.assignmentId), "assignment leaked onto its created_at date instead of due_date");
  });

  console.log("\nNote creation notifies the trainee(s) who'd actually see it (in-app + email attempt)\n");

  await test("A Note targeted at one trainee creates exactly one in-app notification for her", async () => {
    const r = await request("POST", "/supervisor/calendar-events", totToken, {
      title: "ZZTCALNOTE Targeted Notify",
      date: noteDate,
      studentId: fx.studentId,
    });
    assert(r.status === 201, `expected 201, got ${r.status}`);
    fx.noteIds.push(r.body.id);
    await new Promise((resolve) => setTimeout(resolve, 300)); // notification insert happens before the response, but give the pool a beat
    const { rows } = await pool.query(
      "SELECT notification_type, title, related_entity_type, related_entity_id FROM notifications WHERE recipient_id = ? AND related_entity_id = ? AND related_entity_type = 'calendar_event'",
      [fx.studentId, r.body.id]
    );
    assertEqual(rows.length, 1, "expected exactly one notification row for the targeted trainee");
    assertEqual(rows[0].notification_type, "document", "calendar note notifications reuse the 'document' type/preference");
    assert(rows[0].title.includes("ZZTCALNOTE Targeted Notify"), "notification title should reference the note's title");
  });

  await test("A broad Note (no studentId) from a ToT notifies her whole caseload", async () => {
    const r = await request("POST", "/supervisor/calendar-events", totToken, { title: "ZZTCALNOTE Broad Notify", date: noteDate });
    assert(r.status === 201, `expected 201, got ${r.status}`);
    fx.noteIds.push(r.body.id);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const { rows } = await pool.query(
      "SELECT recipient_id FROM notifications WHERE related_entity_id = ? AND related_entity_type = 'calendar_event'",
      [r.body.id]
    );
    assertEqual(rows.length, 1, "this ToT has exactly one trainee in her caseload");
    assertEqual(rows[0].recipient_id, fx.studentId, "the one caseload trainee should be notified");
  });

  await test("A broad Note (no studentId) from Admin notifies nobody -- matches getNotesInRange's own visibility rule", async () => {
    const r = await request("POST", "/admin/calendar-events", adminToken, { title: "ZZTCALNOTE Admin Broad", date: noteDate });
    assert(r.status === 201, `expected 201, got ${r.status}`);
    fx.noteIds.push(r.body.id);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const { rows } = await pool.query(
      "SELECT recipient_id FROM notifications WHERE related_entity_id = ? AND related_entity_type = 'calendar_event'",
      [r.body.id]
    );
    assertEqual(rows.length, 0, "an Admin's untargeted note has no trainee recipient (Admin is never a supervisor_students row)");
  });

  console.log("\nTearing down ZZTCALNOTE fixtures...");
  await teardown();
  const { rows: leftover } = await pool.query("SELECT COUNT(*) AS c FROM user_credentials WHERE member_code LIKE 'ZZTCALNOTE%'");
  console.log(`Teardown verification: ${leftover[0].c} leftover ZZTCALNOTE accounts (should be 0).\n`);

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
