const express = require("express");
const { requireAuth, requireDesigner, asyncRoute } = require("../middleware/auth");
const { toPublicEvent } = require("../utils/serializers");
const { eventImageUpload } = require("../utils/uploads");

const router = express.Router();

router.use(requireAuth, requireDesigner);

function parseIdParam(raw) {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Admin forms send either a real array or newline-separated bullet text -- normalize to an array either way. */
function toArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    return value.split("\n").map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

// ---- Events (owned by the logged-in designer only) -----------------------
// Every query below is scoped by created_by = req.user.id -- a designer can
// never read, edit, or delete another designer's events, and this is
// enforced here in the query itself, not just hidden in the UI.

router.post("/events/upload-image", (req, res) => {
  eventImageUpload.single("image")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    res.status(201).json({ url: `/uploads/events/${req.file.filename}` });
  });
});

// GET /api/designer/events -- only this designer's own events
router.get(
  "/events",
  asyncRoute(async (req, res, db) => {
    const { rows } = await db.query(
      "SELECT * FROM events WHERE created_by = $1 ORDER BY event_date DESC",
      [req.user.id]
    );
    res.json({ events: rows.map(toPublicEvent) });
  })
);

router.post(
  "/events",
  asyncRoute(async (req, res, db) => {
    const b = req.body || {};
    if (!b.date) return res.status(400).json({ error: "date is required" });

    const { rows } = await db.query(
      `INSERT INTO events (
        created_by, event_date, image, status, fee, register_url,
        title_en, format_en, facilitator_en, about_en, learn_en, who_en, outcomes_en, facilitator_bio_en,
        title_ar, format_ar, facilitator_ar, about_ar, learn_ar, who_ar, outcomes_ar, facilitator_bio_ar
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
      RETURNING *`,
      [
        req.user.id,
        b.date,
        b.image || null,
        ["upcoming", "concluded"].includes(b.status) ? b.status : "upcoming",
        b.fee || null,
        b.register || null,
        b.englishTitle || null,
        b.englishFormat || null,
        b.englishFacilitator || null,
        b.englishAbout || null,
        JSON.stringify(toArray(b.englishLearn)),
        JSON.stringify(toArray(b.englishWho)),
        JSON.stringify(toArray(b.englishOutcomes)),
        b.englishFacilitatorBio || null,
        b.arabicTitle || null,
        b.arabicFormat || null,
        b.arabicFacilitator || null,
        b.arabicAbout || null,
        JSON.stringify(toArray(b.arabicLearn)),
        JSON.stringify(toArray(b.arabicWho)),
        JSON.stringify(toArray(b.arabicOutcomes)),
        b.arabicFacilitatorBio || null,
      ]
    );

    res.status(201).json(toPublicEvent(rows[0]));
  })
);

router.put(
  "/events/:id",
  asyncRoute(async (req, res, db) => {
    const id = parseIdParam(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid event id" });

    const { rows: existingRows } = await db.query(
      "SELECT * FROM events WHERE id = $1 AND created_by = $2",
      [id, req.user.id]
    );
    const existing = existingRows[0];
    if (!existing) return res.status(404).json({ error: "Event not found" });

    const b = req.body || {};
    const { rows } = await db.query(
      `UPDATE events SET
        event_date = $1, image = $2, status = $3, fee = $4, register_url = $5,
        title_en = $6, format_en = $7, facilitator_en = $8, about_en = $9,
        learn_en = $10, who_en = $11, outcomes_en = $12, facilitator_bio_en = $13,
        title_ar = $14, format_ar = $15, facilitator_ar = $16, about_ar = $17,
        learn_ar = $18, who_ar = $19, outcomes_ar = $20, facilitator_bio_ar = $21,
        updated_at = now()
       WHERE id = $22 AND created_by = $23 RETURNING *`,
      [
        b.date ?? existing.event_date,
        b.image ?? existing.image,
        ["upcoming", "concluded"].includes(b.status) ? b.status : existing.status,
        b.fee ?? existing.fee,
        b.register ?? existing.register_url,
        b.englishTitle ?? existing.title_en,
        b.englishFormat ?? existing.format_en,
        b.englishFacilitator ?? existing.facilitator_en,
        b.englishAbout ?? existing.about_en,
        b.englishLearn !== undefined ? JSON.stringify(toArray(b.englishLearn)) : JSON.stringify(existing.learn_en),
        b.englishWho !== undefined ? JSON.stringify(toArray(b.englishWho)) : JSON.stringify(existing.who_en),
        b.englishOutcomes !== undefined
          ? JSON.stringify(toArray(b.englishOutcomes))
          : JSON.stringify(existing.outcomes_en),
        b.englishFacilitatorBio ?? existing.facilitator_bio_en,
        b.arabicTitle ?? existing.title_ar,
        b.arabicFormat ?? existing.format_ar,
        b.arabicFacilitator ?? existing.facilitator_ar,
        b.arabicAbout ?? existing.about_ar,
        b.arabicLearn !== undefined ? JSON.stringify(toArray(b.arabicLearn)) : JSON.stringify(existing.learn_ar),
        b.arabicWho !== undefined ? JSON.stringify(toArray(b.arabicWho)) : JSON.stringify(existing.who_ar),
        b.arabicOutcomes !== undefined
          ? JSON.stringify(toArray(b.arabicOutcomes))
          : JSON.stringify(existing.outcomes_ar),
        b.arabicFacilitatorBio ?? existing.facilitator_bio_ar,
        id,
        req.user.id,
      ]
    );

    res.json(toPublicEvent(rows[0]));
  })
);

router.delete(
  "/events/:id",
  asyncRoute(async (req, res, db) => {
    const id = parseIdParam(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid event id" });

    const { rowCount } = await db.query(
      "DELETE FROM events WHERE id = $1 AND created_by = $2",
      [id, req.user.id]
    );
    if (!rowCount) return res.status(404).json({ error: "Event not found" });
    res.json({ success: true });
  })
);

module.exports = router;

