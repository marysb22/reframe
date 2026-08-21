const express = require("express");
const { requireAuth, requireDesigner, asyncRoute } = require("../middleware/auth");
const { toArray, toPublicEvent } = require("../utils/serializers");
const { eventImageUpload } = require("../utils/uploads");

const router = express.Router();

router.use(requireAuth, requireDesigner);

// ---- Events (public site content, Designer-owned) ------------------------
// A Designer is a separate role from Admin: not created through the Admin
// Dashboard's Groups flow, no access to trainee/finance/account-management
// data. Its only real job is authoring the public site's Events content in
// English and Arabic. A Designer only ever sees and manages events they
// themselves created (events.created_by = their own id) -- Admin-authored
// legacy events, or another Designer's events, are invisible here. Admin
// keeps its own separate, unrestricted view of all events at
// /api/admin/events for oversight; this route is Designer-only.

router.post("/events/upload-image", (req, res) => {
  eventImageUpload.single("image")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    res.status(201).json({ url: `/uploads/events/${req.file.filename}` });
  });
});

// GET /api/designer/events
router.get(
  "/events",
  asyncRoute(async (req, res, db) => {
    const { rows } = await db.query("SELECT * FROM events WHERE created_by = ? ORDER BY event_date DESC", [
      req.user.id,
    ]);
    res.json({ events: rows.map(toPublicEvent) });
  })
);

// POST /api/designer/events
router.post(
  "/events",
  asyncRoute(async (req, res, db) => {
    const b = req.body || {};
    if (!b.date) return res.status(400).json({ error: "date is required" });

    const insert = await db.query(
      `INSERT INTO events (
        created_by, event_date, image, status, fee, register_url,
        title_en, format_en, facilitator_en, about_en, learn_en, who_en, outcomes_en, facilitator_bio_en,
        title_ar, format_ar, facilitator_ar, about_ar, learn_ar, who_ar, outcomes_ar, facilitator_bio_ar
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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

    const { rows } = await db.query("SELECT * FROM events WHERE id = ?", [insert.insertId]);
    res.status(201).json(toPublicEvent(rows[0]));
  })
);

// PUT /api/designer/events/:id — only the Designer's own events
router.put(
  "/events/:id",
  asyncRoute(async (req, res, db) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid event id" });

    const { rows: existingRows } = await db.query("SELECT * FROM events WHERE id = ?", [id]);
    const existing = existingRows[0];
    if (!existing) return res.status(404).json({ error: "Event not found" });
    if (existing.created_by !== req.user.id) {
      return res.status(403).json({ error: "You can only edit events you created" });
    }

    const b = req.body || {};
    await db.query(
      `UPDATE events SET
        event_date = ?, image = ?, status = ?, fee = ?, register_url = ?,
        title_en = ?, format_en = ?, facilitator_en = ?, about_en = ?,
        learn_en = ?, who_en = ?, outcomes_en = ?, facilitator_bio_en = ?,
        title_ar = ?, format_ar = ?, facilitator_ar = ?, about_ar = ?,
        learn_ar = ?, who_ar = ?, outcomes_ar = ?, facilitator_bio_ar = ?,
        updated_at = NOW()
       WHERE id = ?`,
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
      ]
    );

    const { rows } = await db.query("SELECT * FROM events WHERE id = ?", [id]);
    res.json(toPublicEvent(rows[0]));
  })
);

// DELETE /api/designer/events/:id — only the Designer's own events
router.delete(
  "/events/:id",
  asyncRoute(async (req, res, db) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid event id" });

    const { rows: existingRows } = await db.query("SELECT created_by FROM events WHERE id = ?", [id]);
    if (!existingRows.length) return res.status(404).json({ error: "Event not found" });
    if (existingRows[0].created_by !== req.user.id) {
      return res.status(403).json({ error: "You can only delete events you created" });
    }

    await db.query("DELETE FROM events WHERE id = ?", [id]);
    res.json({ success: true });
  })
);

module.exports = router;
