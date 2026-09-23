// The Library: a standalone Books feature, deliberately separate from the
// existing Learning Materials feature (own router, own section on every
// dashboard) even though it reuses the same `learning_materials` table as
// pure storage (material_type = 'book') and the same upload infrastructure.
// Every authenticated role can read it; only Admin/Master Trainer/ToT can
// add or remove a book -- enforced here, not just by hiding a button.
const express = require("express");
const fs = require("fs");
const path = require("path");
const config = require("../config");
const { pool } = require("../db");
const { requireAuth, requireAdmin, requireAdminPermission, asyncRoute } = require("../middleware/auth");
const { materialUpload } = require("../utils/uploads");
const { optimizeImageIfPossible } = require("../utils/imageOptimize");
const { checkFileContent } = require("../utils/fileTypeCheck");
const { createUploadGuard, hashFile } = require("../utils/uploadGuard");
const { checkAndRecord } = require("../utils/rateLimit");

const router = express.Router();

router.use(requireAuth);

// Library actions have always been open to every Supervisor (Master
// Trainer or ToT) -- migration 025's admin_permissions table only ever
// governs an Admin account's own access, never a Supervisor's, so this
// only enforces anything when the caller's role is 'admin'. A Supervisor
// (or any other role, on the read-only GET) passes through unchanged.
function requireAdminPermissionIfAdmin(code) {
  const gate = requireAdminPermission(code);
  return (req, res, next) => {
    if (req.user.role !== "admin") return next();
    return gate(req, res, next);
  };
}

// The user-facing "Type" dropdown -- a controlled list distinct from the
// existing material_type column (which only distinguishes a Library row
// from an ordinary Material). Mirrors the schema's own chk_resource_type
// CHECK constraint; kept here too so a bad value 400s with a clear message
// instead of surfacing as a raw DB error.
const RESOURCE_TYPES = [
  "book", "article", "research_paper", "academic_paper", "thesis",
  "ebook", "reference", "guide", "report", "other",
];

// A plain controlled list, not a DB table -- same idiom as RESOURCE_TYPES
// above (kept in sync with the frontend's own copy by convention, not by
// a shared source file, since this is a static HTML/JS frontend with no
// build step). Validated server-side so a request that bypasses the
// dropdown can't write an inconsistent value ("Lebanon" vs "lebanon").
const COUNTRIES = require("../utils/countries");

const CURRENT_YEAR = new Date().getFullYear();

// Mirrors each column's actual VARCHAR width in learning_materials so an
// over-length value 400s with a clear message instead of reaching MySQL and
// coming back as an unhandled "Data too long for column" -- discovered via
// security testing (long-input case) surfacing as a raw 500.
const FIELD_LIMITS = {
  title: 255, author: 255, publisher: 255, publicationLocation: 255,
  category: 100, country: 100, doi: 255,
};
const FIELD_LABELS = {
  title: "Title", author: "Author", publisher: "Publisher",
  publicationLocation: "Publication location", category: "Category",
  country: "Country", doi: "DOI",
};

function findTooLongField(body) {
  for (const [field, max] of Object.entries(FIELD_LIMITS)) {
    const value = body[field];
    if (value != null && String(value).trim().length > max) {
      return `${FIELD_LABELS[field]} must be ${max} characters or fewer`;
    }
  }
  return null;
}

// Blocks a double-click/rapid-repeat book upload from the SAME account
// before the second request even starts streaming its file to disk. Its
// own guard instance -- independent from the one routes/supervisor.js
// uses for Materials -- so a book upload and a material upload from the
// same account never block each other.
const { markStarted: markUploadStarted, markFinished: markUploadFinished } = createUploadGuard();

function toBook(row) {
  const createdByRole = row.admin_id ? "Admin" : row.supervisor_type === "primary" ? "Master Trainer" : "ToT";
  const createdByName = row.admin_id ? row.admin_name : row.supervisor_name;
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    description: row.description,
    category: row.category,
    filename: row.filename,
    originalName: row.original_name,
    coverImage: row.cover_image,
    publisher: row.publisher,
    publicationLocation: row.publication_location,
    publicationYear: row.publication_year,
    resourceType: row.resource_type,
    country: row.country,
    doi: row.doi,
    createdByName,
    createdByRole,
    createdAt: row.created_at,
  };
}

// GET /api/library/books -- the one shared list, every role sees the same
// set (books have no per-student/caseload targeting, unlike Materials).
router.get(
  "/books",
  requireAdminPermissionIfAdmin("library.view"),
  asyncRoute(async (req, res, db) => {
    const { rows } = await db.query(
      `SELECT lm.*, adm.full_name AS admin_name, sup.full_name AS supervisor_name, sup.supervisor_type
       FROM learning_materials lm
       LEFT JOIN admin_users adm ON adm.id = lm.admin_id
       LEFT JOIN supervisors sup ON sup.id = lm.supervisor_id
       WHERE lm.material_type = 'book'
       ORDER BY lm.created_at DESC`
    );

    // Fetched once per request, not per row -- an admin's own granted set
    // never differs row to row. A non-admin's canDelete/canEdit never
    // depends on this at all (see the ?? below), so this stays empty for
    // every other role.
    let adminGranted = new Set();
    if (req.user.role === "admin") {
      const { rows: permRows } = await db.query(
        "SELECT permission_code FROM admin_permissions WHERE admin_id = ?",
        [req.user.id]
      );
      adminGranted = new Set(permRows.map((p) => p.permission_code));
    }

    const books = rows.map((r) => ({
      ...toBook(r),
      canDelete:
        (req.user.role === "admin" && adminGranted.has("library.delete")) ||
        (req.user.role === "supervisor" && Number(r.supervisor_id) === Number(req.user.id)),
      canEdit: req.user.role === "admin" && adminGranted.has("library.edit"),
    }));
    res.json({ books });
  })
);

// POST /api/library/books -- Admin, Master Trainer, and ToT only. A Trainee
// (or Designer) calling this directly gets a 403, not just a missing button.
router.post("/books", requireAdminPermissionIfAdmin("library.add"), (req, res) => {
  if (!["admin", "supervisor"].includes(req.user.role)) {
    return res.status(403).json({ error: "You don't have permission to add to the Library" });
  }

  // Stops a double-click/rapid-repeat submission from this account before
  // its file is even streamed to disk -- see markUploadStarted above.
  if (!markUploadStarted(req.user.id)) {
    return res.status(409).json({ error: "Upload already in progress." });
  }

  materialUpload.fields([
    { name: "file", maxCount: 1 },
    { name: "coverImage", maxCount: 1 },
  ])(req, res, async (err) => {
    if (err) {
      markUploadFinished(req.user.id);
      return res.status(400).json({ error: err.message });
    }

    const file = req.files && req.files.file && req.files.file[0];
    const cover = req.files && req.files.coverImage && req.files.coverImage[0];
    const fail = (status, error) => {
      if (file) fs.unlink(file.path, () => {});
      if (cover) fs.unlink(cover.path, () => {});
      markUploadFinished(req.user.id);
      return res.status(status).json({ error });
    };
    try {
      const { title, author, description, category, publisher, publicationLocation, resourceType, country, doi } = req.body || {};
      if (!title || !title.trim()) return fail(400, "Title is required");
      if (!author || !author.trim()) return fail(400, "Author is required");
      if (!resourceType || !RESOURCE_TYPES.includes(resourceType)) {
        return fail(400, `Type is required and must be one of: ${RESOURCE_TYPES.join(", ")}`);
      }
      if (country && !COUNTRIES.includes(country)) {
        return fail(400, "Country must be chosen from the provided list");
      }
      const tooLong = findTooLongField(req.body || {});
      if (tooLong) return fail(400, tooLong);
      if (!file) return fail(400, "A book file is required");

      let publicationYear = null;
      if (req.body.publicationYear != null && req.body.publicationYear !== "") {
        publicationYear = Number(req.body.publicationYear);
        if (!Number.isInteger(publicationYear) || publicationYear < 1000 || publicationYear > CURRENT_YEAR + 1) {
          return fail(400, `Publication year must be a whole number between 1000 and ${CURRENT_YEAR + 1}`);
        }
      }

      const check = checkFileContent(file.path, ["pdf", "office", "image", "media"]);
      if (!check.safe) return fail(400, check.reason);
      if (cover) {
        const coverCheck = checkFileContent(cover.path, ["image"]);
        if (!coverCheck.safe) return fail(400, "Cover image: " + coverCheck.reason);
        await optimizeImageIfPossible(cover.path, { maxDimension: 800 });
      }
      await optimizeImageIfPossible(file.path, { maxDimension: 1920 });

      // Same book already in the Library, by content -- not filename, so a
      // rename can't defeat this and two different files that happen to
      // share a filename are correctly NOT flagged. Checked globally
      // (across every uploader), scoped to material_type='book' -- the
      // whole point of a shared Library is one entry per real book.
      const fileHash = await hashFile(file.path);
      const { rows: existingRows } = await pool.query(
        "SELECT id FROM learning_materials WHERE material_type = 'book' AND file_hash = ?",
        [fileHash]
      );
      if (existingRows.length) return fail(409, "This book already exists in the Library.");

      // Creator comes ONLY from the authenticated session -- never a
      // client-supplied field.
      let supervisorId = null;
      let adminId = null;
      let createdByName;
      let createdByRole;
      if (req.user.role === "admin") {
        const { rows } = await pool.query("SELECT full_name FROM admin_users WHERE id = ?", [req.user.id]);
        adminId = req.user.id;
        createdByName = (rows[0] && rows[0].full_name) || req.user.member_code;
        createdByRole = "Admin";
      } else {
        const { rows } = await pool.query("SELECT full_name, supervisor_type FROM supervisors WHERE id = ?", [req.user.id]);
        supervisorId = req.user.id;
        createdByName = (rows[0] && rows[0].full_name) || req.user.member_code;
        createdByRole = rows[0] && rows[0].supervisor_type === "primary" ? "Master Trainer" : "ToT";
      }

      const insert = await pool.query(
        `INSERT INTO learning_materials
           (supervisor_id, admin_id, student_id, title, author, description, category, material_type, filename, original_name, cover_image, publisher, publication_location, publication_year, resource_type, file_hash, country, doi)
         VALUES (?,?,NULL,?,?,?,?,'book',?,?,?,?,?,?,?,?,?,?)`,
        [
          supervisorId, adminId, title.trim(), author.trim(), description || null, category || null,
          file.filename, file.originalname, cover ? cover.filename : null,
          publisher || null, publicationLocation ? String(publicationLocation).trim() : null, publicationYear, resourceType, fileHash,
          country || null, doi ? doi.trim() : null,
        ]
      );
      await pool.query(
        "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES (?, 'book added', 'learning_materials', ?)",
        [req.user.id, insert.insertId]
      );
      markUploadFinished(req.user.id);

      res.status(201).json({
        id: insert.insertId,
        title: title.trim(),
        author: author.trim(),
        description: description || null,
        category: category || null,
        publisher: publisher || null,
        publicationLocation: publicationLocation ? String(publicationLocation).trim() : null,
        publicationYear,
        resourceType,
        country: country || null,
        doi: doi ? doi.trim() : null,
        filename: file.filename,
        originalName: file.originalname,
        coverImage: cover ? cover.filename : null,
        createdByName,
        createdByRole,
        createdAt: new Date().toISOString(),
        canDelete: true,
      });
    } catch (e) {
      if (file) fs.unlink(file.path, () => {});
      if (cover) fs.unlink(cover.path, () => {});
      markUploadFinished(req.user.id);
      // The SELECT-then-INSERT duplicate check above (line ~144) has a real
      // race window: two different accounts uploading the identical file
      // within that window can both pass the SELECT before either commits.
      // uniq_materials_book_hash (migration 022's generated column) is what
      // actually prevents the duplicate row in that case -- this turns that
      // DB-level rejection into the same friendly 409 the common case
      // already returns, instead of falling through to a confusing 500.
      // Confirmed reproducible: tested this exact race directly against
      // the DB before adding this catch.
      if (e.code === "ER_DUP_ENTRY") {
        return res.status(409).json({ error: "This book already exists in the Library." });
      }
      console.error("[library] failed to add book:", e);
      res.status(500).json({ error: "Internal server error" });
    }
  });
});

// DELETE /api/library/books/:id -- Admin can remove any book; a Supervisor
// (Master Trainer or ToT) only one they added themselves. Trainee/Designer
// always 403 (role check never even reaches the ownership check).
router.delete(
  "/books/:id",
  requireAdminPermissionIfAdmin("library.delete"),
  asyncRoute(async (req, res, db) => {
    const { rows } = await db.query("SELECT * FROM learning_materials WHERE id = ? AND material_type = 'book'", [req.params.id]);
    const book = rows[0];
    if (!book) return res.status(404).json({ error: "Book not found" });

    const isOwner = req.user.role === "admin" || (req.user.role === "supervisor" && Number(book.supervisor_id) === Number(req.user.id));
    if (!isOwner) return res.status(403).json({ error: "You can only remove a book you added" });

    await db.query("DELETE FROM learning_materials WHERE id = ?", [req.params.id]);
    for (const field of ["filename", "cover_image"]) {
      if (book[field]) {
        const filePath = path.join(config.uploadsDir, "materials", book[field]);
        fs.unlink(filePath, (err) => {
          if (err && err.code !== "ENOENT") console.error("Failed to delete library file:", err);
        });
      }
    }
    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, old_values) VALUES (?, 'book deleted', 'learning_materials', ?, ?)",
      [req.user.id, req.params.id, JSON.stringify(book)]
    );
    res.json({ success: true });
  })
);

// PUT /api/library/books/:id -- metadata-only edit (no re-upload; the file/
// cover themselves are unchanged, same as there's never been a way to
// replace them without deleting and re-adding). Admin only, gated on
// library.edit -- Supervisors have never had an edit capability here and
// this doesn't add one; deleting and re-adding remains their only path,
// exactly as before.
router.put(
  "/books/:id",
  requireAdmin,
  requireAdminPermission("library.edit"),
  asyncRoute(async (req, res, db) => {
    const { rows } = await db.query("SELECT id FROM learning_materials WHERE id = ? AND material_type = 'book'", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Book not found" });

    const { title, author, description, category, publisher, publicationLocation, resourceType, country, doi } = req.body || {};
    if (!title || !String(title).trim()) return res.status(400).json({ error: "Title is required" });
    if (!author || !String(author).trim()) return res.status(400).json({ error: "Author is required" });
    if (!resourceType || !RESOURCE_TYPES.includes(resourceType)) {
      return res.status(400).json({ error: `Type is required and must be one of: ${RESOURCE_TYPES.join(", ")}` });
    }
    if (country && !COUNTRIES.includes(country)) {
      return res.status(400).json({ error: "Country must be chosen from the provided list" });
    }
    const tooLong = findTooLongField(req.body || {});
    if (tooLong) return res.status(400).json({ error: tooLong });
    let publicationYear = null;
    if (req.body.publicationYear != null && req.body.publicationYear !== "") {
      publicationYear = Number(req.body.publicationYear);
      if (!Number.isInteger(publicationYear) || publicationYear < 1000 || publicationYear > CURRENT_YEAR + 1) {
        return res.status(400).json({ error: `Publication year must be a whole number between 1000 and ${CURRENT_YEAR + 1}` });
      }
    }

    await db.query(
      `UPDATE learning_materials SET
         title = ?, author = ?, description = ?, category = ?, publisher = ?, publication_location = ?, publication_year = ?,
         resource_type = ?, country = ?, doi = ?
       WHERE id = ?`,
      [
        title.trim(), author.trim(), description || null, category || null, publisher || null,
        publicationLocation ? String(publicationLocation).trim() : null, publicationYear,
        resourceType, country || null, doi ? doi.trim() : null,
        req.params.id,
      ]
    );
    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES (?, 'book edited', 'learning_materials', ?)",
      [req.user.id, req.params.id]
    );

    const { rows: updated } = await db.query(
      `SELECT lm.*, adm.full_name AS admin_name, sup.full_name AS supervisor_name, sup.supervisor_type
       FROM learning_materials lm
       LEFT JOIN admin_users adm ON adm.id = lm.admin_id
       LEFT JOIN supervisors sup ON sup.id = lm.supervisor_id
       WHERE lm.id = ?`,
      [req.params.id]
    );
    res.json({ ...toBook(updated[0]), canDelete: true });
  })
);

// GET /api/library/online-search?doi= -- optional lookup an Admin or
// Supervisor can use while filling the Add Book form; never writes
// anything itself (see POST /books, still the only way a book actually
// gets saved) -- purely fetches candidate metadata for the caller to
// review and edit before submitting.
//
// This used to look ISBN up via Open Library. Now that the Library's only
// identifier is DOI, it looks the DOI up via Crossref's free, keyless
// metadata API (api.crossref.org/works/<doi> -- verified directly against
// the live API, including a real 404 for an unknown DOI, before wiring this
// in) -- Crossref is the actual DOI registration agency's own public
// lookup, i.e. the correct provider for a DOI, not a repurposed ISBN
// catalog. Crossref's records (mostly journal articles/papers/theses) have
// no "place published" concept the way a physical book does, so
// publicationLocation is deliberately left unmapped here -- never guessed
// -- exactly like Open Library's own lookup left country unmapped for the
// same reason. Crossref also has no cover-image field, so coverImageUrl is
// always null here (never faked).
router.get(
  "/online-search",
  (req, res, next) => {
    if (!["admin", "supervisor"].includes(req.user.role)) {
      return res.status(403).json({ error: "You don't have permission to use Library search" });
    }
    next();
  },
  requireAdminPermissionIfAdmin("library.add"),
  asyncRoute(async (req, res) => {
    const doi = (req.query.doi || "").trim();
    if (!doi) return res.status(400).json({ error: "A valid DOI is required" });

    // Every call here forwards straight to Crossref, an external API this
    // app doesn't control -- with nothing capping it, one account (or a
    // leaked token) hammering this route fast enough could get this
    // server's own IP rate-limited or blocked by Crossref, breaking the
    // lookup for every user, not just the caller. Keyed by account, not IP
    // -- a shared office network legitimately has several people using
    // this at once.
    const rate = checkAndRecord(`library-online-search:${req.user.id}`, { max: 20, windowMs: 60 * 1000 });
    if (rate.blocked) {
      return res.status(429).json({ error: `Too many lookups -- try again in ${rate.retryAfterSeconds}s.` });
    }

    let work;
    try {
      const upstream = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (upstream.status === 404) return res.status(404).json({ error: "No record found for that DOI" });
      if (!upstream.ok) throw new Error(`Crossref responded ${upstream.status}`);
      const body = await upstream.json();
      work = body.message;
    } catch (err) {
      console.error("[library] online search failed:", err.message);
      return res.status(502).json({ error: "Couldn't reach the online catalog. You can still enter details manually." });
    }

    const author = Array.isArray(work.author) && work.author.length
      ? work.author.map((a) => [a.given, a.family].filter(Boolean).join(" ")).filter(Boolean).join(", ") || null
      : null;
    const dateParts = (work["published-print"] || work["published-online"] || work.created || {})["date-parts"];
    const publicationYear = Array.isArray(dateParts) && Array.isArray(dateParts[0]) ? dateParts[0][0] || null : null;
    // Crossref abstracts (when present at all) come wrapped in JATS XML
    // tags (e.g. "<jats:p>...</jats:p>") -- stripped to plain text rather
    // than dumping raw markup into the Description field.
    const description = typeof work.abstract === "string" ? work.abstract.replace(/<[^>]+>/g, "").trim() || null : null;

    res.json({
      title: (Array.isArray(work.title) && work.title[0]) || null,
      author,
      publisher: work.publisher || null,
      publicationLocation: null,
      publicationYear,
      description,
      coverImageUrl: null,
      doi,
    });
  })
);

module.exports = router;
