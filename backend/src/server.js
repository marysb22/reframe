const express = require("express");
const cors = require("cors");
const path = require("path");
const http = require("http");
const config = require("./config");

// Without these, any error that escapes a promise chain anywhere in the
// app (not just email -- any future fire-and-forget async work) crashes
// the entire Node process and drops every other in-flight user's request,
// then relies on the host restarting it. Concretely hit this with a DNS
// failure while sending a notification email: the process died and
// restarted mid-request for everyone else on the server at that moment.
// Logging and continuing is strictly safer than crashing for a background
// task's failure -- a request that's already been answered (e.g. the
// assignment was already created and its HTTP response already sent)
// must never be retroactively undone by an unrelated background error.
process.on("unhandledRejection", (reason) => {
  console.error("[process] Unhandled promise rejection (server kept running):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[process] Uncaught exception (server kept running):", err);
});

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

app.use("/uploads", express.static(config.uploadsDir));
app.use(express.static(path.join(__dirname, "../public")));

app.use("/api/auth", require("./routes/auth"));
app.use("/api/admin", require("./routes/admin"));
app.use("/api/profile", require("./routes/profile"));
app.use("/api/supervisor", require("./routes/supervisor"));
app.use("/api/master-trainer", require("./routes/Mastertrainer"));
app.use("/api/designer", require("./routes/designer"));
app.use("/api/chat-rooms", require("./routes/chatRooms"));
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

// TEMPORARY -- runs the events.slug backfill (see
// backend/scripts/backfill-event-slugs.js and
// database/migrations/001_event_sections.sql) through the app's own DB
// connection, same reasoning as _tmp_setup_designer above: this app has no
// SSH/terminal access on Hostinger to just run a Node script directly.
// Only usable AFTER migration 001's STEP 1-2 have added the nullable `slug`
// column. REMOVE after use.
app.get("/api/_tmp_backfill_slugs", async (req, res) => {
  if (req.query.key !== "reframe-tmp-2026-setup") {
    return res.status(404).json({ error: "Not found" });
  }
  try {
    const { pool } = require("./db");
    const { slugify } = require("./utils/slugify");

    const { rows } = await pool.query("SELECT id, title_en, title_ar, slug FROM events ORDER BY id");
    const used = new Set(rows.filter((r) => r.slug).map((r) => r.slug));
    const assigned = [];

    for (const row of rows) {
      if (row.slug) continue;
      let base = slugify(row.title_en) || slugify(row.title_ar) || `event-${row.id}`;
      let candidate = base;
      let suffix = 2;
      while (used.has(candidate)) {
        candidate = `${base}-${suffix}`;
        suffix += 1;
      }
      await pool.query("UPDATE events SET slug = ? WHERE id = ?", [candidate, row.id]);
      used.add(candidate);
      assigned.push({ id: row.id, slug: candidate });
    }

    const { rows: stillNull } = await pool.query("SELECT COUNT(*) AS n FROM events WHERE slug IS NULL");
    const remaining = Number(stillNull[0].n);

    res.json({
      ok: true,
      totalEvents: rows.length,
      assigned,
      remainingNullSlugs: remaining,
      note:
        remaining === 0
          ? "All rows have a slug. Safe to run migration 001 STEP 4 (NOT NULL + UNIQUE) now, then remove this endpoint."
          : "Some rows still have a NULL slug -- do not run STEP 4 yet.",
    });
  } catch (err) {
    console.error("tmp_backfill_slugs failed:", err);
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

// Group Chats' live delivery needs a real WebSocket server attached to the
// same HTTP server Express already uses -- app.listen() would normally
// create that HTTP server implicitly and hide it, so it's created
// explicitly here instead purely to hand it to socket.io. Whether the
// production host actually proxies WebSocket upgrades is unverified; the
// frontend falls back to polling if a socket never connects, so this is
// safe either way (see the Group Chats plan).
const server = http.createServer(app);
const io = require("./realtime/chatSocket").attach(server);
app.set("io", io);

server.listen(config.port, () => {
  console.log(`API listening on :${config.port}`);
});