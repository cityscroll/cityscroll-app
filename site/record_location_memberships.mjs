/**
 * Source-qualified record-location membership projection.
 *
 * Joins admitted location assertions to exact address-cache BBLs and the
 * committed parcel-membership generation. Active assertions stay keyed by
 * record identity, assertion identity, source-content hash and role. Geographic
 * edges keep role and source path; reverse lists expose distinct record IDs
 * separately from the full evidence list. Source corrections replace only the
 * affected active assertions — surviving subject/host relations keep their own
 * roles.
 *
 * Build/ingestion path. Keep this module free of location_extract.mjs (module-
 * dom inline rebuild binding collisions).
 */

import { civicGeographyKey } from "./civic_geography_registry.mjs";
import {
  LOCATION_ROLES,
  isAdmittedPhysicalVenue,
  isAdmittedSubjectProperty,
} from "./meeting_location_assertions.mjs";
import {
  PARCEL_MEMBERSHIP_LAYERS,
  lookupParcelMemberships,
  parcelShardKey,
} from "./parcel_geography.mjs";

export const RECORD_LOCATION_MEMBERSHIP_PROJECTION_SCHEMA =
  "cityscroll.record_location_membership_projection.v1";
export const RECORD_LOCATION_ACTIVE_ASSERTION_SCHEMA =
  "cityscroll.record_location_active_assertion.v1";
export const RECORD_LOCATION_EDGE_SCHEMA = "cityscroll.record_location_edge.v1";
export const RECORD_LOCATION_EDGE_METHOD = "accepted_exact_parcel_membership";
export const RECORD_LOCATION_HOST_METHOD = "host_jurisdiction_relation";

const EDGE_LAYERS = Object.freeze([
  "nta2020",
  "community_district",
  "council_district",
  "borough",
  "police_precinct",
]);

function cleanText(value, max = 500) {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
  return text || null;
}

function recordIdentity(assertion, resolution = null) {
  return cleanText(
    assertion?.meeting_id
    || assertion?.record_id
    || resolution?.meeting_id
    || resolution?.record_id
    || null,
    500,
  );
}

/**
 * Stable content identity for an assertion so a correction replaces the active
 * row while retained history stays dated.
 */
export function assertionSourceContentHash(assertion) {
  if (!assertion || typeof assertion !== "object") return "";
  const payload = [
    assertion.role || "",
    assertion.validity || "",
    assertion.original_address || "",
    assertion.venue_name || "",
    assertion.source_field || "",
    assertion.source_passage || "",
    assertion.passage_locator || "",
    assertion.passage_text_sha256 || "",
    assertion.components?.street_address || "",
    assertion.components?.address_locality || "",
    assertion.components?.address_borough || "",
    assertion.components?.address_region || "",
    assertion.components?.postal_code || "",
    assertion.attendance_meaning || "",
  ].join("\u001f");
  return fnv1aHex(payload);
}

function fnv1aHex(value) {
  let hash = 0x811c9dc5;
  const text = String(value ?? "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function isParcelEligibleAssertion(assertion) {
  return isAdmittedPhysicalVenue(assertion) || isAdmittedSubjectProperty(assertion);
}

function isHostJurisdictionAssertion(assertion) {
  return assertion?.role === LOCATION_ROLES.HOST_JURISDICTION;
}

function sourcePathFromAssertion(assertion) {
  if (!assertion || typeof assertion !== "object") return null;
  return {
    source_field: assertion.source_field || null,
    source_passage: assertion.source_passage || null,
    passage_locator: assertion.passage_locator || null,
    passage_text_sha256: assertion.passage_text_sha256 || null,
    original_address: assertion.original_address || null,
    venue_name: assertion.venue_name || null,
    components: assertion.components || null,
  };
}

function activeAssertionKey(recordId, assertionId) {
  return `${recordId || ""}\u001f${assertionId || ""}`;
}

function shapeActiveAssertion({
  assertion,
  resolution = null,
  observedAt = null,
  hostGeography = null,
}) {
  const meetingId = cleanText(assertion?.meeting_id || resolution?.meeting_id, 500);
  const recordId = recordIdentity(assertion, resolution);
  const assertionId = cleanText(assertion?.assertion_id || resolution?.assertion_id, 500);
  return {
    schema: RECORD_LOCATION_ACTIVE_ASSERTION_SCHEMA,
    record_id: recordId,
    meeting_id: meetingId,
    assertion_id: assertionId,
    role: assertion?.role || resolution?.role || null,
    source_content_hash: assertionSourceContentHash(assertion),
    validity: assertion?.validity || null,
    active: true,
    observed_at: observedAt || null,
    superseded_at: null,
    resolution: resolution
      ? {
        cache_key: resolution.cache_key || null,
        bbl: resolution.bbl || null,
        status: resolution.status || null,
        reason: resolution.reason || null,
        published_address: resolution.published_address || null,
      }
      : null,
    source_path: sourcePathFromAssertion(assertion),
    host_geography: hostGeography || null,
  };
}

function edgeSortKey(edge) {
  return [
    edge.geography_key || "",
    edge.record_id || "",
    edge.role || "",
    edge.assertion_id || "",
    edge.bbl || "",
  ].join("\u001f");
}

function buildParcelEdges({
  assertion,
  resolution,
  membershipBundle,
  labelFor,
  parcelMembershipGeneration = null,
  observedAt = null,
}) {
  const recordId = recordIdentity(assertion, resolution);
  const meetingId = cleanText(assertion?.meeting_id || resolution?.meeting_id, 500);
  const assertionId = cleanText(assertion?.assertion_id || resolution?.assertion_id, 500);
  const role = assertion?.role || resolution?.role || null;
  const bbl = String(resolution?.bbl || membershipBundle?.bbl || "").trim();
  const sourcePath = sourcePathFromAssertion(assertion);
  const edges = [];

  for (const layerType of EDGE_LAYERS) {
    const membership = membershipBundle?.memberships?.[layerType];
    if (!membership || membership.status !== "matched") continue;
    for (const geographyId of membership.ids || []) {
      const geographyKey = civicGeographyKey(layerType, geographyId);
      if (!geographyKey) continue;
      edges.push({
        schema: RECORD_LOCATION_EDGE_SCHEMA,
        record_id: recordId,
        meeting_id: meetingId,
        assertion_id: assertionId,
        role,
        geography_key: geographyKey,
        geography_type: layerType,
        geography_id: geographyId,
        geography_label: typeof labelFor === "function"
          ? (labelFor(layerType, geographyId) || null)
          : null,
        bbl,
        membership_status: membership.status,
        parcel_membership_vintage: membership.vintage || null,
        source_path: sourcePath,
        provenance: {
          method: RECORD_LOCATION_EDGE_METHOD,
          pad_status: resolution?.status || null,
          cache_key: resolution?.cache_key || null,
          parcel_membership_generation: parcelMembershipGeneration || null,
          layer_sha256: membership.sha256 || null,
        },
        observed_at: observedAt || null,
      });
    }
  }
  return edges;
}

function buildHostEdges({
  assertion,
  hostGeography,
  observedAt = null,
}) {
  if (!hostGeography?.geography_key && !(hostGeography?.geography_type && hostGeography?.geography_id)) {
    return [];
  }
  const geographyType = hostGeography.geography_type || null;
  const geographyId = hostGeography.geography_id || null;
  const geographyKey = hostGeography.geography_key
    || (geographyType && geographyId ? civicGeographyKey(geographyType, geographyId) : null);
  if (!geographyKey) return [];
  const recordId = recordIdentity(assertion);
  return [{
    schema: RECORD_LOCATION_EDGE_SCHEMA,
    record_id: recordId,
    meeting_id: cleanText(assertion?.meeting_id, 500),
    assertion_id: cleanText(assertion?.assertion_id, 500),
    role: LOCATION_ROLES.HOST_JURISDICTION,
    geography_key: geographyKey,
    geography_type: geographyType || geographyKey.split(":")[1] || null,
    geography_id: geographyId || geographyKey.split(":").slice(2).join(":") || null,
    geography_label: hostGeography.geography_label || null,
    bbl: null,
    membership_status: null,
    parcel_membership_vintage: null,
    source_path: sourcePathFromAssertion(assertion),
    provenance: {
      method: RECORD_LOCATION_HOST_METHOD,
      pad_status: null,
      cache_key: null,
      parcel_membership_generation: null,
      layer_sha256: null,
    },
    observed_at: observedAt || null,
  }];
}

function buildReverseIndex(edges) {
  const byKey = new Map();
  for (const edge of edges) {
    const key = edge.geography_key;
    if (!key) continue;
    if (!byKey.has(key)) {
      byKey.set(key, { recordIds: new Set(), evidence: [] });
    }
    const bucket = byKey.get(key);
    if (edge.record_id) bucket.recordIds.add(edge.record_id);
    bucket.evidence.push(edge);
  }
  const reverse = {};
  for (const key of [...byKey.keys()].sort()) {
    const bucket = byKey.get(key);
    reverse[key] = {
      record_ids: [...bucket.recordIds].sort(),
      evidence: bucket.evidence
        .slice()
        .sort((left, right) => edgeSortKey(left).localeCompare(edgeSortKey(right))),
    };
  }
  return reverse;
}

/**
 * Create the production record-location membership projection builder.
 *
 * @param {object} options
 * @param {(shardKey: string) => object|null|undefined} options.loadParcelShard
 *   Loads a committed (or fixture) parcel-geography shard by key. Required.
 * @param {(type: string, id: string) => string|null|undefined} [options.labelFor]
 *   Optional geography label lookup (e.g. NTA → "Midwood").
 * @param {string|null} [options.parcelMembershipGeneration]
 *   Generation identity recorded on parcel-derived edge provenance.
 */
export function createRecordLocationMembershipProjection({
  loadParcelShard,
  labelFor = null,
  parcelMembershipGeneration = null,
} = {}) {
  if (typeof loadParcelShard !== "function") {
    throw new Error("record location membership projection requires loadParcelShard");
  }

  /** @type {Map<string, object>} */
  const activeByKey = new Map();
  /** @type {object[]} */
  const history = [];
  /** @type {object[]} */
  const edges = [];

  function clearEdgesForAssertion(assertionId, recordId) {
    for (let index = edges.length - 1; index >= 0; index -= 1) {
      const edge = edges[index];
      if (edge.assertion_id === assertionId && edge.record_id === recordId) {
        edges.splice(index, 1);
      }
    }
  }

  function clearEdgesForRecord(recordId) {
    for (let index = edges.length - 1; index >= 0; index -= 1) {
      if (edges[index].record_id === recordId) edges.splice(index, 1);
    }
  }

  function resolveMembershipBundle(bbl) {
    const id = String(bbl || "").trim();
    if (!id) return null;
    const shardKey = parcelShardKey(id);
    const shard = loadParcelShard(shardKey);
    if (!shard) return null;
    return lookupParcelMemberships(shard, id);
  }

  function projectOneInput(input, { observedAt = null } = {}) {
    if (!input || typeof input !== "object") {
      return { active: null, edges: [], skipped: "empty_input" };
    }
    const assertion = input.assertion || null;
    const resolution = input.resolution || input.link || null;
    const hostGeography = input.host_geography || null;

    if (!assertion) {
      return { active: null, edges: [], skipped: "missing_assertion" };
    }

    const active = shapeActiveAssertion({
      assertion,
      resolution,
      observedAt,
      hostGeography,
    });

    // Host jurisdiction is retained as its own relation; it never borrows a
    // venue role or a parcel edge from another assertion.
    if (isHostJurisdictionAssertion(assertion)) {
      return {
        active,
        edges: buildHostEdges({ assertion, hostGeography, observedAt }),
        skipped: null,
      };
    }

    if (!isParcelEligibleAssertion(assertion)) {
      return { active, edges: [], skipped: "assertion_not_parcel_eligible" };
    }

    const bbl = resolution?.bbl ? String(resolution.bbl).trim() : "";
    if (!bbl || resolution?.status !== "matched") {
      // Ambiguous / unmatched / empty resolutions create no parcel-derived edge.
      return { active, edges: [], skipped: "no_exact_accepted_bbl" };
    }

    const membershipBundle = resolveMembershipBundle(bbl);
    if (!membershipBundle) {
      return { active, edges: [], skipped: "parcel_memberships_unavailable" };
    }

    return {
      active,
      edges: buildParcelEdges({
        assertion,
        resolution,
        membershipBundle,
        labelFor,
        parcelMembershipGeneration,
        observedAt,
      }),
      skipped: null,
    };
  }

  /**
   * Materialize / refresh the full active projection from a batch of inputs.
   * Each input is `{ assertion, resolution?, host_geography? }`. Resolutions
   * come from the address-cache assertion links (exact BBL or unresolved).
   */
  function project(inputs = [], { observedAt = null, replaceAll = true } = {}) {
    if (replaceAll) {
      activeByKey.clear();
      edges.length = 0;
    }
    const list = Array.isArray(inputs) ? inputs : [];
    const results = [];
    for (const input of list) {
      const outcome = projectOneInput(input, { observedAt });
      results.push(outcome);
      if (!outcome.active?.assertion_id || !outcome.active?.record_id) continue;
      const key = activeAssertionKey(outcome.active.record_id, outcome.active.assertion_id);
      const prior = activeByKey.get(key);
      if (prior?.active) {
        history.push({
          ...prior,
          active: false,
          superseded_at: observedAt || new Date().toISOString(),
        });
        clearEdgesForAssertion(prior.assertion_id, prior.record_id);
      }
      activeByKey.set(key, outcome.active);
      for (const edge of outcome.edges) edges.push(edge);
    }
    return snapshot({ last_results: results });
  }

  /**
   * Replace the active assertions for one record. Removed assertions withdraw
   * only their own membership edges; surviving subject/host relations keep
   * their roles and cannot inherit a withdrawn venue role.
   */
  function replaceRecordAssertions(recordId, inputs = [], { observedAt = null } = {}) {
    const id = cleanText(recordId, 500);
    if (!id) throw new Error("replaceRecordAssertions requires a record id");
    const stamp = observedAt || new Date().toISOString();

    for (const [key, active] of [...activeByKey.entries()]) {
      if (active.record_id !== id) continue;
      history.push({
        ...active,
        active: false,
        superseded_at: stamp,
      });
      activeByKey.delete(key);
    }
    clearEdgesForRecord(id);

    const list = Array.isArray(inputs) ? inputs : [];
    const results = [];
    for (const input of list) {
      const outcome = projectOneInput(input, { observedAt: stamp });
      results.push(outcome);
      if (!outcome.active?.assertion_id) continue;
      // Guard: a surviving subject/host input must keep its own role.
      const incomingRole = outcome.active.role;
      if (
        incomingRole === LOCATION_ROLES.VENUE
        && input?.assertion
        && input.assertion.role !== LOCATION_ROLES.VENUE
      ) {
        throw new Error("surviving relation cannot silently inherit venue role");
      }
      const key = activeAssertionKey(outcome.active.record_id, outcome.active.assertion_id);
      activeByKey.set(key, outcome.active);
      for (const edge of outcome.edges) edges.push(edge);
    }
    return snapshot({ last_results: results });
  }

  function snapshot(extra = {}) {
    const activeAssertions = [...activeByKey.values()]
      .sort((left, right) => activeAssertionKey(left.record_id, left.assertion_id)
        .localeCompare(activeAssertionKey(right.record_id, right.assertion_id)));
    const sortedEdges = edges
      .slice()
      .sort((left, right) => edgeSortKey(left).localeCompare(edgeSortKey(right)));
    return {
      schema: RECORD_LOCATION_MEMBERSHIP_PROJECTION_SCHEMA,
      parcel_membership_generation: parcelMembershipGeneration,
      active_assertion_count: activeAssertions.length,
      edge_count: sortedEdges.length,
      active_assertions: activeAssertions,
      edges: sortedEdges,
      reverse: buildReverseIndex(sortedEdges),
      history: history.slice(),
      ...extra,
    };
  }

  function edgesForRecord(recordId) {
    const id = String(recordId || "");
    return edges.filter((edge) => edge.record_id === id);
  }

  function reverseFor(geographyKey) {
    return buildReverseIndex(edges)[geographyKey] || { record_ids: [], evidence: [] };
  }

  return {
    project,
    replaceRecordAssertions,
    snapshot,
    edgesForRecord,
    reverseFor,
    activeAssertions: () => [...activeByKey.values()],
    history: () => history.slice(),
    projectOneInput,
  };
}

/**
 * Convenience: run the production projection builder once over inputs.
 */
export function materializeRecordLocationMemberships({
  loadParcelShard,
  inputs = [],
  labelFor = null,
  parcelMembershipGeneration = null,
  observedAt = null,
} = {}) {
  const builder = createRecordLocationMembershipProjection({
    loadParcelShard,
    labelFor,
    parcelMembershipGeneration,
  });
  return { builder, document: builder.project(inputs, { observedAt }) };
}

export {
  EDGE_LAYERS as RECORD_LOCATION_EDGE_LAYERS,
  PARCEL_MEMBERSHIP_LAYERS,
  isParcelEligibleAssertion,
  sourcePathFromAssertion,
};
