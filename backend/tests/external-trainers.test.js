// External Trainers (migration 039) -- a third, independent provider kind
// next to Internal Trainers (migration 035) and Guest Trainers (migration
// 038). Verifies External Trainers are recorded and attributed on their
// own, never mixed with Guest Trainers (separate table, column, lists,
// breakdown entries), never credited to the session's creator, never
// counted twice, Group-scoped, and protected from deletion while they have
// history -- and that Guest Trainers keep working unchanged alongside.
//
// Run: node tests/external-trainers.test.js (dev server must be running,
// migrations 038 and 039 applied to the dev database)

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
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}
function request(method, urlPath, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      BASE + urlPath,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
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
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

const fx = { groupId: null, group2Id: null, mtId: null, totId: null, mt2Id: null, adminId: null, studentIds: [] };

async function precleanup() {
  const ids = "SELECT id FROM user_credentials WHERE member_code LIKE 'ZZTEXT%'";
  const groups = "SELECT id FROM trainer_groups WHERE name LIKE 'ZZTEXT%'";
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
  await pool.query("DELETE FROM user_credentials WHERE member_code LIKE 'ZZTEXT%'");
  await pool.query("DELETE FROM trainer_groups WHERE name LIKE 'ZZTEXT%'");
}

async function cred(code, role) {
  const r = await pool.query("INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES (?, 'x', ?, 'active')", [code, role]);
  return r.insertId;
}

async function setup() {
  await precleanup();
  fx.groupId = (await pool.query("INSERT INTO trainer_groups (name) VALUES ('ZZTEXT Group')")).insertId;
  fx.group2Id = (await pool.query("INSERT INTO trainer_groups (name) VALUES ('ZZTEXT Other Group')")).insertId;
  fx.mtId = await cred("ZZTEXTMT", "supervisor");
  await pool.query("INSERT INTO supervisors (id, full_name, supervisor_type, group_id) VALUES (?, 'ZZTEXT Master Trainer', 'primary', ?)", [fx.mtId, fx.groupId]);
  fx.totId = await cred("ZZTEXTTOT", "supervisor");
  await pool.query(
    "INSERT INTO supervisors (id, full_name, supervisor_type, primary_supervisor_id, group_id) VALUES (?, 'ZZTEXT ToT', 'in_training', ?, ?)",
    [fx.totId, fx.mtId, fx.groupId]
  );
  fx.mt2Id = await cred("ZZTEXTMT2", "supervisor");
  await pool.query("INSERT INTO supervisors (id, full_name, supervisor_type, group_id) VALUES (?, 'ZZTEXT Other MT', 'primary', ?)", [fx.mt2Id, fx.group2Id]);
  fx.adminId = await cred("ZZTEXTADM", "admin");
  for (let i = 1; i <= 2; i++) {
    const id = await cred(`ZZTEXTS${i}`, "trainee");
    fx.studentIds.push(id);
    await pool.query("INSERT INTO students (id, full_name, group_id) VALUES (?, ?, ?)", [id, `ZZTEXT Trainee ${i}`, fx.groupId]);
    await pool.query("INSERT INTO supervisor_students (supervisor_id, student_id) VALUES (?, ?), (?, ?)", [fx.totId, id, fx.mtId, id]);
  }
}

async function markPresent(occasionId, recorderId) {
  await pool.query("UPDATE sessions SET status='completed' WHERE occasion_id = ?", [occasionId]);
  const { rows } = await pool.query("SELECT id, student_id, session_date FROM sessions WHERE occasion_id = ?", [occasionId]);
  for (const s of rows) {
    await pool.query(
      "INSERT INTO attendance (student_id, supervisor_id, session_id, attendance_date, status, recorded_by) VALUES (?, ?, ?, ?, 'present', ?)",
      [s.student_id, recorderId, s.id, s.session_date, recorderId]
    );
  }
}

async function breakdown(token) {
  const res = await request("GET", "/supervisor/me/group-training-breakdown", token);
  if (res.status !== 200) throw new Error(`breakdown status ${res.status}`);
  return res.body;
}

async function main() {
  console.log("Setting up isolated ZZTEXT fixtures...\n");
  await setup();
  const mtToken = tokenFor(fx.mtId, "supervisor");
  const totToken = tokenFor(fx.totId, "supervisor");
  const mt2Token = tokenFor(fx.mt2Id, "supervisor");
  const adminToken = tokenFor(fx.adminId, "admin");
  const traineeToken = tokenFor(fx.studentIds[0], "trainee");

  let ext; // External Trainer
  let guest; // Guest Trainer (associated), for coexistence checks

  console.log("Recording an External Trainer");

  await test("ToT records an External Trainer (Arabic name + organization)", async () => {
    const res = await request("POST", "/supervisor/external-trainers", totToken, {
      fullName: "  أ. سامي   Khoury ",
      organization: "University Partner",
      email: "Sami.Khoury@Uni.edu",
    });
    assertEqual(res.status, 201, "expected 201");
    ext = res.body.externalTrainer.id;
    assertEqual(res.body.key, `e:${ext}`, "provider key");
    const { rows } = await pool.query("SELECT full_name, email, organization, owner_group_id FROM external_trainers WHERE id = ?", [ext]);
    assertEqual(rows[0].full_name, "أ. سامي Khoury", "normalized name");
    assertEqual(rows[0].email, "sami.khoury@uni.edu", "normalized email");
    assertEqual(rows[0].organization, "University Partner", "organization");
    assertEqual(Number(rows[0].owner_group_id), fx.groupId, "Group-scoped");
  });

  await test("Recording the same person again reuses the record (no duplicate)", async () => {
    const res = await request("POST", "/supervisor/external-trainers", mtToken, { fullName: "أ. سامي khoury" });
    assertEqual(res.status, 200, "expected 200 (reused)");
    assertEqual(res.body.externalTrainer.id, ext, "same id");
    const { rows } = await pool.query("SELECT COUNT(*) AS n FROM external_trainers WHERE owner_group_id = ?", [fx.groupId]);
    assertEqual(Number(rows[0].n), 1, "one record");
  });

  await test("External Trainer is NOT a Guest Trainer: no guest row, no association, not in guest lists", async () => {
    const { rows: g } = await pool.query("SELECT COUNT(*) AS n FROM guest_trainers WHERE owner_group_id = ?", [fx.groupId]);
    assertEqual(Number(g[0].n), 0, "no guest_trainers row created");
    const list = await request("GET", "/master-trainer/guest-trainers", mtToken);
    assertEqual(list.body.guestTrainers.length, 0, "not in Guest Trainers");
    assertEqual(list.body.sessionOnly.length, 0, "not in Guest session-only list");
  });

  await test("Invalid email is rejected (400)", async () => {
    const res = await request("POST", "/supervisor/external-trainers", totToken, { fullName: "ZZTEXT Bad", email: "nope" });
    assertEqual(res.status, 400, "expected 400");
  });

  await test("Guest Trainer still added independently (coexistence)", async () => {
    const res = await request("POST", "/master-trainer/guest-trainers", mtToken, { fullName: "ZZTEXT Guest Lina" });
    assertEqual(res.status, 201, "expected 201");
    guest = res.body.guestTrainerId;
    const { rows } = await pool.query("SELECT COUNT(*) AS n FROM external_trainers WHERE owner_group_id = ?", [fx.groupId]);
    assertEqual(Number(rows[0].n), 1, "Guest add didn't create an External Trainer");
  });

  await test("Eligible providers list both kinds separately; Group-scoped; trainee denied", async () => {
    const res = await request("GET", "/supervisor/me/eligible-providers", totToken);
    const e = res.body.providers.find((p) => p.key === `e:${ext}`);
    const g = res.body.providers.find((p) => p.key === `g:${guest}`);
    assert(e && e.kind === "external" && e.externalTrainerId === ext, "external offered as kind 'external'");
    assert(g && g.kind === "external_guest", "guest offered as kind 'external_guest'");
    const other = await request("GET", "/supervisor/me/eligible-providers", mt2Token);
    assert(!other.body.providers.some((p) => p.key === `e:${ext}`), "another Group never sees it");
    const denied = await request("GET", "/supervisor/me/eligible-providers", traineeToken);
    assertEqual(denied.status, 403, "trainee role gate");
  });

  console.log("\nExternal Trainer as session provider");

  let extOcc;
  await test("ToT logs a 5h Session delivered by the External Trainer", async () => {
    const res = await request("POST", "/supervisor/session-occasions", totToken, {
      sessionType: "training",
      title: "ZZTEXT external-delivered",
      date: daysAgo(1),
      durationMinutes: 300,
      providedByExternalTrainerId: ext,
    });
    assertEqual(res.status, 201, "expected 201");
    extOcc = res.body.occasionId;
    await markPresent(extOcc, fx.totId);
    const { rows } = await pool.query(
      "SELECT supervisor_id, provided_by_supervisor_id AS s, provided_by_guest_trainer_id AS g, provided_by_external_trainer_id AS e FROM session_occasions WHERE id = ?",
      [extOcc]
    );
    assertEqual(Number(rows[0].supervisor_id), fx.totId, "creator unchanged");
    assertEqual(rows[0].s, null, "internal NULL");
    assertEqual(rows[0].g, null, "guest NULL");
    assertEqual(Number(rows[0].e), ext, "external recorded");
    const { rows: sess } = await pool.query(
      "SELECT COUNT(*) AS n FROM sessions WHERE occasion_id = ? AND provided_by_external_trainer_id = ? AND provided_by_supervisor_id IS NULL AND provided_by_guest_trainer_id IS NULL",
      [extOcc, ext]
    );
    assertEqual(Number(sess[0].n), 2, "every attendee row carries it");
  });

  let guestOcc;
  await test("A separate 2h Session delivered by the Guest Trainer", async () => {
    const res = await request("POST", "/supervisor/session-occasions", totToken, {
      sessionType: "training",
      title: "ZZTEXT guest-delivered",
      date: daysAgo(2),
      durationMinutes: 120,
      providedByGuestTrainerId: guest,
    });
    assertEqual(res.status, 201, "expected 201");
    guestOcc = res.body.occasionId;
    await markPresent(guestOcc, fx.totId);
  });

  await test("Breakdown: External 5h and Guest 2h as separate entries; creator 0; total 7", async () => {
    const bd = await breakdown(mtToken);
    const e = bd.breakdown.find((b) => b.kind === "external" && b.externalTrainerId === ext);
    const g = bd.breakdown.find((b) => b.kind === "guest" && b.guestTrainerId === guest);
    assert(e, "external entry present");
    assertEqual(e.hours, 5, "external hours");
    assertEqual(e.role, "External Trainer", "external role");
    assert(g, "guest entry present");
    assertEqual(g.hours, 2, "guest hours");
    assertEqual(bd.breakdown.find((b) => b.supervisorId === fx.totId).hours, 0, "creator not credited");
    assertEqual(bd.breakdown.find((b) => b.supervisorId === fx.mtId).hours, 0, "MT not credited");
    assertEqual(bd.totalHours, 7, "each hour counted exactly once");
    assert(!bd.breakdown.some((b) => b.guestTrainerId === ext && b.kind === "guest"), "external never shows up as a guest");
  });

  await test("Creator's delivered totals exclude both External and Guest Sessions", async () => {
    const delivered = await request("GET", "/supervisor/me/training-delivered", totToken);
    assertEqual(delivered.body.totalHours, 0, "/me/training-delivered");
    const caseload = await request("GET", "/supervisor/me/caseload-summary", totToken);
    assertEqual(caseload.body.totalHours, 0, "/me/caseload-summary");
    const tots = await request("GET", "/master-trainer/tots", mtToken);
    assertEqual(Number(tots.body.tots.find((t) => t.id === fx.totId).training_hours), 0, "MT's ToT table");
  });

  await test("Trainees receive all 7 hours (provider-independent)", async () => {
    for (const sid of fx.studentIds) {
      const res = await request("GET", `/supervisor/students/${sid}`, totToken);
      assertEqual(res.body.progress.hoursByType.find((h) => h.code === "training").hours, 7, `trainee ${sid}`);
    }
  });

  await test("Session detail / Activities flag External vs Guest correctly", async () => {
    const res = await request("GET", `/supervisor/session-occasions/${extOcc}`, totToken);
    const p = res.body.occasion.providedBy;
    assertEqual(p.isExternal, true, "isExternal");
    assertEqual(p.isGuest, false, "not a guest");
    assertEqual(p.externalTrainerId, ext, "externalTrainerId");
    assertEqual(p.guestTrainerId, null, "no guest id");
    assertEqual(p.id, null, "no internal id");
    assertEqual(p.name, "أ. سامي Khoury", "name");
    assertEqual(res.body.occasion.createdBy.id, fx.totId, "createdBy");
    const g = await request("GET", `/supervisor/session-occasions/${guestOcc}`, totToken);
    assertEqual(g.body.occasion.providedBy.isGuest, true, "guest session still isGuest");
    assertEqual(g.body.occasion.providedBy.isExternal, false, "guest session not external");
    const acts = await request("GET", "/supervisor/activities", totToken);
    const row = acts.body.activities.find((a) => a.kind === "occasion" && a.id === extOcc);
    assertEqual(row.providedByIsExternal, true, "activity flagged external");
    assertEqual(row.providedByIsGuest, false, "activity not guest");
    assertEqual(row.providedByName, "أ. سامي Khoury", "activity name");
  });

  await test("Two providers at once, or another Group's External Trainer, are rejected (400)", async () => {
    const both = await request("POST", "/supervisor/session-occasions", totToken, {
      sessionType: "training",
      date: daysAgo(3),
      durationMinutes: 60,
      providedByGuestTrainerId: guest,
      providedByExternalTrainerId: ext,
    });
    assertEqual(both.status, 400, "guest + external -> 400");
    const intExt = await request("POST", "/supervisor/session-occasions", totToken, {
      sessionType: "training",
      date: daysAgo(3),
      durationMinutes: 60,
      providedBySupervisorId: fx.mtId,
      providedByExternalTrainerId: ext,
    });
    assertEqual(intExt.status, 400, "internal + external -> 400");
    const foreign = (
      await pool.query("INSERT INTO external_trainers (full_name, name_key, owner_group_id) VALUES ('ZZTEXT Foreign', 'zztext foreign', ?)", [fx.group2Id])
    ).insertId;
    const res = await request("POST", "/supervisor/session-occasions", totToken, {
      sessionType: "training",
      date: daysAgo(4),
      durationMinutes: 60,
      providedByExternalTrainerId: foreign,
    });
    assertEqual(res.status, 400, "foreign external -> 400");
  });

  let seriesId;
  await test("Multi-day: day 1 External, day 2 Guest, day 3 default -- each stored on its own day", async () => {
    const res = await request("POST", "/master-trainer/group-sessions", mtToken, {
      sessionType: "training",
      title: "ZZTEXT multi-day",
      days: [
        { date: daysAgo(12), durationMinutes: 60, providedByExternalTrainerId: ext },
        { date: daysAgo(11), durationMinutes: 120, providedByGuestTrainerId: guest },
        { date: daysAgo(10), durationMinutes: 180 },
      ],
    });
    assertEqual(res.status, 201, "expected 201");
    seriesId = res.body.seriesId;
    const { rows } = await pool.query(
      "SELECT id, provided_by_supervisor_id AS s, provided_by_guest_trainer_id AS g, provided_by_external_trainer_id AS e FROM session_occasions WHERE series_id = ? ORDER BY session_date",
      [seriesId]
    );
    assert(rows[0].s === null && rows[0].g === null && Number(rows[0].e) === ext, "day 1 external only");
    assert(rows[1].s === null && Number(rows[1].g) === guest && rows[1].e === null, "day 2 guest only");
    assert(Number(rows[2].s) === fx.mtId && rows[2].g === null && rows[2].e === null, "day 3 creator");
    for (const r of rows) await markPresent(r.id, fx.mtId);
    const detail = await request("GET", `/master-trainer/group-session-series/${seriesId}`, mtToken);
    assertEqual(detail.body.days[0].providedByExternalTrainerId, ext, "day 1 external id in API");
    assertEqual(detail.body.days[0].providedByIsExternal, true, "day 1 flagged");
    assertEqual(detail.body.days[1].providedByGuestTrainerId, guest, "day 2 guest id in API");
    const bd = await breakdown(mtToken);
    assertEqual(bd.breakdown.find((b) => b.kind === "external" && b.externalTrainerId === ext).hours, 6, "external 5 + 1");
    assertEqual(bd.breakdown.find((b) => b.kind === "guest" && b.guestTrainerId === guest).hours, 4, "guest 2 + 2");
    assertEqual(bd.breakdown.find((b) => b.supervisorId === fx.mtId).hours, 3, "MT 3");
    assertEqual(bd.totalHours, 13, "total");
  });

  await test("Editing a Session's provider switches cleanly between all three kinds", async () => {
    const put = (body) => request("PUT", `/supervisor/session-occasions/${extOcc}`, totToken, { date: daysAgo(1), durationMinutes: 300, ...body });
    const cols = async () =>
      (await pool.query("SELECT provided_by_supervisor_id AS s, provided_by_guest_trainer_id AS g, provided_by_external_trainer_id AS e FROM sessions WHERE occasion_id = ?", [extOcc])).rows;
    assertEqual((await put({ providedBySupervisorId: fx.mtId })).status, 200, "-> internal");
    assert((await cols()).every((r) => Number(r.s) === fx.mtId && r.g === null && r.e === null), "internal only");
    assertEqual((await put({ providedByGuestTrainerId: guest })).status, 200, "-> guest");
    assert((await cols()).every((r) => r.s === null && Number(r.g) === guest && r.e === null), "guest only");
    assertEqual((await put({ providedByExternalTrainerId: ext })).status, 200, "-> external");
    assert((await cols()).every((r) => r.s === null && r.g === null && Number(r.e) === ext), "external only");
    const bd = await breakdown(mtToken);
    assertEqual(bd.totalHours, 13, "totals unchanged after switching back");
  });

  await test("Admin trainee profile lists External supervision hours separately from Guest", async () => {
    const e = await request("POST", "/supervisor/session-occasions", totToken, {
      sessionType: "supervision",
      date: daysAgo(5),
      durationMinutes: 90,
      providedByExternalTrainerId: ext,
    });
    await markPresent(e.body.occasionId, fx.totId);
    const g = await request("POST", "/supervisor/session-occasions", totToken, {
      sessionType: "supervision",
      date: daysAgo(6),
      durationMinutes: 60,
      providedByGuestTrainerId: guest,
    });
    await markPresent(g.body.occasionId, fx.totId);
    const prof = await request("GET", `/admin/students/${fx.studentIds[0]}/profile`, adminToken);
    const other = prof.body.trainingHours.otherProviders;
    const ex = other.find((p) => p.kind === "external");
    const gu = other.find((p) => p.kind === "guest");
    assert(ex && ex.hours === 1.5, `external 1.5h, got ${JSON.stringify(other)}`);
    assert(gu && gu.hours === 1, `guest 1h, got ${JSON.stringify(other)}`);
    assertEqual(prof.body.trainingHours.totTrainers[0].hours, 0, "creator ToT not credited");
  });

  console.log("\nManagement & permissions");

  await test("Master Trainer edits her Group's External Trainer; others can't", async () => {
    const ok = await request("PATCH", `/master-trainer/external-trainers/${ext}`, mtToken, {
      fullName: "أ. سامي Khoury",
      organization: "University Partner (Beirut)",
    });
    assertEqual(ok.status, 200, "expected 200");
    const other = await request("PATCH", `/master-trainer/external-trainers/${ext}`, mt2Token, { fullName: "Hijack" });
    assertEqual(other.status, 404, "other Group's MT -> 404");
    const tot = await request("PATCH", `/master-trainer/external-trainers/${ext}`, totToken, { fullName: "ToT edit" });
    assertEqual(tot.status, 403, "ToT -> 403");
    const { rows } = await pool.query("SELECT organization FROM external_trainers WHERE id = ?", [ext]);
    assertEqual(rows[0].organization, "University Partner (Beirut)", "saved");
  });

  await test("Lists: Group's External Trainers with sessions delivered (supervisor + admin)", async () => {
    const mine = await request("GET", "/supervisor/external-trainers", totToken);
    const row = mine.body.externalTrainers.find((t) => t.externalTrainerId === ext);
    assert(row, "listed for the ToT");
    assert(row.sessionsDelivered >= 3, `sessionsDelivered >= 3, got ${row.sessionsDelivered}`);
    const other = await request("GET", "/supervisor/external-trainers", mt2Token);
    assert(!other.body.externalTrainers.some((t) => t.externalTrainerId === ext), "other Group doesn't see it");
    const adm = await request("GET", `/admin/groups/${fx.groupId}/external-trainers`, adminToken);
    assert(adm.body.externalTrainers.some((t) => t.externalTrainerId === ext), "admin sees it");
    const patch = await request("PATCH", `/admin/external-trainers/${ext}`, adminToken, { fullName: "أ. سامي Khoury", organization: "Uni" });
    assertEqual(patch.status, 200, "admin edit");
  });

  await test("History is protected: an External Trainer with Sessions can't be deleted", async () => {
    let blocked = false;
    try {
      await pool.query("DELETE FROM external_trainers WHERE id = ?", [ext]);
    } catch (err) {
      blocked = err.code === "ER_ROW_IS_REFERENCED_2" || err.code === "ER_ROW_IS_REFERENCED";
    }
    assert(blocked, "FK RESTRICT must block deleting a referenced External Trainer");
  });

  await test("ToT-level Session (MT -> ToTs) can be delivered by an External Trainer", async () => {
    const res = await request("POST", "/master-trainer/group-tot-sessions", mtToken, {
      title: "ZZTEXT ToT training by external",
      date: daysAgo(7),
      durationMinutes: 90,
      providedByExternalTrainerId: ext,
    });
    assertEqual(res.status, 201, "expected 201");
    const { rows } = await pool.query(
      "SELECT provided_by_supervisor_id AS s, provided_by_guest_trainer_id AS g, provided_by_external_trainer_id AS e FROM tot_training_sessions WHERE occasion_id = ?",
      [res.body.occasionId]
    );
    assert(rows.length && rows.every((r) => r.s === null && r.g === null && Number(r.e) === ext), "every ToT row external only");
    const list = await request("GET", "/master-trainer/group-tot-sessions", mtToken);
    const item = list.body.occasions.find((o) => o.id === res.body.occasionId);
    assertEqual(item.providedByIsExternal, true, "list flags external");
  });

  await test("Default (no provider) unchanged: creator is the provider, no guest/external", async () => {
    const res = await request("POST", "/supervisor/session-occasions", totToken, { sessionType: "training", date: daysAgo(8), durationMinutes: 30 });
    assertEqual(res.status, 201, "expected 201");
    const { rows } = await pool.query(
      "SELECT provided_by_supervisor_id AS s, provided_by_guest_trainer_id AS g, provided_by_external_trainer_id AS e FROM session_occasions WHERE id = ?",
      [res.body.occasionId]
    );
    assert(Number(rows[0].s) === fx.totId && rows[0].g === null && rows[0].e === null, "creator only");
  });

  console.log("\nCleaning up ZZTEXT fixtures...");
  await precleanup();
  const { rows: left } = await pool.query("SELECT COUNT(*) AS n FROM user_credentials WHERE member_code LIKE 'ZZTEXT%'");
  console.log(`Teardown verification: ${left[0].n} leftover ZZTEXT accounts (should be 0).`);

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
