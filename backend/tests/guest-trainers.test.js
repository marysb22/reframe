// Guest Trainers (migration 038) -- a Group can associate external trainers
// (no login) or another Group's trainer account, and any session can record
// an external trainer as its actual provider. Verifies the relationships
// stay separate (creator / provider / Group responsibility / association),
// hours land on exactly one provider, authorization is Group-scoped and
// deny-by-default, duplicates are rejected, and removing an association
// never rewrites history.
//
// Run: node tests/guest-trainers.test.js (dev server must be running,
// migration 038 applied to the dev database)

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
const today = () => new Date().toISOString().slice(0, 10);
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

const fx = { groupId: null, group2Id: null, mtId: null, totId: null, mt2Id: null, adminId: null, studentIds: [] };

async function precleanup() {
  const ids = "SELECT id FROM user_credentials WHERE member_code LIKE 'ZZTGUEST%'";
  const groups = "SELECT id FROM trainer_groups WHERE name LIKE 'ZZTGUEST%'";
  await pool.query(`DELETE FROM attendance WHERE supervisor_id IN (${ids}) OR student_id IN (${ids})`);
  await pool.query(`DELETE FROM sessions WHERE supervisor_id IN (${ids}) OR student_id IN (${ids})`);
  await pool.query(`DELETE FROM session_occasions WHERE supervisor_id IN (${ids})`);
  await pool.query(`DELETE FROM session_series WHERE supervisor_id IN (${ids})`);
  await pool.query(`DELETE FROM tot_training_attendance WHERE tot_id IN (${ids})`);
  await pool.query(`DELETE FROM tot_training_sessions WHERE master_trainer_id IN (${ids}) OR tot_id IN (${ids})`);
  await pool.query(`DELETE FROM tot_session_occasions WHERE master_trainer_id IN (${ids})`);
  await pool.query(`DELETE FROM group_guest_trainers WHERE group_id IN (${groups})`);
  await pool.query(`DELETE FROM guest_trainers WHERE owner_group_id IN (${groups})`);
  await pool.query(`DELETE FROM supervisor_students WHERE supervisor_id IN (${ids}) OR student_id IN (${ids})`);
  await pool.query(`DELETE FROM supervisors WHERE supervisor_type = 'in_training' AND id IN (${ids})`);
  await pool.query(`DELETE FROM supervisors WHERE supervisor_type = 'primary' AND id IN (${ids})`);
  await pool.query(`DELETE FROM students WHERE id IN (${ids})`);
  await pool.query("DELETE FROM user_credentials WHERE member_code LIKE 'ZZTGUEST%'");
  await pool.query("DELETE FROM trainer_groups WHERE name LIKE 'ZZTGUEST%'");
}

async function cred(code, role) {
  const r = await pool.query("INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES (?, 'x', ?, 'active')", [code, role]);
  return r.insertId;
}

async function setup() {
  await precleanup();
  fx.groupId = (await pool.query("INSERT INTO trainer_groups (name) VALUES ('ZZTGUEST Group')")).insertId;
  fx.group2Id = (await pool.query("INSERT INTO trainer_groups (name) VALUES ('ZZTGUEST Other Group')")).insertId;

  fx.mtId = await cred("ZZTGUESTMT", "supervisor");
  await pool.query("INSERT INTO supervisors (id, full_name, supervisor_type, group_id) VALUES (?, 'ZZTGUEST Master Trainer', 'primary', ?)", [fx.mtId, fx.groupId]);
  fx.totId = await cred("ZZTGUESTTOT", "supervisor");
  await pool.query(
    "INSERT INTO supervisors (id, full_name, supervisor_type, primary_supervisor_id, group_id) VALUES (?, 'ZZTGUEST ToT', 'in_training', ?, ?)",
    [fx.totId, fx.mtId, fx.groupId]
  );
  fx.mt2Id = await cred("ZZTGUESTMT2", "supervisor");
  await pool.query("INSERT INTO supervisors (id, full_name, supervisor_type, group_id) VALUES (?, 'ZZTGUEST Other Group MT', 'primary', ?)", [fx.mt2Id, fx.group2Id]);
  fx.adminId = await cred("ZZTGUESTADM", "admin");

  for (let i = 1; i <= 2; i++) {
    const id = await cred(`ZZTGUESTS${i}`, "trainee");
    fx.studentIds.push(id);
    await pool.query("INSERT INTO students (id, full_name, group_id) VALUES (?, ?, ?)", [id, `ZZTGUEST Trainee ${i}`, fx.groupId]);
    await pool.query("INSERT INTO supervisor_students (supervisor_id, student_id) VALUES (?, ?), (?, ?)", [fx.totId, id, fx.mtId, id]);
  }
}

/** Marks every trainee present on an occasion so its hours count. */
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

async function main() {
  console.log("Setting up isolated ZZTGUEST fixtures...\n");
  await setup();
  const mtToken = tokenFor(fx.mtId, "supervisor");
  const totToken = tokenFor(fx.totId, "supervisor");
  const mt2Token = tokenFor(fx.mt2Id, "supervisor");
  const adminToken = tokenFor(fx.adminId, "admin");
  const traineeToken = tokenFor(fx.studentIds[0], "trainee");

  let rana; // external guest associated with the Group
  let ranaAssociationId;
  let internalAssociationId;

  console.log("Group association (use case A)");

  await test("Master Trainer adds an external Guest Trainer (Arabic name) to her own Group", async () => {
    const res = await request("POST", "/master-trainer/guest-trainers", mtToken, {
      fullName: "  د. رنا   Haddad ",
      email: "Rana.Haddad@Example.org",
      organization: "Partner NGO",
    });
    assertEqual(res.status, 201, "expected 201");
    rana = res.body.guestTrainerId;
    ranaAssociationId = res.body.associationId;
    const { rows } = await pool.query("SELECT full_name, email, owner_group_id FROM guest_trainers WHERE id = ?", [rana]);
    assertEqual(rows[0].full_name, "د. رنا Haddad", "name trimmed and whitespace-collapsed");
    assertEqual(rows[0].email, "rana.haddad@example.org", "email normalized to lowercase");
    assertEqual(Number(rows[0].owner_group_id), fx.groupId, "record scoped to the Group");
  });

  await test("Adding the same person again (different spacing/case) is a 409, not a duplicate row", async () => {
    const res = await request("POST", "/master-trainer/guest-trainers", mtToken, { fullName: "د. رنا haddad" });
    assertEqual(res.status, 409, "expected 409");
    const { rows } = await pool.query("SELECT COUNT(*) AS n FROM guest_trainers WHERE owner_group_id = ?", [fx.groupId]);
    assertEqual(Number(rows[0].n), 1, "still exactly one guest record");
  });

  await test("Concurrent identical submissions still create one association", async () => {
    const body = { fullName: "ZZTGUEST Concurrent Person" };
    const [a, b] = await Promise.all([
      request("POST", "/master-trainer/guest-trainers", mtToken, body),
      request("POST", "/master-trainer/guest-trainers", mtToken, body),
    ]);
    const statuses = [a.status, b.status].sort();
    assert(statuses[0] === 201, `one request must succeed, got ${statuses}`);
    assert(statuses[1] === 409 || statuses[1] === 500, `the other must not create a duplicate, got ${statuses}`);
    const { rows } = await pool.query(
      "SELECT COUNT(*) AS n FROM group_guest_trainers ggt JOIN guest_trainers gt ON gt.id = ggt.guest_trainer_id WHERE gt.full_name = 'ZZTGUEST Concurrent Person'"
    );
    assertEqual(Number(rows[0].n), 1, "exactly one association row");
  });

  await test("Invalid email is rejected (400)", async () => {
    const res = await request("POST", "/master-trainer/guest-trainers", mtToken, { fullName: "ZZTGUEST Bad Email", email: "not-an-email" });
    assertEqual(res.status, 400, "expected 400");
  });

  await test("A ToT cannot manage Group Guest Trainers (403)", async () => {
    const res = await request("POST", "/master-trainer/guest-trainers", totToken, { fullName: "ZZTGUEST Sneaky" });
    assertEqual(res.status, 403, "expected 403");
  });

  await test("A Master Trainer cannot link an existing account from another Group (Admin-only, 403)", async () => {
    const res = await request("POST", "/master-trainer/guest-trainers", mtToken, { supervisorId: fx.mt2Id });
    assertEqual(res.status, 403, "expected 403");
  });

  await test("Another Group's Master Trainer can't see or remove this Group's guests", async () => {
    const list = await request("GET", "/master-trainer/guest-trainers", mt2Token);
    assertEqual(list.status, 200, "expected 200");
    assert(!list.body.guestTrainers.some((g) => g.guestTrainerId === rana), "must not list another Group's guest");
    const del = await request("DELETE", `/master-trainer/guest-trainers/associations/${ranaAssociationId}`, mt2Token);
    assertEqual(del.status, 404, "expected 404 for another Group's association");
    const edit = await request("PATCH", `/master-trainer/guest-trainers/${rana}`, mt2Token, { fullName: "Hijacked" });
    assertEqual(edit.status, 404, "expected 404 editing another Group's guest");
  });

  await test("Admin links another Group's trainer account as an internal Guest Trainer", async () => {
    const res = await request("POST", `/admin/groups/${fx.groupId}/guest-trainers`, adminToken, { supervisorId: fx.mt2Id });
    assertEqual(res.status, 201, "expected 201");
    internalAssociationId = res.body.associationId;
    const again = await request("POST", `/admin/groups/${fx.groupId}/guest-trainers`, adminToken, { supervisorId: fx.mt2Id });
    assertEqual(again.status, 409, "duplicate association must be 409");
    const member = await request("POST", `/admin/groups/${fx.groupId}/guest-trainers`, adminToken, { supervisorId: fx.totId });
    assertEqual(member.status, 409, "a current Group member can't also be its guest");
  });

  await test("Being a Guest Trainer changes nothing about the account's role, Group or caseload", async () => {
    const { rows } = await pool.query("SELECT supervisor_type, group_id FROM supervisors WHERE id = ?", [fx.mt2Id]);
    assertEqual(rows[0].supervisor_type, "primary", "role unchanged");
    assertEqual(Number(rows[0].group_id), fx.group2Id, "Group unchanged");
    const { rows: cl } = await pool.query("SELECT COUNT(*) AS n FROM supervisor_students WHERE supervisor_id = ?", [fx.mt2Id]);
    assertEqual(Number(cl[0].n), 0, "no caseload links granted");
    // No access to this Group's data through the association.
    const res = await request("GET", `/supervisor/students/${fx.studentIds[0]}`, mt2Token);
    assertEqual(res.status, 403, "internal guest must not gain access to this Group's trainee");
  });

  await test("Admin lists the Group's guests with both kinds", async () => {
    const res = await request("GET", `/admin/groups/${fx.groupId}/guest-trainers`, adminToken);
    assertEqual(res.status, 200, "expected 200");
    assert(res.body.guestTrainers.some((g) => g.kind === "external" && g.guestTrainerId === rana), "external guest listed");
    assert(res.body.guestTrainers.some((g) => g.kind === "internal" && g.supervisorId === fx.mt2Id), "internal guest listed");
  });

  console.log("\nSession provider (use case B)");

  await test("Eligible providers = members + guests, Group-scoped; trainees are denied", async () => {
    const res = await request("GET", "/supervisor/me/eligible-providers", totToken);
    assertEqual(res.status, 200, "expected 200");
    const keys = res.body.providers.map((p) => p.key);
    assert(keys.includes(`s:${fx.mtId}`) && keys.includes(`s:${fx.totId}`), "members offered");
    assert(keys.includes(`g:${rana}`), "external guest offered");
    assert(keys.includes(`s:${fx.mt2Id}`), "internal guest offered");
    const other = await request("GET", "/supervisor/me/eligible-providers", mt2Token);
    assert(!other.body.providers.some((p) => p.key === `g:${rana}`), "another Group never sees this Group's external guest");
    const denied = await request("GET", "/supervisor/me/eligible-providers", traineeToken);
    assertEqual(denied.status, 403, "trainee role gate");
  });

  let guestOccasionId;
  await test("ToT logs a 5h Session delivered by the external Guest Trainer", async () => {
    const res = await request("POST", "/supervisor/session-occasions", totToken, {
      sessionType: "training",
      title: "ZZTGUEST Guest-delivered",
      date: today(),
      durationMinutes: 300,
      providedByGuestTrainerId: rana,
    });
    assertEqual(res.status, 201, "expected 201");
    guestOccasionId = res.body.occasionId;
    await markPresent(guestOccasionId, fx.totId);
    const { rows } = await pool.query(
      "SELECT supervisor_id, provided_by_supervisor_id, provided_by_guest_trainer_id FROM session_occasions WHERE id = ?",
      [guestOccasionId]
    );
    assertEqual(Number(rows[0].supervisor_id), fx.totId, "creator stays the ToT");
    assertEqual(rows[0].provided_by_supervisor_id, null, "internal provider column must be NULL");
    assertEqual(Number(rows[0].provided_by_guest_trainer_id), rana, "guest provider recorded");
    const { rows: sess } = await pool.query(
      "SELECT COUNT(*) AS n FROM sessions WHERE occasion_id = ? AND provided_by_supervisor_id IS NULL AND provided_by_guest_trainer_id = ?",
      [guestOccasionId, rana]
    );
    assertEqual(Number(sess[0].n), 2, "every attendee row carries the same guest provider");
  });

  await test("Breakdown: the 5h go to the Guest Trainer only -- not the creator, not counted twice", async () => {
    const res = await request("GET", "/supervisor/me/group-training-breakdown", mtToken);
    assertEqual(res.status, 200, "expected 200");
    const guest = res.body.breakdown.find((b) => b.guestTrainerId === rana);
    const tot = res.body.breakdown.find((b) => b.supervisorId === fx.totId);
    const mt = res.body.breakdown.find((b) => b.supervisorId === fx.mtId);
    assert(guest, "guest listed in the breakdown");
    assertEqual(guest.hours, 5, "guest credited 5h");
    assertEqual(tot.hours, 0, "creator (ToT) not credited");
    assertEqual(mt.hours, 0, "Master Trainer not credited");
    assertEqual(res.body.totalHours, 5, "total counts the session exactly once");
  });

  await test("Creator's own delivered totals exclude the guest-delivered Session", async () => {
    const delivered = await request("GET", "/supervisor/me/training-delivered", totToken);
    assertEqual(delivered.body.totalHours, 0, "/me/training-delivered");
    const caseload = await request("GET", "/supervisor/me/caseload-summary", totToken);
    assertEqual(caseload.body.totalHours, 0, "/me/caseload-summary");
    const tots = await request("GET", "/master-trainer/tots", mtToken);
    const row = tots.body.tots.find((t) => t.id === fx.totId);
    assertEqual(Number(row.training_hours), 0, "MT's ToT table hours delivered");
  });

  await test("Trainees still receive the hours (attendance-based, provider-independent)", async () => {
    for (const sid of fx.studentIds) {
      const res = await request("GET", `/supervisor/students/${sid}`, totToken);
      assertEqual(res.status, 200, "expected 200");
      const training = (res.body.progress.hoursByType || []).find((h) => h.code === "training");
      assertEqual(training.hours, 5, `trainee ${sid} training hours`);
    }
  });

  await test("Session detail and Activities list show the Guest as provider and the ToT as creator", async () => {
    const res = await request("GET", `/supervisor/session-occasions/${guestOccasionId}`, totToken);
    assertEqual(res.body.occasion.createdBy.id, fx.totId, "createdBy");
    assertEqual(res.body.occasion.providedBy.guestTrainerId, rana, "providedBy.guestTrainerId");
    assertEqual(res.body.occasion.providedBy.isGuest, true, "providedBy.isGuest");
    assertEqual(res.body.occasion.providedBy.id, null, "no internal provider id");
    assertEqual(res.body.occasion.providedBy.name, "د. رنا Haddad", "providedBy.name");
    const acts = await request("GET", "/supervisor/activities", totToken);
    const row = acts.body.activities.find((a) => a.kind === "occasion" && a.id === guestOccasionId);
    assert(row, "activity row present");
    assertEqual(row.providedByName, "د. رنا Haddad", "activity providedByName");
    assertEqual(row.providedByIsGuest, true, "activity providedByIsGuest");
  });

  await test("Admin trainee profile lists the Guest Trainer's supervision hours separately", async () => {
    const res = await request("POST", "/supervisor/session-occasions", totToken, {
      sessionType: "supervision",
      title: "ZZTGUEST Guest supervision",
      date: daysAgo(1),
      durationMinutes: 120,
      providedByGuestTrainerId: rana,
    });
    assertEqual(res.status, 201, "expected 201");
    await markPresent(res.body.occasionId, fx.totId);
    const prof = await request("GET", `/admin/students/${fx.studentIds[0]}/profile`, adminToken);
    assertEqual(prof.status, 200, "expected 200");
    const other = (prof.body.trainingHours.otherProviders || []).find((p) => p.kind === "guest");
    assert(other, "guest listed under otherProviders");
    assertEqual(other.hours, 2, "2h supervision credited to the guest");
    assertEqual(prof.body.trainingHours.totTrainers[0].hours, 0, "ToT (creator) not credited for it");
  });

  await test("Both providers at once, or another Group's guest, are rejected (400)", async () => {
    const both = await request("POST", "/supervisor/session-occasions", totToken, {
      sessionType: "training",
      date: daysAgo(2),
      durationMinutes: 60,
      providedBySupervisorId: fx.mtId,
      providedByGuestTrainerId: rana,
    });
    assertEqual(both.status, 400, "both set -> 400");
    const foreign = (
      await pool.query("INSERT INTO guest_trainers (full_name, name_key, owner_group_id) VALUES ('ZZTGUEST Foreign', 'zztguest foreign', ?)", [fx.group2Id])
    ).insertId;
    const res = await request("POST", "/supervisor/session-occasions", totToken, {
      sessionType: "training",
      date: daysAgo(3),
      durationMinutes: 60,
      providedByGuestTrainerId: foreign,
    });
    assertEqual(res.status, 400, "foreign guest -> 400");
  });

  let sessionOnlyId;
  await test("Session-only external trainer: created without association, idempotent", async () => {
    const a = await request("POST", "/supervisor/session-guest-trainers", totToken, { fullName: "ZZTGUEST One-Off Speaker" });
    assertEqual(a.status, 201, "first call creates");
    sessionOnlyId = a.body.guestTrainer.id;
    const b = await request("POST", "/supervisor/session-guest-trainers", totToken, { fullName: "zztguest  one-off speaker" });
    assertEqual(b.status, 200, "second call reuses");
    assertEqual(b.body.guestTrainer.id, sessionOnlyId, "same record");
    const { rows } = await pool.query("SELECT COUNT(*) AS n FROM group_guest_trainers WHERE guest_trainer_id = ?", [sessionOnlyId]);
    assertEqual(Number(rows[0].n), 0, "not associated with the Group");
    const prov = await request("GET", "/supervisor/me/eligible-providers", totToken);
    const p = prov.body.providers.find((x) => x.key === `g:${sessionOnlyId}`);
    assert(p && p.kind === "session_only", "offered as a session-only provider");
  });

  let seriesId;
  await test("Multi-day Session: per-day providers (external guest / internal guest) stored per day", async () => {
    const res = await request("POST", "/master-trainer/group-sessions", mtToken, {
      sessionType: "training",
      title: "ZZTGUEST Multi-day",
      days: [
        { date: daysAgo(10), durationMinutes: 60, providedByGuestTrainerId: sessionOnlyId },
        { date: daysAgo(9), durationMinutes: 120, providedBySupervisorId: fx.mt2Id },
        { date: daysAgo(8), durationMinutes: 180 },
      ],
    });
    assertEqual(res.status, 201, "expected 201");
    seriesId = res.body.seriesId;
    const { rows } = await pool.query(
      "SELECT duration_minutes, provided_by_supervisor_id AS s, provided_by_guest_trainer_id AS g FROM session_occasions WHERE series_id = ? ORDER BY session_date",
      [seriesId]
    );
    assertEqual(rows[0].s, null, "day 1 internal NULL");
    assertEqual(Number(rows[0].g), sessionOnlyId, "day 1 external guest");
    assertEqual(Number(rows[1].s), fx.mt2Id, "day 2 internal guest");
    assertEqual(rows[1].g, null, "day 2 guest NULL");
    assertEqual(Number(rows[2].s), fx.mtId, "day 3 defaults to the creator");
    for (const occ of (await pool.query("SELECT id FROM session_occasions WHERE series_id = ?", [seriesId])).rows) {
      await markPresent(occ.id, fx.mtId);
    }
  });

  await test("Internal guest's hours attribute to their own account; each day counted once", async () => {
    const res = await request("GET", "/supervisor/me/group-training-breakdown", mtToken);
    const one = res.body.breakdown.find((b) => b.guestTrainerId === sessionOnlyId);
    const internal = res.body.breakdown.find((b) => b.supervisorId === fx.mt2Id);
    const mt = res.body.breakdown.find((b) => b.supervisorId === fx.mtId);
    assertEqual(one.hours, 1, "session-only guest 1h");
    assertEqual(internal.hours, 2, "internal guest 2h");
    assertEqual(mt.hours, 3, "creator credited only for the day she delivered");
    assertEqual(res.body.totalHours, 5 + 2 + 1 + 2 + 3, "every delivered hour counted exactly once");
  });

  await test("Series detail returns each day's own provider (guest flagged)", async () => {
    const res = await request("GET", `/master-trainer/group-session-series/${seriesId}`, mtToken);
    assertEqual(res.status, 200, "expected 200");
    assertEqual(res.body.days[0].providedByGuestTrainerId, sessionOnlyId, "day 1 guest id");
    assertEqual(res.body.days[0].providedByIsGuest, true, "day 1 guest flag");
    assertEqual(res.body.days[1].providedBySupervisorId, fx.mt2Id, "day 2 internal id");
  });

  await test("Editing a Session from a Guest to an internal provider clears the guest column", async () => {
    const res = await request("PUT", `/supervisor/session-occasions/${guestOccasionId}`, totToken, {
      date: today(),
      durationMinutes: 300,
      providedBySupervisorId: fx.mtId,
    });
    assertEqual(res.status, 200, "expected 200");
    const { rows } = await pool.query(
      "SELECT COUNT(*) AS n FROM sessions WHERE occasion_id = ? AND provided_by_supervisor_id = ? AND provided_by_guest_trainer_id IS NULL",
      [guestOccasionId, fx.mtId]
    );
    assertEqual(Number(rows[0].n), 2, "every attendee row switched consistently");
    const bd = await request("GET", "/supervisor/me/group-training-breakdown", mtToken);
    // Only the 2h supervision Session (logged above) is still theirs.
    assertEqual(bd.body.breakdown.find((b) => b.guestTrainerId === rana).hours, 2, "guest no longer credited for the 5h Session");
    assertEqual(bd.body.breakdown.find((b) => b.supervisorId === fx.mtId).hours, 3 + 5, "the new internal provider is credited instead");
    // ...and back again, so the removal test below exercises history.
    const back = await request("PUT", `/supervisor/session-occasions/${guestOccasionId}`, totToken, {
      date: today(),
      durationMinutes: 300,
      providedByGuestTrainerId: rana,
    });
    assertEqual(back.status, 200, "switch back to guest");
  });

  await test("Removing the association keeps history: attribution, hours and editability", async () => {
    const del = await request("DELETE", `/master-trainer/guest-trainers/associations/${ranaAssociationId}`, mtToken);
    assertEqual(del.status, 200, "expected 200");
    const { rows } = await pool.query("SELECT provided_by_guest_trainer_id AS g FROM session_occasions WHERE id = ?", [guestOccasionId]);
    assertEqual(Number(rows[0].g), rana, "historical provider untouched");
    const { rows: person } = await pool.query("SELECT COUNT(*) AS n FROM guest_trainers WHERE id = ?", [rana]);
    assertEqual(Number(person[0].n), 1, "person record kept");
    const bd = await request("GET", "/supervisor/me/group-training-breakdown", mtToken);
    assertEqual(bd.body.breakdown.find((b) => b.guestTrainerId === rana).hours, 5 + 2, "delivered hours still shown");
    const edit = await request("PUT", `/supervisor/session-occasions/${guestOccasionId}`, totToken, {
      date: today(),
      durationMinutes: 300,
      providedByGuestTrainerId: rana,
    });
    assertEqual(edit.status, 200, "an old Session keeps its provider when edited");
  });

  await test("Admin removes the internal guest; their delivered day keeps attribution", async () => {
    const del = await request("DELETE", `/admin/groups/${fx.groupId}/guest-trainers/${internalAssociationId}`, adminToken);
    assertEqual(del.status, 200, "expected 200");
    const bd = await request("GET", "/supervisor/me/group-training-breakdown", mtToken);
    const row = bd.body.breakdown.find((b) => b.supervisorId === fx.mt2Id);
    assert(row && row.hours === 2, "internal ex-guest's 2h still listed");
  });

  console.log("\nToT-level Sessions (Master Trainer -> ToTs)");

  await test("A ToT Session can be delivered by a Guest Trainer; a ToT can't be its provider", async () => {
    const ok = await request("POST", "/master-trainer/group-tot-sessions", mtToken, {
      title: "ZZTGUEST ToT training by guest",
      date: daysAgo(4),
      durationMinutes: 90,
      providedByGuestTrainerId: sessionOnlyId,
    });
    assertEqual(ok.status, 201, "expected 201");
    const { rows } = await pool.query(
      "SELECT provided_by_supervisor_id AS s, provided_by_guest_trainer_id AS g FROM tot_session_occasions WHERE id = ?",
      [ok.body.occasionId]
    );
    assertEqual(rows[0].s, null, "internal NULL");
    assertEqual(Number(rows[0].g), sessionOnlyId, "guest recorded");
    const list = await request("GET", "/master-trainer/group-tot-sessions", mtToken);
    const item = list.body.occasions.find((o) => o.id === ok.body.occasionId);
    assertEqual(item.providedByIsGuest, true, "list flags the guest");
    const bad = await request("POST", "/master-trainer/group-tot-sessions", mtToken, {
      title: "ZZTGUEST bad",
      date: daysAgo(5),
      durationMinutes: 90,
      providedBySupervisorId: fx.totId,
    });
    assertEqual(bad.status, 400, "ToT as provider -> 400");
  });

  await test("Default (no provider) behaviour is unchanged: creator is the provider", async () => {
    const res = await request("POST", "/supervisor/session-occasions", totToken, {
      sessionType: "training",
      date: daysAgo(6),
      durationMinutes: 30,
    });
    assertEqual(res.status, 201, "expected 201");
    const { rows } = await pool.query(
      "SELECT provided_by_supervisor_id AS s, provided_by_guest_trainer_id AS g FROM session_occasions WHERE id = ?",
      [res.body.occasionId]
    );
    assertEqual(Number(rows[0].s), fx.totId, "creator");
    assertEqual(rows[0].g, null, "no guest");
  });

  console.log("\nCleaning up ZZTGUEST fixtures...");
  await precleanup();
  const { rows: left } = await pool.query("SELECT COUNT(*) AS n FROM user_credentials WHERE member_code LIKE 'ZZTGUEST%'");
  console.log(`Teardown verification: ${left[0].n} leftover ZZTGUEST accounts (should be 0).`);

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
