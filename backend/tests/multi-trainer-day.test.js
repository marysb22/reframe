// Several trainers on ONE training day (migration 040), across every
// session shape: Group Session day (single-day and multi-day), standalone
// one-trainee session, Master Trainer -> all ToTs session and Master
// Trainer -> one ToT session. A day's trainers are sequential: the day's
// duration is the sum of their minutes and each trainer is credited only
// with their own minutes -- exactly once. Also: Admin-managed trainer
// titles (descriptive only), validation, Group isolation, editing one
// trainer without touching the others, and legacy (no-contribution)
// records keeping their meaning.
//
// Run: node tests/multi-trainer-day.test.js (dev server running, migrations 038-040 applied)

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
const r2 = (n) => Math.round(Number(n) * 100) / 100;

const fx = { studentIds: [] };
const K = "ZZTMT Karim";
const H = "ZZTMT Habib";

async function cleanup() {
  const ids = "SELECT id FROM user_credentials WHERE member_code LIKE 'ZZTMT%'";
  const groups = "SELECT id FROM trainer_groups WHERE name LIKE 'ZZTMT%'";
  await pool.query(`DELETE FROM session_contributions WHERE occasion_id IN (SELECT id FROM session_occasions WHERE supervisor_id IN (${ids}))
                      OR session_id IN (SELECT id FROM sessions WHERE supervisor_id IN (${ids}))
                      OR tot_occasion_id IN (SELECT id FROM tot_session_occasions WHERE master_trainer_id IN (${ids}))
                      OR tot_session_id IN (SELECT id FROM tot_training_sessions WHERE master_trainer_id IN (${ids}))`);
  await pool.query(`DELETE FROM attendance WHERE supervisor_id IN (${ids}) OR student_id IN (${ids})`);
  await pool.query(`DELETE FROM sessions WHERE supervisor_id IN (${ids}) OR student_id IN (${ids})`);
  await pool.query(`DELETE FROM session_occasions WHERE supervisor_id IN (${ids})`);
  await pool.query(`DELETE FROM session_series WHERE supervisor_id IN (${ids})`);
  await pool.query(`DELETE FROM tot_training_attendance WHERE tot_id IN (${ids})`);
  await pool.query(`DELETE FROM tot_training_sessions WHERE master_trainer_id IN (${ids}) OR tot_id IN (${ids})`);
  await pool.query(`DELETE FROM tot_session_occasions WHERE master_trainer_id IN (${ids})`);
  await pool.query(`DELETE FROM group_guest_trainers WHERE group_id IN (${groups})`);
  await pool.query(`DELETE FROM guest_trainers WHERE owner_group_id IN (${groups})`);
  await pool.query(`DELETE FROM external_trainers WHERE owner_group_id IN (${groups})`);
  await pool.query(`DELETE FROM supervisor_students WHERE supervisor_id IN (${ids}) OR student_id IN (${ids})`);
  await pool.query(`DELETE FROM supervisors WHERE supervisor_type = 'in_training' AND id IN (${ids})`);
  await pool.query(`DELETE FROM supervisors WHERE supervisor_type = 'primary' AND id IN (${ids})`);
  await pool.query(`DELETE FROM students WHERE id IN (${ids})`);
  await pool.query("DELETE FROM user_credentials WHERE member_code LIKE 'ZZTMT%'");
  await pool.query("DELETE FROM trainer_groups WHERE name LIKE 'ZZTMT%'");
  await pool.query("DELETE FROM trainer_titles WHERE label LIKE 'ZZTMT%'");
}
async function cred(code, role) {
  return (await pool.query("INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES (?, 'x', ?, 'active')", [code, role])).insertId;
}
async function setup() {
  await cleanup();
  fx.groupId = (await pool.query("INSERT INTO trainer_groups (name) VALUES ('ZZTMT Group')")).insertId;
  fx.group2Id = (await pool.query("INSERT INTO trainer_groups (name) VALUES ('ZZTMT Other Group')")).insertId;
  fx.mtId = await cred("ZZTMTMT", "supervisor");
  await pool.query("INSERT INTO supervisors (id, full_name, supervisor_type, group_id) VALUES (?, ?, 'primary', ?)", [fx.mtId, K, fx.groupId]);
  fx.totId = await cred("ZZTMTTOT", "supervisor");
  await pool.query("INSERT INTO supervisors (id, full_name, supervisor_type, primary_supervisor_id, group_id) VALUES (?, ?, 'in_training', ?, ?)", [fx.totId, H, fx.mtId, fx.groupId]);
  fx.mt2Id = await cred("ZZTMTMT2", "supervisor");
  await pool.query("INSERT INTO supervisors (id, full_name, supervisor_type, group_id) VALUES (?, 'ZZTMT Other MT', 'primary', ?)", [fx.mt2Id, fx.group2Id]);
  fx.adminId = await cred("ZZTMTADM", "admin");
  for (let i = 1; i <= 2; i++) {
    const id = await cred(`ZZTMTS${i}`, "trainee");
    fx.studentIds.push(id);
    await pool.query("INSERT INTO students (id, full_name, group_id) VALUES (?, ?, ?)", [id, `ZZTMT Trainee ${i}`, fx.groupId]);
    await pool.query("INSERT INTO supervisor_students (supervisor_id, student_id) VALUES (?, ?), (?, ?)", [fx.totId, id, fx.mtId, id]);
  }
  fx.guestId = (await pool.query("INSERT INTO guest_trainers (full_name, name_key, owner_group_id) VALUES ('ZZTMT Guest Lina', 'zztmt guest lina', ?)", [fx.groupId])).insertId;
  await pool.query("INSERT INTO group_guest_trainers (group_id, guest_trainer_id) VALUES (?, ?)", [fx.groupId, fx.guestId]);
  fx.extId = (await pool.query("INSERT INTO external_trainers (full_name, name_key, organization, owner_group_id) VALUES ('ZZTMT External Sami', 'zztmt external sami', 'Uni', ?)", [fx.groupId])).insertId;
  fx.foreignExtId = (await pool.query("INSERT INTO external_trainers (full_name, name_key, owner_group_id) VALUES ('ZZTMT Foreign', 'zztmt foreign', ?)", [fx.group2Id])).insertId;
}
async function markOccasionPresent(occasionId) {
  await pool.query("UPDATE sessions SET status='completed' WHERE occasion_id = ?", [occasionId]);
  const { rows } = await pool.query("SELECT id, student_id, session_date FROM sessions WHERE occasion_id = ?", [occasionId]);
  for (const s of rows) {
    await pool.query("INSERT INTO attendance (student_id, supervisor_id, session_id, attendance_date, status, recorded_by) VALUES (?, ?, ?, ?, 'present', ?)", [
      s.student_id,
      fx.mtId,
      s.id,
      s.session_date,
      fx.mtId,
    ]);
  }
}
async function breakdown(token) {
  const res = await request("GET", "/supervisor/me/group-training-breakdown", token);
  const by = {};
  for (const b of res.body.breakdown) {
    const key = b.externalTrainerId ? `e:${b.externalTrainerId}` : b.guestTrainerId ? `g:${b.guestTrainerId}` : `s:${b.supervisorId}`;
    by[key] = b.hours;
  }
  return { by, total: res.body.totalHours };
}
async function contributionsOf(col, id) {
  const { rows } = await pool.query(`SELECT supervisor_id, guest_trainer_id, external_trainer_id, title_code, minutes FROM session_contributions WHERE ${col} = ? ORDER BY sort_order`, [id]);
  return rows;
}
const C = {
  mt: (minutes, titleCode = "master_trainer") => ({ providedBySupervisorId: fx.mtId, titleCode, minutes }),
  tot: (minutes, titleCode = "tot") => ({ providedBySupervisorId: fx.totId, titleCode, minutes }),
  guest: (minutes) => ({ providedByGuestTrainerId: fx.guestId, titleCode: "guest_trainer", minutes }),
  ext: (minutes) => ({ providedByExternalTrainerId: fx.extId, titleCode: "external_trainer", minutes }),
};

async function main() {
  console.log("Setting up isolated ZZTMT fixtures...\n");
  await setup();
  const mt = tokenFor(fx.mtId, "supervisor");
  const tot = tokenFor(fx.totId, "supervisor");
  const mt2 = tokenFor(fx.mt2Id, "supervisor");
  const admin = tokenFor(fx.adminId, "admin");
  const trainee = tokenFor(fx.studentIds[0], "trainee");
  const exp = { [`s:${fx.mtId}`]: 0, [`s:${fx.totId}`]: 0, [`g:${fx.guestId}`]: 0, [`e:${fx.extId}`]: 0 };
  let traineeHours = 0;
  const check = async (label) => {
    const bd = await breakdown(mt);
    for (const [k, v] of Object.entries(exp)) assertEqual(r2(bd.by[k] || 0), r2(v), `${label}: ${k}`);
    assertEqual(r2(bd.total), r2(Object.values(exp).reduce((a, b) => a + b, 0)), `${label}: total counted once`);
  };

  console.log("Titles");
  await test("Default titles are available to trainers", async () => {
    const res = await request("GET", "/supervisor/trainer-titles", tot);
    const codes = res.body.titles.map((t) => t.code);
    for (const c of ["master_trainer", "trainer", "tot", "guest_trainer", "external_trainer"]) assert(codes.includes(c), `missing ${c}`);
  });

  console.log("\nGroup Session day");
  let oneId;
  await test("One trainer on a day (with a title) -- duration = that trainer's minutes", async () => {
    const res = await request("POST", "/master-trainer/group-sessions", mt, {
      sessionType: "training",
      title: "ZZTMT one trainer",
      date: "2026-04-14",
      contributions: [C.tot(120)],
    });
    assertEqual(res.status, 201, "create");
    oneId = res.body.occasionId;
    const { rows } = await pool.query("SELECT duration_minutes, provided_by_supervisor_id AS p FROM session_occasions WHERE id = ?", [oneId]);
    assertEqual(Number(rows[0].duration_minutes), 120, "duration");
    assertEqual(Number(rows[0].p), fx.totId, "provider mirror = the trainer");
    const c = await contributionsOf("occasion_id", oneId);
    assertEqual(c.length, 1, "one contribution");
    assertEqual(c[0].title_code, "tot", "title stored");
    await markOccasionPresent(oneId);
    exp[`s:${fx.totId}`] += 2;
    traineeHours += 2;
    await check("one trainer");
  });

  let threeId;
  await test("Three trainers on the same day: 3h Master Trainer + 2h External + 1h Guest", async () => {
    const res = await request("POST", "/supervisor/session-occasions", tot, {
      sessionType: "training",
      title: "ZZTMT April 15",
      date: "2026-04-15",
      contributions: [C.mt(180), C.ext(120), C.guest(60)],
    });
    assertEqual(res.status, 201, "create");
    threeId = res.body.occasionId;
    const { rows } = await pool.query("SELECT duration_minutes, supervisor_id FROM session_occasions WHERE id = ?", [threeId]);
    assertEqual(Number(rows[0].duration_minutes), 360, "day total = 3+2+1 = 6h");
    assertEqual(Number(rows[0].supervisor_id), fx.totId, "creator stays the ToT who logged it");
    const c = await contributionsOf("occasion_id", threeId);
    assertEqual(c.length, 3, "three contributions");
    assertEqual(c.map((x) => x.title_code).join(","), "master_trainer,external_trainer,guest_trainer", "each with its own title");
    await markOccasionPresent(threeId);
    exp[`s:${fx.mtId}`] += 3;
    exp[`e:${fx.extId}`] += 2;
    exp[`g:${fx.guestId}`] += 1;
    traineeHours += 6;
    await check("three trainers");
  });

  await test("Creator is not credited; each trainer's own totals are right", async () => {
    const totDelivered = await request("GET", "/supervisor/me/training-delivered", tot);
    assertEqual(r2(totDelivered.body.totalHours), 2, "ToT delivered only her own 2h (not the 6h day she logged)");
    const mtDelivered = await request("GET", "/supervisor/me/training-delivered", mt);
    assertEqual(r2(mtDelivered.body.totalHours), 3, "Master Trainer delivered exactly her 3h");
    const tots = await request("GET", "/master-trainer/tots", mt);
    assertEqual(r2(tots.body.tots.find((t) => t.id === fx.totId).training_hours), 2, "MT's ToT table");
    const detail = await request("GET", `/master-trainer/tots/${fx.totId}`, mt);
    assertEqual(r2(detail.body.stats.training_hours), 2, "ToT detail stats");
  });

  await test("Trainees receive the whole day (6h), once", async () => {
    for (const sid of fx.studentIds) {
      const res = await request("GET", `/supervisor/students/${sid}`, tot);
      assertEqual(r2(res.body.progress.hoursByType.find((h) => h.code === "training").hours), r2(traineeHours), `trainee ${sid}`);
    }
  });

  await test("Reopen: day detail and lists show every trainer with title and hours", async () => {
    const d = await request("GET", `/supervisor/session-occasions/${threeId}`, tot);
    const list = d.body.occasion.contributions;
    assertEqual(list.length, 3, "three trainers");
    assertEqual(list[0].name, K, "Karim first");
    assertEqual(list[0].titleLabel, "Master Trainer", "title label");
    assertEqual(list[0].minutes, 180, "her minutes");
    assertEqual(list[1].kind, "external", "external kind");
    const l = await request("GET", "/supervisor/session-occasions", tot);
    const row = l.body.occasions.find((o) => o.id === threeId);
    assertEqual(row.providedByName, `${K}, ZZTMT External Sami, ZZTMT Guest Lina`, "list names all trainers");
    const acts = await request("GET", "/supervisor/activities?pageSize=100", tot);
    assertEqual(acts.body.activities.find((a) => a.kind === "occasion" && a.id === threeId).contributions.length, 3, "activities carry them");
  });

  await test("Edit ONE trainer's hours; the others are unchanged", async () => {
    const res = await request("PUT", `/supervisor/session-occasions/${threeId}`, tot, {
      date: "2026-04-15",
      contributions: [C.mt(180), C.ext(90), C.guest(60)],
    });
    assertEqual(res.status, 200, "edit");
    const c = await contributionsOf("occasion_id", threeId);
    assertEqual(c.map((x) => x.minutes).join(","), "180,90,60", "only the external's minutes changed");
    const { rows } = await pool.query("SELECT duration_minutes FROM session_occasions WHERE id = ?", [threeId]);
    assertEqual(Number(rows[0].duration_minutes), 330, "day total recalculated");
    const { rows: srows } = await pool.query("SELECT DISTINCT duration_minutes FROM sessions WHERE occasion_id = ?", [threeId]);
    assertEqual(Number(srows[0].duration_minutes), 330, "every attendee row follows");
    exp[`e:${fx.extId}`] -= 0.5;
    traineeHours -= 0.5;
    await check("after edit");
  });

  await test("Remove a trainer from the day", async () => {
    const res = await request("PUT", `/supervisor/session-occasions/${threeId}`, tot, {
      date: "2026-04-15",
      contributions: [C.mt(180), C.ext(90)],
    });
    assertEqual(res.status, 200, "edit");
    assertEqual((await contributionsOf("occasion_id", threeId)).length, 2, "two left");
    exp[`g:${fx.guestId}`] -= 1;
    traineeHours -= 1;
    await check("after removal");
  });

  await test("An old-style request can't silently re-split a multi-trainer day", async () => {
    const bad = await request("PUT", `/supervisor/session-occasions/${threeId}`, tot, { date: "2026-04-15", durationMinutes: 600 });
    assertEqual(bad.status, 400, "changing the total without trainers -> 400");
    const ok = await request("PUT", `/supervisor/session-occasions/${threeId}`, tot, { date: "2026-04-15", durationMinutes: 270, title: "ZZTMT April 15 (renamed)" });
    assertEqual(ok.status, 200, "same total, other fields -> fine");
    assertEqual((await contributionsOf("occasion_id", threeId)).length, 2, "trainers kept");
  });

  await test("Validation: duplicates, 0 hours, unknown title, other Group's trainer -- nothing written", async () => {
    const before = (await pool.query("SELECT COUNT(*) AS n FROM session_occasions WHERE supervisor_id = ?", [fx.mtId])).rows[0].n;
    const cases = [
      [C.mt(60), C.mt(60)],
      [C.mt(0)],
      [{ ...C.mt(60), titleCode: "no_such_title" }],
      [{ providedByExternalTrainerId: fx.foreignExtId, minutes: 60 }],
      [{ providedBySupervisorId: fx.mt2Id, minutes: 60 }],
      [{ providedBySupervisorId: fx.mtId, providedByGuestTrainerId: fx.guestId, minutes: 60 }],
    ];
    for (const contributions of cases) {
      const res = await request("POST", "/master-trainer/group-sessions", mt, { sessionType: "training", date: "2026-04-20", contributions });
      assertEqual(res.status, 400, `rejected: ${JSON.stringify(contributions)}`);
    }
    const after = (await pool.query("SELECT COUNT(*) AS n FROM session_occasions WHERE supervisor_id = ?", [fx.mtId])).rows[0].n;
    assertEqual(Number(after), Number(before), "no day written");
  });

  console.log("\nMulti-day Session");
  let seriesId;
  await test("Each day has its own set of trainers", async () => {
    const res = await request("POST", "/master-trainer/group-sessions", mt, {
      sessionType: "training",
      title: "ZZTMT multi-day",
      days: [
        { date: "2026-05-04", contributions: [C.mt(120), C.tot(60)] },
        { date: "2026-05-05", contributions: [C.ext(180)] },
      ],
    });
    assertEqual(res.status, 201, "create");
    seriesId = res.body.seriesId;
    const { rows } = await pool.query("SELECT id, duration_minutes FROM session_occasions WHERE series_id = ? ORDER BY session_date", [seriesId]);
    assertEqual(rows.map((r) => Number(r.duration_minutes)).join(","), "180,180", "each day's own total");
    for (const r of rows) await markOccasionPresent(r.id);
    exp[`s:${fx.mtId}`] += 2;
    exp[`s:${fx.totId}`] += 1;
    exp[`e:${fx.extId}`] += 3;
    traineeHours += 6;
    await check("multi-day");
    const list = await request("GET", "/master-trainer/group-session-series", mt);
    const s = list.body.series.find((x) => x.id === seriesId);
    assertEqual(s.mixedProviders, true, "mixed");
    const by = Object.fromEntries(s.providers.map((p) => [p.name, p.hours]));
    assertEqual(by[K], 2, "Karim 2h");
    assertEqual(by[H], 1, "Habib 1h");
    assertEqual(by["ZZTMT External Sami"], 3, "Sami 3h");
    const detail = await request("GET", `/master-trainer/group-session-series/${seriesId}`, mt);
    assertEqual(detail.body.days[0].contributions.length, 2, "day 1 two trainers");
    assertEqual(detail.body.days[1].contributions[0].kind, "external", "day 2 external");
  });

  await test("Edit one day of the series without touching the other", async () => {
    const detail = await request("GET", `/master-trainer/group-session-series/${seriesId}`, mt);
    const days = detail.body.days.map((d) => ({ occasionId: d.occasionId, date: String(d.date).slice(0, 10), contributions: d.contributions.map((c) => ({
      providedBySupervisorId: c.supervisorId, providedByGuestTrainerId: c.guestTrainerId, providedByExternalTrainerId: c.externalTrainerId, titleCode: c.titleCode, minutes: c.minutes,
    })) }));
    days[1].contributions = [C.ext(120), C.guest(60)];
    const res = await request("PUT", `/master-trainer/group-session-series/${seriesId}`, mt, { sessionType: "training", title: "ZZTMT multi-day", days });
    assertEqual(res.status, 200, "edit");
    const day1 = await contributionsOf("occasion_id", detail.body.days[0].occasionId);
    assertEqual(day1.map((x) => x.minutes).join(","), "120,60", "day 1 untouched");
    exp[`e:${fx.extId}`] -= 1;
    exp[`g:${fx.guestId}`] += 1;
    await check("series edit");
  });

  console.log("\nStandalone one-trainee session");
  await test("Two trainers on a standalone session, partial attendance split proportionally", async () => {
    const res = await request("POST", `/supervisor/students/${fx.studentIds[0]}/records`, tot, {
      recordType: "training_session",
      title: "ZZTMT standalone",
      date: "2026-03-10",
      attendanceStatus: "partial",
      minutesCompleted: 60,
      contributions: [C.tot(60), C.guest(60)],
    });
    assertEqual(res.status, 201, `create (${JSON.stringify(res.body)})`);
    const { rows } = await pool.query("SELECT id, duration_minutes FROM sessions WHERE title = 'ZZTMT standalone'");
    assertEqual(Number(rows[0].duration_minutes), 120, "duration = sum");
    assertEqual((await contributionsOf("session_id", rows[0].id)).length, 2, "two trainers stored");
    // trainee attended 60 of 120 minutes -> each trainer credited 30 min
    exp[`s:${fx.totId}`] += 0.5;
    exp[`g:${fx.guestId}`] += 0.5;
    await check("standalone");
    const recs = await request("GET", "/profile/records", trainee);
    const rec = recs.body.records.find((r) => r.title === "ZZTMT standalone");
    assertEqual(rec.providedByName, `${H}, ZZTMT Guest Lina`, "trainee history names both trainers");
    assertEqual(rec.contributions.length, 2, "with their contributions");
  });

  console.log("\nToT sessions (Master Trainer -> ToTs)");
  await test("All-ToTs session with Master Trainer + External; a ToT can't be one of its trainers", async () => {
    const ok = await request("POST", "/master-trainer/group-tot-sessions", mt, {
      title: "ZZTMT ToT day",
      date: "2026-03-20",
      contributions: [C.mt(120), C.ext(60)],
    });
    assertEqual(ok.status, 201, "create");
    const { rows } = await pool.query("SELECT duration_minutes FROM tot_session_occasions WHERE id = ?", [ok.body.occasionId]);
    assertEqual(Number(rows[0].duration_minutes), 180, "duration = sum");
    const list = await request("GET", "/master-trainer/group-tot-sessions", mt);
    assertEqual(list.body.occasions.find((o) => o.id === ok.body.occasionId).contributions.length, 2, "list carries trainers");
    const bad = await request("POST", "/master-trainer/group-tot-sessions", mt, { title: "x", date: "2026-03-21", contributions: [C.tot(60)] });
    assertEqual(bad.status, 400, "ToT as trainer -> 400");
  });

  await test("One-ToT session: create with two trainers, then change one trainer's hours", async () => {
    const res = await request("POST", `/master-trainer/tots/${fx.totId}/sessions`, mt, {
      date: "2026-03-22",
      attendanceStatus: "present",
      contributions: [C.mt(60), C.guest(30)],
    });
    assertEqual(res.status, 201, "create");
    assertEqual(res.body.durationMinutes, 90, "duration = sum");
    const put = await request("PUT", `/master-trainer/tots/${fx.totId}/sessions/${res.body.id}`, mt, { contributions: [C.mt(60), C.guest(60)] });
    assertEqual(put.status, 200, "edit");
    const { rows } = await pool.query("SELECT duration_minutes FROM tot_training_sessions WHERE id = ?", [res.body.id]);
    assertEqual(Number(rows[0].duration_minutes), 120, "updated total");
    const hist = await request("GET", `/master-trainer/tots/${fx.totId}/sessions`, mt);
    assertEqual(hist.body.sessions.find((x) => x.id === res.body.id).contributions.length, 2, "history carries trainers");
  });

  console.log("\nReports, calendar, history");
  await test("Weekly report, calendar and trainee history name a day's trainers", async () => {
    const weekly = await request("GET", "/master-trainer/reports/weekly?week=2026-04-13", mt);
    const rows = weekly.body.sessions.filter((s) => s.title === "ZZTMT April 15 (renamed)");
    assert(rows.length === 2, "two trainees in the weekly report");
    assertEqual(rows[0].providedByName, `${K}, ZZTMT External Sami`, "weekly names both");
    const cal = await request("GET", "/master-trainer/calendar-sessions?start=2026-04-15&end=2026-04-15", mt);
    assertEqual(cal.body.events.find((e) => e.id === threeId).providedByName, `${K}, ZZTMT External Sami`, "calendar names both");
  });

  await test("A legacy day (no contributions) keeps its single-provider attribution", async () => {
    const res = await request("POST", "/master-trainer/group-sessions", mt, { sessionType: "training", date: "2026-02-02", durationMinutes: 90, providedBySupervisorId: fx.totId });
    assertEqual(res.status, 201, "legacy-style create");
    assertEqual((await contributionsOf("occasion_id", res.body.occasionId)).length, 0, "no contribution rows");
    await markOccasionPresent(res.body.occasionId);
    exp[`s:${fx.totId}`] += 1.5;
    await check("legacy");
  });

  console.log("\nAdmin titles");
  await test("Admin adds, renames and deactivates a title; non-admins can't", async () => {
    const add = await request("POST", "/admin/trainer-titles", admin, { label: "ZZTMT Co-Facilitator" });
    assertEqual(add.status, 201, "create");
    const dup = await request("POST", "/admin/trainer-titles", admin, { label: "zztmt co-facilitator" });
    assertEqual(dup.status, 409, "duplicate");
    const ren = await request("PATCH", `/admin/trainer-titles/${add.body.code}`, admin, { label: "ZZTMT Co-Trainer" });
    assertEqual(ren.status, 200, "rename");
    const off = await request("PATCH", `/admin/trainer-titles/${add.body.code}`, admin, { isActive: false });
    assertEqual(off.status, 200, "deactivate");
    const active = await request("GET", "/supervisor/trainer-titles", tot);
    assert(!active.body.titles.some((t) => t.code === add.body.code), "inactive title not offered");
    const use = await request("POST", "/master-trainer/group-sessions", mt, { sessionType: "training", date: "2026-04-25", contributions: [C.mt(60, add.body.code)] });
    assertEqual(use.status, 400, "inactive title rejected on a new day");
    assertEqual((await request("POST", "/admin/trainer-titles", mt, { label: "X" })).status, 403, "non-admin -> 403");
  });

  await test("A title grants no permission: a ToT titled 'Master Trainer' is still a ToT", async () => {
    await request("POST", "/master-trainer/group-sessions", mt, { sessionType: "training", date: "2026-04-26", contributions: [C.tot(60, "master_trainer")] });
    assertEqual((await request("GET", "/master-trainer/tots", tot)).status, 403, "no Master Trainer access");
    const { rows } = await pool.query("SELECT supervisor_type FROM supervisors WHERE id = ?", [fx.totId]);
    assertEqual(rows[0].supervisor_type, "in_training", "role unchanged");
  });

  await test("Group isolation: another Group's trainer can't edit or read this Group's day", async () => {
    const put = await request("PUT", `/master-trainer/group-sessions/${oneId}`, mt2, { date: "2026-04-14", contributions: [{ providedBySupervisorId: fx.mt2Id, minutes: 60 }] });
    assertEqual(put.status, 404, "other Group's MT can't edit it (not her day)");
    const c = await contributionsOf("occasion_id", oneId);
    assertEqual(c.length, 1, "day unchanged");
    assertEqual(Number(c[0].supervisor_id), fx.totId, "trainer unchanged");
    const get = await request("GET", `/master-trainer/group-sessions/${oneId}`, mt2);
    assertEqual(get.status, 404, "can't read it");
    const tr = await request("GET", "/supervisor/trainer-titles", trainee);
    assertEqual(tr.status, 403, "trainee can't use trainer routes");
  });

  console.log("\nCleaning up ZZTMT fixtures...");
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
