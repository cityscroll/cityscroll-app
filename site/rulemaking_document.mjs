import {
  gateNodePageRender,
  renderCivicDocumentAssets,
  renderCivicDocumentMast,
  renderNodeActions,
  renderNodeBack,
  renderNodeFooter,
  renderNodeSection,
} from "./civic_document_chrome.mjs";
import { RULE_EVENT_META, RULES_PHASE_META } from "./rules_phase_spine.mjs";

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

const clean = (value, max = 2_000) => String(value ?? "")
  .replace(/<[^>]*>/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

function date(value) {
  const match = clean(value, 80).match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] || null;
}

function prettyDate(value) {
  const day = date(value);
  if (!day) return "Date not stated";
  const parsed = new Date(`${day}T12:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? day : parsed.toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}

function eventLabel(event) {
  const meta = RULE_EVENT_META[event?.event_type];
  const labels = {
    proposal_published: "Proposal published",
    public_hearing: "Public hearing",
    comment_close: "Comments due",
    adoption: "Adoption published",
    effective: "Takes effect",
  };
  return labels[event?.event_type] || meta?.label_key || "Process event";
}

function phaseMarkup(phase) {
  const meta = RULES_PHASE_META[phase.id];
  const events = (phase.events || []).map((event) => `<li class="rulemaking-event" data-event-type="${esc(event.event_type)}">
    <strong>${esc(eventLabel(event))}</strong><span>${esc(prettyDate(event.valid_at || event.published_at))}</span>
  </li>`).join("");
  const state = phase.state === "passed" ? "Completed" : phase.state === "current" ? "Current" : "Upcoming";
  return `<li class="rulemaking-phase rulemaking-phase-${esc(phase.state)}" data-phase="${esc(phase.id)}">
    <div class="rulemaking-phase-heading"><strong>${esc(meta?.short || phase.id)}</strong><span>${esc(state)}</span></div>
    ${events ? `<ul class="rulemaking-events">${events}</ul>` : `<p class="muted">No dated event in the published record.</p>`}
  </li>`;
}

export function renderRulemakingDocument(object, { currentHref = "" } = {}) {
  if (!object || object.schema !== "cityscroll.rulemaking.v1" || !object.rulemaking_id) return "";
  const title = clean(object.title, 500) || "Rulemaking";
  const agency = clean(object.agency, 300);
  const phases = Array.isArray(object.phases) ? object.phases : [];
  const sourceDocs = Array.isArray(object.source_documents) ? object.source_documents : [];
  const interaction = object.interaction || {};
  const participationItems = (interaction.kinetic_actions || [])
    .filter((action) => action?.href && action?.label)
    .map((action) => ({ kind: "link", href: action.href, label: action.label, primary: action.primary }));
  const participation = participationItems.length
    ? renderNodeSection({
      heading: "What you can do",
      body: renderNodeActions(participationItems, { ariaLabel: "Participation actions", extraClass: "rulemaking-participation-actions" }),
      extraClass: "rulemaking-participation",
    })
    : "";
  const actionItems = [];
  const officialHref = clean(object.nyc_rules?.url || object.nyc_rules?.comment_url);
  if (officialHref) actionItems.push({ kind: "source", href: officialHref, label: "Open official rule page" });
  const actions = renderNodeActions(actionItems, { ariaLabel: "Rulemaking actions", extraClass: "civic-object-actions" });
  const noticeItems = sourceDocs.filter((item) => item.kind === "city_record_notice").map((item) =>
    `<li><a href="${esc(item.href)}">${esc(item.role === "proposal" ? "Proposal" : item.role === "hearing" ? "Hearing" : item.role === "adoption" ? "Adoption" : "City Record notice")} · ${esc(item.request_id)}</a></li>`
  ).join("");
  const ruleItems = sourceDocs.filter((item) => item.kind === "nyc_rules").map((item) =>
    `<li><a class="ui-official-source-link" href="${esc(item.href)}" target="_blank" rel="noopener noreferrer">${esc(item.label)}<span aria-hidden="true">↗</span></a></li>`
  ).join("");
  const timeline = phases.length
    ? `<ol class="rulemaking-phases">${phases.map(phaseMarkup).join("")}</ol>`
    : "";
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · CityScroll</title><link rel="canonical" href="https://cityscroll.org${esc(object.canonical_href)}">
<meta property="og:title" content="${esc(title)} · CityScroll"><meta property="og:url" content="https://cityscroll.org${esc(object.canonical_href)}">
${renderCivicDocumentAssets()}</head>
<body>${renderCivicDocumentMast({ current: "browse" })}
<main id="main" class="node-document civic-object-document rulemaking-document" data-civic-object-kind="rulemaking" data-rulemaking-id="${esc(object.rulemaking_id)}" tabindex="-1">
${renderNodeBack({ href: "/browse/rules/", label: "Back to Rules", currentHref })}
<header class="node-hero civic-object-hero" data-export-class="object_identity">
<p class="node-kicker civic-object-kicker">Rulemaking case file</p>
<h1>${esc(title)}</h1>
${agency ? `<p class="node-lede">${esc(agency)}</p>` : ""}
<p class="node-lede">One case file for the published proposal, public process, adoption, and effective date.</p>
</header>
${actions}
${renderNodeSection({ heading: "What the agency proposes", body: object.proposal_summary ? `<p>${esc(object.proposal_summary)}</p>` : "" })}
${participation}
${renderNodeSection({ heading: "Process", body: timeline, extraClass: "rulemaking-process" })}
${renderNodeSection({ heading: "Source documents", body: `<ul>${noticeItems}${ruleItems}</ul>` })}
${renderNodeFooter({})}
</main></body></html>`;
  return gateNodePageRender(html);
}
