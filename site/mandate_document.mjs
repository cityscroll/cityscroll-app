/** Canonical resident document for one warranted statutory mandate. */

import { officialSourceLink } from "./affordance_grammar.mjs";
import {
  mandateObjectTarget,
  noticeEvidenceTarget,
} from "./notice_object_links.mjs";
import { canonicalMandateId } from "./mandate_subject_ref.mjs";

export const MANDATE_DOCUMENT_SCHEMA = "cityscroll.mandate_document.v1";

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
export function renderMandateDocument(row = {}, { noticeEvidence = [] } = {}) {
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
</main>
</body>
</html>`;
}
