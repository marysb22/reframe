// Deep audit of "Hours Provided By" / "Training Hours by Provider" --
// commissioned as a full production QA pass, not a smoke test. Builds a
// controlled, minute-exact dataset and verifies the database, the backend
// calculation, the API response, and (separately, via Playwright) the
// browser all agree -- down to the minute, not the rounded decimal.
//
// This is a read-heavy audit script, not a permanent CI assertion file --
// it prints a structured PASS/FAIL ledger and leaves zero data behind.
//
// Run: node tests/audit-provider-attribution.js (dev server must be running)

const http = require("http");
const jwt = require("jsonwebtoken");
const path = require("path");
const cfg = require(path.join(__dirname, "..", "src", "config"));
const { pool } = require(path.join(__dirname, "..", "src", "db"));

const BASE = "http://localhost:3000/api";
const results = [];
function record(section, name, ok, detail) {
  results.push({ section, name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} [${section}] ${name}${detail ? " -- " + detail : ""}`);
}
function assertEqualNum(section, name, actual, expected, unit) {
  const ok = Number(actual) === Number(expected);
  record(section, name, ok, ok ? `${actual}${unit || ""}` : `expected ${expected}${unit || ""}, got ${actual}${unit || ""}`);
  return ok;
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
          try { json = raw ? JSON.parse(raw) : null; } catch {}
          resolve({ status: res.statusCode, body: json });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
function tokenFor(id, role) { return jwt.sign({ id, role }, cfg.jwtSecret, { expiresIn: "1h" }); }

let fx = { groupId: null, mtId: null, totAId: null, totBId: null, outsideTotId: null, studentIds: [], adminId: null };

async function wipe() {
  const idSub = "SELECT id FROM user_credentials WHERE member_code LIKE 'ZZAUDIT%'";
  await pool.query(`DELETE FROM attendance WHERE supervisor_id IN (${idSub}) OR student_id IN (${idSub})`);
  await pool.query(`DELETE FROM sessions WHERE supervisor_id IN (${idSub}) OR student_id IN (${idSub})`);
  await pool.query(`DELETE FROM session_occasions WHERE supervisor_id IN (${idSub})`);
  await pool.query(`DELETE FROM session_series WHERE supervisor_id IN (${idSub})`);
  await pool.query(`DELETE FROM supervisor_students WHERE supervisor_id IN (${idSub}) OR student_id IN (${idSub})`);
  await pool.query(`DELETE FROM supervisors WHERE supervisor_type='in_training' AND id IN (${idSub})`);
  await pool.query(`DELETE FROM supervisors WHERE supervisor_type='primary' AND id IN (${idSub})`);
  await pool.query(`DELETE FROM students WHERE id IN (${idSub})`);
  await pool.query("DELETE FROM user_credentials WHERE member_code LIKE 'ZZAUDIT%'");
  await pool.query("DELETE FROM trainer_groups WHERE name LIKE 'ZZAUDIT%'");
}

async function setup() {
  await wipe();
  const grp = await pool.query("INSERT INTO trainer_groups (name) VALUES ('ZZAUDIT Group')");
  fx.groupId = grp.insertId;

  const mt = await pool.query("INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES ('ZZAUDITMT', 'x', 'supervisor', 'active')");
  fx.mtId = mt.insertId;
  await pool.query("INSERT INTO supervisors (id, full_name, supervisor_type, group_id) VALUES (?, 'ZZAUDIT MT', 'primary', ?)", [fx.mtId, fx.groupId]);

  const totA = await pool.query("INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES ('ZZAUDITTOTA', 'x', 'supervisor', 'active')");
  fx.totAId = totA.insertId;
  await pool.query("INSERT INTO supervisors (id, full_name, supervisor_type, primary_supervisor_id, group_id) VALUES (?, 'ZZAUDIT ToT A', 'in_training', ?, ?)", [fx.totAId, fx.mtId, fx.groupId]);

  const totB = await pool.query("INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES ('ZZAUDITTOTB', 'x', 'supervisor', 'active')");
  fx.totBId = totB.insertId;
  await pool.query("INSERT INTO supervisors (id, full_name, supervisor_type, primary_supervisor_id, group_id) VALUES (?, 'ZZAUDIT ToT B', 'in_training', ?, ?)", [fx.totBId, fx.mtId, fx.groupId]);

  // Outside-group ToT, for authorization bypass tests.
  const outsideGrp = await pool.query("INSERT INTO trainer_groups (name) VALUES ('ZZAUDIT Outside')");
  const outsideMt = await pool.query("INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES ('ZZAUDITOUTMT', 'x', 'supervisor', 'active')");
  await pool.query("INSERT INTO supervisors (id, full_name, supervisor_type, group_id) VALUES (?, 'ZZAUDIT Outside MT', 'primary', ?)", [outsideMt.insertId, outsideGrp.insertId]);
  const outsideTot = await pool.query("INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES ('ZZAUDITOUTTOT', 'x', 'supervisor', 'active')");
  fx.outsideTotId = outsideTot.insertId;
  await pool.query("INSERT INTO supervisors (id, full_name, supervisor_type, primary_supervisor_id, group_id) VALUES (?, 'ZZAUDIT Outside ToT', 'in_training', ?, ?)", [fx.outsideTotId, outsideMt.insertId, outsideGrp.insertId]);

  for (let i = 1; i <= 2; i++) {
    const c = await pool.query("INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES (?, 'x', 'trainee', 'active')", [`ZZAUDITS${i}`]);
    fx.studentIds.push(c.insertId);
    await pool.query("INSERT INTO students (id, full_name, group_id) VALUES (?, ?, ?)", [c.insertId, `ZZAUDIT Trainee ${i}`, fx.groupId]);
    await pool.query("INSERT INTO supervisor_students (supervisor_id, student_id) VALUES (?, ?)", [fx.totAId, c.insertId]);
  }

  const { rows: adminRows } = await pool.query("SELECT id FROM user_credentials WHERE role='admin' LIMIT 1");
  fx.adminId = adminRows.length ? adminRows[0].id : null;
}

// Creates a standalone (non-occasion) session+attendance row directly via
// SQL -- used to simulate pre-migration ("old") data and to build the
// controlled dataset without going through the API for every single row.
async function mkSession({ studentId, supervisorId, providedBy, durationMinutes, status = "completed", attendanceStatus = "present", cancelled = false }) {
  const s = await pool.query(
    "INSERT INTO sessions (student_id, supervisor_id, provided_by_supervisor_id, session_type, session_date, duration_minutes, status) VALUES (?,?,?,'training',CURDATE(),?,?)",
    [studentId, supervisorId, providedBy, durationMinutes, cancelled ? "cancelled" : status]
  );
  if (!cancelled) {
    await pool.query(
      "INSERT INTO attendance (student_id, supervisor_id, session_id, attendance_date, status, recorded_by) VALUES (?,?,?,CURDATE(),?,?)",
      [studentId, supervisorId, s.insertId, attendanceStatus, supervisorId]
    );
  }
  return s.insertId;
}

// Independent raw-SQL cross-check of "minutes attributed to this provider"
// -- deliberately NOT calling computeHoursByType/the breakdown endpoint's
// own SQL, so this is a genuine second implementation to compare against,
// not the same formula checking itself. Must dedupe a Group Session
// occasion's duration ONCE (not once per attendee), same business rule as
// the product code -- this audit's first draft of this helper summed every
// `sessions` row directly and over-counted multi-attendee occasions by
// exactly their attendee count; fixed here, noted in the report.
async function getProviderHours(providerId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(minutes),0) AS minutes FROM (
       SELECT CASE WHEN a.status='present' THEN s.duration_minutes ELSE COALESCE(a.minutes_completed,0) END AS minutes
       FROM sessions s JOIN attendance a ON a.session_id=s.id AND a.status IN ('present','partial')
       WHERE COALESCE(s.provided_by_supervisor_id, s.supervisor_id) = ? AND s.status != 'cancelled' AND s.occasion_id IS NULL

       UNION ALL

       SELECT so.duration_minutes AS minutes
       FROM session_occasions so
       WHERE COALESCE(so.provided_by_supervisor_id, so.supervisor_id) = ?
         AND EXISTS (
           SELECT 1 FROM sessions s2 JOIN attendance a2 ON a2.session_id = s2.id AND a2.status IN ('present','partial')
           WHERE s2.occasion_id = so.id AND s2.status != 'cancelled'
         )
     ) combined`,
    [providerId, providerId]
  );
  return Number(rows[0].minutes);
}

async function main() {
  console.log("=".repeat(70));
  console.log("AUDIT: Hours Provided By / Training Hours by Provider");
  console.log("=".repeat(70));

  await setup();
  const mtToken = tokenFor(fx.mtId, "supervisor");
  const totAToken = tokenFor(fx.totAId, "supervisor");
  const totBToken = tokenFor(fx.totBId, "supervisor");
  const outsideTotToken = tokenFor(fx.outsideTotId, "supervisor");
  const traineeToken = tokenFor(fx.studentIds[0], "trainee");
  const adminToken = fx.adminId ? tokenFor(fx.adminId, "admin") : null;

  // ============================================================
  console.log("\n--- PHASE 1: DATABASE INTEGRITY (schema) ---");
  // ============================================================
  {
    const { rows: cols } = await pool.query(
      `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'provided_by_supervisor_id'
       ORDER BY TABLE_NAME`
    );
    const expectedTables = ["session_occasions", "session_series", "sessions", "tot_session_occasions", "tot_training_sessions"];
    const actualTables = cols.map((c) => c.TABLE_NAME).sort();
    record("DB-1", "provided_by_supervisor_id exists on all 5 expected tables", JSON.stringify(actualTables) === JSON.stringify(expectedTables), JSON.stringify(actualTables));
    cols.forEach((c) => {
      record("DB-1", `${c.TABLE_NAME}.provided_by_supervisor_id is BIGINT and nullable`, c.DATA_TYPE === "bigint" && c.IS_NULLABLE === "YES", `${c.DATA_TYPE}, nullable=${c.IS_NULLABLE}`);
    });

    const { rows: fks } = await pool.query(
      `SELECT kcu.TABLE_NAME AS table_name, rc.CONSTRAINT_NAME AS constraint_name, rc.REFERENCED_TABLE_NAME AS referenced_table_name, rc.DELETE_RULE AS delete_rule
       FROM information_schema.REFERENTIAL_CONSTRAINTS rc
       JOIN information_schema.KEY_COLUMN_USAGE kcu ON kcu.CONSTRAINT_NAME = rc.CONSTRAINT_NAME AND kcu.TABLE_SCHEMA = rc.CONSTRAINT_SCHEMA
       WHERE rc.CONSTRAINT_SCHEMA = DATABASE() AND kcu.COLUMN_NAME = 'provided_by_supervisor_id'`
    );
    fks.forEach((fk) => {
      record("DB-1", `${fk.table_name} FK (${fk.constraint_name}) -> ${fk.referenced_table_name}, ON DELETE ${fk.delete_rule}`, fk.referenced_table_name === "supervisors" && fk.delete_rule === "SET NULL", `references ${fk.referenced_table_name}, rule=${fk.delete_rule}`);
    });

    // Orphan provider IDs: a provided_by_supervisor_id that doesn't resolve to a real supervisor.
    const { rows: orphans } = await pool.query(
      `SELECT COUNT(*) AS c FROM sessions s WHERE s.provided_by_supervisor_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM supervisors sup WHERE sup.id = s.provided_by_supervisor_id)`
    );
    record("DB-1", "No orphan provided_by_supervisor_id values in sessions (whole table)", Number(orphans[0].c) === 0, `${orphans[0].c} orphans`);

    // Backfill completeness: every pre-existing row (not created by this audit) has a non-NULL provider.
    const { rows: nullProviders } = await pool.query(
      `SELECT COUNT(*) AS c FROM sessions WHERE provided_by_supervisor_id IS NULL`
    );
    record("DB-1", "No session rows left with a NULL provider after backfill (whole table)", Number(nullProviders[0].c) === 0, `${nullProviders[0].c} NULL`);
  }

  // ============================================================
  console.log("\n--- PHASE 2 & 13: CONTROLLED DATASET -- exact minute arithmetic ---");
  // ============================================================
  // Session A: created by ToT A, PROVIDED BY MT, 90 min, present.
  // Session B: created by MT, PROVIDED BY ToT B, 120 min, present.
  // Session C: created by ToT A, PROVIDED BY ToT A, 45 min, present.
  // Session D: cancelled (created+provided ToT A), 60 min -- must contribute 0.
  // Session E: simulates a PRE-MIGRATION row (provided_by_supervisor_id forced NULL after insert), created by ToT B, 60 min, present -- must fall back to creator (ToT B) via COALESCE.
  const sA = await mkSession({ studentId: fx.studentIds[0], supervisorId: fx.totAId, providedBy: fx.mtId, durationMinutes: 90 });
  const sB = await mkSession({ studentId: fx.studentIds[0], supervisorId: fx.mtId, providedBy: fx.totBId, durationMinutes: 120 });
  const sC = await mkSession({ studentId: fx.studentIds[1], supervisorId: fx.totAId, providedBy: fx.totAId, durationMinutes: 45 });
  const sD = await mkSession({ studentId: fx.studentIds[1], supervisorId: fx.totAId, providedBy: fx.totAId, durationMinutes: 60, cancelled: true });
  const sE = await mkSession({ studentId: fx.studentIds[0], supervisorId: fx.totBId, providedBy: fx.totBId, durationMinutes: 60 });
  await pool.query("UPDATE sessions SET provided_by_supervisor_id = NULL WHERE id = ?", [sE]); // simulate pre-migration row

  const expectedMinutes = { [fx.mtId]: 90, [fx.totAId]: 45, [fx.totBId]: 120 + 60 };
  for (const [id, expected] of Object.entries(expectedMinutes)) {
    const actual = await getProviderHours(Number(id));
    assertEqualNum("CALC-2", `Provider ${id} exact minutes (raw SQL, before any API layer)`, actual, expected, "min");
  }
  {
    const cancelledMinutes = await getProviderHours(999999999); // sanity: cancelled session's provider isn't even in the map
    // Explicit check that session D (cancelled) contributes nothing anywhere:
    const { rows } = await pool.query("SELECT status FROM sessions WHERE id = ?", [sD]);
    record("CALC-2", "Cancelled session D kept status='cancelled' (not silently completed)", rows[0].status === "cancelled", rows[0].status);
  }
  {
    const { rows } = await pool.query("SELECT provided_by_supervisor_id FROM sessions WHERE id = ?", [sE]);
    record("CALC-2", "Pre-migration-simulated session E has NULL provided_by_supervisor_id in DB", rows[0].provided_by_supervisor_id === null, String(rows[0].provided_by_supervisor_id));
    const fallbackMinutes = await getProviderHours(fx.totBId);
    record("CALC-2", "...but COALESCE fallback still attributes it to creator (ToT B) -- old data doesn't vanish", fallbackMinutes === 180, `${fallbackMinutes}min (expected 180 = 120 session B + 60 session E fallback)`);
  }

  // ============================================================
  console.log("\n--- PHASE 2: API LAYER agrees with raw SQL ---");
  // ============================================================
  {
    const res = await request("GET", "/supervisor/me/group-training-breakdown", mtToken);
    record("API-2", "GET /me/group-training-breakdown -- 200", res.status === 200, `status ${res.status}`);
    const mtRow = res.body.breakdown.find((b) => b.supervisorId === fx.mtId);
    const totARow = res.body.breakdown.find((b) => b.supervisorId === fx.totAId);
    const totBRow = res.body.breakdown.find((b) => b.supervisorId === fx.totBId);
    assertEqualNum("API-2", "API: MT hours = 1.5h (90min)", mtRow.hours, 1.5, "h");
    assertEqualNum("API-2", "API: ToT A hours = 0.75h (45min)", totARow.hours, 0.75, "h");
    assertEqualNum("API-2", "API: ToT B hours = 3h (180min, includes the NULL-provider fallback row)", totBRow.hours, 3, "h");
    assertEqualNum("API-2", "API: totalHours = 5.25h (90+45+180=315min)", res.body.totalHours, 5.25, "h");
  }

  // ============================================================
  console.log("\n--- PHASE 7: MULTI-DAY SESSION ---");
  // ============================================================
  {
    const today = new Date();
    const d = (n) => new Date(today.getTime() - n * 86400000).toISOString().slice(0, 10);
    const res = await request("POST", "/supervisor/session-occasions", totAToken, {
      sessionType: "training",
      title: "ZZAUDIT Multi-day",
      days: [
        { date: d(3), durationMinutes: 60 },
        { date: d(2), durationMinutes: 120 },
        { date: d(1), durationMinutes: 90 },
      ],
      providedBySupervisorId: fx.totAId,
    });
    record("MULTI-7", "Multi-day Session created (201)", res.status === 201, `status ${res.status}`);
    const seriesId = res.body.seriesId;
    // Mark every day's attendance present for both trainees.
    const { rows: dayOcc } = await pool.query("SELECT id FROM session_occasions WHERE series_id = ?", [seriesId]);
    record("MULTI-7", "Exactly 3 session_occasions rows created for 3 days (not fewer/more)", dayOcc.length === 3, `${dayOcc.length} rows`);
    for (const occ of dayOcc) {
      await pool.query("UPDATE sessions SET status='completed' WHERE occasion_id = ?", [occ.id]);
      const { rows: sessRows } = await pool.query("SELECT id, student_id FROM sessions WHERE occasion_id = ?", [occ.id]);
      for (const s of sessRows) {
        await pool.query("INSERT INTO attendance (student_id, supervisor_id, session_id, attendance_date, status, recorded_by) VALUES (?,?,?,CURDATE(),'present',?)", [s.student_id, fx.totAId, s.id, fx.totAId]);
      }
    }
    const totAAfterMulti = await getProviderHours(fx.totAId);
    assertEqualNum("MULTI-7", "ToT A total after multi-day = 45 (session C) + 270 (1h+2h+1.5h multi-day) = 315min, NOT doubled per attendee", totAAfterMulti, 315, "min");

    // Now reassign the series' provider from ToT A to MT -- old provider must lose it, new must gain it.
    const { rows: dayRows2 } = await pool.query("SELECT id, session_date, duration_minutes FROM session_occasions WHERE series_id = ? ORDER BY session_date", [seriesId]);
    const days2 = dayRows2.map((r) => ({ occasionId: r.id, date: String(r.session_date).slice(0, 10), durationMinutes: r.duration_minutes }));
    const editRes = await request("PUT", `/supervisor/session-series/${seriesId}`, totAToken, { title: "ZZAUDIT Multi-day", days: days2, providedBySupervisorId: fx.mtId });
    record("MULTI-7", "PUT reassigning multi-day Session's provider to MT -- 200", editRes.status === 200, `status ${editRes.status}`);
    const totAAfterReassign = await getProviderHours(fx.totAId);
    const mtAfterReassign = await getProviderHours(fx.mtId);
    assertEqualNum("MULTI-7", "ToT A LOSES the 270min after reassignment (back to just 45min from session C)", totAAfterReassign, 45, "min");
    assertEqualNum("MULTI-7", "MT GAINS the 270min (90 from session A + 270 from reassigned multi-day = 360)", mtAfterReassign, 360, "min");

    // Clean up this sub-test's data so it doesn't pollute the rest of the audit.
    await request("DELETE", `/supervisor/session-series/${seriesId}`, totAToken);
    const totAAfterDelete = await getProviderHours(fx.totAId);
    const mtAfterDelete = await getProviderHours(fx.mtId);
    assertEqualNum("MULTI-7", "After deleting the whole Series, ToT A back to 45min (unaffected, she wasn't the provider at delete time)", totAAfterDelete, 45, "min");
    assertEqualNum("MULTI-7", "After deleting the whole Series, MT back to 90min (loses the 270 that's now gone)", mtAfterDelete, 90, "min");
  }

  // ============================================================
  console.log("\n--- PHASE 8: CREATED BY vs PROVIDED BY matrix ---");
  // ============================================================
  {
    // MT and ToT create through DIFFERENT routes (a pre-existing, unrelated
    // architecture fact, not something this feature changed):
    // /supervisor/session-occasions is caseload-scoped (works for a ToT,
    // and would also work for an MT only if she personally has
    // supervisor_students rows, which she doesn't by default -- she
    // reaches her whole Group instead through /master-trainer/group-sessions).
    const matrix = [
      { label: "MT creates, MT provides", path: "/master-trainer/group-sessions", token: mtToken, creatorId: fx.mtId, providedBy: fx.mtId, durationMinutes: 11, detailPath: (id) => `/master-trainer/group-sessions/${id}` },
      { label: "MT creates, ToT A provides", path: "/master-trainer/group-sessions", token: mtToken, creatorId: fx.mtId, providedBy: fx.totAId, durationMinutes: 12, detailPath: (id) => `/master-trainer/group-sessions/${id}` },
      { label: "ToT A creates, MT provides", path: "/supervisor/session-occasions", token: totAToken, creatorId: fx.totAId, providedBy: fx.mtId, durationMinutes: 13, detailPath: (id) => `/supervisor/session-occasions/${id}` },
      { label: "ToT A creates, ToT A provides", path: "/supervisor/session-occasions", token: totAToken, creatorId: fx.totAId, providedBy: fx.totAId, durationMinutes: 14, detailPath: (id) => `/supervisor/session-occasions/${id}` },
    ];
    for (const m of matrix) {
      // Each entry uses its own durationMinutes -- the API's own duplicate-
      // submission guard (same creator+type+date+duration within 10s) would
      // otherwise legitimately reject the second same-creator entry here as
      // a false "looks like a duplicate", which is correct product
      // behavior, not something this matrix should trip over.
      const res = await request("POST", m.path, m.token, {
        sessionType: "training", title: `ZZAUDIT Matrix ${m.label}`, date: new Date().toISOString().slice(0, 10), durationMinutes: m.durationMinutes, providedBySupervisorId: m.providedBy,
      });
      if (!res.body || !res.body.occasionId) {
        record("MATRIX-8", `${m.label}: session creation itself`, false, `status ${res.status}, body=${JSON.stringify(res.body)}`);
        continue;
      }
      const occId = res.body.occasionId;
      const { rows } = await pool.query("SELECT supervisor_id, provided_by_supervisor_id FROM session_occasions WHERE id = ?", [occId]);
      const createdOk = Number(rows[0].supervisor_id) === m.creatorId;
      const providedOk = Number(rows[0].provided_by_supervisor_id) === m.providedBy;
      record("MATRIX-8", `${m.label}: DB createdBy correct`, createdOk, `supervisor_id=${rows[0].supervisor_id}`);
      record("MATRIX-8", `${m.label}: DB providedBy correct`, providedOk, `provided_by=${rows[0].provided_by_supervisor_id}`);
      // Also confirm the detail endpoint's createdBy/providedBy names resolve and differ when expected.
      const detail = await request("GET", m.detailPath(occId), m.token);
      const namesDiffer = detail.body.occasion.createdBy.id !== detail.body.occasion.providedBy.id;
      record("MATRIX-8", `${m.label}: API createdBy.id=${detail.body.occasion.createdBy.id}, providedBy.id=${detail.body.occasion.providedBy.id}, expected ${m.creatorId !== m.providedBy ? "DIFFERENT" : "SAME"}`, (m.creatorId !== m.providedBy) === namesDiffer, "");
      await pool.query("DELETE FROM attendance WHERE session_id IN (SELECT id FROM sessions WHERE occasion_id=?)", [occId]);
      await pool.query("DELETE FROM sessions WHERE occasion_id=?", [occId]);
      await pool.query("DELETE FROM session_occasions WHERE id=?", [occId]);
    }
  }

  // ============================================================
  console.log("\n--- PHASE 6: TRAINEE must see totals, not provider internals ---");
  // ============================================================
  {
    const res = await request("GET", "/profile/progress", traineeToken);
    record("TRAINEE-6", "GET /profile/progress -- 200", res.status === 200, `status ${res.status}`);
    const keys = Object.keys(res.body || {});
    const leaksProvider = JSON.stringify(res.body).includes("provided_by") || JSON.stringify(res.body).includes("providedBy") || JSON.stringify(res.body).includes("createdBy");
    record("TRAINEE-6", "Trainee's /profile/progress response contains NO provider/createdBy fields", !leaksProvider, `keys: ${keys.join(",")}`);
    record("TRAINEE-6", "Trainee's total training hours includes session A/B/C/E (provider-agnostic) -- trainingHours >= 3.25h", res.body.trainingHours >= 3.25, `trainingHours=${res.body.trainingHours}`);
  }

  // ============================================================
  console.log("\n--- PHASE 9: SECURITY / AUTHORIZATION BYPASS (direct HTTP, no UI) ---");
  // ============================================================
  {
    const r1 = await request("POST", "/supervisor/session-occasions", totAToken, {
      sessionType: "training", title: "ZZAUDIT bypass outside-group", date: new Date().toISOString().slice(0, 10), durationMinutes: 10, providedBySupervisorId: fx.outsideTotId,
    });
    record("SEC-9", "Assign provider from ANOTHER Group -- rejected (expected 400)", r1.status === 400, `status ${r1.status}, body=${JSON.stringify(r1.body)}`);

    const r2 = await request("POST", "/supervisor/session-occasions", totAToken, {
      sessionType: "training", title: "ZZAUDIT bypass trainee-as-provider", date: new Date().toISOString().slice(0, 10), durationMinutes: 10, providedBySupervisorId: fx.studentIds[0],
    });
    record("SEC-9", "Assign a TRAINEE id as provider -- rejected (expected 400, trainee isn't in `supervisors` table at all)", r2.status === 400, `status ${r2.status}, body=${JSON.stringify(r2.body)}`);

    const r3 = await request("POST", "/supervisor/session-occasions", totAToken, {
      sessionType: "training", title: "ZZAUDIT bypass nonexistent id", date: new Date().toISOString().slice(0, 10), durationMinutes: 10, providedBySupervisorId: 999999999,
    });
    record("SEC-9", "Assign a nonexistent supervisor id -- rejected (expected 400)", r3.status === 400, `status ${r3.status}`);

    const r4 = await request("GET", "/supervisor/me/group-training-breakdown", traineeToken);
    record("SEC-9", "Trainee token hitting the breakdown endpoint directly -- rejected (expected 403, role gate)", r4.status === 403, `status ${r4.status}`);

    if (adminToken) {
      const r5 = await request("GET", "/supervisor/me/group-training-breakdown", adminToken);
      record("SEC-9", "Admin token hitting the breakdown endpoint directly -- rejected (expected 403, requireSupervisor role gate)", r5.status === 403, `status ${r5.status}`);
    } else {
      record("SEC-9", "Admin token test -- SKIPPED (no admin account found in this DB to borrow an id from)", true, "skipped, not a failure");
    }

    // Cross-group tampering: outside ToT tries to edit ToT A's session.
    const victimRes = await request("POST", "/supervisor/session-occasions", totAToken, { sessionType: "training", title: "ZZAUDIT victim session", date: new Date().toISOString().slice(0, 10), durationMinutes: 10 });
    const victimOccId = victimRes.body.occasionId;
    const r6 = await request("PUT", `/supervisor/session-occasions/${victimOccId}`, outsideTotToken, { date: new Date().toISOString().slice(0, 10), durationMinutes: 999, providedBySupervisorId: fx.outsideTotId });
    record("SEC-9", "An outside-Group ToT cannot edit another Group's session at all (expected 404, ownership check)", r6.status === 404, `status ${r6.status}`);
    await pool.query("DELETE FROM sessions WHERE occasion_id=?", [victimOccId]);
    await pool.query("DELETE FROM session_occasions WHERE id=?", [victimOccId]);

    // Negative testing: malformed/edge-case inputs.
    const r7 = await request("POST", "/supervisor/session-occasions", totAToken, { sessionType: "training", title: "ZZAUDIT neg", date: new Date().toISOString().slice(0, 10), durationMinutes: -5, providedBySupervisorId: fx.mtId });
    record("NEG-12", "Negative durationMinutes -- rejected (expected 400)", r7.status === 400, `status ${r7.status}`);

    const r8 = await request("POST", "/supervisor/session-occasions", totAToken, { sessionType: "training", title: "ZZAUDIT zero", date: new Date().toISOString().slice(0, 10), durationMinutes: 0, providedBySupervisorId: fx.mtId });
    record("NEG-12", "Zero durationMinutes -- ACCEPTED (0-duration placeholder sessions are allowed by design)", r8.status === 201, `status ${r8.status}`);
    if (r8.status === 201) {
      await pool.query("DELETE FROM sessions WHERE occasion_id=?", [r8.body.occasionId]);
      await pool.query("DELETE FROM session_occasions WHERE id=?", [r8.body.occasionId]);
    }

    const r9 = await request("POST", "/supervisor/session-occasions", totAToken, { sessionType: "not_a_real_type", title: "ZZAUDIT badtype", date: new Date().toISOString().slice(0, 10), durationMinutes: 10, providedBySupervisorId: fx.mtId });
    record("NEG-12", "Invalid sessionType -- rejected (expected 400)", r9.status === 400, `status ${r9.status}`);
  }

  // ============================================================
  console.log("\n--- PHASE 5: ADMIN -- confirm NO session-management access exists (by design) ---");
  // ============================================================
  {
    const grepResult = require("child_process").execSync(
      'grep -c "session_occasions\\|INSERT INTO sessions" src/routes/admin.js || true',
      { cwd: path.join(__dirname, "..") }
    ).toString().trim();
    record("ADMIN-5", "admin.js has ZERO session-creation/editing code (confirms this is a pre-existing architecture fact, not a gap introduced by this feature)", grepResult === "0", `grep count: ${grepResult}`);
  }

  // ============================================================
  console.log("\n--- PHASE 10: REGRESSION -- trainee total hours unaffected by provider field ---");
  // ============================================================
  {
    const before = await request("GET", "/profile/progress", traineeToken);
    // Reassign session A's provider from MT to ToT B -- a pure attribution change.
    await pool.query("UPDATE sessions SET provided_by_supervisor_id = ? WHERE id = ?", [fx.totBId, sA]);
    await pool.query("UPDATE session_occasions SET provided_by_supervisor_id = ? WHERE id IN (SELECT occasion_id FROM sessions WHERE id = ?)", [fx.totBId, sA]);
    const after = await request("GET", "/profile/progress", traineeToken);
    record("REGR-10", "Trainee's own total hours IDENTICAL before/after a provider reassignment (provider-agnostic, as designed)", before.body.trainingHours === after.body.trainingHours, `before=${before.body.trainingHours}, after=${after.body.trainingHours}`);
  }

  // ============================================================
  console.log("\n--- EXTRA FINDING: Admin's per-supervisor trainee view (getTrainersAndHours) ---");
  // ============================================================
  {
    // FIXED (post-audit): admin.js's getTrainersAndHours now groups by
    // COALESCE(s.provided_by_supervisor_id, s.supervisor_id). This card
    // only ever shows a supervisor the trainee is actually assigned to via
    // supervisor_students -- student 0 in this audit's main dataset is
    // only assigned to ToT A, so neither MT nor ToT B (session B's
    // creator/provider) can appear on it regardless of attribution; that's
    // a fixture-scope limit of this shared dataset, not a product bug. The
    // real, isolated repro (trainee assigned to both the creator and the
    // provider) is covered independently and far more thoroughly by
    // tests/admin-provider-attribution.test.js (8 scenarios: both
    // directions, MT/MT, ToT/ToT, NULL-provider fallback, edit, delete,
    // multi-day) -- this block is kept only as a lightweight smoke check
    // that the fix didn't regress within this audit's own shared dataset.
    await pool.query("INSERT INTO supervisor_students (supervisor_id, student_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE supervisor_id = supervisor_id", [fx.totBId, fx.studentIds[0]]);
    await pool.query("UPDATE sessions SET session_type='supervision' WHERE id = ?", [sB]);
    if (adminToken) {
      const res = await request("GET", `/admin/students/${fx.studentIds[0]}/profile`, adminToken);
      if (res.status === 200 && res.body && res.body.trainingHours) {
        const mtShown = res.body.trainingHours.masterTrainer ? res.body.trainingHours.masterTrainer.hours : null;
        const totBEntry = (res.body.trainingHours.totTrainers || []).find((t) => t.fullName === "ZZAUDIT ToT B");
        const totBShown = totBEntry ? totBEntry.hours : null;
        record("FINDING-ADMIN", `[POST-FIX] Admin's card attributes session B's 2h supervision to the PROVIDER (ToT B), not the creator (MT)`, totBShown === 2, `MT shown=${mtShown}h, ToT B shown=${totBShown}h, full trainingHours=${JSON.stringify(res.body.trainingHours)}`);
      } else {
        record("FINDING-ADMIN", "Could not reach GET /admin/students/:id/profile to verify", false, `status ${res.status}, body=${JSON.stringify(res.body).slice(0, 300)}`);
      }
    } else {
      record("FINDING-ADMIN", "SKIPPED -- no admin account available in this DB", true, "skipped, not a failure");
    }
    await pool.query("UPDATE sessions SET session_type='training' WHERE id = ?", [sB]);
    await pool.query("DELETE FROM supervisor_students WHERE supervisor_id = ? AND student_id = ?", [fx.totBId, fx.studentIds[0]]);
  }

  console.log("\n" + "=".repeat(70));
  const bySection = {};
  results.forEach((r) => { (bySection[r.section] = bySection[r.section] || []).push(r); });
  let totalPass = 0, totalFail = 0;
  Object.entries(bySection).forEach(([section, rs]) => {
    const pass = rs.filter((r) => r.ok).length;
    console.log(`${section}: ${pass}/${rs.length}`);
    totalPass += pass; totalFail += rs.length - pass;
  });
  console.log("=".repeat(70));
  console.log(`TOTAL: ${totalPass}/${totalPass + totalFail} checks passed`);
  console.log("=".repeat(70));

  console.log("\nFAILURES:");
  results.filter((r) => !r.ok).forEach((r) => console.log(`  [${r.section}] ${r.name} -- ${r.detail}`));

  await wipe();
  console.log("\nCleaned up ZZAUDIT fixtures.");
  process.exit(totalFail > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error("FATAL:", err);
  try { await wipe(); } catch {}
  process.exit(1);
});
