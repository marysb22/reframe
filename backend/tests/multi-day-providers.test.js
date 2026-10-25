// Multi-day Sessions with a different provider and a different number of
// hours on each day -- one Session (session_series) with one
// session_occasions row per day, each day carrying its own provider and
// duration (migrations 030/035). Verifies every day is stored, reopened,
// edited and attributed independently, every hour lands on exactly one
// provider, the Session-level views summarize the real per-day providers
// instead of claiming one trainer delivered everything, and single-day /
// short ("half-day") Sessions keep working as before.
//
// Run: node tests/multi-day-providers.test.js (dev server must be running)

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
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
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
const round2 = (n) => Math.round(n * 100) / 100;

const fx = { groupId: null, group2Id: null, mtId: null, totId: null, tot2Id: null, outsideTotId: null, studentIds: [] };
const MT = "ZZTMD Karim";
const TOT = "ZZTMD Habib";

async function precleanup() {
  const ids = "SELECT id FROM user_credentials WHERE member_code LIKE 'ZZTMD%'";
  await pool.query(`DELETE FROM attendance WHERE supervisor_id IN (${ids}) OR student_id IN (${ids})`);
  await pool.query(`DELETE FROM sessions WHERE supervisor_id IN (${ids}) OR student_id IN (${ids})`);
  await pool.query(`DELETE FROM session_occasions WHERE supervisor_id IN (${ids})`);
  await pool.query(`DELETE FROM session_series WHERE supervisor_id IN (${ids})`);
  await pool.query(`DELETE FROM supervisor_students WHERE supervisor_id IN (${ids}) OR student_id IN (${ids})`);
  await pool.query(`DELETE FROM supervisors WHERE supervisor_type = 'in_training' AND id IN (${ids})`);
  await pool.query(`DELETE FROM supervisors WHERE supervisor_type = 'primary' AND id IN (${ids})`);
  await pool.query(`DELETE FROM students WHERE id IN (${ids})`);
  await pool.query("DELETE FROM user_credentials WHERE member_code LIKE 'ZZTMD%'");
  await pool.query("DELETE FROM trainer_groups WHERE name LIKE 'ZZTMD%'");
}
async function cred(code, role) {
  return (await pool.query("INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES (?, 'x', ?, 'active')", [code, role])).insertId;
}
async function setup() {
  await precleanup();
  fx.groupId = (await pool.query("INSERT INTO trainer_groups (name) VALUES ('ZZTMD Group')")).insertId;
  fx.group2Id = (await pool.query("INSERT INTO trainer_groups (name) VALUES ('ZZTMD Other Group')")).insertId;
  fx.mtId = await cred("ZZTMDMT", "supervisor");
  await pool.query("INSERT INTO supervisors (id, full_name, supervisor_type, group_id) VALUES (?, ?, 'primary', ?)", [fx.mtId, MT, fx.groupId]);
  fx.totId = await cred("ZZTMDTOT", "supervisor");
  await pool.query("INSERT INTO supervisors (id, full_name, supervisor_type, primary_supervisor_id, group_id) VALUES (?, ?, 'in_training', ?, ?)", [fx.totId, TOT, fx.mtId, fx.groupId]);
  fx.tot2Id = await cred("ZZTMDTOT2", "supervisor");
  await pool.query("INSERT INTO supervisors (id, full_name, supervisor_type, primary_supervisor_id, group_id) VALUES (?, 'ZZTMD Second ToT', 'in_training', ?, ?)", [fx.tot2Id, fx.mtId, fx.groupId]);
  const mt2 = await cred("ZZTMDMT2", "supervisor");
  await pool.query("INSERT INTO supervisors (id, full_name, supervisor_type, group_id) VALUES (?, 'ZZTMD Other MT', 'primary', ?)", [mt2, fx.group2Id]);
  fx.outsideTotId = await cred("ZZTMDOUT", "supervisor");
  await pool.query("INSERT INTO supervisors (id, full_name, supervisor_type, primary_supervisor_id, group_id) VALUES (?, 'ZZTMD Outside ToT', 'in_training', ?, ?)", [fx.outsideTotId, mt2, fx.group2Id]);
  for (let i = 1; i <= 2; i++) {
    const id = await cred(`ZZTMDS${i}`, "trainee");
    fx.studentIds.push(id);
    await pool.query("INSERT INTO students (id, full_name, group_id) VALUES (?, ?, ?)", [id, `ZZTMD Trainee ${i}`, fx.groupId]);
    await pool.query("INSERT INTO supervisor_students (supervisor_id, student_id) VALUES (?, ?), (?, ?), (?, ?)", [fx.totId, id, fx.mtId, id, fx.tot2Id, id]);
  }
}
async function markPresent(occasionId) {
  await pool.query("UPDATE sessions SET status='completed' WHERE occasion_id = ?", [occasionId]);
  const { rows } = await pool.query("SELECT id, student_id, session_date FROM sessions WHERE occasion_id = ?", [occasionId]);
  for (const s of rows) {
    await pool.query(
      "INSERT INTO attendance (student_id, supervisor_id, session_id, attendance_date, status, recorded_by) VALUES (?, ?, ?, ?, 'present', ?)",
      [s.student_id, fx.mtId, s.id, s.session_date, fx.mtId]
    );
  }
}
async function markSeriesPresent(seriesId) {
  for (const r of (await pool.query("SELECT id FROM session_occasions WHERE series_id = ?", [seriesId])).rows) await markPresent(r.id);
}
async function breakdownMap(token) {
  const res = await request("GET", "/supervisor/me/group-training-breakdown", token);
  const m = {};
  for (const b of res.body.breakdown) if (b.supervisorId) m[b.supervisorId] = b.hours;
  return { map: m, total: res.body.totalHours };
}
async function storedDays(seriesId) {
  const { rows } = await pool.query(
    "SELECT id, session_date, duration_minutes, provided_by_supervisor_id AS p FROM session_occasions WHERE series_id = ? ORDER BY session_date",
    [seriesId]
  );
  return rows.map((r) => ({ id: Number(r.id), date: String(r.session_date).slice(0, 10), minutes: Number(r.duration_minutes), provider: r.p == null ? null : Number(r.p) }));
}

async function main() {
  console.log("Setting up isolated ZZTMD fixtures...\n");
  await setup();
  const mtToken = tokenFor(fx.mtId, "supervisor");
  const totToken = tokenFor(fx.totId, "supervisor");
  const tot2Token = tokenFor(fx.tot2Id, "supervisor");
  const traineeToken = tokenFor(fx.studentIds[0], "trainee");
  const expected = { [fx.mtId]: 0, [fx.totId]: 0 };
  let traineeHours = 0;

  console.log("Single-day and half-day Sessions (unchanged workflow)");

  let singleId;
  await test("Single-day Session: create with a provider, then edit its hours", async () => {
    const res = await request("POST", "/master-trainer/group-sessions", mtToken, {
      sessionType: "training",
      title: "ZZTMD single day",
      date: "2026-03-02",
      durationMinutes: 300,
      providedBySupervisorId: fx.totId,
    });
    assertEqual(res.status, 201, "create");
    singleId = res.body.occasionId;
    await markPresent(singleId);
    const edit = await request("PUT", `/master-trainer/group-sessions/${singleId}`, mtToken, {
      sessionType: "training",
      date: "2026-03-02",
      durationMinutes: 240,
      providedBySupervisorId: fx.totId,
    });
    assertEqual(edit.status, 200, "edit");
    const { rows } = await pool.query("SELECT duration_minutes, provided_by_supervisor_id AS p, series_id FROM session_occasions WHERE id = ?", [singleId]);
    assertEqual(Number(rows[0].duration_minutes), 240, "hours edited");
    assertEqual(Number(rows[0].p), fx.totId, "provider kept");
    assertEqual(rows[0].series_id, null, "still a single-day Session, not a series");
    expected[fx.totId] += 4;
    traineeHours += 4;
  });

  await test("Half-day Session (2.5h single day) records exactly 2.5h", async () => {
    const res = await request("POST", "/master-trainer/group-sessions", mtToken, { sessionType: "training", title: "ZZTMD half day", date: "2026-03-03", durationMinutes: 150 });
    assertEqual(res.status, 201, "create");
    await markPresent(res.body.occasionId);
    expected[fx.mtId] += 2.5;
    traineeHours += 2.5;
    const bd = await breakdownMap(mtToken);
    assertEqual(bd.map[fx.mtId], expected[fx.mtId], "MT 2.5h");
    assertEqual(bd.map[fx.totId], expected[fx.totId], "ToT 4h from the single-day Session");
  });

  console.log("\nMulti-day Sessions");

  let oneTrainerId;
  await test("Multi-day, one trainer every day: one Session, three days, all attributed to that trainer", async () => {
    const res = await request("POST", "/master-trainer/group-sessions", mtToken, {
      sessionType: "training",
      title: "ZZTMD one trainer",
      days: ["2026-03-09", "2026-03-10", "2026-03-11"].map((date) => ({ date, durationMinutes: 120, providedBySupervisorId: fx.totId })),
      providedBySupervisorId: fx.totId,
    });
    assertEqual(res.status, 201, "create");
    oneTrainerId = res.body.seriesId;
    const { rows } = await pool.query("SELECT COUNT(*) AS n FROM session_series WHERE id = ?", [oneTrainerId]);
    assertEqual(Number(rows[0].n), 1, "exactly one Session record");
    const days = await storedDays(oneTrainerId);
    assertEqual(days.length, 3, "three days");
    assert(days.every((d) => d.provider === fx.totId && d.minutes === 120), "every day Habib, 2h");
    await markSeriesPresent(oneTrainerId);
    expected[fx.totId] += 6;
    traineeHours += 6;
  });

  // The example from the request: Karim/Karim/Habib/Habib/Karim, 5/5/4/5/4h.
  const plan = [
    { date: "2026-04-06", who: "mt", minutes: 300 },
    { date: "2026-04-07", who: "mt", minutes: 300 },
    { date: "2026-04-08", who: "tot", minutes: 240 },
    { date: "2026-04-09", who: "tot", minutes: 300 },
    { date: "2026-04-10", who: "mt", minutes: 240 },
  ];
  const idOf = (who) => (who === "mt" ? fx.mtId : fx.totId);
  let mixedId;
  await test("Multi-day, two trainers on different days with different hours: stored per day", async () => {
    const res = await request("POST", "/master-trainer/group-sessions", mtToken, {
      sessionType: "training",
      title: "ZZTMD April training",
      notes: "Shared notes for the whole training",
      days: plan.map((p) => ({ date: p.date, durationMinutes: p.minutes, providedBySupervisorId: idOf(p.who) })),
      providedBySupervisorId: fx.mtId,
    });
    assertEqual(res.status, 201, "create");
    mixedId = res.body.seriesId;
    const days = await storedDays(mixedId);
    assertEqual(days.length, 5, "five days in ONE Session");
    plan.forEach((p, i) => {
      assertEqual(days[i].date, p.date, `day ${i + 1} date`);
      assertEqual(days[i].minutes, p.minutes, `day ${i + 1} hours`);
      assertEqual(days[i].provider, idOf(p.who), `day ${i + 1} provider`);
    });
    const { rows } = await pool.query("SELECT title, notes FROM session_series WHERE id = ?", [mixedId]);
    assertEqual(rows[0].title, "ZZTMD April training", "shared title on the Session");
    assertEqual(rows[0].notes, "Shared notes for the whole training", "shared notes on the Session");
    await markSeriesPresent(mixedId);
    expected[fx.mtId] += 14;
    expected[fx.totId] += 9;
    traineeHours += 23;
  });

  await test("Provider breakdown: each day's hours credited to that day's trainer exactly once", async () => {
    const bd = await breakdownMap(mtToken);
    assertEqual(bd.map[fx.mtId], expected[fx.mtId], "Karim");
    assertEqual(bd.map[fx.totId], expected[fx.totId], "Habib");
    assertEqual(round2(bd.total), round2(expected[fx.mtId] + expected[fx.totId]), "total = sum of days, nothing doubled");
  });

  await test("Session list summarizes the real per-day providers (not one trainer for everything)", async () => {
    const res = await request("GET", "/master-trainer/group-session-series", mtToken);
    const mixed = res.body.series.find((s) => s.id === mixedId);
    assert(mixed, "listed");
    assertEqual(mixed.mixedProviders, true, "flagged as delivered by more than one trainer");
    const byName = Object.fromEntries((mixed.providers || []).map((p) => [p.name, p]));
    assert(byName[MT] && byName[TOT], `both trainers listed, got ${JSON.stringify(mixed.providers)}`);
    assertEqual(byName[MT].hours, 14, "Karim 14h");
    assertEqual(byName[MT].dayCount, 3, "Karim 3 days");
    assertEqual(byName[TOT].hours, 9, "Habib 9h");
    assertEqual(byName[TOT].dayCount, 2, "Habib 2 days");
    assert(mixed.providedByName.includes(MT) && mixed.providedByName.includes(TOT), `providedByName names both, got ${mixed.providedByName}`);
    const one = res.body.series.find((s) => s.id === oneTrainerId);
    assertEqual(one.mixedProviders, false, "single-trainer Session not mixed");
    assertEqual(one.providedByName, TOT, "single-trainer name");
    assertEqual(one.providers.length, 1, "one provider");
  });

  await test("Activities feed (one row per Session) shows both trainers", async () => {
    const res = await request("GET", "/supervisor/activities?pageSize=100", mtToken);
    const row = res.body.activities.find((a) => a.kind === "series" && a.id === mixedId);
    assert(row, "series row present");
    assertEqual(row.mixedProviders, true, "mixed flag");
    assert(row.providedByName.includes(MT) && row.providedByName.includes(TOT), `names both, got ${row.providedByName}`);
  });

  await test("Reopen: Session detail returns shared info + every day with its own provider and hours", async () => {
    const res = await request("GET", `/master-trainer/group-session-series/${mixedId}`, mtToken);
    assertEqual(res.status, 200, "200");
    assertEqual(res.body.series.title, "ZZTMD April training", "shared title");
    assertEqual(res.body.days.length, 5, "five days");
    plan.forEach((p, i) => {
      const d = res.body.days[i];
      assertEqual(String(d.date).slice(0, 10), p.date, `day ${i + 1} date`);
      assertEqual(d.durationMinutes, p.minutes, `day ${i + 1} minutes`);
      assertEqual(d.providedBySupervisorId, idOf(p.who), `day ${i + 1} provider id`);
      assertEqual(d.providedByName, p.who === "mt" ? MT : TOT, `day ${i + 1} provider name`);
    });
    assertEqual(res.body.series.mixedProviders, true, "detail also flags mixed providers");
  });

  await test("Edit ONE day's trainer and hours; every other day stays exactly as it was", async () => {
    const before = await request("GET", `/master-trainer/group-session-series/${mixedId}`, mtToken);
    const days = before.body.days.map((d) => ({
      occasionId: d.occasionId,
      date: String(d.date).slice(0, 10),
      durationMinutes: d.durationMinutes,
      providedBySupervisorId: d.providedBySupervisorId,
    }));
    // Day 3: Habib 4h -> Karim 3h
    days[2] = { ...days[2], durationMinutes: 180, providedBySupervisorId: fx.mtId };
    const res = await request("PUT", `/master-trainer/group-session-series/${mixedId}`, mtToken, {
      sessionType: "training",
      title: "ZZTMD April training",
      notes: "Shared notes for the whole training",
      days,
      providedBySupervisorId: fx.mtId,
    });
    assertEqual(res.status, 200, "edit");
    const after = await storedDays(mixedId);
    const beforeStored = before.body.days;
    after.forEach((d, i) => {
      assertEqual(d.id, Number(beforeStored[i].occasionId), `day ${i + 1} kept its own record (no recreate)`);
      if (i === 2) {
        assertEqual(d.minutes, 180, "day 3 hours changed");
        assertEqual(d.provider, fx.mtId, "day 3 provider changed");
      } else {
        assertEqual(d.minutes, plan[i].minutes, `day ${i + 1} hours unchanged`);
        assertEqual(d.provider, idOf(plan[i].who), `day ${i + 1} provider unchanged`);
      }
    });
    const { rows } = await pool.query(
      "SELECT COUNT(*) AS n FROM attendance a JOIN sessions s ON s.id = a.session_id JOIN session_occasions so ON so.id = s.occasion_id WHERE so.series_id = ?",
      [mixedId]
    );
    assertEqual(Number(rows[0].n), 10, "attendance of every day preserved");
    expected[fx.totId] -= 4;
    expected[fx.mtId] += 3;
    traineeHours -= 1;
    const bd = await breakdownMap(mtToken);
    assertEqual(bd.map[fx.mtId], expected[fx.mtId], "Karim after edit");
    assertEqual(bd.map[fx.totId], expected[fx.totId], "Habib after edit");
  });

  await test("Dashboards: each trainer's delivered total counts only their own days", async () => {
    const delivered = await request("GET", "/supervisor/me/training-delivered", totToken);
    // /me/training-delivered counts everything the ToT provided, regardless of who logged it.
    assertEqual(round2(delivered.body.totalHours), round2(expected[fx.totId]), "Habib's own delivered total");
    const tots = await request("GET", "/master-trainer/tots", mtToken);
    assertEqual(round2(Number(tots.body.tots.find((t) => t.id === fx.totId).training_hours)), round2(expected[fx.totId]), "MT's ToT table");
    const other = await request("GET", "/supervisor/me/training-delivered", tot2Token);
    assertEqual(Number(other.body.totalHours), 0, "a ToT who delivered nothing has 0");
  });

  await test("Trainees receive every day's hours once (attendance-based)", async () => {
    for (const sid of fx.studentIds) {
      const res = await request("GET", `/supervisor/students/${sid}`, totToken);
      assertEqual(round2(res.body.progress.hoursByType.find((h) => h.code === "training").hours), round2(traineeHours), `trainee ${sid}`);
    }
  });

  await test("Weekly report, trainee history and calendar name each day's actual provider", async () => {
    const weekly = await request("GET", "/master-trainer/reports/weekly?week=2026-04-06", mtToken);
    assertEqual(weekly.status, 200, "weekly 200");
    const rows = weekly.body.sessions.filter((s) => s.title === "ZZTMD April training");
    assertEqual(rows.length, 10, "5 days x 2 trainees");
    const byDate = {};
    for (const r of rows) byDate[String(r.date).slice(0, 10)] = r.providedByName;
    assertEqual(byDate["2026-04-08"], MT, "day 3 (edited) shows Karim");
    assertEqual(byDate["2026-04-09"], TOT, "day 4 shows Habib");

    const recs = await request("GET", "/profile/records", traineeToken);
    const day4 = recs.body.records.find((r) => r.title === "ZZTMD April training" && String(r.date).slice(0, 10) === "2026-04-09");
    assert(day4, "trainee sees day 4");
    assertEqual(day4.providedByName, TOT, "trainee history: day 4 delivered by Habib");
    assertEqual(day4.supervisorName, MT, "and still logged by Karim");

    const cal = await request("GET", "/master-trainer/calendar-sessions?start=2026-04-06&end=2026-04-10", mtToken);
    const calDay = cal.body.events.find((e) => e.kind === "series_day" && String(e.date).slice(0, 10) === "2026-04-09");
    assert(calDay, "calendar day present");
    assertEqual(calDay.providedByName, TOT, "calendar: day 4 delivered by Habib");
  });

  console.log("\nValidation, authorization, isolation");

  await test("A day naming a trainer from another Group is rejected and nothing is written", async () => {
    const { rows: b } = await pool.query("SELECT COUNT(*) AS n FROM session_series WHERE supervisor_id = ?", [fx.mtId]);
    const res = await request("POST", "/master-trainer/group-sessions", mtToken, {
      sessionType: "training",
      title: "ZZTMD bad",
      days: [
        { date: "2026-05-04", durationMinutes: 60, providedBySupervisorId: fx.mtId },
        { date: "2026-05-05", durationMinutes: 60, providedBySupervisorId: fx.outsideTotId },
      ],
    });
    assertEqual(res.status, 400, "400");
    const { rows: a } = await pool.query("SELECT COUNT(*) AS n FROM session_series WHERE supervisor_id = ?", [fx.mtId]);
    assertEqual(Number(a[0].n), Number(b[0].n), "no Session created");
  });

  await test("Duplicate dates and negative hours are rejected", async () => {
    const dup = await request("POST", "/master-trainer/group-sessions", mtToken, {
      sessionType: "training",
      days: [{ date: "2026-05-11", durationMinutes: 60 }, { date: "2026-05-11", durationMinutes: 60 }],
    });
    assertEqual(dup.status, 400, "duplicate date");
    const neg = await request("POST", "/master-trainer/group-sessions", mtToken, {
      sessionType: "training",
      days: [{ date: "2026-05-12", durationMinutes: -60 }, { date: "2026-05-13", durationMinutes: 60 }],
    });
    assertEqual(neg.status, 400, "negative hours");
  });

  await test("Only the Session's creator can edit it; trainees can't reach the routes", async () => {
    const asTot = await request("PUT", `/supervisor/session-series/${mixedId}`, totToken, {
      days: [{ date: "2026-04-06", durationMinutes: 600 }],
    });
    assertEqual(asTot.status, 404, "another trainer can't edit it");
    const view = await request("GET", `/supervisor/session-series/${mixedId}`, totToken);
    assertEqual(view.status, 404, "or open it through their own routes");
    const trainee = await request("GET", "/master-trainer/group-session-series", traineeToken);
    assertEqual(trainee.status, 403, "trainee gated");
    const { rows } = await pool.query("SELECT SUM(duration_minutes) AS m FROM session_occasions WHERE series_id = ?", [mixedId]);
    assertEqual(Number(rows[0].m), 300 + 300 + 180 + 300 + 240, "untouched by the rejected edit");
  });

  console.log("\nHistorical records (backward compatibility)");

  await test("A pre-migration-035 multi-day Session (no per-day provider stored) still reads as its creator", async () => {
    const s = (await pool.query("INSERT INTO session_series (supervisor_id, session_type, title) VALUES (?, 'training', 'ZZTMD legacy')", [fx.mtId])).insertId;
    for (const [date, minutes] of [
      ["2026-02-02", 120],
      ["2026-02-03", 60],
    ]) {
      const o = (
        await pool.query(
          "INSERT INTO session_occasions (supervisor_id, session_type, title, session_date, duration_minutes, series_id) VALUES (?, 'training', 'ZZTMD legacy', ?, ?, ?)",
          [fx.mtId, date, minutes, s]
        )
      ).insertId;
      for (const sid of fx.studentIds) {
        await pool.query(
          "INSERT INTO sessions (student_id, supervisor_id, session_type, title, session_date, duration_minutes, status, occasion_id) VALUES (?, ?, 'training', 'ZZTMD legacy', ?, ?, 'completed', ?)",
          [sid, fx.mtId, date, minutes, o]
        );
      }
      await markPresent(o);
    }
    expected[fx.mtId] += 3;
    const list = await request("GET", "/master-trainer/group-session-series", mtToken);
    const legacy = list.body.series.find((x) => x.id === s);
    assertEqual(legacy.providedByName, MT, "falls back to the creator, nothing invented");
    assertEqual(legacy.mixedProviders, false, "not mixed");
    assertEqual(legacy.providers[0].hours, 3, "3h");
    const detail = await request("GET", `/master-trainer/group-session-series/${s}`, mtToken);
    assert(detail.body.days.every((d) => d.providedBySupervisorId === fx.mtId), "every day reads as the creator");
    const { rows } = await pool.query("SELECT COUNT(*) AS n FROM session_occasions WHERE series_id = ? AND provided_by_supervisor_id IS NULL", [s]);
    assertEqual(Number(rows[0].n), 2, "stored NULLs left untouched by reading");
    const bd = await breakdownMap(mtToken);
    assertEqual(bd.map[fx.mtId], expected[fx.mtId], "breakdown includes legacy hours once");
  });

  console.log("\nCleaning up ZZTMD fixtures...");
  await precleanup();
  const { rows: left } = await pool.query("SELECT COUNT(*) AS n FROM user_credentials WHERE member_code LIKE 'ZZTMD%'");
  console.log(`Teardown verification: ${left[0].n} leftover ZZTMD accounts (should be 0).`);
  const passed = results.filter((r) => r.ok).length;
  console.log("\n" + "=".repeat(60));
  console.log(`${passed}/${results.length} passed`);
  console.log("=".repeat(60));
  process.exit(passed === results.length ? 0 : 1);
}

main().catch(async (err) => {
  console.error("Test run crashed:", err);
  try {
    await precleanup();
  } catch {}
  process.exit(1);
});
