/**
 * Reader-facing agency identity-and-coverage disclosure.
 *
 * The sibling compatibility work owns source identity, route aliasing, and
 * evidence state. This projection only re-reads that contract for a resident
 * opening an agency from `/agencies/`: a concise summary of what can be
 * followed at first paint, and one disclosure that names source identity,
 * route alias, category state, basis, and vintage on inspection.
 *
 * It asserts nothing new. Institution kind, legal form, publisher labels,
 * route existence, category counts, geography, acronyms, and Community Board
 * body ids stay outside the classification path.
 */

import { renderNodeSection } from "./civic_document_chrome.mjs";
import {
  institutionReaderToken,
  projectInstitutionProfileNavigation,
} from "./civic_institution_profile_navigation.mjs";

export const AGENCY_IDENTITY_COVERAGE_SCHEMA = "cityscroll.agency_identity_coverage.v1";
export const AGENCY_IDENTITY_COVERAGE_METHOD = "agency_identity_coverage_v1";
export const AGENCY_IDENTITY_COVERAGE_ANCHOR = "agency-identity-and-coverage";

/**
 * Summary copy never reads a missing join as an absence of civic activity.
 * "Empty" is a snapshot statement, "unknown" is an un-joined source, and
 * "blocked" is a disclosed withholding rather than a silent omission.
 */
const SUMMARY_COPY = Object.freeze({
  some: "These capabilities have joined records on this profile. Inspect the coverage details for the source basis behind each one.",
  none: "No capability is joined from a retained source in this snapshot. That is a gap in what has been joined, not a finding that this institution does nothing.",
  withheld: "This route has no exact source identity, so capabilities stay withheld instead of guessed. The details below name the source report, basis, and vintage behind that decision.",
});

/** Identity states that withhold capabilities rather than report a snapshot gap. */
const WITHHOLDING_IDENTITY_STATES = new Set(["collision", "unresolved"]);

const STATE_SUMMARY_LABELS = Object.freeze({
  matched: "supported",
  empty: "empty in this snapshot",
  unknown: "not joined yet",
  blocked: "not inferred",
});

function esc(value) {
  return String(value ?? "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function dayStamp(value) {
  return String(value || "").match(/\d{4}-\d{2}-\d{2}/)?.[0] || null;
}

function countByState(rows) {
  const counts = { matched: 0, empty: 0, unknown: 0, blocked: 0 };
  for (const row of rows) {
    if (counts[row?.state] == null) continue;
    counts[row.state] += 1;
  }
  return counts;
}

function headline(counts) {
  return ["matched", "empty", "unknown", "blocked"]
    .filter((state) => counts[state] > 0)
    .map((state) => `${counts[state]} ${STATE_SUMMARY_LABELS[state]}`)
    .join(" · ");
}

/**
 * Reduce the institution navigation contract to the resident disclosure.
 * Returns null when there is no navigation projection to disclose.
 */
export function projectAgencyIdentityCoverage(navigation) {
  if (!navigation) return null;
  const capabilities = Array.isArray(navigation.role_capabilities) ? navigation.role_capabilities : [];
  const categories = Array.isArray(navigation.category_states) ? navigation.category_states : [];
  const identityState = navigation.identity_evidence_state || {};
  const provenance = navigation.provenance || {};
  const counts = countByState(capabilities);
  const supported = capabilities.filter((row) => row.state === "matched" && (row.href || row.record_href));
  const vintage = dayStamp(identityState.vintage || provenance.vintage);
  return Object.freeze({
    schema: AGENCY_IDENTITY_COVERAGE_SCHEMA,
    method: AGENCY_IDENTITY_COVERAGE_METHOD,
    anchor: AGENCY_IDENTITY_COVERAGE_ANCHOR,
    subject_ref: navigation.identity?.subject_ref || null,
    summary: Object.freeze({
      counts: Object.freeze({ ...counts }),
      headline: headline(counts),
      copy: supported.length
        ? SUMMARY_COPY.some
        : (WITHHOLDING_IDENTITY_STATES.has(identityState.status) ? SUMMARY_COPY.withheld : SUMMARY_COPY.none),
      supported_count: supported.length,
    }),
    supported_capabilities: Object.freeze(supported.map((row) => Object.freeze({
      id: row.id,
      label: row.label,
      // Prefer the profile's own section anchor; a direct record path stays
      // available but is never the only way to reach the capability.
      href: row.href || row.record_href,
      record_href: row.record_href || null,
      source_basis: row.source_basis || null,
      vintage: dayStamp(row.vintage),
      relation_id: row.relation_id || null,
    }))),
    identity: Object.freeze({
      source_id: identityState.source_id || navigation.identity?.canonical_id || null,
      status: identityState.status || "unknown",
      linking: Boolean(identityState.linking),
      basis: identityState.basis || null,
      vintage,
      source_report: provenance.source_report || identityState.source_report || null,
      route: identityState.route || provenance.route || null,
      comparison_key: identityState.comparison_key || null,
      collision_ids: Object.freeze([...(identityState.collision_ids || [])]),
      copy: identityState.copy || null,
      // Classification stays unasserted: the disclosure reports evidence only.
      classification_status: navigation.identity?.classification_status || "unclassified",
    }),
    capability_states: Object.freeze(capabilities),
    category_states: Object.freeze(categories),
    route_aliases: navigation.route_aliases || Object.freeze({ incoming: [], outgoing: [] }),
    provenance,
  });
}

/** Convenience seam: project the disclosure straight from a constellation view. */
export function projectAgencyIdentityCoverageFromView(options) {
  return projectAgencyIdentityCoverage(projectInstitutionProfileNavigation(options));
}

function metaLine(parts) {
  const text = parts.filter(Boolean).join(" · ");
  return text ? `<span class="muted node-muted agency-coverage-meta">${esc(text)}</span>` : "";
}

function renderSupported(rows) {
  if (!rows.length) return "";
  return `<ul class="agency-coverage-supported">${rows.map((row) => `<li class="agency-coverage-supported-item" data-capability="${esc(row.id)}">
      <a class="ui-constellation-link agency-edge-link" href="${esc(row.href)}">${esc(row.label)}</a>
    </li>`).join("")}</ul>`;
}

function renderIdentityRow(identity) {
  const collision = identity.collision_ids.length
    ? `Shares comparison key ${identity.comparison_key || ""} with ${identity.collision_ids.join(", ")}`
    : "";
  return `<ul class="agency-coverage-list">
    <li class="agency-coverage-item" data-identity-state="${esc(identity.status)}" data-identity-linking="${identity.linking ? "1" : "0"}">
      <div class="agency-coverage-main"><span class="agency-coverage-label">Source identity</span><span class="agency-coverage-state" data-evidence-state="${esc(identity.status)}">${esc(identity.status.replace(/_/g, " "))}</span></div>
      ${metaLine([
        identity.source_id ? `Source id ${identity.source_id}` : "",
        identity.basis ? `Basis ${institutionReaderToken(identity.basis)}` : "",
        identity.source_report ? `Source report ${institutionReaderToken(identity.source_report)}` : "",
        identity.vintage ? `As of ${identity.vintage}` : "",
        identity.route ? `Route ${identity.route}` : "",
        collision,
      ])}
      ${identity.copy ? `<span class="muted node-muted">${esc(identity.copy)}</span>` : ""}
    </li>
  </ul>`;
}

function renderStateRows(rows, { kind }) {
  if (!rows.length) return "";
  return `<ul class="agency-coverage-list">${rows.map((row) => {
    const label = row.href
      ? `<a class="ui-constellation-link agency-edge-link" href="${esc(row.href)}">${esc(row.label || row.id)}</a>`
      : `<span class="agency-coverage-label">${esc(row.label || row.id)}</span>`;
    return `<li class="agency-coverage-item" data-${esc(kind)}="${esc(row.id)}" data-evidence-state="${esc(row.state)}">
      <div class="agency-coverage-main">${label}<span class="agency-coverage-state" data-evidence-state="${esc(row.state)}">${esc(STATE_SUMMARY_LABELS[row.state] || row.state)}</span></div>
      ${row.copy ? `<span class="muted node-muted">${esc(row.copy)}</span>` : ""}
      ${metaLine([
        row.source_basis ? `Basis ${institutionReaderToken(row.source_basis)}` : "",
        row.vintage ? `As of ${row.vintage}` : "",
        row.count != null ? `${row.count} joined` : "",
        row.relation_id ? `Relation ${institutionReaderToken(row.relation_id)}` : "",
      ])}
    </li>`;
  }).join("")}</ul>`;
}

function renderAliasRows(rows, heading) {
  if (!rows.length) return "";
  return `<h4 class="agency-coverage-subhead">${esc(heading)}</h4>
    <ul class="agency-coverage-list">${rows.map((edge) => `<li class="agency-coverage-item" data-route-alias="${esc(edge.source_id)}" data-canonical-id="${esc(edge.canonical_id)}">
      <div class="agency-coverage-main"><a class="ui-constellation-link agency-edge-link" href="${esc(edge.href)}">${esc(edge.source_id.replace(/-/g, " "))} → ${esc(edge.canonical_id.replace(/-/g, " "))}</a></div>
      ${metaLine([
        `Basis ${institutionReaderToken(edge.disposition_basis)}`,
        `Redirect ${edge.redirect_path}`,
        `Source report ${institutionReaderToken(edge.source_report)}`,
        dayStamp(edge.vintage) ? `As of ${dayStamp(edge.vintage)}` : "",
      ])}
    </li>`).join("")}</ul>`;
}

/**
 * One compact, inspectable disclosure for the ordinary agency profile.
 * First paint stays a summary line plus the capabilities that can be followed;
 * everything evidentiary sits behind the disclosure.
 */
export function renderAgencyIdentityCoverage(projection) {
  if (!projection) return "";
  const { summary, identity } = projection;
  const aliases = `${renderAliasRows(projection.route_aliases?.incoming || [], "Routes that alias to this profile")}
    ${renderAliasRows(projection.route_aliases?.outgoing || [], "This route aliases to")}`;
  return `<div class="agency-identity-coverage" id="${esc(AGENCY_IDENTITY_COVERAGE_ANCHOR)}" data-coverage-schema="${esc(projection.schema)}" data-identity-state="${esc(identity.status)}" data-supported-count="${esc(String(summary.supported_count))}">
    <p class="agency-coverage-headline" data-coverage-headline="1">${esc(summary.headline)}</p>
    <p class="muted node-muted agency-coverage-copy">${esc(summary.copy)}</p>
    ${renderSupported(projection.supported_capabilities)}
    <details class="agency-coverage-disclosure" data-coverage-disclosure="1">
      <summary>Identity and coverage details</summary>
      <h4 class="agency-coverage-subhead">Source identity</h4>
      ${renderIdentityRow(identity)}
      <h4 class="agency-coverage-subhead">Capabilities</h4>
      ${renderStateRows(projection.capability_states, { kind: "capability" })}
      <h4 class="agency-coverage-subhead">Record categories</h4>
      ${renderStateRows(projection.category_states, { kind: "category" })}
      ${aliases}
    </details>
  </div>`;
}

/**
 * The profile-level block. Section identity stays on the established
 * `institution-profile-navigation` contract so the index boundary and the
 * machine compatibility surface are unchanged; the reader-facing disclosure
 * is the `#agency-identity-and-coverage` block inside it.
 */
export function renderAgencyIdentityCoverageSection(navigation) {
  const projection = projectAgencyIdentityCoverage(navigation);
  if (!projection) return "";
  const identity = projection.identity;
  return renderNodeSection({
    heading: "Identity and coverage",
    headingId: "institution-profile-navigation-heading",
    exportClass: "object_institution_navigation",
    extraClass: "node-card civic-object-section institution-profile-navigation",
    attrs: {
      id: "institution-profile-navigation",
      "data-navigation-schema": navigation.schema,
      "data-coverage-schema": projection.schema,
      "data-identity-state": identity.status,
      "data-identity-linking": identity.linking ? "1" : "0",
    },
    body: renderAgencyIdentityCoverage(projection),
  });
}
