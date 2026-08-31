const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const config = require("../config");
const { checkFileContent } = require("./fileTypeCheck");

/**
 * Express middleware factory: run AFTER a multer upload middleware in the
 * same route (so `req.file`/`req.files` already point at bytes actually on
 * disk), BEFORE the route's own handler. multer's own fileFilter only ever
 * sees the client-supplied Content-Type header, which is trivially
 * spoofable -- this reads the real file and rejects anything whose content
 * doesn't match one of `categories` (see fileTypeCheck.js), deleting the
 * now-rejected file rather than leaving it on disk with no DB row pointing
 * at it. A route with an optional attachment (no req.file) is a no-op.
 */
function requireValidFileContent(categories) {
  return (req, res, next) => {
    const files = req.file ? [req.file] : Array.isArray(req.files) ? req.files : [];
    for (const file of files) {
      const result = checkFileContent(file.path, categories);
      if (!result.safe) {
        fs.unlink(file.path, () => {});
        return res.status(400).json({ error: result.reason });
      }
    }
    next();
  };
}

// multer's diskStorage never creates its destination folder -- it just
// fails the upload with ENOENT if it doesn't already exist. That bit
// `uploads/submissions` in production (the folder was never created, so
// every trainee assignment submission was silently erroring even though
// the route logic itself was correct) until this was caught by live
// end-to-end testing rather than by reading the code. Every disk-storage
// destination below now creates its folder on first use instead of
// assuming someone remembered to `mkdir` it by hand.
function ensureUploadDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const eventImageStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, ensureUploadDir(path.join(config.uploadsDir, "events"))),
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
    destination: (req, file, cb) => cb(null, ensureUploadDir(path.join(config.uploadsDir, subfolder))),
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

// Assignment attachments: the instructions/template a Trainer (ToT) attaches
// when creating an assignment -- same allowed types as a submission, since
// it's the same "instructions/reference document" use case in reverse.
const assignmentAttachmentUpload = multer({
  storage: makeDiskStorage("assignments"),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_DOCUMENT_TYPES.has(file.mimetype)) {
      return cb(new Error("Only PDF, Word, or image files are allowed"));
    }
    cb(null, true);
  },
});

// Group chat attachments: broader than a plain document (adds Excel/
// PowerPoint/ZIP per the Group Chats feature's requirements) but capped
// lower than learning materials, since chat isn't meant for large media.
const ALLOWED_CHAT_ATTACHMENT_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/zip",
  "application/x-zip-compressed",
]);
const chatAttachmentUpload = multer({
  storage: makeDiskStorage("chat"),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_CHAT_ATTACHMENT_TYPES.has(file.mimetype)) {
      return cb(new Error("That file type isn't supported in chat"));
    }
    cb(null, true);
  },
});

module.exports = {
  eventImageUpload,
  photoUpload,
  cvUpload,
  documentUpload,
  materialUpload,
  submissionUpload,
  assignmentAttachmentUpload,
  chatAttachmentUpload,
  requireValidFileContent,
  // Ready-made per-upload-type content checks, matching each config's own
  // fileFilter allowed-type list above -- insert right after the matching
  // upload middleware in every route that accepts a file.
  checkEventImageContent: requireValidFileContent(["image"]),
  checkPhotoContent: requireValidFileContent(["image"]),
  checkCvContent: requireValidFileContent(["pdf"]),
  checkDocumentContent: requireValidFileContent(["pdf", "office", "image"]),
  checkMaterialContent: requireValidFileContent(["pdf", "office", "image", "media"]),
  checkSubmissionContent: requireValidFileContent(["pdf", "office", "image"]),
  checkAssignmentAttachmentContent: requireValidFileContent(["pdf", "office", "image"]),
  checkChatAttachmentContent: requireValidFileContent(["pdf", "office", "image", "zip"]),
};