const { slugify } = require("./slugify");

/** Fetches all four child collections for one event, each in designer-chosen
 * order. Always returns full data regardless of the show_* toggles -- callers
 * that need to respect OFF toggles (the public route) filter afterwards; the
 * authenticated editor always needs everything so re-enabling a section never
 * loses previously-entered data. */
async function fetchEventChildren(db, eventId) {
  const [speakers, agenda, sponsors, gallery] = await Promise.all([
    db.query("SELECT * FROM event_speakers WHERE event_id = ? ORDER BY sort_order, id", [eventId]),
    db.query("SELECT * FROM event_agenda_items WHERE event_id = ? ORDER BY sort_order, id", [eventId]),
    db.query("SELECT * FROM event_sponsors WHERE event_id = ? ORDER BY sort_order, id", [eventId]),
    db.query("SELECT * FROM event_gallery WHERE event_id = ? ORDER BY sort_order, id", [eventId]),
  ]);
  return {
    speakers: speakers.rows,
    agenda: agenda.rows,
    sponsors: sponsors.rows,
    gallery: gallery.rows,
  };
}

/**
 * Replace-all writer for the four child collections, guarded per-collection
 * by `!== undefined` -- a collection key that's simply absent from the
 * request body is left completely untouched (existing rows survive), while
 * an explicit `[]` deletes everything. This matters because the pre-this-
 * feature frontend never sends these keys at all, so treating "absent" the
 * same as "empty" would silently wipe data on the very first old-format save
 * after this ships.
 *
 * Agenda items may reference a speaker from the SAME request body via a
 * 0-based `speakerIndex` into `body.speakers` -- speakers are always deleted
 * and re-inserted with fresh auto-increment ids on every save (replace-all),
 * so a stale `speaker_id` from a previous load would silently point at
 * nothing (or, far worse, at a since-reused id from an unrelated event).
 * Speakers are inserted first, an index->insertId map is built from that,
 * and agenda rows resolve their real speaker_id from it.
 */
async function writeEventChildren(db, eventId, body) {
  let speakerIdByIndex = [];

  if (body.speakers !== undefined) {
    await db.query("DELETE FROM event_speakers WHERE event_id = ?", [eventId]);
    const speakers = Array.isArray(body.speakers) ? body.speakers : [];
    for (let i = 0; i < speakers.length; i++) {
      const s = speakers[i] || {};
      const insert = await db.query(
        `INSERT INTO event_speakers (event_id, name_en, name_ar, title_en, title_ar, bio_en, bio_ar, photo, sort_order)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [eventId, s.nameEn || null, s.nameAr || null, s.titleEn || null, s.titleAr || null, s.bioEn || null, s.bioAr || null, s.photo || null, i]
      );
      speakerIdByIndex[i] = insert.insertId;
    }
  } else {
    // Speakers weren't touched this save -- if agenda items reference them
    // by index, resolve against the speakers that already exist in the DB
    // (same order this function always reads them back in).
    const { rows } = await db.query(
      "SELECT id FROM event_speakers WHERE event_id = ? ORDER BY sort_order, id",
      [eventId]
    );
    speakerIdByIndex = rows.map((r) => r.id);
  }

  if (body.agenda !== undefined) {
    await db.query("DELETE FROM event_agenda_items WHERE event_id = ?", [eventId]);
    const agenda = Array.isArray(body.agenda) ? body.agenda : [];
    for (let i = 0; i < agenda.length; i++) {
      const a = agenda[i] || {};
      const speakerId =
        typeof a.speakerIndex === "number" && speakerIdByIndex[a.speakerIndex] !== undefined
          ? speakerIdByIndex[a.speakerIndex]
          : null;
      await db.query(
        `INSERT INTO event_agenda_items
           (event_id, item_date, start_time, end_time, title_en, title_ar, description_en, description_ar, speaker_id, sort_order)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          eventId,
          a.date || null,
          a.startTime || null,
          a.endTime || null,
          a.titleEn || null,
          a.titleAr || null,
          a.descriptionEn || null,
          a.descriptionAr || null,
          speakerId,
          i,
        ]
      );
    }
  }

  if (body.sponsors !== undefined) {
    await db.query("DELETE FROM event_sponsors WHERE event_id = ?", [eventId]);
    const sponsors = Array.isArray(body.sponsors) ? body.sponsors : [];
    for (let i = 0; i < sponsors.length; i++) {
      const s = sponsors[i] || {};
      await db.query(
        "INSERT INTO event_sponsors (event_id, name, logo, url, sort_order) VALUES (?,?,?,?,?)",
        [eventId, s.name || null, s.logo || null, s.url || null, i]
      );
    }
  }

  if (body.gallery !== undefined) {
    await db.query("DELETE FROM event_gallery WHERE event_id = ?", [eventId]);
    const gallery = Array.isArray(body.gallery) ? body.gallery : [];
    for (let i = 0; i < gallery.length; i++) {
      const g = gallery[i] || {};
      if (!g.image) continue; // an image is the one required field for a gallery row
      await db.query(
        "INSERT INTO event_gallery (event_id, image, caption_en, caption_ar, sort_order) VALUES (?,?,?,?,?)",
        [eventId, g.image, g.captionEn || null, g.captionAr || null, i]
      );
    }
  }
}

/** Generates a unique slug for a new event, using the transactional `db` so
 * the uniqueness check sees this same transaction's own in-flight state.
 * Called before the event row exists (slug is a NOT NULL column being
 * inserted), so there's no real id yet to fall back on -- an event with
 * neither an English nor Arabic title falls back to a timestamp instead. */
async function generateUniqueSlug(db, titleEn, titleAr) {
  const base = slugify(titleEn) || slugify(titleAr) || `event-${Date.now()}`;
  let candidate = base;
  let suffix = 2;
  // Loop bound is generous but finite -- this only runs on create, and a
  // real collision chain this long would mean something else is wrong.
  for (let i = 0; i < 1000; i++) {
    const { rows } = await db.query("SELECT id FROM events WHERE slug = ?", [candidate]);
    if (rows.length === 0) return candidate;
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  // Astronomically unlikely fallback -- guarantees termination either way.
  return `${base}-${Date.now()}`;
}

module.exports = { fetchEventChildren, writeEventChildren, generateUniqueSlug };
