const express = require("express");
const { pool } = require("../db");
const { toPublicEvent } = require("../utils/serializers");

const router = express.Router();

// GET /api/events -- public, unauthenticated. Powers the public
// events.html page (EVENTS_API), which lists every event regardless of
// which designer created it. No RLS context needed: `events` has no RLS
// policy (it's public content), so a plain pool query is fine here, unlike
// the RLS-protected tables that require asyncRoute's transactional client.
router.get("/", async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT * FROM events ORDER BY event_date DESC");
    res.json({ events: rows.map(toPublicEvent) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
