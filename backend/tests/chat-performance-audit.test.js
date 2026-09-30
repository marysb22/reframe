// Chat performance audit -- automated regression suite.
//
// Verifies: (1) the new batched preview endpoints return the exact same
// data the old N+1 peek-loop did, for a real conversation with real
// messages, (2) they return null/nothing for a contact who never
// messaged (no chats row yet), (3) correct scoping (no cross-tenant
// leakage), (4) the Group Chat send route + message-history route still
// work correctly end to end. This does NOT try to automate a full
// browser optimistic-UI check (already verified manually via a real
// Chromium run against 18 seeded rooms, screenshotted, see the
// engineering report) -- this suite is the backend/API/DB layer.
//
// Run: node tests/chat-performance-audit.test.js  (dev server must be running)

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
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      BASE + urlPath,
      { method, headers: { Authorization: token ? `Bearer ${token}` : undefined, "Content-Type": "application/json", "Content-Length": data ? Buffer.byteLength(data) : 0 } },
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
    if (data) req.write(data);
    req.end();
  });
}
function tokenFor(id, role) {
  return jwt.sign({ id, role }, cfg.jwtSecret, { expiresIn: "1h" });
}

const SUP_ID = 326; // reused fixture (supervisor_type='primary')
let fx = { studentWithMsgs: null, studentNoMsgs: null, chatId: null, otherSupervisorId: null, otherStudentId: null, roomId: null };

async function setup() {
  const mkStudent = async (code, name) => {
    const cred = await pool.query("INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES (?, 'x', 'trainee', 'active')", [code]);
    const id = cred.insertId;
    await pool.query("INSERT INTO students (id, full_name) VALUES (?, ?)", [id, name]);
    await pool.query("INSERT INTO supervisor_students (supervisor_id, student_id) VALUES (?, ?)", [SUP_ID, id]);
    return id;
  };
  fx.studentWithMsgs = await mkStudent("ZZTPERF1", "ZZTPerf HasMessages");
  fx.studentNoMsgs = await mkStudent("ZZTPERF2", "ZZTPerf NoMessages");

  const chat = await pool.query("INSERT INTO chats (supervisor_id, student_id) VALUES (?, ?)", [SUP_ID, fx.studentWithMsgs]);
  fx.chatId = chat.insertId;
  await pool.query("INSERT INTO messages (chat_id, sender_id, content) VALUES (?, ?, 'first message')", [fx.chatId, SUP_ID]);
  const lastMsg = await pool.query("INSERT INTO messages (chat_id, sender_id, content) VALUES (?, ?, 'the real last message')", [fx.chatId, fx.studentWithMsgs]);
  fx.lastMessageId = lastMsg.insertId;

  // Cross-tenant fixture: another supervisor + student with their own chat.
  const otherCred = await pool.query("INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES ('ZZTPERFSUP', 'x', 'supervisor', 'active')");
  fx.otherSupervisorId = otherCred.insertId;
  await pool.query("INSERT INTO supervisors (id, full_name, supervisor_type) VALUES (?, 'ZZTPerf Other Supervisor', 'primary')", [fx.otherSupervisorId]);
  const otherStudentCred = await pool.query("INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES ('ZZTPERF3', 'x', 'trainee', 'active')");
  fx.otherStudentId = otherStudentCred.insertId;
  await pool.query("INSERT INTO students (id, full_name) VALUES (?, 'ZZTPerf OtherSup Trainee')", [fx.otherStudentId]);
  await pool.query("INSERT INTO supervisor_students (supervisor_id, student_id) VALUES (?, ?)", [fx.otherSupervisorId, fx.otherStudentId]);
  const otherChat = await pool.query("INSERT INTO chats (supervisor_id, student_id) VALUES (?, ?)", [fx.otherSupervisorId, fx.otherStudentId]);
  await pool.query("INSERT INTO messages (chat_id, sender_id, content) VALUES (?, ?, 'should never leak into ZZTPERF1 supervisor view')", [otherChat.insertId, fx.otherSupervisorId]);

  // A Group Chat room for the message-send/history regression check.
  const grp = await pool.query("INSERT INTO trainer_groups (name) VALUES ('ZZTPERF Group')");
  fx.groupId = grp.insertId;
  await pool.query("UPDATE supervisors SET group_id = ? WHERE id = ?", [fx.groupId, SUP_ID]);
  await pool.query("UPDATE students SET group_id = ? WHERE id = ?", [fx.groupId, fx.studentWithMsgs]);
  const room = await pool.query("INSERT INTO chat_rooms (name, created_by, is_direct, group_id) VALUES ('ZZTPerf Room', ?, FALSE, ?)", [SUP_ID, fx.groupId]);
  fx.roomId = room.insertId;
  await pool.query("INSERT INTO chat_room_members (room_id, user_id, added_by) VALUES (?, ?, ?), (?, ?, ?)", [
    fx.roomId, SUP_ID, SUP_ID, fx.roomId, fx.studentWithMsgs, SUP_ID,
  ]);
}

async function teardown() {
  if (fx.roomId) {
    await pool.query("DELETE FROM chat_room_messages WHERE room_id = ?", [fx.roomId]);
    await pool.query("DELETE FROM chat_room_members WHERE room_id = ?", [fx.roomId]);
    await pool.query("DELETE FROM chat_rooms WHERE id = ?", [fx.roomId]);
  }
  await pool.query("UPDATE supervisors SET group_id = NULL WHERE id = ?", [SUP_ID]);
  if (fx.groupId) await pool.query("DELETE FROM trainer_groups WHERE id = ?", [fx.groupId]);

  const ids = [fx.studentWithMsgs, fx.studentNoMsgs, fx.otherStudentId].filter(Boolean);
  if (fx.chatId) await pool.query("DELETE FROM messages WHERE chat_id = ?", [fx.chatId]);
  await pool.query("DELETE FROM messages WHERE chat_id IN (SELECT id FROM chats WHERE supervisor_id = ?)", [fx.otherSupervisorId]);
  await pool.query("DELETE FROM chats WHERE supervisor_id IN (?, ?)", [SUP_ID, fx.otherSupervisorId]);
  if (ids.length) {
    await pool.query(`DELETE FROM supervisor_students WHERE student_id IN (${ids.map(() => "?").join(",")})`, ids);
    await pool.query(`DELETE FROM students WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
    await pool.query(`DELETE FROM user_credentials WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
  }
  if (fx.otherSupervisorId) {
    await pool.query("DELETE FROM supervisors WHERE id = ?", [fx.otherSupervisorId]);
    await pool.query("DELETE FROM user_credentials WHERE id = ?", [fx.otherSupervisorId]);
  }
}

async function run() {
  console.log("Setting up isolated ZZTPERF fixtures...");
  await setup();

  try {
    const token = tokenFor(SUP_ID, "supervisor");
    const otherToken = tokenFor(fx.otherSupervisorId, "supervisor");

    console.log("\nGET /supervisor/messages/previews (replaces the N+1 peek loop)");
    await test("returns the real last message for a conversation with history", async () => {
      const r = await request("GET", "/supervisor/messages/previews", token);
      assertEqual(r.status, 200);
      const p = r.body.previews[fx.studentWithMsgs];
      assert(p, "no preview returned for the fixture with messages");
      assertEqual(p.content, "the real last message");
    });
    await test("a contact with no chat row yet is simply absent (not an error, not a fake value)", async () => {
      const r = await request("GET", "/supervisor/messages/previews", token);
      assertEqual(r.body.previews[fx.studentNoMsgs], undefined);
    });
    await test("never returns another supervisor's conversation", async () => {
      const r = await request("GET", "/supervisor/messages/previews", token);
      const leaked = Object.values(r.body.previews).some((p) => p && p.content && p.content.includes("should never leak"));
      assert(!leaked, "another supervisor's message content leaked into this supervisor's previews");
    });
    await test("the other supervisor sees their own conversation, correctly scoped", async () => {
      const r = await request("GET", "/supervisor/messages/previews", otherToken);
      const p = r.body.previews[fx.otherStudentId];
      assert(p && p.content.includes("should never leak"), "other supervisor's own real conversation missing");
    });

    console.log("\nGroup Chat send/history -- unaffected regression check");
    let sentMessageId;
    await test("POST a message to a Group Chat room still works and returns the full shape", async () => {
      // The route expects real multipart/form-data (chatAttachmentUpload's
      // multer middleware), matching exactly how the frontend sends it.
      const boundary = "----zzperfboundary" + Date.now();
      const body = `--${boundary}\r\nContent-Disposition: form-data; name="content"\r\n\r\nRegression check message\r\n--${boundary}--\r\n`;
      const r = await new Promise((resolve, reject) => {
        const req = http.request(`http://localhost:3000/api/chat-rooms/${fx.roomId}/messages`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": Buffer.byteLength(body) },
        }, (res) => {
          let raw = "";
          res.on("data", (c) => (raw += c));
          res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
        });
        req.on("error", reject);
        req.write(body);
        req.end();
      });
      assertEqual(r.status, 201);
      assertEqual(r.body.content, "Regression check message");
      assert(r.body.senderName, "sender name missing from the response");
      sentMessageId = r.body.id;
    });
    await test("the sent message appears correctly in message history", async () => {
      const r = await request("GET", `/chat-rooms/${fx.roomId}/messages`, token);
      assertEqual(r.status, 200);
      const found = r.body.messages.find((m) => m.id === sentMessageId);
      assert(found, "sent message not found in history");
      assertEqual(found.content, "Regression check message");
    });
    await test("GET /chat-rooms still returns the correct updated preview for this room", async () => {
      const r = await request("GET", "/chat-rooms?type=group", token);
      const room = r.body.rooms.find((x) => x.id === fx.roomId);
      assert(room, "room not found");
      assertEqual(room.lastMessage.preview, "Regression check message");
    });
  } finally {
    console.log("\nTearing down ZZTPERF fixtures...");
    await teardown();
    const { rows } = await pool.query("SELECT COUNT(*) c FROM user_credentials WHERE member_code LIKE 'ZZTPERF%'");
    console.log(`Teardown verification: ${rows[0].c} leftover ZZTPERF accounts (should be 0).`);
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${"=".repeat(60)}`);
  console.log(`${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ""}`);
  console.log("=".repeat(60));
  process.exit(failed ? 1 : 0);
}

run().catch((err) => {
  console.error("Suite crashed:", err);
  teardown().catch(() => {}).finally(() => process.exit(1));
});
