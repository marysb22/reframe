const express = require("express");
const { pool } = require("../db");
const { toPublicEvent, toEventDetail } = require("../utils/serializers");

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

// GET /api/events/:slug -- public, unauth, single event. Section arrays are
// enforced OFF at the source: a section whose show_* toggle is false has its
// key deleted from the response entirely (not sent empty), so nothing
// downstream can accidentally leak an off section's data. Contrast with the
// designer/admin single-event routes, which always return full child data
// regardless of toggle state (that's the authenticated editor's view).
router.get("/events/:slug", async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT * FROM events WHERE slug = ?", [req.params.slug]);
    const event = rows[0];
    if (!event) return res.status(404).json({ error: "Event not found" });

    const [speakers, agenda, sponsors, gallery] = await Promise.all([
      event.show_speakers
        ? pool.query("SELECT * FROM event_speakers WHERE event_id = ? ORDER BY sort_order, id", [event.id])
        : { rows: [] },
      event.show_agenda
        ? pool.query("SELECT * FROM event_agenda_items WHERE event_id = ? ORDER BY sort_order, id", [event.id])
        : { rows: [] },
      event.show_sponsors
        ? pool.query("SELECT * FROM event_sponsors WHERE event_id = ? ORDER BY sort_order, id", [event.id])
        : { rows: [] },
      event.show_gallery
        ? pool.query("SELECT * FROM event_gallery WHERE event_id = ? ORDER BY sort_order, id", [event.id])
        : { rows: [] },
    ]);

    const detail = toEventDetail(event, {
      speakers: speakers.rows,
      agenda: agenda.rows,
      sponsors: sponsors.rows,
      gallery: gallery.rows,
    });
    if (!detail.toggles.speakers) delete detail.speakers;
    if (!detail.toggles.agenda) delete detail.agenda;
    if (!detail.toggles.sponsors) delete detail.sponsors;
    if (!detail.toggles.gallery) delete detail.gallery;

    res.json(detail);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
