const multer = require("multer");
const path = require("path");
const crypto = require("crypto");

const eventImageStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, "../../uploads/events")),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${ext}`);
  },
});

const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

const eventImageUpload = multer({
  storage: eventImageStorage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
      return cb(new Error("Only JPEG, PNG, WEBP, or GIF images are allowed"));
    }
    cb(null, true);
  },
});

function makeDiskStorage(subfolder) {
  return multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, "../../uploads", subfolder)),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${ext}`);
    },
  });
}

const photoUpload = multer({
  storage: makeDiskStorage("photos"),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
      return cb(new Error("Only JPEG, PNG, WEBP, or GIF images are allowed"));
    }
    cb(null, true);
  },
});

const ALLOWED_CV_TYPES = new Set(["application/pdf"]);
const cvUpload = multer({
  storage: makeDiskStorage("cv"),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_CV_TYPES.has(file.mimetype)) {
      return cb(new Error("CV must be a PDF"));
    }
    cb(null, true);
  },
});

// Documents: supervisor -> one specific student (PDF, Word, or image)
const ALLOWED_DOCUMENT_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/jpeg",
  "image/png",
]);
const documentUpload = multer({
  storage: makeDiskStorage("documents"),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_DOCUMENT_TYPES.has(file.mimetype)) {
      return cb(new Error("Only PDF, Word, or image files are allowed"));
    }
    cb(null, true);
  },
});

// Learning materials: broader set (PDF/Word/PPT/images/video/audio) per the
// Supervisor Dashboard requirements doc.
const ALLOWED_MATERIAL_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "audio/mpeg",
  "audio/wav",
]);
const materialUpload = multer({
  storage: makeDiskStorage("materials"),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB (video/audio need headroom)
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MATERIAL_TYPES.has(file.mimetype)) {
      return cb(new Error("File type not allowed for learning materials"));
    }
    cb(null, true);
  },
});

const submissionUpload = multer({
  storage: makeDiskStorage("submissions"),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_DOCUMENT_TYPES.has(file.mimetype)) {
      return cb(new Error("Only PDF, Word, or image files are allowed"));
    }
    cb(null, true);
  },
});

module.exports = { eventImageUpload, photoUpload, cvUpload, documentUpload, materialUpload, submissionUpload };