// Library download approval (migration 041) -- security + workflow tests.
//
// Exercises the real HTTP API and the real file route of a running dev
// server against isolated ZZLDA fixtures (two Groups, Admins with and
// without the reviewer permission, a Master Trainer per Group, a ToT and
// Trainees), then removes every fixture row and uploaded file.
//
// Run: node tests/library-download-approval.test.js (dev server must be running)

const http = require("http");
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const cfg = require(path.join(__dirname, "..", "src", "config"));
const { pool } = require(path.join(__dirname, "..", "src", "db"));

const BASE = "http://localhost:3000";
const P = "ZZLDA";
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
const tok = (id, role) => jwt.sign({ id, role }, cfg.jwtSecret, { expiresIn: "1h" });

function request(method, urlPath, { token, body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const h = { ...(headers || {}) };
    if (token) h.Authorization = `Bearer ${token}`;
    if (data) {
      h["Content-Type"] = "application/json";
      h["Content-Length"] = data.length;
    }
    const req = http.request(BASE + urlPath, { method, headers: h }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString("utf8")); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: json, raw: buf });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
const api = (method, p, opts) => request(method, "/api" + p, opts);

function uploadBook(token, title, fileBuf, coverBuf) {
  return new Promise((resolve, reject) => {
    const boundary = "----zzlda" + Date.now() + Math.random().toString(36).slice(2);
    const chunks = [];
    const push = (s) => chunks.push(Buffer.isBuffer(s) ? s : Buffer.from(s, "utf8"));
    for (const [k, v] of Object.entries({ title, author: "ZZLDA Author", resourceType: "book" })) {
      push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
    }
    push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${title}.pdf"\r\nContent-Type: application/pdf\r\n\r\n`);
    push(fileBuf);
    push("\r\n");
    if (coverBuf) {
      push(`--${boundary}\r\nContent-Disposition: form-data; name="coverImage"; filename="cover.png"\r\nContent-Type: image/png\r\n\r\n`);
      push(coverBuf);
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
        res.on("end", () => { let json = null; try { json = JSON.parse(raw); } catch {} resolve({ status: res.statusCode, body: json }); });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

const fx = {};
const T = {};

async function fixtureIds() {
  const { rows } = await pool.query(`SELECT id FROM user_credentials WHERE member_code LIKE '${P}%'`);
  return rows.map((r) => r.id);
}

async function wipe() {
  const ids = await fixtureIds();
  const { rows: mats } = await pool.query(
    `SELECT id, filename, cover_image FROM learning_materials WHERE title LIKE '${P}%'`
  );
  const matIds = mats.map((m) => m.id);
  if (ids.length || matIds.length) {
    const { rows: reqs } = await pool.query(
      `SELECT id FROM library_download_requests WHERE requester_id IN (?) OR requested_material_id IN (?)`,
      [ids.length ? ids : [0], matIds.length ? matIds : [0]]
    );
    const reqIds = reqs.map((r) => r.id);
    if (reqIds.length) {
      await pool.query("DELETE FROM audit_logs WHERE entity_type = 'library_download_requests' AND entity_id IN (?)", [reqIds]);
      await pool.query("DELETE FROM notifications WHERE related_entity_type = 'download_request' AND related_entity_id IN (?)", [reqIds]);
      await pool.query("DELETE FROM library_download_requests WHERE id IN (?)", [reqIds]);
    }
  }
  for (const m of mats) {
    for (const f of [m.filename, m.cover_image]) {
      if (f) { try { fs.unlinkSync(path.join(cfg.uploadsDir, "materials", f)); } catch {} }
    }
  }
  if (matIds.length) {
    await pool.query("DELETE FROM audit_logs WHERE entity_type = 'learning_materials' AND entity_id IN (?)", [matIds]);
    await pool.query("DELETE FROM learning_materials WHERE id IN (?)", [matIds]);
  }
  if (ids.length) {
    await pool.query("DELETE FROM audit_logs WHERE actor_id IN (?)", [ids]);
    await pool.query("DELETE FROM admin_permissions WHERE admin_id IN (?)", [ids]);
    await pool.query("DELETE FROM admin_users WHERE id IN (?)", [ids]);
    await pool.query("DELETE FROM students WHERE id IN (?)", [ids]);
    await pool.query("UPDATE supervisors SET primary_supervisor_id = NULL, supervisor_type = 'primary' WHERE id IN (?)", [ids]);
    await pool.query("DELETE FROM supervisors WHERE id IN (?)", [ids]);
    await pool.query("DELETE FROM user_credentials WHERE id IN (?)", [ids]);
  }
  await pool.query(`DELETE FROM trainer_groups WHERE name LIKE '${P}%'`);
}

async function cred(code, role) {
  const r = await pool.query(
    "INSERT INTO user_credentials (member_code, password_hash, role, status, must_change_password) VALUES (?, 'x', ?, 'active', FALSE)",
    [code, role]
  );
  return r.insertId;
}

async function setup() {
  await wipe();
  fx.groupA = (await pool.query(`INSERT INTO trainer_groups (name) VALUES ('${P} Group A')`)).insertId;
  fx.groupB = (await pool.query(`INSERT INTO trainer_groups (name) VALUES ('${P} Group B')`)).insertId;

  fx.admin = await cred(`${P}ADM`, "admin");
  await pool.query("INSERT INTO admin_users (id, full_name) VALUES (?, 'ZZLDA Admin Reviewer')", [fx.admin]);
  await pool.query("INSERT INTO admin_permissions (admin_id, permission_code) VALUES (?, 'library.view'), (?, 'library.approve_downloads')", [fx.admin, fx.admin]);
  fx.adminNo = await cred(`${P}ADMNO`, "admin");
  await pool.query("INSERT INTO admin_users (id, full_name) VALUES (?, 'ZZLDA Admin NoPerm')", [fx.adminNo]);
  await pool.query("INSERT INTO admin_permissions (admin_id, permission_code) VALUES (?, 'library.view')", [fx.adminNo]);

  fx.mtA = await cred(`${P}MTA`, "supervisor");
  await pool.query("INSERT INTO supervisors (id, full_name, supervisor_type, group_id) VALUES (?, 'ZZLDA MT A', 'primary', ?)", [fx.mtA, fx.groupA]);
  fx.mtB = await cred(`${P}MTB`, "supervisor");
  await pool.query("INSERT INTO supervisors (id, full_name, supervisor_type, group_id) VALUES (?, 'ZZLDA MT B', 'primary', ?)", [fx.mtB, fx.groupB]);
  fx.totA = await cred(`${P}TOTA`, "supervisor");
  await pool.query("INSERT INTO supervisors (id, full_name, supervisor_type, primary_supervisor_id, group_id) VALUES (?, 'ZZLDA ToT A', 'in_training', ?, ?)", [fx.totA, fx.mtA, fx.groupA]);

  for (const [key, code, group] of [["a1", "TRA1", fx.groupA], ["a2", "TRA2", fx.groupA], ["b1", "TRB1", fx.groupB], ["nog", "TRNOG", null]]) {
    fx[key] = await cred(`${P}${code}`, "trainee");
    await pool.query("INSERT INTO students (id, full_name, group_id) VALUES (?, ?, ?)", [fx[key], `ZZLDA Trainee ${code}`, group]);
  }
  for (const k of ["admin", "adminNo", "mtA", "mtB", "totA", "a1", "a2", "b1", "nog"]) {
    T[k] = tok(fx[k], ["admin", "adminNo"].includes(k) ? "admin" : ["mtA", "mtB", "totA"].includes(k) ? "supervisor" : "trainee");
  }

  const sharp = require("sharp");
  const cover = await sharp({ create: { width: 12, height: 18, channels: 3, background: "#2e7d78" } }).png().toBuffer();
  fx.pdf1 = Buffer.from("%PDF-1.4\n% ZZLDA book one " + Date.now() + "\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
  fx.pdf2 = Buffer.from("%PDF-1.4\n% ZZLDA book two " + Date.now() + "\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
  const b1 = await uploadBook(T.mtA, `${P} Book One`, fx.pdf1, cover);
  const b2 = await uploadBook(T.mtA, `${P} Book Two`, fx.pdf2, null);
  if (b1.status !== 201 || b2.status !== 201) throw new Error(`fixture upload failed: ${b1.status} ${b2.status} ${JSON.stringify(b1.body || b2.body)}`);
  fx.book1 = b1.body;
  fx.book2 = b2.body;
}

const fileUrl = (b) => `/uploads/materials/${b.filename}`;
// fileGet / fileGetQ = a DOWNLOAD (the approval-gated action); fileRead = Open & Read.
const fileGet = (b, token) => request("GET", fileUrl(b) + "?mode=download", { token });
const fileGetQ = (b, token) => request("GET", `${fileUrl(b)}?token=${encodeURIComponent(token)}&mode=download`);
const fileRead = (b, token) => request("GET", fileUrl(b), { token });
const previewLink = (b, token) => request("GET", `/uploads/preview-link?subfolder=materials&filename=${encodeURIComponent(b.filename)}`, { token });
const ask = (token, book) => api("POST", `/library/books/${book.id}/download-requests`, { token });
const decide = (token, id, decision, reason) => api("POST", `/library/download-requests/${id}/decision`, { token, body: { decision, reason } });
async function reqRow(id) {
  const { rows } = await pool.query("SELECT * FROM library_download_requests WHERE id = ?", [id]);
  return rows[0];
}
async function notifCount(recipient, type, entityId) {
  const { rows } = await pool.query(
    "SELECT COUNT(*) AS c FROM notifications WHERE recipient_id = ? AND related_entity_type = ? AND related_entity_id = ?",
    [recipient, type, entityId]
  );
  return Number(rows[0].c);
}
async function latestRequest(requester, book) {
  const { rows } = await pool.query(
    "SELECT * FROM library_download_requests WHERE requester_id = ? AND requested_material_id = ? ORDER BY id DESC LIMIT 1",
    [requester, book.id]
  );
  return rows[0];
}

async function main() {
  console.log("Setting up isolated ZZLDA fixtures...");
  await setup();

  console.log("\nBaseline: who downloads without a request\n");
  await test("Master Trainer (uploader) downloads the file: 200 and exact bytes", async () => {
    const r = await fileGet(fx.book1, T.mtA);
    assert(r.status === 200 && r.raw.equals(fx.pdf1), `got ${r.status}`);
  });
  await test("Another Group's Master Trainer downloads without a request (existing MT access)", async () => {
    const r = await fileGet(fx.book1, T.mtB);
    assert(r.status === 200, `got ${r.status}`);
  });
  await test("Admin downloads without a request", async () => {
    const r = await fileGet(fx.book1, T.adminNo);
    assert(r.status === 200, `got ${r.status}`);
  });
  await test("Master Trainer cannot file a request (none needed): 400", async () => {
    const r = await ask(T.mtB, fx.book1);
    assert(r.status === 400, `got ${r.status}`);
  });

  console.log("\nC. Nothing is downloadable before approval (every route)\n");
  await test("Trainee's book list: readable (filename present), download not allowed, approval required", async () => {
    const r = await api("GET", "/library/books", { token: T.a1 });
    const b = r.body.books.find((x) => x.id === fx.book1.id);
    assert(b && b.filename === fx.book1.filename && b.access.canDownload === false && b.access.required === true && b.access.status === "none", JSON.stringify(b && b.access));
    assert(r.body.reviewer === false, "trainee must not be flagged as reviewer");
  });
  for (const who of ["a1", "totA", "nog"]) {
    await test(`[${who}] Open & Read (no mode): 200, inline only, no filename offered, not cached`, async () => {
      const r = await fileRead(fx.book1, T[who]);
      assert(r.status === 200 && r.raw.equals(fx.pdf1), `got ${r.status}`);
      assert(r.headers["content-disposition"] === "inline", `disposition: ${r.headers["content-disposition"]}`);
      assert(r.headers["cache-control"] === "no-store", `cache: ${r.headers["cache-control"]}`);
    });
    await test(`[${who}] Download (?mode=download, Bearer header): 403`, async () => {
      const r = await fileGet(fx.book1, T[who]);
      assert(r.status === 403, `got ${r.status}`);
    });
    await test(`[${who}] Download via old-style ?token=&mode=download URL: 403`, async () => {
      const r = await fileGetQ(fx.book1, T[who]);
      assert(r.status === 403, `got ${r.status}`);
    });
    await test(`[${who}] preview-link (reading via Google viewer): allowed`, async () => {
      const r = await previewLink(fx.book1, T[who]);
      assert(r.status === 200 && r.body && r.body.url, `got ${r.status}`);
    });
  }
  await test("No session at all: 401 for both reading and downloading", async () => {
    assert((await fileGet(fx.book1, null)).status === 401);
    assert((await fileRead(fx.book1, null)).status === 401);
  });
  await test("A format the browser can't display (.docx) is not handed out for 'reading' without approval (403)", async () => {
    const name = `zzlda-${Date.now()}.docx`;
    fs.writeFileSync(path.join(cfg.uploadsDir, "materials", name), Buffer.from("PK\x03\x04zzlda"));
    await pool.query(
      "INSERT INTO learning_materials (supervisor_id, title, material_type, filename, original_name, resource_type) VALUES (?, ?, 'book', ?, 'x.docx', 'book')",
      [fx.mtA, `${P} Docx Book`, name]
    );
    const r = await request("GET", `/uploads/materials/${name}`, { token: T.a1 });
    assert(r.status === 403, `got ${r.status}`);
    const owner = await request("GET", `/uploads/materials/${name}`, { token: T.mtA });
    assert(owner.status === 200, `MT got ${owner.status}`);
  });
  await test("Cover image stays visible to a trainee (it is the shelf, not the document)", async () => {
    const r = await request("GET", `/uploads/materials/${fx.book1.coverImage}`, { token: T.a1 });
    assert(r.status === 200, `got ${r.status}`);
  });
  await test("Direct path outside the protected route is not served (/materials/<file>, /backend/uploads/...)", async () => {
    for (const p of [`/materials/${fx.book1.filename}`, `/uploads/../uploads/materials/${fx.book1.filename}`, `/backend/uploads/materials/${fx.book1.filename}`]) {
      const r = await request("GET", p);
      assert(r.status !== 200 || !r.raw.equals(fx.pdf1), `${p} returned the file`);
    }
  });

  console.log("\nA. Normal workflow -- Admin approves a ToT\n");
  let totReq;
  await test("ToT requests Book One: 201, row is pending with file hash + group recorded", async () => {
    const r = await ask(T.totA, fx.book1);
    assert(r.status === 201 && r.body.created === true && r.body.access.status === "pending", `got ${r.status} ${JSON.stringify(r.body)}`);
    totReq = await latestRequest(fx.totA, fx.book1);
    assert(totReq.status === "pending" && Number(totReq.group_id) === fx.groupA && totReq.file_hash, JSON.stringify(totReq));
    assert(totReq.requester_role === "tot", totReq.requester_role);
  });
  await test("Pending ToT still gets 403 on the file", async () => {
    const r = await fileGet(fx.book1, T.totA);
    assert(r.status === 403, `got ${r.status}`);
  });
  await test("Reviewers notified exactly once: Admin reviewer + MT A; not MT B, not Admin without permission", async () => {
    assert((await notifCount(fx.admin, "download_request", totReq.id)) === 1, "admin");
    assert((await notifCount(fx.mtA, "download_request", totReq.id)) === 1, "mtA");
    assert((await notifCount(fx.mtB, "download_request", totReq.id)) === 0, "mtB must not be notified");
    assert((await notifCount(fx.adminNo, "download_request", totReq.id)) === 0, "adminNo must not be notified");
  });
  await test("Request appears in Admin's and MT A's pending list with full context; not in MT B's", async () => {
    const a = await api("GET", "/library/download-requests?status=pending", { token: T.admin });
    const m = await api("GET", "/library/download-requests?status=pending", { token: T.mtA });
    const b = await api("GET", "/library/download-requests?status=pending", { token: T.mtB });
    const row = a.body.requests.find((x) => x.id === totReq.id);
    assert(row && row.requesterName === "ZZLDA ToT A" && row.requesterRoleLabel === "Trainer (ToT)" && row.title === `${P} Book One` && row.groupName === `${P} Group A` && row.createdAt, JSON.stringify(row));
    assert(m.body.requests.some((x) => x.id === totReq.id), "missing from MT A");
    assert(!b.body.requests.some((x) => x.id === totReq.id), "visible to MT B");
  });
  await test("Retrying the request returns the same pending one: no new row, no new notifications", async () => {
    const r = await ask(T.totA, fx.book1);
    assert(r.status === 200 && r.body.created === false && r.body.access.requestId === totReq.id, JSON.stringify(r.body));
    const { rows } = await pool.query("SELECT COUNT(*) AS c FROM library_download_requests WHERE requester_id = ? AND requested_material_id = ?", [fx.totA, fx.book1.id]);
    assert(Number(rows[0].c) === 1, `rows: ${rows[0].c}`);
    assert((await notifCount(fx.admin, "download_request", totReq.id)) === 1, "duplicate notification");
  });
  await test("Admin accepts: 200, reviewer + timestamp recorded, audit row written", async () => {
    const r = await decide(T.admin, totReq.id, "approve");
    assert(r.status === 200 && r.body.request.status === "approved", `got ${r.status} ${JSON.stringify(r.body)}`);
    const row = await reqRow(totReq.id);
    assert(Number(row.reviewer_id) === fx.admin && row.decided_at && row.reviewer_name === "ZZLDA Admin Reviewer", JSON.stringify(row));
    const { rows } = await pool.query("SELECT COUNT(*) AS c FROM audit_logs WHERE entity_type = 'library_download_requests' AND entity_id = ? AND action = 'library download approved' AND actor_id = ?", [totReq.id, fx.admin]);
    assert(Number(rows[0].c) === 1, "audit");
  });
  await test("ToT is notified of the approval", async () => {
    assert((await notifCount(fx.totA, "library_book", fx.book1.id)) === 1, "no approval notification");
  });
  await test("Other reviewers' notifications for the settled request are marked read", async () => {
    const { rows } = await pool.query("SELECT COUNT(*) AS c FROM notifications WHERE related_entity_type='download_request' AND related_entity_id = ? AND is_read = FALSE", [totReq.id]);
    assert(Number(rows[0].c) === 0, `unread left: ${rows[0].c}`);
  });
  await test("ToT now downloads Book One: 200, exact bytes; list shows filename", async () => {
    const r = await fileGet(fx.book1, T.totA);
    assert(r.status === 200 && r.raw.equals(fx.pdf1), `got ${r.status}`);
    const l = await api("GET", "/library/books", { token: T.totA });
    const b = l.body.books.find((x) => x.id === fx.book1.id);
    assert(b.filename === fx.book1.filename && b.access.status === "approved" && b.access.canDownload === true, JSON.stringify(b.access));
    assert(/^attachment;/.test(r.headers["content-disposition"] || ""), `disposition: ${r.headers["content-disposition"]}`);
  });
  await test("ToT's approval for Book One does NOT open Book Two (file id swap)", async () => {
    const r = await fileGet(fx.book2, T.totA);
    assert(r.status === 403, `got ${r.status}`);
  });

  console.log("\nA2. Normal workflow -- Master Trainer approves a Trainee\n");
  let a1Req;
  await test("Trainee A1 requests Book One -> MT A accepts -> A1 downloads", async () => {
    const r = await ask(T.a1, fx.book1);
    assert(r.status === 201, `request ${r.status}`);
    a1Req = await latestRequest(fx.a1, fx.book1);
    const d = await decide(T.mtA, a1Req.id, "approve");
    assert(d.status === 200, `decide ${d.status} ${JSON.stringify(d.body)}`);
    assert((await notifCount(fx.a1, "library_book", fx.book1.id)) === 1, "trainee not notified");
    const f = await fileGet(fx.book1, T.a1);
    assert(f.status === 200 && f.raw.equals(fx.pdf1), `file ${f.status}`);
    const pl = await previewLink(fx.book1, T.a1);
    assert(pl.status === 200 && pl.body.url, `preview-link ${pl.status}`);
  });

  console.log("\nB. Rejection workflow\n");
  let a2Req;
  await test("Trainee A2 requests -> MT A rejects with a reason -> A2 notified, still 403 everywhere", async () => {
    const r = await ask(T.a2, fx.book1);
    assert(r.status === 201, `request ${r.status}`);
    a2Req = await latestRequest(fx.a2, fx.book1);
    const d = await decide(T.mtA, a2Req.id, "reject", "Not part of this module");
    assert(d.status === 200 && d.body.request.status === "rejected" && d.body.request.rejectionReason === "Not part of this module", JSON.stringify(d.body));
    assert((await notifCount(fx.a2, "library_book", fx.book1.id)) === 1, "not notified");
    for (const res of [await fileGet(fx.book1, T.a2), await fileGetQ(fx.book1, T.a2)]) {
      assert(res.status === 403, `got ${res.status}`);
    }
    const l = await api("GET", "/library/books", { token: T.a2 });
    const b = l.body.books.find((x) => x.id === fx.book1.id);
    assert(b.access.canDownload === false && b.access.status === "rejected" && b.access.rejectionReason === "Not part of this module", JSON.stringify(b.access));
  });
  await test("A rejected request cannot be re-decided (409) and is not reusable", async () => {
    const d = await decide(T.admin, a2Req.id, "approve");
    assert(d.status === 409, `got ${d.status}`);
    assert((await reqRow(a2Req.id)).status === "rejected", "status changed");
    assert((await fileGet(fx.book1, T.a2)).status === 403, "file served");
  });
  await test("Re-request after rejection creates a NEW pending row; the rejected row is kept; still 403", async () => {
    const r = await ask(T.a2, fx.book1);
    assert(r.status === 201 && r.body.access.status === "pending", `got ${r.status} ${JSON.stringify(r.body)}`);
    const { rows } = await pool.query("SELECT status FROM library_download_requests WHERE requester_id = ? AND requested_material_id = ? ORDER BY id", [fx.a2, fx.book1.id]);
    assert(rows.map((x) => x.status).join(",") === "rejected,pending", rows.map((x) => x.status).join(","));
    assert((await fileGet(fx.book1, T.a2)).status === 403, "file served while pending");
  });

  console.log("\nD. Authorization attacks\n");
  await test("1. Trainee B1 cannot use A1's approval (403 on the same file)", async () => {
    assert((await fileGet(fx.book1, T.b1)).status === 403);
    assert((await fileGetQ(fx.book1, T.b1)).status === 403);
  });
  let b1Req;
  await test("2. A requester cannot decide their own request (scope: 403)", async () => {
    await ask(T.b1, fx.book2);
    b1Req = await latestRequest(fx.b1, fx.book2);
    const d = await decide(T.b1, b1Req.id, "approve");
    assert(d.status === 403, `got ${d.status}`);
    assert((await reqRow(b1Req.id)).status === "pending");
  });
  await test("3/4. A ToT cannot approve (403), even inside their own Group", async () => {
    const pending = await latestRequest(fx.a2, fx.book1);
    const d = await decide(T.totA, pending.id, "approve");
    assert(d.status === 403, `got ${d.status}`);
    const l = await api("GET", "/library/download-requests", { token: T.totA });
    assert(l.status === 403, `list ${l.status}`);
  });
  await test("5. A Trainee cannot approve another trainee's request (403)", async () => {
    const pending = await latestRequest(fx.a2, fx.book1);
    const d = await decide(T.a1, pending.id, "approve");
    assert(d.status === 403, `got ${d.status}`);
  });
  await test("6. MT B cannot approve a Group A request (404, nothing revealed) nor see it", async () => {
    const pending = await latestRequest(fx.a2, fx.book1);
    const d = await decide(T.mtB, pending.id, "approve");
    assert(d.status === 404, `got ${d.status}`);
    const g = await api("GET", `/library/download-requests/${pending.id}`, { token: T.mtB });
    assert(g.status === 404, `detail ${g.status}`);
    const l = await api("GET", `/library/download-requests?status=all&ids=${pending.id}`, { token: T.mtB });
    assert(l.status === 200 && l.body.requests.length === 0, "listed for MT B");
    assert((await reqRow(pending.id)).status === "pending");
  });
  await test("6b. MT A cannot approve a Group B request; MT B can see it", async () => {
    const d = await decide(T.mtA, b1Req.id, "approve");
    assert(d.status === 404, `got ${d.status}`);
    const l = await api("GET", "/library/download-requests", { token: T.mtB });
    assert(l.body.requests.some((x) => x.id === b1Req.id), "MT B should see its own Group's request");
  });
  await test("6c. Admin WITHOUT library.approve_downloads cannot list or decide (403)", async () => {
    assert((await api("GET", "/library/download-requests", { token: T.adminNo })).status === 403);
    assert((await decide(T.adminNo, b1Req.id, "approve")).status === 403);
  });
  await test("6d. An ungrouped trainee's request goes to Admin only (no Master Trainer can see it)", async () => {
    const r = await ask(T.nog, fx.book2);
    assert(r.status === 201, `got ${r.status}`);
    const row = await latestRequest(fx.nog, fx.book2);
    assert(row.group_id === null, "group");
    assert((await notifCount(fx.admin, "download_request", row.id)) === 1, "admin not notified");
    assert((await notifCount(fx.mtA, "download_request", row.id)) === 0 && (await notifCount(fx.mtB, "download_request", row.id)) === 0, "MT notified");
    assert((await decide(T.mtA, row.id, "approve")).status === 404, "MT A decided");
  });
  await test("7. A requester cannot read another user's request by id (404)", async () => {
    const g = await api("GET", `/library/download-requests/${a1Req.id}`, { token: T.b1 });
    assert(g.status === 404, `got ${g.status}`);
    const own = await api("GET", `/library/download-requests/${b1Req.id}`, { token: T.b1 });
    assert(own.status === 200 && own.body.canDecide === false, `own ${own.status}`);
  });
  await test("8. Changing the file id/filename does not reach another file (A1 approved for One, not Two)", async () => {
    assert((await fileGet(fx.book2, T.a1)).status === 403);
    const acc = await api("GET", `/library/books/${fx.book2.id}/access`, { token: T.a1 });
    assert(acc.body.access.canDownload === false && acc.body.access.status === "none", JSON.stringify(acc.body));
  });
  await test("9. Invalid decision values / ids are refused (400)", async () => {
    assert((await decide(T.admin, b1Req.id, "grant")).status === 400);
    assert((await api("POST", "/library/download-requests/abc/decision", { token: T.admin, body: { decision: "approve" } })).status === 400);
    assert((await api("POST", "/library/books/0/download-requests", { token: T.a1 })).status === 400);
  });
  await test("10. Approval is bound to the file content: a changed file_hash stops the download", async () => {
    const { rows } = await pool.query("SELECT file_hash FROM learning_materials WHERE id = ?", [fx.book1.id]);
    const original = rows[0].file_hash;
    await pool.query("UPDATE learning_materials SET file_hash = ? WHERE id = ?", ["0".repeat(64), fx.book1.id]);
    try {
      assert((await fileGet(fx.book1, T.a1)).status === 403, "old approval still served new content");
      const l = await api("GET", "/library/books", { token: T.a1 });
      const b = l.body.books.find((x) => x.id === fx.book1.id);
      assert(b.access.canDownload === false && b.access.status === "none", JSON.stringify(b.access));
    } finally {
      await pool.query("UPDATE learning_materials SET file_hash = ? WHERE id = ?", [original, fx.book1.id]);
    }
    assert((await fileGet(fx.book1, T.a1)).status === 200, "restored hash should serve again");
  });
  await test("11. A suspended requester's token stops working on the file route", async () => {
    await pool.query("UPDATE user_credentials SET status = 'suspended' WHERE id = ?", [fx.a1]);
    try {
      assert((await fileGet(fx.book1, T.a1)).status === 403);
    } finally {
      await pool.query("UPDATE user_credentials SET status = 'active' WHERE id = ?", [fx.a1]);
    }
  });

  console.log("\nE. Concurrency and data integrity\n");
  await test("10 simultaneous requests by one user for one file -> exactly 1 row, 1 notification per reviewer", async () => {
    const rs = await Promise.all(Array.from({ length: 10 }, () => ask(T.totA, fx.book2)));
    assert(rs.every((r) => r.status === 200 || r.status === 201), rs.map((r) => r.status).join(","));
    assert(rs.filter((r) => r.body.created === true).length === 1, `created: ${rs.filter((r) => r.body.created).length}`);
    const { rows } = await pool.query("SELECT id FROM library_download_requests WHERE requester_id = ? AND requested_material_id = ?", [fx.totA, fx.book2.id]);
    assert(rows.length === 1, `rows: ${rows.length}`);
    assert((await notifCount(fx.admin, "download_request", rows[0].id)) === 1, "admin notifications");
    assert((await notifCount(fx.mtA, "download_request", rows[0].id)) === 1, "mt notifications");
  });
  await test("Two reviewers approve at the same moment -> one 200, one 409, one decision recorded", async () => {
    const row = await latestRequest(fx.totA, fx.book2);
    const [x, y] = await Promise.all([decide(T.admin, row.id, "approve"), decide(T.mtA, row.id, "approve")]);
    const codes = [x.status, y.status].sort().join(",");
    assert(codes === "200,409", codes);
    const { rows } = await pool.query("SELECT COUNT(*) AS c FROM audit_logs WHERE entity_type = 'library_download_requests' AND entity_id = ? AND action IN ('library download approved', 'library download rejected')", [row.id]);
    assert(Number(rows[0].c) === 1, `audit rows: ${rows[0].c}`);
    assert((await notifCount(fx.totA, "library_book", fx.book2.id)) === 1, "requester notified twice");
  });
  await test("Accept and Reject at the same moment -> exactly one wins, the stored status matches the winner", async () => {
    const row = await latestRequest(fx.a2, fx.book1);
    const [acc, rej] = await Promise.all([decide(T.admin, row.id, "approve"), decide(T.mtA, row.id, "reject", "race")]);
    const winner = acc.status === 200 ? "approved" : rej.status === 200 ? "rejected" : null;
    assert(winner && [acc.status, rej.status].sort().join(",") === "200,409", `${acc.status},${rej.status}`);
    assert((await reqRow(row.id)).status === winner, "stored status differs from the winner");
    const f = await fileGet(fx.book1, T.a2);
    assert(f.status === (winner === "approved" ? 200 : 403), `file ${f.status} for ${winner}`);
  });
  await test("Repeated Accept on a decided request -> 409, reviewer/timestamp unchanged", async () => {
    const before = await reqRow(a1Req.id);
    const d = await decide(T.admin, a1Req.id, "approve");
    assert(d.status === 409, `got ${d.status}`);
    const after = await reqRow(a1Req.id);
    assert(String(after.reviewer_id) === String(before.reviewer_id) && String(after.decided_at) === String(before.decided_at), "changed");
  });
  await test("Repeated Reject on a decided request -> 409, nothing changes", async () => {
    const d = await decide(T.mtA, a1Req.id, "reject", "late");
    assert(d.status === 409 && (await reqRow(a1Req.id)).status === "approved", `got ${d.status}`);
  });
  await test("Database failure during the decision rolls everything back (status, audit, notifications)", async () => {
    const row = await latestRequest(fx.b1, fx.book2);
    // Force the decision's LAST write (the requester's notification) to
    // fail: point this one fixture row at an account id that doesn't exist,
    // so the notifications FK rejects the insert after the status UPDATE
    // and the audit INSERT already ran -- a partial commit would show.
    const db = require(path.join(__dirname, "..", "src", "db"));
    const setRequester = async (id) => {
      const c = await db.getRequestClient();
      await c.query("SET FOREIGN_KEY_CHECKS = 0");
      await c.query("UPDATE library_download_requests SET requester_id = ? WHERE id = ?", [id, row.id]);
      await c.query("SET FOREIGN_KEY_CHECKS = 1");
      await db.commitAndRelease(c);
    };
    const { rows: mx } = await pool.query("SELECT MAX(id) + 1000000 AS ghost FROM user_credentials");
    await setRequester(mx[0].ghost);
    let d;
    try {
      d = await decide(T.mtB, row.id, "approve");
    } finally {
      await setRequester(fx.b1);
    }
    assert(d.status === 500, `expected 500, got ${d.status}`);
    const after = await reqRow(row.id);
    assert(after.status === "pending" && after.reviewer_id === null && after.decided_at === null, JSON.stringify(after));
    const { rows } = await pool.query("SELECT COUNT(*) AS c FROM audit_logs WHERE entity_type='library_download_requests' AND entity_id = ? AND action IN ('library download approved', 'library download rejected')", [row.id]);
    assert(Number(rows[0].c) === 0, "audit row survived the rollback");
    assert((await fileGet(fx.book2, T.b1)).status === 403, "file served after failed decision");
    const retry = await decide(T.mtB, row.id, "approve");
    assert(retry.status === 200, `retry ${retry.status}`);
    assert((await fileGet(fx.book2, T.b1)).status === 200, "file not served after successful retry");
  });
  await test("The database itself refuses a second pending row (unique key), even bypassing the API", async () => {
    await ask(T.a1, fx.book2);
    const row = await latestRequest(fx.a1, fx.book2);
    let err = null;
    try {
      await pool.query(
        "INSERT INTO library_download_requests (material_id, requested_material_id, material_title, requester_id, requester_name, requester_role, status) VALUES (?, ?, 'x', ?, 'x', 'trainee', 'pending')",
        [fx.book2.id, fx.book2.id, fx.a1]
      );
    } catch (e) {
      err = e.code;
    }
    assert(err === "ER_DUP_ENTRY", `got ${err}`);
    assert(row.status === "pending");
  });
  await test("The database refuses an invalid status (CHECK)", async () => {
    let err = null;
    try {
      await pool.query("UPDATE library_download_requests SET status = 'granted' WHERE id = ?", [a1Req.id]);
    } catch (e) {
      err = e.code;
    }
    assert(err && /CHECK/.test(err), `got ${err}`);
  });
  await test("Removing a book closes its pending requests (cancelled, kept) and blocks any decision", async () => {
    const pending = await latestRequest(fx.a1, fx.book2);
    const del = await api("DELETE", `/library/books/${fx.book2.id}`, { token: T.mtA });
    assert(del.status === 200, `delete ${del.status}`);
    const row = await reqRow(pending.id);
    assert(row.status === "cancelled" && row.material_id === null && row.material_title === `${P} Book Two`, JSON.stringify(row));
    const d = await decide(T.admin, pending.id, "approve");
    assert(d.status === 409, `decide ${d.status}`);
    const hist = await api("GET", "/library/download-requests?status=decided", { token: T.admin });
    assert(hist.body.requests.some((x) => x.id === pending.id && x.bookAvailable === false), "history lost");
  });

  console.log("\nRequester history / reviewer views\n");
  await test("Requester sees only their own requests in /mine", async () => {
    const r = await api("GET", "/library/download-requests/mine", { token: T.a2 });
    assert(r.status === 200 && r.body.requests.length >= 2 && r.body.requests.every((x) => x.requesterId === fx.a2), JSON.stringify(r.body.requests.map((x) => x.requesterId)));
  });
  await test("Pending count is scoped per reviewer; non-reviewers get 0", async () => {
    const t = await api("GET", "/library/download-requests/pending-count", { token: T.a1 });
    assert(t.body.count === 0 && t.body.reviewer === false, JSON.stringify(t.body));
    const m = await api("GET", "/library/download-requests/pending-count", { token: T.mtA });
    assert(m.body.reviewer === true && Number.isInteger(m.body.count), JSON.stringify(m.body));
  });
  await test("Reviewer search filters by requester name", async () => {
    const r = await api("GET", `/library/download-requests?status=all&q=${encodeURIComponent("Trainee TRB1")}`, { token: T.admin });
    assert(r.body.requests.length >= 1 && r.body.requests.every((x) => x.requesterName === "ZZLDA Trainee TRB1"), JSON.stringify(r.body.requests.map((x) => x.requesterName)));
  });
  await test("Decision history is append-only from the API: there is no edit/delete endpoint", async () => {
    for (const m of ["PUT", "PATCH", "DELETE"]) {
      const r = await api(m, `/library/download-requests/${a1Req.id}`, { token: T.admin });
      assert(r.status === 404, `${m} -> ${r.status}`);
    }
  });

  console.log("\nTearing down ZZLDA fixtures...");
  await wipe();
  const left = await fixtureIds();
  console.log(`Teardown verification: ${left.length} leftover ZZLDA accounts (should be 0).`);

  const failed = results.filter((r) => !r.ok);
  console.log("\n" + "=".repeat(60));
  console.log(`${results.length - failed.length}/${results.length} passed`);
  console.log("=".repeat(60));
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (err) => {
  console.error("FATAL", err);
  try { await wipe(); } catch {}
  process.exit(1);
});
