import { installFilterChipNavigation } from "../affordance_grammar.mjs";
import {
  composeWatchRuleSentence,
  isCitywideWatchScope,
} from "../following_view.mjs";

const root = document.querySelector("[data-following-root]");
const msg = (name) => root?.dataset[name] || "";

function canonical(value) {
  if (Array.isArray(value)) {
    const rows = value.map(canonical).filter((item) => item !== undefined);
    return rows.length ? rows : undefined;
  }
  if (value && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])])
      .filter(([, item]) => item !== undefined);
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  if (value === null || value === undefined || value === false || value === "") return undefined;
  return value;
}

function watchKey(lens, filter) {
  return JSON.stringify({ lens, filter: canonical(filter || {}) });
}

function currentWatch() {
  const form = root?.querySelector("[data-following-subscribe-form]");
  if (!form) return null;
  try {
    return { lens: form.elements.lens.value, filter: JSON.parse(form.elements.filter.value || "{}") };
  } catch { return null; }
}

function duplicateWarning() {
  const watch = currentWatch();
  const host = root?.querySelector("[data-following-subscribe-panel]");
  if (!watch || !host) return;
  host.querySelector("[data-duplicate-warning]")?.remove();
  const key = watchKey(watch.lens, watch.filter);
  const duplicate = [...root.querySelectorAll("[data-watch-lens][data-watch-filter]")].some((row) => {
    try { return watchKey(row.dataset.watchLens, JSON.parse(row.dataset.watchFilter || "{}")) === key; }
    catch { return false; }
  });
  if (!duplicate) return;
  const note = document.createElement("p");
  note.className = "following-warning";
  note.dataset.duplicateWarning = "true";
  note.setAttribute("role", "alert");
  note.textContent = msg("msgDuplicate");
  host.prepend(note);
}

function readRefineFilter() {
  const form = root?.querySelector("[data-following-preview-form]");
  if (!form) return { lens: root?.dataset.followingLens || "money", filter: {}, frequency: "daily" };
  let filter = {};
  try {
    filter = JSON.parse(form.elements.filter?.value || "{}") || {};
  } catch { filter = {}; }
  const q = String(form.elements.q?.value || "").trim();
  if (q) filter.keywords = [q];
  else delete filter.keywords;
  const agency = String(form.elements.agency?.value || "").trim();
  if (agency) filter.agency = agency;
  else delete filter.agency;
  const council = String(form.elements.council?.value || "").trim();
  if (council) filter.councilDistrict = council;
  else delete filter.councilDistrict;
  const boro = String(form.elements.boro?.value || "").trim();
  if (boro) {
    const lens = form.elements.lens?.value || "money";
    if (lens === "land") {
      filter.boro = boro;
      delete filter.borough;
    } else {
      filter.borough = boro;
      delete filter.boro;
    }
  }
  const freqInput = form.querySelector('input[name="freq"]:checked');
  const frequency = freqInput?.value === "weekly" ? "weekly" : "daily";
  return {
    lens: form.elements.lens?.value || root?.dataset.followingLens || "money",
    filter,
    frequency,
  };
}

function updateRuleLine() {
  const { lens, filter, frequency } = readRefineFilter();
  const sentence = composeWatchRuleSentence(lens, filter);
  for (const line of root.querySelectorAll("[data-following-rule-line]")) {
    line.textContent = sentence;
  }
  const citywideDaily = isCitywideWatchScope(filter) && frequency === "daily";
  for (const panel of root.querySelectorAll("[data-following-rule-panel]")) {
    let warn = panel.querySelector("[data-following-citywide-warn]");
    if (citywideDaily && !warn) {
      warn = document.createElement("p");
      warn.className = "following-warning";
      warn.dataset.followingCitywideWarn = "true";
      warn.setAttribute("role", "status");
      warn.textContent = "This watch is citywide and daily — quiet days stay silent, but matches anywhere in the city can email you. Add a place or switch to weekly for a lighter inbox.";
      panel.append(warn);
    } else if (!citywideDaily && warn) {
      warn.remove();
    }
  }
  const subFreq = root.querySelector("[data-following-subscribe-freq]");
  if (subFreq) subFreq.value = frequency;
  // Keep cadence card selection styling in brand tokens.
  for (const card of root.querySelectorAll(".following-cadence-card")) {
    const input = card.querySelector('input[type="radio"]');
    card.classList.toggle("is-selected", !!(input && input.checked));
  }
}

function wireRefineLive() {
  const form = root?.querySelector("[data-following-preview-form]");
  if (!form || form.dataset.ruleLive === "true") return;
  form.dataset.ruleLive = "true";
  form.addEventListener("input", updateRuleLine);
  form.addEventListener("change", updateRuleLine);
  updateRuleLine();
}

function watchCountFromPersonal() {
  const host = root?.querySelector("[data-personal-watch-list]");
  if (!host) return 0;
  if (host.querySelector("[data-session-recognized='false']")) return 0;
  return host.querySelectorAll("[data-watch-key]").length;
}

function setTab(tab) {
  if (!root) return;
  const tabs = root.querySelectorAll("[data-following-tab]");
  for (const button of tabs) {
    const on = button.dataset.followingTab === tab;
    button.setAttribute("aria-selected", on ? "true" : "false");
    button.classList.toggle("is-selected", on);
  }
  for (const panel of root.querySelectorAll("[data-following-panel]")) {
    const match = panel.dataset.followingPanel === tab;
    panel.hidden = !match;
    if (match && panel.id === "your-following") {
      panel.querySelector("details.following-personal-details")?.setAttribute("open", "");
    }
  }
  const workspace = root.querySelector("[data-following-panel-workspace]");
  if (workspace) workspace.hidden = tab !== "create";
}

function promotePersonalWhenWatches() {
  if (!root) return;
  const count = watchCountFromPersonal();
  const personal = root.querySelector("#your-following");
  const create = root.querySelector("#create");
  const packs = root.querySelector("#packs");
  const tabs = root.querySelector("[data-following-tabs]");
  if (!personal || !create) return;

  if (count < 1) {
    root.dataset.followingLayout = root.dataset.followingLayout === "create-first" ? "create-first" : "browse";
    personal.dataset.followingPersonalMode = personal.classList.contains("following-personal--demoted")
      ? "demoted"
      : "secondary";
    if (tabs) tabs.hidden = true;
    for (const panel of root.querySelectorAll("[data-following-panel]")) panel.hidden = false;
    const workspace = root.querySelector("[data-following-panel-workspace]");
    if (workspace) workspace.hidden = false;
    return;
  }

  // Recognized multi-watch / any-watch session: management first.
  root.dataset.followingLayout = "manage-first";
  personal.classList.remove("following-personal--demoted");
  personal.dataset.followingPersonalMode = "primary";
  const details = personal.querySelector("details.following-personal-details");
  if (details) {
    // Promote demoted markup into a full section heading when watches exist.
    const summary = details.querySelector("summary");
    const list = personal.querySelector("[data-personal-watch-list]");
    const status = personal.querySelector("[data-personal-status]");
    if (summary && list) {
      personal.innerHTML = `<p class="following-kicker">Saved</p><h2 id="following-personal-heading">Your watches</h2>${list.outerHTML}${status ? status.outerHTML : ""}`;
    }
  }
  // Order: watches → create → workspace → packs
  const hero = root.querySelector(".following-hero");
  const insertAfter = tabs || hero;
  if (insertAfter) {
    insertAfter.after(personal);
    personal.after(create);
    const workspace = root.querySelector("[data-following-workspace]");
    if (workspace) create.after(workspace);
    if (packs && workspace) workspace.after(packs);
    else if (packs) create.after(packs);
  }
  if (tabs) {
    tabs.hidden = false;
    if (!tabs.dataset.wired) {
      tabs.dataset.wired = "true";
      for (const button of tabs.querySelectorAll("[data-following-tab]")) {
        button.addEventListener("click", () => setTab(button.dataset.followingTab));
      }
    }
    const hash = (location.hash || "").replace(/^#/, "");
    if (hash === "create") setTab("create");
    else if (hash === "packs") setTab("packs");
    else setTab("watches");
  }
  wirePersonalForms();
  duplicateWarning();
}

async function loadPersonal() {
  const host = root?.querySelector("[data-personal-watch-list]");
  if (!host) return;
  try {
    const response = await fetch(root.dataset.personalUrl, { credentials: "include", headers: { Accept: "text/html" } });
    if (!response.ok) return;
    host.innerHTML = await response.text();
    wirePersonalForms();
    duplicateWarning();
    promotePersonalWhenWatches();
  } catch { /* public page and management link remain complete */ }
}

function adoptFollowingDocument(html) {
  const next = new DOMParser().parseFromString(html, "text/html");
  const current = root.querySelector("[data-following-workspace]");
  const replacement = next.querySelector("[data-following-workspace]");
  if (current && replacement) current.replaceWith(replacement);
  // Keep refine form + cadence in sync with the previewed document when present.
  const currentForm = root.querySelector("[data-following-preview-form]");
  const nextForm = next.querySelector("[data-following-preview-form]");
  if (currentForm && nextForm) {
    currentForm.replaceWith(nextForm);
    nextForm.addEventListener("submit", preview);
  }
  installFilterChipNavigation(root);
  wireSubscribe();
  wireRefineLive();
  duplicateWarning();
  updateRuleLine();
}

function wirePersonalForms() {
  const host = root?.querySelector("[data-personal-watch-list]");
  const status = root?.querySelector("[data-personal-status]");
  if (!host) return;
  for (const form of host.querySelectorAll("form" + "[data-watch-action]")) {
    if (form.dataset.enhanced === "true") continue;
    if (new URL(form.action, location.href).origin !== location.origin) continue;
    form.dataset.enhanced = "true";
    form.addEventListener("submit", async (event) => {
      if (form.dataset.confirm && !globalThis.confirm(form.dataset.confirm)) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      const button = form.querySelector("button" + "[type=submit]");
      if (button) button.disabled = true;
      if (status) status.textContent = msg("msgPersonalSaving");
      try {
        const response = await fetch(form.action, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
          credentials: "include",
          body: new URLSearchParams(new FormData(form)),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.ok) throw new Error("watch-action");
        if (status) status.textContent = result.flash?.message || msg("msgPersonalSaved");
        await loadPersonal();
      } catch {
        if (status) status.textContent = msg("msgPersonalError");
      } finally {
        if (button) button.disabled = false;
      }
    });
  }
}

async function preview(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const status = form.querySelector("[data-following-preview-status]");
  if (status) status.textContent = msg("msgPreviewLoading");
  try {
    const url = new URL(form.action);
    url.search = new URLSearchParams(new FormData(form)).toString();
    const response = await fetch(url, { headers: { Accept: "text/html" } });
    if (!response.ok) throw new Error("preview");
    adoptFollowingDocument(await response.text());
    if (status) status.textContent = msg("msgPreviewReady");
  } catch {
    if (status) status.textContent = msg("msgPreviewError");
  }
}

function wireSubscribe() {
  const form = root?.querySelector("[data-following-subscribe-form]");
  if (!form || form.dataset.enhanced === "true") return;
  form.dataset.enhanced = "true";
  form.addEventListener("submit", async (event) => {
    const warning = form.closest("[data-following-subscribe-panel]")?.querySelector("[data-duplicate-warning]");
    if (warning) {
      event.preventDefault();
      warning.focus?.();
      return;
    }
    if (!form.reportValidity()) return;
    event.preventDefault();
    // Sync cadence from the refine radio cards before POST.
    updateRuleLine();
    const status = form.querySelector("[data-following-submit-status]");
    const button = form.querySelector("button" + "[type=submit]");
    if (status) status.textContent = msg("msgSubmitLoading");
    if (button) button.disabled = true;
    try {
      const body = Object.fromEntries(new FormData(form).entries());
      body.filter = JSON.parse(body.filter || "{}");
      const response = await fetch(form.action, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) throw new Error(result.reason || "subscribe");
      if (status) status.textContent = msg("msgSubmitReady");
      form.elements.email.value = "";
    } catch {
      if (status) status.textContent = msg("msgSubmitError");
    } finally {
      if (button) button.disabled = false;
    }
  });
}

if (root) {
  installFilterChipNavigation(root);
  root.querySelector("[data-following-preview-form]")?.addEventListener("submit", preview);
  wireSubscribe();
  wireRefineLive();
  loadPersonal();
}
