const express = require("express");
const cors = require("cors");
const path = require("path");
const config = require("./config");

const app = express();

// Without this, every browser-based page (login.html, the dashboards,
// anything served from a different origin than the API itself -- e.g.
// a Live Server on 127.0.0.1:5500 calling an API on localhost:3000)
// gets silently blocked by the browser before the request even leaves,
// surfacing as a generic "could not reach the server" error. Tools like
// curl/Invoke-RestMethod/node-fetch aren't subject to CORS at all, which
// is why this gap didn't show up until an actual browser hit the API.
// Bearer-token auth (no cookies) means an open origin policy carries the
// usual CORS risk profile, not a cookie-CSRF one -- still, tighten
// `origin` to your real frontend's exact URL before deploying anywhere
// public.
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

app.use(express.json());

// Temporary debug logging -- prints every incoming request to the
// terminal so it's obvious whether the browser's request is even
// reaching the server at all, vs. being blocked client-side (CORS, a
// JS error before the fetch call, wrong URL, etc.). Safe to remove
// later once things are confirmed working.
app.use((req, res, next) => {
  const start = Date.now();
  console.log(`[${new Date().toISOString()}] --> ${req.method} ${req.originalUrl}`);
  res.on("finish", () => {
    console.log(
      `[${new Date().toISOString()}] <-- ${req.method} ${req.originalUrl} : ${res.statusCode} (${Date.now() - start}ms)`
    );
  });
  next();
});

app.use("/uploads", express.static(path.join(__dirname, "../uploads")));
app.use(express.static(path.join(__dirname, "../public")));

app.use("/api/auth", require("./routes/auth"));
app.use("/api/admin", require("./routes/admin"));
app.use("/api/profile", require("./routes/profile"));
app.use("/api/supervisor", require("./routes/supervisor"));
app.use("/api/designer", require("./routes/designer"));
app.use("/api", require("./routes/public"));

app.get("/api/health", (req, res) => res.json({ ok: true }));

// TEMPORARY -- one-off setup endpoint to create/fix the DES001 designer
// test account directly through the app's own DB connection, since
// phpMyAdmin access wasn't working out. Guarded by a secret query param
// so it isn't trivially discoverable. REMOVE after use.
app.get("/api/_tmp_setup_designer", async (req, res) => {
  if (req.query.key !== "reframe-tmp-2026-setup") {
    return res.status(404).json({ error: "Not found" });
  }
  try {
    const { pool } = require("./db");
    const bcrypt = require("bcryptjs");
    const memberCode = "DES001";
    const password = "Designer2026Temp";
    const passwordHash = await bcrypt.hash(password, 12);

    const { rows: existing } = await pool.query(
      "SELECT id FROM user_credentials WHERE member_code = ?",
      [memberCode]
    );

    let userId;
    if (existing.length > 0) {
      userId = existing[0].id;
      await pool.query(
        "UPDATE user_credentials SET password_hash = ?, role = 'designer', status = 'active', must_change_password = TRUE WHERE id = ?",
        [passwordHash, userId]
      );
    } else {
      const { rows: maxRows } = await pool.query(
        "SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM user_credentials"
      );
      userId = maxRows[0].next_id;
      await pool.query(
        "INSERT INTO user_credentials (id, member_code, password_hash, role, status, must_change_password) VALUES (?, ?, ?, 'designer', 'active', TRUE)",
        [userId, memberCode, passwordHash]
      );
    }

    const { rows: designerRow } = await pool.query(
      "SELECT id FROM designers WHERE id = ?",
      [userId]
    );
    if (designerRow.length === 0) {
      await pool.query(
        "INSERT INTO designers (id, full_name, email) VALUES (?, 'Test Designer', 'designer@reframe-mhs.org')",
        [userId]
      );
    }

    res.json({ ok: true, userId, memberCode, password, note: "Log in with these credentials, then remove this endpoint." });
  } catch (err) {
    console.error("tmp_setup_designer failed:", err);
    res.status(500).json({ error: err.message, code: err.code });
  }
});

// Centralized error handler -- every asyncRoute() failure lands here.
// Full error detail (including raw DB errors) is logged server-side only;
// the client gets a generic message. Returning err.message to the client
// is a real information-disclosure risk (DB structure, internal paths,
// query text can leak through driver error messages) and was only ever
// meant to be a temporary local-debugging aid -- removed before this is
// anywhere near a real deployment.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(config.port, () => {
  console.log(`API listening on :${config.port}`);
});