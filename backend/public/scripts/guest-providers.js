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
    // A day with its own trainers (migration 040): "Karim (Master Trainer) 3h · Sami (External Trainer) 2h".
    if (Array.isArray(item.contributions) && item.contributions.length) {
      if (item.contributions.length === 1) {
        const c = item.contributions[0];
        return `${providerDisplayName(c.name, c.kind === "guest", c.kind === "external")}${c.titleLabel ? ` -- ${c.titleLabel}` : ""}`;
      }
      return item.contributions.map((c) => `${c.name}${c.titleLabel ? ` (${c.titleLabel})` : ""} ${c.hours}h`).join(" · ");
    }
    if (item.mixedProviders && Array.isArray(item.providers) && item.providers.length > 1) {
      return item.providers
        .map((p) => `${providerDisplayName(p.name, p.kind === "guest", p.kind === "external")} ${p.hours}h`)
        .join(" · ");
    }
    return providerDisplayName(item.providedByName, item.providedByIsGuest, item.providedByIsExternal);
  }

  /** "Karim (Master Trainer) 3h · Sami (External Trainer) 2h" for a day's contributions; callers still escape. */
  function contributionsText(list) {
    if (!Array.isArray(list) || !list.length) return "";
    return list.map((c) => `${c.name}${c.titleLabel ? ` (${c.titleLabel})` : ""} ${c.hours}h`).join(" · ");
  }

  window.GuestProviders = {
    loadProviders,
    renderProviderSelect,
    readProviderSelect,
    providerKey,
    providerDisplayName,
    deliveredByText,
    contributionsText,
  };

  // ---- Several trainers on one day (migration 040) -------------------------
  // TrainerRows.mount(container, opts) renders an editable list of
  // { trainer, title, hours } rows plus "+ Add trainer"; TrainerRows.read
  // returns the API's contributions array. A day's trainers are sequential:
  // its total is the sum of their hours. A title is descriptive only -- it
  // never grants a role or permission.
  let titles = null;
  let titlesPromise = null;
  function loadTitles(force) {
    if (force) {
      titles = null;
      titlesPromise = null;
    }
    if (titles) return Promise.resolve(titles);
    if (!titlesPromise) {
      titlesPromise = apiRequest("/supervisor/trainer-titles").then((data) => {
        titles = (data && data.titles) || [];
        titlesPromise = null;
        return titles;
      });
    }
    return titlesPromise;
  }

  /** The title a trainer gets by default, from what kind of provider they are. */
  function defaultTitleFor(provider) {
    if (!provider) return "";
    if (provider.kind === "external") return "external_trainer";
    if (provider.kind === "external_guest" || provider.kind === "internal_guest" || provider.kind === "session_only") return "guest_trainer";
    if (provider.kind === "member") return provider.role === "Master Trainer" ? "master_trainer" : "tot";
    return "";
  }

  function rowKeyOf(c) {
    if (!c) return null;
    if (c.key) return c.key;
    return providerKey(c);
  }

  async function addTrainerRow(container, c, opts) {
    const list = container.querySelector(".tr-rows");
    const row = document.createElement("div");
    row.className = "tr-row";
    const hours = c && c.minutes != null ? Math.round((c.minutes / 60) * 100) / 100 : "";
    row.innerHTML = `
      <div class="tr-f tr-f-who"><label>Trainer</label><select class="tr-who" required></select></div>
      <div class="tr-f tr-f-title"><label title="A professional title only -- it never changes anyone's account or permissions">Title</label><select class="tr-title"></select></div>
      <div class="tr-f tr-f-hours"><label>Hours</label><input type="number" class="tr-hours" min="0.25" step="0.25" value="${hours}" required></div>
      <button type="button" class="tr-remove" title="Remove this trainer" aria-label="Remove this trainer"><i class="fa fa-xmark"></i></button>`;
    list.appendChild(row);

    const who = row.querySelector(".tr-who");
    const prev = list.children.length > 1 ? null : opts.defaultKey;
    await renderProviderSelect(who, rowKeyOf(c) || prev || undefined, { filter: opts.filter, fallbackName: c && c.name });
    const titleSel = row.querySelector(".tr-title");
    const all = await loadTitles();
    const wanted = c && c.titleCode != null ? c.titleCode : null;
    const opt = (t) => `<option value="${escapeHtml(t.code)}">${escapeHtml(t.label)}</option>`;
    let html = '<option value="">— No title —</option>' + all.map(opt).join("");
    // A title since deactivated stays shown (and kept) on an existing day.
    if (wanted && !all.some((t) => t.code === wanted)) html += `<option value="${escapeHtml(wanted)}">${escapeHtml((c && c.titleLabel) || wanted)} (inactive)</option>`;
    titleSel.innerHTML = html;
    const applyDefaultTitle = () => {
      if (titleSel.dataset.touched) return;
      const p = (roster || []).find((x) => x.key === who.value);
      titleSel.value = defaultTitleFor(p);
    };
    if (wanted != null) {
      titleSel.value = wanted;
      titleSel.dataset.touched = "1";
    } else applyDefaultTitle();
    titleSel.addEventListener("change", () => (titleSel.dataset.touched = "1"));
    who.addEventListener("change", applyDefaultTitle);
    row.querySelector(".tr-remove").addEventListener("click", () => {
      row.remove();
      refreshTrainerRows(container);
    });
    row.addEventListener("input", () => refreshTrainerRows(container));
    row.addEventListener("change", () => refreshTrainerRows(container));
    refreshTrainerRows(container);
    return row;
  }

  function refreshTrainerRows(container) {
    const rows = Array.from(container.querySelectorAll(".tr-row"));
    rows.forEach((r) => (r.querySelector(".tr-remove").style.visibility = rows.length > 1 ? "visible" : "hidden"));
    const total = rows.reduce((t, r) => t + (Number(r.querySelector(".tr-hours").value) || 0), 0);
    const out = container.querySelector(".tr-total");
    if (out) out.innerHTML = `Day total: <strong>${Math.round(total * 100) / 100}h</strong>${rows.length > 1 ? ` <span class="tr-hint">(${rows.length} trainers, one after another)</span>` : ""}`;
    if (typeof container._trOnChange === "function") container._trOnChange();
  }

  /**
   * Renders the trainers block into `container`. opts:
   *   contributions -- existing rows to show (API shape), else one empty row
   *   legacy        -- { provider, minutes } for a day saved before
   *                    contributions existed: shown as one row
   *   defaultKey    -- provider key for a brand-new first row
   *   filter(p)     -- limit selectable providers (e.g. no ToTs on a ToT session)
   *   onChange()    -- called whenever a row changes
   */
  async function mountTrainerRows(container, opts = {}) {
    container.classList.add("tr-block");
    container.innerHTML = `
      <div class="tr-rows"></div>
      <div class="tr-foot">
        <button type="button" class="btn btn-secondary tr-add" style="width:auto;margin:0;"><i class="fa fa-user-plus"></i> Add trainer</button>
        <span class="tr-total" aria-live="polite"></span>
      </div>`;
    container._trOnChange = opts.onChange;
    const rowOpts = { filter: opts.filter, defaultKey: opts.defaultKey };
    container.querySelector(".tr-add").addEventListener("click", () => addTrainerRow(container, null, rowOpts));
    const list = Array.isArray(opts.contributions) && opts.contributions.length ? opts.contributions : null;
    if (list) {
      for (const c of list) await addTrainerRow(container, c, rowOpts);
    } else if (opts.legacy && opts.legacy.provider) {
      await addTrainerRow(container, { ...opts.legacy.provider, minutes: opts.legacy.minutes, titleCode: null }, rowOpts);
    } else {
      await addTrainerRow(container, null, rowOpts);
    }
    refreshTrainerRows(container);
  }

  /** { contributions, totalMinutes, error } from a mounted block. */
  function readTrainerRows(container) {
    const rows = Array.from(container.querySelectorAll(".tr-row"));
    const contributions = [];
    const seen = new Set();
    for (const [i, r] of rows.entries()) {
      const who = r.querySelector(".tr-who");
      const pair = readProviderSelect(who);
      const hours = Number(r.querySelector(".tr-hours").value);
      if (!/^[sge]:\d+$/.test(who.value || "")) return { error: `Trainer ${i + 1}: choose a trainer` };
      if (!(hours > 0)) return { error: `Trainer ${i + 1}: enter the hours they delivered` };
      if (seen.has(who.value)) return { error: `Trainer ${i + 1}: the same trainer is listed twice on this day` };
      seen.add(who.value);
      contributions.push({
        providedBySupervisorId: pair.providedBySupervisorId,
        providedByGuestTrainerId: pair.providedByGuestTrainerId,
        providedByExternalTrainerId: pair.providedByExternalTrainerId,
        titleCode: r.querySelector(".tr-title").value || null,
        minutes: Math.round(hours * 60),
      });
    }
    if (!contributions.length) return { error: "Add at least one trainer" };
    return { contributions, totalMinutes: contributions.reduce((t, c) => t + c.minutes, 0) };
  }

  /** Display names of a mounted block's trainers ("Karim, Sami"). */
  function trainerRowsNames(container) {
    return Array.from(container.querySelectorAll(".tr-row .tr-who"))
      .map((s) => {
        const o = s.selectedOptions && s.selectedOptions[0];
        if (!o || !/^[sge]:/.test(o.value)) return "";
        const t = o.textContent || "";
        const i = t.indexOf(" — ");
        return (i >= 0 ? t.slice(i + 3) : t).replace(/ \(no longer in this Group\)$/, "").trim();
      })
      .filter(Boolean);
  }

  window.TrainerRows = { mount: mountTrainerRows, read: readTrainerRows, names: trainerRowsNames, loadTitles, defaultTitleFor };

  // Styles for the trainers block, injected once (both dashboards share it).
  if (!document.getElementById("trainer-rows-style")) {
    const st = document.createElement("style");
    st.id = "trainer-rows-style";
    st.textContent = `
      .tr-block { min-width: 0; }
      .tr-row { display: grid; grid-template-columns: 1.6fr 1.1fr 0.6fr auto; gap: 8px; align-items: end; margin-bottom: 8px; }
      .tr-row label { font-size: 11px; margin: 0 0 4px; }
      .tr-f { min-width: 0; }
      .tr-f select, .tr-f input { width: 100%; min-width: 0; }
      .tr-remove { width: 34px; height: 34px; border-radius: 9px; border: 1px solid var(--border); background: var(--surface); color: var(--danger); cursor: pointer; }
      .tr-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-top: 4px; }
      .tr-total { font-size: 12.5px; color: var(--muted); }
      .tr-total strong { color: var(--text); }
      .tr-hint { font-size: 11.5px; }
      @media (max-width: 640px) {
        .tr-row { grid-template-columns: 1fr 1fr; grid-template-areas: "who who" "title hours" "remove remove"; }
        .tr-f-who { grid-area: who; } .tr-f-title { grid-area: title; } .tr-f-hours { grid-area: hours; }
        .tr-remove { grid-area: remove; justify-self: end; }
      }`;
    document.head.appendChild(st);
  }
})();
