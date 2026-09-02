/**
 * Uncertainty-aware institution profile navigation.
 *
 * Compatibility is a contract, not a global rename. This projection separates
 * identity, kind, legal form, role capabilities, and evidence state, and it
 * emits `route_alias_of` only for reviewed aliases already declared by the
 * route identity report. Collisions, unresolved routes, OTI buckets, and
 * Community Board body ids stay non-linking.
 */

import { agencyComparisonKey, agencyRouteAliasTarget } from "./agency_identity.mjs";
import {
  gateNodePageRender,
  renderCivicDocumentAssets,
  renderCivicDocumentMast,
  renderNodeBack,
  renderNodeFooter,
  renderNodeSection,
} from "./civic_document_chrome.mjs";
import defaultRouteIdentityReport from "./data/agency_route_identity_report.json" with { type: "json" };

export const INSTITUTION_PROFILE_NAVIGATION_SCHEMA = "cityscroll.institution_profile_navigation.v1";
export const INSTITUTION_PROFILE_NAVIGATION_METHOD = "institution_profile_navigation_v1";
export const ROUTE_ALIAS_OF_RELATION = "route_alias_of";
export const ROUTE_ALIAS_OF_INVERSE = "has_route_alias";
export const ROUTE_ALIAS_SOURCE_CONTRACT = "cityscroll.agency_route_identity_report.v1";
export const CATEGORY_EVIDENCE_STATES = Object.freeze(["matched", "empty", "unknown", "blocked"]);
export const IDENTITY_EVIDENCE_STATES = Object.freeze([
  "matched",
  "collision",
  "unresolved",
  "route_only",
  "source_only",
  "legitimate_external",
  "oti_only",
]);

const GOVERNANCE_RELATIONS = new Set(["governed_by", "governing_body_of"]);
const COMMITTEE_RELATIONS = new Set(["has_committee", "part_of"]);
const PROJECT_RELATIONS = new Set(["applicant_on", "has_applicant"]);
const PROCUREMENT_RELATIONS = new Set(["contractor_on", "has_contractor", "contracted_by", "contracts_with"]);
const ACCOUNTABILITY_RELATIONS = new Set(["must_report_to", "receives_report_from", "duty_bearer", "holds_duty"]);
const OFFICE_RELATIONS = new Set(["holds_office", "officeholder_of", "appoints_members_of", "members_appointed_by"]);

const CAPABILITY_SPECS = Object.freeze([
  Object.freeze({
    id: "projects",
    label: "Projects",
    relations: PROJECT_RELATIONS,
    heading_id: "agency-institution-projects",
  }),
  Object.freeze({
    id: "contracts",
    label: "Contracts",
    category: "contracts",
    relation: "published_by_agency",
  }),
  Object.freeze({
    id: "procurement_roles",
    label: "Procurement roles",
    relations: PROCUREMENT_RELATIONS,
    heading_id: "agency-institution-procurement",
  }),
  Object.freeze({
    id: "accountability",
    label: "Accountability",
    relations: ACCOUNTABILITY_RELATIONS,
    heading_id: "agency-institution-accountability",
  }),
  Object.freeze({
    id: "committees",
    label: "Committees",
    relations: COMMITTEE_RELATIONS,
    heading_id: "agency-institution-committees",
  }),
  Object.freeze({
    id: "governance",
    label: "Governance",
    relations: GOVERNANCE_RELATIONS,
    heading_id: "agency-institution-governance",
    include_hosts_meeting: true,
  }),
  Object.freeze({
    id: "meetings",
    label: "Meetings",
    category: "meetings",
    relation: "hosts_meeting",
  }),
  Object.freeze({
    id: "rules",
    label: "Rules",
    category: "rules",
    relation: "issued_rule",
  }),
  Object.freeze({
    id: "staffing",
    label: "Staffing exams",
    category: "staffing",
    relation: "certified_to_agency",
  }),
  Object.freeze({
    id: "source_identity",
    label: "Source identity",
    heading_id: "agency-source-identity",
    identity: true,
  }),
]);

const STATE_COPY = Object.freeze({
  matched: "Joined records are on this profile.",
  empty: "No joined records in the current snapshot. That is not proof this institution has none.",
  unknown: "This capability has not been joined from a retained source yet.",
  blocked: "This capability is withheld because the identity or classification is not exact.",
});

const IDENTITY_COPY = Object.freeze({
  matched: "This profile uses a reviewed publisher identity and a stable agency route.",
  collision: "More than one publisher identity shares this comparison key. Inspect the evidence below to see both identities.",
  unresolved: "This route has no exact publisher-crosswalk identity. It stays on an evidence page until an exact join exists.",
  route_only: "This route is retained without a publisher crosswalk row.",
  source_only: "A publisher identity exists without a generated agency route.",
  legitimate_external: "This body is retained separately. It is not merged into a parent institution.",
  oti_only: "A publisher classification is retained as source evidence and is not an institution kind.",
});

const BASIS_LABELS = Object.freeze({
  agency_canonical_v1: "joined agency records",
  agency_browse_snapshot_v1: "agency record snapshot",
  agency_vendor_awards_12mo_v1: "recent vendor awards",
  publisher_certification_record_v1: "exam certification records",
  mandate_expected_vs_observed_v1: "mandate evidence",
  source_preserving_agency_identity_v1: "publisher identity evidence",
  "agency_route_identity_report.v1": "agency route identity report",
  agency_route_identity_report: "agency route identity report",
  entity_link: "source identity",
});

/** Reader vocabulary for a source basis or relation token. */
export function institutionReaderToken(value) {
  return readerToken(value);
}

function readerToken(value) {
  const raw = clean(value, 240);
  if (!raw) return "";
  if (BASIS_LABELS[raw]) return BASIS_LABELS[raw];
  return raw
    .replace(/_/g, " ")
    .replace(/\.v\d+$/i, "")
    .replace(/\s+v\d+$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function clean(value, max = 500) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

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

function categoryMap(view) {
  if (Array.isArray(view?.categories)) {
    return new Map(view.categories.map((row) => [row.id, row]));
  }
  if (view?.categories && typeof view.categories === "object") {
    return new Map(Object.entries(view.categories).map(([id, row]) => [id, { id, ...row }]));
  }
  return new Map();
}

function roleBag(evidence) {
  return [
    ...(Array.isArray(evidence?.role_edges) ? evidence.role_edges : []),
    ...(Array.isArray(evidence?.role_edge_held) ? evidence.role_edge_held : []),
    ...(Array.isArray(evidence?.role_edge_unresolved) ? evidence.role_edge_unresolved : []),
  ].filter(Boolean);
}

function isGovernanceHost(edge) {
  if (edge?.relation_id !== "hosts_meeting" && edge?.relation_id !== "hosted_by") return false;
  return edge.from_kind === "board"
    || edge.object_kind === "board"
    || edge.from_kind === "committee"
    || edge.object_kind === "committee";
}

function acceptedMatching(edges, spec) {
  return edges.filter((edge) => {
    if (edge.status && edge.status !== "accepted") return false;
    if (spec.relations?.has(edge.relation_id)) return true;
    if (spec.include_hosts_meeting && isGovernanceHost(edge)) return true;
    return false;
  });
}

function collisionRow(report, canonicalId, canonicalName) {
  const key = agencyComparisonKey(canonicalName || canonicalId || "");
  return (report?.collisions?.ambiguous_publisher_keys || []).find((row) => {
    const ids = Array.isArray(row.canonical_ids) ? row.canonical_ids : [];
    return ids.includes(canonicalId) || row.comparison_key === key;
  }) || null;
}

function routeCase(report, sourceId) {
  return (report?.cases || []).find((row) => row.source_id === sourceId) || null;
}

/**
 * Reviewed `route_alias_of` edges: report alias ∩ ROUTE_ALIAS_TARGETS, never
 * self-aliases, collisions, unresolved routes, or legitimate externals.
 */
export function projectReviewedRouteAliases(report = defaultRouteIdentityReport) {
  const vintage = report?.generated_at || null;
  const collisionIds = new Set(
    (report?.collisions?.ambiguous_publisher_keys || []).flatMap((row) => row.canonical_ids || []),
  );
  const edges = [];
  for (const row of report?.cases || []) {
    if (row.classification !== "alias_to_canonical") continue;
    const sourceId = clean(row.source_id, 160);
    const canonicalId = clean(row.canonical_id, 160);
    if (!sourceId || !canonicalId || sourceId === canonicalId) continue;
    if (!row.redirect_from || !row.canonical_path) continue;
    if (collisionIds.has(sourceId) || collisionIds.has(canonicalId)) continue;
    if (agencyRouteAliasTarget(sourceId) !== canonicalId) continue;
    edges.push(Object.freeze({
      schema: INSTITUTION_PROFILE_NAVIGATION_SCHEMA,
      relation_id: ROUTE_ALIAS_OF_RELATION,
      inverse: ROUTE_ALIAS_OF_INVERSE,
      from: sourceId,
      to: canonicalId,
      source_id: sourceId,
      canonical_id: canonicalId,
      redirect_path: row.redirect_from,
      destination_path: row.canonical_path,
      disposition_basis: clean(row.basis, 400) || "reviewed publisher alias",
      collision: false,
      source_contract: ROUTE_ALIAS_SOURCE_CONTRACT,
      source_report: "agency_route_identity_report.v1",
      vintage,
      href: row.canonical_path,
      linking: true,
    }));
  }
  return Object.freeze(edges);
}

export function agencyRouteUncertaintyKind(sourceId, report = defaultRouteIdentityReport) {
  const id = clean(sourceId, 160);
  if (!id) return null;
  const found = routeCase(report, id);
  if (found?.classification === "unresolved") return "unresolved";
  const collision = collisionRow(report, id, found?.canonical_name || id);
  if (collision && (collision.canonical_ids || []).includes(id) && found?.classification !== "alias_to_canonical") {
    return "collision";
  }
  return null;
}

function projectIdentityState({
  canonicalId,
  canonicalName,
  publisherRow,
  report,
  hasRoute,
}) {
  const found = routeCase(report, canonicalId);
  const collision = collisionRow(report, canonicalId, canonicalName);
  const vintage = report?.generated_at || null;
  const sourceReport = "agency_route_identity_report.v1";
  if (found?.classification === "unresolved") {
    return Object.freeze({
      status: "unresolved",
      linking: false,
      source_id: canonicalId,
      basis: found.basis || "unresolved route identity",
      vintage,
      source_report: sourceReport,
      route: found.canonical_path || `/agencies/${canonicalId}/`,
      copy: IDENTITY_COPY.unresolved,
    });
  }
  if (collision) {
    return Object.freeze({
      status: "collision",
      linking: false,
      source_id: canonicalId,
      collision_ids: Object.freeze([...(collision.canonical_ids || [])]),
      comparison_key: collision.comparison_key,
      basis: "ambiguous publisher comparison key",
      vintage,
      source_report: sourceReport,
      route: hasRoute ? `/agencies/${canonicalId}/` : null,
      copy: IDENTITY_COPY.collision,
    });
  }
  if (found?.classification === "legitimate_non_crosswalk_entity") {
    return Object.freeze({
      status: "legitimate_external",
      linking: true,
      source_id: canonicalId,
      basis: found.basis || "legitimate non-crosswalk entity",
      vintage,
      source_report: sourceReport,
      route: found.canonical_path || `/agencies/${canonicalId}/`,
      copy: IDENTITY_COPY.legitimate_external,
    });
  }
  if (found && !publisherRow) {
    return Object.freeze({
      status: "route_only",
      linking: true,
      source_id: canonicalId,
      basis: found.basis || "route retained without publisher crosswalk",
      vintage,
      source_report: sourceReport,
      route: found.canonical_path || `/agencies/${canonicalId}/`,
      copy: IDENTITY_COPY.route_only,
    });
  }
  if (publisherRow && hasRoute === false) {
    return Object.freeze({
      status: "source_only",
      linking: false,
      source_id: canonicalId,
      basis: "publisher identity without a generated route",
      vintage,
      source_report: sourceReport,
      route: null,
      copy: IDENTITY_COPY.source_only,
    });
  }
  if (publisherRow && !found) {
    return Object.freeze({
      status: "matched",
      linking: true,
      source_id: canonicalId,
      basis: "publisher crosswalk plus stable agency route",
      vintage,
      source_report: sourceReport,
      route: `/agencies/${canonicalId}/`,
      copy: IDENTITY_COPY.matched,
    });
  }
  return Object.freeze({
    status: publisherRow ? "matched" : (hasRoute ? "route_only" : "unknown"),
    linking: Boolean(hasRoute && publisherRow),
    source_id: canonicalId,
    basis: publisherRow ? "publisher crosswalk plus stable agency route" : "identity is not independently classified",
    vintage,
    source_report: sourceReport,
    route: hasRoute ? `/agencies/${canonicalId}/` : null,
    copy: publisherRow ? IDENTITY_COPY.matched : IDENTITY_COPY.route_only,
  });
}

function projectCategoryState(category, generatedAt) {
  if (!category) {
    return Object.freeze({
      state: "unknown",
      count: null,
      source_basis: "category not evaluated",
      vintage: dayStamp(generatedAt),
      href: null,
    });
  }
  const raw = clean(category.status, 40).toLowerCase();
  const state = CATEGORY_EVIDENCE_STATES.includes(raw)
    ? raw
    : (category.count == null ? "unknown" : (Number(category.count) > 0 ? "matched" : "empty"));
  const count = state === "unknown" || state === "blocked"
    ? null
    : (Number.isInteger(Number(category.count)) ? Number(category.count) : null);
  const first = Array.isArray(category.items) ? category.items.find((item) => item?.href) : null;
  return Object.freeze({
    id: category.id,
    label: category.label || category.id,
    relation: category.relation || null,
    state,
    count,
    source_basis: clean(category.method, 200) || "agency constellation snapshot",
    vintage: dayStamp(category.as_of || generatedAt),
    href: state === "matched" ? (category.view_all_href || first?.href || null) : null,
    record_href: first?.href || null,
    copy: STATE_COPY[state],
  });
}

function projectCapability(spec, { categories, edges, evidence, generatedAt, identityState }) {
  if (identityState.status === "unresolved") {
    return Object.freeze({
      id: spec.id,
      label: spec.label,
      state: "blocked",
      source_basis: identityState.basis,
      vintage: dayStamp(identityState.vintage || generatedAt),
      href: null,
      relation_id: spec.relation || [...(spec.relations || [])][0] || null,
      copy: STATE_COPY.blocked,
    });
  }
  if (spec.identity) {
    const observations = Array.isArray(evidence?.observations) ? evidence.observations : [];
    const matched = observations.length > 0;
    const href = matched ? `#${spec.heading_id}` : null;
    return Object.freeze({
      id: spec.id,
      label: spec.label,
      state: matched ? "matched" : (evidence ? "empty" : "unknown"),
      source_basis: evidence?.method || "source-preserving agency identity",
      vintage: dayStamp(evidence?.provenance?.generated_at || generatedAt),
      href,
      record_href: observations[0]?.record_href || null,
      relation_id: "entity_link",
      copy: matched ? STATE_COPY.matched : STATE_COPY.empty,
    });
  }
  if (spec.relations) {
    const matchedEdges = acceptedMatching(edges, spec);
    if (matchedEdges.length) {
      const sample = matchedEdges[0];
      return Object.freeze({
        id: spec.id,
        label: spec.label,
        state: "matched",
        source_basis: sample.basis || sample.method || sample.provenance?.source_system || "civic-institution role edge",
        vintage: dayStamp(sample.as_of || sample.vintage || generatedAt),
        href: `#${spec.heading_id}`,
        record_href: sample.href || sample.notice_href || null,
        relation_id: sample.relation_id,
        parcel_hrefs: Object.freeze(
          (sample.parcel_trail || []).map((parcel) => parcel.href).filter(Boolean),
        ),
        copy: STATE_COPY.matched,
      });
    }
    const heldOrUnresolved = edges.some((edge) => {
      const matches = spec.relations.has(edge.relation_id)
        || (spec.include_hosts_meeting && isGovernanceHost(edge));
      return matches && edge.status && edge.status !== "accepted";
    });
    return Object.freeze({
      id: spec.id,
      label: spec.label,
      state: heldOrUnresolved ? "unknown" : "empty",
      source_basis: heldOrUnresolved
        ? "role evidence is held or unresolved"
        : "no accepted role edge in the current snapshot",
      vintage: dayStamp(generatedAt),
      href: null,
      relation_id: [...spec.relations][0],
      copy: heldOrUnresolved ? STATE_COPY.unknown : STATE_COPY.empty,
    });
  }
  const category = categories.get(spec.category);
  const projected = projectCategoryState(category, generatedAt);
  return Object.freeze({
    id: spec.id,
    label: spec.label,
    state: projected.state,
    source_basis: projected.source_basis,
    vintage: projected.vintage,
    href: projected.state === "matched"
      ? (projected.href || (category?.id ? `#${category.id === "obligations" ? "agency-statutory-mandates" : `agency-${category.id}`}` : null))
      : null,
    record_href: projected.record_href,
    relation_id: spec.relation,
    copy: projected.copy,
  });
}

function blockedCapabilities(generatedAt) {
  return Object.freeze([
    Object.freeze({
      id: "institution_kind",
      label: "Institution kind",
      state: "blocked",
      source_basis: "publisher organization type is source vocabulary",
      vintage: dayStamp(generatedAt),
      href: null,
      relation_id: null,
      copy: IDENTITY_COPY.oti_only,
    }),
    Object.freeze({
      id: "community_board_child",
      label: "Community Board membership",
      state: "blocked",
      source_basis: "Community Board identity uses board-local body ids on board pages",
      vintage: dayStamp(generatedAt),
      href: null,
      relation_id: null,
      copy: "Individual Community Boards keep board-local body ids on their own pages.",
    }),
  ]);
}

/**
 * Build the additive institution-profile navigation projection.
 * Existing agency subjects, routes, and category inventories stay intact.
 */
export function projectInstitutionProfileNavigation({
  view = null,
  identity = null,
  identityEvidence = null,
  publisherRow = null,
  routeIdentityReport = defaultRouteIdentityReport,
  hasRoute = true,
} = {}) {
  const evidence = identityEvidence || view?.identity_evidence || null;
  const canonicalId = clean(
    identity?.canonical_id || view?.canonical_id || view?.id || evidence?.institution?.canonical_id,
    160,
  );
  if (!canonicalId) return null;
  const canonicalName = clean(
    identity?.canonical_name || view?.display_name || evidence?.institution?.canonical_name || canonicalId,
    400,
  );
  const generatedAt = view?.summary?.generated_at
    || evidence?.provenance?.generated_at
    || routeIdentityReport?.generated_at
    || null;
  const institution = evidence?.institution || {
    id: `civic-institution:${canonicalId}`,
    canonical_id: canonicalId,
    canonical_name: canonicalName,
    legacy_subject_ref: `agency:id:${canonicalId}`,
    institution_kind: null,
    legal_form: null,
    classification_status: "unclassified",
  };
  const identityState = projectIdentityState({
    canonicalId,
    canonicalName,
    publisherRow: publisherRow || null,
    report: routeIdentityReport,
    hasRoute,
  });
  const aliases = projectReviewedRouteAliases(routeIdentityReport);
  const incoming = aliases.filter((edge) => edge.to === canonicalId);
  const outgoing = aliases.filter((edge) => edge.from === canonicalId);
  const categories = categoryMap(view);
  const categoryStates = Object.freeze(
    ["contracts", "vendors", "meetings", "rules", "obligations", "staffing"].map((id) => {
      const row = categories.get(id) || { id, status: view ? "empty" : "unknown", count: view ? 0 : null };
      return projectCategoryState({ id, ...row }, generatedAt);
    }),
  );
  const edges = roleBag(evidence);
  const capabilities = Object.freeze([
    ...CAPABILITY_SPECS.map((spec) => projectCapability(spec, {
      categories,
      edges,
      evidence,
      generatedAt,
      identityState,
    })),
    ...blockedCapabilities(generatedAt),
  ]);
  return Object.freeze({
    schema: INSTITUTION_PROFILE_NAVIGATION_SCHEMA,
    method: INSTITUTION_PROFILE_NAVIGATION_METHOD,
    identity: Object.freeze({
      canonical_id: canonicalId,
      canonical_name: canonicalName,
      subject_ref: `agency:id:${canonicalId}`,
      civic_institution_id: institution.id || `civic-institution:${canonicalId}`,
      route: `/agencies/${canonicalId}/`,
      institution_kind: institution.institution_kind || null,
      institution_kind_basis: institution.institution_kind_basis || null,
      legal_form: institution.legal_form || null,
      classification_status: institution.classification_status || "unclassified",
    }),
    identity_evidence_state: identityState,
    category_states: categoryStates,
    role_capabilities: capabilities,
    route_aliases: Object.freeze({
      incoming,
      outgoing,
    }),
    provenance: Object.freeze({
      source_report: "agency_route_identity_report.v1",
      source_contract: ROUTE_ALIAS_SOURCE_CONTRACT,
      vintage: generatedAt,
      route: `/agencies/${canonicalId}/`,
    }),
  });
}

function stateChip(state) {
  const label = state === "matched"
    ? "supported"
    : state === "empty"
      ? "empty in snapshot"
      : state === "blocked"
        ? "not inferred"
        : "unknown";
  return `<span class="institution-nav-state" data-evidence-state="${esc(state)}">${esc(label)}</span>`;
}

function capabilityHref(row) {
  return row.state === "matched" ? (row.record_href || row.href) : null;
}

function renderCapabilityList(rows, { matchedOnly = false } = {}) {
  const selected = matchedOnly
    ? rows.filter((row) => row.state === "matched" && capabilityHref(row))
    : rows;
  if (!selected.length) return "";
  return `<ul class="institution-nav-list">${selected.map((row) => {
    const href = capabilityHref(row);
    const label = href
      ? `<a class="ui-constellation-link agency-edge-link" href="${esc(href)}" data-capability="${esc(row.id)}">${esc(row.label)}</a>`
      : `<span data-capability="${esc(row.id)}">${esc(row.label)}</span>`;
    const parcels = Array.isArray(row.parcel_hrefs) && row.parcel_hrefs.length
      ? ` · ${row.parcel_hrefs.map((href) => `<a class="ui-constellation-link agency-edge-link" href="${esc(href)}">${esc(href.replace(/^\/parcels\//, "").replace(/\/$/, ""))}</a>`).join(", ")}`
      : "";
    const meta = [
      row.source_basis ? `Basis ${readerToken(row.source_basis)}` : "",
      row.vintage ? `As of ${row.vintage}` : "",
      row.relation_id ? `Relation ${readerToken(row.relation_id)}` : "",
    ].filter(Boolean).join(" · ");
    return `<li class="institution-nav-item" data-capability="${esc(row.id)}" data-evidence-state="${esc(row.state)}">
      <div class="institution-nav-main">${label}${stateChip(row.state)}${parcels}</div>
      <span class="muted node-muted">${esc(row.copy || "")}${meta ? ` · ${esc(meta)}` : ""}</span>
    </li>`;
  }).join("")}</ul>`;
}

function renderAliasList(edges, heading) {
  if (!edges.length) return "";
  return `<h3 class="institution-nav-subhead">${esc(heading)}</h3>
    <ul class="institution-nav-list">${edges.map((edge) => `<li class="institution-nav-item" data-relation="${esc(edge.relation_id)}" data-source-id="${esc(edge.source_id)}" data-canonical-id="${esc(edge.canonical_id)}" data-collision="${edge.collision ? "1" : "0"}">
      <div class="institution-nav-main"><a class="ui-constellation-link agency-edge-link" href="${esc(edge.href)}">${esc(edge.source_id.replace(/-/g, " "))} → ${esc(edge.canonical_id.replace(/-/g, " "))}</a></div>
      <span class="muted node-muted">Route alias · ${esc(edge.disposition_basis)} · Redirect ${esc(edge.redirect_path)} · Source report ${esc(readerToken(edge.source_report))} · Vintage ${esc(dayStamp(edge.vintage) || "report")}</span>
    </li>`).join("")}</ul>`;
}

function renderCategoryList(rows) {
  return `<ul class="institution-nav-list">${rows.map((row) => {
    const label = row.href
      ? `<a class="ui-constellation-link agency-edge-link" href="${esc(row.href)}">${esc(row.label || row.id)}</a>`
      : `<span>${esc(row.label || row.id)}</span>`;
    const meta = [
      row.source_basis ? `Basis ${readerToken(row.source_basis)}` : "",
      row.vintage ? `As of ${row.vintage}` : "",
      row.count != null ? `${row.count} joined` : "",
    ].filter(Boolean).join(" · ");
    return `<li class="institution-nav-item" data-category="${esc(row.id)}" data-evidence-state="${esc(row.state)}">
      <div class="institution-nav-main">${label}${stateChip(row.state)}</div>
      <span class="muted node-muted">${esc(row.copy || "")}${meta ? ` · ${esc(meta)}` : ""}</span>
    </li>`;
  }).join("")}</ul>`;
}

/** Compact first-paint capabilities plus an inspectable evidence disclosure. */
export function renderInstitutionProfileNavigation(projection) {
  if (!projection) return "";
  const identity = projection.identity_evidence_state || {};
  const matched = renderCapabilityList(projection.role_capabilities, { matchedOnly: true });
  const firstPaint = matched
    ? `<div class="institution-nav-capabilities" data-institution-nav-capabilities="1">${matched}</div>`
    : "";
  const collision = identity.status === "collision"
    ? `<p class="institution-nav-stop" data-identity-state="collision">Publisher comparison key ${esc(identity.comparison_key || "")} matches more than one identity. Inspect the evidence below to see both identities.</p>`
    : "";
  const unresolved = identity.status === "unresolved"
    ? `<p class="institution-nav-stop" data-identity-state="unresolved">${esc(identity.copy)}</p>`
    : "";
  const aliases = `${renderAliasList(projection.route_aliases?.incoming || [], "Reviewed route aliases")}
    ${renderAliasList(projection.route_aliases?.outgoing || [], "This route aliases")}`;
  const body = `${collision}${unresolved}
    <p class="node-muted">${esc(identity.copy || "")} Institution kind and legal form stay unclassified until independent evidence supports them. Publisher organization type is source vocabulary only.</p>
    ${firstPaint}
    <details class="institution-nav-disclosure" id="institution-profile-navigation-details">
      <summary>Inspect coverage details</summary>
      <p class="muted node-muted">Source report ${esc(readerToken(projection.provenance?.source_report || ""))} · Route ${esc(projection.provenance?.route || "")}${dayStamp(projection.provenance?.vintage) ? ` · Vintage ${esc(dayStamp(projection.provenance.vintage))}` : ""}</p>
      <h3 class="institution-nav-subhead">Role capabilities</h3>
      ${renderCapabilityList(projection.role_capabilities)}
      <h3 class="institution-nav-subhead">Category evidence</h3>
      ${renderCategoryList(projection.category_states)}
      ${aliases}
    </details>`;
  return renderNodeSection({
    heading: "What you can follow",
    headingId: "institution-profile-navigation-heading",
    exportClass: "object_institution_navigation",
    extraClass: "node-card civic-object-section institution-profile-navigation",
    attrs: {
      id: "institution-profile-navigation",
      "data-navigation-schema": projection.schema,
      "data-identity-state": identity.status || "unknown",
      "data-identity-linking": identity.linking ? "1" : "0",
    },
    body,
  });
}

export function renderInstitutionUncertaintyDocument(projection, {
  title = "Agency identity",
  renderNavigation = renderInstitutionProfileNavigation,
} = {}) {
  const identity = projection?.identity_evidence_state || {};
  const heading = identity.status === "collision"
    ? "More than one identity shares this name"
    : "This route is unresolved";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(heading)} · CityScroll</title>${renderCivicDocumentAssets()}</head>
<body>
${renderCivicDocumentMast({ current: "browse" })}
<main id="main" class="node-document civic-object-document" data-node-document="1" data-identity-state="${esc(identity.status || "unresolved")}" data-identity-linking="0">
${renderNodeBack({ href: "/agencies/", label: "Back to agencies" })}
<header class="node-hero civic-object-hero"><p class="node-kicker civic-object-kicker">${esc(title)}</p>
<h1>${esc(heading)}</h1>
<p class="node-lede">${esc(identity.copy || IDENTITY_COPY.unresolved)}</p>
</header>
${renderNavigation(projection)}
<p class="node-inline-actions civic-object-inline-actions"><a class="node-action civic-object-action" href="/agencies/">Browse reviewed agencies</a></p>
</main>
${renderNodeFooter()}
</body></html>`;
  return gateNodePageRender(html);
}

export { defaultRouteIdentityReport };
