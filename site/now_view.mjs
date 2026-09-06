import { buildNowSurface } from "./now_surface.mjs";
import { nowItemMatchesScope } from "./scope_now_adapter.mjs";
import { buildNowCalendarView } from "./now_calendar.mjs";
import { bindCompactMonthCalendar, renderCompactMonth } from "./compact_calendar.mjs";
import { AFFORDANCE_ACTION_ROLES, affordanceHandoffPresentation } from "./affordance_grammar.mjs";
import {
  CALENDAR_VIEW_CALENDAR,
  installNowCalendarSwitch,
  nowCalendarFallbackNote,
  nowCalendarSwitchHTML,
  nowCalendarViewHref,
  resolveNowCalendarPresentation,
} from "./now_calendar_switch.mjs";

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

function workerThenLocal(workerPath, localPath, shape) {
  return safeJson(async () => {
    try {
      if (typeof workerFetch === "function") {
        const response = await workerFetch(workerPath, {}, NOW_SOURCE_TIMEOUT_MS);
        if (response.ok) {
          const payload = await response.json();
          if (payload && Array.isArray(payload[shape])) return payload;
        }
      }
    } catch {
      // Worker miss or timeout falls through to the committed snapshot.
    }
    const response = await fetch(localPath, { cache: "no-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }, shape);
}

function loadNowSources() {
  if (nowSourcesPromise) return nowSourcesPromise;
  nowSourcesPromise = Promise.all([
    localJson("data/money_default_open.json", "notices"),
    workerThenLocal("/staffing-exams", "data/staffing_exams.json", "exams"),
    workerJson("/rules", "rules"),
    workerJson("/property-locations", "properties"),
    workerJson("/hearings", "hearings"),
    workerThenLocal("/land-upcoming-hearings", "data/land_upcoming_hearings.json", "hearings"),
  ]).then(([money, staffing, rules, property, meetings, land]) => ({
    money, staffing, rules, property, meetings, land,
  }));
  return nowSourcesPromise;
}

const DOMAIN_KEYS = Object.freeze({
  money: "tab_money", staffing: "tab_people", rules: "tab_rules",
  property: "tab_property", meetings: "tab_meetings", land: "tab_land",
});
// The badge on an `act_by` card names the kind of window the card is about.
// It used to be drawn from the same per-kind action-label map the control below
// it used, so a card printed one sentence twice — once as a decorative fact and
// again as the thing to click — and spent both readings on neither the window
// nor the consequence. Badge, date label and control are now three distinct
// statements: what kind of window this is, when it closes, and what the next
// step does.
const WINDOW_KEYS = Object.freeze({
  bid: "now_window_response", apply: "now_window_application",
  comment: "now_window_comment", object: "now_window_objection",
  request_accommodation: "now_window_request",
});

// A compiled action already carries the label reviewed for it, and this listing
// had been discarding that in favour of one label per kind. That is how a card
// pointing at the OASys landing page came to read "Apply in OASys", and how a
// property sale response came to read like a City Record procurement. The
// compiled label is authoritative here.
//
// One class of label does not survive the move: an instruction positioned
// against the reader's own document — "follow the response steps below" — is
// true on the notice that carries those steps and false on a card that only
// links to it. Those keys, and only those, are re-pointed to name the page the
// link opens. Every other reviewed label is left exactly as its owner wrote it.
const LISTING_LABEL_KEYS = Object.freeze({
  next_action_response_guide: "now_action_response_instructions",
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
  const key = item.lane === "act_by" ? WINDOW_KEYS[item.kind] : EVENT_KEYS[item.kind];
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

function nowActionLabel(action) {
  const key = action?.label_key;
  if (!key) return t("now_open_details");
  const listing = LISTING_LABEL_KEYS[key];
  if (listing) return t(listing);
  const label = t(key, action.label_vars || {});
  // `t` echoes the key back only when no dictionary carries it. A compiled
  // action's own fallback text is a better answer to the reader than a raw key.
  return label === key ? (action.label || t("now_open_details")) : label;
}

/**
 * One card, one accurately named next step.
 *
 * Which affordance that is, is decided by the destination through the shared
 * classifier rather than by testing the href for a scheme here: an absolute URL
 * on a host this site owns is navigation however it is spelled, and a
 * publisher's URL is a handoff that says so — the visible arrow, the new tab,
 * and the announcement that goes with one — before it is followed. A handoff
 * keeps the ordinary internal link beside it, so leaving the site is never the
 * only way on from a card.
 */
function nowActionHTML(item) {
  const action = item.action;
  const destination = action?.destination || item.route;
  const presentation = affordanceHandoffPresentation({
    href: destination,
    escape: nowEsc,
    newTabLabel: t("ext_link_new_tab_sr"),
  });
  const label = nowActionLabel(action);
  if (presentation.role === AFFORDANCE_ACTION_ROLES.handoff) {
    return `<a class="act primary" href="${nowEsc(destination)}"${presentation.attributes}>${nowEsc(label)}${presentation.glyph}${presentation.announcement}</a>
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

// The Cards body: the two existing lanes, untouched. This is also what
// paints when a Calendar request falls back for lack of density (A6): the
// default, no-JS-safe reading of Now never depends on the switch below.
function nowCardsBodyHTML(surface, undatedHTML) {
  return `<div class="now-lanes">
      ${nowLaneHTML("act-by", "now_act_by_title", "now_act_by_deck", surface.act_by.dated, "now_empty_act", undatedHTML)}
      ${nowLaneHTML("happening-soon", "now_happening_title", "now_happening_deck", surface.happening_soon.items, "now_empty_events")}
    </div>`;
}

// The Calendar body: the same eligible dated identities as the two Cards
// lanes above (A1), projected onto the shared compact month component.
// Undated open opportunities never reach this projection (A3).
function nowCalendarBodyHTML(calendarView) {
  return `<div class="now-calendar">${renderCompactMonth(calendarView)}</div>`;
}

/**
 * `options.view` is the requested presentation (defaults to Cards); the
 * switch always shows what actually painted, never what was merely
 * requested (A6). `options.currentHash` carries the shareable Now route so
 * the switch's two destinations stay ordinary, bookmarkable links.
 */
export function renderNowSurface(surface, options = {}) {
  const box = $("#nowview");
  if (!box) return;
  const currentHash = options.currentHash || "#now";
  const calendarView = buildNowCalendarView(surface, { today: surface.generated_for });
  const presentation = resolveNowCalendarPresentation({ requested: options.view, sparse: calendarView.render !== true });
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
  const switchHTML = nowCalendarSwitchHTML({ view: presentation.view, currentHash, t, escape: nowEsc });
  const fallbackNote = nowCalendarFallbackNote({ ...presentation, t });
  const body = presentation.view === CALENDAR_VIEW_CALENDAR
    ? nowCalendarBodyHTML(calendarView)
    : nowCardsBodyHTML(surface, undatedHTML);
  box.innerHTML = `<div class="now-surface">
    <p class="now-back"><a href="/browse/">${t("back_browse")}</a></p>
    <header class="now-head"><p class="now-kicker">${t("now_kicker")}</p><h2>${t("now_title")}</h2><p>${t("now_deck")}</p><p class="now-bounded-note">${t("now_bounded_note")}</p></header>
    ${coverage}
    <div class="now-calview-row">
      <div class="now-calview-switch" id="now-calview-switch" role="group" aria-label="${nowEsc(t("now_calview_switch_label"))}">${switchHTML}</div>
      ${fallbackNote ? `<p class="now-calview-note" role="status">${nowEsc(fallbackNote)}</p>` : ""}
    </div>
    ${body}
  </div>`;
  installNowCalendarSwitch(globalThis.document, (view) => {
    location.hash = nowCalendarViewHref(view, currentHash);
  });
  // PX-01: idempotent and delegated, so switching between Cards and Calendar
  // repaints `#nowview` as often as the reader likes without a second listener.
  bindCompactMonthCalendar(box);
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
  }), { view: options.view, currentHash: options.currentHash });
}

globalThis.loadNowSources = loadNowSources;
globalThis.renderNowSurface = renderNowSurface;
globalThis.showNow = showNow;
