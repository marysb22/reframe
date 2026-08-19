const express = require("express");
const cors = require("cors");
const path = require("path");

const config = require("../config");

const app = express();

// =====================================================
// BASIC CONFIG
// =====================================================

const PORT = Number(process.env.PORT) || Number(config.port) || 3000;

// =====================================================
// MIDDLEWARE
// =====================================================

app.use(
    cors({
        origin: true,
        credentials: true,
    })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logger
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

const publicPath = path.join(__dirname, "../public");
const publicPath = path.join(__dirname, "../../public");
const uploadsPath = path.join(__dirname, "../uploads");

console.log("Serving static files from:", publicPath);

// Uploaded files
app.use("/uploads", express.static(uploadsPath));

// Frontend
app.use(express.static(publicPath));

// =====================================================
// API ROUTES
// =====================================================

app.use("/api/auth", require("./routes/auth"));
app.use("/api/admin", require("./routes/admin"));
app.use("/api/profile", require("./routes/profile"));
app.use("/api/supervisor", require("./routes/supervisor"));
app.use("/api/designer", require("./routes/designer"));
app.use("/api/events", require("./routes/events"));
app.use("/api/admin", require("./routes/group"));

// =====================================================
// HEALTH CHECK
// =====================================================

app.get("/api/health", (req, res) => {
    res.status(200).json({
        ok: true,
        environment: process.env.NODE_ENV || "development",
        port: PORT,
    });
});

// =====================================================
// ROOT ROUTE
// =====================================================

// Explicitly serve index.html
app.get("/", (req, res) => {
    res.sendFile(path.join(publicPath, "index.html"));
});

// =====================================================
// 404 API HANDLER
// =====================================================

app.use("/api", (req, res) => {
    res.status(404).json({
        error: "API endpoint not found",
        method: req.method,
        path: req.originalUrl,
    });
});

// =====================================================
// ERROR HANDLER
// =====================================================

app.use((err, req, res, next) => {
    console.error("SERVER ERROR:", err);

    res.status(500).json({
        error: "Internal server error",
        message: err && err.message ? err.message : String(err),
    });
});

// =====================================================
// START SERVER
// =====================================================

app.listen(PORT, "0.0.0.0", () => {
    console.log("========================================");
    console.log("Reframe MHS server started");
    console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
    console.log(`Port: ${PORT}`);
    console.log(`Public directory: ${publicPath}`);
    console.log("========================================");
});