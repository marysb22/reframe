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

// `app.set("trust proxy", ...)` is deliberately NOT set here. It controls
// whether Express trusts the X-Forwarded-For header for req.ip (used by
// utils/loginRateLimit.js's per-IP+account login throttle) -- enabling it
// when there is NO real reverse proxy in front of Node lets any client
// simply send its own X-Forwarded-For header and pick whatever "IP" the
// rate limiter sees, defeating that limiter entirely; leaving it disabled
// when there IS a trusted proxy (Hostinger's Node hosting commonly sits
// behind one, e.g. nginx/Apache+Passenger) makes req.ip always resolve to
// the proxy's own address instead of the real client's, which doesn't
// create a bypass but does make every visitor behind that proxy share one
// rate-limit bucket per account -- a correctness/UX issue, not a security
// hole, but still worth fixing with the right setting once confirmed.
//
// This could not be verified from this environment (no access to
// Hostinger's hPanel or its actual request path) -- to resolve it:
//   1. Add a temporary route (or check existing request logs) that prints
//      req.ip, req.headers['x-forwarded-for'], and req.socket.remoteAddress
//      for a real request hitting the LIVE site.
//   2. If req.socket.remoteAddress is Hostinger's own internal/proxy
//      address (not the visitor's real IP) and x-forwarded-for holds the
//      real one, there IS a trusted proxy in front -- set
//      `app.set("trust proxy", 1)` (trust exactly one hop, not `true`,
//      which trusts the whole forwarded chain including anything a client
//      prepends).
//   3. If req.socket.remoteAddress already IS the visitor's real IP, there
//      is no proxy to trust -- leave this unset exactly as it is now.

// Explicit allowlist, not `origin: true` (which reflected ANY origin back
// as allowed) -- the production site (events.json's own marketing copy
// tells visitors to "visit www.reframemhs.com") is served from both the
// apex and the www subdomain, so both are included by default. Overridable
// via CORS_ALLOWED_ORIGINS (comma-separated) without a code change, so a
// staging domain or a different local dev port can be added without
// touching this file. Requests with no Origin header at all (curl,
// server-to-server calls, the test suite's raw http client) are never
// subject to CORS in the first place -- only a browser sends/enforces it --
// so they're let through unconditionally, matching how they already
// behaved under `origin: true`.
//
// Bearer-token auth (no cookies) means a wrong/missing origin here can
// never be a cookie-CSRF issue -- the actual access boundary is still the
// Authorization header/token, checked independently by requireAuth on
// every route. This allowlist exists so a browser won't even attempt a
// request from somewhere it has no business running this app's JS from,
// not as the app's only line of defense.
const DEFAULT_ALLOWED_ORIGINS = [
  "https://reframemhs.com",
  "https://www.reframemhs.com",
  // Local development: the Node server itself serves the frontend
  // (express.static below), which is same-origin and never needs CORS --
  // these two only matter if the frontend is instead opened through a
  // separate tool (e.g. VS Code's "Live Server" on 127.0.0.1:5500, the
  // exact scenario this middleware was originally added for).
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
];
const allowedOrigins = process.env.CORS_ALLOWED_ORIGINS
  ? process.env.CORS_ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
  : DEFAULT_ALLOWED_ORIGINS;

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      callback(null, false);
    },
    credentials: true,
  })
);

app.use(express.json());

// Event images are shown on the public marketing site, which requires no
// login at all, so that one subfolder stays a plain static mount. Every
// other upload subfolder (documents, CVs, chat attachments, submissions,
// materials, assignment attachments, profile photos) previously lived
// under this same unauthenticated mount -- meaning anyone who obtained a
// URL (a leaked link, browser history, a screenshot) had permanent,
// unrevocable access to a private file with no login check at all. Those
// now go through routes/files.js instead, which requires a valid session
// and checks per-file ownership/caseload before serving anything.
// A 1-day cache lets a repeat visitor's browser skip re-downloading the
// same event photo or site asset on every page view, without risking a
// stale image sticking around for long if a designer replaces one --
// these filenames aren't content-hashed, so an aggressive/immutable
// cache would risk serving an old image under an unchanged URL.
const STATIC_CACHE_OPTIONS = { maxAge: "1d" };
app.use("/uploads/events", express.static(path.join(config.uploadsDir, "events"), STATIC_CACHE_OPTIONS));
app.use("/uploads", require("./routes/files"));
app.use(express.static(path.join(__dirname, "../public"), STATIC_CACHE_OPTIONS));

app.use("/api/auth", require("./routes/auth"));
app.use("/api/admin", require("./routes/admin"));
app.use("/api/profile", require("./routes/profile"));
app.use("/api/supervisor", require("./routes/supervisor"));
app.use("/api/library", require("./routes/library"));
app.use("/api/master-trainer", require("./routes/Mastertrainer"));
app.use("/api/designer", require("./routes/designer"));
app.use("/api/chat-rooms", require("./routes/chatRooms"));
app.use("/api/ai", require("./routes/ai"));
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