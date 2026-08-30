// { quiet: true } suppresses dotenv's console output on every boot --
// as of dotenv 17.x that output includes a rotating promotional "tip"
// line pointing at an unrelated third-party service, which has no
// business appearing in a real server's logs.
require("dotenv").config({ quiet: true });
const path = require("path");

module.exports = {
  port: process.env.PORT || 3000,
  jwtSecret: process.env.JWT_SECRET || "dev-only-secret-change-me",
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
};
