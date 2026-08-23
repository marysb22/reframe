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
app.use("/api/designer", require("./routes/designer"));
app.use("/api", require("./routes/public"));

app.get("/api/health", (req, res) => res.json({ ok: true }));

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