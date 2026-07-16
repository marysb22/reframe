const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const config = require("../config");

const photosDir = path.join(config.uploadsDir, "photos");
const cvDir = path.join(config.uploadsDir, "cv");
const documentsDir = path.join(config.uploadsDir, "documents");
const materialsDir = path.join(config.uploadsDir, "materials");
const eventsDir = path.join(config.uploadsDir, "events");
fs.mkdirSync(photosDir, { recursive: true });
fs.mkdirSync(cvDir, { recursive: true });
fs.mkdirSync(documentsDir, { recursive: true });
fs.mkdirSync(materialsDir, { recursive: true });
fs.mkdirSync(eventsDir, { recursive: true });

function safeFilename(originalName) {
  const ext = path.extname(originalName).toLowerCase();
  const random = crypto.randomBytes(16).toString("hex");
  return `${random}${ext}`;
}

const photoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, photosDir),
    filename: (req, file, cb) => cb(null, safeFilename(file.originalname)),
  }),
  limits: { fileSize: config.maxUploadMB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Only JPEG, PNG, WEBP, or GIF images are allowed"));
    }
    cb(null, true);
  },
});

const cvUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, cvDir),
    filename: (req, file, cb) => cb(null, safeFilename(file.originalname)),
  }),
  limits: { fileSize: config.maxUploadMB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== "application/pdf") {
      return cb(new Error("CV must be a PDF file"));
    }
    cb(null, true);
  },
});

// Used by supervisors to attach feedback forms, evaluation sheets, etc. to
// a specific student. Wider file-type allowance than the CV upload since
// supervisors may need to share images, PDFs, or Office documents.
const documentUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, documentsDir),
    filename: (req, file, cb) => cb(null, safeFilename(file.originalname)),
  }),
  limits: { fileSize: config.maxUploadMB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "image/jpeg",
      "image/png",
      "image/webp",
    ];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Only PDF, Word, or image files are allowed"));
    }
    cb(null, true);
  },
});

// Learning materials can be documents, images, video, or audio -- a wider
// allowance than the per-student document upload, since supervisors share
// full lesson resources here.
const materialUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, materialsDir),
    filename: (req, file, cb) => cb(null, safeFilename(file.originalname)),
  }),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "image/jpeg",
      "image/png",
      "image/webp",
      "video/mp4",
      "video/webm",
      "video/quicktime",
      "audio/mpeg",
      "audio/wav",
      "audio/ogg",
    ];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("That file type isn't supported"));
    }
    cb(null, true);
  },
});

// Cover photos for public events (admin-only upload)
const eventImageUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, eventsDir),
    filename: (req, file, cb) => cb(null, safeFilename(file.originalname)),
  }),
  limits: { fileSize: config.maxUploadMB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Only JPEG, PNG, WEBP, or GIF images are allowed"));
    }
    cb(null, true);
  },
});

module.exports = {
  photoUpload, cvUpload, documentUpload, materialUpload, eventImageUpload,
  photosDir, cvDir, documentsDir, materialsDir, eventsDir,
};