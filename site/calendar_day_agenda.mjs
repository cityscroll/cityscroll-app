/**
 * Shared crowded-day agenda for the compact month component (PX-02).
 *
 * A month grid is an overview. Reading one is a different task from reading a
 * notice, and the shared renderer had been trying to serve both at once: a day
 * cell painted its first three occurrences with unbounded titles, and put the
 * remainder behind a native disclosure that expanded the whole month row when
 * a reader opened it. A single long procurement title could therefore decide
 * how tall a week was, and reaching a crowded day's fourth event meant
 * destroying the overview that made the day worth looking at.
 *
 * This module supplies the other half of the fix. `compact_calendar.mjs` bounds
 * what a cell paints; this opens the complete day beside the month rather than
 * inside it:
 *
 *   - the trigger is an explicit native `<button>` carrying the exact number
 *     of events the cell could not show, with an accessible name that states
 *     the day and its complete total.
 *   - the panel it opens lists *every* accepted occurrence for that day, in
 *     the same order the cell used, with each title unabridged and its kind,
 *     supplied clock time, lifecycle and venue stated in text beside it.
 *   - each event keeps its real canonical link, so every action in the agenda
 *     is reachable by touch and by keyboard.
 *
 * The button is invisible until `bindCalendarDayAgenda` marks its container
 * ready, and the renderer keeps the native `<details>` disclosure in the
 * document as the unenhanced reading. A reader without scripting is offered
 * only the affordance that actually works for them, and no occurrence is ever
 * absent from the document in either mode.
 *
 * Facts come from the already-accepted display occurrences the cell was
 * admitted with, through the same bounded fact builder the in-place preview
 * uses. Nothing here derives, softens, summarizes or invents anything: a
 * date-only occurrence acquires no clock time, an absent optional field
 * produces no line, and a cancelled occurrence says so before its link.
 */

// Every top-level name is scoped to this module's subject, because the
// DOM-equivalence contract reconstructs a pre-split build by concatenating
// module sources into one scope: a bare `KIND_LABELS` here would collide with
// the shared month renderer's.
import { calendarEventPreviewFacts } from "./calendar_event_preview.mjs";

export const CALENDAR_DAY_AGENDA_SCHEMA = "cityscroll.calendar_day_agenda.v1";

// The version marker carried in rendered markup. The contract identity above
// names this module for its callers; the attribute payload carries only this
// short integer, so no schema vocabulary reaches a resident-facing document.
export const CALENDAR_DAY_AGENDA_VERSION = 1;

// One stable element id for the whole document. The panel is a singleton that
// is reused for every day, so no amount of rerendering can produce a second
// element carrying this id.
export const CALENDAR_DAY_AGENDA_DIALOG_ID = "calendar-day-agenda";
export const CALENDAR_DAY_AGENDA_TITLE_ID = "calendar-day-agenda-title";

// The attribute the shared renderer writes and the binder reads. Marking the
// container `ready` is also what swaps the unenhanced disclosure for the
// button, so a container that was never bound keeps the reading that works.
export const CALENDAR_DAY_AGENDA_ATTRIBUTE = "data-calendar-day-agenda";
export const CALENDAR_DAY_AGENDA_DAY_ATTRIBUTE = "data-calendar-day-agenda-day";
export const CALENDAR_DAY_AGENDA_UID_ATTRIBUTE = "data-calendar-day-agenda-uid";
export const CALENDAR_DAY_AGENDA_READY_ATTRIBUTE = "data-calendar-day-agenda-ready";
export const CALENDAR_DAY_AGENDA_BUTTON_CLASS = "compact-month-day-more";

const AGENDA_CLOSE_LABEL = "Close";
const AGENDA_KICKER = "Calendar day";

// Plain resident-facing labels only, matching the shared renderer's vocabulary.
const AGENDA_KIND_LABELS = Object.freeze({
  event: "Event",
  deadline: "Deadline",
  window_open: "Opens",
  window_close: "Closes",
  milestone: "Milestone",
});

const AGENDA_LIFECYCLE_FLAGS = Object.freeze({
  cancelled: "Cancelled",
  rescheduled: "Rescheduled",
});

const AGENDA_LIFECYCLE_NOTICES = Object.freeze({
  cancelled: "This event is cancelled.",
  rescheduled: "This event was rescheduled; the date shown is the currently published one.",
});

const AGENDA_STATE_LABELS = Object.freeze({
  past: "This date has passed.",
  current: "This is today.",
});

const AGENDA_ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function agendaText(value) {
  const result = String(value ?? "").replace(/\s+/g, " ").trim();
  return result || null;
}

function agendaDefaultEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function agendaEscapeFor(options) {
  return typeof options?.esc === "function" ? options.esc : agendaDefaultEscape;
}

/**
 * The day's own heading. A calendar day is named in full — weekday, month, day
 * and year — because the panel is read away from the grid that supplied the
 * column it sat in.
 */
export function formatCalendarDayLabel(day) {
  if (typeof day !== "string" || !AGENDA_ISO_DATE.test(day)) return null;
  const instant = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(instant)) return null;
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(instant));
  } catch {
    return day;
  }
}

/* ---------- facts ---------- */

/**
 * Build the agenda fact set for one rendered day cell (the shape
 * `buildCompactMonthView` produces). Pure: no clock, no I/O, no fetch.
 *
 * Every accepted occurrence for the day is carried, visible ones first and
 * then the ones the cell could not show, which is exactly the stable per-day
 * order the cell itself used. `hidden` is the count the trigger states, and it
 * is the real remainder rather than a rounded or capped figure.
 *
 * Returns `null` for a day with nothing to disclose, so a cell that shows
 * everything it has offers no agenda trigger at all.
 */
export function calendarDayAgendaFacts(day = {}) {
  const date = typeof day.date === "string" && AGENDA_ISO_DATE.test(day.date) ? day.date : null;
  if (!date) return null;
  const visible = Array.isArray(day.visible_occurrences) ? day.visible_occurrences : [];
  const overflow = Array.isArray(day.overflow_occurrences) ? day.overflow_occurrences : [];
  if (!overflow.length) return null;
  const events = [...visible, ...overflow].map(calendarEventPreviewFacts).filter(Boolean);
  if (!events.length) return null;
  return {
    v: CALENDAR_DAY_AGENDA_VERSION,
    day: date,
    label: formatCalendarDayLabel(date) || date,
    // The complete accepted total and the exact remainder the cell could not
    // paint. Both are counted from the admitted occurrences themselves.
    total: events.length,
    hidden: overflow.length,
    events,
  };
}

/** Serialize agenda facts for one HTML attribute. */
export function serializeCalendarDayAgenda(facts) {
  return facts ? JSON.stringify(facts) : "";
}

/** Parse agenda facts back out of an attribute; never throws. */
export function parseCalendarDayAgenda(value) {
  if (!value) return null;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || parsed.v !== CALENDAR_DAY_AGENDA_VERSION) return null;
  return parsed.day && Array.isArray(parsed.events) && parsed.events.length ? parsed : null;
}

/**
 * The agenda trigger: an explicit native button rendered beside the day's
 * visible occurrences. Its visible text is the exact number of events the cell
 * could not show; its accessible name states the complete total and the day,
 * so the control is never a bare symbol whose meaning has to be guessed or
 * hovered for. It stays invisible until a bound container marks itself ready.
 */
export function renderCalendarDayAgendaButton(facts, options = {}) {
  if (!facts) return "";
  const esc = agendaEscapeFor(options);
  const noun = facts.total === 1 ? "event" : "events";
  const label = `Show all ${facts.total} ${noun} on ${facts.label}`;
  return `<button class="${CALENDAR_DAY_AGENDA_BUTTON_CLASS}" type="button"` +
    ` ${CALENDAR_DAY_AGENDA_ATTRIBUTE}="${esc(serializeCalendarDayAgenda(facts))}"` +
    ` ${CALENDAR_DAY_AGENDA_DAY_ATTRIBUTE}="${esc(facts.day)}"` +
    ` aria-label="${esc(label)}">+${esc(facts.hidden)} more</button>`;
}

/* ---------- panel body ---------- */

function agendaWhenValue(event) {
  return event.precision === "time" && event.time ? event.time : "All day";
}

function agendaItemHTML(event, esc) {
  const kindLabel = AGENDA_KIND_LABELS[event.kind] || AGENDA_KIND_LABELS.event;
  const flag = AGENDA_LIFECYCLE_FLAGS[event.lifecycle];
  const notices = [
    event.lifecycle ? AGENDA_LIFECYCLE_NOTICES[event.lifecycle] : null,
    event.state ? AGENDA_STATE_LABELS[event.state] : null,
  ].filter(Boolean);
  const classes = [
    "calendar-day-agenda-item",
    `calendar-day-agenda-item-${event.kind}`,
    `calendar-day-agenda-item-lifecycle-${event.lifecycle || "scheduled"}`,
  ];
  // Kind, supplied time and lifecycle are stated in their own text, above the
  // title rather than inside it, so they stay legible however long the title
  // is and whatever the cell had to clip.
  const meta = `<p class="calendar-day-agenda-item-meta">` +
    `<span class="calendar-day-agenda-item-kind">${esc(kindLabel)}</span>` +
    `<span class="calendar-day-agenda-item-time">${esc(agendaWhenValue(event))}</span>` +
    (flag ? `<span class="calendar-day-agenda-item-flag calendar-day-agenda-item-flag-${esc(event.lifecycle)}">${esc(flag)}</span>` : "") +
    "</p>";
  // The unabridged title, as a real link to the event's own page.
  const title = `<a class="calendar-day-agenda-item-link" href="${esc(event.href)}">${esc(event.title)}</a>`;
  const noticeHTML = notices.length
    ? `<p class="calendar-day-agenda-item-notice">${notices.map((notice) => esc(notice)).join(" ")}</p>`
    : "";
  const where = event.location
    ? `<p class="calendar-day-agenda-item-where">${esc(event.location)}</p>`
    : "";
  return `<li class="${classes.join(" ")}" ${CALENDAR_DAY_AGENDA_UID_ATTRIBUTE}="${esc(event.uid)}">` +
    meta + noticeHTML + title + where +
    "</li>";
}

/**
 * Render the day agenda body: the named day, its complete accepted total, and
 * every one of its occurrences in the cell's own order. Not an embedded copy
 * of any event's page — each full page stays one explicit link away.
 */
export function renderCalendarDayAgendaBody(facts, options = {}) {
  if (!facts) return "";
  const esc = agendaEscapeFor(options);
  const noun = facts.total === 1 ? "event" : "events";
  return `<p class="calendar-day-agenda-kicker">${esc(AGENDA_KICKER)}</p>` +
    `<h2 class="calendar-day-agenda-title" id="${esc(CALENDAR_DAY_AGENDA_TITLE_ID)}">${esc(facts.label)}</h2>` +
    `<p class="calendar-day-agenda-count">${esc(facts.total)} ${esc(noun)}</p>` +
    `<ol class="calendar-day-agenda-list">${facts.events.map((event) => agendaItemHTML(event, esc)).join("")}</ol>`;
}

/* ---------- browser binder ---------- */

const AGENDA_FOCUSABLE = "a[href], button:not([disabled]), [tabindex]:not([tabindex='-1'])";

// Containers this process has already bound. Binding the same root twice is a
// no-op, so a host that rebinds after a rerender never accumulates listeners.
const boundAgendaRoots = new WeakSet();

// Distinct bindings share one panel, so each needs to be able to tell whether
// the agenda currently on screen is the one it opened. Without that, a
// container binding and a document binding that both saw the same click would
// each try to put focus back afterwards.
const AGENDA_DIALOG_OWNER_ATTRIBUTE = "data-calendar-day-agenda-owner";
let agendaBindingSequence = 0;

function agendaOwnerDocument(root) {
  if (!root) return typeof document === "undefined" ? null : document;
  if (typeof root.querySelectorAll !== "function") return null;
  return root.ownerDocument || (root.nodeType === 9 ? root : null);
}

function ensureAgendaDialog(doc) {
  const existing = doc.getElementById(CALENDAR_DAY_AGENDA_DIALOG_ID);
  if (existing) return existing;
  const dialog = doc.createElement("dialog");
  dialog.id = CALENDAR_DAY_AGENDA_DIALOG_ID;
  dialog.className = "calendar-day-agenda-dialog";
  doc.body.appendChild(dialog);
  return dialog;
}

function agendaFocusableIn(dialog) {
  return [...dialog.querySelectorAll(AGENDA_FOCUSABLE)].filter((node) => !node.hasAttribute("hidden"));
}

// Days are compared as attribute values rather than spliced into a selector,
// for the same reason occurrence identities are in the preview binder.
function agendaTriggerForDay(doc, day) {
  for (const node of doc.querySelectorAll(`[${CALENDAR_DAY_AGENDA_DAY_ATTRIBUTE}]`)) {
    if (node.getAttribute(CALENDAR_DAY_AGENDA_DAY_ATTRIBUTE) === day) return node;
  }
  return null;
}

/**
 * Return focus to the control that opened the agenda. When a rerender has
 * replaced that control, the same day's new trigger is the logical surviving
 * target; when the day itself is gone, the calendar it lived in is. Focus
 * never silently lands back on the document body.
 */
function returnAgendaFocus(doc, invoker, day, root) {
  if (invoker && invoker.isConnected && typeof invoker.focus === "function") {
    invoker.focus();
    return invoker;
  }
  const replacement = day ? agendaTriggerForDay(doc, day) : null;
  if (replacement && typeof replacement.focus === "function") {
    replacement.focus();
    return replacement;
  }
  const survivor = root && root.isConnected ? root.querySelector(".compact-month") || root : null;
  if (survivor && typeof survivor.focus === "function") {
    if (!survivor.hasAttribute("tabindex")) survivor.setAttribute("tabindex", "-1");
    survivor.focus();
    return survivor;
  }
  return null;
}

/**
 * Mount the shared day-agenda behaviour on one container. Idempotent,
 * delegated, and rerender-proof: one listener per container handles day cells
 * that do not exist yet, so a host that repaints its calendar needs no second
 * call and can never install a duplicate listener.
 *
 * Returns a controller (`{ open, close, destroy }`) or `null` when there is no
 * document to bind to, so server-side rendering is safe.
 */
export function bindCalendarDayAgenda(root, options = {}) {
  const doc = agendaOwnerDocument(root);
  if (!doc || typeof doc.createElement !== "function" || !doc.body) return null;
  const scope = root && typeof root.querySelectorAll === "function" ? root : doc;
  if (boundAgendaRoots.has(scope)) return null;
  boundAgendaRoots.add(scope);

  const dialog = ensureAgendaDialog(doc);
  agendaBindingSequence += 1;
  const bindingId = String(agendaBindingSequence);
  let invoker = null;
  let openDay = null;

  const setBody = (facts) => {
    dialog.innerHTML = `<div class="calendar-day-agenda-inner">` +
      `<button class="calendar-day-agenda-close" type="button" data-calendar-day-agenda-close>${AGENDA_CLOSE_LABEL}</button>` +
      renderCalendarDayAgendaBody(facts, options) +
      "</div>";
    dialog.setAttribute("aria-labelledby", CALENDAR_DAY_AGENDA_TITLE_ID);
  };

  const close = () => {
    if (!dialog.open) return;
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  };

  const open = (facts, control) => {
    if (!facts) return null;
    invoker = control || null;
    openDay = facts.day;
    dialog.setAttribute(AGENDA_DIALOG_OWNER_ATTRIBUTE, bindingId);
    setBody(facts);
    if (!dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else {
        dialog.setAttribute("open", "");
        // Without `showModal` there is no native modality to inherit, so the
        // panel states its own semantics rather than looking modal silently.
        dialog.setAttribute("role", "dialog");
        dialog.setAttribute("aria-modal", "true");
      }
    }
    const first = dialog.querySelector("[data-calendar-day-agenda-close]");
    if (first && typeof first.focus === "function") first.focus();
    return dialog;
  };

  const onClick = (event) => {
    const closeControl = event.target.closest?.("[data-calendar-day-agenda-close]");
    if (closeControl) {
      event.preventDefault();
      close();
      return;
    }
    const control = event.target.closest?.(`[${CALENDAR_DAY_AGENDA_ATTRIBUTE}]`);
    if (!control) return;
    // One activation opens one agenda, even where a nested container binding
    // and an enclosing document binding both see the same bubbling click.
    if (event.calendarDayAgendaHandled) return;
    event.calendarDayAgendaHandled = true;
    open(parseCalendarDayAgenda(control.getAttribute(CALENDAR_DAY_AGENDA_ATTRIBUTE)), control);
  };

  // Native modal dialogs already contain Tab; this keeps the same contract on
  // the non-modal fallback path, where nothing would otherwise hold focus.
  const onKeydown = (event) => {
    if (!dialog.open) return;
    if (event.key === "Escape" && typeof dialog.showModal !== "function") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = agendaFocusableIn(dialog);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = doc.activeElement;
    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    }
  };

  const onClose = () => {
    // Only the binding that opened this agenda returns focus for it.
    if (dialog.getAttribute(AGENDA_DIALOG_OWNER_ATTRIBUTE) !== bindingId) return;
    returnAgendaFocus(doc, invoker, openDay, scope);
    dialog.removeAttribute(AGENDA_DIALOG_OWNER_ATTRIBUTE);
    invoker = null;
    openDay = null;
  };

  scope.addEventListener("click", onClick);
  // The panel lives on `document.body`, so a container-scoped binding does not
  // see its Close button; a document-scoped one already does.
  if (typeof scope.contains !== "function" || !scope.contains(dialog)) dialog.addEventListener("click", onClick);
  dialog.addEventListener("keydown", onKeydown);
  dialog.addEventListener("close", onClose);

  // Revealing the trigger — and standing the unenhanced disclosure down — is
  // the last step, so the reading a container offers is always one that works.
  if (typeof scope.setAttribute === "function") scope.setAttribute(CALENDAR_DAY_AGENDA_READY_ATTRIBUTE, "");
  else if (doc.documentElement) doc.documentElement.setAttribute(CALENDAR_DAY_AGENDA_READY_ATTRIBUTE, "");

  return {
    open,
    close,
    destroy() {
      scope.removeEventListener("click", onClick);
      dialog.removeEventListener("click", onClick);
      dialog.innerHTML = "";
      dialog.removeEventListener("keydown", onKeydown);
      dialog.removeEventListener("close", onClose);
      boundAgendaRoots.delete(scope);
    },
  };
}
