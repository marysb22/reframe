// AI Assistant -- a DeepSeek-backed general assistant + translation helper,
// deliberately separate from the existing human-to-human chat (chatRooms.js /
// supervisor.js / profile.js / Mastertrainer.js). Every authenticated role
// may use it; it never reads or writes any other table in this app -- its
// only data is its own two tables (ai_conversations/ai_messages, migration
// 034) -- and it has no access to Reframe's data beyond what the caller
// types into it. See the "AI Assistant" tab in each dashboard's Chat section
// for the frontend half of this.
const express = require("express");
const config = require("../config");
const { requireAuth, asyncRoute } = require("../middleware/auth");
const { checkAndRecord } = require("../utils/rateLimit");

const router = express.Router();

router.use(requireAuth);

const MAX_MESSAGE_LENGTH = 4000;
const HISTORY_TURNS = 20;

const SYSTEM_PROMPT = `You are the AI Assistant inside Reframe, a training management system. You have two jobs:

1. General assistant: answer the user's questions helpfully and concisely.
2. Translation: when the user asks you to translate something -- in any
   phrasing, not just the word "translate" (e.g. "can you put this in
   French?", "ترجملي هيدا للإنجليزي", "Mets ça en anglais") -- detect the
   source and target language yourself from their wording, then output
   ONLY the translation, preserving the original meaning, tone, and any
   professional/training terminology. Do not add explanations unless asked.

Language rules: detect and reply in the user's own language (English,
French, or Arabic). Keep using that language across turns unless they
switch or explicitly ask for a translation into another one.

You do not have access to any of Reframe's database, user records, or
files. If asked about specific Reframe data you don't have, say so plainly
instead of guessing.`;

function toMessage(row) {
  return { id: row.id, role: row.role, content: row.content, createdAt: row.created_at };
}

async function getOrCreateConversationId(db, userId) {
  const { rows } = await db.query("SELECT id FROM ai_conversations WHERE user_id = ?", [userId]);
  if (rows.length) return rows[0].id;
  const insert = await db.query("INSERT INTO ai_conversations (user_id) VALUES (?)", [userId]);
  return insert.insertId;
}

// GET /api/ai/conversation -- this user's own AI Assistant thread so far
// (there is at most one per user -- see migration 034's UNIQUE key).
// Capped the same way chatRooms.js caps a room's history -- never an
// unbounded fetch.
router.get(
  "/conversation",
  asyncRoute(async (req, res, db) => {
    const { rows: convRows } = await db.query("SELECT id FROM ai_conversations WHERE user_id = ?", [req.user.id]);
    if (!convRows.length) return res.json({ messages: [] });

    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const { rows } = await db.query(
      "SELECT * FROM ai_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?",
      [convRows[0].id, limit]
    );
    res.json({ messages: rows.map(toMessage).reverse() });
  })
);

// POST /api/ai/chat  { message } -- never { message, history }: the
// caller's own prior turns are loaded from ai_messages here, server-side,
// never taken from the request body -- a client-supplied history could
// otherwise impersonate earlier "assistant" turns that were never actually
// said, feeding the model a fabricated conversation (prompt injection via
// history, not just via the message itself).
router.post(
  "/chat",
  asyncRoute(async (req, res, db) => {
    if (!config.deepseekApiKey) {
      return res.status(503).json({ error: "The AI Assistant isn't configured on this server yet." });
    }

    const message = String((req.body || {}).message || "").trim();
    if (!message) return res.status(400).json({ error: "A message is required" });
    if (message.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ error: `Message is too long (max ${MAX_MESSAGE_LENGTH} characters)` });
    }

    // Keyed by account, not IP -- same reasoning as library.js's Crossref
    // proxy (checkAndRecord's first real use in this app): this calls a
    // paid external API, so one account (or a leaked token) must not be
    // able to run up the bill or exhaust whatever cap DeepSeek itself
    // enforces for everyone else.
    const rate = checkAndRecord(`ai-chat:${req.user.id}`, { max: 20, windowMs: 60 * 1000 });
    if (rate.blocked) {
      return res.status(429).json({ error: `Too many AI requests -- try again in ${rate.retryAfterSeconds}s.` });
    }

    const conversationId = await getOrCreateConversationId(db, req.user.id);

    const { rows: historyRows } = await db.query(
      "SELECT role, content FROM ai_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?",
      [conversationId, HISTORY_TURNS]
    );
    const history = historyRows.reverse().map((r) => ({ role: r.role, content: r.content }));

    let reply;
    try {
      const upstream = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.deepseekApiKey}`,
        },
        body: JSON.stringify({
          model: "deepseek-flash",
          messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history, { role: "user", content: message }],
          stream: false,
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!upstream.ok) throw new Error(`DeepSeek responded ${upstream.status}`);
      const body = await upstream.json();
      reply = body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content;
      if (!reply) throw new Error("DeepSeek returned no reply content");
    } catch (err) {
      console.error("[ai] DeepSeek request failed:", err.message);
      return res.status(502).json({ error: "The AI Assistant is unavailable right now. Try again shortly." });
    }

    await db.query("INSERT INTO ai_messages (conversation_id, role, content) VALUES (?, 'user', ?)", [
      conversationId,
      message,
    ]);
    const insert = await db.query("INSERT INTO ai_messages (conversation_id, role, content) VALUES (?, 'assistant', ?)", [
      conversationId,
      reply,
    ]);

    res.status(201).json({ id: insert.insertId, role: "assistant", content: reply, createdAt: new Date().toISOString() });
  })
);

module.exports = router;
