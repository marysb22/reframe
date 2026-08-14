const express = require("express");
const db = require("../../db");
const { toPublicEvent } = require("../utils/serializers");

const router = express.Router();

// GET /api/events — public, no login required. Matches the shape the
// events.html page already expects from the old static events.json file.
router.get("/", (req, res) => {
  const rows = db.prepare("SELECT * FROM events ORDER BY event_date DESC").all();
  res.json({ events: rows.map(toPublicEvent) });
});

module.exports = router;