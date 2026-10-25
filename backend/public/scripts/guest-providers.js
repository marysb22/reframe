// "Hours Provided By" selector shared by the Master Trainer and ToT
// dashboards (migration 038 -- Guest Trainers). Replaces each dashboard's
// own copy of renderProvidedByOptions' roster-only dropdown with one that
// also offers the Group's Guest Trainers and session-only external
// trainers, plus an inline "Add external trainer" action.
//
// Option values are provider KEYS: "s:<supervisorId>" for an internal
// trainer account (a Group member or another Group's trainer associated as
// a Guest Trainer) and "g:<guestTrainerId>" for an external Guest Trainer
// with no Reframe login. readProviderSelect() turns a key back into the
// { providedBySupervisorId, providedByGuestTrainerId } pair the API takes --
// exactly one of the two is ever set.
//
// Since migration 039 there is a third, independent provider kind:
// External Trainers ("e:<externalTrainerId>") -- someone from outside the
// organization/Group, never on a Group roster, recorded via its own
// "+ Add External Trainer (outside organization)" action and its own
// endpoint. The Guest Trainer options and "+ Add external trainer..." flow
// above are unchanged. Exactly one of providedBySupervisorId /
// providedByGuestTrainerId / providedByExternalTrainerId is ever set.
//
// Relies on the host page's own globals: apiRequest, escapeHtml,
// openModal/closeModal, showToast.
(function () {
  const ADD_EXTERNAL = "__add_external__";
  const ADD_OUTSIDE = "__add_outside_external__";
  let roster = null;
  let rosterPromise = null;

  function loadProviders(force) {
    if (force) {
      roster = null;
      rosterPromise = null;
    }
    if (roster) return Promise.resolve(roster);
    if (!rosterPromise) {
      rosterPromise = apiRequest("/supervisor/me/eligible-providers").then((data) => {
        roster = (data && data.providers) || [];
        rosterPromise = null;
        return roster;
      });
    }
    return rosterPromise;
  }

  /** Normalizes whatever an API response stored into a key ("s:12" / "g:5" / "e:3"), or null. */
  function providerKey(sel) {
    if (sel == null || sel === "") return null;
    if (typeof sel === "string" && /^[sge]:\d+$/.test(sel)) return sel;
    if (typeof sel === "number" || /^\d+$/.test(String(sel))) return `s:${Number(sel)}`;
    if (sel.externalTrainerId != null) return `e:${Number(sel.externalTrainerId)}`;
    if (sel.providedByExternalTrainerId != null) return `e:${Number(sel.providedByExternalTrainerId)}`;
    if (sel.guestTrainerId != null) return `g:${Number(sel.guestTrainerId)}`;
    if (sel.providedByGuestTrainerId != null) return `g:${Number(sel.providedByGuestTrainerId)}`;
    if (sel.supervisorId != null) return `s:${Number(sel.supervisorId)}`;
    if (sel.providedBySupervisorId != null) return `s:${Number(sel.providedBySupervisorId)}`;
    if (sel.id != null) return `s:${Number(sel.id)}`;
    return null;
  }

  function myKey() {
    try {
      const u = JSON.parse(localStorage.getItem("user") || localStorage.getItem("reframe_user") || "{}");
      return u && u.id ? `s:${Number(u.id)}` : null;
    } catch {
      return null;
    }
  }

  function optionLabel(p) {
    const org = p.organization ? ` (${p.organization})` : "";
    return `${p.role} — ${p.name}${org}`;
  }

  /**
   * Fills `selectEl`. `selected` may be a key, a numeric supervisor id, or
   * an API provider object ({id, guestTrainerId, name}). opts:
   *   filter(p)          -- limit which providers are offered
   *   defaultKey         -- used when nothing is selected (default: me)
   *   allowAddExternal   -- show "+ Add external trainer..." (default true)
   *   fallbackName       -- display name if the stored provider is no longer eligible
   */
  async function renderProviderSelect(selectEl, selected, opts = {}) {
    const list = (await loadProviders()).filter((p) => (opts.filter ? opts.filter(p) : true));
    const wanted = providerKey(selected) || opts.defaultKey || myKey();
    const groups = [
      { label: "Group Trainers", items: list.filter((p) => p.kind === "member") },
      { label: "Guest Trainers", items: list.filter((p) => p.kind === "internal_guest" || p.kind === "external_guest") },
      { label: "External Trainers (session only)", items: list.filter((p) => p.kind === "session_only") },
      { label: "External Trainers (outside organization)", items: list.filter((p) => p.kind === "external") },
    ];
    let html = "";
    let found = false;
    for (const g of groups) {
      if (!g.items.length) continue;
      html += `<optgroup label="${escapeHtml(g.label)}">`;
      for (const p of g.items) {
        const isSel = p.key === wanted;
        if (isSel) found = true;
        html += `<option value="${p.key}" dir="auto" ${isSel ? "selected" : ""}>${escapeHtml(optionLabel(p))}</option>`;
      }
      html += "</optgroup>";
    }
    // A stored provider who is no longer eligible (left the Group, or their
    // Guest association was removed) must still show -- and stay selected --
    // when editing an old Session; the server accepts it unchanged.
    if (!found && wanted && providerKey(selected)) {
      const prev = selectEl._gpFallback && selectEl._gpFallback.key === wanted ? selectEl._gpFallback.name : null;
      const name = opts.fallbackName || (selected && selected.name) || prev || "Previous provider";
      selectEl._gpFallback = { key: wanted, name };
      html = `<option value="${wanted}" selected dir="auto">${escapeHtml(name)} (no longer in this Group)</option>` + html;
    }
    if (opts.allowAddExternal !== false) {
      html += `<option value="${ADD_EXTERNAL}">+ Add external trainer…</option>`;
    }
    if (opts.allowAddOutside !== false) {
      html += `<option value="${ADD_OUTSIDE}">+ Add External Trainer (outside organization)…</option>`;
    }
    selectEl.innerHTML = html;
    selectEl._gpOpts = opts;
    selectEl.dataset.lastValue = selectEl.value;
    if (!selectEl.dataset.guestBound) {
      selectEl.dataset.guestBound = "1";
      selectEl.addEventListener("change", () => {
        if (selectEl.value === ADD_OUTSIDE) {
          selectEl.value = selectEl.dataset.lastValue || "";
          openOutsideModal(selectEl, selectEl._gpOpts || opts);
          return;
        }
        if (selectEl.value !== ADD_EXTERNAL) {
          selectEl.dataset.lastValue = selectEl.value;
          return;
        }
        selectEl.value = selectEl.dataset.lastValue || "";
        openAddExternalModal(selectEl, opts);
      });
    }
  }

  /** { providedBySupervisorId, providedByGuestTrainerId, providedByExternalTrainerId } for a provider select (all undefined if unset, at most one set). */
  function readProviderSelect(selectEl) {
    const v = selectEl && selectEl.value;
    const m = /^([sge]):(\d+)$/.exec(v || "");
    const out = { providedBySupervisorId: undefined, providedByGuestTrainerId: undefined, providedByExternalTrainerId: undefined };
    if (!m) return out;
    if (m[1] === "g") out.providedByGuestTrainerId = Number(m[2]);
    else if (m[1] === "e") out.providedByExternalTrainerId = Number(m[2]);
    else out.providedBySupervisorId = Number(m[2]);
    return out;
  }

  // ---- "Add external trainer" (session-only) modal ----------------------
  let pendingSelect = null;
  let pendingOpts = null;
  function ensureModal() {
    if (document.getElementById("guestProviderModal")) return;
    const wrap = document.createElement("div");
    wrap.className = "modal-overlay";
    wrap.id = "guestProviderModal";
    wrap.innerHTML = `
      <div class="modal-box">
        <button type="button" class="close-modal" data-gp-cancel>&times;</button>
        <h3>Add External Trainer</h3>
        <p class="card-subtitle" style="margin-top:0;">Record a trainer from outside Reframe who delivered this Session. No account is created and they get no access to the system. Your Master Trainer or an administrator can also add them to the Group's Guest Trainers list.</p>
        <form id="guestProviderForm" novalidate>
          <label>Full name</label>
          <input type="text" id="gpFullName" dir="auto" maxlength="255" required autocomplete="off">
          <label>Organization <span style="font-weight:400;color:var(--muted);">(optional)</span></label>
          <input type="text" id="gpOrganization" dir="auto" maxlength="255" autocomplete="off">
          <label>Email <span style="font-weight:400;color:var(--muted);">(optional)</span></label>
          <input type="email" id="gpEmail" dir="ltr" maxlength="255" autocomplete="off">
          <p id="gpError" role="alert" style="display:none;color:var(--danger, #c0392b);font-size:13px;margin:8px 0 0;"></p>
          <div class="modal-actions">
            <button type="button" class="btn btn-secondary" data-gp-cancel>Cancel</button>
            <button type="submit" class="btn" id="gpSubmit">Add Trainer</button>
          </div>
        </form>
      </div>`;
    document.body.appendChild(wrap);
    wrap.querySelectorAll("[data-gp-cancel]").forEach((b) => b.addEventListener("click", () => closeModal("guestProviderModal")));
    document.getElementById("guestProviderForm").addEventListener("submit", submitExternal);
  }

  function openAddExternalModal(selectEl, opts) {
    ensureModal();
    pendingSelect = selectEl;
    pendingOpts = opts;
    document.getElementById("guestProviderForm").reset();
    document.getElementById("gpError").style.display = "none";
    openModal("guestProviderModal");
    setTimeout(() => document.getElementById("gpFullName").focus(), 50);
  }

  async function submitExternal(e) {
    e.preventDefault();
    const err = document.getElementById("gpError");
    const fullName = document.getElementById("gpFullName").value.trim();
    const email = document.getElementById("gpEmail").value.trim();
    const showError = (msg) => {
      err.textContent = msg;
      err.style.display = "block";
    };
    if (fullName.length < 2) return showError("Please enter the trainer's full name.");
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showError("Please enter a valid email address, or leave it empty.");

    const btn = document.getElementById("gpSubmit");
    btn.disabled = true;
    btn.textContent = "Adding…";
    try {
      const result = await apiRequest("/supervisor/session-guest-trainers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullName, email: email || undefined, organization: document.getElementById("gpOrganization").value.trim() || undefined }),
      });
      if (!result) return; // apiRequest already showed the error toast
      await loadProviders(true);
      // Refresh every provider select currently on the page so the new
      // person is selectable on every day row too, keeping each one's
      // current choice -- then select them on the row that asked.
      const selects = document.querySelectorAll("select[data-guest-bound]");
      for (const s of selects) {
        const keep = s === pendingSelect ? result.key : s.value;
        await renderProviderSelect(s, keep, s === pendingSelect ? pendingOpts : s._gpOpts || {});
      }
      // Let the host form react to the new selection (e.g. a day card's "Delivered by" label).
      if (pendingSelect) pendingSelect.dispatchEvent(new Event("change", { bubbles: true }));
      closeModal("guestProviderModal");
      if (typeof showToast === "function") {
        showToast(result.created ? `${result.guestTrainer.fullName} added as an external trainer` : `${result.guestTrainer.fullName} was already recorded -- selected`, "success");
      }
    } finally {
      btn.disabled = false;
      btn.textContent = "Add Trainer";
    }
  }

  // ---- "Add External Trainer (outside organization)" modal (migration 039)
  // Its own modal and endpoint -- the Guest Trainer modal above is untouched.
  let outsideSelect = null;
  let outsideOpts = null;
  function ensureOutsideModal() {
    if (document.getElementById("externalTrainerModal")) return;
    const wrap = document.createElement("div");
    wrap.className = "modal-overlay";
    wrap.id = "externalTrainerModal";
    wrap.innerHTML = `
      <div class="modal-box">
        <button type="button" class="close-modal" data-et-cancel>&times;</button>
        <h3>Add External Trainer</h3>
        <p class="card-subtitle" style="margin-top:0;">A trainer from outside the organization who delivered this Session. External Trainers are not added to the Group's Guest Trainers list, get no account, and have no access to the system.</p>
        <form id="externalTrainerForm" novalidate>
          <label>Full name</label>
          <input type="text" id="etFullName" dir="auto" maxlength="255" autocomplete="off">
          <label>Organization</label>
          <input type="text" id="etOrganization" dir="auto" maxlength="255" autocomplete="off" placeholder="Organization they come from">
          <label>Specialization <span style="font-weight:400;color:var(--muted);">(optional)</span></label>
          <input type="text" id="etSpecialization" dir="auto" maxlength="255" autocomplete="off">
          <label>Email <span style="font-weight:400;color:var(--muted);">(optional)</span></label>
          <input type="email" id="etEmail" dir="ltr" maxlength="255" autocomplete="off">
          <label>Phone <span style="font-weight:400;color:var(--muted);">(optional)</span></label>
          <input type="tel" id="etPhone" dir="ltr" maxlength="50" autocomplete="off">
          <p id="etError" role="alert" style="display:none;color:var(--danger, #c0392b);font-size:13px;margin:8px 0 0;"></p>
          <div class="modal-actions">
            <button type="button" class="btn btn-secondary" data-et-cancel>Cancel</button>
            <button type="submit" class="btn" id="etSubmit">Add External Trainer</button>
          </div>
        </form>
      </div>`;
    document.body.appendChild(wrap);
    wrap.querySelectorAll("[data-et-cancel]").forEach((b) => b.addEventListener("click", () => closeModal("externalTrainerModal")));
    document.getElementById("externalTrainerForm").addEventListener("submit", submitOutside);
  }

  function openOutsideModal(selectEl, opts) {
    ensureOutsideModal();
    outsideSelect = selectEl;
    outsideOpts = opts;
    document.getElementById("externalTrainerForm").reset();
    document.getElementById("etError").style.display = "none";
    openModal("externalTrainerModal");
    setTimeout(() => document.getElementById("etFullName").focus(), 50);
  }

  async function submitOutside(e) {
    e.preventDefault();
    const err = document.getElementById("etError");
    const showError = (msg) => {
      err.textContent = msg;
      err.style.display = "block";
    };
    const body = {
      fullName: document.getElementById("etFullName").value.trim(),
      organization: document.getElementById("etOrganization").value.trim() || undefined,
      specialization: document.getElementById("etSpecialization").value.trim() || undefined,
      email: document.getElementById("etEmail").value.trim() || undefined,
      phone: document.getElementById("etPhone").value.trim() || undefined,
    };
    if (body.fullName.length < 2) return showError("Please enter the trainer's full name.");
    if (body.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) return showError("Please enter a valid email address, or leave it empty.");

    const btn = document.getElementById("etSubmit");
    btn.disabled = true;
    btn.textContent = "Adding…";
    try {
      const result = await apiRequest("/supervisor/external-trainers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!result) return;
      await loadProviders(true);
      const selects = document.querySelectorAll("select[data-guest-bound]");
      for (const sel of selects) {
        const keep = sel === outsideSelect ? result.key : sel.value;
        await renderProviderSelect(sel, keep, sel === outsideSelect ? outsideOpts : sel._gpOpts || {});
      }
      if (outsideSelect) outsideSelect.dispatchEvent(new Event("change", { bubbles: true }));
      closeModal("externalTrainerModal");
      if (typeof showToast === "function") {
        showToast(
          result.created ? `${result.externalTrainer.fullName} added as an External Trainer` : `${result.externalTrainer.fullName} was already recorded -- selected`,
          "success"
        );
      }
    } finally {
      btn.disabled = false;
      btn.textContent = "Add External Trainer";
    }
  }

  /** "Name", "Name (Guest Trainer)" or "Name (External Trainer)" for list display; callers still escape. */
  function providerDisplayName(name, isGuest, isExternal) {
    if (!name) return "";
    if (isExternal) return `${name} (External Trainer)`;
    return isGuest ? `${name} (Guest Trainer)` : name;
  }

  /**
   * Who delivered a list item, for display (callers still escape). A
   * multi-day Session split between trainers (mixedProviders, from the
   * API's per-day summary) reads "Karim 14h · Habib 9h" instead of
   * naming one trainer for the whole Session.
   */
  function deliveredByText(item) {
    if (!item) return "";
    if (item.mixedProviders && Array.isArray(item.providers) && item.providers.length > 1) {
      return item.providers
        .map((p) => `${providerDisplayName(p.name, p.kind === "guest", p.kind === "external")} ${p.hours}h`)
        .join(" · ");
    }
    return providerDisplayName(item.providedByName, item.providedByIsGuest, item.providedByIsExternal);
  }

  window.GuestProviders = {
    loadProviders,
    renderProviderSelect,
    readProviderSelect,
    providerKey,
    providerDisplayName,
    deliveredByText,
  };
})();
