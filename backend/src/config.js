// { quiet: true } suppresses dotenv's console output on every boot --
// as of dotenv 17.x that output includes a rotating promotional "tip"
// line pointing at an unrelated third-party service, which has no
// business appearing in a real server's logs.
require("dotenv").config({ quiet: true });

module.exports = {
  port: process.env.PORT || 3000,
  jwtSecret: process.env.JWT_SECRET || "dev-only-secret-change-me",
  jwtExpiresIn: "12h",
  db: {
    connectionString: process.env.DATABASE_URL || "mysql://localhost:3306/reframe_dev",
  },
};
