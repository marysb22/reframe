const express = require("express");
const { pool } = require("../db");
const { toPublicEvent, toEventDetail } = require("../utils/serializers");
const { sendEmail } = require("../utils/mailer");
const { renderEmailTemplate } = require("../utils/emailTemplates");

const router = express.Router();

// Strips CR/LF (defense-in-depth against header/log injection even though
// this input never reaches a raw email header) and caps length, for every
// free-text field submitted through the public registration form.
function cleanField(value, maxLength) {
  return String(value == null ? "" : value)
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, maxLength);
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Minimal per-IP rate limit for the public registration endpoint -- no new
// dependency, just a small in-memory window. Resets on server restart,
// which is fine: this is abuse mitigation, not a security boundary.
const REGISTRATION_RATE_LIMIT = { windowMs: 15 * 60 * 1000, max: 5 };
const registrationAttemptsByIp = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const attempts = (registrationAttemptsByIp.get(ip) || []).filter(
    (ts) => now - ts < REGISTRATION_RATE_LIMIT.windowMs
  );
  attempts.push(now);
  registrationAttemptsByIp.set(ip, attempts);
  return attempts.length > REGISTRATION_RATE_LIMIT.max;
}

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
    const events = rows.map(toPublicEvent);

    // An event with more than one occurrence date (event_agenda_items,
    // reused as-is -- see utils/eventChildren.js) needs every date exposed
    // here, not just the single primary event_date, so the public
    // calendar can light up each day it actually occurs on. One extra
    // batched query (never N+1), and only for events that opted in via
    // show_agenda -- same visibility gate as the detail page's agenda
    // section, so there's a single consistent rule for "are this event's
    // extra dates public" across the whole site.
    const agendaEventIds = rows.filter((r) => r.show_agenda).map((r) => r.id);
    if (agendaEventIds.length) {
      const placeholders = agendaEventIds.map(() => "?").join(",");
      const { rows: agendaRows } = await pool.query(
        `SELECT event_id, item_date FROM event_agenda_items
         WHERE event_id IN (${placeholders}) AND item_date IS NOT NULL
         ORDER BY item_date`,
        agendaEventIds
      );
      const datesByEvent = {};
      agendaRows.forEach((r) => {
        (datesByEvent[r.event_id] = datesByEvent[r.event_id] || []).push(r.item_date);
      });
      events.forEach((e) => {
        if (datesByEvent[e.id]) e.dates = datesByEvent[e.id];
      });
    }

    res.json({ events });
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

// POST /api/events/:id/register -- public, unauth registration submission
// from the events.html "Register Now" modal. Always a plain server-side
// INSERT + a best-effort internal email alert; the public response NEVER
// reveals whether that alert email actually sent (the client only ever
// finds out whether the registration itself was stored), so a down SMTP
// server or a typo'd env var can't make the site show a false "registered"
// claim or leak transport details to an anonymous caller.
router.post("/events/:id/register", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid event id" });
    }

    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    if (isRateLimited(ip)) {
      return res.status(429).json({ error: "Too many registration attempts. Please try again later." });
    }

    const b = req.body || {};

    // Honeypot: a real visitor never sees or fills this field (hidden
    // off-screen in the markup). A bot that fills every input gets a fake
    // success with no DB row and no email, so it has no signal to tell its
    // submission apart from a real one.
    if (cleanField(b.website, 200)) {
      return res.json({ success: true });
    }

    const firstName = cleanField(b.firstName, 100);
    const lastName = cleanField(b.lastName, 100);
    const email = cleanField(b.email, 190);
    const phone = cleanField(b.phone, 40);
    const location = cleanField(b.location, 150);

    if (!firstName || !lastName || !email || !phone || !location) {
      return res.status(400).json({ error: "All fields are required" });
    }
    if (!EMAIL_PATTERN.test(email)) {
      return res.status(400).json({ error: "Invalid email address" });
    }

    const { rows } = await pool.query("SELECT id, title_en, title_ar FROM events WHERE id = ?", [id]);
    const event = rows[0];
    if (!event) return res.status(404).json({ error: "Event not found" });

    const eventTitle = event.title_en || event.title_ar || `Event #${event.id}`;

    const insert = await pool.query(
      `INSERT INTO event_registrations (event_id, first_name, last_name, email, phone, location)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [event.id, firstName, lastName, email, phone, location]
    );

    // Respond to the visitor immediately -- registration is already durably
    // stored at this point, which is the only thing the success message
    // promises. The alert email to staff is a best-effort side effect; any
    // failure past this point (including a DB error updating email_sent)
    // must only be logged, never passed to next(err) -- the response has
    // already been sent, so an error handler trying to send another one
    // would blow up on "headers already sent" instead of doing anything
    // useful.
    res.json({ success: true });

    try {
      if (process.env.EVENT_REGISTRATION_EMAIL) {
        const { subject, text, html } = renderEmailTemplate("eventRegistration", {
          eventTitle,
          firstName,
          lastName,
          email,
          phone,
          location,
        });
        const result = await sendEmail({ to: process.env.EVENT_REGISTRATION_EMAIL, subject, text, html });
        if (result.sent) {
          await pool.query("UPDATE event_registrations SET email_sent = 1 WHERE id = ?", [insert.insertId]);
        } else {
          console.error(
            `[events.register] Registration #${insert.insertId} stored but alert email failed: ${result.reason}`
          );
        }
      } else {
        console.warn(
          `[events.register] EVENT_REGISTRATION_EMAIL is not set -- no alert email sent for registration #${insert.insertId}`
        );
      }
    } catch (emailErr) {
      console.error(`[events.register] Unexpected error sending alert email for registration #${insert.insertId}:`, emailErr.message);
    }
  } catch (err) {
    next(err);
  }
});

module.exports = router;
