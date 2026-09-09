// Real-time layer for Group Chats -- the first WebSocket usage anywhere in
// this app (every other "live-ish" feature just polls on an interval).
// Message persistence still goes through the normal REST route
// (chatRooms.js); this module only broadcasts "a message was created" to
// every OTHER currently-connected member of that room so it appears live,
// and evicts a removed member's live connection so they stop receiving a
// room's messages the instant they're removed (REST access is already
// denied by the route's own membership check -- this closes the same gap
// for the still-open socket).
//
// Whether the production host actually proxies WebSocket upgrade requests
// is unverified (see the Group Chats plan) -- the frontend must fall back
// to polling if a socket never connects, so this feature works either way.

const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const config = require("../config");
const { pool } = require("../db");

function roomChannel(roomId) {
  return `room:${roomId}`;
}

// Direct Messages (1:1 Trainee<->Supervisor chat, backed by chats/messages --
// see profile.js/supervisor.js) reuse this exact same socket/connection
// instead of a second one -- only the channel naming is different, so a
// direct-message broadcast can never land in a Group Chat room and vice
// versa.
function dmChannel(chatId) {
  return `dm:${chatId}`;
}

function attach(server) {
  const io = new Server(server, {
    cors: { origin: true, credentials: true },
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (!token) return next(new Error("Not authenticated"));
    try {
      const payload = jwt.verify(token, config.jwtSecret);
      socket.userId = payload.id;
      next();
    } catch (err) {
      next(new Error("Invalid or expired session"));
    }
  });

  io.on("connection", async (socket) => {
    try {
      const { rows } = await pool.query("SELECT room_id FROM chat_room_members WHERE user_id = ?", [socket.userId]);
      rows.forEach((r) => socket.join(roomChannel(r.room_id)));
    } catch (err) {
      console.error("[chatSocket] Failed to auto-join rooms for user", socket.userId, err.message);
    }

    try {
      const { rows } = await pool.query(
        "SELECT id FROM chats WHERE supervisor_id = ? OR student_id = ?",
        [socket.userId, socket.userId]
      );
      rows.forEach((r) => socket.join(dmChannel(r.id)));
    } catch (err) {
      console.error("[chatSocket] Failed to auto-join direct chats for user", socket.userId, err.message);
    }

    // Lets an already-connected client join a room it was just added to
    // (or that it just created) without reconnecting the whole socket.
    // Idempotent and re-verifies membership server-side -- a client can't
    // join a room it isn't actually in by guessing an id.
    socket.on("joinRoom", async (roomId) => {
      try {
        const { rows } = await pool.query(
          "SELECT 1 FROM chat_room_members WHERE room_id = ? AND user_id = ?",
          [roomId, socket.userId]
        );
        if (rows.length) socket.join(roomChannel(roomId));
      } catch (err) {
        // Ignore -- worst case this client just relies on its polling fallback.
      }
    });

    // Same idempotent, re-verified join as "joinRoom" above, for the one
    // case the initial auto-join at connection time can miss: the very
    // first message ever sent between two people, whose chats row didn't
    // exist yet when this socket connected.
    socket.on("joinDirectChat", async (chatId) => {
      try {
        const { rows } = await pool.query(
          "SELECT 1 FROM chats WHERE id = ? AND (supervisor_id = ? OR student_id = ?)",
          [chatId, socket.userId, socket.userId]
        );
        if (rows.length) socket.join(dmChannel(chatId));
      } catch (err) {
        // Ignore -- worst case this client just relies on its polling fallback.
      }
    });
  });

  return io;
}

/** Called by chatRooms.js right after persisting a new message. The
 *  sender's own UI already appends it locally from the POST response, so
 *  this explicitly excludes the sender's own socket(s) -- io.to(room)
 *  would otherwise also deliver it back to them and double-render it. */
async function broadcastMessage(io, roomId, message) {
  const channel = roomChannel(roomId);
  const sockets = await io.in(channel).fetchSockets();
  sockets.forEach((s) => {
    if (s.userId !== message.senderId) s.emit("newMessage", { roomId, message });
  });
}

/** Called by profile.js/supervisor.js right after persisting a direct
 *  message, exactly mirroring broadcastMessage above (same "never echo
 *  back to the sender" rule) -- the only difference is the channel and
 *  event name, so a client can tell a Direct Message apart from a Group
 *  Chat message without inspecting payload shape. */
async function broadcastDirectMessage(io, chatId, message) {
  const channel = dmChannel(chatId);
  const sockets = await io.in(channel).fetchSockets();
  sockets.forEach((s) => {
    if (s.userId !== message.senderId) s.emit("newDirectMessage", { chatId, message });
  });
}

/** Called by chatRooms.js right after removing a member, so their live
 *  connection (if any) immediately stops receiving this room's messages --
 *  otherwise a stale socket.join() from before removal would keep leaking
 *  live messages even though REST access is already denied. */
async function evictMember(io, roomId, userId) {
  const channel = roomChannel(roomId);
  const sockets = await io.in(channel).fetchSockets();
  sockets.forEach((s) => {
    if (s.userId === userId) s.leave(channel);
  });
}

module.exports = { attach, broadcastMessage, broadcastDirectMessage, evictMember };
