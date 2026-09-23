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