// { quiet: true } suppresses dotenv's console output on every boot --
// as of dotenv 17.x that output includes a rotating promotional "tip"
// line pointing at an unrelated third-party service, which has no
// business appearing in a real server's logs.
require("dotenv").config({ quiet: true });

module.exports = {
    port: process.env.PORT || 3000,
    jwtSecret: process.env.JWT_SECRET || "dev-only-secret-change-me",
    jwtExpiresIn: "12h",
    corsOrigins: (process.env.CORS_ORIGIN || "http://localhost:5500,http://127.0.0.1:5500")
        .split(",").map((s) => s.trim()).filter(Boolean),
    db: {
        connectionString: process.env.DATABASE_URL || "postgres://localhost:5432/reframe_dev",
    },
};