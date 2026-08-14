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

app.use("/api/auth", require("./routes/auth"));
app.use("/api/admin", require("./routes/admin"));
app.use("/api/profile", require("./routes/profile"));
app.use("/api/supervisor", require("./routes/supervisor"));

app.get("/api/health", (req, res) => res.json({ ok: true }));

// TEMPORARY DIAGNOSTIC ENDPOINT -- just visit this URL directly in the
// browser (type it into the address bar, no form/file/DevTools needed).
// Checks each step of "can the DB be reached, does ADM001 exist, is its
// password hash actually a valid bcrypt hash, does 'password123' verify
// against it" and reports all of it as plain JSON. Delete this route
// once login is confirmed working -- it exists purely to bypass every
// other layer that's been hard to debug so far.
app.get("/api/debug/check-admin", async (req, res) => {
  const { pool } = require("./db");
  const bcrypt = require("bcryptjs");
  const report = {};

  // Shows exactly what connection string THIS RUNNING PROCESS currently
  // has loaded -- .env is only read once, at startup, so if you edited
  // .env but never actually stopped and restarted node, this will still
  // show the OLD value. Password is masked but its presence/length is
  // shown so a missing password is obvious.
  const rawUrl = process.env.DATABASE_URL || "(not set -- using config.js default, which has no password)";
  report.currentlyLoadedDatabaseUrl = rawUrl.replace(/:([^:@]+)@/, (m, pw) => `:${"*".repeat(pw.length)}(${pw.length} chars)@`);

  try {
    const dbTest = await pool.query("SELECT 1 AS ok");
    report.databaseConnected = dbTest.rows[0].ok === 1;
  } catch (err) {
    report.databaseConnected = false;
    report.databaseError = err.message || err.code || String(err);
    // AggregateError (thrown when Node can't reach the DB host at all --
    // wrong port, service not running, wrong host) has an empty top-level
    // .message; the real detail is in .errors, one entry per address it
    // tried (e.g. 127.0.0.1 and ::1).
    if (err.errors && Array.isArray(err.errors)) {
      report.underlyingErrors = err.errors.map((e) => ({
        message: e.message,
        code: e.code,
        address: e.address,
        port: e.port,
      }));
    }
    return res.json(report);
  }

  try {
    const { rows } = await pool.query(
      "SELECT id, member_code, password_hash, role, status FROM user_credentials WHERE member_code = 'ADM001'"
    );
    if (!rows.length) {
      report.adminAccountExists = false;
      return res.json(report);
    }
    report.adminAccountExists = true;
    report.adminId = rows[0].id;
    report.adminRole = rows[0].role;
    report.adminStatus = rows[0].status;
    report.storedHashPreview = rows[0].password_hash.slice(0, 15) + "...";
    report.storedHashLooksValid = /^\$2[aby]\$\d{2}\$/.test(rows[0].password_hash);

    if (!report.storedHashLooksValid) {
      report.diagnosis = "The stored password_hash is NOT a real bcrypt hash (probably still the schema's placeholder text). This is why login throws. Run the password-seeding script.";
      return res.json(report);
    }

    try {
      const matches = await bcrypt.compare("password123", rows[0].password_hash);
      report.passwordCompareResult = matches;
      report.diagnosis = matches
        ? "Everything checks out -- 'password123' should log in successfully. If login still fails, the problem is elsewhere (routes/auth.js logic, or a different password was actually set)."
        : "The hash is valid bcrypt format, but 'password123' does NOT match it -- a different password was set during seeding. Try that password instead, or re-run the seeding script with 'password123'.";
    } catch (err) {
      report.passwordCompareThrew = err.message;
      report.diagnosis = "bcrypt.compare() itself threw an error -- this is the exact crash causing 'Internal server error' on login.";
    }
  } catch (err) {
    report.queryError = err.message;
  }

  res.json(report);
});

// Centralized error handler -- every asyncRoute() failure lands here.
//
// TEMPORARY DEBUG MODE: sending err.message back in the response so it's
// visible directly in the login page's error box, without needing
// terminal/DevTools access. REVERT THIS before anything but local
// debugging -- exposing internal error text to the client is a real
// information-disclosure risk in production.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "DEBUG: " + (err && err.message ? err.message : String(err)) });
});

app.listen(config.port, () => {
  console.log(`API listening on :${config.port}`);
});