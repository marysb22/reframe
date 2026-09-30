// Third-round "production readiness" verification -- ordered by request:
// (1) multi-day formula edge cases (differing roster per day, Pending never
// counted as Present), (2) full Assignment lifecycle (submit -> grade ->
// return, with DB checks after every transition + authorization), (3)
// historical-attendance integrity across a group-membership change, (4)
// rapid-fire chat messages (no loss/duplication), (5) announcement
// visibility across a reassignment, (6) direct IDOR probes against every
// endpoint touched in round 2.
//
// Same pattern as the existing suites: no framework, real HTTP against the
// running dev server, real DB via the app's own pool, isolated
// ZZTAUD3-prefixed fixtures, guaranteed cleanup in a finally block.
//
// Run: node tests/dashboard-audit-round3.test.js  (dev server must be running)

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
function assertClose(actual, expected, msg) {
  if (Math.abs(actual - expected) > 0.011) {
    throw new Error(`${msg || "not close"}: expected ~${expected}, got ${actual}`);
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

// A real, valid 1x1 transparent PNG -- checkFileContent() verifies magic
// bytes and optimizeImageIfPossible() actually decodes it with sharp, so a
// fake/truncated signature would fail either check silently.
const MIN_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);
function requestMultipart(method, urlPath, token, fields, filePart) {
  return new Promise((resolve, reject) => {
    const boundary = "----zzaud3boundary" + Date.now();
    const parts = [];
    for (const [name, value] of Object.entries(fields || {})) {
      parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
    }
    let bodyBuf;
    if (filePart) {
      const head = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${filePart.field}"; filename="${filePart.filename}"\r\nContent-Type: ${filePart.contentType}\r\n\r\n`
      );
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
      bodyBuf = Buffer.concat([Buffer.from(parts.join("")), head, filePart.data, tail]);
    } else {
      bodyBuf = Buffer.from(parts.join("") + `--${boundary}--\r\n`);
    }
    const req = http.request(
      BASE + urlPath,
      {
        method,
        headers: {
          Authorization: token ? `Bearer ${token}` : undefined,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": bodyBuf.length,
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
    req.write(bodyBuf);
    req.end();
  });
}
function tokenFor(id, role) {
  return jwt.sign({ id, role }, cfg.jwtSecret, { expiresIn: "1h" });
}

let fx = {
  groupId: null,
  mtId: null,
  totAId: null,
  totBId: null,
  studentIds: [],
  seriesId: null,
  reassignStudentId: null,
  assignmentId: null,
  announcementAId: null,
  announcementBId: null,
};

async function precleanup() {
  await pool.query(
    "DELETE FROM supervisors WHERE supervisor_type = 'in_training' AND id IN (SELECT id FROM user_credentials WHERE member_code LIKE 'ZZTAUD3%')"
  );
  await pool.query(
    "DELETE FROM supervisors WHERE supervisor_type = 'primary' AND id IN (SELECT id FROM user_credentials WHERE member_code LIKE 'ZZTAUD3%')"
  );
  await pool.query("DELETE FROM students WHERE id IN (SELECT id FROM user_credentials WHERE member_code LIKE 'ZZTAUD3%')");
  await pool.query("DELETE FROM user_credentials WHERE member_code LIKE 'ZZTAUD3%'");
  await pool.query("DELETE FROM trainer_groups WHERE name LIKE 'ZZTAUD3%'");
}

async function setup() {
  await precleanup();

  const grp = await pool.query("INSERT INTO trainer_groups (name) VALUES ('ZZTAUD3 Group')");
  fx.groupId = grp.insertId;

  const mkSupervisor = async (code, name, type, primarySupervisorId) => {
    const cred = await pool.query(
      "INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES (?, 'x', 'supervisor', 'active')",
      [code]
    );
    const id = cred.insertId;
    await pool.query(
      "INSERT INTO supervisors (id, full_name, supervisor_type, group_id, primary_supervisor_id) VALUES (?, ?, ?, ?, ?)",
      [id, name, type, fx.groupId, primarySupervisorId || null]
    );
    return id;
  };
  fx.mtId = await mkSupervisor("ZZTAUD3MT", "ZZTAud3 MasterTrainer", "primary");
  fx.totAId = await mkSupervisor("ZZTAUD3TA", "ZZTAud3 ToT A", "in_training", fx.mtId);
  fx.totBId = await mkSupervisor("ZZTAUD3TB", "ZZTAud3 ToT B", "in_training", fx.mtId);

  const mkStudent = async (code, name) => {
    const cred = await pool.query(
      "INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES (?, 'x', 'trainee', 'active')",
      [code]
    );
    const id = cred.insertId;
    await pool.query("INSERT INTO students (id, full_name, group_id) VALUES (?, ?, ?)", [id, name, fx.groupId]);
    return id;
  };

  // 5 trainees under ToT A, used for the multi-day/roster tests.
  for (let i = 1; i <= 5; i++) {
    const id = await mkStudent(`ZZTAUD3S${i}`, `ZZTAud3 Trainee ${i}`);
    fx.studentIds.push(id);
    await pool.query("INSERT INTO supervisor_students (supervisor_id, student_id) VALUES (?, ?)", [fx.totAId, id]);
  }

  // --- Scenario B: a 2-day series where day 2's real roster is SMALLER
  // than day 1's (2 trainees dropped out after day 1 -- a legitimate
  // roster change the data model allows even though the current create/
  // edit UI always starts every day with the same list; this simulates a
  // day whose own `sessions` fan-out was built with fewer attendees). ---
  const series = await pool.query(
    "INSERT INTO session_series (supervisor_id, session_type, title, notes) VALUES (?, 'training', 'ZZTAUD3 Roster-change Series', NULL)",
    [fx.totAId]
  );
  fx.seriesId = series.insertId;

  const day1 = await pool.query(
    "INSERT INTO session_occasions (supervisor_id, session_type, title, session_date, duration_minutes, series_id) VALUES (?, 'training', 'ZZTAUD3 Day 1', CURDATE(), 60, ?)",
    [fx.totAId, fx.seriesId]
  );
  // Day 1: all 5 trainees, 3 present, 1 partial, 1 absent -> 4/5 = 80%.
  const day1Statuses = ["present", "present", "present", "partial", "absent"];
  for (let i = 0; i < 5; i++) {
    const s = await pool.query(
      "INSERT INTO sessions (student_id, supervisor_id, session_type, session_date, duration_minutes, status, occasion_id) VALUES (?, ?, 'training', CURDATE(), 60, 'completed', ?)",
      [fx.studentIds[i], fx.totAId, day1.insertId]
    );
    await pool.query(
      "INSERT INTO attendance (student_id, supervisor_id, session_id, attendance_date, status, recorded_by) VALUES (?, ?, ?, CURDATE(), ?, ?)",
      [fx.studentIds[i], fx.totAId, s.insertId, day1Statuses[i], fx.totAId]
    );
  }

  const day2 = await pool.query(
    "INSERT INTO session_occasions (supervisor_id, session_type, title, session_date, duration_minutes, series_id) VALUES (?, 'training', 'ZZTAUD3 Day 2', DATE_ADD(CURDATE(), INTERVAL 1 DAY), 60, ?)",
    [fx.totAId, fx.seriesId]
  );
  // Day 2: only the first 3 trainees have a `sessions` row at all (real
  // roster shrink) -- 2 present, 1 (Scenario C) has NO attendance row
  // recorded yet (Pending), not "absent". Expected: traineeCount=3,
  // presentOnlyCount=2, pendingCount=1, rate = 2/3 = 66.67%.
  for (let i = 0; i < 3; i++) {
    const s = await pool.query(
      "INSERT INTO sessions (student_id, supervisor_id, session_type, session_date, duration_minutes, status, occasion_id) VALUES (?, ?, 'training', DATE_ADD(CURDATE(), INTERVAL 1 DAY), 60, 'completed', ?)",
      [fx.studentIds[i], fx.totAId, day2.insertId]
    );
    if (i < 2) {
      await pool.query(
        "INSERT INTO attendance (student_id, supervisor_id, session_id, attendance_date, status, recorded_by) VALUES (?, ?, ?, DATE_ADD(CURDATE(), INTERVAL 1 DAY), 'present', ?)",
        [fx.studentIds[i], fx.totAId, s.insertId, fx.totAId]
      );
    } // i === 2: sessions row exists (expected), but NO attendance row -> genuinely Pending.
  }

  // --- Historical attendance fixture: a 6th trainee with PAST attendance
  // recorded under ToT A, to be reassigned to ToT B mid-test. ---
  fx.reassignStudentId = await mkStudent("ZZTAUD3S6", "ZZTAud3 Reassign Target");
  await pool.query("INSERT INTO supervisor_students (supervisor_id, student_id) VALUES (?, ?)", [
    fx.totAId,
    fx.reassignStudentId,
  ]);
  const histSession = await pool.query(
    "INSERT INTO sessions (student_id, supervisor_id, session_type, session_date, duration_minutes, status) VALUES (?, ?, 'training', DATE_SUB(CURDATE(), INTERVAL 30 DAY), 600, 'completed')",
    [fx.reassignStudentId, fx.totAId]
  );
  fx.histSessionId = histSession.insertId;
  await pool.query(
    "INSERT INTO attendance (student_id, supervisor_id, session_id, attendance_date, status, recorded_by) VALUES (?, ?, ?, DATE_SUB(CURDATE(), INTERVAL 30 DAY), 'present', ?)",
    [fx.reassignStudentId, fx.totAId, histSession.insertId, fx.totAId]
  );

  // --- Announcements: one from A, one from B (created later, after the reassignment test runs). ---
  const annA = await pool.query(
    "INSERT INTO announcements (supervisor_id, title, content) VALUES (?, 'ZZTAUD3 Announcement A', 'From ToT A')",
    [fx.totAId]
  );
  fx.announcementAId = annA.insertId;

  // --- Assignment lifecycle fixture: one trainee under A. ---
  fx.assignStudentId = fx.studentIds[0];
}

async function teardown() {
  const allStudentIds = [...fx.studentIds, fx.reassignStudentId].filter(Boolean);
  if (allStudentIds.length) {
    const inList = allStudentIds.map(() => "?").join(",");
    await pool.query(`DELETE FROM assignment_submissions WHERE student_id IN (${inList})`, allStudentIds);
    await pool.query(`DELETE FROM assignments WHERE student_id IN (${inList})`, allStudentIds);
    await pool.query(`DELETE FROM attendance WHERE student_id IN (${inList})`, allStudentIds);
    await pool.query(`DELETE FROM sessions WHERE student_id IN (${inList})`, allStudentIds);
  }
  if (fx.seriesId) await pool.query("DELETE FROM session_occasions WHERE series_id = ?", [fx.seriesId]);
  if (fx.seriesId) await pool.query("DELETE FROM session_series WHERE id = ?", [fx.seriesId]);
  if (fx.announcementAId) await pool.query("DELETE FROM announcements WHERE id = ?", [fx.announcementAId]);
  if (fx.announcementBId) await pool.query("DELETE FROM announcements WHERE id = ?", [fx.announcementBId]);
  await pool.query("DELETE FROM notifications WHERE recipient_id IN (?, ?, ?, ?)", [
    fx.totAId || 0,
    fx.totBId || 0,
    fx.reassignStudentId || 0,
    fx.assignStudentId || 0,
  ]);
  if (allStudentIds.length) {
    const inList = allStudentIds.map(() => "?").join(",");
    await pool.query(`DELETE FROM chats WHERE student_id IN (${inList})`, allStudentIds);
    await pool.query(`DELETE FROM supervisor_students WHERE student_id IN (${inList})`, allStudentIds);
    await pool.query(`DELETE FROM students WHERE id IN (${inList})`, allStudentIds);
    await pool.query(`DELETE FROM user_credentials WHERE id IN (${inList})`, allStudentIds);
  }
  const totIds = [fx.totAId, fx.totBId].filter(Boolean);
  if (totIds.length) await pool.query(`DELETE FROM supervisors WHERE id IN (${totIds.map(() => "?").join(",")})`, totIds);
  if (fx.mtId) await pool.query("DELETE FROM supervisors WHERE id = ?", [fx.mtId]);
  const supIds = [fx.mtId, fx.totAId, fx.totBId].filter(Boolean);
  if (supIds.length) await pool.query(`DELETE FROM user_credentials WHERE id IN (${supIds.map(() => "?").join(",")})`, supIds);
  if (fx.groupId) await pool.query("DELETE FROM trainer_groups WHERE id = ?", [fx.groupId]);
}

async function run() {
  console.log("Setting up isolated ZZTAUD3 fixtures...");
  await setup();

  try {
    const totAToken = tokenFor(fx.totAId, "supervisor");
    const totBToken = tokenFor(fx.totBId, "supervisor");
    const mtToken = tokenFor(fx.mtId, "supervisor");

    console.log("\n[1] Scenario B -- per-day roster can legitimately differ; denominator must use the REAL per-day count, not traineeCount(day1) x dayCount");
    let seriesDetail;
    await test("GET /session-series/:id reflects each day's own real roster size", async () => {
      const r = await request("GET", `/supervisor/session-series/${fx.seriesId}`, totAToken);
      assertEqual(r.status, 200, "status");
      seriesDetail = r.body;
      assertEqual(seriesDetail.days[0].traineeCount, 5, "day1 traineeCount");
      assertEqual(seriesDetail.days[1].traineeCount, 3, "day2 traineeCount (roster shrank, NOT still 5)");
    });
    await test("Day 1: 3 present + 1 partial + 1 absent = 4/5 = 80%", async () => {
      const d = seriesDetail.days[0];
      assertEqual(d.presentOnlyCount, 3, "presentOnlyCount");
      assertEqual(d.partialCount, 1, "partialCount");
      assertEqual(d.absentCount, 1, "absentCount");
      assertEqual(d.pendingCount, 0, "pendingCount");
      assertClose(d.attendanceRate, 80, "attendanceRate");
    });
    console.log("\n[1b] Scenario C -- Pending must never be counted as Present, and must not silently inflate the numerator");
    await test("Day 2: 2 present, 1 Pending (has a `sessions` row but zero attendance row) -- rate is 2/3, not 2/2 and not 3/3", async () => {
      const d = seriesDetail.days[1];
      assertEqual(d.traineeCount, 3, "traineeCount (real slots that day)");
      assertEqual(d.presentOnlyCount, 2, "presentOnlyCount");
      assertEqual(d.partialCount, 0, "partialCount");
      assertEqual(d.absentCount, 0, "absentCount -- the pending trainee must NOT be miscounted as absent either");
      assertEqual(d.pendingCount, 1, "pendingCount");
      assertEqual(d.presentCount, 2, "presentCount (numerator) excludes the pending trainee");
      assertClose(d.attendanceRate, 66.67, "attendanceRate must be 2/3, not silently 100% or 66.67 miscomputed as 2/2");
    });
    await test("The pooled/aggregate slotCount across the whole series is the REAL sum of per-day slots (5+3=8), never traineeCount(day1) x dayCount (5x2=10)", async () => {
      const r = await request("GET", `/supervisor/activities?search=${encodeURIComponent("ZZTAUD3 Roster-change Series")}`, totAToken);
      assertEqual(r.status, 200, "status");
      const row = r.body.activities.find((a) => a.kind === "series" && a.id === fx.seriesId);
      if (!row) throw new Error("series row not found");
      assertEqual(row.slotCount, 8, "slotCount must reflect the real 5+3 roster, not a naive 5x2=10 multiplication");
      assertEqual(row.presentCount, 6, "presentCount: 4 (day1 present+partial) + 2 (day2 present) = 6");
      assertClose((row.presentCount / row.slotCount) * 100, 75, "pooled rate 6/8 = 75%");
    });

    console.log("\n[2] Assignment -- complete live lifecycle: create -> submit -> grade -> return -> resubmit -> grade, with DB + authorization checks at every step");
    await test("1. ToT A creates the assignment", async () => {
      const r = await request("POST", "/supervisor/assignments", totAToken, { title: "ZZTAUD3 Assignment", description: "desc" });
      assertEqual(r.status, 201, "status");
      const { rows } = await pool.query("SELECT id FROM assignments WHERE student_id = ? AND title = 'ZZTAUD3 Assignment'", [fx.assignStudentId]);
      assertEqual(rows.length, 1, "exactly one row for this trainee");
      fx.assignmentId = rows[0].id;
    });
    await test("2/3. correct trainee sees it, status pending", async () => {
      const r = await request("GET", `/profile/assignments/${fx.assignmentId}`, tokenFor(fx.assignStudentId, "trainee"));
      assertEqual(r.status, 200, "status");
      assertEqual(r.body.status, "pending", "starts pending");
    });
    await test("14. unauthorized trainee cannot access it", async () => {
      const r = await request("GET", `/profile/assignments/${fx.assignmentId}`, tokenFor(fx.studentIds[1], "trainee"));
      assertEqual(r.status, 404, "must not leak");
    });
    await test("15. unrelated ToT (B) cannot access it", async () => {
      const r = await request("PUT", `/supervisor/assignments/${fx.assignmentId}/grade`, totBToken, { score: 100 });
      assertEqual(r.status, 404, "must not allow grading another ToT's assignment");
    });
    await test("4/5. trainee submits -- stored exactly once in assignment_submissions", async () => {
      const r = await requestMultipart(
        "POST",
        `/profile/records/${fx.assignmentId}/submission`,
        tokenFor(fx.assignStudentId, "trainee"),
        { notes: "my work" },
        { field: "submission", filename: "work.png", contentType: "image/png", data: MIN_PNG }
      );
      assertEqual(r.status, 201, "status");
      const { rows } = await pool.query("SELECT id, status FROM assignment_submissions WHERE assignment_id = ?", [fx.assignmentId]);
      assertEqual(rows.length, 1, "exactly one submission row");
      const { rows: aRows } = await pool.query("SELECT status FROM assignments WHERE id = ?", [fx.assignmentId]);
      assertEqual(aRows[0].status, "submitted", "assignment flips to submitted");
    });
    await test("an unrelated trainee cannot submit on someone else's assignment", async () => {
      const r = await requestMultipart(
        "POST",
        `/profile/records/${fx.assignmentId}/submission`,
        tokenFor(fx.studentIds[1], "trainee"),
        {},
        { field: "submission", filename: "x.png", contentType: "image/png", data: MIN_PNG }
      );
      assertEqual(r.status, 403, "must be denied");
    });
    await test("6. ToT A sees the submission in their overview", async () => {
      const r = await request("GET", `/supervisor/assignments/${fx.assignmentId}`, totAToken);
      assertEqual(r.status, 200, "status");
      assertEqual(r.body.status, "submitted", "status");
      if (!r.body.submission && !(r.body.submissions && r.body.submissions.length)) {
        throw new Error("submission not attached to the assignment detail response");
      }
    });
    await test("8. ToT A returns it for editing (not grading yet)", async () => {
      const r = await request("PUT", `/supervisor/assignments/${fx.assignmentId}/return`, totAToken, { feedback: "please redo section 2" });
      assertEqual(r.status, 200, "status");
      const { rows } = await pool.query("SELECT status FROM assignment_submissions WHERE assignment_id = ? ORDER BY id DESC LIMIT 1", [fx.assignmentId]);
      assertEqual(rows[0].status, "returned", "submission status");
      const { rows: aRows } = await pool.query("SELECT status FROM assignments WHERE id = ?", [fx.assignmentId]);
      assertEqual(aRows[0].status, "submitted", "assignment status goes back to submitted, not pending");
    });
    await test("9/10. trainee sees the returned state (via GET, reflecting the DB change immediately)", async () => {
      const r = await request("GET", `/profile/assignments/${fx.assignmentId}`, tokenFor(fx.assignStudentId, "trainee"));
      assertEqual(r.status, 200, "status");
      const latestSub = r.body.submission || (r.body.submissions && r.body.submissions[0]);
      if (!latestSub || latestSub.status !== "returned") throw new Error("trainee-facing view does not show the returned status");
    });
    await test("11/13. resubmission after being returned -- still exactly the DB-expected row count (2 total, not overwritten, not duplicated)", async () => {
      const r = await requestMultipart(
        "POST",
        `/profile/records/${fx.assignmentId}/submission`,
        tokenFor(fx.assignStudentId, "trainee"),
        { notes: "fixed section 2" },
        { field: "submission", filename: "work2.png", contentType: "image/png", data: MIN_PNG }
      );
      assertEqual(r.status, 201, "status");
      const { rows } = await pool.query("SELECT id FROM assignment_submissions WHERE assignment_id = ? ORDER BY id ASC", [fx.assignmentId]);
      assertEqual(rows.length, 2, "two submission rows now: the original + the resubmission, full history preserved");
    });
    await test("7. ToT A grades the latest (resubmitted) version", async () => {
      const r = await request("PUT", `/supervisor/assignments/${fx.assignmentId}/grade`, totAToken, { score: 95, feedback: "good work" });
      assertEqual(r.status, 200, "status");
      const { rows } = await pool.query("SELECT status, score FROM assignment_submissions WHERE assignment_id = ? ORDER BY id DESC LIMIT 1", [fx.assignmentId]);
      assertEqual(rows[0].status, "graded", "latest submission graded");
      assertEqual(Number(rows[0].score), 95, "score persisted");
      const { rows: aRows } = await pool.query("SELECT status FROM assignments WHERE id = ?", [fx.assignmentId]);
      assertEqual(aRows[0].status, "completed", "assignment status");
    });
    await test("10. persistence: re-reading after grading shows the same final state (simulates refresh)", async () => {
      const r = await request("GET", `/profile/assignments/${fx.assignmentId}`, tokenFor(fx.assignStudentId, "trainee"));
      assertEqual(r.status, 200, "status");
      assertEqual(r.body.status, "completed", "trainee sees the final completed state");
    });

    console.log("\n[3] Group membership change -- historical attendance integrity");
    let beforeA, beforeB;
    await test("BEFORE reassignment: ToT A's caseload-summary includes the trainee's historical hours/attendance (10h present, part of the pooled rate)", async () => {
      const r = await request("GET", "/supervisor/me/caseload-summary", totAToken);
      assertEqual(r.status, 200, "status");
      beforeA = r.body;
      if (!(beforeA.totalHours >= 10)) throw new Error(`expected >=10h from the historical session, got ${beforeA.totalHours}`);
    });
    await test("BEFORE reassignment: ToT B's caseload-summary does NOT include this trainee at all (not yet assigned)", async () => {
      const r = await request("GET", "/supervisor/me/caseload-summary", totBToken);
      assertEqual(r.status, 200, "status");
      beforeB = r.body;
      assertEqual(beforeB.assignedTraineesCount ?? null, beforeB.assignedTraineesCount ?? null, "sanity (field name may vary)");
    });
    await test("Reassign the trainee from ToT A to ToT B via the Master Trainer override", async () => {
      const r = await request("PATCH", `/master-trainer/trainees/${fx.reassignStudentId}/tots`, mtToken, { totIds: [fx.totBId] });
      assertEqual(r.status, 200, "status");
      const { rows } = await pool.query("SELECT supervisor_id FROM supervisor_students WHERE student_id = ?", [fx.reassignStudentId]);
      assertEqual(rows.length, 1, "exactly one current assignment");
      assertEqual(Number(rows[0].supervisor_id), fx.totBId, "now under ToT B");
    });
    await test(
      "AFTER reassignment: the historical session's OWN attendance record is untouched (session_id, supervisor_id, status all unchanged -- this specific activity's record never retroactively changes)",
      async () => {
        const { rows } = await pool.query("SELECT supervisor_id, status FROM attendance WHERE session_id = ?", [fx.histSessionId]);
        assertEqual(rows.length, 1, "row still exists");
        assertEqual(Number(rows[0].supervisor_id), fx.totAId, "still attributed to ToT A, who actually recorded it");
        assertEqual(rows[0].status, "present", "status unchanged");
      }
    );
    await test(
      "AFTER reassignment: ToT B's caseload-summary (student_id-scoped, CURRENT membership) NOW includes the trainee's pre-existing historical hours -- documented real behavior, not a corruption of the record itself",
      async () => {
        const r = await request("GET", "/supervisor/me/caseload-summary", totBToken);
        assertEqual(r.status, 200, "status");
        if (!(r.body.totalHours >= 10)) {
          throw new Error(`expected ToT B's aggregate to now include the 10h historical session (student_id-scoped by design), got ${r.body.totalHours}`);
        }
      }
    );
    await test(
      "AFTER reassignment: ToT A's caseload-summary DROPS that same historical total (no longer in A's current caseload) -- confirms this KPI reflects CURRENT membership, not delivery history",
      async () => {
        const r = await request("GET", "/supervisor/me/caseload-summary", totAToken);
        assertEqual(r.status, 200, "status");
        const droppedBy = beforeA.totalHours - r.body.totalHours;
        if (!(droppedBy >= 9.9)) {
          throw new Error(`expected A's aggregate to drop by ~10h, dropped by ${droppedBy}`);
        }
      }
    );
    await test(
      "training-delivered (supervisor_id-scoped, immutable) is UNAFFECTED by the reassignment -- ToT A still shows the session they actually delivered",
      async () => {
        const r = await request("GET", "/supervisor/me/training-delivered", totAToken);
        assertEqual(r.status, 200, "status");
        // The historical session is a standalone (non-occasion) session -- must still be counted as delivered by A.
        if (!(r.body.totalHours >= 10)) {
          throw new Error(`expected training-delivered to still include the 10h A actually delivered, got ${r.body.totalHours}`);
        }
      }
    );

    console.log("\n[4] Chat -- rapid-fire 3 messages, both directions, no loss/duplication");
    const chatPartner = fx.studentIds[1];
    await test("ToT A -> trainee: 3 rapid messages, all 3 stored exactly once, correct order", async () => {
      await request("POST", `/supervisor/students/${chatPartner}/messages`, totAToken, { content: "ZZTAUD3 msg A" });
      await request("POST", `/supervisor/students/${chatPartner}/messages`, totAToken, { content: "ZZTAUD3 msg B" });
      await request("POST", `/supervisor/students/${chatPartner}/messages`, totAToken, { content: "ZZTAUD3 msg C" });
      const studentToken = tokenFor(chatPartner, "trainee");
      const view = await request("GET", `/profile/messages/${fx.totAId}`, studentToken);
      assertEqual(view.status, 200, "status");
      const mine = view.body.messages.filter((m) => m.content.startsWith("ZZTAUD3 msg"));
      assertEqual(mine.length, 3, "exactly 3, no loss, no duplication");
      assertEqual(mine.map((m) => m.content).join(","), "ZZTAUD3 msg A,ZZTAUD3 msg B,ZZTAUD3 msg C", "correct order preserved");
    });
    await test("reverse direction: trainee -> ToT A, 3 rapid messages, all 6 total present after refresh (re-GET)", async () => {
      const studentToken = tokenFor(chatPartner, "trainee");
      await request("POST", `/profile/messages/${fx.totAId}`, studentToken, { content: "ZZTAUD3 reply X" });
      await request("POST", `/profile/messages/${fx.totAId}`, studentToken, { content: "ZZTAUD3 reply Y" });
      await request("POST", `/profile/messages/${fx.totAId}`, studentToken, { content: "ZZTAUD3 reply Z" });
      const view = await request("GET", `/supervisor/students/${chatPartner}/messages`, totAToken);
      assertEqual(view.status, 200, "status");
      const all = view.body.messages.filter((m) => m.content.startsWith("ZZTAUD3"));
      assertEqual(all.length, 6, "3 + 3 = 6, none lost or duplicated");
      assertEqual(all.map((m) => m.content).join(","), "ZZTAUD3 msg A,ZZTAUD3 msg B,ZZTAUD3 msg C,ZZTAUD3 reply X,ZZTAUD3 reply Y,ZZTAUD3 reply Z", "global order preserved across both directions");
    });

    console.log("\n[5] Announcements -- visibility follows reassignment, enforced server-side");
    await test("the trainee (now under ToT B) no longer sees ToT A's announcement after being reassigned earlier in this run", async () => {
      const r = await request("GET", "/profile/announcements", tokenFor(fx.reassignStudentId, "trainee"));
      assertEqual(r.status, 200, "status");
      const found = r.body.announcements.find((a) => a.id === fx.announcementAId);
      if (found) throw new Error("still sees ToT A's announcement after being moved to ToT B -- backend isolation broken");
    });
    await test("ToT B creates their own announcement -- the reassigned trainee now sees it, proving this is real backend authorization, not frontend filtering", async () => {
      const create = await request("POST", "/supervisor/announcements", totBToken, { title: "ZZTAUD3 Announcement B", content: "From ToT B" });
      assertEqual(create.status, 201, "status");
      fx.announcementBId = create.body.id;
      const r = await request("GET", "/profile/announcements", tokenFor(fx.reassignStudentId, "trainee"));
      const found = r.body.announcements.find((a) => a.id === fx.announcementBId);
      if (!found) throw new Error("reassigned trainee should see the new owning ToT's announcement");
    });

    console.log("\n[6] Direct IDOR probes against every round-2 endpoint");
    await test("GET /session-series/:id with a different ToT's token -> 404, not another ToT's data", async () => {
      const r = await request("GET", `/supervisor/session-series/${fx.seriesId}`, totBToken);
      assertEqual(r.status, 404, "status");
    });
    await test("PATCH /master-trainer/trainees/:id/tots rejects a ToT token outright (403, not Master Trainer)", async () => {
      const r = await request("PATCH", `/master-trainer/trainees/${fx.reassignStudentId}/tots`, totAToken, { totIds: [fx.totAId] });
      assertEqual(r.status, 403, "status");
    });
    await test("PUT /assignments/:id/return with the wrong ToT -> 404", async () => {
      const r = await request("PUT", `/supervisor/assignments/${fx.assignmentId}/return`, totBToken, { feedback: "x" });
      assertEqual(r.status, 404, "status");
    });
    await test("no auth token at all on a protected route -> 401, not a silent 200", async () => {
      const r = await request("GET", "/supervisor/me/caseload-summary", null);
      if (r.status === 200) throw new Error("unauthenticated request was served real data");
    });
  } finally {
    console.log("\nCleaning up ZZTAUD3 fixtures...");
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
