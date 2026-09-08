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
const { requireAuth, asyncRoute } = require("../middleware/auth");
const { materialUpload } = require("../utils/uploads");
const { optimizeImageIfPossible } = require("../utils/imageOptimize");
const { checkFileContent } = require("../utils/fileTypeCheck");

const router = express.Router();

router.use(requireAuth);

// The user-facing "Type" dropdown -- a controlled list distinct from the
// existing material_type column (which only distinguishes a Library row
// from an ordinary Material). Mirrors the schema's own chk_resource_type
// CHECK constraint; kept here too so a bad value 400s with a clear message
// instead of surfacing as a raw DB error.
const RESOURCE_TYPES = [
  "book", "article", "research_paper", "academic_paper", "thesis",
  "ebook", "reference", "guide", "report", "other",
];

const CURRENT_YEAR = new Date().getFullYear();

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
    publicationYear: row.publication_year,
    resourceType: row.resource_type,
    createdByName,
    createdByRole,
    createdAt: row.created_at,
  };
}

// GET /api/library/books -- the one shared list, every role sees the same
// set (books have no per-student/caseload targeting, unlike Materials).
router.get(
  "/books",
  asyncRoute(async (req, res, db) => {
    const { rows } = await db.query(
      `SELECT lm.*, adm.full_name AS admin_name, sup.full_name AS supervisor_name, sup.supervisor_type
       FROM learning_materials lm
       LEFT JOIN admin_users adm ON adm.id = lm.admin_id
       LEFT JOIN supervisors sup ON sup.id = lm.supervisor_id
       WHERE lm.material_type = 'book'
       ORDER BY lm.created_at DESC`
    );
    const books = rows.map((r) => ({
      ...toBook(r),
      canDelete: req.user.role === "admin" || (req.user.role === "supervisor" && Number(r.supervisor_id) === Number(req.user.id)),
    }));
    res.json({ books });
  })
);

// POST /api/library/books -- Admin, Master Trainer, and ToT only. A Trainee
// (or Designer) calling this directly gets a 403, not just a missing button.
router.post("/books", (req, res) => {
  if (!["admin", "supervisor"].includes(req.user.role)) {
    return res.status(403).json({ error: "You don't have permission to add to the Library" });
  }

  materialUpload.fields([
    { name: "file", maxCount: 1 },
    { name: "coverImage", maxCount: 1 },
  ])(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });

    const file = req.files && req.files.file && req.files.file[0];
    const cover = req.files && req.files.coverImage && req.files.coverImage[0];
    const fail = (status, error) => {
      if (file) fs.unlink(file.path, () => {});
      if (cover) fs.unlink(cover.path, () => {});
      return res.status(status).json({ error });
    };
    try {
      const { title, author, description, category, publisher, resourceType } = req.body || {};
      if (!title || !title.trim()) return fail(400, "Title is required");
      if (!author || !author.trim()) return fail(400, "Author is required");
      if (!resourceType || !RESOURCE_TYPES.includes(resourceType)) {
        return fail(400, `Type is required and must be one of: ${RESOURCE_TYPES.join(", ")}`);
      }
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
           (supervisor_id, admin_id, student_id, title, author, description, category, material_type, filename, original_name, cover_image, publisher, publication_year, resource_type)
         VALUES (?,?,NULL,?,?,?,?,'book',?,?,?,?,?,?)`,
        [
          supervisorId, adminId, title.trim(), author.trim(), description || null, category || null,
          file.filename, file.originalname, cover ? cover.filename : null,
          publisher || null, publicationYear, resourceType,
        ]
      );
      await pool.query(
        "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES (?, 'book added', 'learning_materials', ?)",
        [req.user.id, insert.insertId]
      );

      res.status(201).json({
        id: insert.insertId,
        title: title.trim(),
        author: author.trim(),
        description: description || null,
        category: category || null,
        publisher: publisher || null,
        publicationYear,
        resourceType,
        filename: file.filename,
        originalName: file.originalname,
        coverImage: cover ? cover.filename : null,
        createdByName,
        createdByRole,
        createdAt: new Date().toISOString(),
        canDelete: true,
      });
    } catch (e) {
      console.error("[library] failed to add book:", e);
      if (file) fs.unlink(file.path, () => {});
      if (cover) fs.unlink(cover.path, () => {});
      res.status(500).json({ error: "Internal server error" });
    }
  });
});

// DELETE /api/library/books/:id -- Admin can remove any book; a Supervisor
// (Master Trainer or ToT) only one they added themselves. Trainee/Designer
// always 403 (role check never even reaches the ownership check).
router.delete(
  "/books/:id",
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

module.exports = router;
