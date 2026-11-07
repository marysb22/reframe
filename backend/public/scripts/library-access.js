// Library download approval (migration 041) -- the dashboard side.
//
// A Trainee / ToT asks for one Library file ("Request access"); an Admin
// or the Group's Master Trainer accepts or rejects it from the Library's
// "Download requests" panel or straight from the notification bell. The
// backend is the authority: routes/files.js serves a book's bytes only
// for an approved request by that user for that file. Nothing here grants
// access -- it only shows the state the API returns and calls the API.
//
// Shared by AdminDashboard.html, masterDashborad.html, Totdashboard.html
// and PersonalProfile.html. Relies on the host page's own globals:
// apiRequest, escapeHtml, showToast, UPLOADS, TOKEN_Q, and (when present)
// showSection, loadLibrary, libraryBooksRaw, openBookDetails, openBookReader.
//
//   LibraryAccess.onLibraryLoaded(data)        after GET /library/books
//   LibraryAccess.canOpen(book)                 may this account open the file now?
//   LibraryAccess.renderDetailsActions(book, el)  actions area of the details dialog
//   LibraryAccess.cardBadgeHtml(book)           status chip on a shelf card
//   LibraryAccess.decorateNotifications(listEl, notifications)
//   LibraryAccess.handleNotification(type, id)  -> true if it handled the click
(function () {
  // Requester-facing copy, English first with the Arabic line underneath --
  // the same bilingual convention the Library's Restricted Use banner uses
  // on every dashboard (the dashboards have no language switcher).
  const COPY = {
    note: {
      en: "You can open and read every title here. Downloading a file needs approval: open the title and choose Request download; an Admin or your Master Trainer will review it.",
      ar: "يمكنك فتح وقراءة جميع العناوين هنا. تنزيل الملف يحتاج إلى موافقة: افتح العنوان واختر «طلب تنزيل»، وسيقوم المسؤول أو المدرّب الرئيسي بمراجعة طلبك.",
    },
    none: {
      en: "You can open and read this file here. Downloading it requires approval from an Admin or Master Trainer.",
      ar: "يمكنك فتح وقراءة هذا الملف هنا. يتطلب تنزيله موافقة من المسؤول أو المدرّب الرئيسي.",
    },
    pending: {
      en: "Your download request has been submitted. Please wait for approval from an Admin or Master Trainer. You can still open and read the file.",
      ar: "تم إرسال طلب التنزيل. يرجى انتظار موافقة المسؤول أو المدرّب الرئيسي. يمكنك متابعة قراءة الملف.",
    },
    approved: {
      en: "Your download request has been approved. You can now download this file.",
      ar: "تمت الموافقة على طلب التنزيل. يمكنك الآن تنزيل هذا الملف.",
    },
    rejected: {
      en: "Your download request was rejected. Download access has not been granted.",
      ar: "تم رفض طلب التنزيل. لم يتم منح صلاحية التنزيل.",
    },
  };
  const CARD_LABEL = { pending: "Pending", approved: "Approved", rejected: "Rejected" };
  const STATUS_LABEL = { pending: "Pending approval", approved: "Approved", rejected: "Rejected", cancelled: "Closed", granted: "Available" };

  let isReviewer = false;
  let reviewerState = { status: "pending", q: "", timer: null };

  function esc(s) {
    return typeof escapeHtml === "function" ? escapeHtml(s == null ? "" : String(s)) : String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function bi(key) {
    const c = COPY[key];
    return `<span class="lda-en">${esc(c.en)}</span><span class="lda-ar" lang="ar" dir="rtl">${esc(c.ar)}</span>`;
  }
  function fmtDateTime(d) {
    if (!d) return "";
    const dt = new Date(String(d).replace(" ", "T"));
    if (isNaN(dt)) return String(d);
    return dt.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  function toast(msg, type) {
    if (typeof showToast === "function") showToast(msg, type);
  }

  function injectCss() {
    if (document.getElementById("library-access-css")) return;
    const style = document.createElement("style");
    style.id = "library-access-css";
    style.textContent = `
      .lda-ar { display: block; margin-top: 3px; font-size: .94em; color: var(--muted); text-align: right; }
      .lda-note { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; margin-top: 12px; border: 1px solid var(--border); border-radius: var(--radius-sm, 10px); background: var(--surface-2, #fafbfa); font-size: 12.5px; color: var(--text); line-height: 1.5; }
      .lda-note > i { color: var(--primary); margin-top: 2px; }
      .lda-note-body { flex: 1; min-width: 0; }
      .lda-linkbtn { background: none; border: 0; padding: 0; margin-top: 6px; font: inherit; font-weight: 600; color: var(--primary); cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
      .lda-linkbtn:focus-visible, .lda-btn:focus-visible, .lda-seg button:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }

      .lda-pill { display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; border-radius: 999px; font-size: 11.5px; font-weight: 600; white-space: nowrap; line-height: 1.6; }
      .lda-pill::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
      .lda-pill.pending { background: var(--warning-bg); color: var(--warning); }
      .lda-pill.approved, .lda-pill.granted { background: var(--success-bg); color: var(--success); }
      .lda-pill.rejected { background: var(--danger-bg); color: var(--danger); }
      .lda-pill.locked::before { display: none; }
      .lda-pill.cancelled { background: var(--surface-2, #f2f4f3); color: var(--muted); }

      .book-cover .lda-card-badge { position: absolute; left: 6px; top: 6px; z-index: 2; box-shadow: 0 1px 2px rgba(15,27,30,.12); }
      [dir="rtl"] .book-cover .lda-card-badge { left: auto; right: 6px; }

      .lda-access { margin-top: 4px; }
      .lda-state { border: 1px solid var(--border); border-radius: var(--radius-sm, 10px); padding: 12px 14px; font-size: 13px; line-height: 1.5; background: var(--surface); }
      .lda-state.pending { border-color: #F1DDB8; background: #FFFBF3; }
      .lda-state.rejected { border-color: #F0CFCB; background: #FFF8F7; }
      .lda-state.approved { border-color: #CBE7D6; background: #F6FCF8; }
      .lda-state-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
      .lda-state-meta { font-size: 11.5px; color: var(--muted); }
      .lda-reason { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border-soft, #eef2f1); font-size: 12.5px; color: var(--text); overflow-wrap: anywhere; }
      .lda-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
      .lda-actions .btn { flex: none; width: auto; margin: 0; text-decoration: none; display: inline-flex; align-items: center; gap: 8px; }

      .lda-panel { margin-top: 14px; border: 1px solid var(--border); border-radius: var(--radius-md, 14px); background: var(--surface); }
      .lda-panel-head { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--border-soft, #eef2f1); flex-wrap: wrap; }
      .lda-panel-title { font-size: 14px; font-weight: 700; color: var(--text); display: flex; align-items: center; gap: 8px; margin-right: auto; }
      [dir="rtl"] .lda-panel-title { margin-right: 0; margin-left: auto; }
      .lda-count { min-width: 20px; height: 20px; padding: 0 6px; border-radius: 999px; background: var(--warning-bg); color: var(--warning); font-size: 11.5px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }
      .lda-count.zero { background: var(--surface-2, #f2f4f3); color: var(--muted); }
      .lda-seg { display: inline-flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
      .lda-seg button { border: 0; background: transparent; padding: 6px 12px; font: inherit; font-size: 12.5px; color: var(--muted); cursor: pointer; }
      .lda-seg button + button { border-left: 1px solid var(--border); }
      [dir="rtl"] .lda-seg button + button { border-left: 0; border-right: 1px solid var(--border); }
      .lda-seg button[aria-pressed="true"] { background: var(--primary); color: #fff; font-weight: 600; }
      .lda-search { flex: 0 1 220px; min-width: 0; padding: 7px 10px; border: 1px solid var(--border); border-radius: 8px; font: inherit; font-size: 12.5px; background: var(--surface); color: var(--text); }
      .lda-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
      .lda-table th { text-align: start; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--faint, #8b9997); padding: 8px 14px; border-bottom: 1px solid var(--border-soft, #eef2f1); white-space: nowrap; }
      .lda-table td { padding: 10px 14px; border-bottom: 1px solid var(--border-soft, #eef2f1); vertical-align: top; color: var(--text); }
      .lda-table tr:last-child td { border-bottom: 0; }
      .lda-table tr.lda-flash td { background: #FFFBF3; }
      .lda-strong { font-weight: 600; overflow-wrap: anywhere; }
      .lda-sub { color: var(--muted); font-size: 11.5px; margin-top: 2px; overflow-wrap: anywhere; }
      .lda-row-actions { display: flex; gap: 6px; justify-content: flex-end; flex-wrap: wrap; }
      .lda-btn { border: 1px solid var(--border); background: var(--surface); color: var(--text); border-radius: 8px; padding: 6px 12px; font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer; white-space: nowrap; }
      .lda-btn.accept { background: var(--primary); border-color: var(--primary); color: #fff; }
      .lda-btn.accept:hover { background: var(--primary-dark, #215e5a); }
      .lda-btn.reject { color: var(--danger); }
      .lda-btn.reject:hover { background: var(--danger-bg); border-color: #F0CFCB; }
      .lda-btn[disabled] { opacity: .55; cursor: default; }
      .lda-empty { padding: 22px 14px; text-align: center; color: var(--muted); font-size: 12.5px; }

      .lda-mine { margin-top: 10px; font-size: 12.5px; }
      .lda-mine summary { cursor: pointer; color: var(--primary); font-weight: 600; width: fit-content; }
      .lda-mine ul { list-style: none; padding: 0; margin: 8px 0 0; border: 1px solid var(--border); border-radius: var(--radius-sm, 10px); }
      .lda-mine li { display: flex; justify-content: space-between; gap: 10px; padding: 9px 12px; border-bottom: 1px solid var(--border-soft, #eef2f1); align-items: flex-start; }
      .lda-mine li:last-child { border-bottom: 0; }

      .notif-item .lda-notif { margin-top: 8px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }

      .lda-dialog-overlay { position: fixed; inset: 0; background: rgba(15,27,30,.45); display: flex; align-items: center; justify-content: center; padding: 16px; z-index: 10050; }
      .lda-dialog { background: var(--surface); border-radius: var(--radius-md, 14px); box-shadow: var(--shadow-pop); width: 100%; max-width: 440px; max-height: calc(100vh - 32px); overflow: auto; padding: 20px; }
      .lda-dialog h4 { margin: 0 0 12px; font-size: 16px; color: var(--text); }
      .lda-dialog dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 14px; margin: 0 0 14px; font-size: 13px; }
      .lda-dialog dt { color: var(--muted); }
      .lda-dialog dd { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
      .lda-dialog label { display: block; font-size: 12px; font-weight: 600; margin-bottom: 4px; color: var(--text); }
      .lda-dialog textarea { width: 100%; box-sizing: border-box; min-height: 70px; resize: vertical; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; font: inherit; font-size: 13px; }
      .lda-dialog .lda-hint { font-size: 11.5px; color: var(--muted); margin-top: 4px; }
      .lda-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
      .lda-btn.danger-solid { background: var(--danger); border-color: var(--danger); color: #fff; }

      .lda-nav-count { margin-inline-start: auto; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px; background: var(--warning); color: #fff; font-size: 10.5px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }

      @media (max-width: 720px) {
        .lda-table thead { display: none; }
        .lda-table, .lda-table tbody, .lda-table tr, .lda-table td { display: block; width: 100%; box-sizing: border-box; }
        .lda-table tr { padding: 10px 14px; border-bottom: 1px solid var(--border-soft, #eef2f1); }
        .lda-table tr:last-child { border-bottom: 0; }
        .lda-table td { padding: 2px 0; border: 0; }
        .lda-table td[data-label]::before { content: attr(data-label); display: block; font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em; color: var(--faint, #8b9997); margin-top: 6px; }
        .lda-row-actions { justify-content: flex-start; margin-top: 8px; }
        .lda-row-actions .lda-btn { flex: 1 1 0; padding: 9px 12px; }
        .lda-search { flex: 1 1 100%; }
        .lda-panel-title { margin-right: 0; flex: 1 1 auto; }
        .lda-dialog dl { grid-template-columns: 1fr; gap: 2px; }
        .lda-dialog dd { margin-bottom: 6px; }
      }`;
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------- requester

  // Reading is open to everyone who can see the Library; only downloading
  // needs an approval (the file route enforces both).
  function canOpen(book) {
    return !!(book && book.filename);
  }
  function canDownload(book) {
    if (!book || !book.filename) return false;
    const a = book.access;
    if (!a) return true;
    return a.canDownload === true || a.status === "granted" || a.status === "approved";
  }

  function cardBadgeHtml(book) {
    const a = book && book.access;
    if (!a || !a.required || a.status === "none") return "";
    if (!CARD_LABEL[a.status]) return "";
    return `<span class="lda-pill ${esc(a.status)} lda-card-badge" title="${esc(STATUS_LABEL[a.status])}">${esc(CARD_LABEL[a.status])}</span>`;
  }

  function readButtonHtml(book, primary) {
    return `<button type="button" class="btn${primary ? "" : " btn-secondary"}" style="flex:none;" onclick="closeModal('bookDetailsModal'); openBookReader(${Number(book.id)});"><i class="fa fa-book-open"></i> Open &amp; Read</button>`;
  }

  function grantedActionsHtml(book) {
    const fileUrl = `${UPLOADS}/materials/${encodeURIComponent(book.filename)}${TOKEN_Q}&mode=download`;
    return `
      <div class="modal-actions" style="justify-content:flex-start;">
        ${readButtonHtml(book, true)}
        <a class="btn btn-secondary" style="flex:none;text-decoration:none;" href="${fileUrl}" download="${esc(book.originalName || "")}"><i class="fa fa-download"></i> Download</a>
      </div>`;
  }

  // Open & Read always; Download replaced by the request action.
  function readOnlyActionsHtml(book, requestLabel, requestIcon) {
    return `
      <div class="lda-actions">
        ${book.filename ? readButtonHtml(book, true) : ""}
        ${requestLabel ? `<button type="button" class="btn btn-secondary" data-lda-request="${Number(book.id)}"><i class="fa ${requestIcon}"></i> ${requestLabel}</button>` : ""}
      </div>`;
  }

  function detailsActionsHtml(book) {
    const a = book.access || { required: false, status: "granted" };
    if (a.status === "granted") return grantedActionsHtml(book);
    if (a.status === "approved" && book.filename) {
      return `
        <div class="lda-access">
          <div class="lda-state approved">
            <div class="lda-state-head"><span class="lda-pill approved">Approved</span>${a.decidedAt ? `<span class="lda-state-meta">${esc(fmtDateTime(a.decidedAt))}</span>` : ""}</div>
            ${bi("approved")}
          </div>
          ${grantedActionsHtml(book)}
        </div>`;
    }
    if (a.status === "pending") {
      return `
        <div class="lda-access">
          <div class="lda-state pending" role="status">
            <div class="lda-state-head"><span class="lda-pill pending">Pending approval</span>${a.requestedAt ? `<span class="lda-state-meta">Requested ${esc(fmtDateTime(a.requestedAt))}</span>` : ""}</div>
            ${bi("pending")}
          </div>
          ${readOnlyActionsHtml(book, null)}
        </div>`;
    }
    if (a.status === "rejected") {
      return `
        <div class="lda-access">
          <div class="lda-state rejected" role="status">
            <div class="lda-state-head"><span class="lda-pill rejected">Rejected</span>${a.decidedAt ? `<span class="lda-state-meta">${esc(fmtDateTime(a.decidedAt))}</span>` : ""}</div>
            ${bi("rejected")}
            ${a.rejectionReason ? `<div class="lda-reason"><strong>Reason:</strong> ${esc(a.rejectionReason)}</div>` : ""}
          </div>
          ${readOnlyActionsHtml(book, "Request download again", "fa-rotate-right")}
        </div>`;
    }
    return `
      <div class="lda-access">
        <div class="lda-state">
          <div class="lda-state-head"><span class="lda-pill cancelled locked"><i class="fa fa-lock" aria-hidden="true"></i> Download needs approval</span></div>
          ${bi("none")}
        </div>
        ${readOnlyActionsHtml(book, "Request download", "fa-download")}
      </div>`;
  }

  function applyAccess(book, access, filename) {
    book.access = access;
    if (filename) book.filename = filename;
    if (typeof applyLibraryFilters === "function") {
      try { applyLibraryFilters(); } catch (e) { /* the shelf just keeps its old chip */ }
    }
  }

  function wireDetails(book, el) {
    el.innerHTML = detailsActionsHtml(book);
    const btn = el.querySelector("[data-lda-request]");
    if (btn) btn.addEventListener("click", () => submitRequest(book, el, btn));
  }

  async function renderDetailsActions(book, el) {
    if (!el) return;
    wireDetails(book, el);
    if (!book.access || !book.access.required) return;
    // Re-read the live state: the list may be minutes old (an approval
    // can arrive while the page is open).
    const fresh = await apiRequest(`/library/books/${Number(book.id)}/access`);
    if (!fresh || !el.isConnected) return;
    applyAccess(book, fresh.access, fresh.filename);
    wireDetails(book, el);
  }

  async function submitRequest(book, el, btn) {
    btn.disabled = true;
    const original = btn.innerHTML;
    btn.innerHTML = `<i class="fa fa-spinner fa-spin"></i> Sending...`;
    const r = await apiRequest(`/library/books/${Number(book.id)}/download-requests`, { method: "POST" });
    if (!r) {
      btn.disabled = false;
      btn.innerHTML = original;
      return;
    }
    const fresh = await apiRequest(`/library/books/${Number(book.id)}/access`);
    if (fresh) applyAccess(book, fresh.access, fresh.filename);
    else applyAccess(book, r.access, book.filename);
    wireDetails(book, el);
    loadMine();
  }

  async function loadMine() {
    const host = document.getElementById("ldaMine");
    if (!host) return;
    const data = await apiRequest("/library/download-requests/mine");
    if (!data) return;
    if (!data.requests.length) {
      host.innerHTML = "";
      return;
    }
    const open = host.querySelector("details") && host.querySelector("details").open;
    host.innerHTML = `
      <details class="lda-mine"${open ? " open" : ""}>
        <summary>My download requests (${data.requests.length})</summary>
        <ul>${data.requests
          .map(
            (r) => `<li>
              <div style="min-width:0;">
                <div class="lda-strong">${esc(r.title)}</div>
                <div class="lda-sub">Requested ${esc(fmtDateTime(r.createdAt))}${r.decidedAt && r.status !== "pending" ? ` · Decided ${esc(fmtDateTime(r.decidedAt))}` : ""}${r.rejectionReason ? ` · Reason: ${esc(r.rejectionReason)}` : ""}</div>
              </div>
              <span class="lda-pill ${esc(r.status)}">${esc(STATUS_LABEL[r.status] || r.status)}</span>
            </li>`
          )
          .join("")}</ul>
      </details>`;
  }

  // ----------------------------------------------------------------- reviewer

  function confirmDialog({ title, request, decision }) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "lda-dialog-overlay";
      overlay.innerHTML = `
        <div class="lda-dialog" role="dialog" aria-modal="true" aria-labelledby="ldaDialogTitle">
          <h4 id="ldaDialogTitle">${esc(title)}</h4>
          <dl>
            <dt>Requested by</dt><dd>${esc(request.requesterName)} · ${esc(request.requesterRoleLabel)}</dd>
            <dt>File</dt><dd>${esc(request.title)}${request.originalName ? `<div class="lda-sub">${esc(request.originalName)}</div>` : ""}</dd>
            <dt>Group</dt><dd>${esc(request.groupName || "No group")}</dd>
            <dt>Requested</dt><dd>${esc(fmtDateTime(request.createdAt))}</dd>
          </dl>
          ${decision === "reject" ? `
            <label for="ldaReason">Reason (optional)</label>
            <textarea id="ldaReason" maxlength="500" placeholder="Shared with the requester"></textarea>
            <div class="lda-hint">The requester will see this reason.</div>` : `
            <div class="lda-hint">Only ${esc(request.requesterName)} will be able to download this file.</div>`}
          <div class="lda-dialog-actions">
            <button type="button" class="lda-btn" data-act="cancel">Cancel</button>
            <button type="button" class="lda-btn ${decision === "reject" ? "danger-solid" : "accept"}" data-act="ok">${decision === "reject" ? "Reject request" : "Accept request"}</button>
          </div>
        </div>`;
      const prevFocus = document.activeElement;
      const close = (value) => {
        overlay.remove();
        document.removeEventListener("keydown", onKey, true);
        if (prevFocus && prevFocus.focus) prevFocus.focus();
        resolve(value);
      };
      const onKey = (e) => {
        if (e.key === "Escape") { e.stopPropagation(); close(null); }
      };
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) close(null);
        const act = e.target.closest && e.target.closest("[data-act]");
        if (!act) return;
        if (act.dataset.act === "cancel") close(null);
        else {
          const reasonEl = overlay.querySelector("#ldaReason");
          close({ reason: reasonEl ? reasonEl.value.trim() : null });
        }
      });
      document.addEventListener("keydown", onKey, true);
      document.body.appendChild(overlay);
      const first = overlay.querySelector(decision === "reject" ? "#ldaReason" : '[data-act="ok"]');
      if (first) first.focus();
    });
  }

  async function decide(request, decision) {
    const answer = await confirmDialog({
      title: decision === "reject" ? "Reject download request?" : "Accept download request?",
      request,
      decision,
    });
    if (!answer) return null;
    const r = await apiRequest(`/library/download-requests/${Number(request.id)}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, reason: answer.reason || undefined }),
    });
    // 409 (already decided by someone else) arrives here as null with a
    // toast already shown -- refresh either way so the row shows the truth.
    refreshReviewer();
    refreshNavCount();
    if (r) toast(decision === "approve" ? `Approved -- ${request.requesterName} can now download this file.` : "Request rejected.", "info");
    return r ? r.request : null;
  }

  function reviewerRowHtml(r) {
    const pending = r.status === "pending";
    return `
      <tr data-lda-row="${Number(r.id)}">
        <td data-label="Requested by"><div class="lda-strong">${esc(r.requesterName)}</div><div class="lda-sub">${esc(r.requesterRoleLabel)}${r.groupName ? ` · ${esc(r.groupName)}` : ""}</div></td>
        <td data-label="File"><div class="lda-strong">${esc(r.title)}</div><div class="lda-sub">${esc(r.originalName || "")}${r.bookAvailable ? "" : " · removed from the Library"}</div></td>
        <td data-label="Requested"><div>${esc(fmtDateTime(r.createdAt))}</div></td>
        <td data-label="Status"><span class="lda-pill ${esc(r.status)}">${esc(STATUS_LABEL[r.status] || r.status)}</span>${
          !pending && r.reviewerName ? `<div class="lda-sub">by ${esc(r.reviewerName)}${r.decidedAt ? ` · ${esc(fmtDateTime(r.decidedAt))}` : ""}</div>` : ""
        }${r.rejectionReason ? `<div class="lda-sub">Reason: ${esc(r.rejectionReason)}</div>` : ""}</td>
        <td>${pending && r.bookAvailable ? `<div class="lda-row-actions">
          <button type="button" class="lda-btn accept" data-lda-decide="approve" data-id="${Number(r.id)}">Accept</button>
          <button type="button" class="lda-btn reject" data-lda-decide="reject" data-id="${Number(r.id)}">Reject</button>
        </div>` : ""}</td>
      </tr>`;
  }

  let reviewerRows = [];

  async function refreshReviewer(flashId) {
    const body = document.getElementById("ldaReviewerBody");
    if (!body) return;
    const qs = new URLSearchParams({ status: reviewerState.status });
    if (reviewerState.q) qs.set("q", reviewerState.q);
    const data = await apiRequest(`/library/download-requests?${qs}`);
    if (!data) {
      body.innerHTML = `<div class="lda-empty">Couldn't load download requests.</div>`;
      return;
    }
    reviewerRows = data.requests;
    if (!reviewerRows.length) {
      body.innerHTML = `<div class="lda-empty">${
        reviewerState.q ? "No requests match your search." : reviewerState.status === "pending" ? "No requests are waiting for review." : "No decided requests yet."
      }</div>`;
    } else {
      body.innerHTML = `
        <table class="lda-table">
          <thead><tr><th>Requested by</th><th>File</th><th>Requested</th><th>Status</th><th><span class="sr-only" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);">Actions</span></th></tr></thead>
          <tbody>${reviewerRows.map(reviewerRowHtml).join("")}</tbody>
        </table>`;
    }
    if (flashId) {
      const row = body.querySelector(`[data-lda-row="${Number(flashId)}"]`);
      if (row) {
        row.classList.add("lda-flash");
        row.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }
    const count = document.getElementById("ldaPendingCount");
    if (count && reviewerState.status === "pending" && !reviewerState.q) {
      count.textContent = String(reviewerRows.length);
      count.classList.toggle("zero", reviewerRows.length === 0);
    }
  }

  function mountReviewer(host) {
    host.innerHTML = `
      <section class="lda-panel" aria-labelledby="ldaPanelTitle">
        <div class="lda-panel-head">
          <div class="lda-panel-title" id="ldaPanelTitle"><i class="fa fa-inbox" aria-hidden="true" style="color:var(--primary);"></i>Download requests <span class="lda-count zero" id="ldaPendingCount">0</span></div>
          <div class="lda-seg" role="group" aria-label="Filter requests">
            <button type="button" data-lda-filter="pending" aria-pressed="true">Pending</button>
            <button type="button" data-lda-filter="decided" aria-pressed="false">History</button>
          </div>
          <input type="search" class="lda-search" id="ldaSearch" placeholder="Search name, file or group" aria-label="Search download requests">
        </div>
        <div id="ldaReviewerBody"><div class="lda-empty">Loading...</div></div>
      </section>`;
    host.querySelectorAll("[data-lda-filter]").forEach((b) =>
      b.addEventListener("click", () => {
        reviewerState.status = b.dataset.ldaFilter;
        host.querySelectorAll("[data-lda-filter]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
        refreshReviewer();
      })
    );
    host.querySelector("#ldaSearch").addEventListener("input", (e) => {
      clearTimeout(reviewerState.timer);
      reviewerState.timer = setTimeout(() => {
        reviewerState.q = e.target.value.trim();
        refreshReviewer();
      }, 250);
    });
    host.addEventListener("click", (e) => {
      const btn = e.target.closest && e.target.closest("[data-lda-decide]");
      if (!btn) return;
      const req = reviewerRows.find((r) => Number(r.id) === Number(btn.dataset.id));
      if (req) decide(req, btn.dataset.ldaDecide);
    });
    refreshReviewer();
  }

  async function refreshNavCount() {
    if (!isReviewer) return;
    const data = await apiRequest("/library/download-requests/pending-count");
    if (!data) return;
    const link = document.querySelector('a[data-section="library"]');
    if (!link) return;
    let badge = link.querySelector(".lda-nav-count");
    if (!data.count) {
      if (badge) badge.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "lda-nav-count";
      badge.setAttribute("aria-label", "pending download requests");
      link.appendChild(badge);
    }
    badge.textContent = data.count > 99 ? "99+" : String(data.count);
  }

  // ------------------------------------------------------------------ library

  function onLibraryLoaded(data) {
    injectCss();
    isReviewer = !!(data && data.reviewer);
    const host = document.getElementById("libraryAccessPanel");
    if (!host) return;
    const needsApproval = data && data.books && data.books.some((b) => b.access && b.access.required);
    if (isReviewer) {
      if (!host.querySelector(".lda-panel")) mountReviewer(host);
      else refreshReviewer();
      refreshNavCount();
    } else if (needsApproval) {
      if (!host.querySelector(".lda-note")) {
        host.innerHTML = `
          <div class="lda-note"><i class="fa fa-lock" aria-hidden="true"></i><div class="lda-note-body">${bi("note")}<div id="ldaMine"></div></div></div>`;
      }
      loadMine();
    } else {
      host.innerHTML = "";
    }
  }

  // ------------------------------------------------------------ notifications

  async function decorateNotifications(listEl, notifications) {
    if (!listEl || !Array.isArray(notifications)) return;
    injectCss();
    const items = Array.from(listEl.querySelectorAll(".notif-item"));
    const pairs = notifications
      .map((n, i) => ({ n, el: items[i] }))
      .filter((p) => p.el && p.n.relatedEntityType === "download_request" && p.n.relatedEntityId);
    if (!pairs.length) return;
    const ids = [...new Set(pairs.map((p) => Number(p.n.relatedEntityId)))];
    const data = await apiRequest(`/library/download-requests?status=all&ids=${ids.join(",")}`);
    if (!data) return;
    const byId = new Map(data.requests.map((r) => [Number(r.id), r]));
    for (const { n, el } of pairs) {
      const r = byId.get(Number(n.relatedEntityId));
      if (!r || !el.isConnected) continue;
      const slot = document.createElement("div");
      slot.className = "lda-notif";
      const target = el.querySelector(".ni-time") ? el.querySelector(".ni-time").parentNode : el;
      if (r.status === "pending" && r.bookAvailable) {
        slot.innerHTML = `
          <button type="button" class="lda-btn accept" data-act="approve">Accept</button>
          <button type="button" class="lda-btn reject" data-act="reject">Reject</button>`;
        slot.addEventListener("click", async (e) => {
          const b = e.target.closest("[data-act]");
          e.stopPropagation();
          if (!b) return;
          const updated = await decide(r, b.dataset.act);
          if (updated) {
            slot.innerHTML = `<span class="lda-pill ${esc(updated.status)}">${esc(STATUS_LABEL[updated.status])}</span>`;
            if (typeof loadNotifUnreadCount === "function") loadNotifUnreadCount();
          }
        });
      } else {
        slot.innerHTML = `<span class="lda-pill ${esc(r.status)}">${esc(STATUS_LABEL[r.status] || r.status)}</span>${
          r.reviewerName && r.status !== "pending" ? `<span class="lda-sub">by ${esc(r.reviewerName)}</span>` : ""
        }`;
      }
      target.appendChild(slot);
    }
  }

  async function openLibraryThen(fn) {
    if (typeof showSection === "function") showSection("library");
    if (typeof loadLibrary === "function") await loadLibrary();
    if (fn) fn();
  }

  // Returns true when the click was a download-approval notification.
  function handleNotification(type, id) {
    if (type === "download_request") {
      openLibraryThen(() => {
        reviewerState.status = "pending";
        reviewerState.q = "";
        const host = document.getElementById("libraryAccessPanel");
        if (host) host.querySelectorAll("[data-lda-filter]").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.ldaFilter === "pending")));
        refreshReviewer(id);
      });
      return true;
    }
    if (type === "library_book") {
      openLibraryThen(() => {
        const list = typeof libraryBooksRaw !== "undefined" ? libraryBooksRaw : [];
        if (id && list.some((b) => Number(b.id) === Number(id)) && typeof openBookDetails === "function") openBookDetails(Number(id));
      });
      return true;
    }
    return false;
  }

  // The reader overlay's own Download button: shown (as a real download)
  // only with approval, hidden otherwise.
  function prepareReader(book) {
    const link = document.getElementById("readerDownload");
    if (!link) return;
    if (canDownload(book)) {
      link.href = `${UPLOADS}/materials/${encodeURIComponent(book.filename)}${TOKEN_Q}&mode=download`;
      link.style.display = "";
    } else {
      link.removeAttribute("href");
      link.style.display = "none";
    }
  }

  // A file type the browser can't display, opened without download approval.
  function readOnlyUnsupportedHtml(book) {
    return `
      <div style="text-align:center;padding:32px 24px;background:#fff;border-radius:14px;max-width:380px;">
        <i class="fa fa-lock" style="font-size:32px;color:var(--faint);margin-bottom:14px;display:block;"></i>
        <p style="margin:0 0 6px;color:var(--text);font-size:13.5px;">This file type can't be shown in the browser.</p>
        <p style="margin:0;color:var(--muted);font-size:12.5px;">To get the file, request a download from the title's details. An Admin or Master Trainer will review it.</p>
      </div>`;
  }

  window.LibraryAccess = {
    onLibraryLoaded,
    canOpen,
    canDownload,
    prepareReader,
    readOnlyUnsupportedHtml,
    cardBadgeHtml,
    renderDetailsActions,
    decorateNotifications,
    handleNotification,
    refreshNavCount,
  };
})();
