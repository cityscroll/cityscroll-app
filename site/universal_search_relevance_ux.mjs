/**
 * Resident-facing relevance projection for federated SearchDocuments.
 *
 * Ranking and source adapters own match evidence and lifecycle truth. This
 * module only turns that evidence into safe, inspectable result-card copy.
 */

import { isSafeSearchCanonicalRoute } from "./search_document_contract.mjs";

export const UNIVERSAL_SEARCH_RELEVANCE_VIEW_SCHEMA =
  "cityscroll.universal_search_relevance_view.v1";

const TYPE_LABELS = Object.freeze({
  procurement: "Contract",
  rulemaking: "Rule",
  meeting: "Meeting",
  mandate: "Mandate",
  land_use_project: "Land-use project",
  person: "Person",
  official: "Official",
  agency: "Agency",
  vendor: "Vendor",
  committee: "Committee",
  community_board: "Community board",
  civil_service_exam: "Civil-service exam",
  parcel: "Property",
  unclassified: "Published record",
});

const LENS_LABELS = Object.freeze({
  notices: "Published notices",
  people: "People",
  agencies: "Agencies",
  vendors: "Vendors",
  committees: "Committees",
  community_boards: "Community boards",
  exams: "Exams",
  parcels: "Properties",
});

const FIELD_REASONS = Object.freeze({
  title: "Title match",
  display_name: "Name match",
  name: "Name match",
  alias: "Alias match",
  address: "Address match",
  code: "Official code match",
  identifier: "Official ID match",
  exam_number: "Exam number match",
  bbl: "Property ID match",
  summary: "Summary match",
  description: "Record text match",
  notice_text: "Notice text match",
  attachment_text: "Attachment text match",
  search_text: "Record text match",
});

const ARCHIVE_STATES = new Set(["archived", "closed", "expired", "past"]);
const ACTIVE_STATES = new Set(["active", "current", "open", "scheduled", "upcoming"]);

function clean(value, max = 500) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function uniqueStrings(values, max = 1_200) {
  const seen = new Set();
  const strings = [];
  for (const value of values.flat(Infinity)) {
    const normalized = clean(value, max);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    strings.push(normalized);
  }
  return strings;
}

function containsTerm(value, term) {
  return clean(value, 8_000).toLocaleLowerCase("en-US")
    .includes(clean(term, 240).toLocaleLowerCase("en-US"));
}

function excerptAround(value, term, max = 240) {
  const text = clean(value, 8_000);
  if (text.length <= max) return text;
  const index = text.toLocaleLowerCase("en-US")
    .indexOf(clean(term, 240).toLocaleLowerCase("en-US"));
  if (index < 0) return `${text.slice(0, max - 1).trimEnd()}…`;
  const half = Math.floor((max - clean(term, 240).length) / 2);
  let start = Math.max(0, index - half);
  let end = Math.min(text.length, start + max);
  start = Math.max(0, end - max);
  return `${start ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

function matchFieldValues(record, field) {
  const provenance = record?.provenance || {};
  const declared = provenance.match_fields || {};
  const identity = provenance.identity || {};
  const common = [record?.title, record?.summary, record?.search_text];
  switch (field) {
    case "title":
    case "display_name":
    case "name":
      return uniqueStrings([record?.title, declared.display_name, declared.name]);
    case "alias":
      return uniqueStrings([
        declared.aliases,
        provenance.identity_aliases,
        provenance.reviewed_aliases,
        provenance.aliases,
        common,
      ]);
    case "address":
      return uniqueStrings([provenance.address_labels, declared.addresses, common]);
    case "exam_number":
      return uniqueStrings([identity.exam_number, record?.object_ref?.replace(/^exam:/, ""), common]);
    case "bbl":
      return uniqueStrings([identity.bbl, record?.object_ref?.replace(/^parcel:/, ""), common]);
    case "code":
    case "identifier":
      return uniqueStrings([
        identity.code,
        identity.id,
        provenance.publisher_body_id,
        record?.object_ref?.split(":").at(-1),
        common,
      ]);
    case "notice_text":
    case "attachment_text":
    case "description":
    case "search_text":
      return uniqueStrings([record?.summary, record?.search_text, record?.title]);
    case "summary":
      return uniqueStrings([record?.summary, record?.title, record?.search_text]);
    default:
      return uniqueStrings(common);
  }
}

function matchEvidence(record) {
  const match = Array.isArray(record?.match_fields) ? record.match_fields[0] : null;
  const field = clean(match?.field, 80).toLocaleLowerCase("en-US") || "search_text";
  const term = clean(match?.matched_term, 240) || clean(record?.query, 240);
  const candidates = matchFieldValues(record, field);
  const value = candidates.find((candidate) => containsTerm(candidate, term))
    || term
    || candidates[0]
    || clean(record?.title, 500);
  return Object.freeze({
    field,
    term,
    value: excerptAround(value, term),
    reason: FIELD_REASONS[field] || "Record details match",
    source_observation_ref: clean(match?.source_observation_ref, 240) || null,
  });
}

function sourceLifecycleState(record) {
  const lifecycle = record?.provenance?.lifecycle || {};
  return clean(
    record?.ranking?.lifecycle_state
      || lifecycle.state
      || lifecycle.schedule_status
      || lifecycle.status
      || "unknown",
    80,
  ).toLocaleLowerCase("en-US") || "unknown";
}

function titleCase(value) {
  return clean(value, 80)
    .replaceAll("_", " ")
    .replace(/(^|\s)\p{L}/gu, (letter) => letter.toLocaleUpperCase("en-US"));
}

function lifecycleView(record) {
  const state = sourceLifecycleState(record);
  return Object.freeze({
    state,
    label: state === "unknown" ? "Status not available" : titleCase(state),
    group: ARCHIVE_STATES.has(state)
      ? "archive"
      : ACTIVE_STATES.has(state)
        ? "active"
        : "other",
  });
}

export function relevanceResultHref(record = {}) {
  const href = clean(record?.source_route || record?.canonical_href, 600);
  return isSafeSearchCanonicalRoute(href, { evidenceOnly: record?.outcome === "evidence_only" })
    ? href
    : null;
}

/** Build an immutable card model without changing source-owned evidence. */
export function buildUniversalSearchResultView(record = {}) {
  const href = relevanceResultHref(record);
  if (!href) return null;
  const evidence = matchEvidence(record);
  const lifecycle = lifecycleView(record);
  const entityType = clean(record.entity_type || record.object_type, 80) || "unclassified";
  const lens = clean(record.lens, 80) || clean(record.domain, 80) || "notices";
  return Object.freeze({
    schema: UNIVERSAL_SEARCH_RELEVANCE_VIEW_SCHEMA,
    title: clean(record.title, 500) || "Public record",
    summary: clean(record.summary, 1_200) || null,
    href,
    entity_type: entityType,
    entity_type_label: TYPE_LABELS[entityType] || titleCase(entityType) || "Published record",
    lens,
    lens_label: LENS_LABELS[lens] || titleCase(lens) || "Published records",
    lifecycle,
    evidence,
    edge_provenance: Object.freeze({
      source_observation_ref: evidence.source_observation_ref,
      source_observation_refs: Object.freeze([...(record.source_observation_refs || [])]),
      document_producer: clean(record?.edge_provenance?.document_producer
        || record?.provenance?.producer, 240) || null,
    }),
  });
}

export function highlightLiteralHtml(value, term) {
  const text = clean(value, 2_000);
  const needle = clean(term, 240);
  if (!needle) return escapeHtml(text);
  const lowerText = text.toLocaleLowerCase("en-US");
  const lowerNeedle = needle.toLocaleLowerCase("en-US");
  let cursor = 0;
  let html = "";
  let matchCount = 0;
  while (cursor < text.length && matchCount < 20) {
    const index = lowerText.indexOf(lowerNeedle, cursor);
    if (index < 0) break;
    html += escapeHtml(text.slice(cursor, index));
    html += `<mark>${escapeHtml(text.slice(index, index + needle.length))}</mark>`;
    cursor = index + needle.length;
    matchCount += 1;
  }
  return matchCount ? `${html}${escapeHtml(text.slice(cursor))}` : escapeHtml(text);
}

/** Render only escaped values; the sole emitted markup is this fixed template. */
export function renderUniversalSearchResultHtml(record = {}) {
  const view = buildUniversalSearchResultView(record);
  if (!view) return "";
  const titleHtml = ["title", "display_name", "name"].includes(view.evidence.field)
    ? highlightLiteralHtml(view.title, view.evidence.term)
    : escapeHtml(view.title);
  const summaryHtml = view.summary
    ? `<p class="topic-search-result-snippet">${escapeHtml(view.summary)}</p>`
    : "";
  return `<article class="topic-search-result is-${escapeHtml(view.lifecycle.group)}" data-search-result data-search-entity-type="${escapeHtml(view.entity_type)}" data-search-lens="${escapeHtml(view.lens)}" data-lifecycle-state="${escapeHtml(view.lifecycle.state)}">
    <h4><a href="${escapeHtml(view.href)}">${titleHtml}</a></h4>
    <p class="topic-search-result-meta"><span class="topic-search-result-type">${escapeHtml(view.entity_type_label)}</span><span class="topic-search-result-lens">${escapeHtml(view.lens_label)}</span><span class="topic-search-result-status is-${escapeHtml(view.lifecycle.group)}">${escapeHtml(view.lifecycle.label)}</span></p>
    <p class="topic-search-result-evidence" data-match-field="${escapeHtml(view.evidence.field)}"><span class="topic-search-result-reason">${escapeHtml(view.evidence.reason)}</span><span>${highlightLiteralHtml(view.evidence.value, view.evidence.term)}</span></p>
    ${summaryHtml}
  </article>`;
}
