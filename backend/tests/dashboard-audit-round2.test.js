// Second-round ToT Console / Training Activities / Assignments / Group /
// Announcements / Chat audit -- covers what the first round (tests/
// tot-console-audit.test.js) did not: per-day multi-day attendance
// breakdown, single-day roster breakdown math, trainee<->TOT group
// assignment count consistency, a real assignment end-to-end lifecycle
// (incl. cross-trainee permission denial), announcement cross-tenant
// isolation, and a real two-way Direct Message chat test.
//
// Same pattern as the existing suites: no framework, real HTTP against the
// running dev server, real DB via the app's own pool, isolated
// ZZTAUD2-prefixed fixtures, guaranteed cleanup in a finally block.
//
// Run: node tests/dashboard-audit-round2.test.js  (dev server must be running)

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
          Authorization: token ? `Bearer ${token}` : undefined,
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

let fx = {
  groupId: null,
  mtId: null,
  totId: null,
  otherTotId: null,
  studentIds: [],
  seriesId: null,
  occasionIds: [],
  singleOccasionId: null,
  assignmentId: null,
  otherStudentId: null,
  announcementId: null,
};

async function setup() {
  // Defensive pre-cleanup in case a previous run crashed mid-setup and
  // never reached teardown(). in_training supervisors (children, via
  // primary_supervisor_id) must go before primary ones (fk_supervisors_primary
  // is ON DELETE RESTRICT).
  await pool.query(
    "DELETE FROM supervisors WHERE supervisor_type = 'in_training' AND id IN (SELECT id FROM user_credentials WHERE member_code LIKE 'ZZTAUD2%')"
  );
  await pool.query(
    "DELETE FROM supervisors WHERE supervisor_type = 'primary' AND id IN (SELECT id FROM user_credentials WHERE member_code LIKE 'ZZTAUD2%')"
  );
  await pool.query("DELETE FROM students WHERE id IN (SELECT id FROM user_credentials WHERE member_code LIKE 'ZZTAUD2%')");
  await pool.query("DELETE FROM user_credentials WHERE member_code LIKE 'ZZTAUD2%'");
  await pool.query("DELETE FROM trainer_groups WHERE name LIKE 'ZZTAUD2%'");

  const grp = await pool.query("INSERT INTO trainer_groups (name) VALUES ('ZZTAUD2 Group')");
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
  fx.mtId = await mkSupervisor("ZZTAUD2MT", "ZZTAud2 MasterTrainer", "primary");
  fx.totId = await mkSupervisor("ZZTAUD2T1", "ZZTAud2 ToT One", "in_training", fx.mtId);
  fx.otherTotId = await mkSupervisor("ZZTAUD2T2", "ZZTAud2 ToT Two", "in_training", fx.mtId);

  const mkStudent = async (code, name) => {
    const cred = await pool.query(
      "INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES (?, 'x', 'trainee', 'active')",
      [code]
    );
    const id = cred.insertId;
    await pool.query("INSERT INTO students (id, full_name, group_id) VALUES (?, ?, ?)", [id, name, fx.groupId]);
    return id;
  };
  // 17 trainees, all currently assigned to fx.totId.
  for (let i = 1; i <= 17; i++) {
    const id = await mkStudent(`ZZTAUD2S${i}`, `ZZTAud2 Trainee ${i}`);
    fx.studentIds.push(id);
    await pool.query("INSERT INTO supervisor_students (supervisor_id, student_id) VALUES (?, ?)", [fx.totId, id]);
  }
  // An 18th trainee, NOT yet in the group -- used for the 17->18 add test.
  const extra = await mkStudent("ZZTAUD2S18", "ZZTAud2 Trainee 18");
  fx.studentIds.push(extra);
  fx.extraStudentId = extra;

  // A cross-tenant trainee under a totally different Group, for announcement isolation.
  const otherGrp = await pool.query("INSERT INTO trainer_groups (name) VALUES ('ZZTAUD2 OtherGroup')");
  fx.otherGroupId = otherGrp.insertId;
  fx.otherStudentId = await mkStudent("ZZTAUD2OTH", "ZZTAud2 Other Trainee");
  await pool.query("UPDATE students SET group_id = ? WHERE id = ?", [fx.otherGroupId, fx.otherStudentId]);
  await pool.query("INSERT INTO supervisor_students (supervisor_id, student_id) VALUES (?, ?)", [
    fx.otherTotId,
    fx.otherStudentId,
  ]);

  // --- Multi-day Session series: 3 days, 17 trainees each day. ---
  // Day 1: 13 present, 2 partial, 2 absent -> 15/17 attended = 88.24%
  // Day 2: 13 present, 0 partial, 4 absent -> 13/17 attended = 76.47%
  // Day 3: 17 present -> 17/17 = 100%
  const series = await pool.query(
    "INSERT INTO session_series (supervisor_id, session_type, title, notes) VALUES (?, 'training', 'ZZTAUD2 Multi-day Training', NULL)",
    [fx.totId]
  );
  fx.seriesId = series.insertId;
  const first17 = fx.studentIds.slice(0, 17);

  const dayPlan = [
    { present: 13, partial: 2, absent: 2 },
    { present: 13, partial: 0, absent: 4 },
    { present: 17, partial: 0, absent: 0 },
  ];
  for (let day = 0; day < 3; day++) {
    const occ = await pool.query(
      "INSERT INTO session_occasions (supervisor_id, session_type, title, session_date, duration_minutes, series_id) VALUES (?, 'training', ?, DATE_ADD(CURDATE(), INTERVAL ? DAY), 120, ?)",
      [fx.totId, `ZZTAUD2 Day ${day + 1}`, day, fx.seriesId]
    );
    fx.occasionIds.push(occ.insertId);
    const plan = dayPlan[day];
    const statuses = [
      ...Array(plan.present).fill("present"),
      ...Array(plan.partial).fill("partial"),
      ...Array(plan.absent).fill("absent"),
    ];
    for (let i = 0; i < 17; i++) {
      const studentId = first17[i];
      const s = await pool.query(
        "INSERT INTO sessions (student_id, supervisor_id, session_type, session_date, duration_minutes, status, occasion_id) VALUES (?, ?, 'training', DATE_ADD(CURDATE(), INTERVAL ? DAY), 120, 'completed', ?)",
        [studentId, fx.totId, day, occ.insertId]
      );
      await pool.query(
        "INSERT INTO attendance (student_id, supervisor_id, session_id, attendance_date, status, recorded_by) VALUES (?, ?, ?, DATE_ADD(CURDATE(), INTERVAL ? DAY), ?, ?)",
        [studentId, fx.totId, s.insertId, day, statuses[i], fx.totId]
      );
    }
  }

  // --- Master Trainer's OWN Group Session series (masterDashborad.html's
  // "Group Sessions" panel, GET /master-trainer/group-session-series/:id --
  // same session_series/session_occasions/sessions/attendance tables as the
  // ToT's, just supervisor_id = the Master Trainer's own id). 2 days, 4
  // trainees: Day 1 3/4 attended, Day 2 4/4. ---
  const mtSeries = await pool.query(
    "INSERT INTO session_series (supervisor_id, session_type, title, notes) VALUES (?, 'training', 'ZZTAUD2 MT Multi-day', NULL)",
    [fx.mtId]
  );
  fx.mtSeriesId = mtSeries.insertId;
  const mtDayPlan = [
    { present: 2, partial: 1, absent: 1 },
    { present: 4, partial: 0, absent: 0 },
  ];
  fx.mtOccasionIds = [];
  const mtRoster = first17.slice(0, 4);
  for (let day = 0; day < 2; day++) {
    const occ = await pool.query(
      "INSERT INTO session_occasions (supervisor_id, session_type, title, session_date, duration_minutes, series_id) VALUES (?, 'training', ?, DATE_ADD(CURDATE(), INTERVAL ? DAY), 60, ?)",
      [fx.mtId, `ZZTAUD2 MT Day ${day + 1}`, day, fx.mtSeriesId]
    );
    fx.mtOccasionIds.push(occ.insertId);
    const plan = mtDayPlan[day];
    const statuses = [...Array(plan.present).fill("present"), ...Array(plan.partial).fill("partial"), ...Array(plan.absent).fill("absent")];
    for (let i = 0; i < 4; i++) {
      const s = await pool.query(
        "INSERT INTO sessions (student_id, supervisor_id, session_type, session_date, duration_minutes, status, occasion_id) VALUES (?, ?, 'training', DATE_ADD(CURDATE(), INTERVAL ? DAY), 60, 'completed', ?)",
        [mtRoster[i], fx.mtId, day, occ.insertId]
      );
      await pool.query(
        "INSERT INTO attendance (student_id, supervisor_id, session_id, attendance_date, status, recorded_by) VALUES (?, ?, ?, DATE_ADD(CURDATE(), INTERVAL ? DAY), ?, ?)",
        [mtRoster[i], fx.mtId, s.insertId, day, statuses[i], fx.mtId]
      );
    }
  }

  // --- Single-day Group Session occasion: 17 trainees, 15 attended (13 present + 2 partial), 2 absent. ---
  const singleOcc = await pool.query(
    "INSERT INTO session_occasions (supervisor_id, session_type, title, session_date, duration_minutes) VALUES (?, 'training', 'ZZTAUD2 Single Day', CURDATE(), 90)",
    [fx.totId]
  );
  fx.singleOccasionId = singleOcc.insertId;
  const singleStatuses = [...Array(13).fill("present"), ...Array(2).fill("partial"), ...Array(2).fill("absent")];
  for (let i = 0; i < 17; i++) {
    const studentId = first17[i];
    const s = await pool.query(
      "INSERT INTO sessions (student_id, supervisor_id, session_type, session_date, duration_minutes, status, occasion_id) VALUES (?, ?, 'training', CURDATE(), 90, 'completed', ?)",
      [studentId, fx.totId, fx.singleOccasionId]
    );
    await pool.query(
      "INSERT INTO attendance (student_id, supervisor_id, session_id, attendance_date, status, recorded_by) VALUES (?, ?, ?, CURDATE(), ?, ?)",
      [studentId, fx.totId, s.insertId, singleStatuses[i], fx.totId]
    );
  }

  // --- One announcement from fx.totId, broadcast to its own caseload only. ---
  const ann = await pool.query(
    "INSERT INTO announcements (supervisor_id, title, content) VALUES (?, 'ZZTAUD2 Announcement', 'For my caseload only')",
    [fx.totId]
  );
  fx.announcementId = ann.insertId;
}

async function teardown() {
  const allStudentIds = [...fx.studentIds, fx.otherStudentId].filter(Boolean);
  if (allStudentIds.length) {
    const inList = allStudentIds.map(() => "?").join(",");
    await pool.query(`DELETE FROM assignment_submissions WHERE student_id IN (${inList})`, allStudentIds);
    await pool.query(`DELETE FROM assignments WHERE student_id IN (${inList})`, allStudentIds);
    await pool.query(`DELETE FROM attendance WHERE student_id IN (${inList})`, allStudentIds);
    await pool.query(`DELETE FROM sessions WHERE student_id IN (${inList})`, allStudentIds);
  }
  if (fx.seriesId) await pool.query("DELETE FROM session_occasions WHERE series_id = ?", [fx.seriesId]);
  if (fx.seriesId) await pool.query("DELETE FROM session_series WHERE id = ?", [fx.seriesId]);
  if (fx.mtSeriesId) await pool.query("DELETE FROM session_occasions WHERE series_id = ?", [fx.mtSeriesId]);
  if (fx.mtSeriesId) await pool.query("DELETE FROM session_series WHERE id = ?", [fx.mtSeriesId]);
  if (fx.singleOccasionId) await pool.query("DELETE FROM session_occasions WHERE id = ?", [fx.singleOccasionId]);
  if (fx.announcementId) await pool.query("DELETE FROM announcements WHERE id = ?", [fx.announcementId]);
  await pool.query("DELETE FROM notifications WHERE recipient_id IN (?, ?, ?)", [
    fx.totId || 0,
    fx.otherTotId || 0,
    fx.extraStudentId || 0,
  ]);
  if (allStudentIds.length) {
    const inList = allStudentIds.map(() => "?").join(",");
    await pool.query(`DELETE FROM chats WHERE student_id IN (${inList})`, allStudentIds);
    await pool.query(`DELETE FROM supervisor_students WHERE student_id IN (${inList})`, allStudentIds);
    await pool.query(`DELETE FROM students WHERE id IN (${inList})`, allStudentIds);
    await pool.query(`DELETE FROM user_credentials WHERE id IN (${inList})`, allStudentIds);
  }
  // Children (in_training, reference primary_supervisor_id) before the
  // parent (primary) -- fk_supervisors_primary is ON DELETE RESTRICT.
  const totIds = [fx.totId, fx.otherTotId].filter(Boolean);
  if (totIds.length) await pool.query(`DELETE FROM supervisors WHERE id IN (${totIds.map(() => "?").join(",")})`, totIds);
  if (fx.mtId) await pool.query("DELETE FROM supervisors WHERE id = ?", [fx.mtId]);
  const supIds = [fx.mtId, fx.totId, fx.otherTotId].filter(Boolean);
  if (supIds.length) {
    await pool.query(`DELETE FROM user_credentials WHERE id IN (${supIds.map(() => "?").join(",")})`, supIds);
  }
  if (fx.groupId) await pool.query("DELETE FROM trainer_groups WHERE id = ?", [fx.groupId]);
  if (fx.otherGroupId) await pool.query("DELETE FROM trainer_groups WHERE id = ?", [fx.otherGroupId]);
}

async function run() {
  console.log("Setting up isolated ZZTAUD2 fixtures...");
  await setup();

  try {
    const totToken = tokenFor(fx.totId, "supervisor");
    const otherTotToken = tokenFor(fx.otherTotId, "supervisor");
    const mtToken = tokenFor(fx.mtId, "supervisor");

    console.log("\n[1] Multi-day Session -- per-day attendance breakdown (GET /supervisor/session-series/:id)");
    let seriesDetail;
    await test("returns 3 days with full status breakdown + real percentages", async () => {
      const r = await request("GET", `/supervisor/session-series/${fx.seriesId}`, totToken);
      assertEqual(r.status, 200, "status");
      seriesDetail = r.body;
      assertEqual(seriesDetail.days.length, 3, "day count");
    });
    await test("Day 1: 13 present + 2 partial + 2 absent, 15/17 = 88.24%", async () => {
      const d = seriesDetail.days[0];
      assertEqual(d.traineeCount, 17, "traineeCount");
      assertEqual(d.presentOnlyCount, 13, "presentOnlyCount");
      assertEqual(d.partialCount, 2, "partialCount");
      assertEqual(d.absentCount, 2, "absentCount");
      assertEqual(d.pendingCount, 0, "pendingCount");
      assertEqual(d.presentCount, 15, "presentCount (present+partial)");
      assertClose(d.attendanceRate, 88.24, "attendanceRate");
    });
    await test("Day 2: 13 present + 0 partial + 4 absent, 13/17 = 76.47%", async () => {
      const d = seriesDetail.days[1];
      assertEqual(d.presentCount, 13, "presentCount");
      assertEqual(d.absentCount, 4, "absentCount");
      assertClose(d.attendanceRate, 76.47, "attendanceRate");
    });
    await test("Day 3: 17/17 = 100%", async () => {
      const d = seriesDetail.days[2];
      assertEqual(d.presentCount, 17, "presentCount");
      assertClose(d.attendanceRate, 100, "attendanceRate");
    });
    await test(
      "Overall multi-day rate uses pooled trainee-days (45/51 = 88.24%), NOT the average of the 3 daily percentages (88.24+76.47+100)/3 = 88.24 coincidentally close -- verify against the real pooled formula from the Activities feed",
      async () => {
        const r = await request(
          "GET",
          `/supervisor/activities?search=${encodeURIComponent("ZZTAUD2 Multi-day Training")}`,
          totToken
        );
        assertEqual(r.status, 200, "status");
        const row = r.body.activities.find((a) => a.kind === "series" && a.id === fx.seriesId);
        if (!row) throw new Error("series row not found in activities feed");
        // 15 + 13 + 17 = 45 attended trainee-days out of 17*3 = 51 expected.
        assertEqual(row.presentCount, 45, "pooled presentCount across all 3 days");
        assertEqual(row.slotCount, 51, "pooled slotCount (traineeCount x dayCount)");
        assertClose((row.presentCount / row.slotCount) * 100, 88.24, "pooled overall rate");
      }
    );

    console.log("\n[1b] Master Trainer's own Group Session series (GET /master-trainer/group-session-series/:id) -- same fix, parallel implementation");
    await test("MT series: Day 1 2 present+1 partial+1 absent = 3/4 = 75%, Day 2 = 4/4 = 100%", async () => {
      const r = await request("GET", `/master-trainer/group-session-series/${fx.mtSeriesId}`, mtToken);
      assertEqual(r.status, 200, "status");
      assertEqual(r.body.days.length, 2, "day count");
      const d1 = r.body.days[0];
      assertEqual(d1.traineeCount, 4, "day1 traineeCount");
      assertEqual(d1.presentOnlyCount, 2, "day1 presentOnlyCount");
      assertEqual(d1.partialCount, 1, "day1 partialCount");
      assertEqual(d1.absentCount, 1, "day1 absentCount");
      assertClose(d1.attendanceRate, 75, "day1 attendanceRate");
      const d2 = r.body.days[1];
      assertEqual(d2.presentOnlyCount, 4, "day2 presentOnlyCount");
      assertClose(d2.attendanceRate, 100, "day2 attendanceRate");
    });

    console.log("\n[2] Single-day Group Session -- roster breakdown (GET /supervisor/session-occasions/:id)");
    await test("roster carries real per-trainee status, present+partial != 100% when 2 are absent", async () => {
      const r = await request("GET", `/supervisor/session-occasions/${fx.singleOccasionId}`, totToken);
      assertEqual(r.status, 200, "status");
      const roster = r.body.roster;
      assertEqual(roster.length, 17, "roster length");
      const present = roster.filter((x) => x.status === "present").length;
      const partial = roster.filter((x) => x.status === "partial").length;
      const absent = roster.filter((x) => x.status === "absent").length;
      assertEqual(present, 13, "present");
      assertEqual(partial, 2, "partial");
      assertEqual(absent, 2, "absent");
      const rate = ((present + partial) / roster.length) * 100;
      assertClose(rate, 88.24, "single-day rate must reflect the real absences, not show 100%");
    });

    console.log("\n[3] Group member count -- 17 -> 18 -> 17 (PATCH /master-trainer/trainees/:studentId/tots)");
    await test("adding the 18th trainee to the ToT's caseload updates supervisor_students", async () => {
      const before = await pool.query("SELECT COUNT(*) c FROM supervisor_students WHERE supervisor_id = ?", [fx.totId]);
      assertEqual(Number(before.rows[0].c), 17, "starts at 17");

      const r = await request(
        "PATCH",
        `/master-trainer/trainees/${fx.extraStudentId}/tots`,
        mtToken,
        { totIds: [fx.totId] }
      );
      assertEqual(r.status, 200, "status");

      const after = await pool.query("SELECT COUNT(*) c FROM supervisor_students WHERE supervisor_id = ?", [fx.totId]);
      assertEqual(Number(after.rows[0].c), 18, "now 18");
    });
    await test("the new count survives an independent re-read (simulates refresh/second account)", async () => {
      const r = await request("GET", "/supervisor/students", totToken);
      assertEqual(r.status, 200, "status");
      assertEqual(r.body.students.length, 18, "ToT's own students list now shows 18");
    });
    await test("removing the trainee brings it back to 17 (inverse operation)", async () => {
      const r = await request("PATCH", `/master-trainer/trainees/${fx.extraStudentId}/tots`, mtToken, {
        totIds: [],
      });
      assertEqual(r.status, 200, "status");
      const after = await pool.query("SELECT COUNT(*) c FROM supervisor_students WHERE supervisor_id = ?", [fx.totId]);
      assertEqual(Number(after.rows[0].c), 17, "back to 17");
    });

    console.log("\n[4] Assignments -- real end-to-end lifecycle");
    let submissionStudentId = fx.studentIds[0];
    let wrongStudentId = fx.studentIds[1];
    await test("ToT creates an assignment for their whole caseload", async () => {
      const r = await request("POST", "/supervisor/assignments", totToken, {
        title: "ZZTAUD2 Assignment",
        description: "test",
        dueDate: null,
      });
      assertEqual(r.status, 201, "status");
      assertEqual(r.body.createdIds.length, 17, "one row per current caseload trainee (17, not 18 -- created before the add/remove above)");
      const { rows } = await pool.query("SELECT id FROM assignments WHERE student_id = ? AND title = 'ZZTAUD2 Assignment'", [
        submissionStudentId,
      ]);
      fx.assignmentId = rows[0].id;
    });
    await test("the correct trainee sees it via GET /profile/assignments/:id", async () => {
      const token = tokenFor(submissionStudentId, "trainee");
      const r = await request("GET", `/profile/assignments/${fx.assignmentId}`, token);
      assertEqual(r.status, 200, "status");
      assertEqual(r.body.status, "pending", "starts pending");
    });
    await test("an unrelated trainee (not this assignment's owner) is denied", async () => {
      const token = tokenFor(wrongStudentId, "trainee");
      const r = await request("GET", `/profile/assignments/${fx.assignmentId}`, token);
      assertEqual(r.status, 404, "must not leak someone else's assignment");
    });
    await test("an unrelated ToT cannot grade/see this assignment", async () => {
      const r = await request("PUT", `/supervisor/assignments/${fx.assignmentId}/grade`, otherTotToken, {
        score: 100,
      });
      assertEqual(r.status, 404, "must not allow grading another ToT's assignment");
    });
    await test("the owning ToT sees it in their overview", async () => {
      const r = await request("GET", `/supervisor/assignments?studentId=${submissionStudentId}`, totToken);
      assertEqual(r.status, 200, "status");
      const found = r.body.assignments.find((a) => a.id === fx.assignmentId);
      if (!found) throw new Error("assignment not found in supervisor overview");
      assertEqual(found.status, "pending", "status");
    });

    console.log("\n[5] Announcements -- cross-tenant isolation");
    await test("this ToT's own trainee sees the announcement", async () => {
      const token = tokenFor(submissionStudentId, "trainee");
      const r = await request("GET", "/profile/announcements", token);
      assertEqual(r.status, 200, "status");
      const found = r.body.announcements.find((a) => a.id === fx.announcementId);
      if (!found) throw new Error("own trainee should see the announcement");
    });
    await test("a trainee under a different ToT never sees it", async () => {
      const token = tokenFor(fx.otherStudentId, "trainee");
      const r = await request("GET", "/profile/announcements", token);
      assertEqual(r.status, 200, "status");
      const found = r.body.announcements.find((a) => a.id === fx.announcementId);
      if (found) throw new Error("cross-tenant leak: other ToT's trainee can see this announcement");
    });

    console.log("\n[6] Chat -- real two-way Direct Message test");
    const chatPartner = fx.studentIds[2];
    await test("ToT -> Trainee: message appears for both sides, stored once", async () => {
      const send = await request("POST", `/supervisor/students/${chatPartner}/messages`, totToken, {
        content: "ZZTAUD2 hello from ToT",
      });
      assertEqual(send.status, 201, "send status");

      const studentToken = tokenFor(chatPartner, "trainee");
      const studentView = await request("GET", `/profile/messages/${fx.totId}`, studentToken);
      assertEqual(studentView.status, 200, "trainee can read");
      const msgs = studentView.body.messages.filter((m) => m.content === "ZZTAUD2 hello from ToT");
      assertEqual(msgs.length, 1, "stored exactly once, visible to the recipient");
      assertEqual(msgs[0].isMine, false, "correct sender attribution on the recipient's side");
    });
    await test("Trainee -> ToT: reverse direction, correct sender/content, no duplicates", async () => {
      const studentToken = tokenFor(chatPartner, "trainee");
      const send = await request("POST", `/profile/messages/${fx.totId}`, studentToken, {
        content: "ZZTAUD2 hello back from trainee",
      });
      assertEqual(send.status, 201, "send status");

      const totView = await request("GET", `/supervisor/students/${chatPartner}/messages`, totToken);
      assertEqual(totView.status, 200, "ToT can read");
      const msgs = totView.body.messages.filter((m) => m.content === "ZZTAUD2 hello back from trainee");
      assertEqual(msgs.length, 1, "stored exactly once");
      assertEqual(msgs[0].isMine, false, "ToT correctly sees it as not their own message");

      // Both messages must be present together, in order, with no cross-talk from unrelated fixtures.
      const all = totView.body.messages.filter((m) => m.content.startsWith("ZZTAUD2"));
      assertEqual(all.length, 2, "both directions present, exactly once each");
    });
    await test("an unrelated ToT cannot read this conversation", async () => {
      const r = await request("GET", `/supervisor/students/${chatPartner}/messages`, otherTotToken);
      // chatPartner isn't in otherTotId's caseload -> loadAssignedStudent must reject.
      if (r.status === 200) throw new Error("unrelated ToT was able to read another ToT's trainee conversation");
    });
  } finally {
    console.log("\nCleaning up ZZTAUD2 fixtures...");
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
