const fs = require("fs");

// multer's fileFilter only ever sees the client-supplied Content-Type
// header for the field, which is trivially spoofable (rename any file,
// set any Content-Type) -- it is not a real security boundary on its own.
// This reads the first bytes actually written to disk and checks them
// against known file-format signatures ("magic bytes"), so a file's
// claimed type has to match what it actually is.
//
// Deliberately NOT an exhaustive validator for every nuance of every
// container format (e.g. telling a .docx apart from a plain .zip requires
// opening the archive and inspecting its internal paths, not just the
// leading bytes) -- the goal is the specific, high-value guarantee that
// something claiming to be a document/image/spreadsheet/etc. is not
// actually an executable or script, which is the exploit this closes.

const SIGNATURES = {
  pdf: [[0x25, 0x50, 0x44, 0x46]], // %PDF
  jpeg: [[0xff, 0xd8, 0xff]],
  png: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  gif: [[0x47, 0x49, 0x46, 0x38]], // GIF8
  // WEBP/WAV are both a RIFF container -- the format tag (WEBP/WAVE) sits
  // at byte offset 8, RIFF itself at offset 0.
  riff: [[0x52, 0x49, 0x46, 0x46]],
  zip: [[0x50, 0x4b, 0x03, 0x04], [0x50, 0x4b, 0x05, 0x06], [0x50, 0x4b, 0x07, 0x08]], // also covers docx/xlsx/pptx (OOXML is a zip container)
  oleLegacyOffice: [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]], // legacy .doc/.xls/.ppt
};

// Signatures that must NEVER be accepted regardless of what the upload
// claims to be -- this is what actually stops a renamed executable.
const DANGEROUS_SIGNATURES = [
  [0x4d, 0x5a], // MZ -- Windows PE (.exe/.dll)
  [0x7f, 0x45, 0x4c, 0x46], // ELF -- Linux binary
  [0x23, 0x21], // #! -- shell/interpreter script
  [0xca, 0xfe, 0xba, 0xbe], // Mach-O (macOS binary, fat)
  [0xfe, 0xed, 0xfa, 0xce], // Mach-O 32-bit
  [0xfe, 0xed, 0xfa, 0xcf], // Mach-O 64-bit
];

function matchesSignature(buf, sig, offset = 0) {
  if (buf.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (buf[offset + i] !== sig[i]) return false;
  }
  return true;
}

function matchesAny(buf, sigs, offset = 0) {
  return sigs.some((sig) => matchesSignature(buf, sig, offset));
}

/** Categories a caller can require the file to actually be. */
const CATEGORY_CHECKS = {
  pdf: (buf) => matchesAny(buf, SIGNATURES.pdf),
  image: (buf) =>
    matchesAny(buf, SIGNATURES.jpeg) ||
    matchesAny(buf, SIGNATURES.png) ||
    matchesAny(buf, SIGNATURES.gif) ||
    (matchesAny(buf, SIGNATURES.riff) && matchesSignature(buf, [0x57, 0x45, 0x42, 0x50], 8)), // RIFF....WEBP
  // Word/Excel/PowerPoint: modern (.docx/.xlsx/.pptx) is a zip container,
  // legacy (.doc/.xls/.ppt) is an OLE compound file. Accept either shape
  // rather than trying to fully parse which specific Office format it is.
  office: (buf) => matchesAny(buf, SIGNATURES.zip) || matchesAny(buf, SIGNATURES.oleLegacyOffice),
  zip: (buf) => matchesAny(buf, SIGNATURES.zip),
  // Audio/video containers vary too much to fingerprint reliably from a
  // short prefix (MP3 in particular often has no fixed header at all) --
  // for these, the dangerous-signature block below is the real defense;
  // this check only rejects the obviously-wrong case of an empty file.
  media: (buf) => buf.length > 16,
};

/**
 * Reads the first 32 bytes actually on disk and confirms they match one of
 * `allowedCategories` (from CATEGORY_CHECKS) and are never a known
 * dangerous signature. Returns { safe: true } or { safe: false, reason }.
 * Synchronous by design -- called once, right after multer finishes
 * writing a single file, before any DB row referencing it is created.
 */
function checkFileContent(filePath, allowedCategories) {
  let buf;
  try {
    const fd = fs.openSync(filePath, "r");
    buf = Buffer.alloc(32);
    fs.readSync(fd, buf, 0, 32, 0);
    fs.closeSync(fd);
  } catch (err) {
    return { safe: false, reason: "Could not read the uploaded file" };
  }

  if (DANGEROUS_SIGNATURES.some((sig) => matchesSignature(buf, sig))) {
    return { safe: false, reason: "This file's content does not match an allowed file type" };
  }

  const categories = Array.isArray(allowedCategories) ? allowedCategories : [allowedCategories];
  const matches = categories.some((cat) => CATEGORY_CHECKS[cat] && CATEGORY_CHECKS[cat](buf));
  if (!matches) {
    return { safe: false, reason: "This file's content does not match an allowed file type" };
  }
  return { safe: true };
}

module.exports = { checkFileContent };
