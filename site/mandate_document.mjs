/** Canonical resident document for one warranted statutory mandate. */

import { officialSourceLink } from "./affordance_grammar.mjs";
import {
  mandateObjectTarget,
  noticeEvidenceTarget,
  procurementObjectTarget,
} from "./notice_object_links.mjs";
import { canonicalMandateId } from "./mandate_subject_ref.mjs";

export const MANDATE_DOCUMENT_SCHEMA = "cityscroll.mandate_document.v1";

const PUBLIC_EDGE_TIERS = new Set(["deterministic", "public_inferred"]);

const clean = (value, max = 700) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

const esc = (value) => String(value ?? "").replace(/[<>&"']/g, (char) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
}[char]));

function mandateId(row) {
  return canonicalMandateId(row?.mandate_id || row?.obligation_id || row?.id || row?.subject_ref);
}

export function findMandateById(lookup, value) {
  const id = canonicalMandateId(value);
  if (!id || !lookup || typeof lookup !== "object") return null;
  for (const bucket of Object.values(lookup.by_agency || {})) {
    const match = (Array.isArray(bucket?.obligations) ? bucket.obligations : [])
      .find((row) => mandateId(row) === id);
    if (match) return match;
  }
  return null;
}

export function noticeEvidenceForMandate(lookup, value) {
  const id = canonicalMandateId(value);
  if (!id || !lookup || typeof lookup !== "object") return [];
  const out = [];
  for (const [noticeId, rows] of Object.entries(lookup.by_notice || {})) {
    if (!(Array.isArray(rows) && rows.some((row) => mandateId(row) === id))) continue;
    const evidence = noticeEvidenceTarget(noticeId);
    if (evidence) out.push(evidence);
  }
  return out.sort((left, right) => left.id.localeCompare(right.id));
}

function provenanceValue(field) {
  return field && field.available === true ? clean(field.value, 500) : null;
}

function completePublicEdge(row, mandateRef) {
  const edge = row?.edge || {};
  const provenance = edge.provenance || null;
  return row?.status === "observed"
    && edge.from === mandateRef
    && clean(edge.to, 240)
    && PUBLIC_EDGE_TIERS.has(clean(edge.publication_tier, 40))
    && provenance?.schema === "cityscroll.graph_edge_provenance.v1"
    && provenanceValue(provenance.where?.source_system)
    && provenanceValue(provenance.where?.source_record_id)
    && provenanceValue(provenance.where?.observed_at)
    && provenanceValue(provenance.how?.method)
    && clean(provenance.confidence?.band, 40)
    && provenance.confidence?.standable === true;
}

function relatedEdgeTarget(row) {
  const edge = row.edge;
  const record = row.observed_record || {};
  const requestId = clean(record.request_id, 80) || null;
  if (row.category === "contracts" && edge.to.startsWith("contract:")) {
    const id = edge.to.slice("contract:".length);
    const target = procurementObjectTarget(id, { label: record.label || `Contract · ${id}` });
    return target ? { ...target, category: "contracts" } : null;
  }
  if (row.category === "rules" && requestId) {
    return {
      kind: "rule",
      id: edge.to,
      href: `/notices/${encodeURIComponent(requestId)}`,
      label: record.label || `Rule filing · ${requestId}`,
      category: "rules",
    };
  }
  if (row.category === "meetings" && requestId) {
    const id = `meeting:city_record:${requestId}`;
    return {
      kind: "meeting",
      id,
      href: `/meetings/${encodeURIComponent(id)}`,
      label: record.label || `Meeting · ${requestId}`,
      category: "meetings",
    };
  }
  return null;
}

/**
 * Public forward index over the shared process-conformance materialization.
 * Evidence-only candidates, expected null edges, and provenance-incomplete
 * rows remain absent instead of becoming speculative mandate pivots.
 */
export function relatedCivicEdgesForMandate(lookup, value) {
  const id = canonicalMandateId(value);
  if (!id || !lookup || typeof lookup !== "object") return [];
  const mandateRef = `mandate:${id}`;
  const out = [];
  const seen = new Set();
  for (const bucket of Object.values(lookup.by_agency || {})) {
    for (const row of Array.isArray(bucket?.edge_observations) ? bucket.edge_observations : []) {
      if (!completePublicEdge(row, mandateRef)) continue;
      const target = relatedEdgeTarget(row);
      if (!target) continue;
      const key = `${row.edge.type}|${target.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const noticeEvidence = row.observed_record?.request_id
        ? noticeEvidenceTarget(row.observed_record.request_id)
        : null;
      out.push({
        ...target,
        relation: row.edge.type,
        evidence: noticeEvidence,
        provenance: row.edge.provenance,
        verified: row.edge.provenance.confidence?.counts_as_verified_total === true,
      });
    }
  }
  const rank = { procurement: 0, rule: 1, meeting: 2 };
  return out.sort((left, right) => (
    (rank[left.kind] ?? 9) - (rank[right.kind] ?? 9)
      || left.id.localeCompare(right.id)
  ));
}

function deadlineText(row) {
  const deadline = row?.deadline && typeof row.deadline === "object" ? row.deadline : {};
  return clean(
    deadline.text
      || deadline.computed_date
      || row?.deadline_text
      || row?.deadline_date
      || row?.trigger
      || row?.trigger_text,
    300,
  ) || null;
}

/** Empty string means the record did not pass the deontic-object gate. */
export function renderMandateDocument(row = {}, { noticeEvidence = [], relatedEdges = [] } = {}) {
  const target = mandateObjectTarget(row);
  if (!target) return "";
  const id = target.id;
  const duty = clean(row.duty_text || row.required_action || row.expected_event);
  const agency = clean(row.agency_name || row.agency_id || row.subject_name || row.subject_id, 200);
  const agencyId = clean(row.agency_id, 120);
  const backHref = agencyId && /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(agencyId)
    ? `/agencies/${encodeURIComponent(agencyId)}/`
    : "/browse/";
  const backLabel = agencyId ? "Back to agency" : "Back to Browse";
  const deadline = deadlineText(row);
  const recurrence = clean(row.recurrence, 100);
  const citation = clean(row.citation || row.source?.citation, 240);
  const sourceHref = clean(
    row.source_href || row.source?.legistar_url || row.source?.law_text_url,
    500,
  );
  const evidence = (Array.isArray(noticeEvidence) ? noticeEvidence : [])
    .map((item) => typeof item === "string" ? noticeEvidenceTarget(item) : item)
    .filter((item) => item?.kind === "notice" && item.href && item.id);
  const evidenceSection = evidence.length
    ? `<section class="node-section civic-object-section mandate-evidence" data-mandate-inverse-links="${esc(evidence.length)}"><h2>Publication evidence</h2><ul>${evidence.map((item) => `<li><a href="${esc(item.href)}" data-target-kind="notice">${esc(item.label || "Notice evidence")} · ${esc(item.id)}</a></li>`).join("")}</ul></section>`
    : "";
  const relations = (Array.isArray(relatedEdges) ? relatedEdges : [])
    .filter((item) => item?.href && item?.label && item?.provenance?.claim_id);
  const verifiedCount = relations.filter((item) => item.verified === true).length;
  const relationSection = relations.length
    ? `<section class="node-section civic-object-section mandate-related-records" data-related-civic-edges="${relations.length}" data-verified-civic-edges="${verifiedCount}"><h2>Related civic records</h2><ul>${relations.map((item) => {
      const kind = item.kind === "procurement" ? "Contract" : item.kind === "rule" ? "Rule" : "Meeting";
      const evidenceLink = item.evidence?.href && item.evidence.href !== item.href
        ? ` · <a href="${esc(item.evidence.href)}" data-target-kind="notice">Notice evidence</a>`
        : "";
      const why = item.provenance.inspect_href
        ? ` · <a href="${esc(item.provenance.inspect_href)}" data-edge-claim="${esc(item.provenance.claim_id)}">Why this link?</a>`
        : "";
      return `<li data-mandate-edge="${esc(item.relation)}" data-target-kind="${esc(item.kind)}"><span class="node-kicker">${kind}</span> · <a href="${esc(item.href)}">${esc(item.label)}</a>${evidenceLink}${why}</li>`;
    }).join("")}</ul></section>`
    : "";
  const facts = [
    ["Subject", agency],
    ["Required action", duty],
    ["Trigger or deadline", deadline],
    ["Recurrence", recurrence],
    ["Citation", citation],
  ].filter(([, value]) => value);
  const source = sourceHref
    ? officialSourceLink({ href: sourceHref, label: "Source law", className: "node-source-link", escape: esc })
    : "";
  const canonical = `/mandates/${encodeURIComponent(id)}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mandate · ${esc(agency)} · CityScroll</title>
<meta name="description" content="Statutory mandate and its publication evidence.">
<link rel="canonical" href="https://cityscroll.org${esc(canonical)}">
<link rel="stylesheet" href="/brand.css">
<link rel="stylesheet" href="/civic-documents.css">
</head>
<body>
<header class="document-mast"><div class="document-mast-inner"><a class="document-brand brand-lockup home" href="/">CityScroll</a><nav class="document-nav" aria-label="Primary"><a href="/now/">Now</a><a href="/near-you/">Near you</a><a href="/following/">Following</a><a href="/browse/">Browse</a></nav></div></header>
<main id="main" class="civic-document node-document mandate-document" data-civic-object-kind="mandate" data-mandate-id="${esc(id)}" data-schema="${MANDATE_DOCUMENT_SCHEMA}" tabindex="-1">
  <p class="node-back"><a href="${esc(backHref)}">${backLabel}</a></p>
  <section class="node-hero civic-object-hero mandate-hero"><p class="node-kicker civic-object-kicker">Statutory mandate</p><h1>${esc(duty)}</h1><p class="node-lede">${esc(agency)}</p></section>
  <section class="node-section civic-object-section mandate-facts"><h2>Mandate</h2><dl>${facts.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`).join("")}</dl>${source ? `<p>${source}</p>` : ""}</section>
  ${evidenceSection}
  ${relationSection}
</main>
</body>
</html>`;
}
