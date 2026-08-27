import { renderNodeSection } from "./civic_document_chrome.mjs";

const esc = (value) => String(value ?? "").replace(/[<>&"']/g, (char) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
}[char]));

const METHOD_LABELS = Object.freeze({
  exact_source_identifier: "Exact source identifier",
  exact_normalized_publisher_value: "Exact normalized publisher value",
  reviewed_publisher_alias: "Reviewed publisher alias",
});

function fieldLabel(value) {
  const labels = {
    agency_name: "Agency name",
    canonical_name: "Canonical name",
    org_type: "Publisher organization type",
  };
  return labels[value] || String(value || "Source field").replace(/_/g, " ");
}

function methodLabel(value, detail = null) {
  return METHOD_LABELS[value] || String(detail || value || "Exact publisher identity")
    .replace(/_v\d+$/i, "")
    .replace(/_/g, " ");
}

function confidenceLabel(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "strong" ? "Strong" : (normalized || "Unknown");
}

function sourceLink(observation, fallbackHref) {
  const href = observation.record_href || observation.source_url || fallbackHref;
  if (!href) return esc(observation.source_record_id || "Source record");
  const label = observation.record_label || observation.source_record_id || "Source record";
  const external = /^https?:\/\//i.test(href);
  return `<a class="ui-constellation-link agency-edge-link" href="${esc(href)}"${external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${esc(label)}</a>`;
}

function observationRow(observation, view) {
  const method = methodLabel(observation.method, observation.source_resolution_method);
  const details = [
    `${fieldLabel(observation.source_field)}: “${observation.source_value}”`,
    `Method: ${method}`,
    `Confidence: ${confidenceLabel(observation.confidence)}`,
    observation.observed_at ? `Observed ${observation.observed_at}` : "",
    observation.oti_org_type ? `Publisher classification: ${observation.oti_org_type}` : "",
  ].filter(Boolean).join(" · ");
  return `<li class="node-record agency-source-identity-record" data-source-record-ref="${esc(observation.source_record_ref)}" data-source-field="${esc(observation.source_field)}">
    <div class="node-record-main">${sourceLink(observation, view.path)} <span aria-hidden="true">→</span> <a class="ui-constellation-link agency-edge-link" href="${esc(view.path)}">${esc(view.display_name)}</a></div>
    <span class="muted node-muted">${esc(details)}</span>
  </li>`;
}

/** Render only accepted source observations; unknown links remain absent. */
export function renderAgencyIdentitySection(view = {}) {
  const evidence = view.identity_evidence;
  const observations = Array.isArray(evidence?.observations) ? evidence.observations : [];
  if (!observations.length) return "";
  const kind = evidence.institution?.institution_kind;
  const kindCopy = kind
    ? ` Independently grounded institution kind: ${kind}.`
    : " Institution classification: unclassified until independent evidence supports a kind.";
  const body = `<p class="node-muted">These source observations resolve to this profile through exact publisher identity evidence. Source spellings and publisher classifications remain separate from institution classification.${kindCopy}</p>
    <ul class="node-record-list">${observations.map((observation) => observationRow(observation, view)).join("")}</ul>`;
  return renderNodeSection({
    heading: "Source identity",
    headingId: "agency-source-identity-heading",
    exportClass: "object_identity_evidence",
    extraClass: "node-card civic-object-section agency-source-identity",
    attrs: {
      id: "agency-source-identity",
      "data-identity-schema": evidence.schema || "",
      "data-identity-status": evidence.status || "matched",
    },
    body,
  });
}
