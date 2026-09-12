// Shared building blocks for making an upload endpoint safe against
// double-clicks, rapid repeats, and retried requests -- used by both
// routes/library.js (books) and routes/supervisor.js (learning materials).
// Each caller gets its OWN independent guard instance (see
// createUploadGuard() below) so a book upload and a material upload from
// the same account never block each other.
const fs = require("fs");
const crypto = require("crypto");

// Blocks a double-click/rapid-repeat upload from the SAME account before
// the second request even starts streaming its file to disk -- this app
// runs as a single Node process, so a plain in-memory Map is enough (no
// cross-instance coordination needed). Keyed by uploader id -> the time
// their upload started, so a request that crashes without reaching the
// release call can't wedge that account forever; anything older than
// staleMs is treated as abandoned, not in-progress.
function createUploadGuard(staleMs = 5 * 60 * 1000) {
  const inFlight = new Map();
  function markStarted(key) {
    const startedAt = inFlight.get(key);
    if (startedAt && Date.now() - startedAt < staleMs) return false;
    inFlight.set(key, Date.now());
    return true;
  }
  function markFinished(key) {
    inFlight.delete(key);
  }
  return { markStarted, markFinished };
}

// SHA-256 of a file's actual bytes -- streamed, never loaded whole into
// memory, so this scales fine to large files (videos included). Used to
// recognize "the same file" regardless of filename.
function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

module.exports = { createUploadGuard, hashFile };
