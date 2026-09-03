/**
 * Shared compact month view model and renderer.
 *
 * Every later calendar-bearing surface (rules, Community Boards, Now, Land,
 * procurement, property, exams, legislative matters) consumes this one pure
 * view model and one shared renderer instead of forking its own grid. Both
 * halves accept only normalized `cityscroll.calendar_display_occurrence.v1`
 * occurrences from the bounded display query in `calendar_display.mjs`: this
 * module does not decide eligibility, infer a date or a kind, or fetch data.
 *
 * `buildCompactMonthView` is pure: no clock, no I/O. The caller supplies
 * `today` explicitly so month, six-week grid bounds, and every occurrence's
 * past/current/future state are deterministic across timezones and calls.
 * When the bundle does not meet the commissioned density rule, it returns an
 * explicit non-render result instead of an empty grid — the month view is a
 * hypothesis about a bundle, not a default a sparse surface owes its reader.
 *
 * `renderCompactMonth` turns a render:true view model into semantic table and
 * list markup: a real `<table>` with weekday `<th>` headings for desktop/print,
 * and a parallel `<ol>` agenda for narrow viewports, toggled by CSS alone so
 * neither pointer hover nor script is required to read either form. Crowded
 * days keep every occurrence in the document behind a native `<details>`
 * disclosure rather than dropping or silently truncating any of them.
 */

import { occurrenceDay, evaluateDisplayCluster } from "./calendar_display.mjs";

export const COMPACT_MONTH_VIEW_SCHEMA = "cityscroll.compact_month_view.v1";
export const COMPACT_MONTH_NON_RENDER_SCHEMA = "cityscroll.compact_month_non_render.v1";

// A day cell shows at most this many occurrences inline; the remainder sits
// behind a reachable disclosure. Held to the same reviewed "three" as the
// commissioned density rule so crowded-day handling reads as one reviewed
// number, not a per-surface guess.
export const MAX_VISIBLE_OCCURRENCES_PER_DAY = 3;

const WEEK_LENGTH = 7;
const GRID_WEEKS = 6;
const GRID_LENGTH = WEEK_LENGTH * GRID_WEEKS;

export const WEEKDAY_LABELS = Object.freeze(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);

const MONTH_LABELS = Object.freeze([
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]);

// Plain resident-facing labels only. No schema, join, workstream, or
// control-plane vocabulary ever reaches rendered copy (A7).
const KIND_LABELS = Object.freeze({
  event: "Event",
  deadline: "Deadline",
  window_open: "Opens",
  window_close: "Closes",
  milestone: "Milestone",
});

const COMPACT_MONTH_ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MONTH = /^\d{4}-\d{2}$/;

/* ---------- pure date math ---------- */

function compactMonthIsDateOnly(value) {
  return typeof value === "string" && COMPACT_MONTH_ISO_DATE.test(value);
}

function compactMonthIsoToEpochDay(iso) {
  return Math.round(Date.parse(`${iso}T00:00:00Z`) / 86400000);
}

function compactMonthEpochDayToIso(day) {
  return new Date(day * 86400000).toISOString().slice(0, 10);
}

function compactMonthAddDays(iso, count) {
  return compactMonthEpochDayToIso(compactMonthIsoToEpochDay(iso) + count);
}

// 1970-01-01 (epoch day 0) was a Thursday, so `+4` aligns epoch day to a
// Sunday-first (0-6) weekday index without reading any local clock.
function weekdayIndex(iso) {
  return ((compactMonthIsoToEpochDay(iso) + 4) % 7 + 7) % 7;
}

function normalizeMonth(month) {
  if (typeof month !== "string" || !ISO_MONTH.test(month)) return null;
  const monthNumber = Number(month.slice(5, 7));
  return monthNumber >= 1 && monthNumber <= 12 ? month : null;
}

function monthGrid(month) {
  const first = `${month}-01`;
  const gridFrom = compactMonthAddDays(first, -weekdayIndex(first));
  const gridTo = compactMonthAddDays(gridFrom, GRID_LENGTH - 1);
  return { gridFrom, gridTo };
}

function formatMonthLabel(month) {
  const [year, monthNumber] = month.split("-").map(Number);
  return `${MONTH_LABELS[monthNumber - 1]} ${year}`;
}

/* ---------- occurrence admission ---------- */

// Defensive re-validation of the contract fields this module needs to render
// a link and a stable identity. CBICS-01 already enforces eligibility
// upstream; this only guards against a caller handing this module something
// that is not, in fact, normalized CBICS-01 output (A: missing canonical
// link/source rejection, duplicate identity prevention).
function admitOccurrences(occurrences) {
  const seen = new Set();
  const kept = [];
  for (const occurrence of Array.isArray(occurrences) ? occurrences : []) {
    if (!occurrence || typeof occurrence !== "object") continue;
    if (!occurrence.uid || seen.has(occurrence.uid)) continue;
    if (!occurrence.canonical_url || !occurrence.source) continue;
    if (!occurrenceDay(occurrence)) continue;
    seen.add(occurrence.uid);
    kept.push(occurrence);
  }
  return kept;
}

function timeKey(occurrence) {
  return occurrence.starts_at && !compactMonthIsDateOnly(occurrence.starts_at) ? occurrence.starts_at : "";
}

// Stable per-day ordering: date-only ("all day") occurrences sort first, then
// by actual start time, then kind, then uid — deterministic under ties.
function sortDayOccurrences(list) {
  return [...list].sort((a, b) => {
    const timeA = timeKey(a);
    const timeB = timeKey(b);
    if (timeA !== timeB) return timeA < timeB ? -1 : 1;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0;
  });
}

function stateFor(day, today) {
  if (!day) return "unknown";
  return day < today ? "past" : day > today ? "future" : "current";
}

function toEntry(occurrence, today) {
  const day = occurrenceDay(occurrence);
  return {
    uid: occurrence.uid,
    kind: occurrence.kind,
    lifecycle: occurrence.lifecycle,
    status: occurrence.status,
    title: occurrence.title,
    day,
    starts_at: occurrence.starts_at,
    date: occurrence.date,
    ends_at: occurrence.ends_at,
    timezone: occurrence.timezone,
    state: stateFor(day, today),
    canonical_url: occurrence.canonical_url,
    source: occurrence.source,
    provenance: occurrence.provenance,
  };
}

/* ---------- view model (A1, A2) ---------- */

/**
 * Build the compact month view model over normalized CBICS-01 display
 * occurrences. Returns a `render: true` result with the selected month,
 * six-week grid, per-day occurrences, and crowded-day overflow counts, or an
 * explicit `render: false` non-render result with a reason when the bundle
 * does not meet the commissioned density rule. `today` is required so the
 * result never depends on a hidden clock.
 */
export function buildCompactMonthView(occurrences, options = {}) {
  if (!compactMonthIsDateOnly(options.today)) {
    throw new TypeError("buildCompactMonthView requires an explicit YYYY-MM-DD `today`");
  }
  if (options.month != null && !normalizeMonth(options.month)) {
    throw new TypeError("buildCompactMonthView `month` override must be an explicit YYYY-MM string");
  }
  const today = options.today;
  const usable = admitOccurrences(occurrences);
  const cluster = evaluateDisplayCluster(usable);

  if (!cluster.qualifies) {
    return {
      schema: COMPACT_MONTH_NON_RENDER_SCHEMA,
      render: false,
      reason: cluster.reason,
      candidate_occurrences: cluster.candidate_occurrences,
      distinct_dates: cluster.distinct_dates,
    };
  }

  const month = normalizeMonth(options.month) || cluster.selected_month;
  const { gridFrom, gridTo } = monthGrid(month);

  const byDay = new Map();
  for (const occurrence of usable) {
    const day = occurrenceDay(occurrence);
    if (day < gridFrom || day > gridTo) continue;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(occurrence);
  }

  const weeks = [];
  for (let week = 0; week < GRID_WEEKS; week += 1) {
    const row = [];
    for (let weekday = 0; weekday < WEEK_LENGTH; weekday += 1) {
      const date = compactMonthAddDays(gridFrom, week * WEEK_LENGTH + weekday);
      const dayOccurrences = sortDayOccurrences(byDay.get(date) || []);
      const visible = dayOccurrences.slice(0, MAX_VISIBLE_OCCURRENCES_PER_DAY);
      const overflow = dayOccurrences.slice(MAX_VISIBLE_OCCURRENCES_PER_DAY);
      row.push({
        date,
        weekday,
        in_month: date.slice(0, 7) === month,
        is_today: date === today,
        occurrence_count: dayOccurrences.length,
        hidden_count: overflow.length,
        visible_occurrences: visible.map((occurrence) => toEntry(occurrence, today)),
        overflow_occurrences: overflow.map((occurrence) => toEntry(occurrence, today)),
      });
    }
    weeks.push(row);
  }

  return {
    schema: COMPACT_MONTH_VIEW_SCHEMA,
    render: true,
    month,
    month_label: formatMonthLabel(month),
    weekday_labels: [...WEEKDAY_LABELS],
    grid_from: gridFrom,
    grid_to: gridTo,
    crosses_month_boundary: cluster.crosses_month_boundary,
    occurrence_days: [...byDay.keys()].sort(),
    weeks,
    densest_window: cluster.densest_window,
    distinct_dates: cluster.distinct_dates,
    candidate_occurrences: cluster.candidate_occurrences,
    eligibility: { qualifies: true, reason: cluster.reason },
  };
}

/* ---------- renderer (A3, A4, A5, A6) ---------- */

function defaultEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Timed occurrences show a real clock time; date-only occurrences (an
// exact-date deadline with no time-of-day) show none, which is itself the
// non-colour signal that distinguishes the two (A3).
function timeLabelFor(occurrence) {
  if (!occurrence.starts_at || compactMonthIsDateOnly(occurrence.starts_at)) return null;
  const instant = new Date(occurrence.starts_at);
  if (Number.isNaN(instant.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: occurrence.timezone || "UTC",
    }).format(instant);
  } catch {
    return null;
  }
}

function occurrenceItemHTML(occurrence, esc) {
  const kindLabel = KIND_LABELS[occurrence.kind] || "Item";
  const timeLabel = timeLabelFor(occurrence);
  const classes = [
    "compact-month-occ",
    `compact-month-occ-${occurrence.kind}`,
    `compact-month-occ-${occurrence.state}`,
    `compact-month-occ-lifecycle-${occurrence.lifecycle || "scheduled"}`,
  ];
  const flag = occurrence.lifecycle === "cancelled"
    ? '<span class="compact-month-occ-flag compact-month-occ-flag-cancelled">Cancelled</span>'
    : occurrence.lifecycle === "rescheduled"
      ? '<span class="compact-month-occ-flag compact-month-occ-flag-rescheduled">Rescheduled</span>'
      : "";
  const sourceUrl = occurrence.source && typeof occurrence.source === "object" ? occurrence.source.url : null;
  const sourceLink = sourceUrl && sourceUrl !== occurrence.canonical_url
    ? `<a class="compact-month-occ-source" href="${esc(sourceUrl)}">Source</a>`
    : "";
  return `<li class="${classes.join(" ")}">` +
    `<a class="compact-month-occ-link" href="${esc(occurrence.canonical_url)}">` +
    `<span class="compact-month-occ-kind">${esc(kindLabel)}</span>` +
    (timeLabel ? `<span class="compact-month-occ-time">${esc(timeLabel)}</span>` : "") +
    `<span class="compact-month-occ-title">${esc(occurrence.title || "Civic calendar item")}</span>` +
    "</a>" +
    flag + sourceLink +
    "</li>";
}

function dayCellHTML(day, esc) {
  const classes = ["compact-month-day"];
  if (!day.in_month) classes.push("compact-month-day-outside");
  if (day.is_today) classes.push("compact-month-day-today");
  if (day.occurrence_count === 0) classes.push("compact-month-day-empty");
  const dayNumber = Number(day.date.slice(8, 10));
  const items = day.visible_occurrences.map((occurrence) => occurrenceItemHTML(occurrence, esc)).join("");
  const overflow = day.hidden_count > 0
    ? `<details class="compact-month-overflow">` +
      `<summary>+${day.hidden_count} more</summary>` +
      `<ul class="compact-month-overflow-list">${day.overflow_occurrences.map((occurrence) => occurrenceItemHTML(occurrence, esc)).join("")}</ul>` +
      "</details>"
    : "";
  return `<td class="${classes.join(" ")}">` +
    `<time class="compact-month-date" datetime="${esc(day.date)}"${day.is_today ? ' aria-current="date"' : ""}>${dayNumber}</time>` +
    (items ? `<ul class="compact-month-occurrences">${items}</ul>` : "") +
    overflow +
    "</td>";
}

function gridTableHTML(view, esc) {
  const head = WEEKDAY_LABELS.map((label) => `<th scope="col">${esc(label)}</th>`).join("");
  const body = view.weeks.map((week) => `<tr>${week.map((day) => dayCellHTML(day, esc)).join("")}</tr>`).join("");
  return `<table class="compact-month-grid" aria-label="${esc(view.month_label)}">` +
    `<caption>${esc(view.month_label)}</caption>` +
    `<thead><tr>${head}</tr></thead>` +
    `<tbody>${body}</tbody>` +
    "</table>";
}

function agendaDayHTML(day, esc) {
  const items = day.visible_occurrences.map((occurrence) => occurrenceItemHTML(occurrence, esc)).join("");
  const overflow = day.hidden_count > 0
    ? `<details class="compact-month-overflow">` +
      `<summary>+${day.hidden_count} more</summary>` +
      `<ul class="compact-month-overflow-list">${day.overflow_occurrences.map((occurrence) => occurrenceItemHTML(occurrence, esc)).join("")}</ul>` +
      "</details>"
    : "";
  return `<li class="compact-month-agenda-day">` +
    `<time class="compact-month-date" datetime="${esc(day.date)}"${day.is_today ? ' aria-current="date"' : ""}>${esc(day.date)}</time>` +
    `<ul class="compact-month-occurrences">${items}</ul>` +
    overflow +
    "</li>";
}

// A narrow-viewport-friendly reading of the same view model: one vertical
// list of days that actually carry occurrences rather than a cramped
// seven-column grid. CSS alone toggles which of the two forms is visible.
function agendaListHTML(view, esc) {
  const days = view.weeks.flat().filter((day) => day.occurrence_count > 0);
  if (!days.length) return `<p class="compact-month-agenda-empty">No dates in ${esc(view.month_label)}.</p>`;
  return `<ol class="compact-month-agenda">${days.map((day) => agendaDayHTML(day, esc)).join("")}</ol>`;
}

/**
 * Render a `buildCompactMonthView` result. A `render: false` view produces no
 * markup at all — no empty calendar chrome (A2). `options.fullListHref`, when
 * given, adds a retained link back to the surface's full list or timeline.
 */
export function renderCompactMonth(view, options = {}) {
  if (!view || view.render !== true) return "";
  const esc = typeof options.esc === "function" ? options.esc : defaultEscape;
  const fullList = options.fullListHref
    ? `<p class="compact-month-full-list"><a href="${esc(options.fullListHref)}">${esc(options.fullListLabel || "View the full list")}</a></p>`
    : "";
  return `<div class="compact-month" data-compact-month-schema="${esc(COMPACT_MONTH_VIEW_SCHEMA)}" data-compact-month="${esc(view.month)}">` +
    gridTableHTML(view, esc) +
    agendaListHTML(view, esc) +
    fullList +
    "</div>";
}

/**
 * Optional companion binder: forces every crowded-day overflow disclosure
 * open for the duration of printing, then restores whichever ones the reader
 * had not opened themselves. CSS alone cannot guarantee this — a closed
 * native `<details>` may stay excluded from Chromium's print layout even
 * under a `display` override — so print behaviour depends on this binder
 * running once against the mounted document (mirrors the existing
 * `bindAttachmentTableSort` companion-binder pattern in this codebase).
 * A surface that never prints the component does not need to call this.
 */
export function bindCompactMonthPrintDisclosure(root) {
  const scope = root || (typeof document === "undefined" ? null : document);
  if (!scope || typeof window === "undefined") return;
  let openedByPrint = [];
  const openAll = () => {
    openedByPrint = [...scope.querySelectorAll(".compact-month-overflow:not([open])")];
    for (const details of openedByPrint) details.open = true;
  };
  const restore = () => {
    for (const details of openedByPrint) details.open = false;
    openedByPrint = [];
  };
  window.addEventListener("beforeprint", openAll);
  window.addEventListener("afterprint", restore);
}
