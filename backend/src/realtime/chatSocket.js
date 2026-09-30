// Real-time layer for Chat -- Group Chats, Master Trainer<->ToT Direct
// Chat, peer-trainee Direct Chat (all three backed by chat_rooms), and
// ToT<->Trainee Direct Messages (backed by the older chats/messages
// tables). Message persistence still goes through the normal REST routes
// (chatRooms.js / supervisor.js / profile.js / Mastertrainer.js); this
// module only broadcasts "a message was created" to whoever should see it
// live, and evicts a removed Group Chat member's live connection so they
// stop receiving that room's messages the instant they're removed (REST
// access is already denied by the route's own membership check -- this
// closes the same gap for the still-open socket).
//
// Delivery is identity-based: every socket joins a room named after its
// own user id the moment it authenticates (userChannel below), and a
// broadcast targets the intended recipient(s)' own channel directly. This
// used to be room/chat-id-based instead (a socket auto-joined
// room:{roomId}/dm:{chatId} channels for whatever rooms/chats already
// existed AT CONNECTION TIME) -- which meant the very first message ever
// sent in a brand-new conversation was never delivered live: the
// recipient's socket had connected before that room/chat row existed, so
// it was never in the channel the broadcast targeted, and nothing on the
// client ever asked to join it afterward (a "joinDirectChat" handler
// existed for exactly this gap, but no frontend code ever called it).
// Identity-based delivery has no such timing dependency -- a user's own
// channel exists the instant they connect, regardless of which
// conversations do or don't exist yet.
//
// Whether the production host actually proxies WebSocket upgrade requests
// is unverified -- the frontend must fall back to polling if a socket
// never connects, so this feature works either way.

const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const config = require("../config");
const { pool } = require("../db");

function userChannel(userId) {
  return `user:${userId}`;
}

// Superseded by userChannel for delivery (see the module comment above),
// but evictMember still uses this to drop a removed Group Chat member's
// stale room membership -- kept only for that, and for the "joinRoom"
// handler below which a client still calls when opening a Group Chat room.
function roomChannel(roomId) {
  return `room:${roomId}`;
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
    socket.join(userChannel(socket.userId));

    try {
      const { rows } = await pool.query("SELECT room_id FROM chat_room_members WHERE user_id = ?", [socket.userId]);
      rows.forEach((r) => socket.join(roomChannel(r.room_id)));
    } catch (err) {
      console.error("[chatSocket] Failed to auto-join rooms for user", socket.userId, err.message);
    }

    // Lets an already-connected client join a room it was just added to
    // (or that it just created) without reconnecting the whole socket.
    // Idempotent and re-verifies membership server-side -- a client can't
    // join a room it isn't actually in by guessing an id. No longer
    // load-bearing for delivery (broadcastMessage looks up live membership
    // itself), but evictMember still targets roomChannel, so a member who
    // re-joins a room they were removed from and re-added to needs this to
    // receive Group Chat's other still-room-scoped behavior correctly.
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
  });

  return io;
}

/** Called by chatRooms.js/supervisor.js/Mastertrainer.js right after
 *  persisting a new chat_room_messages row (Group Chat OR a 1:1
 *  is_direct room -- Master Trainer<->ToT, peer-trainee). Looks up the
 *  room's CURRENT members at broadcast time (not a cached room->sockets
 *  mapping), so it's correct regardless of when each member's socket
 *  connected relative to the room's own creation, and a removed member
 *  simply won't be in this list any more. The sender's own UI already
 *  appends the message locally from the POST response, so their own
 *  channel is explicitly excluded. */
async function broadcastMessage(io, roomId, message) {
  const { rows } = await pool.query("SELECT user_id FROM chat_room_members WHERE room_id = ?", [roomId]);
  rows.forEach((r) => {
    if (Number(r.user_id) !== Number(message.senderId)) {
      io.to(userChannel(r.user_id)).emit("newMessage", { roomId, message });
    }
  });
}

/** Called by profile.js/supervisor.js right after persisting a direct
 *  message (the older chats/messages tables -- always exactly one
 *  recipient, known directly by the caller, so no membership lookup is
 *  needed at all). */
async function broadcastDirectMessage(io, recipientId, message) {
  io.to(userChannel(recipientId)).emit("newDirectMessage", { message });
}

/** Called by chatRooms.js right after removing a Group Chat member, so
 *  their live connection (if any) immediately stops receiving this room's
 *  OTHER room-scoped socket behavior (e.g. a future "joinRoom" re-check).
 *  broadcastMessage itself already re-queries live membership on every
 *  send, so a removed member stops receiving new messages the instant
 *  this function's caller's own DELETE commits, with or without this. */
async function evictMember(io, roomId, userId) {
  const channel = roomChannel(roomId);
  const sockets = await io.in(channel).fetchSockets();
  sockets.forEach((s) => {
    if (s.userId === userId) s.leave(channel);
  });
}

module.exports = { attach, broadcastMessage, broadcastDirectMessage, evictMember };
