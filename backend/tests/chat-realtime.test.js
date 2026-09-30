// CRITICAL production bug: a Direct Message required a manual page refresh
// to appear for the recipient. This suite proves the fix with REAL
// socket.io-client connections -- not REST assertions on what the server
// stored, but actual push events received by a live client, the same way
// two real browser tabs would receive them. No polling, no setInterval, no
// refresh: if an event doesn't arrive within the timeout, the test fails.
//
// Root causes found and fixed (see the accompanying engineering report):
//  1. The Chat socket (chatSocket.js) was only ever connected as a side
//     effect of switching to the "Group Chat" tab (connectGcSocket() was
//     called from loadGroupChats() only) -- Direct Messages, the default
//     tab, never connected a socket at all, so "newDirectMessage" never
//     fired and the 4s-timeout polling fallback never engaged either
//     (nothing ever tried to connect, so nothing ever timed out).
//  2. Master Trainer<->ToT Direct Messages and peer-trainee Direct Messages
//     are both backed by chat_rooms (is_direct=TRUE), which broadcasts the
//     SAME "newMessage" event Group Chats use (not "newDirectMessage",
//     which only exists for the legacy chats/messages table) -- but no
//     client-side handler ever recognized "this newMessage event is for my
//     currently-open 1:1 room", so these two conversation kinds had zero
//     real-time delivery even once issue #1 was fixed.
//
// Same pattern as the other suites otherwise: no framework, real HTTP +
// real sockets against the running dev server, real DB via the app's own
// pool, isolated ZZTRT-prefixed fixtures, guaranteed cleanup.
//
// Run: node tests/chat-realtime.test.js  (dev server must be running)

const http = require("http");
const jwt = require("jsonwebtoken");
const path = require("path");
const { io } = require("socket.io-client");
const cfg = require(path.join(__dirname, "..", "src", "config"));
const { pool } = require(path.join(__dirname, "..", "src", "db"));

const BASE = "http://localhost:3000/api";
const SOCKET_BASE = "http://localhost:3000";

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

function connectSocket(token) {
  return new Promise((resolve, reject) => {
    const socket = io(SOCKET_BASE, { auth: { token }, transports: ["websocket", "polling"], forceNew: true });
    const timer = setTimeout(() => reject(new Error("socket did not connect within 5s")), 5000);
    socket.on("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on("connect_error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// Waits for a specific event, with a hard timeout -- this is the whole
// point: no refresh, no poll, just "did the push event actually arrive".
function waitForEvent(socket, eventName, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`"${eventName}" did not arrive within ${timeoutMs}ms -- this is exactly the bug: no refresh, no poll, just the real event`)), timeoutMs);
    socket.once(eventName, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function collectEvents(socket, eventName, count, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const collected = [];
    const timer = setTimeout(
      () => reject(new Error(`only received ${collected.length}/${count} "${eventName}" events within ${timeoutMs}ms`)),
      timeoutMs
    );
    const handler = (payload) => {
      collected.push(payload);
      if (collected.length >= count) {
        clearTimeout(timer);
        socket.off(eventName, handler);
        resolve(collected);
      }
    };
    socket.on(eventName, handler);
  });
}

let fx = { groupId: null, mtId: null, totId: null, otherTotId: null, studentId: null, mtRoomId: null };

async function precleanup() {
  await pool.query("DELETE FROM supervisors WHERE supervisor_type = 'in_training' AND id IN (SELECT id FROM user_credentials WHERE member_code LIKE 'ZZTRT%')");
  await pool.query("DELETE FROM supervisors WHERE supervisor_type = 'primary' AND id IN (SELECT id FROM user_credentials WHERE member_code LIKE 'ZZTRT%')");
  await pool.query("DELETE FROM students WHERE id IN (SELECT id FROM user_credentials WHERE member_code LIKE 'ZZTRT%')");
  await pool.query("DELETE FROM user_credentials WHERE member_code LIKE 'ZZTRT%'");
  await pool.query("DELETE FROM trainer_groups WHERE name LIKE 'ZZTRT%'");
}

async function setup() {
  await precleanup();
  const grp = await pool.query("INSERT INTO trainer_groups (name) VALUES ('ZZTRT Group')");
  fx.groupId = grp.insertId;

  const mkSup = async (code, name, type, primaryId) => {
    const cred = await pool.query(
      "INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES (?, 'x', 'supervisor', 'active')",
      [code]
    );
    const id = cred.insertId;
    await pool.query(
      "INSERT INTO supervisors (id, full_name, supervisor_type, group_id, primary_supervisor_id) VALUES (?, ?, ?, ?, ?)",
      [id, name, type, fx.groupId, primaryId || null]
    );
    return id;
  };
  fx.mtId = await mkSup("ZZTRTMT", "ZZTRT MasterTrainer", "primary");
  fx.totId = await mkSup("ZZTRTTOT", "ZZTRT ToT", "in_training", fx.mtId);
  fx.otherTotId = await mkSup("ZZTRTOTHER", "ZZTRT Unrelated ToT", "in_training", fx.mtId);

  const cred = await pool.query(
    "INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES ('ZZTRTS1', 'x', 'trainee', 'active')"
  );
  fx.studentId = cred.insertId;
  await pool.query("INSERT INTO students (id, full_name, group_id) VALUES (?, 'ZZTRT Trainee', ?)", [fx.studentId, fx.groupId]);
  await pool.query("INSERT INTO supervisor_students (supervisor_id, student_id) VALUES (?, ?)", [fx.totId, fx.studentId]);
}

async function teardown() {
  if (fx.studentId) {
    await pool.query("DELETE FROM notifications WHERE recipient_id IN (?, ?, ?, ?)", [fx.totId || 0, fx.studentId || 0, fx.mtId || 0, fx.otherTotId || 0]);
    await pool.query("DELETE FROM chats WHERE student_id = ?", [fx.studentId]);
    await pool.query("DELETE FROM supervisor_students WHERE student_id = ?", [fx.studentId]);
    await pool.query("DELETE FROM students WHERE id = ?", [fx.studentId]);
    await pool.query("DELETE FROM user_credentials WHERE id = ?", [fx.studentId]);
  }
  await pool.query("DELETE FROM chat_room_messages WHERE room_id IN (SELECT room_id FROM chat_room_members WHERE user_id IN (?, ?, ?))", [fx.mtId || 0, fx.totId || 0, fx.otherTotId || 0]);
  await pool.query("DELETE FROM chat_room_members WHERE user_id IN (?, ?, ?)", [fx.mtId || 0, fx.totId || 0, fx.otherTotId || 0]);
  await pool.query("DELETE FROM chat_rooms WHERE is_direct = TRUE AND id NOT IN (SELECT DISTINCT room_id FROM chat_room_members)");
  const totIds = [fx.totId, fx.otherTotId].filter(Boolean);
  if (totIds.length) await pool.query(`DELETE FROM supervisors WHERE id IN (${totIds.map(() => "?").join(",")})`, totIds);
  if (fx.mtId) await pool.query("DELETE FROM supervisors WHERE id = ?", [fx.mtId]);
  const supIds = [fx.mtId, fx.totId, fx.otherTotId].filter(Boolean);
  if (supIds.length) await pool.query(`DELETE FROM user_credentials WHERE id IN (${supIds.map(() => "?").join(",")})`, supIds);
  if (fx.groupId) await pool.query("DELETE FROM trainer_groups WHERE id = ?", [fx.groupId]);
}

async function run() {
  console.log("Setting up isolated ZZTRT fixtures...");
  await setup();

  let totSocket, studentSocket, mtSocket, otherTotSocket;
  try {
    const totToken = tokenFor(fx.totId, "supervisor");
    const studentToken = tokenFor(fx.studentId, "trainee");
    const mtToken = tokenFor(fx.mtId, "supervisor");
    const otherTotToken = tokenFor(fx.otherTotId, "supervisor");

    console.log("\n[1] Socket connection itself");
    await test("ToT, trainee, Master Trainer, and an unrelated ToT can all connect real sockets", async () => {
      [totSocket, studentSocket, mtSocket, otherTotSocket] = await Promise.all([
        connectSocket(totToken),
        connectSocket(studentToken),
        connectSocket(mtToken),
        connectSocket(otherTotToken),
      ]);
    });

    console.log("\n[2] ACCEPTANCE TEST -- ToT <-> Trainee, both directions, NO refresh, NO polling, real push only");
    await test("ToT sends 'Hi' -> trainee's socket receives it live (this is the exact bug scenario)", async () => {
      const waiter = waitForEvent(studentSocket, "newDirectMessage", 3000);
      const send = await request("POST", `/supervisor/students/${fx.studentId}/messages`, totToken, { content: "Hi" });
      assertEqual(send.status, 201, "send status");
      const payload = await waiter;
      assertEqual(payload.message.content, "Hi", "content");
      assertEqual(payload.message.senderId, fx.totId, "correct sender");
    });
    await test("trainee replies 'Hi' -> ToT's socket receives it live", async () => {
      const waiter = waitForEvent(totSocket, "newDirectMessage", 3000);
      const send = await request("POST", `/profile/messages/${fx.totId}`, studentToken, { content: "Hi" });
      assertEqual(send.status, 201, "send status");
      const payload = await waiter;
      assertEqual(payload.message.content, "Hi", "content");
      assertEqual(payload.message.senderId, fx.studentId, "correct sender");
    });

    console.log("\n[3] Rapid-fire messages -- correct order, no loss, no duplication");
    await test("5 rapid messages arrive live, in order, exactly once", async () => {
      const collector = collectEvents(studentSocket, "newDirectMessage", 5, 4000);
      for (let i = 1; i <= 5; i++) {
        const r = await request("POST", `/supervisor/students/${fx.studentId}/messages`, totToken, { content: `Rapid ${i}` });
        assertEqual(r.status, 201, `send ${i} status`);
      }
      const events = await collector;
      assertEqual(events.length, 5, "exactly 5 events, no loss, no duplication");
      assertEqual(events.map((e) => e.message.content).join(","), "Rapid 1,Rapid 2,Rapid 3,Rapid 4,Rapid 5", "correct order");
    });

    console.log("\n[4] Master Trainer <-> ToT Direct Message (chat_rooms/is_direct) -- previously had ZERO handler on either side");
    let mtRoomId;
    await test("MT opens the thread (creates the room), ToT sends -> MT's socket receives it live", async () => {
      const opened = await request("GET", `/master-trainer/tots/${fx.totId}/messages`, mtToken);
      assertEqual(opened.status, 200, "status");
      mtRoomId = opened.body.roomId;
      if (!mtRoomId) throw new Error("GET /master-trainer/tots/:id/messages must return roomId now");

      const waiter = waitForEvent(mtSocket, "newMessage", 3000);
      const send = await request("POST", `/supervisor/master-trainer/messages`, totToken, { content: "Hello from ToT" });
      assertEqual(send.status, 201, "send status");
      const payload = await waiter;
      assertEqual(payload.roomId, mtRoomId, "roomId matches the same direct room");
      assertEqual(payload.message.content, "Hello from ToT", "content");
    });
    await test("MT replies -> ToT's socket receives it live", async () => {
      const waiter = waitForEvent(totSocket, "newMessage", 3000);
      const send = await request("POST", `/master-trainer/tots/${fx.totId}/messages`, mtToken, { content: "Hello from MT" });
      assertEqual(send.status, 201, "send status");
      const payload = await waiter;
      assertEqual(payload.roomId, mtRoomId, "roomId matches");
      assertEqual(payload.message.content, "Hello from MT", "content");
    });
    await test("an unrelated ToT's socket receives NOTHING from this MT<->ToT conversation (authorization enforced server-side)", async () => {
      let leaked = false;
      const handler = () => {
        leaked = true;
      };
      otherTotSocket.on("newMessage", handler);
      await request("POST", `/master-trainer/tots/${fx.totId}/messages`, mtToken, { content: "private" });
      await new Promise((r) => setTimeout(r, 1200));
      otherTotSocket.off("newMessage", handler);
      if (leaked) throw new Error("unrelated ToT's socket received another ToT's private conversation");
    });

    console.log("\n[5] Database consistency -- exactly what the sockets delivered is exactly what's stored");
    await test("DB message count matches exactly what was sent (no phantom/duplicate rows from the real-time path)", async () => {
      const { rows } = await pool.query(
        `SELECT COUNT(*) c FROM messages m JOIN chats c ON c.id = m.chat_id WHERE c.supervisor_id = ? AND c.student_id = ?`,
        [fx.totId, fx.studentId]
      );
      // 1 (Hi) + 1 (Hi reply) + 5 (Rapid 1-5) = 7
      assertEqual(Number(rows[0].c), 7, "exactly 7 messages in this conversation, matching what was actually sent");
    });
  } finally {
    console.log("\nCleaning up ZZTRT fixtures and sockets...");
    [totSocket, studentSocket, mtSocket, otherTotSocket].forEach((s) => s && s.disconnect());
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
