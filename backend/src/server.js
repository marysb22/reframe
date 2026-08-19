const express = require("express");
const cors = require("cors");
const path = require("path");
const config = require("../config");

const app = express();

app.use(
    cors({
        origin: true,
        credentials: true,
    })
);

app.use(express.json());

app.use((req, res, next) => {
    const start = Date.now();

    console.log(
        `[${new Date().toISOString()}] --> ${req.method} ${req.originalUrl}`
    );

    res.on("finish", () => {
        console.log(
            `[${new Date().toISOString()}] <-- ${req.method} ${req.originalUrl} : ${res.statusCode} (${Date.now() - start}ms)`
        );
    });

    next();
});

app.use("/uploads", express.static(path.join(__dirname, "../uploads")));
app.use(express.static(path.join(__dirname, "../../public")));

app.use("/api/auth", require("./routes/auth"));
app.use("/api/admin", require("./routes/admin"));
app.use("/api/profile", require("./routes/profile"));
app.use("/api/supervisor", require("./routes/supervisor"));
app.use("/api/designer", require("./routes/designer"));
app.use("/api/events", require("./routes/events"));
app.use("/api/admin", require("./routes/group"));

app.get("/api/health", (req, res) => {
    res.json({ ok: true });
});

app.use((err, req, res, next) => {
    console.error(err);

    res.status(500).json({
        error: "DEBUG: " + (err && err.message ? err.message : String(err)),
    });
});

app.listen(config.port, () => {
    console.log(`API listening on :${config.port}`);
});

console.log(
    "Serving static files from:",
    path.join(__dirname, "../../public")
);