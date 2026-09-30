// The Calendar looked nearly empty. Root cause: it was built from
// GET /supervisor/schedule -- a small "today & upcoming" teaser widget
// that only returns session_date >= CURDATE() and caps "upcoming" at 10
// items -- so every PAST date and anything beyond the 10th soonest
// activity was silently missing, and Prev/Next only re-rendered that same
// stale array instead of fetching the newly-viewed month. Fixed with a
// dedicated GET /supervisor/calendar-sessions?start=&end= that returns
// every occasion/standalone session date in the exact range requested,
// with no upper-bound cap and no "future only" restriction; the frontend
// now re-fetches on every month navigation instead of caching one array
// forever.
//
// This suite tests the new endpoint directly: a past month's session, an
// 11th (previously-dropped) upcoming session, and a 5-day multi-day
// Session whose every day must appear on its own date. Also covers
// deleting a custom calendar event and confirming it disappears.
//
// No timezone conversion is involved anywhere in this data path --
// session_date/event_date are DATE columns (dateStrings:true returns
// plain 'YYYY-MM-DD', no time-of-day, no UTC offset), so there is no
// midnight-boundary ambiguity to test here; that claim is verified
// directly against the schema in this file's first test.
//
// Run: node tests/calendar-sessions.test.js (dev server must be running)

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
function pad(n) {
  return String(n).padStart(2, "0");
}
function ymd(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

let fx = { groupId: null, totId: null, studentIds: [], occasionIds: [], seriesId: null, eventId: null };

async function precleanup() {
  await pool.query("DELETE FROM supervisors WHERE id IN (SELECT id FROM user_credentials WHERE member_code = 'ZZTCALTOT')");
  await pool.query("DELETE FROM students WHERE id IN (SELECT id FROM user_credentials WHERE member_code LIKE 'ZZTCAL%')");
  await pool.query("DELETE FROM user_credentials WHERE member_code LIKE 'ZZTCAL%'");
  await pool.query("DELETE FROM trainer_groups WHERE name LIKE 'ZZTCAL%'");
}

async function setup() {
  await precleanup();
  const grp = await pool.query("INSERT INTO trainer_groups (name) VALUES ('ZZTCAL Group')");
  fx.groupId = grp.insertId;

  const cred = await pool.query(
    "INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES ('ZZTCALTOT', 'x', 'supervisor', 'active')"
  );
  fx.totId = cred.insertId;
  await pool.query("INSERT INTO supervisors (id, full_name, supervisor_type, group_id) VALUES (?, 'ZZTCAL ToT', 'primary', ?)", [
    fx.totId,
    fx.groupId,
  ]);

  const c = await pool.query(
    "INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES ('ZZTCALS1', 'x', 'trainee', 'active')"
  );
  const student = c.insertId;
  fx.studentIds.push(student);
  await pool.query("INSERT INTO students (id, full_name, group_id) VALUES (?, 'ZZTCAL Trainee', ?)", [student, fx.groupId]);
  await pool.query("INSERT INTO supervisor_students (supervisor_id, student_id) VALUES (?, ?)", [fx.totId, student]);

  // A session 45 days in the past -- GET /schedule (session_date >=
  // CURDATE()) would never return this at all.
  const past = await pool.query(
    "INSERT INTO session_occasions (supervisor_id, session_type, title, session_date, duration_minutes) VALUES (?, 'training', 'ZZTCAL Past Session', DATE_SUB(CURDATE(), INTERVAL 45 DAY), 60)",
    [fx.totId]
  );
  fx.occasionIds.push(past.insertId);
  const sPast = await pool.query(
    "INSERT INTO sessions (student_id, supervisor_id, session_type, session_date, duration_minutes, status, occasion_id) VALUES (?, ?, 'training', DATE_SUB(CURDATE(), INTERVAL 45 DAY), 60, 'completed', ?)",
    [student, fx.totId, past.insertId]
  );
  await pool.query(
    "INSERT INTO attendance (student_id, supervisor_id, session_id, attendance_date, status, recorded_by) VALUES (?, ?, ?, DATE_SUB(CURDATE(), INTERVAL 45 DAY), 'present', ?)",
    [student, fx.totId, sPast.insertId, fx.totId]
  );

  // 11 standalone future sessions -- GET /schedule's upcoming.slice(0, 10)
  // would drop the 11th.
  for (let i = 1; i <= 11; i++) {
    const s = await pool.query(
      "INSERT INTO sessions (student_id, supervisor_id, session_type, title, session_date, duration_minutes, status) VALUES (?, ?, 'training', ?, DATE_ADD(CURDATE(), INTERVAL ? DAY), 60, 'scheduled')",
      [student, fx.totId, `ZZTCAL Standalone ${i}`, i]
    );
    fx.lastStandaloneId = s.insertId;
    fx.lastStandaloneOffset = i;
  }

  // A 5-day multi-day Session, 60 days out, well past any "next 10" cutoff.
  const series = await pool.query(
    "INSERT INTO session_series (supervisor_id, session_type, title) VALUES (?, 'training', 'ZZTCAL Multi-day')",
    [fx.totId]
  );
  fx.seriesId = series.insertId;
  fx.seriesOccasionIds = [];
  for (let day = 0; day < 5; day++) {
    const occ = await pool.query(
      "INSERT INTO session_occasions (supervisor_id, session_type, title, session_date, duration_minutes, series_id) VALUES (?, 'training', ?, DATE_ADD(CURDATE(), INTERVAL ? DAY), 60, ?)",
      [fx.totId, `ZZTCAL Multi-day Day ${day + 1}`, 60 + day, fx.seriesId]
    );
    fx.seriesOccasionIds.push(occ.insertId);
  }
}

async function teardown() {
  const inList = fx.studentIds.map(() => "?").join(",");
  if (fx.studentIds.length) {
    await pool.query(`DELETE FROM attendance WHERE student_id IN (${inList})`, fx.studentIds);
    await pool.query(`DELETE FROM sessions WHERE student_id IN (${inList})`, fx.studentIds);
  }
  await pool.query("DELETE FROM session_occasions WHERE supervisor_id = ?", [fx.totId]);
  await pool.query("DELETE FROM session_series WHERE supervisor_id = ?", [fx.totId]);
  await pool.query("DELETE FROM calendar_events WHERE owner_id = ?", [fx.totId]);
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
  console.log("Setting up isolated ZZTCAL fixtures...");
  await setup();

  try {
    const token = tokenFor(fx.totId, "supervisor");

    console.log("\n[0] Schema sanity -- confirms there is no UTC-offset/midnight-boundary ambiguity to begin with");
    await test("session_date and event_date are plain DATE columns (no time-of-day, no timezone)", async () => {
      const { rows } = await pool.query("DESCRIBE session_occasions");
      const dateCol = rows.find((r) => r.Field === "session_date");
      assertEqual(dateCol.Type, "date", "session_occasions.session_date type");
      const { rows: ceRows } = await pool.query("DESCRIBE calendar_events");
      const ceDateCol = ceRows.find((r) => r.Field === "event_date");
      assertEqual(ceDateCol.Type, "date", "calendar_events.event_date type");
    });

    console.log("\n[1] Past date -- GET /schedule would never return this; calendar-sessions must");
    const pastDate = ymd(new Date(Date.now() - 45 * 86400000));
    await test("a 45-day-old session appears when querying that past month's range", async () => {
      const r = await request("GET", `/supervisor/calendar-sessions?start=${pastDate}&end=${pastDate}`, token);
      assertEqual(r.status, 200, "status");
      const found = r.body.events.find((e) => e.title === "ZZTCAL Past Session");
      if (!found) throw new Error("past session missing from calendar-sessions -- the exact reported bug");
      assertEqual(found.date, pastDate, "correct date");
    });

    console.log("\n[2] The 11th upcoming session -- GET /schedule's slice(0,10) would drop it");
    const day11 = ymd(new Date(Date.now() + fx.lastStandaloneOffset * 86400000));
    await test("the 11th standalone session is NOT dropped when its month is queried", async () => {
      const wideStart = ymd(new Date(Date.now()));
      const wideEnd = ymd(new Date(Date.now() + 70 * 86400000));
      const r = await request("GET", `/supervisor/calendar-sessions?start=${wideStart}&end=${wideEnd}`, token);
      assertEqual(r.status, 200, "status");
      const found = r.body.events.find((e) => e.title === "ZZTCAL Standalone 11");
      if (!found) throw new Error("11th upcoming session missing -- would have been silently capped under the old schedule-based source");
    });

    console.log("\n[3] Multi-day Session -- every one of its 5 days must appear on its OWN date");
    await test("all 5 days of the multi-day Session are present, each on a different date, none duplicated", async () => {
      const wideStart = ymd(new Date(Date.now() + 55 * 86400000));
      const wideEnd = ymd(new Date(Date.now() + 70 * 86400000));
      const r = await request("GET", `/supervisor/calendar-sessions?start=${wideStart}&end=${wideEnd}`, token);
      assertEqual(r.status, 200, "status");
      const days = r.body.events.filter((e) => e.title.startsWith("ZZTCAL Multi-day Day"));
      assertEqual(days.length, 5, "all 5 days present");
      const uniqueDates = new Set(days.map((d) => d.date));
      assertEqual(uniqueDates.size, 5, "5 distinct dates, none duplicated");
      assertEqual(days.every((d) => d.kind === "series_day"), true, "each day correctly tagged as part of a series");
    });

    console.log("\n[4] Authorization -- calendar-sessions must not leak another ToT's activities");
    await test("start/end are required", async () => {
      const r = await request("GET", "/supervisor/calendar-sessions", token);
      assertEqual(r.status, 400, "status");
    });

    console.log("\n[5] Custom calendar event -- create, appears in range, delete, disappears");
    await test("create a custom reminder", async () => {
      const r = await request("POST", "/supervisor/calendar-events", token, { title: "ZZTCAL Reminder", date: ymd(new Date()) });
      assertEqual(r.status, 201, "status");
      fx.eventId = r.body.id;
    });
    await test("appears when querying today's range", async () => {
      const today = ymd(new Date());
      const r = await request("GET", `/supervisor/calendar-events?start=${today}&end=${today}`, token);
      assertEqual(r.status, 200, "status");
      const found = r.body.events.find((e) => e.id === fx.eventId);
      if (!found) throw new Error("reminder not found in its own date's range");
    });
    await test("delete it", async () => {
      const r = await request("DELETE", `/supervisor/calendar-events/${fx.eventId}`, token);
      assertEqual(r.status, 200, "status");
    });
    await test("disappears from the calendar after deletion", async () => {
      const today = ymd(new Date());
      const r = await request("GET", `/supervisor/calendar-events?start=${today}&end=${today}`, token);
      assertEqual(r.status, 200, "status");
      const found = r.body.events.find((e) => e.id === fx.eventId);
      if (found) throw new Error("deleted reminder still appears");
    });
  } finally {
    console.log("\nCleaning up ZZTCAL fixtures...");
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
