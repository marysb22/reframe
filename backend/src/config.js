// { quiet: true } suppresses dotenv's console output on every boot --
// as of dotenv 17.x that output includes a rotating promotional "tip"
// line pointing at an unrelated third-party service, which has no
// business appearing in a real server's logs.
require("dotenv").config({ quiet: true });
const path = require("path");

// No fallback for JWT_SECRET -- this file is committed to the repo (it's
// source code, not a local secret), so any hardcoded fallback string here
// is exactly as public as the repo itself. A silent fallback would mean a
// misconfigured deployment (JWT_SECRET missing from its real environment --
// a redeploy, a host migration, a typo'd variable name) doesn't fail to
// start; it starts fine and quietly signs every session with a secret
// anyone can read straight off GitHub, letting them forge a valid token for
// any account, admin included, with no further access needed. Failing
// loudly on boot is the correct behavior here -- an environment that's
// missing this is not safe to serve traffic from, and should say so instead
// of appearing to work.
if (!process.env.JWT_SECRET) {
  throw new Error(
    "JWT_SECRET is not set. Set it in this environment's real configuration (not this file) before starting the server -- a fallback here would be exactly as public as the repo itself."
  );
}

module.exports = {
  port: process.env.PORT || 3000,
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: "12h",
  db: {
    connectionString: process.env.DATABASE_URL || "mysql://localhost:3306/reframe_dev",
  },
  // Overridable so a hosting platform with an ephemeral filesystem (e.g.
  // Railway without a mounted Volume) can point this at a persistent
  // mount instead -- without this, every redeploy silently wipes every
  // uploaded photo/CV/document/material/assignment file while the
  // database rows referencing them survive, leaving broken links. Set
  // UPLOADS_DIR to the same path a persistent Volume is mounted at.
  uploadsDir: process.env.UPLOADS_DIR || path.join(__dirname, "../uploads"),
  // Learning materials (and Library books, which share the same upload
  // pipeline) are streamed straight to disk, never buffered in memory, so
  // this cap exists only to keep obviously-wrong uploads and disk usage in
  // check -- not because large files are unsafe to handle. 2GB comfortably
  // covers real multi-hour training videos; raise via env if a hosting
  // platform's own request-size limit ever needs to match a different
  // number (that outer limit, if any, lives outside this repo).
  materialUploadMaxMb: Number(process.env.MATERIAL_UPLOAD_MAX_MB) || 2048,
};
