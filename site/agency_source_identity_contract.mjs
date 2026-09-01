/**
 * Machine-only agency source-identity compatibility contract.
 *
 * Compatibility is a contract, not a global rename. This module is the
 * machine seam for CI-K1 source identity: it preserves `agency:id:*`
 * subject refs, `/agencies/<slug>/` routes, reviewed `route_alias_of`
 * edges, `agency:{canonical_id|name}`, property disposition keys,
 * person-leader keys, staffing agency refs, and Community Board body ids
 * while collisions, unresolved, route-only, and source-only identities
 * stay non-linking and never infer an institution kind.
 *
 * It deliberately imports no reader-facing chrome. Resident disclosure
 * lives in civic_institution_profile_navigation.mjs; this contract is the
 * additive machine surface read-model adapters consume.
 */

import { AGENCY_GROUPS, agencyRouteAliasTarget } from "./agency_identity.mjs";
import { personLeaderEntityId } from "../entity_resolution/leaders/index.mjs";
import defaultRouteIdentityReport from "./data/agency_route_identity_report.json" with { type: "json" };
import defaultConstellationLookup from "./data/agency_constellation_lookup.json" with { type: "json" };
import defaultExamConstellation from "./data/exam_certification_constellation.json" with { type: "json" };
import defaultBoardLookup from "./data/community_board_constellation_lookup.json" with { type: "json" };
import defaultPropertyObservations from "./data/property_domain_observations.json" with { type: "json" };
import defaultPropertyCrossDomain from "./data/property_cross_domain_lookup.json" with { type: "json" };

export const AGENCY_SOURCE_IDENTITY_CONTRACT_SCHEMA = "cityscroll.agency_source_identity_contract.v1";
export const AGENCY_SOURCE_IDENTITY_CONTRACT_METHOD = "agency_source_identity_contract_v1";
export const ROUTE_ALIAS_OF_RELATION = "route_alias_of";
export const ROUTE_ALIAS_OF_INVERSE = "has_route_alias";
export const ROUTE_ALIAS_SOURCE_CONTRACT = "cityscroll.agency_route_identity_report.v1";
export const AGENCY_SUBJECT_REF_PATTERN = "agency:id:{canonical_id}";
export const AGENCY_OBJECT_KEY_PATTERN = "agency:{canonical_id|name}";
export const PROPERTY_SITE_KEY_PATTERN = "disposition:{agency}:{bbl|taxlot}|notice:{notice_id}";
export const PERSON_LEADER_KEY_PATTERN = "person-leader:{agency_id}:{person_id|name}";
export const STAFFING_AGENCY_KEY_PATTERN = "agency:id:{canonical_id}";

// Identity statuses that never mint a link to a canonical subject and never
// carry an institution kind. `route_only` retains its own route but is still
// barred from resolving to a different canonical identity.
export const AGENCY_SOURCE_IDENTITY_NON_LINKING_STATUSES = Object.freeze([
  "collision",
  "unresolved",
  "route_only",
  "source_only",
]);

export const AGENCY_SOURCE_IDENTITY_STATUSES = Object.freeze([
  "matched",
  "collision",
  "unresolved",
  "route_only",
  "source_only",
  "legitimate_external",
  "alias_route",
  "unknown",
]);

const AGENCY_SUBJECT_REF_RE = /^agency:id:[a-z0-9][a-z0-9.-]*$/;
const COMMUNITY_BOARD_BODY_ID_RE = /^[a-z]+(?:-[a-z]+)*-cb-\d{2}$/;
const PROPERTY_DISPOSITION_KEY_RE = /^disposition:[a-z0-9][a-z0-9.-]*:(?:bbl|taxlot):\d+[a-z0-9]*$/;
const NOTICE_SUBJECT_RE = /^notice:[A-Za-z0-9-]+$/;
const PERSON_LEADER_KEY_RE = /^person-leader:[a-z0-9][a-z0-9.-]*:(?:id|name):.+$/;

function clean(value, max = 200) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function sortedUnique(values) {
  return Object.freeze([...new Set(values)].sort());
}

/**
 * Reviewed `route_alias_of` edges, derived exactly like the resident
 * projection: report alias cases ∩ reviewed ROUTE_ALIAS_TARGETS, never
 * self-aliases, collisions, unresolved routes, or legitimate externals.
 * The regression test asserts byte equality with
 * projectReviewedRouteAliases() so the machine and reader halves cannot
 * drift.
 */
export function projectReviewedRouteAliasEdges(report = defaultRouteIdentityReport) {
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
    edges.push({
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
      vintage: report?.generated_at || null,
    });
  }
  return edges;
}

/**
 * Machine identity status for one agency identity surface. Mirrors the
 * resident projection's decision order: unresolved, collision,
 * legitimate external, then route/publisher presence. Non-linking
 * statuses keep their own source id — no guessed canonical subject and
 * no institution kind is ever inferred.
 */
export function classifyAgencySourceIdentity(sourceId, {
  report = defaultRouteIdentityReport,
  crosswalk = null,
  routes = null,
} = {}) {
  const id = clean(sourceId, 160).replace(/^agency:id:/, "");
  if (!id) return null;
  const routeSet = routes instanceof Set ? routes : null;
  const hasRoute = routeSet ? routeSet.has(id) : null;
  const publisherRow = crosswalk ? (crosswalk.entries || crosswalk)[id] || null : null;
  const found = (report?.cases || []).find((row) => row.source_id === id) || null;
  const collisionRow = (report?.collisions?.ambiguous_publisher_keys || []).find((row) =>
    (row.canonical_ids || []).includes(id),
  ) || null;
  // The report declares canonical_path for retained route cases even when no
  // static directory is generated (unresolved and some standalone routes).
  const route = found?.canonical_path || (hasRoute ? `/agencies/${id}/` : null);
  const vintage = report?.generated_at || null;
  const self = { source_id: id, institution_kind: null, vintage };
  if (agencyRouteAliasTarget(id)) {
    return Object.freeze({
      ...self,
      status: "alias_route",
      links_to_canonical: true,
      canonical_id: agencyRouteAliasTarget(id),
      route: `/agencies/${id}/`,
      basis: "reviewed route alias",
    });
  }
  if (found?.classification === "unresolved") {
    return Object.freeze({
      ...self,
      status: "unresolved",
      links_to_canonical: false,
      canonical_id: null,
      route,
      basis: found.basis || "no exact publisher-crosswalk identity",
    });
  }
  if (collisionRow && found?.classification !== "alias_to_canonical") {
    return Object.freeze({
      ...self,
      status: "collision",
      links_to_canonical: false,
      canonical_id: null,
      collision_ids: Object.freeze([...(collisionRow.canonical_ids || [])].sort()),
      comparison_key: collisionRow.comparison_key,
      route,
      basis: "ambiguous publisher comparison key",
    });
  }
  if (found?.classification === "legitimate_non_crosswalk_entity") {
    return Object.freeze({
      ...self,
      status: "legitimate_external",
      links_to_canonical: false,
      canonical_id: null,
      route,
      basis: found.basis || "legitimate non-crosswalk entity",
    });
  }
  if (hasRoute === false && publisherRow) {
    return Object.freeze({
      ...self,
      status: "source_only",
      links_to_canonical: false,
      canonical_id: null,
      route: null,
      basis: "publisher identity without a generated route",
    });
  }
  if (hasRoute === true && !publisherRow) {
    return Object.freeze({
      ...self,
      status: "route_only",
      links_to_canonical: false,
      canonical_id: null,
      route,
      basis: found?.basis || "route retained without publisher crosswalk",
    });
  }
  if (hasRoute === true && publisherRow) {
    return Object.freeze({
      ...self,
      status: "matched",
      links_to_canonical: true,
      canonical_id: id,
      route,
      basis: found?.basis || "publisher crosswalk plus stable agency route",
    });
  }
  return Object.freeze({
    ...self,
    status: "unknown",
    links_to_canonical: false,
    canonical_id: null,
    route,
    basis: found?.basis || "identity is not independently classified",
  });
}

/** `agency:id:<canonical_id>` subject ref shape used by scopes and follows. */
export function isAgencySubjectRef(value) {
  return AGENCY_SUBJECT_REF_RE.test(String(value || ""));
}

/** `agency:{canonical_id}` or `agency:{name}` object key branch. */
export function isAgencyObjectKey(value) {
  const raw = clean(value, 240);
  if (!raw || raw.startsWith("agency:id:")) return false;
  const tail = raw.slice("agency:".length);
  if (!tail) return false;
  const canonicalBranch = /^[a-z0-9][a-z0-9.-]*$/.test(tail);
  const nameBranch = /^[A-Za-z0-9][A-Za-z0-9'&.\s-]*$/.test(tail);
  return canonicalBranch || nameBranch;
}

/** `disposition:{agency}:{bbl|taxlot}` or `notice:{notice_id}` property key. */
export function isPropertyDispositionKey(value) {
  const raw = clean(value, 240);
  return PROPERTY_DISPOSITION_KEY_RE.test(raw) || NOTICE_SUBJECT_RE.test(raw);
}

/** `person-leader:{agency_id}:{id|name}:<segment>` key. */
export function isPersonLeaderKey(value) {
  return PERSON_LEADER_KEY_RE.test(clean(value, 240));
}

/** Community Board `body_id` shape, e.g. `brooklyn-cb-15`. */
export function isCommunityBoardBodyId(value) {
  return COMMUNITY_BOARD_BODY_ID_RE.test(clean(value, 60));
}

/** Staffing agency key: `agency:id:<canonical_id>` on certified_to_agency edges. */
export function isStaffingAgencyKey(value) {
  return isAgencySubjectRef(value);
}

function collectDispositionSubjects(node, acc) {
  if (Array.isArray(node)) {
    for (const item of node) collectDispositionSubjects(item, acc);
    return;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "disposition_subject_ref" && typeof value === "string") {
        acc.add(clean(value, 240));
      } else {
        collectDispositionSubjects(value, acc);
      }
    }
  }
}

function collectNoticeSubjects(agencyObjects, acc) {
  for (const row of Array.isArray(agencyObjects) ? agencyObjects : []) {
    const ref = clean(row?.subject_ref, 240);
    if (ref.startsWith("notice:")) acc.add(ref);
  }
}

function crosswalkEntries(crosswalk) {
  const entries = crosswalk?.entries ?? crosswalk;
  return entries && typeof entries === "object" && !Array.isArray(entries) ? entries : {};
}

/**
 * Build the deterministic machine compatibility contract.
 *
 * `crosswalk` (worker/src/data/agency_crosswalk.json shape) and `routes`
 * (generated agency route directory names) are injected so this module
 * stays free of worker and filesystem imports; the snapshot tool and the
 * regression test always pass the real values.
 */
export function buildAgencySourceIdentityContract({
  routeIdentityReport = defaultRouteIdentityReport,
  constellationLookup = defaultConstellationLookup,
  examConstellation = defaultExamConstellation,
  boardLookup = defaultBoardLookup,
  propertyObservations = defaultPropertyObservations,
  propertyCrossDomain = defaultPropertyCrossDomain,
  crosswalk = null,
  routes = [],
} = {}) {
  const publisherEntries = crosswalkEntries(crosswalk);
  const routeNames = sortedUnique((Array.isArray(routes) ? routes : []).map((r) => clean(r, 160)));
  const routeSet = new Set(routeNames);
  const byId = constellationLookup?.by_id && typeof constellationLookup.by_id === "object"
    ? constellationLookup.by_id
    : {};

  const subjectRefs = sortedUnique(Object.keys(byId).map((id) => `agency:id:${clean(id, 160)}`));
  // The identity surface is every retained route, every publisher identity,
  // and every report case — unresolved routes have no generated directory,
  // so excluding cases would silently drop the visibly-uncertain identities.
  const identitySurfaces = sortedUnique([
    ...routeNames,
    ...Object.keys(publisherEntries).map((id) => clean(id, 160)),
    ...(routeIdentityReport?.cases || []).map((row) => clean(row.source_id, 160)),
  ]);
  const identityStates = identitySurfaces.map((id) =>
    classifyAgencySourceIdentity(id, { report: routeIdentityReport, crosswalk, routes: routeSet }),
  );
  const nonLinking = identityStates.filter((row) =>
    AGENCY_SOURCE_IDENTITY_NON_LINKING_STATUSES.includes(row.status),
  );

  const aliasEdges = projectReviewedRouteAliasEdges(routeIdentityReport);
  const dispositionSubjects = new Set();
  collectDispositionSubjects(propertyObservations, dispositionSubjects);
  const noticeSubjects = new Set();
  if (propertyCrossDomain) collectNoticeSubjects(propertyCrossDomain.agency_objects, noticeSubjects);

  const personLeaderKeys = [];
  for (const [id, entry] of Object.entries(publisherEntries)) {
    const key = personLeaderEntityId({
      agencyId: clean(id, 160),
      personName: clean(entry?.head_name, 200),
    });
    if (key) personLeaderKeys.push(key);
  }

  const staffingAgencyRefs = sortedUnique(
    (Array.isArray(examConstellation?.by_agency) ? examConstellation.by_agency : [])
      .map((row) => clean(row?.ref, 200))
      .filter(Boolean),
  );
  const boardBodyIds = sortedUnique(
    Object.values(boardLookup?.by_id && typeof boardLookup.by_id === "object" ? boardLookup.by_id : {})
      .map((row) => clean(row?.body_id, 60))
      .filter(Boolean),
  );

  const agencyCanonicalIdKeys = sortedUnique(
    Object.keys(publisherEntries).map((id) => `agency:${clean(id, 160)}`),
  );
  const agencyNameKeys = sortedUnique([
    // Publisher canonical names (crosswalk) plus the reviewed browse
    // canonical names (AGENCY_GROUPS) both materialize the name branch of
    // `agency:{canonical_id|name}`.
    ...Object.entries(publisherEntries)
      .map(([, entry]) => clean(entry?.canonical_name, 240))
      .filter(Boolean)
      .map((name) => `agency:${name}`),
    ...Object.keys(AGENCY_GROUPS).map((name) => `agency:${clean(name, 240)}`),
  ]);

  const statusCounts = {};
  for (const row of identityStates) statusCounts[row.status] = (statusCounts[row.status] || 0) + 1;

  return Object.freeze({
    schema: AGENCY_SOURCE_IDENTITY_CONTRACT_SCHEMA,
    method: AGENCY_SOURCE_IDENTITY_CONTRACT_METHOD,
    relation: Object.freeze({
      id: ROUTE_ALIAS_OF_RELATION,
      inverse: ROUTE_ALIAS_OF_INVERSE,
      source_contract: ROUTE_ALIAS_SOURCE_CONTRACT,
      precision: "exact reviewed alias only",
      negative_rule: Object.freeze([
        "unresolved routes do not become aliases",
        "colliding comparison keys never mint route_alias_of",
        "legitimate external and source-only identities stay separate",
        "a route existing or naming a similar agency is never sufficient",
      ]),
    }),
    subject_refs: Object.freeze({
      pattern: AGENCY_SUBJECT_REF_PATTERN,
      count: subjectRefs.length,
      refs: Object.freeze(subjectRefs),
    }),
    routes: Object.freeze({
      pattern: "/agencies/{slug}/",
      count: routeNames.length,
      paths: Object.freeze(routeNames.map((name) => `/agencies/${name}/`)),
    }),
    route_alias_of: Object.freeze(aliasEdges.map((edge) => Object.freeze({ ...edge }))),
    identity_states: Object.freeze({
      counts: Object.freeze(statusCounts),
      non_linking_statuses: Object.freeze([...AGENCY_SOURCE_IDENTITY_NON_LINKING_STATUSES]),
      non_linking: Object.freeze(nonLinking),
      states: Object.freeze(identityStates),
    }),
    key_shapes: Object.freeze({
      agency: Object.freeze({
        pattern: AGENCY_OBJECT_KEY_PATTERN,
        canonical_id_keys: Object.freeze(agencyCanonicalIdKeys),
        name_keys: Object.freeze(agencyNameKeys),
      }),
      property_site: Object.freeze({
        pattern: PROPERTY_SITE_KEY_PATTERN,
        disposition_subject_refs: Object.freeze(sortedUnique([...dispositionSubjects])),
        notice_subject_refs: Object.freeze(sortedUnique([...noticeSubjects])),
      }),
      person_leader: Object.freeze({
        pattern: PERSON_LEADER_KEY_PATTERN,
        keys: Object.freeze(sortedUnique(personLeaderKeys)),
      }),
      staffing: Object.freeze({
        relation: "certified_to_agency",
        pattern: STAFFING_AGENCY_KEY_PATTERN,
        agency_refs: Object.freeze(staffingAgencyRefs),
      }),
    }),
    community_boards: Object.freeze({
      count: boardBodyIds.length,
      body_ids: Object.freeze(boardBodyIds),
    }),
    guard_rails: Object.freeze({
      index_wide_role_filters: false,
      index_evidence_chips: false,
      global_agency_rename: false,
      community_board_child_relation: null,
      resident_chrome_required: false,
    }),
    provenance: Object.freeze({
      route_identity_report: routeIdentityReport?.generated_at || null,
      constellation_lookup: constellationLookup?.generated_at || null,
      exam_constellation: examConstellation?.generated_at || null,
      board_lookup: boardLookup?.generated_at || null,
      property_observations: propertyObservations?.generated_at || null,
    }),
  });
}
