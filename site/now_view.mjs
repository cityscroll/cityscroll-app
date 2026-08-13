import { buildNowSurface } from "./now_surface.mjs";
import { nowItemMatchesScope } from "./scope_now_adapter.mjs";

let nowSourcesPromise = null;
export const NOW_SOURCE_TIMEOUT_MS = 12_000;

export function safeJson(load, shape, timeoutMs = NOW_SOURCE_TIMEOUT_MS) {
  let timer;
  const request = Promise.resolve().then(load)
    .then((payload) => ({ ...(payload || {}), status: "available" }))
    .catch((error) => ({ status: "unavailable", reason: error?.name || "request_failed", [shape]: [] }));
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ status: "unavailable", reason: "timeout", [shape]: [] }), timeoutMs);
  });
  return Promise.race([request, timeout]).finally(() => clearTimeout(timer));
}

function localJson(path, shape) {
  return safeJson(() => fetch(path, { cache: "no-cache" }).then((response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }), shape);
}

function workerJson(path, shape) {
  return safeJson(() => workerFetch(path, {}, NOW_SOURCE_TIMEOUT_MS).then((response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }), shape);
}

function loadNowSources() {
  if (nowSourcesPromise) return nowSourcesPromise;
  nowSourcesPromise = Promise.all([
    localJson("data/money_default_open.json", "notices"),
    localJson("data/staffing_exams.json", "exams"),
    workerJson("/rules", "rules"),
    workerJson("/property-locations", "properties"),
    workerJson("/hearings", "hearings"),
    localJson("data/land_upcoming_hearings.json", "hearings"),
  ]).then(([money, staffing, rules, property, meetings, land]) => ({
    money, staffing, rules, property, meetings, land,
  }));
  return nowSourcesPromise;
}

const DOMAIN_KEYS = Object.freeze({
  money: "tab_money", staffing: "tab_people", rules: "tab_rules",
  property: "tab_property", meetings: "tab_meetings", land: "tab_land",
});
const ACTION_KEYS = Object.freeze({
  bid: "next_action_response_instructions", apply: "career_apply_oasys",
  comment: "rule_comment_btn", object: "now_action_object",
  request_accommodation: "property_event_accommodation",
});
const EVENT_KEYS = Object.freeze({
  hearing: "disposition_stage_hearing", auction: "property_event_auction",
  meeting: "now_event_meeting", effective: "rule_event_effective", decision: "rule_event_adoption",
});
const DATE_KEYS = Object.freeze({
  bid: "now_date_responses_due", apply: "now_date_apply_by",
  comment: "now_date_comment_by", object: "now_date_object_by",
  request_accommodation: "now_date_request_by", hearing: "now_date_hearing",
  meeting: "now_date_meeting", auction: "now_date_auction",
  effective: "now_date_effective", decision: "now_date_decision",
});
const DATE_KIND_IS_CARD_KIND = new Set(["hearing", "meeting", "auction", "effective"]);

function nowEsc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function nowKindLabel(item) {
  const key = item.lane === "act_by" ? ACTION_KEYS[item.kind] : EVENT_KEYS[item.kind];
  return key ? t(key) : item.kind;
}

function comparableFact(value) {
  return String(value || "").toLocaleLowerCase().replace(/\bdate\b/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function nowDateLabel(item) {
  if (!item.time?.value) return t("now_basis_no_date");
  const key = DATE_KEYS[item.kind];
  if (!key) return "";
  if (DATE_KIND_IS_CARD_KIND.has(item.kind)) return "";
  const label = t(key);
  return comparableFact(label) === comparableFact(nowKindLabel(item)) ? "" : label;
}

function nowDateProvenance(item) {
  const parts = [];
  if (item.time?.source_field) parts.push(t("now_date_source_field", { field: item.time.source_field }));
  if (item.time?.verified === false) parts.push(t("now_basis_derived"));
  return parts.join(" · ");
}

function nowActionHTML(item) {
  const destination = item.action?.destination || item.route;
  const labelKey = item.lane === "act_by" ? ACTION_KEYS[item.kind] : null;
  const label = labelKey ? t(labelKey) : t("now_open_details");
  if (/^https:\/\//i.test(destination || "")) {
    return `<a class="act primary" href="${nowEsc(destination)}" ${EXT_ATTRS}>${nowEsc(label)}${extSR()}</a>
      <a class="act" href="${nowEsc(item.route)}">${t("now_open_details")}</a>`;
  }
  return `<a class="act primary" href="${nowEsc(item.route)}">${nowEsc(label)}</a>`;
}

function nowCardHTML(item) {
  const when = item.time?.value ? fdt(item.time.value) : t("now_open_without_date_title");
  const dateLabel = nowDateLabel(item);
  const provenance = nowDateProvenance(item);
  const provenanceTitle = provenance ? ` title="${nowEsc(provenance)}"` : "";
  return `<article class="now-card" data-now-item="${nowEsc(item.id)}" data-now-lane="${nowEsc(item.lane)}">
    <div class="now-card-tags">
      <span class="tag ${item.lane === "act_by" ? "urgency" : "open"}">${nowEsc(nowKindLabel(item))}</span>
      <span class="tag asset">${t(DOMAIN_KEYS[item.domain])}</span>
      <span class="now-source-badge">${t("now_source", { source: nowEsc(item.source.label) })}</span>
    </div>
    <p class="now-card-when"${provenanceTitle}><b>${nowEsc(when)}</b>${dateLabel ? `<span>${nowEsc(dateLabel)}</span>` : ""}</p>
    <h3><a href="${nowEsc(item.route)}" lang="en" dir="ltr">${nowEsc(item.title)}</a></h3>
    ${item.agency ? `<p class="now-card-agency" lang="en" dir="ltr">${nowEsc(item.agency)}</p>` : ""}
    <div class="actions">${nowActionHTML(item)}</div>
  </article>`;
}

function nowLaneHTML(id, titleKey, deckKey, items, emptyKey, extra = "") {
  return `<section class="now-lane" aria-labelledby="${id}-title">
    <header class="now-lane-head">
      <div><h3 id="${id}-title">${t(titleKey)}</h3><p>${t(deckKey)}</p></div>
      <span class="now-count">${t("results_count", { n: items.length })}</span>
    </header>
    <div class="now-list" data-now-list="${id}" data-now-count="${items.length}">
      ${items.length ? items.map(nowCardHTML).join("") : `<div class="empty">${t(emptyKey)}</div>`}
    </div>${extra}
  </section>`;
}

export function renderNowSurface(surface) {
  const box = $("#nowview");
  if (!box) return;
  const unavailable = surface.coverage.unavailable_sources;
  const coverage = unavailable.length
    ? `<div class="note warn" role="status">${t("now_source_unavailable", { sources: unavailable.map((domain) => t(DOMAIN_KEYS[domain])).join(", ") })}</div>` : "";
  const undated = surface.act_by.open_without_date;
  const undatedHTML = undated.length
    ? `<section class="now-undated" aria-labelledby="now-undated-title">
        <h4 id="now-undated-title">${t("now_open_without_date_title")}</h4>
        <p>${t("now_open_without_date_note")}</p>
        <div class="now-list" data-now-list="open-without-date" data-now-count="${undated.length}">${undated.map(nowCardHTML).join("")}</div>
      </section>` : "";
  box.innerHTML = `<div class="now-surface">
    <p class="now-back"><a href="/browse/">${t("back_browse")}</a></p>
    <header class="now-head"><p class="now-kicker">${t("now_kicker")}</p><h2>${t("now_title")}</h2><p>${t("now_deck")}</p><p class="now-bounded-note">${t("now_bounded_note")}</p></header>
    ${coverage}
    <div class="now-lanes">
      ${nowLaneHTML("act-by", "now_act_by_title", "now_act_by_deck", surface.act_by.dated, "now_empty_act", undatedHTML)}
      ${nowLaneHTML("happening-soon", "now_happening_title", "now_happening_deck", surface.happening_soon.items, "now_empty_events")}
    </div>
  </div>`;
  announce(t("results_count", { n: surface.counts.total }));
}

export async function showNow(options = {}) {
  showTab("now");
  const box = $("#nowview");
  if (!box) return;
  box.hidden = false;
  box.innerHTML = `<div class="empty"><span class="loading" aria-hidden="true"></span> ${t("now_loading")}</div>`;
  const sources = await loadNowSources();
  if (!box.isConnected || !box.closest(".tabpane.active")) return;
  renderNowSurface(buildNowSurface(sources, {
    today: todayISO(), scope: options.scope || null,
    matchesScope: options.matchesScope || nowItemMatchesScope,
    compileActionRail: window.CrolActions?.compileActionRail,
  }));
}

globalThis.loadNowSources = loadNowSources;
globalThis.renderNowSurface = renderNowSurface;
globalThis.showNow = showNow;
