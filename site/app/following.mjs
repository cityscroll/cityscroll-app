import { installFilterChipNavigation } from "../affordance_grammar.mjs";
import {
  composeWatchRuleSentence,
  followingCadenceLabel,
  requestedFollowingTab,
} from "../following_view.mjs";
import {
  followingManagementUrl,
  followingPersonalIslandHtml,
  followingPersonalUiState,
  followingUrlForTab,
} from "../following_personal_state.mjs";
import { communityBoardIdFromSelection } from "../community_board_watch.mjs";
import { runtimeRumSemanticMilestones } from "../rum_static_record_instrumentation.mjs";
import {
  createFollowingRumInstrumentation,
  followingPersonalOutcomeFromHost,
} from "../rum_stateful_instrumentation.mjs";

const root = document.querySelector("[data-following-root]");
const msg = (name) => root?.dataset[name] || "";
const followingRum = createFollowingRumInstrumentation({
  rum: runtimeRumSemanticMilestones(),
});

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
  const boardBorough = String(form.elements.boardBorough?.value || "").trim();
  const boardNumber = String(form.elements.boardNumber?.value || "").trim();
  if (form.elements.lens?.value === "meetings") {
    const communityBoard = communityBoardIdFromSelection(boardBorough, boardNumber);
    if (communityBoard) filter.communityBoard = communityBoard;
    else delete filter.communityBoard;
  } else {
    delete filter.communityBoard;
  }
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

function syncCouncilFieldVisibility(form) {
  const field = form?.querySelector("[data-following-council-field]");
  if (!field) return;
  const lens = form.elements.lens?.value || root?.dataset.followingLens || "money";
  field.hidden = lens !== "district";
}

function syncCommunityBoardFieldVisibility(form) {
  const field = form?.querySelector("[data-following-community-board-field]");
  if (!field) return;
  const lens = form.elements.lens?.value || root?.dataset.followingLens || "money";
  field.hidden = lens !== "meetings";
}

function updateRuleLine() {
  const form = root?.querySelector("[data-following-preview-form]");
  syncCouncilFieldVisibility(form);
  syncCommunityBoardFieldVisibility(form);
  const { lens, filter, frequency } = readRefineFilter();
  const sentence = composeWatchRuleSentence(lens, filter);
  for (const line of root.querySelectorAll("[data-following-rule-line]")) {
    line.textContent = sentence;
  }
  for (const line of root.querySelectorAll("[data-following-identity-rule]")) {
    line.textContent = sentence;
  }
  const cadenceLabel = followingCadenceLabel(frequency, globalThis.t);
  for (const label of root.querySelectorAll("[data-following-identity-cadence]")) {
    label.textContent = cadenceLabel;
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
  syncCouncilFieldVisibility(form);
  syncCommunityBoardFieldVisibility(form);
  updateRuleLine();
}

function watchCountFromPersonal() {
  const host = root?.querySelector("[data-personal-watch-list]");
  if (!host) return 0;
  if (host.querySelector("[data-session-recognized='false']")) return 0;
  return host.querySelectorAll("[data-watch-key]").length;
}

function syncLocationForTab(tab, historyMode = "replace") {
  if (historyMode === "none" || !globalThis.history) return;
  const current = String(location.hash || "").replace(/^#/, "");
  const next = tab === "watches" ? "your-following" : tab;
  if (historyMode === "replace" && tab === "create" && !current) return;
  if (current === next) return;
  const url = followingUrlForTab(location, tab);
  if (historyMode === "push") history.pushState({ followingTab: tab }, "", url);
  else history.replaceState({ followingTab: tab }, "", url);
}

function setTab(tab, { historyMode = "replace" } = {}) {
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
  const suggestions = root.querySelector("[data-following-suggestions]");
  if (suggestions) suggestions.hidden = tab !== "create";
  if (tab === "watches") {
    const personal = root.querySelector("#your-following");
    const tabsBar = root.querySelector("[data-following-tabs]");
    const hero = root.querySelector(".following-hero");
    const insertAfter = tabsBar || hero;
    if (personal && insertAfter) insertAfter.after(personal);
  }
  syncLocationForTab(tab, historyMode);
}

function requestedTab(fallback) {
  return requestedFollowingTab(location, fallback);
}

function wireTabs(defaultTab = "create", { reset = false } = {}) {
  const tabs = root?.querySelector("[data-following-tabs]");
  if (!tabs) return;
  tabs.hidden = false;
  if (!tabs.dataset.wired) {
    tabs.dataset.wired = "true";
    for (const button of tabs.querySelectorAll("[data-following-tab]")) {
      button.addEventListener("click", () => setTab(button.dataset.followingTab, { historyMode: "push" }));
    }
  }
  if (reset || !tabs.dataset.selected) {
    setTab(requestedTab(defaultTab));
    tabs.dataset.selected = "true";
  }
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
    return;
  }

  // Recognized multi-watch / any-watch session: management first.
  root.dataset.followingLayout = "manage-first";
  personal.classList.remove("following-personal--demoted");
  personal.dataset.followingPersonalMode = "primary";
  const details = personal.querySelector("details.following-personal-details");
  if (details) {
    // Promote demoted markup into a full section heading when watches exist.
    // Reuse SSR copy already in the summary — no new English literals in this island.
    const kickerEl = details.querySelector(".following-kicker");
    const headingEl = details.querySelector("#following-personal-heading");
    const list = personal.querySelector("[data-personal-watch-list]");
    const status = personal.querySelector("[data-personal-status]");
    if (kickerEl && headingEl && list) {
      const kicker = document.createElement("p");
      kicker.className = "following-kicker";
      kicker.textContent = kickerEl.textContent || "";
      const heading = document.createElement("h2");
      heading.id = "following-personal-heading";
      heading.textContent = headingEl.textContent || "";
      personal.replaceChildren(kicker, heading, list);
      if (status) personal.append(status);
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
    wireTabs("watches", { reset: true });
  }
  wirePersonalForms();
  duplicateWarning();
}

function personalHost() {
  return root?.querySelector("[data-personal-watch-list]");
}

function personalStatus() {
  return root?.querySelector("[data-personal-status]");
}

function stampPersonalHost(state) {
  const host = personalHost();
  if (!host) return;
  host.dataset.personalState = state;
  host.setAttribute("aria-busy", state === "loading" ? "true" : "false");
}

function offerStatusRetry() {
  const status = personalStatus();
  if (!status || status.querySelector("[data-personal-retry]")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "following-personal-retry";
  button.dataset.personalRetry = "true";
  button.textContent = msg("msgPersonalRetry");
  status.append(" ", button);
}

function paintPersonalIsland(state, { keepExisting = false } = {}) {
  const host = personalHost();
  if (!host) return;
  const hasWatches = Boolean(host.querySelector("[data-watch-key]"));
  if (keepExisting && hasWatches && (state === "loading" || state === "unavailable" || state === "error")) {
    stampPersonalHost(state === "loading" ? (host.dataset.personalState || "recognized") : state);
    if (state === "unavailable" || state === "error") offerStatusRetry();
    return;
  }
  stampPersonalHost(state);
  if (state === "recognized") return;
  host.innerHTML = followingPersonalIslandHtml(state);
}

function focusWatch(key) {
  if (!key || typeof CSS === "undefined" || typeof CSS.escape !== "function") return;
  const card = personalHost()?.querySelector(`[data-watch-key="${CSS.escape(key)}"]`);
  if (!card) return;
  if (!card.hasAttribute("tabindex")) card.setAttribute("tabindex", "-1");
  card.focus();
}

function markManagementDestination() {
  const url = followingManagementUrl(location);
  if (`${location.pathname}${location.search}${location.hash}` === url) return;
  history.replaceState({ followingTab: "watches" }, "", url);
}

async function loadPersonal({ keepExisting = false, focusWatchKey = "" } = {}) {
  const host = personalHost();
  if (!host) return;
  followingRum.retrievalStart();
  paintPersonalIsland("loading", { keepExisting });
  try {
    const response = await fetch(root.dataset.personalUrl, { credentials: "include", headers: { Accept: "text/html" } });
    if (!response.ok) {
      followingRum.watchListReady({ resultState: "unavailable" });
      paintPersonalIsland("unavailable", { keepExisting });
      const status = personalStatus();
      if (keepExisting && status && host.querySelector("[data-watch-key]")) {
        status.textContent = msg("msgPersonalLoadError");
        offerStatusRetry();
      }
      return;
    }
    host.innerHTML = await response.text();
    const nextState = followingPersonalUiState({
      sessionRecognized: host.querySelector("[data-session-recognized]")?.getAttribute("data-session-recognized") === "true",
      watchCount: host.querySelectorAll("[data-watch-key]").length,
      responseOk: true,
    });
    stampPersonalHost(host.querySelector("[data-personal-state]")?.getAttribute("data-personal-state") || nextState);
    followingRum.watchListReady({ resultState: followingPersonalOutcomeFromHost(host) });
    wirePersonalForms();
    duplicateWarning();
    promotePersonalWhenWatches();
    if (focusWatchKey) focusWatch(focusWatchKey);
  } catch {
    followingRum.watchListReady({ resultState: "error" });
    paintPersonalIsland("error", { keepExisting });
    const status = personalStatus();
    if (keepExisting && status && host.querySelector("[data-watch-key]")) {
      status.textContent = msg("msgPersonalLoadError");
      offerStatusRetry();
    }
  }
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
  const host = personalHost();
  const status = personalStatus();
  if (!host) return;
  for (const form of host.querySelectorAll("form" + "[data-watch-action]")) {
    if (form.dataset.enhanced === "true") continue;
    const actionUrl = form.getAttribute("action") || "";
    const actionOrigin = new URL(actionUrl, location.href).origin;
    if (actionOrigin !== location.origin && actionOrigin !== "https://cityscroll.org") continue;
    form.dataset.enhanced = "true";
    form.addEventListener("submit", async (event) => {
      if (form.dataset.confirm && !globalThis.confirm(form.dataset.confirm)) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      const watchKey = form.closest("[data-watch-key]")?.getAttribute("data-watch-key") || "";
      const button = form.querySelector("button" + "[type=submit]");
      if (button) button.disabled = true;
      if (status) status.textContent = msg("msgPersonalSaving");
      try {
        const response = await fetch(actionUrl, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
          credentials: "include",
          body: new URLSearchParams(new FormData(form)),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.ok) throw new Error("watch-action");
        if (status) status.textContent = result.flash?.message || msg("msgPersonalSaved");
        markManagementDestination();
        await loadPersonal({ keepExisting: true, focusWatchKey: watchKey });
      } catch {
        if (status) status.textContent = msg("msgPersonalError");
        offerStatusRetry();
      } finally {
        if (button) button.disabled = false;
      }
    });
  }
}

function wirePersonalRecovery() {
  if (!root || root.dataset.personalRecoveryWired === "true") return;
  root.dataset.personalRecoveryWired = "true";
  root.addEventListener("click", (event) => {
    const retry = event.target.closest?.("[data-personal-retry]");
    if (retry) {
      event.preventDefault();
      loadPersonal({ keepExisting: true });
      return;
    }
    const create = event.target.closest?.("[data-following-create-recovery]");
    if (create) {
      event.preventDefault();
      setTab("create", { historyMode: "push" });
    }
  });
}

function wireLocationSync() {
  if (!root || root.dataset.locationSyncWired === "true") return;
  root.dataset.locationSyncWired = "true";
  window.addEventListener("popstate", async () => {
    await restoreFromLocation();
    setTab(requestedTab("create"), { historyMode: "none" });
  });
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
    if (url.origin === location.origin) history.replaceState({}, "", `${url.pathname}${url.search}`);
    root.querySelector("[data-following-preview-status]")?.replaceChildren(msg("msgPreviewReady"));
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
      await loadPersonal({ keepExisting: true });
      if (watchCountFromPersonal() > 0) {
        markManagementDestination();
        setTab("watches", { historyMode: "push" });
      }
    } catch {
      if (status) status.textContent = msg("msgSubmitError");
    } finally {
      if (button) button.disabled = false;
    }
  });
}

async function restoreFromLocation() {
  if (!root) return;
  try {
    const response = await fetch(`${location.pathname}${location.search}`, { headers: { Accept: "text/html" } });
    if (!response.ok) return;
    adoptFollowingDocument(await response.text());
    wireTabs(requestedTab("create"), { reset: true });
  } catch {
    /* current document remains the last honest state */
  }
}

if (root) {
  installFilterChipNavigation(root);
  wireTabs("create");
  root.querySelector("[data-following-preview-form]")?.addEventListener("submit", preview);
  wireSubscribe();
  wireRefineLive();
  wirePersonalRecovery();
  wireLocationSync();
  followingRum.shellReady({
    hasRoot: true,
    hasCreatePanel: Boolean(root.querySelector('[data-following-panel="create"]')),
    hasPersonalHost: Boolean(root.querySelector("[data-personal-watch-list]")),
  });
  loadPersonal();
}
