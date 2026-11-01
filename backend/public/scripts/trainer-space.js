// Trainer Space + Trainer Reports (migration 040): the training team's
// private area -- documents, learning materials, feedback and reports that
// Master Trainers and ToTs share with each other. Trainees never see any of
// it: every item is stored with visibility = 'training_team', which the
// trainee materials feed, the uploads route and every trainee API exclude.
//
// Shared by masterDashborad.html and Totdashboard.html. Relies on the host
// page's own globals: apiRequest, escapeHtml, showToast, UPLOADS, TOKEN_Q.
//
//   TrainerSpace.mount(container, { sections: ["documents","materials","feedback"] })
//   TrainerSpace.mount(container, { sections: ["reports"] })
//   opts.myId: function returning the signed-in trainer's id
(function () {
  const SECTION_LABELS = {
    documents: "Documents",
    materials: "Learning materials",
    feedback: "Feedback",
    reports: "Reports",
  };
  const FILE_TYPES = [
    ["document", "Document"],
    ["worksheet", "Worksheet"],
    ["reading", "Reading"],
    ["image", "Image"],
    ["video", "Video"],
    ["audio", "Audio"],
  ];

  function injectCss() {
    if (document.getElementById("trainer-space-css")) return;
    const style = document.createElement("style");
    style.id = "trainer-space-css";
    style.textContent = `
      .ts-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
      .ts-tabs { display: flex; flex-wrap: wrap; gap: 6px; }
      .ts-tab { border: 1px solid var(--border, #ddd); background: transparent; border-radius: 999px; padding: 5px 12px; font-size: 12.5px; cursor: pointer; color: inherit; }
      .ts-tab.active { background: var(--accent, #6b4fd8); border-color: var(--accent, #6b4fd8); color: #fff; }
      .ts-search { flex: 1 1 180px; min-width: 0; padding: 7px 10px; border: 1px solid var(--border, #ddd); border-radius: 8px; font: inherit; }
      .ts-private { display: inline-flex; gap: 6px; align-items: center; font-size: 12px; color: var(--muted, #777); margin-bottom: 10px; }
      .ts-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
      .ts-item { border: 1px solid var(--border, #e5e5e5); border-radius: 10px; padding: 10px 12px; display: grid; grid-template-columns: 1fr auto; gap: 6px 12px; align-items: start; }
      .ts-item h4 { margin: 0 0 2px; font-size: 14px; overflow-wrap: anywhere; }
      .ts-item p { margin: 0 0 4px; font-size: 12.5px; overflow-wrap: anywhere; }
      .ts-meta { font-size: 11.5px; color: var(--muted, #777); display: flex; flex-wrap: wrap; gap: 4px 10px; }
      .ts-badge { font-size: 10.5px; font-weight: 700; padding: 1px 7px; border-radius: 999px; background: rgba(107,79,216,.12); color: var(--accent, #6b4fd8); }
      .ts-actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
      .ts-actions a, .ts-actions button { font-size: 12px; padding: 5px 9px; border-radius: 7px; border: 1px solid var(--border, #ddd); background: transparent; color: inherit; cursor: pointer; text-decoration: none; white-space: nowrap; }
      .ts-actions .ts-del { color: #c0392b; }
      .ts-form { border: 1px dashed var(--border, #ccc); border-radius: 10px; padding: 12px; margin-bottom: 12px; display: grid; gap: 8px; }
      .ts-form .ts-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
      .ts-form label { font-size: 12px; font-weight: 600; display: grid; gap: 4px; }
      .ts-form input, .ts-form select, .ts-form textarea { font: inherit; padding: 7px 9px; border: 1px solid var(--border, #ddd); border-radius: 8px; min-width: 0; }
      .ts-form .ts-form-actions { display: flex; gap: 8px; justify-content: flex-end; }
      [dir="rtl"] .ts-actions, :root[dir="rtl"] .ts-actions { justify-content: flex-start; }
      @media (max-width: 640px) {
        .ts-item { grid-template-columns: 1fr; }
        .ts-actions { justify-content: flex-start; }
        .ts-form .ts-row { grid-template-columns: 1fr; }
      }`;
    document.head.appendChild(style);
  }

  function fmtDate(d) {
    if (!d) return "";
    const dt = new Date(d);
    return isNaN(dt) ? String(d).slice(0, 10) : dt.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function sharedWithText(item) {
    if (item.sharedWith && item.sharedWith.kind === "trainer") return `Shared with ${item.sharedWith.name || "a trainer"}`;
    return `Shared with the training team${item.sharedWith && item.sharedWith.name ? " of " + item.sharedWith.name : ""}`;
  }

  function itemHtml(item, state) {
    const link =
      item.materialType === "link"
        ? item.externalUrl
        : item.filename
          ? `${UPLOADS}/materials/${encodeURIComponent(item.filename)}${TOKEN_Q}`
          : null;
    const showSection = state.sections.length > 1;
    return `<li class="ts-item" data-id="${item.id}">
      <div>
        <h4 dir="auto">${escapeHtml(item.title)} ${showSection ? `<span class="ts-badge">${escapeHtml(SECTION_LABELS[item.section] || item.section)}</span>` : ""}</h4>
        ${item.description ? `<p dir="auto">${escapeHtml(item.description)}</p>` : ""}
        <div class="ts-meta">
          <span dir="auto"><i class="fa fa-user"></i> ${escapeHtml(item.uploadedBy.name || "")} (${escapeHtml(item.uploadedBy.role)})</span>
          <span><i class="fa fa-calendar"></i> ${fmtDate(item.createdAt)}</span>
          <span dir="auto"><i class="fa fa-lock"></i> ${escapeHtml(sharedWithText(item))}</span>
          ${item.originalName ? `<span dir="auto"><i class="fa fa-paperclip"></i> ${escapeHtml(item.originalName)}</span>` : ""}
        </div>
      </div>
      <div class="ts-actions">
        ${link ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer"><i class="fa fa-${item.materialType === "link" ? "link" : "download"}"></i> Open</a>` : ""}
        ${item.canEdit ? `<button type="button" class="ts-edit"><i class="fa fa-pen"></i> Edit</button>` : ""}
        ${item.canDelete ? `<button type="button" class="ts-del"><i class="fa fa-trash"></i> Delete</button>` : ""}
      </div>
    </li>`;
  }

  async function load(container) {
    const state = container._ts;
    const list = container.querySelector(".ts-list");
    const params = new URLSearchParams();
    if (state.active) params.set("section", state.active);
    const q = container.querySelector(".ts-search").value.trim();
    if (q) params.set("search", q);
    const seq = ++state.seq;
    list.innerHTML = `<li class="empty-state">Loading...</li>`;
    const data = await apiRequest(`/supervisor/team-space?${params}`);
    if (seq !== state.seq) return;
    if (!data) {
      list.innerHTML = `<li class="empty-state">Could not load the Trainer Space.</li>`;
      return;
    }
    // "All" across this page's own sections only (Trainer Reports never
    // mixes into Trainer Space and vice versa).
    const items = (data.items || []).filter((i) => state.sections.includes(i.section));
    state.items = new Map(items.map((i) => [String(i.id), i]));
    list.innerHTML = items.length
      ? items.map((i) => itemHtml(i, state)).join("")
      : `<li class="empty-state">${q ? "Nothing matches your search." : "Nothing shared here yet."}</li>`;
  }

  // Trainers of the caller's own Group (its Master Trainer and ToTs), never
  // the caller -- the backend enforces the same rule.
  async function trainerOptions(myId) {
    const data = await apiRequest("/supervisor/me/eligible-providers");
    return ((data && data.providers) || []).filter((p) => p.kind === "member" && Number(p.supervisorId) !== Number(myId));
  }

  async function openForm(container, item) {
    const state = container._ts;
    const host = container.querySelector(".ts-form-host");
    const editing = !!item;
    const sectionSelect = state.sections
      .map((s) => `<option value="${s}" ${(item ? item.section : state.active || state.sections[0]) === s ? "selected" : ""}>${SECTION_LABELS[s]}</option>`)
      .join("");
    host.innerHTML = `<form class="ts-form">
      <strong>${editing ? "Edit item" : "Share with the training team"}</strong>
      <div class="ts-row">
        <label>Title<input name="title" maxlength="255" required dir="auto" value="${editing ? escapeHtml(item.title) : ""}"></label>
        <label>Section<select name="section" ${state.sections.length === 1 ? "disabled" : ""}>${sectionSelect}</select></label>
      </div>
      <label>Description <span style="font-weight:400;">(optional)</span><textarea name="description" rows="2" dir="auto">${editing && item.description ? escapeHtml(item.description) : ""}</textarea></label>
      ${
        editing
          ? ""
          : `<div class="ts-row">
        <label>Share with<select name="shareWith"><option value="team">The whole training team (Master Trainer and ToTs)</option></select></label>
        <label>Content<select name="kind"><option value="file">Upload a file</option><option value="link">A link</option></select></label>
      </div>
      <div class="ts-row ts-file-row">
        <label>File<input type="file" name="file"></label>
        <label>File type<select name="materialType">${FILE_TYPES.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></label>
      </div>
      <label class="ts-link-row" style="display:none;">Link (https://...)<input type="url" name="externalUrl" dir="ltr"></label>`
      }
      <div class="ts-form-actions">
        <button type="button" class="btn btn-secondary ts-cancel">Cancel</button>
        <button type="submit" class="btn">${editing ? "Save" : "Share"}</button>
      </div>
    </form>`;
    const form = host.querySelector("form");
    form.querySelector(".ts-cancel").onclick = () => (host.innerHTML = "");
    if (!editing) {
      const kind = form.elements.kind;
      kind.onchange = () => {
        form.querySelector(".ts-file-row").style.display = kind.value === "file" ? "" : "none";
        form.querySelector(".ts-link-row").style.display = kind.value === "link" ? "" : "none";
      };
      trainerOptions(state.myId && state.myId()).then((trainers) => {
        const sel = form.elements.shareWith;
        if (!sel) return;
        trainers.forEach((t) => {
          const o = document.createElement("option");
          o.value = String(t.supervisorId);
          o.textContent = `Only ${t.name} (${t.role})`;
          sel.appendChild(o);
        });
      });
    }
    form.onsubmit = async (e) => {
      e.preventDefault();
      const submit = form.querySelector('button[type="submit"]');
      const title = form.elements.title.value.trim();
      const description = form.elements.description.value.trim();
      const section = state.sections.length === 1 ? state.sections[0] : form.elements.section.value;
      if (!title) return showToast("Title is required", "error");
      submit.disabled = true;
      try {
        if (editing) {
          const r = await apiRequest(`/supervisor/team-space/${item.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title, description, section }),
          });
          if (!r) return;
        } else {
          const shareWith = form.elements.shareWith.value;
          const target = shareWith === "team" ? { shareWithGroup: "true" } : { targetSupervisorId: shareWith };
          const idempotencyKey = `ts-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          let r;
          if (form.elements.kind.value === "link") {
            const externalUrl = form.elements.externalUrl.value.trim();
            if (!/^https?:\/\//i.test(externalUrl)) return showToast("Enter a link starting with http:// or https://", "error");
            r = await apiRequest("/supervisor/materials", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ title, description, materialType: "link", externalUrl, teamSection: section, idempotencyKey, ...target }),
            });
          } else {
            const file = form.elements.file.files[0];
            if (!file) return showToast("Choose a file to upload", "error");
            const fd = new FormData();
            Object.entries({ title, description, materialType: form.elements.materialType.value, teamSection: section, idempotencyKey, ...target }).forEach(
              ([k, v]) => fd.append(k, v)
            );
            fd.append("file", file);
            r = await apiRequest("/supervisor/materials", { method: "POST", body: fd });
          }
          if (!r) return;
        }
        host.innerHTML = "";
        showToast(editing ? "Saved" : "Shared with the training team", "success");
        load(container);
      } finally {
        submit.disabled = false;
      }
    };
  }

  async function remove(container, item) {
    if (!confirm(`Delete "${item.title}"? Everyone in the training team loses access to it.`)) return;
    const r = await apiRequest(`/supervisor/materials/${item.id}`, { method: "DELETE" });
    if (r === null) return;
    showToast("Deleted", "success");
    load(container);
  }

  function mount(container, opts) {
    injectCss();
    const sections = (opts && opts.sections) || ["documents", "materials", "feedback"];
    if (container._ts) return load(container);
    container._ts = { sections, myId: opts && opts.myId, active: sections.length === 1 ? sections[0] : null, seq: 0, items: new Map() };
    const tabs =
      sections.length > 1
        ? `<div class="ts-tabs"><button type="button" class="ts-tab active" data-s="">All</button>${sections
            .map((s) => `<button type="button" class="ts-tab" data-s="${s}">${SECTION_LABELS[s]}</button>`)
            .join("")}</div>`
        : "";
    container.innerHTML = `
      <div class="ts-private"><i class="fa fa-lock"></i> Private to the training team -- trainees can't see, open or download anything here.</div>
      <div class="ts-bar">${tabs}<input type="search" class="ts-search" placeholder="Search by title, description or file name" dir="auto">
        <button type="button" class="btn ts-add"><i class="fa fa-plus"></i> ${sections.length === 1 && sections[0] === "reports" ? "Add report" : "Share"}</button></div>
      <div class="ts-form-host"></div>
      <ul class="ts-list"></ul>`;
    container.querySelectorAll(".ts-tab").forEach((b) =>
      b.addEventListener("click", () => {
        container.querySelectorAll(".ts-tab").forEach((x) => x.classList.toggle("active", x === b));
        container._ts.active = b.dataset.s || null;
        load(container);
      })
    );
    let t;
    container.querySelector(".ts-search").addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => load(container), 300);
    });
    container.querySelector(".ts-add").addEventListener("click", () => openForm(container));
    container.querySelector(".ts-list").addEventListener("click", (e) => {
      const li = e.target.closest(".ts-item");
      if (!li) return;
      const item = container._ts.items.get(li.dataset.id);
      if (!item) return;
      if (e.target.closest(".ts-edit")) openForm(container, item);
      else if (e.target.closest(".ts-del")) remove(container, item);
    });
    return load(container);
  }

  window.TrainerSpace = { mount, SECTION_LABELS };
})();
