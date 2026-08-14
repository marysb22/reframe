require("dotenv").config();
const path = require("path");

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

module.exports = {
  port: Number(process.env.PORT || 3000),
  jwtSecret: required("JWT_SECRET"),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "8h",
  idPrefix: process.env.ID_PREFIX || "TTR",
  idPadLength: Number(process.env.ID_PAD_LENGTH || 3),
  dbFile: path.resolve(process.cwd(), process.env.DB_FILE || "./db/reframe.sqlite"),
  corsOrigins: (process.env.CORS_ORIGIN || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  uploadsDir: path.resolve(process.cwd(), "uploads"),
  maxUploadMB: 10,
};
