/**
 * In-place Near You record inspection with staged geographic evidence.
 *
 * Progressive enhancement keeps three distinct meanings:
 *
 *   - the static title `<a>` is the canonical record until enhancement is ready
 *   - once bound, a title-sized inspect button opens a bounded modal summary
 *   - a separately named full-record `<a>` keeps native destination behaviour
 *
 * Default cards keep the consequential place role and key facts visible.
 * Geographic matching evidence stays optional inside inspection and never
 * exposes raw adapter method enums as resident copy.
 */

import {
  AFFORDANCE_ACTION_ROLES,
  affordanceHandoffPresentation,
} from "./affordance_grammar.mjs";
import { readerLabel } from "./reader_surface_labels.mjs";

export const NEAR_YOU_RECORD_INSPECTION_SCHEMA = "cityscroll.near_you_record_inspection.v1";
export const NEAR_YOU_RECORD_INSPECTION_VERSION = 1;
export const NEAR_YOU_RECORD_INSPECTION_DIALOG_ID = "near-you-record-inspection";
export const NEAR_YOU_RECORD_INSPECTION_TITLE_ID = "near-you-record-inspection-title";
export const NEAR_YOU_RECORD_INSPECTION_ATTRIBUTE = "data-near-you-record-inspection";
export const NEAR_YOU_RECORD_INSPECTION_READY_ATTRIBUTE = "data-near-you-record-inspection-ready";
export const NEAR_YOU_RECORD_TITLE_LINK_CLASS = "near-record-title-link";
export const NEAR_YOU_RECORD_INSPECT_CLASS = "near-record-inspect";
export const NEAR_YOU_RECORD_FULL_RECORD_CLASS = "near-record-full-record";

const INSPECT_CLOSE_LABEL = "Close";
const INSPECT_KICKER = "Nearby record";
const FULL_RECORD_LABEL = "Open the full record";
const VIEW_RECORD_LABEL = "View the full record";
const VIEW_PUBLISHED_LABEL = "View the published record";
const DETAIL_FAILURE_STATUS = "Further detail did not load. The full record link below is unaffected.";
const DETAIL_RETRY_LABEL = "Try again";
const WEAK_UNCERTAINTY = "Place match is approximate";
const EXPLICIT_AREA_ROLES = new Set(["subject_affected_area", "affected_area", "property_affected", "project_geometry"]);
const VENUE_PLACE_ROLES = new Set(["venue"]);
const MATTER_PLACE_ROLES = new Set(["matter"]);

export const NEAR_YOU_RECORD_TIMING_STATES = Object.freeze([
  "upcoming",
  "past",
  "closed",
  "unknown",
]);

const PLACE_ROLE_USER_LABELS = Object.freeze({
  venue: "Happening here",
  matter: "About this place",
  affected_area: "Affecting this place",
});

const PLACE_ROLE_DETAIL_LABELS = Object.freeze({
  venue: "Meeting venue",
  matter: "Matter place",
  property_affected: "Affected property",
  project_geometry: "Project area",
  place_of_performance: "Place of performance",
});

function inspectText(value, max = 2_000) {
  const result = String(value ?? "").replace(/\s+/g, " ").trim();
  return result ? result.slice(0, max) : null;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeFor(options = {}) {
  return typeof options.escape === "function" ? options.escape : escapeHtml;
}

export function nearYouPlaceRoleUserLabel(role) {
  return PLACE_ROLE_USER_LABELS[role] || null;
}

export function nearYouPlaceRoleDetailLabel(role) {
  if (PLACE_ROLE_DETAIL_LABELS[role]) return PLACE_ROLE_DETAIL_LABELS[role];
  if (role === "affected_area") return "Affected area";
  return null;
}

/**
 * Plain resident reason for a venue match in a named place ("Held in Midwood").
 * Point method and publisher vintage stay in optional geography details.
 */
export function nearYouHeldInLabel(placeLabel) {
  const label = inspectText(placeLabel, 160);
  return label ? `Held in ${label}` : null;
}

/**
 * Plain resident reason for a subject-property match ("About 461 Coney Island Avenue").
 * Keeps the publisher's address wording; neighborhood labels stay on geography details.
 */
export function nearYouAboutLabel(address) {
  const text = inspectText(address, 160);
  return text ? `About ${text}` : null;
}

/**
 * Card / inspection appearance reason from geography evidence and lean record fields.
 * Venue matches stay "Held in …"; subject-property matches stay "About …".
 */
export function nearYouAppearanceReason(record = {}) {
  const evidence = record?.geography_evidence;
  const placeRole = inspectText(record?.matched_place_role, 80)
    || inspectText(evidence?.location_role, 80)
    || inspectText(record?.place?.location_role, 80);
  const subjectAddress = inspectText(
    record?.subject_address
      || record?.place?.subject_address
      || (MATTER_PLACE_ROLES.has(placeRole) && /^About\s/i.test(String(evidence?.basis || ""))
        ? String(evidence.basis).replace(/^About\s+/i, "")
        : null),
    160,
  );
  if (VENUE_PLACE_ROLES.has(placeRole) && evidence?.label) {
    return inspectText(evidence.resident_label, 180) || nearYouHeldInLabel(evidence.label);
  }
  if (record?.place?.location_role === "venue") {
    const venueGeo = (record.place.geographies || []).find((row) =>
      row?.visibility === "public" && row.location_role === "venue" && row.label);
    if (venueGeo?.label) {
      return nearYouHeldInLabel(venueGeo.label) || venueGeo.label;
    }
  }
  if (MATTER_PLACE_ROLES.has(placeRole)) {
    if (evidence?.resident_label && /^About\s/i.test(evidence.resident_label)) {
      return inspectText(evidence.resident_label, 180);
    }
    if (evidence?.basis && /^About\s/i.test(evidence.basis)) {
      return inspectText(evidence.basis, 180);
    }
    const about = nearYouAboutLabel(subjectAddress);
    if (about) return about;
  }
  return inspectText(record?.basis, 160) || "Local activity";
}

function dateLabel(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return inspectText(value, 40);
  // determinism-lint: allow timezone — published dates render in the reader's zone.
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(date);
}

/** Clock time (HH:mm, America/New_York) when the source value carries a time. */
export function nearYouEventTimeLabel(value) {
  if (!value || !/[T ]\d{1,2}:\d{2}/.test(String(value))) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  // determinism-lint: allow timezone — event clocks publish in New York civil time.
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function isoDay(value) {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value || "").trim());
  return match ? match[1] : null;
}

function daysUntilDay(eventDay, todayDay) {
  if (!eventDay || !todayDay) return null;
  const eventMs = Date.parse(`${eventDay}T00:00:00Z`);
  const todayMs = Date.parse(`${todayDay}T00:00:00Z`);
  if (!Number.isFinite(eventMs) || !Number.isFinite(todayMs)) return null;
  return Math.round((eventMs - todayMs) / 86_400_000);
}

/**
 * Dated event or deadline status for a Near You record, against a frozen clock.
 * Expired and unknown times never claim a currently open action.
 */
export function nearYouRecordTiming(record = {}, options = {}) {
  const today = isoDay(options.now) || isoDay(new Date().toISOString());
  const deadline = isoDay(record.deadline || record.due_date || record.comment_by_date);
  const eventDay = isoDay(record.event_date || (!deadline ? record.date : null));

  if (deadline) {
    const daysLeft = daysUntilDay(deadline, today);
    if (daysLeft == null) {
      return Object.freeze({
        kind: "deadline",
        state: "unknown",
        action_open: false,
        event_at: deadline,
        days_left: null,
        label: "Deadline date not published",
      });
    }
    if (daysLeft < 0) {
      return Object.freeze({
        kind: "deadline",
        state: "closed",
        action_open: false,
        event_at: deadline,
        days_left: daysLeft,
        label: `Deadline closed ${dateLabel(deadline) || deadline}`,
      });
    }
    return Object.freeze({
      kind: "deadline",
      state: "upcoming",
      action_open: true,
      event_at: deadline,
      days_left: daysLeft,
      label: `Deadline open through ${dateLabel(deadline) || deadline}`,
    });
  }

  if (eventDay) {
    const daysLeft = daysUntilDay(eventDay, today);
    if (daysLeft == null) {
      return Object.freeze({
        kind: "event",
        state: "unknown",
        action_open: false,
        event_at: eventDay,
        days_left: null,
        label: "Event date not published",
      });
    }
    if (daysLeft < 0) {
      return Object.freeze({
        kind: "event",
        state: "past",
        action_open: false,
        event_at: eventDay,
        days_left: daysLeft,
        label: `Past event · ${dateLabel(eventDay) || eventDay}`,
      });
    }
    return Object.freeze({
      kind: "event",
      state: "upcoming",
      action_open: true,
      event_at: eventDay,
      days_left: daysLeft,
      label: `Upcoming · ${dateLabel(eventDay) || eventDay}`,
    });
  }

  return Object.freeze({
    kind: "unknown",
    state: "unknown",
    action_open: false,
    event_at: null,
    days_left: null,
    label: "Date not published",
  });
}

function timingFacts(value) {
  if (!value || typeof value !== "object") return null;
  const state = NEAR_YOU_RECORD_TIMING_STATES.includes(value.state) ? value.state : "unknown";
  const kind = value.kind === "deadline" || value.kind === "event" || value.kind === "unknown"
    ? value.kind
    : "unknown";
  const actionOpen = value.action_open === true && (state === "upcoming");
  return Object.freeze({
    kind,
    state,
    action_open: actionOpen,
    event_at: isoDay(value.event_at),
    days_left: Number.isFinite(value.days_left) ? value.days_left : null,
    label: inspectText(value.label, 160) || "Date not published",
  });
}

function recordActionLabel(facts, openPresentation) {
  const closedOrUnknown = facts?.timing && facts.timing.action_open !== true;
  if (closedOrUnknown) {
    return openPresentation.role === AFFORDANCE_ACTION_ROLES.handoff
      ? VIEW_PUBLISHED_LABEL
      : VIEW_RECORD_LABEL;
  }
  return openPresentation.role === AFFORDANCE_ACTION_ROLES.handoff
    ? "Open the published record"
    : FULL_RECORD_LABEL;
}

function geographyFacts(evidence) {
  if (!evidence) return null;
  const label = inspectText(evidence.label, 160);
  const basis = inspectText(evidence.basis, 160);
  // Accept location_role from live evidence and place_role from serialized facts.
  const placeRole = inspectText(evidence.location_role, 80)
    || inspectText(evidence.place_role, 80);
  if (!label || !basis || !placeRole) return null;
  const tier = evidence.tier === "strong" || evidence.tier === "derived" || evidence.tier === "weak"
    ? evidence.tier
    : null;
  const heldIn = VENUE_PLACE_ROLES.has(placeRole)
    ? (inspectText(evidence.resident_label, 180) || nearYouHeldInLabel(label))
    : null;
  const aboutMatter = MATTER_PLACE_ROLES.has(placeRole)
    ? (
      (inspectText(evidence.resident_label, 180) && /^About\s/i.test(evidence.resident_label)
        ? inspectText(evidence.resident_label, 180)
        : null)
      || (/^About\s/i.test(basis || "") ? basis : null)
      || nearYouAboutLabel(evidence.subject_address || evidence.original_address)
    )
    : null;
  const residentLabel = heldIn
    || aboutMatter
    || inspectText(evidence.resident_label, 180)
    || (tier !== "weak" && EXPLICIT_AREA_ROLES.has(placeRole)
      ? "About or affecting this area"
      : "Located in this area");
  return Object.freeze({
    key: inspectText(evidence.key, 180),
    source_id: inspectText(evidence.source_id, 180),
    place_role: placeRole,
    place_role_label: nearYouPlaceRoleDetailLabel(placeRole)
      || inspectText(evidence.place_role_label, 80)
      || "Place",
    label,
    basis,
    tier,
    // Humanized only — raw adapter enums must not enter the resident payload.
    method: (() => {
      const raw = inspectText(evidence.method, 100);
      if (!raw) return null;
      const label = readerLabel(raw);
      if (!label || label.includes("_")) return null;
      return label;
    })(),
    resident_label: residentLabel,
    boundary_vintage: inspectText(evidence.boundary_vintage, 80),
  });
}

function whyHereFacts(path) {
  if (!path) return null;
  const label = inspectText(path.location?.label, 160);
  const placeRole = inspectText(path.location?.place_role, 80);
  const agencyName = inspectText(path.agency?.name, 200);
  const agencyHref = inspectText(path.agency?.href, 240);
  const noticeHref = inspectText(path.notice_href, 320);
  if (!label || !placeRole || !agencyName || !agencyHref || !noticeHref) return null;
  const mandateLabel = inspectText(path.mandate?.citation, 240)
    || inspectText(path.mandate?.relation_label, 180)
    || "Connected mandate";
  const tier = path.location?.tier === "strong"
    || path.location?.tier === "derived"
    || path.location?.tier === "weak"
    ? path.location.tier
    : null;
  return Object.freeze({
    place_role: placeRole,
    place_role_label: nearYouPlaceRoleDetailLabel(placeRole) || "Place",
    label,
    agency_name: agencyName,
    agency_href: agencyHref,
    notice_href: noticeHref,
    mandate_label: mandateLabel,
    duty_text: inspectText(path.mandate?.duty_text, 700),
    tier,
  });
}

/**
 * Immutable inspection facts from a Near You result record. Omits raw adapter
 * method enums from the resident projection while preserving place role,
 * consequential basis, and optional geographic evidence for disclosure.
 */
export function nearYouRecordInspectionFacts(record = {}, options = {}) {
  const uid = inspectText(record.id, 160);
  const title = inspectText(record.title, 500);
  const href = inspectText(record.route, 600);
  if (!uid || !title || !href) return null;
  const placeRole = inspectText(record.matched_place_role, 80)
    || inspectText(record.geography_evidence?.location_role, 80)
    || inspectText(record.place?.location_role, 80);
  const geography = geographyFacts(record.geography_evidence);
  const whyHere = whyHereFacts(record.why_here);
  const weak = geography?.tier === "weak" || whyHere?.tier === "weak";
  const timing = timingFacts(nearYouRecordTiming(record, options));
  const sourceUrl = /^https?:\/\//i.test(String(record.source_url || "").trim())
    ? inspectText(record.source_url, 500)
    : null;
  const venueAddress = inspectText(
    record.venue_address || record.venue?.address || record.place?.venue_address,
    240,
  );
  const venueName = inspectText(
    record.venue_name || record.venue?.name || record.place?.venue_name,
    160,
  );
  const subjectAddress = inspectText(
    record.subject_address || record.place?.subject_address,
    240,
  );
  const eventInstant = record.date || record.event_date || null;
  const appearanceReason = nearYouAppearanceReason({
    ...record,
    matched_place_role: placeRole,
    geography_evidence: record.geography_evidence,
    subject_address: subjectAddress,
  });
  const hrefWithSubjectAnchor = subjectAddress && MATTER_PLACE_ROLES.has(placeRole)
    && href && !href.includes("#")
    ? `${href}#agenda-subject`
    : href;
  return Object.freeze({
    schema: NEAR_YOU_RECORD_INSPECTION_SCHEMA,
    version: NEAR_YOU_RECORD_INSPECTION_VERSION,
    uid,
    title,
    href: hrefWithSubjectAnchor,
    agency: inspectText(record.agency, 200),
    type: inspectText(record.type, 120),
    date_label: dateLabel(eventInstant || record.deadline || record.due_date),
    time_label: nearYouEventTimeLabel(eventInstant),
    place_role: placeRole,
    place_role_label: nearYouPlaceRoleUserLabel(placeRole),
    basis: appearanceReason,
    venue_address: venueAddress,
    venue_name: venueName,
    subject_address: subjectAddress,
    source_url: sourceUrl,
    source_label: sourceUrl ? (inspectText(record.source_label, 120) || "Official source") : null,
    timing,
    geography,
    why_here: whyHere,
    uncertainty: weak ? WEAK_UNCERTAINTY : null,
  });
}

export function serializeNearYouRecordInspection(facts) {
  return facts ? JSON.stringify(facts) : "";
}

export function parseNearYouRecordInspection(value) {
  if (!value) return null;
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!parsed || parsed.schema !== NEAR_YOU_RECORD_INSPECTION_SCHEMA) return null;
    if (!inspectText(parsed.uid, 160) || !inspectText(parsed.href, 600) || !inspectText(parsed.title, 500)) {
      return null;
    }
    const geography = geographyFacts(parsed.geography);
    const whyHere = whyHereFacts({
      location: parsed.why_here ? {
        label: parsed.why_here.label,
        place_role: parsed.why_here.place_role,
        tier: parsed.why_here.tier,
      } : null,
      agency: parsed.why_here ? {
        name: parsed.why_here.agency_name,
        href: parsed.why_here.agency_href,
      } : null,
      notice_href: parsed.why_here?.notice_href,
      mandate: parsed.why_here ? {
        citation: parsed.why_here.mandate_label,
        duty_text: parsed.why_here.duty_text,
      } : null,
    });
    const placeRole = inspectText(parsed.place_role, 80);
    const weak = geography?.tier === "weak" || whyHere?.tier === "weak"
      || inspectText(parsed.uncertainty, 120) === WEAK_UNCERTAINTY;
    const sourceUrl = /^https?:\/\//i.test(String(parsed.source_url || "").trim())
      ? inspectText(parsed.source_url, 500)
      : null;
    return Object.freeze({
      schema: NEAR_YOU_RECORD_INSPECTION_SCHEMA,
      version: Number(parsed.version) || NEAR_YOU_RECORD_INSPECTION_VERSION,
      uid: inspectText(parsed.uid, 160),
      title: inspectText(parsed.title, 500),
      href: inspectText(parsed.href, 600),
      agency: inspectText(parsed.agency, 200),
      type: inspectText(parsed.type, 120),
      date_label: inspectText(parsed.date_label, 40),
      time_label: inspectText(parsed.time_label, 16),
      place_role: placeRole,
      place_role_label: nearYouPlaceRoleUserLabel(placeRole) || inspectText(parsed.place_role_label, 80),
      basis: inspectText(parsed.basis, 160) || "Local activity",
      venue_address: inspectText(parsed.venue_address, 240),
      venue_name: inspectText(parsed.venue_name, 160),
      subject_address: inspectText(parsed.subject_address, 240),
      source_url: sourceUrl,
      source_label: sourceUrl
        ? (inspectText(parsed.source_label, 120) || "Official source")
        : null,
      timing: timingFacts(parsed.timing) || timingFacts(nearYouRecordTiming({
        date: parsed.date_label,
        deadline: parsed.timing?.kind === "deadline" ? parsed.timing?.event_at : null,
        event_date: parsed.timing?.kind === "event" ? parsed.timing?.event_at : null,
      })),
      geography,
      why_here: whyHere,
      uncertainty: weak ? WEAK_UNCERTAINTY : null,
    });
  } catch {
    return null;
  }
}

export function nearYouRecordFullRecordLabel() {
  return FULL_RECORD_LABEL;
}

export function renderNearYouRecordInspectButton(facts, options = {}) {
  if (!facts) return "";
  const esc = escapeFor(options);
  const label = `Inspect: ${facts.title}`;
  const payload = esc(serializeNearYouRecordInspection(facts));
  const inner = typeof options.innerHTML === "string" ? options.innerHTML : esc(facts.title);
  return `<button class="${NEAR_YOU_RECORD_INSPECT_CLASS} near-record-title" type="button"` +
    ` ${NEAR_YOU_RECORD_INSPECTION_ATTRIBUTE}="${payload}"` +
    ` data-near-you-record-inspection-uid="${esc(facts.uid)}"` +
    ` aria-label="${esc(label)}">${inner}</button>`;
}

export function renderNearYouRecordFullRecordLink(facts, options = {}) {
  if (!facts) return "";
  const esc = escapeFor(options);
  const openPresentation = affordanceHandoffPresentation({ href: facts.href, escape: esc });
  const actionOpen = facts.timing?.action_open === true;
  return `<a class="${NEAR_YOU_RECORD_FULL_RECORD_CLASS}" href="${esc(facts.href)}"` +
    ` data-browse-return-uid="${esc(facts.uid)}"` +
    ` data-action-open="${actionOpen ? "true" : "false"}"` +
    `${openPresentation.attributes}>${esc(recordActionLabel(facts, openPresentation))}` +
    `${openPresentation.glyph}${openPresentation.announcement}</a>`;
}

function definitionRow(term, value, esc) {
  return `<div class="near-you-record-inspection-row"><dt>${esc(term)}</dt><dd>${esc(value)}</dd></div>`;
}

function renderGeographyDisclosure(facts, esc) {
  const geography = facts.geography;
  if (!geography) return "";
  const uncertainty = geography.tier === "weak"
    ? `<span class="near-you-record-inspection-uncertainty">${esc(WEAK_UNCERTAINTY)}</span>`
    : "";
  const methodLabel = geography.method ? readerLabel(geography.method) : null;
  const method = methodLabel
    ? `<span class="near-you-record-inspection-source">Point method ${esc(methodLabel)}</span>`
    : "";
  const vintage = geography.boundary_vintage
    ? `<span class="near-you-record-inspection-source">Publisher boundary ${esc(geography.boundary_vintage)}</span>`
    : "";
  const source = geography.source_id
    ? `<span class="near-you-record-inspection-source">Source ${esc(geography.source_id)}</span>`
    : "";
  const key = geography.key
    ? `<span class="near-you-record-inspection-source">Geography key ${esc(geography.key)}</span>`
    : "";
  return `<details class="near-you-record-inspection-evidence" data-geography-evidence="1">` +
    `<summary>Why this place matched</summary>` +
    `<span class="near-you-record-inspection-step">${esc(geography.resident_label)}</span>` +
    `<span class="near-you-record-inspection-separator" aria-hidden="true">·</span>` +
    `<span class="near-you-record-inspection-step">${esc(geography.place_role_label)}: ${esc(geography.label)}</span>` +
    `<span class="near-you-record-inspection-separator" aria-hidden="true">·</span>` +
    `<span class="near-you-record-inspection-step">${esc(geography.basis)}</span>` +
    uncertainty +
    method +
    source +
    key +
    vintage +
    `</details>`;
}

function renderWhyHereDisclosure(facts, esc) {
  const path = facts.why_here;
  if (!path) return "";
  const duty = path.duty_text ? ` title="${esc(path.duty_text)}"` : "";
  return `<details class="near-you-record-inspection-evidence" data-why-here-path="1">` +
    `<summary>Why this appears</summary>` +
    `<span class="near-you-record-inspection-step">${esc(path.place_role_label)}: ${esc(path.label)}</span>` +
    `<span class="near-you-record-inspection-separator" aria-hidden="true">·</span>` +
    `<span class="near-you-record-inspection-step">Process: <a href="${esc(path.agency_href)}">${esc(path.agency_name)}</a>` +
    ` → <a href="${esc(path.notice_href)}"${duty}>Mandate: ${esc(path.mandate_label)}</a></span>` +
    `<span class="near-you-record-inspection-source">Public location and civic-process links</span>` +
    `</details>`;
}

export function renderNearYouRecordInspectionBody(facts, options = {}) {
  if (!facts) return "";
  const esc = escapeFor(options);
  const timing = facts.timing;
  const actionOpen = timing?.action_open === true;
  const sourceRow = facts.source_url
    ? `<div class="near-you-record-inspection-row"><dt>Source</dt><dd><a class="near-you-record-inspection-source-link" href="${esc(facts.source_url)}" rel="noopener noreferrer" data-near-you-record-source>${esc(facts.source_label || "Official source")}</a></dd></div>`
    : "";
  const venueLabel = [facts.venue_name, facts.venue_address].filter(Boolean).join(" · ");
  const subjectLabel = facts.subject_address
    ? (nearYouAboutLabel(facts.subject_address) || facts.subject_address)
    : null;
  const rows = [
    facts.place_role_label ? definitionRow("Place role", facts.place_role_label, esc) : "",
    definitionRow("Place claim", facts.basis, esc),
    subjectLabel ? definitionRow("Subject property", subjectLabel, esc) : "",
    venueLabel ? definitionRow("Venue", venueLabel, esc) : "",
    facts.agency ? definitionRow("Agency", facts.agency, esc) : "",
    facts.type ? definitionRow("Type", facts.type, esc) : "",
    facts.date_label ? definitionRow("Date", facts.date_label, esc) : "",
    facts.time_label ? definitionRow("Time", facts.time_label, esc) : "",
    timing ? `<div class="near-you-record-inspection-row" data-record-timing="${esc(timing.state)}" data-action-open="${actionOpen ? "true" : "false"}"><dt>Status</dt><dd>${esc(timing.label)}</dd></div>` : "",
    sourceRow,
    facts.uncertainty ? definitionRow("Certainty", facts.uncertainty, esc) : "",
  ].filter(Boolean).join("");
  const detail = inspectText(options.detail);
  const detailHTML = detail
    ? `<p class="near-you-record-inspection-detail">${esc(detail)}</p>`
    : "";
  const detailStatus = inspectText(options.detailStatus);
  const detailRetry = options.detailRetry === true;
  const detailStatusHTML = detailStatus
    ? `<p class="near-you-record-inspection-detail-status" data-near-you-record-detail-status="failed">${esc(detailStatus)}</p>` +
      (detailRetry
        ? `<p class="near-you-record-inspection-detail-retry"><button class="near-you-record-inspection-retry" type="button" data-near-you-record-inspection-retry>${esc(DETAIL_RETRY_LABEL)}</button></p>`
        : "")
    : "";
  const evidence = `${renderGeographyDisclosure(facts, esc)}${renderWhyHereDisclosure(facts, esc)}`;
  const openPresentation = affordanceHandoffPresentation({ href: facts.href, escape: esc });
  const actionLabel = recordActionLabel(facts, openPresentation);
  return `<p class="near-you-record-inspection-kicker">${esc(INSPECT_KICKER)}</p>` +
    `<h2 class="near-you-record-inspection-title" id="${esc(NEAR_YOU_RECORD_INSPECTION_TITLE_ID)}">${esc(facts.title)}</h2>` +
    `<dl class="near-you-record-inspection-facts">${rows}</dl>` +
    evidence +
    detailHTML +
    detailStatusHTML +
    `<p class="near-you-record-inspection-actions">` +
    `<a class="near-you-record-inspection-open" data-near-you-record-inspection-open href="${esc(facts.href)}"` +
    ` data-browse-return-uid="${esc(facts.uid)}"` +
    ` data-action-open="${actionOpen ? "true" : "false"}"` +
    `${openPresentation.attributes}>${esc(actionLabel)}` +
    `${openPresentation.glyph}${openPresentation.announcement}</a>` +
    "</p>";
}

const INSPECT_FOCUSABLE = "a[href], button:not([disabled]), [tabindex]:not([tabindex='-1'])";
const boundInspectionRoots = new WeakSet();
const DIALOG_OWNER_ATTRIBUTE = "data-near-you-record-inspection-owner";
let inspectionBindingSequence = 0;

function ownerDocument(root) {
  if (!root) return typeof document === "undefined" ? null : document;
  if (typeof root.querySelectorAll !== "function") return null;
  return root.ownerDocument || (root.nodeType === 9 ? root : null);
}

function ensureDialog(doc) {
  const existing = doc.getElementById(NEAR_YOU_RECORD_INSPECTION_DIALOG_ID);
  if (existing) return existing;
  const dialog = doc.createElement("dialog");
  dialog.id = NEAR_YOU_RECORD_INSPECTION_DIALOG_ID;
  dialog.className = "near-you-record-inspection-dialog";
  doc.body.appendChild(dialog);
  return dialog;
}

function focusableIn(dialog) {
  return [...dialog.querySelectorAll(INSPECT_FOCUSABLE)].filter((node) => !node.hasAttribute("hidden"));
}

function triggerForUid(doc, uid) {
  for (const node of doc.querySelectorAll("[data-near-you-record-inspection-uid]")) {
    if (node.getAttribute("data-near-you-record-inspection-uid") === uid) return node;
  }
  return null;
}

function returnFocus(doc, invoker, uid, root) {
  if (invoker && invoker.isConnected && typeof invoker.focus === "function") {
    invoker.focus();
    return invoker;
  }
  const replacement = uid ? triggerForUid(doc, uid) : null;
  if (replacement && typeof replacement.focus === "function") {
    replacement.focus();
    return replacement;
  }
  const survivor = root && root.isConnected
    ? root.querySelector("[data-near-you-root], .near-results, main") || root
    : null;
  if (survivor && typeof survivor.focus === "function") {
    if (!survivor.hasAttribute("tabindex")) survivor.setAttribute("tabindex", "-1");
    survivor.focus();
    return survivor;
  }
  return null;
}

/**
 * Mount Near You record inspection on one container. Idempotent and delegated so
 * deferred result adoption does not require a second bind.
 */
export function bindNearYouRecordInspection(root, options = {}) {
  const doc = ownerDocument(root);
  if (!doc || typeof doc.createElement !== "function" || !doc.body) return null;
  const scope = root && typeof root.querySelectorAll === "function" ? root : doc;
  if (boundInspectionRoots.has(scope)) return null;
  boundInspectionRoots.add(scope);

  const dialog = ensureDialog(doc);
  inspectionBindingSequence += 1;
  const bindingId = String(inspectionBindingSequence);
  let openToken = 0;
  let invoker = null;
  let openUid = null;

  const setBody = (facts, extra) => {
    dialog.innerHTML = `<div class="near-you-record-inspection-inner">` +
      `<button class="near-you-record-inspection-close" type="button" data-near-you-record-inspection-close>${INSPECT_CLOSE_LABEL}</button>` +
      renderNearYouRecordInspectionBody(facts, extra) +
      "</div>";
    dialog.setAttribute("aria-labelledby", NEAR_YOU_RECORD_INSPECTION_TITLE_ID);
  };

  const close = () => {
    if (!dialog.open) return;
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  };

  let openFacts = null;

  const requestDetail = (facts, sequence) => {
    if (typeof options.loadDetail !== "function") return;
    Promise.resolve()
      .then(() => options.loadDetail(facts))
      .then((detail) => {
        if (sequence !== openToken || !dialog.open) return;
        const text = inspectText(typeof detail === "string" ? detail : detail?.summary);
        if (text) setBody(facts, { detail: text });
      })
      .catch(() => {
        if (sequence !== openToken || !dialog.open) return;
        setBody(facts, { detailStatus: DETAIL_FAILURE_STATUS, detailRetry: true });
      });
  };

  const open = (facts, control) => {
    if (!facts) return null;
    openToken += 1;
    const sequence = openToken;
    invoker = control || null;
    openUid = facts.uid;
    openFacts = facts;
    dialog.setAttribute(DIALOG_OWNER_ATTRIBUTE, bindingId);
    dialog.setAttribute("data-browse-return-uid", facts.uid);
    setBody(facts);
    if (!dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else {
        dialog.setAttribute("open", "");
        dialog.setAttribute("role", "dialog");
        dialog.setAttribute("aria-modal", "true");
      }
    }
    const first = dialog.querySelector("[data-near-you-record-inspection-close]");
    if (first && typeof first.focus === "function") first.focus();
    requestDetail(facts, sequence);
    return dialog;
  };

  const onClick = (event) => {
    const closeControl = event.target.closest?.("[data-near-you-record-inspection-close]");
    if (closeControl) {
      event.preventDefault();
      close();
      return;
    }
    const retryControl = event.target.closest?.("[data-near-you-record-inspection-retry]");
    if (retryControl && dialog.open && openFacts) {
      event.preventDefault();
      openToken += 1;
      const sequence = openToken;
      setBody(openFacts);
      requestDetail(openFacts, sequence);
      return;
    }
    const control = event.target.closest?.(`[${NEAR_YOU_RECORD_INSPECTION_ATTRIBUTE}]`);
    if (!control) return;
    if (event.nearYouRecordInspectionHandled) return;
    event.nearYouRecordInspectionHandled = true;
    // Modified clicks on the inspect control still inspect; native navigation
    // stays on the separately named full-record link.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      event.preventDefault();
    }
    open(parseNearYouRecordInspection(control.getAttribute(NEAR_YOU_RECORD_INSPECTION_ATTRIBUTE)), control);
  };

  const onKeydown = (event) => {
    if (!dialog.open) return;
    if (event.key === "Escape" && typeof dialog.showModal !== "function") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = focusableIn(dialog);
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
    if (dialog.getAttribute(DIALOG_OWNER_ATTRIBUTE) !== bindingId) return;
    returnFocus(doc, invoker, openUid, scope);
    dialog.removeAttribute(DIALOG_OWNER_ATTRIBUTE);
    invoker = null;
    openUid = null;
    openFacts = null;
  };

  scope.addEventListener("click", onClick);
  if (typeof scope.contains !== "function" || !scope.contains(dialog)) dialog.addEventListener("click", onClick);
  dialog.addEventListener("keydown", onKeydown);
  dialog.addEventListener("close", onClose);

  if (typeof scope.setAttribute === "function") scope.setAttribute(NEAR_YOU_RECORD_INSPECTION_READY_ATTRIBUTE, "");
  else if (doc.documentElement) doc.documentElement.setAttribute(NEAR_YOU_RECORD_INSPECTION_READY_ATTRIBUTE, "");

  return {
    open,
    close,
    destroy() {
      scope.removeEventListener("click", onClick);
      dialog.removeEventListener("click", onClick);
      dialog.innerHTML = "";
      dialog.removeEventListener("keydown", onKeydown);
      dialog.removeEventListener("close", onClose);
      boundInspectionRoots.delete(scope);
    },
  };
}
