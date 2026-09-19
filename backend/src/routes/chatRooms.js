// Group Chats -- Master Trainer-curated chat rooms, independent of
// trainer_groups/supervisor_students membership (see database/migrations/
// 005_chat_rooms.sql for why). Used identically by all three dashboards;
// permissions are enforced per-request (room membership / room ownership),
// not by which role hit the route -- mirrors how Notifications ended up
// centralized in profile.js rather than duplicated per role.
const express = require("express");
const { requireAuth, requireGroupSupervisor, requireGroupMember, asyncRoute } = require("../middleware/auth");
const { pool } = require("../db");
const { chatAttachmentUpload, checkChatAttachmentContent, optimizeChatAttachmentImage } = require("../utils/uploads");
const { broadcastMessage, evictMember } = require("../realtime/chatSocket");

const router = express.Router();
router.use(requireAuth);

function toMessage(row) {
  return {
    id: row.id,
    roomId: row.room_id,
    senderId: row.sender_id,
    senderName: row.sender_name,
    senderPhoto: row.sender_photo,
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

/** Resolves a room only if the caller is the one who created it (a Master Trainer or a ToT). */
async function loadOwnedRoom(db, roomId, creatorId) {
  const { rows } = await db.query("SELECT * FROM chat_rooms WHERE id = ? AND created_by = ?", [roomId, creatorId]);
  return rows[0] || null;
}

// GET /api/chat-rooms -- my rooms (Group rooms and Direct threads alike),
// with a last-message preview + unread flag. Pass ?type=direct or
// ?type=group to filter to just one kind (used by the Direct Chat inbox
// vs. the Group Chats list, which are the same underlying table).
router.get(
  "/",
  asyncRoute(async (req, res, db) => {
    const { rows } = await db.query(
      `SELECT r.id, r.name, r.created_by, r.is_direct, m.last_read_at,
              (SELECT COUNT(*) FROM chat_room_members WHERE room_id = r.id) AS member_count,
              lm.content AS last_content, lm.attachment_original_name AS last_attachment_name,
              lm.created_at AS last_message_at,
              COALESCE(sup.full_name, st.full_name) AS last_sender_name,
              (SELECT COUNT(*) FROM chat_room_messages
                WHERE room_id = r.id AND created_at > COALESCE(m.last_read_at, '1970-01-01')) AS unread_count,
              other_sup.id AS other_supervisor_id, other_sup.full_name AS other_supervisor_name, other_sup.supervisor_type AS other_supervisor_type,
              other_st.id AS other_trainee_id, other_st.full_name AS other_trainee_name
         FROM chat_rooms r
         JOIN chat_room_members m ON m.room_id = r.id
         LEFT JOIN chat_room_messages lm ON lm.id = (
           SELECT id FROM chat_room_messages WHERE room_id = r.id ORDER BY created_at DESC LIMIT 1
         )
         LEFT JOIN supervisors sup ON sup.id = lm.sender_id
         LEFT JOIN students st ON st.id = lm.sender_id
         LEFT JOIN chat_room_members other_m ON other_m.room_id = r.id AND other_m.user_id != ? AND r.is_direct = TRUE
         LEFT JOIN supervisors other_sup ON other_sup.id = other_m.user_id
         LEFT JOIN students other_st ON other_st.id = other_m.user_id
        WHERE m.user_id = ?
          ${req.query.type === "direct" ? "AND r.is_direct = TRUE" : ""}
          ${req.query.type === "group" ? "AND r.is_direct = FALSE" : ""}
        ORDER BY lm.created_at IS NULL, lm.created_at DESC`,
      [req.user.id, req.user.id]
    );
    res.json({
      rooms: rows.map((r) => ({
        id: r.id,
        // A Direct thread's own `name` (the OTHER party's name at the time
        // it was created) is only a fallback -- the live name is looked up
        // fresh every time so a later name change is reflected immediately.
        name: r.is_direct ? (r.other_supervisor_name || r.other_trainee_name || r.name) : r.name,
        isDirect: !!r.is_direct,
        otherUserId: r.is_direct ? (r.other_supervisor_id || r.other_trainee_id || null) : undefined,
        otherUserRole: r.is_direct ? (r.other_supervisor_id ? (r.other_supervisor_type === "primary" ? "Master Trainer" : "ToT") : r.other_trainee_id ? "Trainee" : null) : undefined,
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

// POST /api/chat-rooms/direct  { userId } -- find-or-create a Direct Chat
// thread with someone in the caller's own Group. Reuses chat_rooms'
// existing generic (any user_credentials pair) membership/messaging
// infrastructure instead of the separate chats/messages tables, whose
// supervisor_id/student_id columns are typed FKs that structurally cannot
// hold a supervisor-to-supervisor (Master Trainer <-> ToT) pair -- see
// migration 023's comment. A "direct" thread is just an ordinary 2-member
// room with is_direct=TRUE, found by membership rather than a synthetic
// composite key (order-independent, unlike a lookup keyed on created_by).
router.post(
  "/direct",
  requireGroupMember,
  asyncRoute(async (req, res, db) => {
    if (!req.groupMember.groupId) return res.status(400).json({ error: "You don't have a Group assigned yet" });

    const targetId = Number((req.body || {}).userId);
    if (!targetId || targetId === req.groupMember.id) {
      return res.status(400).json({ error: "Choose someone else to message" });
    }

    // Only people currently in the caller's own Group are eligible -- same
    // eligibility set as a regular room's member picker.
    const { rows: eligible } = await db.query(
      `SELECT id FROM supervisors WHERE id = ? AND group_id = ?
       UNION SELECT id FROM students WHERE id = ? AND group_id = ?`,
      [targetId, req.groupMember.groupId, targetId, req.groupMember.groupId]
    );
    if (!eligible.length) return res.status(400).json({ error: "That person is not in your Group" });

    const { rows: existingRoom } = await db.query(
      `SELECT cr.id FROM chat_rooms cr
         JOIN chat_room_members m1 ON m1.room_id = cr.id AND m1.user_id = ?
         JOIN chat_room_members m2 ON m2.room_id = cr.id AND m2.user_id = ?
        WHERE cr.is_direct = TRUE
        LIMIT 1`,
      [req.groupMember.id, targetId]
    );
    if (existingRoom.length) return res.json({ id: existingRoom[0].id });

    const { rows: targetNameRows } = await db.query(
      `SELECT full_name FROM supervisors WHERE id = ? UNION SELECT full_name FROM students WHERE id = ?`,
      [targetId, targetId]
    );
    const name = (targetNameRows[0] && targetNameRows[0].full_name) || "Direct message";

    const room = await db.query("INSERT INTO chat_rooms (name, created_by, group_id, is_direct) VALUES (?, ?, ?, TRUE)", [
      name,
      req.groupMember.id,
      req.groupMember.groupId,
    ]);
    const roomId = room.insertId;
    await db.query("INSERT INTO chat_room_members (room_id, user_id, added_by) VALUES (?, ?, ?)", [roomId, req.groupMember.id, req.groupMember.id]);
    await db.query("INSERT INTO chat_room_members (room_id, user_id, added_by) VALUES (?, ?, ?)", [roomId, targetId, req.groupMember.id]);

    res.status(201).json({ id: roomId });
  })
);

// POST /api/chat-rooms  { name, memberIds: [] } -- any supervisor (Master
// Trainer or ToT) in a Group may create a room. Every memberId must
// currently belong to the creator's own group (their own row is always
// included automatically).
router.post(
  "/",
  requireGroupSupervisor,
  asyncRoute(async (req, res, db) => {
    const name = String((req.body || {}).name || "").trim();
    if (!name) return res.status(400).json({ error: "Room name is required" });
    if (!req.groupSupervisor.groupId) return res.status(400).json({ error: "You don't have a Group assigned yet" });

    const memberIds = Array.isArray((req.body || {}).memberIds) ? (req.body.memberIds).map(Number) : [];

    // Only people currently in the creator's own group are eligible.
    const { rows: eligible } = await db.query(
      `SELECT id FROM supervisors WHERE group_id = ?
       UNION SELECT id FROM students WHERE group_id = ?`,
      [req.groupSupervisor.groupId, req.groupSupervisor.groupId]
    );
    const eligibleIds = new Set(eligible.map((r) => r.id));
    const invalid = memberIds.filter((id) => !eligibleIds.has(id));
    if (invalid.length) {
      return res.status(400).json({ error: "One or more selected members are not in your Group" });
    }

    const room = await db.query("INSERT INTO chat_rooms (name, created_by, group_id) VALUES (?, ?, ?)", [
      name,
      req.groupSupervisor.id,
      req.groupSupervisor.groupId,
    ]);
    const roomId = room.insertId;

    const allMemberIds = new Set([req.groupSupervisor.id, ...memberIds]);
    for (const userId of allMemberIds) {
      await db.query("INSERT INTO chat_room_members (room_id, user_id, added_by) VALUES (?, ?, ?)", [
        roomId,
        userId,
        req.groupSupervisor.id,
      ]);
    }

    res.status(201).json({ id: roomId, name, memberIds: [...allMemberIds] });
  })
);

// GET /api/chat-rooms/roster -- any Group member (supervisor OR trainee):
// everyone else in that same Group (every other ToT/Master Trainer + every
// other Trainee), for the "New Room" member picker before any room exists
// yet, and for a Trainee's Direct Chats member list (see requireGroupMember).
router.get(
  "/roster",
  requireGroupMember,
  asyncRoute(async (req, res, db) => {
    if (!req.groupMember.groupId) return res.json({ roster: [] });
    // supervisor_type distinguishes a Master Trainer from a ToT within the
    // 'supervisor' kind -- needed once a ToT (not just a Master Trainer) can
    // see this list, since it may now include their own Master Trainer.
    const { rows } = await db.query(
      `SELECT sup.id, sup.full_name, sup.photo, 'supervisor' AS kind, sup.supervisor_type FROM supervisors sup
        WHERE sup.group_id = ? AND sup.id != ?
       UNION
       SELECT st.id, st.full_name, st.photo, 'trainee' AS kind, NULL AS supervisor_type FROM students st
        WHERE st.group_id = ? AND st.id != ?`,
      [req.groupMember.groupId, req.groupMember.id, req.groupMember.groupId, req.groupMember.id]
    );
    res.json({
      roster: rows.map((r) => ({ id: r.id, fullName: r.full_name, photo: r.photo, kind: r.kind, supervisorType: r.supervisor_type })),
    });
  })
);

// GET /api/chat-rooms/:id/members -- owner only: the room's current
// members by name, for the "Manage members" modal's remove-member list.
router.get(
  "/:id/members",
  requireGroupSupervisor,
  asyncRoute(async (req, res, db) => {
    const roomId = Number(req.params.id);
    const room = await loadOwnedRoom(db, roomId, req.groupSupervisor.id);
    if (!room) return res.status(404).json({ error: "Room not found" });

    const { rows } = await db.query(
      `SELECT crm.user_id AS id, COALESCE(sup.full_name, st.full_name) AS full_name,
              CASE WHEN sup.id IS NOT NULL THEN 'supervisor' ELSE 'trainee' END AS kind,
              sup.supervisor_type
         FROM chat_room_members crm
         LEFT JOIN supervisors sup ON sup.id = crm.user_id
         LEFT JOIN students st ON st.id = crm.user_id
        WHERE crm.room_id = ?
        ORDER BY full_name`,
      [roomId]
    );
    res.json({
      members: rows.map((r) => ({
        id: r.id,
        fullName: r.full_name,
        kind: r.kind,
        supervisorType: r.supervisor_type,
        isOwner: r.id === room.created_by,
      })),
    });
  })
);

// GET /api/chat-rooms/:id/candidates -- creator only: this room's
// eligible-but-not-yet-added group members, for the add-member picker.
router.get(
  "/:id/candidates",
  requireGroupSupervisor,
  asyncRoute(async (req, res, db) => {
    const roomId = Number(req.params.id);
    const room = await loadOwnedRoom(db, roomId, req.groupSupervisor.id);
    if (!room) return res.status(404).json({ error: "Room not found" });

    const { rows } = await db.query(
      `SELECT sup.id, sup.full_name, 'supervisor' AS kind, sup.supervisor_type FROM supervisors sup
        WHERE sup.group_id = ? AND sup.id NOT IN (SELECT user_id FROM chat_room_members WHERE room_id = ?)
       UNION
       SELECT st.id, st.full_name, 'trainee' AS kind, NULL AS supervisor_type FROM students st
        WHERE st.group_id = ? AND st.id NOT IN (SELECT user_id FROM chat_room_members WHERE room_id = ?)`,
      [room.group_id, roomId, room.group_id, roomId]
    );
    res.json({
      candidates: rows.map((r) => ({ id: r.id, fullName: r.full_name, kind: r.kind, supervisorType: r.supervisor_type })),
    });
  })
);

// POST /api/chat-rooms/:id/members  { userId } -- creator only.
router.post(
  "/:id/members",
  requireGroupSupervisor,
  asyncRoute(async (req, res, db) => {
    const roomId = Number(req.params.id);
    const room = await loadOwnedRoom(db, roomId, req.groupSupervisor.id);
    if (!room) return res.status(404).json({ error: "Room not found" });
    if (room.is_direct) return res.status(400).json({ error: "Direct chats can't have members added" });

    const userId = Number((req.body || {}).userId);
    const { rows: eligible } = await db.query(
      `SELECT id FROM supervisors WHERE id = ? AND group_id = ?
       UNION SELECT id FROM students WHERE id = ? AND group_id = ?`,
      [userId, room.group_id, userId, room.group_id]
    );
    if (!eligible.length) return res.status(400).json({ error: "That person is not in your Group" });

    await db.query(
      "INSERT INTO chat_room_members (room_id, user_id, added_by) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE joined_at = joined_at",
      [roomId, userId, req.groupSupervisor.id]
    );
    res.status(201).json({ success: true });
  })
);

// DELETE /api/chat-rooms/:id/members/:userId -- creator only.
router.delete(
  "/:id/members/:userId",
  requireGroupSupervisor,
  asyncRoute(async (req, res, db) => {
    const roomId = Number(req.params.id);
    const room = await loadOwnedRoom(db, roomId, req.groupSupervisor.id);
    if (!room) return res.status(404).json({ error: "Room not found" });
    if (room.is_direct) return res.status(400).json({ error: "Direct chats can't have members removed -- delete the chat instead" });

    const userId = Number(req.params.userId);
    if (userId === req.groupSupervisor.id) {
      return res.status(400).json({ error: "The room's creator can't be removed from their own room" });
    }
    await db.query("DELETE FROM chat_room_members WHERE room_id = ? AND user_id = ?", [roomId, userId]);
    evictMember(req.app.get("io"), roomId, userId).catch(() => {});
    res.json({ success: true });
  })
);

// PUT /api/chat-rooms/:id  { name } -- creator only.
router.put(
  "/:id",
  requireGroupSupervisor,
  asyncRoute(async (req, res, db) => {
    const roomId = Number(req.params.id);
    const room = await loadOwnedRoom(db, roomId, req.groupSupervisor.id);
    if (!room) return res.status(404).json({ error: "Room not found" });
    if (room.is_direct) return res.status(400).json({ error: "Direct chats can't be renamed" });

    const name = String((req.body || {}).name || "").trim();
    if (!name) return res.status(400).json({ error: "Room name is required" });
    await db.query("UPDATE chat_rooms SET name = ? WHERE id = ?", [name, roomId]);
    res.json({ success: true });
  })
);

// DELETE /api/chat-rooms/:id -- creator only.
router.delete(
  "/:id",
  requireGroupSupervisor,
  asyncRoute(async (req, res, db) => {
    const roomId = Number(req.params.id);
    const room = await loadOwnedRoom(db, roomId, req.groupSupervisor.id);
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
      `SELECT m.*, COALESCE(sup.full_name, st.full_name) AS sender_name, COALESCE(sup.photo, st.photo) AS sender_photo FROM chat_room_messages m
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
  optimizeChatAttachmentImage,
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
      `SELECT m.*, COALESCE(sup.full_name, st.full_name) AS sender_name, COALESCE(sup.photo, st.photo) AS sender_photo FROM chat_room_messages m
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
