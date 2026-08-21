const express = require("express");
const { pool } = require("../db");
const { toPublicEvent } = require("../utils/serializers");

const router = express.Router();

// GET /api/events -- the public site's events.html reads events from here.
// No auth: this is public marketing content, same as the rest of the
// public site. Deliberately separate from /api/admin/events (Admin's
// full-oversight, authenticated view) and /api/designer/events
// (a Designer's own-events management view) -- this route always returns
// every event regardless of who authored it, since visitors to the public
// site should see everything that's published, not just one author's work.
router.get("/events", async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT * FROM events ORDER BY event_date DESC");
    res.json({ events: rows.map(toPublicEvent) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
