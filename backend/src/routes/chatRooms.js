// Group Chats -- Master Trainer-curated chat rooms, independent of
// trainer_groups/supervisor_students membership (see database/migrations/
// 005_chat_rooms.sql for why). Used identically by all three dashboards;
// permissions are enforced per-request (room membership / room ownership),
// not by which role hit the route -- mirrors how Notifications ended up
// centralized in profile.js rather than duplicated per role.
const express = require("express");
const { requireAuth, requireMasterTrainer, asyncRoute } = require("../middleware/auth");
const { pool } = require("../db");
const { chatAttachmentUpload, checkChatAttachmentContent } = require("../utils/uploads");
const { broadcastMessage, evictMember } = require("../realtime/chatSocket");

const router = express.Router();
router.use(requireAuth);

function toMessage(row) {
  return {
    id: row.id,
    roomId: row.room_id,
    senderId: row.sender_id,
    senderName: row.sender_name,
    content: row.content,
    attachment: row.attachment_filename
      ? {
          filename: row.attachment_filename,
          originalName: row.attachment_original_name,
          mime: row.attachment_mime,
          size: row.attachment_size,
        }
      : null,
    createdAt: row.created_at,
  };
}

/** Resolves a room only if the caller is currently a member of it. */
async function loadMemberRoom(db, roomId, userId) {
  const { rows } = await db.query(
    `SELECT r.*, m.last_read_at FROM chat_rooms r
       JOIN chat_room_members m ON m.room_id = r.id
      WHERE r.id = ? AND m.user_id = ?`,
    [roomId, userId]
  );
  return rows[0] || null;
}

/** Resolves a room only if the caller is the Master Trainer who created it. */
async function loadOwnedRoom(db, roomId, masterTrainerId) {
  const { rows } = await db.query("SELECT * FROM chat_rooms WHERE id = ? AND created_by = ?", [roomId, masterTrainerId]);
  return rows[0] || null;
}

// GET /api/chat-rooms -- my rooms, with a last-message preview + unread flag.
router.get(
  "/",
  asyncRoute(async (req, res, db) => {
    const { rows } = await db.query(
      `SELECT r.id, r.name, r.created_by, m.last_read_at,
              (SELECT COUNT(*) FROM chat_room_members WHERE room_id = r.id) AS member_count,
              lm.content AS last_content, lm.attachment_original_name AS last_attachment_name,
              lm.created_at AS last_message_at,
              COALESCE(sup.full_name, st.full_name) AS last_sender_name,
              (SELECT COUNT(*) FROM chat_room_messages
                WHERE room_id = r.id AND created_at > COALESCE(m.last_read_at, '1970-01-01')) AS unread_count
         FROM chat_rooms r
         JOIN chat_room_members m ON m.room_id = r.id
         LEFT JOIN chat_room_messages lm ON lm.id = (
           SELECT id FROM chat_room_messages WHERE room_id = r.id ORDER BY created_at DESC LIMIT 1
         )
         LEFT JOIN supervisors sup ON sup.id = lm.sender_id
         LEFT JOIN students st ON st.id = lm.sender_id
        WHERE m.user_id = ?
        ORDER BY lm.created_at IS NULL, lm.created_at DESC`,
      [req.user.id]
    );
    res.json({
      rooms: rows.map((r) => ({
        id: r.id,
        name: r.name,
        isOwner: r.created_by === req.user.id,
        memberCount: r.member_count,
        unreadCount: Number(r.unread_count),
        lastMessage: r.last_message_at
          ? {
              preview: r.last_content || (r.last_attachment_name ? `📎 ${r.last_attachment_name}` : ""),
              senderName: r.last_sender_name,
              createdAt: r.last_message_at,
            }
          : null,
      })),
    });
  })
);

// POST /api/chat-rooms  { name, memberIds: [] } -- Master Trainer only.
// Every memberId must currently belong to the creator's own group (their
// own row is always included automatically).
router.post(
  "/",
  requireMasterTrainer,
  asyncRoute(async (req, res, db) => {
    const name = String((req.body || {}).name || "").trim();
    if (!name) return res.status(400).json({ error: "Room name is required" });
    if (!req.masterTrainer.groupId) return res.status(400).json({ error: "You don't have a Group assigned yet" });

    const memberIds = Array.isArray((req.body || {}).memberIds) ? (req.body.memberIds).map(Number) : [];

    // Only people currently in this Master Trainer's own group are eligible.
    const { rows: eligible } = await db.query(
      `SELECT id FROM supervisors WHERE group_id = ?
       UNION SELECT id FROM students WHERE group_id = ?`,
      [req.masterTrainer.groupId, req.masterTrainer.groupId]
    );
    const eligibleIds = new Set(eligible.map((r) => r.id));
    const invalid = memberIds.filter((id) => !eligibleIds.has(id));
    if (invalid.length) {
      return res.status(400).json({ error: "One or more selected members are not in your Group" });
    }

    const room = await db.query("INSERT INTO chat_rooms (name, created_by, group_id) VALUES (?, ?, ?)", [
      name,
      req.masterTrainer.id,
      req.masterTrainer.groupId,
    ]);
    const roomId = room.insertId;

    const allMemberIds = new Set([req.masterTrainer.id, ...memberIds]);
    for (const userId of allMemberIds) {
      await db.query("INSERT INTO chat_room_members (room_id, user_id, added_by) VALUES (?, ?, ?)", [
        roomId,
        userId,
        req.masterTrainer.id,
      ]);
    }

    res.status(201).json({ id: roomId, name, memberIds: [...allMemberIds] });
  })
);

// GET /api/chat-rooms/roster -- Master-Trainer-only: everyone in their own
// Group (every ToT + every Trainee), for the "New Room" member picker
// before any room exists yet.
router.get(
  "/roster",
  requireMasterTrainer,
  asyncRoute(async (req, res, db) => {
    if (!req.masterTrainer.groupId) return res.json({ roster: [] });
    const { rows } = await db.query(
      `SELECT sup.id, sup.full_name, 'supervisor' AS kind FROM supervisors sup
        WHERE sup.group_id = ? AND sup.id != ?
       UNION
       SELECT st.id, st.full_name, 'trainee' AS kind FROM students st WHERE st.group_id = ?`,
      [req.masterTrainer.groupId, req.masterTrainer.id, req.masterTrainer.groupId]
    );
    res.json({ roster: rows.map((r) => ({ id: r.id, fullName: r.full_name, kind: r.kind })) });
  })
);

// GET /api/chat-rooms/:id/members -- owner only: the room's current
// members by name, for the "Manage members" modal's remove-member list.
router.get(
  "/:id/members",
  requireMasterTrainer,
  asyncRoute(async (req, res, db) => {
    const roomId = Number(req.params.id);
    const room = await loadOwnedRoom(db, roomId, req.masterTrainer.id);
    if (!room) return res.status(404).json({ error: "Room not found" });

    const { rows } = await db.query(
      `SELECT crm.user_id AS id, COALESCE(sup.full_name, st.full_name) AS full_name,
              CASE WHEN sup.id IS NOT NULL THEN 'supervisor' ELSE 'trainee' END AS kind
         FROM chat_room_members crm
         LEFT JOIN supervisors sup ON sup.id = crm.user_id
         LEFT JOIN students st ON st.id = crm.user_id
        WHERE crm.room_id = ?
        ORDER BY full_name`,
      [roomId]
    );
    res.json({ members: rows.map((r) => ({ id: r.id, fullName: r.full_name, kind: r.kind, isOwner: r.id === room.created_by })) });
  })
);

// GET /api/chat-rooms/:id/candidates -- Master-Trainer-only: this room's
// eligible-but-not-yet-added group members, for the add-member picker.
router.get(
  "/:id/candidates",
  requireMasterTrainer,
  asyncRoute(async (req, res, db) => {
    const roomId = Number(req.params.id);
    const room = await loadOwnedRoom(db, roomId, req.masterTrainer.id);
    if (!room) return res.status(404).json({ error: "Room not found" });

    const { rows } = await db.query(
      `SELECT sup.id, sup.full_name, 'supervisor' AS kind FROM supervisors sup
        WHERE sup.group_id = ? AND sup.id NOT IN (SELECT user_id FROM chat_room_members WHERE room_id = ?)
       UNION
       SELECT st.id, st.full_name, 'trainee' AS kind FROM students st
        WHERE st.group_id = ? AND st.id NOT IN (SELECT user_id FROM chat_room_members WHERE room_id = ?)`,
      [room.group_id, roomId, room.group_id, roomId]
    );
    res.json({ candidates: rows.map((r) => ({ id: r.id, fullName: r.full_name, kind: r.kind })) });
  })
);

// POST /api/chat-rooms/:id/members  { userId } -- creator only.
router.post(
  "/:id/members",
  requireMasterTrainer,
  asyncRoute(async (req, res, db) => {
    const roomId = Number(req.params.id);
    const room = await loadOwnedRoom(db, roomId, req.masterTrainer.id);
    if (!room) return res.status(404).json({ error: "Room not found" });

    const userId = Number((req.body || {}).userId);
    const { rows: eligible } = await db.query(
      `SELECT id FROM supervisors WHERE id = ? AND group_id = ?
       UNION SELECT id FROM students WHERE id = ? AND group_id = ?`,
      [userId, room.group_id, userId, room.group_id]
    );
    if (!eligible.length) return res.status(400).json({ error: "That person is not in your Group" });

    await db.query(
      "INSERT INTO chat_room_members (room_id, user_id, added_by) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE joined_at = joined_at",
      [roomId, userId, req.masterTrainer.id]
    );
    res.status(201).json({ success: true });
  })
);

// DELETE /api/chat-rooms/:id/members/:userId -- creator only.
router.delete(
  "/:id/members/:userId",
  requireMasterTrainer,
  asyncRoute(async (req, res, db) => {
    const roomId = Number(req.params.id);
    const room = await loadOwnedRoom(db, roomId, req.masterTrainer.id);
    if (!room) return res.status(404).json({ error: "Room not found" });

    const userId = Number(req.params.userId);
    if (userId === req.masterTrainer.id) {
      return res.status(400).json({ error: "The Master Trainer can't be removed from their own room" });
    }
    await db.query("DELETE FROM chat_room_members WHERE room_id = ? AND user_id = ?", [roomId, userId]);
    evictMember(req.app.get("io"), roomId, userId).catch(() => {});
    res.json({ success: true });
  })
);

// PUT /api/chat-rooms/:id  { name } -- creator only.
router.put(
  "/:id",
  requireMasterTrainer,
  asyncRoute(async (req, res, db) => {
    const roomId = Number(req.params.id);
    const room = await loadOwnedRoom(db, roomId, req.masterTrainer.id);
    if (!room) return res.status(404).json({ error: "Room not found" });

    const name = String((req.body || {}).name || "").trim();
    if (!name) return res.status(400).json({ error: "Room name is required" });
    await db.query("UPDATE chat_rooms SET name = ? WHERE id = ?", [name, roomId]);
    res.json({ success: true });
  })
);

// DELETE /api/chat-rooms/:id -- creator only.
router.delete(
  "/:id",
  requireMasterTrainer,
  asyncRoute(async (req, res, db) => {
    const roomId = Number(req.params.id);
    const room = await loadOwnedRoom(db, roomId, req.masterTrainer.id);
    if (!room) return res.status(404).json({ error: "Room not found" });
    await db.query("DELETE FROM chat_rooms WHERE id = ?", [roomId]);
    res.json({ success: true });
  })
);

// GET /api/chat-rooms/:id/messages?before=<id>&limit=50 -- paginated
// history, member only. Never fetches unbounded history -- same
// "don't wall-of-history" principle used for Weekly Activity.
router.get(
  "/:id/messages",
  asyncRoute(async (req, res, db) => {
    const roomId = Number(req.params.id);
    const room = await loadMemberRoom(db, roomId, req.user.id);
    if (!room) return res.status(404).json({ error: "Room not found" });

    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const before = Number(req.query.before) || null;
    const clauses = ["m.room_id = ?"];
    const params = [roomId];
    if (before) {
      clauses.push("m.id < ?");
      params.push(before);
    }
    const { rows } = await db.query(
      `SELECT m.*, COALESCE(sup.full_name, st.full_name) AS sender_name FROM chat_room_messages m
       LEFT JOIN supervisors sup ON sup.id = m.sender_id
       LEFT JOIN students st ON st.id = m.sender_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY m.id DESC LIMIT ?`,
      [...params, limit]
    );
    res.json({ messages: rows.map(toMessage).reverse(), hasMore: rows.length === limit });
  })
);

// POST /api/chat-rooms/:id/messages -- multipart (optional single
// attachment), member only. Persists, responds, then broadcasts over the
// socket so other connected members see it live.
router.post(
  "/:id/messages",
  (req, res, next) => {
    chatAttachmentUpload.single("attachment")(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      next();
    });
  },
  checkChatAttachmentContent,
  asyncRoute(async (req, res, db) => {
    const roomId = Number(req.params.id);
    const room = await loadMemberRoom(db, roomId, req.user.id);
    if (!room) return res.status(404).json({ error: "Room not found" });

    const content = (req.body && req.body.content && String(req.body.content).trim()) || null;
    const file = req.file;
    if (!content && !file) {
      return res.status(400).json({ error: "Message content or an attachment is required" });
    }

    const insert = await db.query(
      `INSERT INTO chat_room_messages (room_id, sender_id, content, attachment_filename, attachment_original_name, attachment_mime, attachment_size)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        roomId,
        req.user.id,
        content,
        file ? file.filename : null,
        file ? file.originalname : null,
        file ? file.mimetype : null,
        file ? file.size : null,
      ]
    );
    await db.query(
      "UPDATE chat_room_members SET last_read_at = NOW() WHERE room_id = ? AND user_id = ?",
      [roomId, req.user.id]
    );

    const { rows } = await db.query(
      `SELECT m.*, COALESCE(sup.full_name, st.full_name) AS sender_name FROM chat_room_messages m
       LEFT JOIN supervisors sup ON sup.id = m.sender_id
       LEFT JOIN students st ON st.id = m.sender_id
       WHERE m.id = ?`,
      [insert.insertId]
    );
    const message = toMessage(rows[0]);
    broadcastMessage(req.app.get("io"), roomId, message).catch(() => {});
    res.status(201).json(message);
  })
);

// POST /api/chat-rooms/:id/read -- marks the room read for the caller.
router.post(
  "/:id/read",
  asyncRoute(async (req, res, db) => {
    const roomId = Number(req.params.id);
    const room = await loadMemberRoom(db, roomId, req.user.id);
    if (!room) return res.status(404).json({ error: "Room not found" });
    await db.query("UPDATE chat_room_members SET last_read_at = NOW() WHERE room_id = ? AND user_id = ?", [
      roomId,
      req.user.id,
    ]);
    res.json({ success: true });
  })
);

module.exports = router;
