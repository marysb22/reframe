const express = require("express");
const cors = require("cors");
const path = require("path");
const config = require("../config");

const app = express();

// Bearer-token auth (no cookies) means an open origin policy carries the
// usual CORS risk profile, not a cookie-CSRF one -- still, only the
// origins listed in CORS_ORIGIN (or the local dev defaults below) are
// allowed. Add your real deployed frontend URL to CORS_ORIGIN before
// deploying anywhere public.
app.use(
    cors({
        origin: config.corsOrigins,
        credentials: true,
    })
);

app.use(express.json());

app.use("/uploads", express.static(path.join(__dirname, "../uploads")));
app.use(express.static(path.join(__dirname, "../../public")));

app.use("/api/auth", require("./routes/auth"));
app.use("/api/admin", require("./routes/admin"));
app.use("/api/profile", require("./routes/profile"));
app.use("/api/supervisor", require("./routes/supervisor"));
app.use("/api/designer", require("./routes/designer"));
app.use("/api/events", require("./routes/events"));
app.use("/api/admin", require("./routes/group"));

app.get("/api/health", (req, res) => res.json({ ok: true }));

// Centralized error handler -- every asyncRoute() failure lands here.
app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: "Server error" });
});

app.listen(config.port, () => {
    console.log(`API listening on :${config.port}`);
});
console.log("Serving static files from:", path.join(__dirname, "../../public"));