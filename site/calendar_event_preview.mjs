/**
 * Bounded in-place calendar event preview (PX-01).
 *
 * Every mounted calendar — Now, Community Boards, rulemaking, land projects,
 * legislative matters, exams, procurement, property opportunities — paints its
 * month through the one shared occurrence renderer in `compact_calendar.mjs`.
 * That renderer emits a real canonical anchor per occurrence, so activating an
 * event has always meant leaving the calendar: the reader loses the month they
 * had selected, their filters, their scroll position and the day they had
 * expanded, in order to answer a question the calendar could have answered in
 * place.
 *
 * This module adds inspection *beside* that anchor rather than instead of it.
 * Two separate affordances, two separate meanings:
 *
 *   - the existing `<a>` is the destination. It keeps working with scripting
 *     off, through the context menu, and under a modified click, because
 *     nothing here intercepts it.
 *   - a sibling native `<button>` is the action. It opens a bounded summary of
 *     one event and nothing else — no navigation, no subscription change, no
 *     save, and no request to the event's publisher.
 *
 * The button is never nested inside the anchor, and the anchor is never
 * silently re-cast as a dialog control. The button is invisible until
 * `bindCalendarEventPreview` marks its container ready, so a reader without
 * scripting is offered only the affordance that actually works for them.
 *
 * The preview facts come from the already-accepted display occurrence: the
 * same title, date precision, lifecycle, location and source-backed
 * destination the cell was admitted with. Nothing is derived, softened, or
 * invented — an occurrence with no location simply has no location line, and a
 * date-only occurrence never acquires a clock time it was not published with.
 *
 * Optional deeper detail is a caller-supplied hook, not a behaviour of this
 * module: when a host passes `loadDetail`, a slower answer for a selection the
 * reader has already moved on from is discarded rather than painted, and a
 * failed one leaves the initial facts and the working full-page link exactly
 * as they were.
 */

import {
  AFFORDANCE_ACTION_ROLES,
  affordanceHandoffPresentation,
} from "./affordance_grammar.mjs";

// Every top-level name below is scoped to this module's subject, because the
// DOM-equivalence contract reconstructs a pre-split build by concatenating
// module sources into one scope: a bare `KIND_LABELS` here would collide with
// the shared month renderer's. This follows the same convention as
// `COMPACT_CALENDAR_ISO_DATE` / `CALENDAR_DISPLAY_ISO_DATE`.
export const CALENDAR_EVENT_PREVIEW_SCHEMA = "cityscroll.calendar_event_preview.v1";

// The version marker carried in rendered markup. The contract identity above
// names this module for its callers; the attribute payload carries only this
// short integer, so no schema vocabulary reaches a resident-facing document.
export const CALENDAR_EVENT_PREVIEW_VERSION = 1;

// One stable element id for the whole document. The dialog is a singleton that
// is reused for every event, so no amount of rerendering can produce a second
// element carrying this id.
export const CALENDAR_EVENT_PREVIEW_DIALOG_ID = "calendar-event-preview";
export const CALENDAR_EVENT_PREVIEW_TITLE_ID = "calendar-event-preview-title";

// The attribute the shared renderer writes and the binder reads. Marking the
// container `ready` is also what reveals the buttons, so a container that was
// never bound never shows an affordance that would not work.
export const CALENDAR_EVENT_PREVIEW_ATTRIBUTE = "data-calendar-event-preview";
export const CALENDAR_EVENT_PREVIEW_READY_ATTRIBUTE = "data-calendar-event-preview-ready";
export const CALENDAR_EVENT_PREVIEW_BUTTON_CLASS = "compact-month-occ-preview";

const PREVIEW_BUTTON_LABEL = "Preview";
const PREVIEW_CLOSE_LABEL = "Close";
const PREVIEW_KICKER = "Calendar event";

// Plain resident-facing labels only, matching the shared renderer's vocabulary.
const PREVIEW_KIND_LABELS = Object.freeze({
  event: "Event",
  deadline: "Deadline",
  window_open: "Opens",
  window_close: "Closes",
  milestone: "Milestone",
});

// The next action is a labelled destination, never a fabricated instruction:
// each entry only names the page the reader already has a link to.
//
// Which set applies is decided by the destination, not by the surface. An
// occurrence's canonical destination is usually a page of this site, but the
// occurrence contract also accepts a publisher's own absolute URL, and a
// reader promised "the event page" who is handed to a publisher instead has
// been told the wrong thing about the click. When the destination leaves this
// site the label says so and stops describing a page this site does not own.
const PREVIEW_KIND_ACTION_LABELS = Object.freeze({
  event: "Open the event page",
  deadline: "Open the page for this deadline",
  window_open: "Open the page for this opening",
  window_close: "Open the page for this closing",
  milestone: "Open the page for this milestone",
});

const PREVIEW_HANDOFF_ACTION_LABEL = "Open the published event page";
const PREVIEW_SOURCE_ACTION_LABEL = "Open the publisher's record";

const PREVIEW_LIFECYCLE_NOTICES = Object.freeze({
  cancelled: "This event is cancelled.",
  rescheduled: "This event was rescheduled; the date below is the currently published one.",
});

const PREVIEW_STATE_LABELS = Object.freeze({
  past: "This date has passed.",
  current: "This is today.",
});

const PREVIEW_ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function previewText(value) {
  const result = String(value ?? "").replace(/\s+/g, " ").trim();
  return result || null;
}

function previewIsDateOnly(value) {
  return typeof value === "string" && PREVIEW_ISO_DATE.test(value);
}

function previewDefaultEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function previewEscapeFor(options) {
  return typeof options?.esc === "function" ? options.esc : previewDefaultEscape;
}

/* ---------- dates ---------- */

// A date-only occurrence is formatted as a date and nothing else. A timestamp
// keeps both halves, rendered in the occurrence's own timezone so an evening
// hearing reads as the civic evening it was published for.
function formatPreviewDay(day) {
  if (!previewIsDateOnly(day)) return null;
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

function formatPreviewTime(startsAt, timezone) {
  if (!startsAt || previewIsDateOnly(startsAt)) return null;
  const instant = Date.parse(startsAt);
  if (Number.isNaN(instant)) return null;
  try {
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
      timeZone: timezone || "UTC",
    }).format(new Date(instant));
  } catch {
    return null;
  }
}

/* ---------- location ---------- */

// The occurrence contract allows a location to be either a plain string or a
// structured venue. Only a value that actually names somewhere is kept; an
// empty or unnameable structure is dropped rather than reported as missing.
function previewLocation(location) {
  if (!location) return null;
  if (typeof location === "string") return previewText(location);
  if (typeof location !== "object") return null;
  const named = previewText(location.name || location.label || location.venue);
  const address = previewText(location.address
    || [location.street_address_1, location.street_address_2, location.city, location.state, location.zip_code]
      .filter(Boolean).join(", "));
  if (named && address && named !== address) return `${named} — ${address}`;
  return named || address;
}

/* ---------- source ---------- */

// The control's name states what following it does. It used to be built from
// the publishing system's own identifier ("Source: city_record"), which named
// neither the consequence nor anything a reader outside this repository knows;
// the system slug is dropped rather than relocated, because a resident-facing
// control is not where an implementation token belongs.
function previewSource(source, canonicalUrl) {
  if (!source || typeof source !== "object") return null;
  const url = previewText(source.url);
  if (!url || url === canonicalUrl) return null;
  return { url, label: PREVIEW_SOURCE_ACTION_LABEL };
}

/* ---------- facts ---------- */

/**
 * Build the bounded preview fact set for one rendered occurrence entry (the
 * `visible_occurrences` / `overflow_occurrences` shape produced by
 * `buildCompactMonthView`). Pure: no clock, no I/O, no fetch.
 *
 * Every optional field is omitted when the occurrence does not carry it. A
 * fact this function does not return is a fact the publisher did not supply,
 * and the preview says nothing about it at all.
 */
export function calendarEventPreviewFacts(entry = {}) {
  const uid = previewText(entry.uid);
  const href = previewText(entry.canonical_url);
  if (!uid || !href) return null;
  const kind = PREVIEW_KIND_LABELS[entry.kind] ? entry.kind : "event";
  const day = previewIsDateOnly(entry.day) ? entry.day : null;
  const timeLabel = formatPreviewTime(entry.starts_at, entry.timezone);
  const lifecycle = PREVIEW_LIFECYCLE_NOTICES[entry.lifecycle] ? entry.lifecycle : null;
  const state = PREVIEW_STATE_LABELS[entry.state] ? entry.state : null;
  const location = previewLocation(entry.location);
  const source = previewSource(entry.source, href);
  return {
    v: CALENDAR_EVENT_PREVIEW_VERSION,
    uid,
    title: previewText(entry.title) || "Civic calendar item",
    kind,
    href,
    // Precision is carried explicitly so a date-only occurrence can never be
    // rendered with a clock time it was never published with.
    precision: timeLabel ? "time" : "date",
    ...(day ? { day } : {}),
    ...(timeLabel ? { time: timeLabel } : {}),
    ...(lifecycle ? { lifecycle } : {}),
    ...(state ? { state } : {}),
    ...(location ? { location } : {}),
    ...(source ? { source } : {}),
  };
}

/** Serialize preview facts for one HTML attribute. */
export function serializeCalendarEventPreview(facts) {
  return facts ? JSON.stringify(facts) : "";
}

/** Parse preview facts back out of an attribute; never throws. */
export function parseCalendarEventPreview(value) {
  if (!value) return null;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || parsed.v !== CALENDAR_EVENT_PREVIEW_VERSION) return null;
  return parsed.uid && parsed.href ? parsed : null;
}

/**
 * The preview trigger: an explicit native button, rendered as a sibling of the
 * canonical anchor rather than inside it, so the two affordances never nest
 * and the link keeps its own meaning. It stays invisible until a bound
 * container marks itself ready.
 */
export function renderCalendarEventPreviewButton(facts, options = {}) {
  if (!facts) return "";
  const esc = previewEscapeFor(options);
  const label = `${PREVIEW_BUTTON_LABEL}: ${facts.title}`;
  return `<button class="${CALENDAR_EVENT_PREVIEW_BUTTON_CLASS}" type="button"` +
    ` ${CALENDAR_EVENT_PREVIEW_ATTRIBUTE}="${esc(serializeCalendarEventPreview(facts))}"` +
    ` data-calendar-event-preview-uid="${esc(facts.uid)}"` +
    ` aria-label="${esc(label)}">${esc(PREVIEW_BUTTON_LABEL)}</button>`;
}

/* ---------- dialog body ---------- */

function previewDefinitionRow(term, value, esc) {
  return `<div class="calendar-event-preview-row"><dt>${esc(term)}</dt><dd>${esc(value)}</dd></div>`;
}

function previewWhenValue(facts) {
  const dayLabel = formatPreviewDay(facts.day) || facts.day;
  if (!dayLabel) return null;
  return facts.precision === "time" && facts.time ? `${dayLabel}, ${facts.time}` : dayLabel;
}

/**
 * Render the bounded preview body: one event summary and its applicable
 * links. Never an embedded copy of the full application document — the full
 * page stays one explicit, visible choice away.
 */
export function renderCalendarEventPreviewBody(facts, options = {}) {
  if (!facts) return "";
  const esc = previewEscapeFor(options);
  const kindLabel = PREVIEW_KIND_LABELS[facts.kind] || PREVIEW_KIND_LABELS.event;
  const when = previewWhenValue(facts);
  const notices = [
    facts.lifecycle ? PREVIEW_LIFECYCLE_NOTICES[facts.lifecycle] : null,
    facts.state ? PREVIEW_STATE_LABELS[facts.state] : null,
  ].filter(Boolean);
  const noticeHTML = notices.length
    ? `<p class="calendar-event-preview-notice">${notices.map((notice) => esc(notice)).join(" ")}</p>`
    : "";
  const rows = [
    previewDefinitionRow("Kind", kindLabel, esc),
    when ? previewDefinitionRow("Date", when, esc) : "",
    facts.location ? previewDefinitionRow("Where", facts.location, esc) : "",
  ].filter(Boolean).join("");
  const detail = previewText(options.detail);
  const detailHTML = detail
    ? `<p class="calendar-event-preview-detail">${esc(detail)}</p>`
    : "";
  const detailStatus = previewText(options.detailStatus);
  const detailStatusHTML = detailStatus
    ? `<p class="calendar-event-preview-detail-status">${esc(detailStatus)}</p>`
    : "";
  // A publisher's record always leaves this site, so it is rendered as the
  // handoff it is: the arrow, the new tab, and the announcement that goes with
  // one — rather than as an anchor indistinguishable from the internal link
  // beside it.
  const sourcePresentation = facts.source
    ? affordanceHandoffPresentation({ href: facts.source.url, escape: esc })
    : null;
  const source = facts.source && sourcePresentation?.role
    ? `<a class="calendar-event-preview-source" href="${esc(facts.source.url)}"` +
      `${sourcePresentation.attributes}>${esc(facts.source.label)}` +
      `${sourcePresentation.glyph}${sourcePresentation.announcement}</a>`
    : "";
  const openPresentation = affordanceHandoffPresentation({ href: facts.href, escape: esc });
  const action = openPresentation.role === AFFORDANCE_ACTION_ROLES.handoff
    ? PREVIEW_HANDOFF_ACTION_LABEL
    : PREVIEW_KIND_ACTION_LABELS[facts.kind] || PREVIEW_KIND_ACTION_LABELS.event;
  return `<p class="calendar-event-preview-kicker">${esc(PREVIEW_KICKER)}</p>` +
    `<h2 class="calendar-event-preview-title" id="${esc(CALENDAR_EVENT_PREVIEW_TITLE_ID)}">${esc(facts.title)}</h2>` +
    noticeHTML +
    `<dl class="calendar-event-preview-facts">${rows}</dl>` +
    detailHTML +
    detailStatusHTML +
    `<p class="calendar-event-preview-actions">` +
    `<a class="calendar-event-preview-open" data-calendar-event-preview-open href="${esc(facts.href)}"` +
    ` data-browse-return-uid="${esc(facts.uid)}"` +
    `${openPresentation.attributes}>${esc(action)}` +
    `${openPresentation.glyph}${openPresentation.announcement}</a>` +
    source +
    "</p>";
}

/* ---------- browser binder ---------- */

const PREVIEW_FOCUSABLE = "a[href], button:not([disabled]), [tabindex]:not([tabindex='-1'])";

// Containers this process has already bound. Binding the same root twice is a
// no-op, so a host that rebinds after a rerender never accumulates listeners.
const boundPreviewRoots = new WeakSet();

// Distinct bindings share one dialog, so each needs to be able to tell whether
// the preview currently on screen is the one it opened. Without that, a
// container binding and a document binding that both see the same click would
// each try to put focus back afterwards, and the second would take it away
// from the control the first correctly returned it to.
const PREVIEW_DIALOG_OWNER_ATTRIBUTE = "data-calendar-event-preview-owner";
let previewBindingSequence = 0;

function previewOwnerDocument(root) {
  if (!root) return typeof document === "undefined" ? null : document;
  if (typeof root.querySelectorAll !== "function") return null;
  return root.ownerDocument || (root.nodeType === 9 ? root : null);
}

function ensurePreviewDialog(doc) {
  const existing = doc.getElementById(CALENDAR_EVENT_PREVIEW_DIALOG_ID);
  if (existing) return existing;
  const dialog = doc.createElement("dialog");
  dialog.id = CALENDAR_EVENT_PREVIEW_DIALOG_ID;
  dialog.className = "calendar-event-preview-dialog";
  // The label is attached with the heading it points at, never before: a
  // reference to an element that does not exist yet is not a label.
  doc.body.appendChild(dialog);
  return dialog;
}

function previewFocusableIn(dialog) {
  return [...dialog.querySelectorAll(PREVIEW_FOCUSABLE)].filter((node) => !node.hasAttribute("hidden"));
}

// Occurrence uids are real publisher identities (`notice:20260722002:deadline`
// and less tidy shapes), so they are compared as values rather than spliced
// into a selector that would then have to be escaped correctly.
function previewTriggerForUid(doc, uid) {
  for (const node of doc.querySelectorAll("[data-calendar-event-preview-uid]")) {
    if (node.getAttribute("data-calendar-event-preview-uid") === uid) return node;
  }
  return null;
}

/**
 * Return focus to the control that opened the preview. When a rerender has
 * replaced that control, the same event's new button is the logical surviving
 * target; when the event itself is gone, the calendar container it lived in
 * is. Focus never silently lands back on the document body.
 */
function returnPreviewFocus(doc, invoker, uid, root) {
  if (invoker && invoker.isConnected && typeof invoker.focus === "function") {
    invoker.focus();
    return invoker;
  }
  const replacement = uid ? previewTriggerForUid(doc, uid) : null;
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
 * Mount the shared preview behaviour on one container. Idempotent, delegated,
 * and rerender-proof: one listener per container handles occurrences that do
 * not exist yet, so a host that repaints its calendar needs no second call and
 * can never install a duplicate listener.
 *
 * `options.loadDetail(facts)` is an optional host-supplied hook for deeper
 * detail this module does not itself go looking for. There is no default:
 * without it, a preview makes no request of any kind.
 *
 * Returns a controller (`{ open, close, destroy }`) or `null` when there is no
 * document to bind to, so server-side rendering is safe.
 */
export function bindCalendarEventPreview(root, options = {}) {
  const doc = previewOwnerDocument(root);
  if (!doc || typeof doc.createElement !== "function" || !doc.body) return null;
  const scope = root && typeof root.querySelectorAll === "function" ? root : doc;
  if (boundPreviewRoots.has(scope)) return null;
  boundPreviewRoots.add(scope);

  const dialog = ensurePreviewDialog(doc);
  previewBindingSequence += 1;
  const bindingId = String(previewBindingSequence);
  // Every open takes the next token. A detail response whose token is no
  // longer current belongs to a selection the reader has already left, so it
  // is dropped instead of overwriting what is on screen.
  let openToken = 0;
  let invoker = null;
  let openUid = null;

  const setBody = (facts, extra) => {
    dialog.innerHTML = `<div class="calendar-event-preview-inner">` +
      `<button class="calendar-event-preview-close" type="button" data-calendar-event-preview-close>${PREVIEW_CLOSE_LABEL}</button>` +
      renderCalendarEventPreviewBody(facts, extra) +
      "</div>";
    dialog.setAttribute("aria-labelledby", CALENDAR_EVENT_PREVIEW_TITLE_ID);
  };

  const close = () => {
    if (!dialog.open) return;
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  };

  const open = (facts, control) => {
    if (!facts) return null;
    openToken += 1;
    const sequence = openToken;
    invoker = control || null;
    openUid = facts.uid;
    dialog.setAttribute(PREVIEW_DIALOG_OWNER_ATTRIBUTE, bindingId);
    dialog.setAttribute("data-browse-return-uid", facts.uid);
    if (control) {
      const day = control.closest?.("[data-compact-month-day]")?.getAttribute("data-compact-month-day");
      if (day) dialog.setAttribute("data-browse-return-day", day);
      else dialog.removeAttribute("data-browse-return-day");
      const nodes = scope.querySelectorAll?.("[data-calendar-event-preview-uid]") || [];
      let appearance = 0;
      for (const node of nodes) {
        if (node === control) break;
        if (node.getAttribute("data-calendar-event-preview-uid") === facts.uid) appearance += 1;
      }
      dialog.setAttribute("data-browse-return-appearance", String(appearance));
    }
    setBody(facts);
    if (!dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else {
        dialog.setAttribute("open", "");
        // Without `showModal` there is no native modality to inherit, so the
        // dialog states its own semantics rather than looking modal silently.
        dialog.setAttribute("role", "dialog");
        dialog.setAttribute("aria-modal", "true");
      }
    }
    const first = dialog.querySelector("[data-calendar-event-preview-close]");
    if (first && typeof first.focus === "function") first.focus();
    if (typeof options.loadDetail === "function") {
      Promise.resolve()
        .then(() => options.loadDetail(facts))
        .then((detail) => {
          // A newer selection, or a closed dialog, wins over a slower answer.
          if (sequence !== openToken || !dialog.open) return;
          const text = previewText(typeof detail === "string" ? detail : detail?.summary);
          if (text) setBody(facts, { detail: text });
        })
        .catch(() => {
          if (sequence !== openToken || !dialog.open) return;
          // The facts the cell was admitted with, and the full-page link, are
          // already correct and stay exactly as they are.
          setBody(facts, { detailStatus: "Further detail did not load. The event page below is unaffected." });
        });
    }
    return dialog;
  };

  const onClick = (event) => {
    const closeControl = event.target.closest?.("[data-calendar-event-preview-close]");
    if (closeControl) {
      event.preventDefault();
      close();
      return;
    }
    const control = event.target.closest?.(`[${CALENDAR_EVENT_PREVIEW_ATTRIBUTE}]`);
    if (!control) return;
    // One activation opens one preview, even where a nested container binding
    // and an enclosing document binding both see the same bubbling click.
    if (event.calendarEventPreviewHandled) return;
    event.calendarEventPreviewHandled = true;
    // The button is not a link: nothing here cancels a navigation, because a
    // button never started one.
    open(parseCalendarEventPreview(control.getAttribute(CALENDAR_EVENT_PREVIEW_ATTRIBUTE)), control);
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
    const focusable = previewFocusableIn(dialog);
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
    // Only the binding that opened this preview returns focus for it.
    if (dialog.getAttribute(PREVIEW_DIALOG_OWNER_ATTRIBUTE) !== bindingId) return;
    returnPreviewFocus(doc, invoker, openUid, scope);
    dialog.removeAttribute(PREVIEW_DIALOG_OWNER_ATTRIBUTE);
    invoker = null;
    openUid = null;
  };

  scope.addEventListener("click", onClick);
  // The dialog lives on `document.body`, so a container-scoped binding does
  // not see its Close button; a document-scoped one already does.
  if (typeof scope.contains !== "function" || !scope.contains(dialog)) dialog.addEventListener("click", onClick);
  dialog.addEventListener("keydown", onKeydown);
  dialog.addEventListener("close", onClose);

  // Revealing the buttons is the last step, so an affordance is only ever
  // visible once the behaviour behind it is actually listening.
  if (typeof scope.setAttribute === "function") scope.setAttribute(CALENDAR_EVENT_PREVIEW_READY_ATTRIBUTE, "");
  else if (doc.documentElement) doc.documentElement.setAttribute(CALENDAR_EVENT_PREVIEW_READY_ATTRIBUTE, "");

  return {
    open,
    close,
    destroy() {
      scope.removeEventListener("click", onClick);
      dialog.removeEventListener("click", onClick);
      dialog.innerHTML = "";
      dialog.removeEventListener("keydown", onKeydown);
      dialog.removeEventListener("close", onClose);
      boundPreviewRoots.delete(scope);
    },
  };
}
