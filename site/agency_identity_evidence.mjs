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
  applicant_on: "applicant on",
  has_applicant: "has applicant",
  contractor_on: "contractor on",
  has_contractor: "has contractor",
  contracted_by: "contracted",
  contracts_with: "contracts with",
  presents_transaction_at: "presents a transaction at",
  presents_transaction: "presents transaction",
});

function roleLabel(edge) {
  return ROLE_LABELS[edge.relation_id] || String(edge.role || edge.relation_id || "role").replace(/_/g, " ");
}

function roleEndpoint(id, href, linking, displayName = null) {
  const label = displayName || String(id || "")
    .replace(/^civic-institution:/, "")
    .replace(/^project:/, "")
    .replace(/^procurement:contract:/, "")
    .replace(/^meetings:notice:/, "");
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
    edge.provenance?.source_field && edge.provenance?.source_value
      ? `${edge.provenance.source_field}: “${edge.provenance.source_value}”`
      : "",
    edge.provenance?.source_receipt ? `Receipt ${edge.provenance.source_receipt}` : "",
    edge.method ? `Method: ${methodLabel(edge.method)}` : "",
    edge.reason && edge.status !== "accepted" ? `Status: ${edge.status} (${edge.reason})` : "",
  ].filter(Boolean).join(" · ");
  return `<li class="node-record agency-role-edge-record" data-role-relation="${esc(edge.relation_id || "")}" data-role-status="${esc(edge.status || "")}" data-role-linking="${edge.linking ? "1" : "0"}" data-role-object-kind="${esc(edge.object_kind || "")}">
    <div class="node-record-main">${roleEndpoint(edge.from, edge.inverse_href, edge.linking)} <span aria-hidden="true">→</span> ${esc(roleLabel(edge))} ${roleEndpoint(edge.to, edge.href, edge.linking, edge.object_display_name)}</div>
    <span class="muted node-muted">${esc(details)}</span>
    ${Array.isArray(edge.parcel_trail) && edge.parcel_trail.length
      ? `<p class="node-inline-actions civic-object-inline-actions">Parcel trail: ${
        edge.parcel_trail.map((parcel) => `<a class="ui-constellation-link agency-edge-link" data-role-parcel="${esc(parcel.bbl)}" href="${esc(parcel.href)}">${esc(parcel.bbl)}</a>`).join(", ")
      }</p>`
      : ""}
  </li>`;
}

function roleBag(evidence) {
  return [
    ...(Array.isArray(evidence?.role_edges) ? evidence.role_edges : []),
    ...(Array.isArray(evidence?.role_edge_held) ? evidence.role_edge_held : []),
    ...(Array.isArray(evidence?.role_edge_unresolved) ? evidence.role_edge_unresolved : []),
  ].filter((edge) => edge && edge.status !== "unknown");
}

const PROJECT_RELATIONS = new Set(["applicant_on", "has_applicant"]);
const PROCUREMENT_RELATIONS = new Set([
  "contractor_on",
  "has_contractor",
  "contracted_by",
  "contracts_with",
]);
const PROCEEDING_RELATIONS = new Set(["presents_transaction_at", "presents_transaction"]);

function renderRoleGroup({
  rows,
  heading,
  headingId,
  sectionId,
  intro,
  extraClass,
  evidence,
}) {
  if (!rows.length) return "";
  const body = `<p class="node-muted">${intro}</p>
    <ul class="node-record-list">${rows.map((edge) => roleRow(edge)).join("")}</ul>`;
  return renderNodeSection({
    heading,
    headingId,
    exportClass: "object_role_edges",
    extraClass: `node-card civic-object-section ${extraClass}`,
    attrs: {
      id: sectionId,
      "data-role-schema": evidence.role_edge_schema || "cityscroll.civic_institution_role_edge.v1",
    },
    body,
  });
}

export function renderAgencyRoleEdgeSection(view = {}) {
  const evidence = view.identity_evidence;
  const rows = roleBag(evidence);
  const institutionRows = rows.filter((edge) =>
    !PROJECT_RELATIONS.has(edge.relation_id)
    && !PROCUREMENT_RELATIONS.has(edge.relation_id)
    && !PROCEEDING_RELATIONS.has(edge.relation_id));
  return `${renderRoleGroup({
    rows: rows.filter((edge) => PROJECT_RELATIONS.has(edge.relation_id)),
    heading: "Projects",
    headingId: "agency-institution-projects-heading",
    sectionId: "agency-institution-projects",
    extraClass: "agency-institution-projects",
    intro: "These applicant roles use the exact retained land-use source spelling and keep parcel joins on the project.",
    evidence,
  })}${renderRoleGroup({
    rows: rows.filter((edge) => PROCUREMENT_RELATIONS.has(edge.relation_id)),
    heading: "Procurement roles",
    headingId: "agency-institution-procurement-heading",
    sectionId: "agency-institution-procurement",
    extraClass: "agency-institution-procurement",
    intro: "These contractor roles use exact contract party fields. Inverse links return to the contracting institution.",
    evidence,
  })}${renderRoleGroup({
    rows: rows.filter((edge) => PROCEEDING_RELATIONS.has(edge.relation_id)),
    heading: "Public proceedings",
    headingId: "agency-institution-proceedings-heading",
    sectionId: "agency-institution-proceedings",
    extraClass: "agency-institution-proceedings",
    intro: "A Borough Board transaction role appears only when the exact notice, date, quote, and retained source passage prove the selection.",
    evidence,
  })}${institutionRows.length ? renderRoleGroup({
    rows: institutionRows,
    heading: "Institution roles",
    headingId: "agency-institution-roles-heading",
    sectionId: "agency-institution-roles",
    extraClass: "agency-institution-roles",
    intro: "These roles are institution-to-institution and keep exact source evidence. Missing, held, and unresolved roles stay unlinked.",
    evidence,
  }) : ""}`;
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
