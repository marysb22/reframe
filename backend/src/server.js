const express = require("express");
const cors = require("cors");
const path = require("path");
const config = require("./config");

const authRoutes = require("./routes/auth.routes");
const profileRoutes = require("./routes/profile.routes");
const adminRoutes = require("./routes/admin.routes");
const masterTrainerRoutes = require("./routes/masterTrainer.routes");
const eventsRoutes = require("./routes/events.routes");

const app = express();

app.use(
  cors({
    origin: config.corsOrigins.length ? config.corsOrigins : true,
  })
);
app.use(express.json());

// Serve uploaded photos/CVs, e.g. http://localhost:3000/uploads/photos/<file>
app.use("/uploads", express.static(config.uploadsDir));

app.get("/api/health", (req, res) => res.json({ status: "ok" }));

app.use("/api/auth", authRoutes);
app.use("/api/profile", profileRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/master-trainer", masterTrainerRoutes);
app.use("/api/events", eventsRoutes);

// Multer / JSON parse errors and anything unhandled end up here.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || "Server error" });
});

app.use((req, res) => res.status(404).json({ error: "Not found" }));

app.listen(config.port, () => {
  console.log(`Reframe MHS backend listening on http://localhost:${config.port}`);
});
