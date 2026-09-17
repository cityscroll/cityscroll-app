/**
 * Who leads this agency — rendered on the agency page itself.
 *
 * The officer statement is the same published record the entity dossier and
 * organization/relationship capabilities already serve. This module only puts
 * that answer on the page a resident opens; it never invents a leader from a
 * related entity or a similar name.
 */

import { officialSourceLink } from "./affordance_grammar.mjs";
import { renderNodeSection } from "./civic_document_chrome.mjs";
import { agencyLeadershipAnswer } from "../worker/src/lib/published_agency_entity.mjs";

const esc = (value) => String(value ?? "").replace(/[<>&"']/g, (char) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
}[char]));

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

function humanStatus(value) {
  return clean(value).replace(/_/g, " ").replace(/^./, (letter) => letter.toUpperCase());
}

function agencyEntityId(view = {}) {
  const subjectRef = clean(view.subject_ref);
  if (subjectRef) return subjectRef;
  const canonical = clean(view.canonical_id || view.id);
  if (!canonical) return "";
  return canonical.includes(":") ? canonical : `agency:id:${canonical}`;
}

const SOURCE_SYSTEM_LABELS = Object.freeze({
  nyc_open_data: "NYC Open Data",
});

function sourceSystemLabel(system) {
  const key = clean(system);
  return SOURCE_SYSTEM_LABELS[key] || humanStatus(key);
}

function sourceMarkup(source = {}) {
  // Humanize the dataset system so resident copy never exposes snake_case
  // identifiers such as nyc_open_data.
  const label = [sourceSystemLabel(source.system), clean(source.id)].filter(Boolean).join(" · ");
  if (!label) return "";
  if (source.url) {
    return officialSourceLink({
      href: source.url,
      label,
      className: "agency-leadership-source-link",
      newTabLabel: "(opens the source dataset in a new tab)",
    });
  }
  return esc(label);
}

function publishedBody(leadership) {
  const title = clean(leadership.title);
  const personLine = title
    ? `${esc(leadership.person)}, ${esc(title)}`
    : esc(leadership.person);
  const confidence = leadership.confidence
    ? `${humanStatus(leadership.confidence.status)} · ${humanStatus(leadership.confidence.basis)}`
    : "";
  // Resident copy stays plain-language: name the dataset and its date, never the
  // publisher column identifiers (head_name / head_title) that built the record.
  return `<p class="agency-leadership-value" data-leadership-person="${esc(leadership.person)}"${title ? ` data-leadership-title="${esc(title)}"` : ""}>${personLine}</p>
    <details class="agency-leadership-provenance">
      <summary>Source and confidence</summary>
      <dl class="agency-leadership-facts">
        <div><dt>Source</dt><dd data-leadership-source>${sourceMarkup(leadership.source)}</dd></div>
        <div><dt>Source last updated</dt><dd><time datetime="${esc(leadership.observed_at)}" data-leadership-observed-at="${esc(leadership.observed_at)}">${esc(leadership.observed_at)}</time></dd></div>
        ${confidence ? `<div><dt>Confidence</dt><dd data-leadership-confidence="${esc(leadership.confidence.status)}" data-leadership-basis="${esc(leadership.confidence.basis)}">${esc(confidence)}</dd></div>` : ""}
      </dl>
    </details>`;
}

function notRecordedBody(leadership) {
  const consulted = (Array.isArray(leadership.consulted_sources) ? leadership.consulted_sources : [])
    .map((source) => {
      const link = sourceMarkup(source);
      if (!link) return "";
      const when = clean(source.observed_at)
        ? ` · last updated <time datetime="${esc(source.observed_at)}">${esc(source.observed_at)}</time>`
        : "";
      return `<li>${link}${when}</li>`;
    })
    .filter(Boolean)
    .join("");
  return `<p class="agency-leadership-value" data-leadership-absence="not_recorded">Not recorded</p>
    <p class="node-muted muted">${esc(leadership.note)}</p>
    ${consulted ? `<details class="agency-leadership-provenance"><summary>Datasets consulted</summary><ul class="agency-leadership-consulted">${consulted}</ul></details>` : ""}`;
}

function unreadableBody(leadership) {
  return `<p class="agency-leadership-value" data-leadership-absence="unreadable">Could not be read</p>
    <p class="node-muted muted">${esc(leadership.note)}</p>`;
}

/** Resolve the published leadership answer for one agency constellation view. */
export function resolveAgencyPageLeadership(view = {}, { publication } = {}) {
  const entityId = agencyEntityId(view);
  if (!entityId) return null;
  return publication === undefined
    ? agencyLeadershipAnswer(entityId)
    : agencyLeadershipAnswer(entityId, publication);
}

/**
 * Render the leadership block for an agency page.
 *
 * Returns "" only when this agency has no published officer statement at all.
 * A published name, an explicit not-recorded answer, and a read failure each
 * occupy the same block so the question is never silently dropped.
 */
export function renderAgencyPageLeadership(leadership) {
  if (!leadership) return "";
  const status = clean(leadership.status);
  let body = "";
  if (status === "published") body = publishedBody(leadership);
  else if (status === "not_recorded") body = notRecordedBody(leadership);
  else body = unreadableBody(leadership);
  return renderNodeSection({
    heading: clean(leadership.question) || "Who leads this agency?",
    headingId: "agency-leadership-heading",
    exportClass: "object_identity",
    extraClass: "node-card civic-object-section agency-leadership",
    attrs: {
      id: "agency-leadership",
      "data-agency-leadership": status || "unknown",
      "data-leadership-status": status || "unknown",
    },
    body,
  });
}

export const AGENCY_PAGE_LEADERSHIP_STYLE = `.agency-leadership-value{margin:.35rem 0 .75rem;font-weight:700;font-size:1.08rem;overflow-wrap:anywhere}
.agency-leadership-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.65rem 1rem;margin:.75rem 0 0}
.agency-leadership-facts div{min-width:0}
.agency-leadership-facts dt{font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted,#5e6a73)}
.agency-leadership-facts dd{margin:.15rem 0 0;overflow-wrap:anywhere}
.agency-leadership-provenance{margin:.85rem 0 0}
.agency-leadership-provenance > summary{cursor:pointer;min-height:44px;display:inline-flex;align-items:center}
.agency-leadership-consulted{list-style:none;padding:0;margin:.65rem 0 0;color:var(--muted,#5e6a73);font-size:.88rem}
.agency-leadership-consulted li{margin:.25rem 0;overflow-wrap:anywhere}
@media (max-width:760px){.agency-leadership-facts{grid-template-columns:1fr}}`;
