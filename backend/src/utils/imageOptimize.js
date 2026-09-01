const sharp = require("sharp");
const fs = require("fs");

// A phone-camera photo is routinely 3000px+ wide and several MB -- nothing
// in this app ever displays an uploaded image anywhere near that size, so
// storing and serving it at full resolution is pure waste (slow uploads,
// slow page loads, wasted disk). This resizes + recompresses an
// already-on-disk, already-validated image in place before any DB row is
// created pointing at it. Animated GIFs are left untouched -- sharp would
// otherwise flatten them to a single static frame. A file that isn't one
// of the three raster formats sharp/browsers handle well (e.g. a PDF/Word
// document that happened to pass a multi-type filter) is left untouched.
const OPTIMIZABLE_FORMATS = new Set(["jpeg", "png", "webp"]);

/**
 * @param {string} filePath - path multer already wrote the upload to.
 * @param {{maxDimension: number, quality?: number}} opts
 * @returns {Promise<number|null>} the file's resulting size in bytes, or
 *   null if the file wasn't touched (not a recognized raster format).
 */
async function optimizeImageIfPossible(filePath, { maxDimension, quality = 82 }) {
  // Reading the whole file into memory first (rather than pointing sharp
  // at the path and later writing back to that same path) avoids a real
  // Windows file-locking error: sharp's read handle on the path can still
  // be open when the write-back attempts to open the same path, throwing
  // "UNKNOWN: unknown error, open". Buffer in, buffer out sidesteps it
  // entirely and works identically cross-platform.
  let inputBuffer;
  try {
    inputBuffer = fs.readFileSync(filePath);
  } catch (err) {
    console.error("[imageOptimize] could not read uploaded file, leaving it as-is:", err);
    return null;
  }

  let meta;
  try {
    meta = await sharp(inputBuffer).metadata();
  } catch {
    return null; // not an image sharp can decode -- leave it alone
  }
  if (!OPTIMIZABLE_FORMATS.has(meta.format)) return null;

  try {
    const pipeline = sharp(inputBuffer).resize({
      width: maxDimension,
      height: maxDimension,
      fit: "inside",
      withoutEnlargement: true,
    });

    let buf;
    if (meta.format === "jpeg") buf = await pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();
    else if (meta.format === "png") buf = await pipeline.png({ compressionLevel: 9 }).toBuffer();
    else buf = await pipeline.webp({ quality, effort: 4 }).toBuffer();

    // An already small/well-compressed image re-encoded at a fixed quality
    // can occasionally come out larger -- only replace the original if the
    // optimized version actually won.
    if (buf.length < inputBuffer.length) {
      fs.writeFileSync(filePath, buf);
      return buf.length;
    }
    return inputBuffer.length;
  } catch (err) {
    // Optimization is a nice-to-have, never a correctness requirement --
    // the original, already-validated file on disk is still perfectly
    // servable, so a failure here must never surface as a request error.
    console.error("[imageOptimize] optimization failed, keeping original file:", err);
    return null;
  }
}

module.exports = { optimizeImageIfPossible };
