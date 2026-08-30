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

const ROLE_LABELS = Object.freeze({
  must_report_to: "must report to",
  receives_report_from: "receives reports from",
});

function roleLabel(edge) {
  return ROLE_LABELS[edge.relation_id] || String(edge.role || edge.relation_id || "role").replace(/_/g, " ");
}

function roleEndpoint(id, href, linking) {
  const label = String(id || "").replace(/^civic-institution:/, "");
  if (linking && href) {
    return `<a class="ui-constellation-link agency-edge-link" href="${esc(href)}">${esc(label)}</a>`;
  }
  return `<span data-role-unlinked="1">${esc(label || "unresolved institution")}</span>`;
}

function roleRow(edge) {
  const details = [
    `Role: ${roleLabel(edge)}`,
    edge.confidence ? `Confidence: ${confidenceLabel(edge.confidence)}` : "",
    edge.as_of ? `As of ${edge.as_of}` : "",
    edge.vintage ? `Vintage ${edge.vintage}` : "",
    edge.provenance?.source_system ? `Source ${edge.provenance.source_system}` : "",
    edge.reason && edge.status !== "accepted" ? `Status: ${edge.status} (${edge.reason})` : "",
  ].filter(Boolean).join(" · ");
  return `<li class="node-record agency-role-edge-record" data-role-relation="${esc(edge.relation_id || "")}" data-role-status="${esc(edge.status || "")}" data-role-linking="${edge.linking ? "1" : "0"}">
    <div class="node-record-main">${roleEndpoint(edge.from, edge.inverse_href, edge.linking)} <span aria-hidden="true">→</span> ${esc(roleLabel(edge))} ${roleEndpoint(edge.to, edge.href, edge.linking)}</div>
    <span class="muted node-muted">${esc(details)}</span>
  </li>`;
}

export function renderAgencyRoleEdgeSection(view = {}) {
  const evidence = view.identity_evidence;
  const rows = [
    ...(Array.isArray(evidence?.role_edges) ? evidence.role_edges : []),
    ...(Array.isArray(evidence?.role_edge_held) ? evidence.role_edge_held : []),
    ...(Array.isArray(evidence?.role_edge_unresolved) ? evidence.role_edge_unresolved : []),
  ].filter((edge) => edge && edge.status !== "unknown");
  if (!rows.length) return "";
  const body = `<p class="node-muted">These roles are institution-to-institution and keep exact source evidence. Missing, held, and unresolved roles stay unlinked.</p>
    <ul class="node-record-list">${rows.map((edge) => roleRow(edge)).join("")}</ul>`;
  return renderNodeSection({
    heading: "Institution roles",
    headingId: "agency-institution-roles-heading",
    exportClass: "object_role_edges",
    extraClass: "node-card civic-object-section agency-institution-roles",
    attrs: {
      id: "agency-institution-roles",
      "data-role-schema": evidence.role_edge_schema || "cityscroll.civic_institution_role_edge.v1",
    },
    body,
  });
}

/** Render only accepted source observations; unknown links remain absent. */
export function renderAgencyIdentitySection(view = {}) {
  const evidence = view.identity_evidence;
  const observations = Array.isArray(evidence?.observations) ? evidence.observations : [];
  const identityHtml = observations.length ? (() => {
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
  })() : "";
  return `${identityHtml}${renderAgencyRoleEdgeSection(view)}`;
}
