import {
  gateNodePageRender,
  renderCivicDocumentAssets,
  renderCivicDocumentMast,
  renderNodeActions,
  renderNodeBack,
  renderNodeFooter,
  renderNodeSection,
} from "./civic_document_chrome.mjs";

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

const clean = (value, max = 5_000) => String(value ?? "")
  .replace(/<[^>]*>/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

const FIELD_LABELS = Object.freeze({
  justification: "Why it is under consideration",
  anticipated_content: "Anticipated content",
  objective: "Objective",
  legal_basis: "Legal basis",
  affected_groups: "Who may be affected",
  approximate_schedule: "Approximate schedule",
});

export function renderRegulatoryAgendaDocument(item, { currentHref = "" } = {}) {
  if (!item || item.schema !== "cityscroll.regulatory_agenda_item.v1" || !item.id) return "";
  const title = clean(item.subject, 500) || "Anticipated rulemaking topic";
  const rows = Object.entries(FIELD_LABELS)
    .map(([field, label]) => item[field] ? `<div><dt>${esc(label)}</dt><dd>${esc(item[field])}</dd></div>` : "")
    .filter(Boolean)
    .join("");
  const source = item.publisher_document || item.source?.document_url || null;
  const actionItems = source ? [{ kind: "source", href: source, label: "Open agenda PDF" }] : [];
  const follow = item.follow_href || "/following/";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Regulatory agenda · CityScroll</title>
<link rel="canonical" href="https://cityscroll.org${esc(item.canonical_href || "")}">${renderCivicDocumentAssets()}</head>
<body>${renderCivicDocumentMast({ current: "browse" })}<main id="main" class="node-document civic-object-document regulatory-agenda-document" data-civic-object-kind="regulatory-agenda-item" data-agenda-item-id="${esc(item.id)}" tabindex="-1">
${renderNodeBack({ href: "/browse/rules/", label: "Back to Rules", currentHref })}
<header class="node-hero civic-object-hero" data-export-class="object_identity"><p class="node-kicker civic-object-kicker">Regulatory agenda · ${esc(item.fiscal_year || "Fiscal year not stated")}</p><h1>${esc(title)}</h1><p class="node-lede">${esc(item.agency || "Agency not stated")}</p><p class="node-lede">Anticipated planning signal — not a formal rulemaking proceeding.</p></header>
${renderNodeActions([{ kind: "link", href: follow, label: "Follow anticipated topic", primary: true }, ...actionItems], { ariaLabel: "Agenda actions", extraClass: "civic-object-actions" })}
${renderNodeSection({ heading: "What the agenda says", body: rows ? `<dl class="regulatory-agenda-fields">${rows}</dl>` : `<p class="muted">The published agenda does not state structured details for this item.</p>` })}
${renderNodeSection({ heading: "Source provenance", body: `<dl class="regulatory-agenda-provenance"><div><dt>Agency</dt><dd>${esc(item.agency || "Not stated")}</dd></div><div><dt>Fiscal year</dt><dd>${esc(item.fiscal_year || "Not stated")}</dd></div><div><dt>Lifecycle stage</dt><dd>Anticipated</dd></div>${item.source?.published_at ? `<div><dt>Published</dt><dd>${esc(item.source.published_at)}</dd></div>` : ""}</dl>` })}
${renderNodeFooter({})}</main></body></html>`;
  return gateNodePageRender(html);
}
