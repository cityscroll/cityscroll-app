/**
 * Typed contractual place assertions for procurement.
 *
 * The procurement layer owns place meaning (facility, work, delivery, service,
 * beneficiary). The existing geography spine owns address resolution, versioned
 * boundaries, crosswalks, and geography_items membership. Vendor addresses may
 * be retained for entity identity but never become service geography or Near You
 * local counts. Point containment may say a site is located in a geography;
 * polygon overlap alone never manufactures serves, represents, or affects.
 */

import { civicGeographyKey } from "./civic_geography_registry.mjs";
import {
  matchGeographyPlaceLabels,
  resolveGeographyEntryFromAddress,
  resolveGeographyEntryFromPoint,
} from "./geography_navigation_entry.mjs";
import { GEOGRAPHY_NAVIGATION_LAYER_TYPES } from "./geography_navigation_capability.mjs";

export const CONTRACT_SERVICE_GEOGRAPHY_SCHEMA =
  "cityscroll.procurement_contract_service_geography.v1";

export const CONTRACT_PLACE_ROLES = Object.freeze({
  FACILITY_SITE: "facility_site",
  WORK_SITE: "work_site",
  DELIVERY_SITE: "delivery_site",
  SERVICE_AREA: "service_area",
  BENEFICIARY_AREA: "beneficiary_area",
});

export const CONTRACT_PLACE_ROLE_SET = Object.freeze(new Set(Object.values(CONTRACT_PLACE_ROLES)));

/** Legacy notice-derived role; admitted only after upgrade to facility_site. */
export const LEGACY_FACILITY_SERVICE_SITE = "facility_service_site";

/** Entity-identity role that must never enter service geography. */
export const VENDOR_ADDRESS_ROLE = "vendor_address";

export const PLACE_INPUT_KINDS = Object.freeze({
  EXACT_ADDRESS: "exact_address",
  NAMED_GEOGRAPHY: "named_geography",
  GEOGRAPHY_KEY: "geography_key",
  BROAD_SCOPE: "broad_scope",
  COORDINATE: "coordinate",
});

export const BROAD_SCOPE_KINDS = Object.freeze({
  CITYWIDE: "citywide",
  BOROUGHWIDE: "boroughwide",
  MULTI_SITE: "multi_site",
});

export const RESOLUTION_STATES = Object.freeze({
  RESOLVED: "resolved",
  AMBIGUOUS: "ambiguous",
  UNRESOLVED: "unresolved",
  BROAD_SCOPE: "broad_scope",
});

export const SPATIAL_EVIDENCE_KINDS = Object.freeze({
  POINT_CONTAINMENT: "point_containment",
  POLYGON_OVERLAP: "polygon_overlap",
});

export const GEOGRAPHY_RELATIONS = Object.freeze({
  LOCATED_IN: "located_in",
});

const FORBIDDEN_OVERLAP_RELATIONS = Object.freeze([
  "serves",
  "represents",
  "affects",
  "about",
  "service_area",
]);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const GEOGRAPHY_KEY_RE = /^geography:[a-z0-9_]+:.+$/i;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clean(value, max = 500) {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

function isoDate(value) {
  return Boolean(clean(value, 10) && ISO_DATE_RE.test(String(value).trim()));
}

function isoInstant(value) {
  if (!clean(value, 64) || !ISO_INSTANT_RE.test(String(value).trim())) return false;
  return Number.isFinite(new Date(value).getTime());
}

function normalizeRole(value) {
  return clean(value, 80)?.toLowerCase().replace(/[\s-]+/g, "_") || null;
}

function normalizePlaceRole(value) {
  const role = normalizeRole(value);
  if (!role) return null;
  if (role === LEGACY_FACILITY_SERVICE_SITE) return CONTRACT_PLACE_ROLES.FACILITY_SITE;
  if (CONTRACT_PLACE_ROLE_SET.has(role)) return role;
  return null;
}

export function isContractServiceGeographyRole(role) {
  return CONTRACT_PLACE_ROLE_SET.has(normalizePlaceRole(role) || normalizeRole(role));
}

export function isVendorAddressRole(role) {
  return normalizeRole(role) === VENDOR_ADDRESS_ROLE;
}

/**
 * Point containment may justify located_in. Polygon overlap alone never yields
 * serves, represents, affects, about, or service_area.
 */
export function classifySpatialEvidence(input = {}) {
  const kind = clean(input.kind || input.evidence_kind, 40);
  if (kind === SPATIAL_EVIDENCE_KINDS.POINT_CONTAINMENT) {
    return Object.freeze({
      kind: SPATIAL_EVIDENCE_KINDS.POINT_CONTAINMENT,
      allowed_relation: GEOGRAPHY_RELATIONS.LOCATED_IN,
      may_claim_service_role: false,
      forbidden_relations: Object.freeze([...FORBIDDEN_OVERLAP_RELATIONS]),
    });
  }
  if (kind === SPATIAL_EVIDENCE_KINDS.POLYGON_OVERLAP) {
    return Object.freeze({
      kind: SPATIAL_EVIDENCE_KINDS.POLYGON_OVERLAP,
      allowed_relation: null,
      may_claim_service_role: false,
      forbidden_relations: Object.freeze([...FORBIDDEN_OVERLAP_RELATIONS]),
      refusal: "polygon_overlap_cannot_manufacture_service_or_affecting_role",
    });
  }
  return Object.freeze({
    kind: null,
    allowed_relation: null,
    may_claim_service_role: false,
    forbidden_relations: Object.freeze([...FORBIDDEN_OVERLAP_RELATIONS]),
    refusal: "unknown_spatial_evidence_kind",
  });
}

function citationFromCandidate(candidate = {}) {
  const sourceDocumentId = clean(
    candidate.source_document_id || candidate.document_id || candidate.request_id,
    180,
  );
  const locator = clean(candidate.locator || candidate.page_section_locator, 240);
  const effectivePeriod = isRecord(candidate.effective_period)
    ? {
      start: clean(candidate.effective_period.start, 40),
      end: clean(candidate.effective_period.end, 40),
    }
    : null;
  const noticeId = clean(candidate.notice_id || candidate.request_id, 80);
  return {
    source_document_id: sourceDocumentId,
    locator,
    effective_period: effectivePeriod
      && (isoDate(effectivePeriod.start) || isoInstant(effectivePeriod.start) || !effectivePeriod.start)
      && (isoDate(effectivePeriod.end) || isoInstant(effectivePeriod.end) || !effectivePeriod.end)
      ? {
        start: effectivePeriod.start || null,
        end: effectivePeriod.end || null,
      }
      : null,
    notice_id: noticeId,
    notice_href: clean(candidate.notice_href, 300)
      || (noticeId ? `/notices/${encodeURIComponent(noticeId)}` : null),
    source_observation_ref: clean(candidate.source_observation_ref, 200)
      || (noticeId ? `city_record:${noticeId}` : null),
    attribution_label: clean(candidate.attribution_label, 160)
      || (noticeId ? `Notice ${noticeId}` : null),
  };
}

function placeInputFromCandidate(candidate = {}) {
  const inputKind = clean(candidate.input_kind || candidate.place_input_kind, 40);
  if (inputKind === PLACE_INPUT_KINDS.BROAD_SCOPE || candidate.broad_scope || candidate.scope_kind) {
    const scopeKind = clean(candidate.scope_kind || candidate.broad_scope, 40);
    return {
      input_kind: PLACE_INPUT_KINDS.BROAD_SCOPE,
      scope_kind: Object.values(BROAD_SCOPE_KINDS).includes(scopeKind) ? scopeKind : null,
      label: clean(candidate.label || candidate.scope_label, 200),
      site_labels: Array.isArray(candidate.site_labels)
        ? candidate.site_labels.map((value) => clean(value, 200)).filter(Boolean)
        : [],
    };
  }
  if (inputKind === PLACE_INPUT_KINDS.GEOGRAPHY_KEY || candidate.geography_key) {
    const key = clean(candidate.geography_key, 120);
    return {
      input_kind: PLACE_INPUT_KINDS.GEOGRAPHY_KEY,
      geography_key: key && GEOGRAPHY_KEY_RE.test(key) ? key : null,
      label: clean(candidate.label, 200),
    };
  }
  if (inputKind === PLACE_INPUT_KINDS.NAMED_GEOGRAPHY || candidate.named_geography || candidate.geography_name) {
    return {
      input_kind: PLACE_INPUT_KINDS.NAMED_GEOGRAPHY,
      name: clean(candidate.named_geography || candidate.geography_name || candidate.label, 200),
      geography_type: clean(candidate.geography_type, 40),
    };
  }
  if (
    inputKind === PLACE_INPUT_KINDS.COORDINATE
    || (Number.isFinite(Number(candidate.lon)) && Number.isFinite(Number(candidate.lat)))
  ) {
    return {
      input_kind: PLACE_INPUT_KINDS.COORDINATE,
      lon: Number(candidate.lon),
      lat: Number(candidate.lat),
      label: clean(candidate.label || candidate.address, 200),
    };
  }
  return {
    input_kind: PLACE_INPUT_KINDS.EXACT_ADDRESS,
    address: clean(candidate.address || candidate.street_address, 240),
    units: Number.isFinite(Number(candidate.units)) ? Number(candidate.units) : null,
  };
}

function admissionRefusalReasons(candidate = {}) {
  const reasons = [];
  const rawRole = normalizeRole(candidate.place_role || candidate.evidence_role || candidate.role);
  if (rawRole === VENDOR_ADDRESS_ROLE) {
    reasons.push("vendor_address_is_not_service_geography");
  }
  const placeRole = normalizePlaceRole(rawRole);
  if (!placeRole) reasons.push("missing_or_unknown_place_role");
  if (!clean(candidate.contract_id, 160)) reasons.push("missing_contract_identity");

  const citation = citationFromCandidate(candidate);
  if (!citation.source_document_id) reasons.push("missing_source_document_identity");
  if (!citation.locator && !citation.notice_id) reasons.push("missing_page_section_or_notice_locator");

  const placeInput = placeInputFromCandidate(candidate);
  if (placeInput.input_kind === PLACE_INPUT_KINDS.EXACT_ADDRESS && !placeInput.address) {
    reasons.push("missing_exact_address");
  }
  if (placeInput.input_kind === PLACE_INPUT_KINDS.NAMED_GEOGRAPHY && !placeInput.name) {
    reasons.push("missing_named_geography");
  }
  if (placeInput.input_kind === PLACE_INPUT_KINDS.GEOGRAPHY_KEY && !placeInput.geography_key) {
    reasons.push("missing_or_invalid_geography_key");
  }
  if (placeInput.input_kind === PLACE_INPUT_KINDS.BROAD_SCOPE && !placeInput.scope_kind) {
    reasons.push("missing_broad_scope_kind");
  }
  if (
    placeInput.input_kind === PLACE_INPUT_KINDS.COORDINATE
    && (!Number.isFinite(placeInput.lon) || !Number.isFinite(placeInput.lat))
  ) {
    reasons.push("missing_or_invalid_coordinates");
  }

  const overlapClaim = normalizeRole(candidate.claimed_relation || candidate.overlap_relation);
  if (overlapClaim && FORBIDDEN_OVERLAP_RELATIONS.includes(overlapClaim)) {
    const spatial = classifySpatialEvidence({
      kind: candidate.spatial_evidence_kind || SPATIAL_EVIDENCE_KINDS.POLYGON_OVERLAP,
    });
    if (spatial.kind === SPATIAL_EVIDENCE_KINDS.POLYGON_OVERLAP) {
      reasons.push("polygon_overlap_cannot_claim_" + overlapClaim);
    }
  }

  return { reasons, placeRole, citation, placeInput, rawRole };
}

/**
 * Admit a typed contractual place assertion, or refuse with reasons.
 * vendor_address candidates are always refused as service geography.
 */
export function admitContractPlaceAssertion(candidate = {}) {
  const { reasons, placeRole, citation, placeInput, rawRole } = admissionRefusalReasons(candidate);
  if (reasons.length) {
    return Object.freeze({
      ok: false,
      assertion: null,
      reasons: Object.freeze(reasons),
      identity_only: rawRole === VENDOR_ADDRESS_ROLE
        ? Object.freeze({
          role: VENDOR_ADDRESS_ROLE,
          contract_id: clean(candidate.contract_id, 160),
          address: clean(candidate.address, 240),
        })
        : null,
    });
  }

  const units = placeInput.units;
  return Object.freeze({
    ok: true,
    reasons: Object.freeze([]),
    identity_only: null,
    assertion: Object.freeze({
      schema: CONTRACT_SERVICE_GEOGRAPHY_SCHEMA,
      contract_id: clean(candidate.contract_id, 160).toUpperCase(),
      place_role: placeRole,
      input: Object.freeze({
        ...placeInput,
        site_labels: placeInput.site_labels ? Object.freeze([...placeInput.site_labels]) : undefined,
      }),
      citation: Object.freeze({
        ...citation,
        effective_period: citation.effective_period
          ? Object.freeze({ ...citation.effective_period })
          : null,
      }),
      units: Number.isFinite(units) ? units : null,
      legacy_role: rawRole === LEGACY_FACILITY_SERVICE_SITE ? LEGACY_FACILITY_SERVICE_SITE : null,
    }),
  });
}

/**
 * Upgrade a notice-derived place-facts row into a facility_site assertion.
 */
export function facilitySiteFromNoticePlaceFact(placeFact = {}, { contractId } = {}) {
  return admitContractPlaceAssertion({
    contract_id: contractId || placeFact.contract_id,
    place_role: placeFact.evidence_role || LEGACY_FACILITY_SERVICE_SITE,
    address: placeFact.address,
    units: placeFact.units,
    request_id: placeFact.request_id,
    notice_id: placeFact.request_id,
    notice_href: placeFact.notice_href,
    attribution_label: placeFact.attribution_label,
    source_observation_ref: placeFact.source_observation_ref,
    source_document_id: placeFact.source_observation_ref || placeFact.request_id,
    locator: placeFact.locator || `notice ${placeFact.request_id} facility description`,
    input_kind: PLACE_INPUT_KINDS.EXACT_ADDRESS,
  });
}

function geographyMatchFromEntry(match, {
  relation = GEOGRAPHY_RELATIONS.LOCATED_IN,
  method = null,
} = {}) {
  if (!isRecord(match)) return null;
  const type = clean(match.type, 40);
  const id = clean(match.id, 80);
  const key = clean(match.key, 120) || civicGeographyKey(type, id);
  if (!key) return null;
  return Object.freeze({
    key,
    type,
    id,
    label: clean(match.label, 200),
    class: clean(match.class, 40),
    relation,
    method: clean(method || match.method, 80),
    source_id: clean(match.source_id, 120),
    boundary_vintage: clean(match.boundary_vintage, 40),
    subtype: clean(match.subtype, 40),
  });
}

function matchesFromEntryResult(entryResult, { method = null } = {}) {
  if (!entryResult?.ok) return [];
  const byType = entryResult.bundle?.by_type || {};
  const out = [];
  for (const type of GEOGRAPHY_NAVIGATION_LAYER_TYPES) {
    for (const match of byType[type] || []) {
      const projected = geographyMatchFromEntry(match, {
        relation: GEOGRAPHY_RELATIONS.LOCATED_IN,
        method: method || match.method || "point_in_polygon",
      });
      if (projected) out.push(projected);
    }
  }
  if (entryResult.selected) {
    const selected = geographyMatchFromEntry(entryResult.selected, {
      relation: GEOGRAPHY_RELATIONS.LOCATED_IN,
      method: method || "resident_geography_entry",
    });
    if (selected && !out.some((row) => row.key === selected.key)) out.unshift(selected);
  }
  return out;
}

function parseGeographyKey(key) {
  const text = clean(key, 120);
  if (!text || !GEOGRAPHY_KEY_RE.test(text)) return null;
  const parts = text.split(":");
  if (parts.length < 3) return null;
  return { type: parts[1], id: parts.slice(2).join(":") };
}

/**
 * Resolve an admitted assertion through the geography spine.
 * Exact addresses use the entry resolver; named areas use label/registry match;
 * ambiguous matches retain candidates without resident acceptance.
 */
export function resolveContractPlaceAssertion(assertion, {
  layerData = null,
  geocode = null,
  expectedBoundaryVintage = null,
  crosswalkRows = [],
} = {}) {
  if (!isRecord(assertion) || !CONTRACT_PLACE_ROLE_SET.has(assertion.place_role)) {
    return Object.freeze({
      ok: false,
      state: RESOLUTION_STATES.UNRESOLVED,
      geographies: Object.freeze([]),
      candidates: Object.freeze([]),
      reason: "missing_admitted_assertion",
    });
  }

  const input = assertion.input || {};
  if (input.input_kind === PLACE_INPUT_KINDS.BROAD_SCOPE) {
    return Object.freeze({
      ok: true,
      state: RESOLUTION_STATES.BROAD_SCOPE,
      scope_kind: input.scope_kind,
      site_labels: Object.freeze([...(input.site_labels || [])]),
      geographies: Object.freeze([]),
      candidates: Object.freeze([]),
      collapsed: false,
      reason: null,
    });
  }

  if (input.input_kind === PLACE_INPUT_KINDS.GEOGRAPHY_KEY) {
    const parsed = parseGeographyKey(input.geography_key);
    const match = geographyMatchFromEntry({
      key: input.geography_key,
      type: parsed?.type,
      id: parsed?.id,
      label: input.label,
      method: "explicit_geography_key",
      boundary_vintage: expectedBoundaryVintage,
    }, { method: "explicit_geography_key" });
    return Object.freeze({
      ok: Boolean(match),
      state: match ? RESOLUTION_STATES.RESOLVED : RESOLUTION_STATES.UNRESOLVED,
      geographies: Object.freeze(match ? [match] : []),
      candidates: Object.freeze([]),
      reason: match ? null : "invalid_geography_key",
    });
  }

  if (input.input_kind === PLACE_INPUT_KINDS.NAMED_GEOGRAPHY) {
    const hits = matchGeographyPlaceLabels(input.name, { layerData })
      .filter((hit) => !input.geography_type || hit.type === input.geography_type)
      .map((hit) => geographyMatchFromEntry(hit, {
        relation: GEOGRAPHY_RELATIONS.LOCATED_IN,
        method: hit.method || "canonical_label",
      }))
      .filter(Boolean);
    if (hits.length === 1) {
      const primary = hits[0];
      const linked = [];
      for (const row of Array.isArray(crosswalkRows) ? crosswalkRows : []) {
        if (row?.from_key !== primary.key) continue;
        if (row.material_for_navigation !== true) continue;
        const parsed = parseGeographyKey(row.to_key);
        const linkedMatch = geographyMatchFromEntry({
          key: row.to_key,
          type: parsed?.type || row.to_type,
          id: parsed?.id,
          method: "versioned_crosswalk",
          boundary_vintage: row.source_vintages?.to || null,
          source_id: "geography-crosswalk",
        }, {
          relation: GEOGRAPHY_RELATIONS.LOCATED_IN,
          method: "versioned_crosswalk",
        });
        if (linkedMatch) linked.push(linkedMatch);
      }
      return Object.freeze({
        ok: true,
        state: RESOLUTION_STATES.RESOLVED,
        geographies: Object.freeze([primary, ...linked]),
        candidates: Object.freeze([]),
        reason: null,
      });
    }
    if (hits.length > 1) {
      return Object.freeze({
        ok: false,
        state: RESOLUTION_STATES.AMBIGUOUS,
        geographies: Object.freeze([]),
        candidates: Object.freeze(hits),
        reason: "ambiguous_named_geography",
        resident_accepted: false,
      });
    }
    return Object.freeze({
      ok: false,
      state: RESOLUTION_STATES.UNRESOLVED,
      geographies: Object.freeze([]),
      candidates: Object.freeze([]),
      reason: "named_geography_not_found",
    });
  }

  let entryResult = null;
  let method = null;
  if (input.input_kind === PLACE_INPUT_KINDS.COORDINATE) {
    entryResult = resolveGeographyEntryFromPoint(input.lon, input.lat, { layerData });
    method = "point_in_polygon";
  } else if (input.input_kind === PLACE_INPUT_KINDS.EXACT_ADDRESS) {
    const geocodeFn = typeof geocode === "function" ? geocode : () => geocode;
    let geocodeResult = null;
    try {
      geocodeResult = geocodeFn(input.address);
    } catch {
      geocodeResult = null;
    }
    if (geocodeResult && typeof geocodeResult === "object" && geocodeResult.status === "ambiguous") {
      const candidates = (Array.isArray(geocodeResult.candidates) ? geocodeResult.candidates : [])
        .map((hit) => geographyMatchFromEntry(hit, { method: "ambiguous_address_candidate" }))
        .filter(Boolean);
      return Object.freeze({
        ok: false,
        state: RESOLUTION_STATES.AMBIGUOUS,
        geographies: Object.freeze([]),
        candidates: Object.freeze(candidates),
        reason: "ambiguous_address",
        resident_accepted: false,
      });
    }
    entryResult = resolveGeographyEntryFromAddress(input.address, {
      layerData,
      geocode: () => geocodeResult,
    });
    method = "exact_address_entry_resolver";
  }

  if (!entryResult) {
    return Object.freeze({
      ok: false,
      state: RESOLUTION_STATES.UNRESOLVED,
      geographies: Object.freeze([]),
      candidates: Object.freeze([]),
      reason: "resolution_unavailable",
    });
  }

  if (entryResult.ok === false || entryResult.recovery) {
    const recoveryReason = clean(entryResult.recovery?.reason || entryResult.reason, 80);
    const candidates = (entryResult.candidates || entryResult.alternatives || entryResult.matches || [])
      .map((hit) => geographyMatchFromEntry(hit))
      .filter(Boolean);
    const ambiguous = recoveryReason === "ambiguous_place_label"
      || recoveryReason === "ambiguous_address"
      || candidates.length > 1;
    return Object.freeze({
      ok: false,
      state: ambiguous ? RESOLUTION_STATES.AMBIGUOUS : RESOLUTION_STATES.UNRESOLVED,
      geographies: Object.freeze([]),
      candidates: Object.freeze(candidates),
      reason: recoveryReason || "address_unresolved",
      resident_accepted: false,
    });
  }

  const geographies = matchesFromEntryResult(entryResult, { method });
  const vintageDrift = [];
  if (expectedBoundaryVintage) {
    for (const match of geographies) {
      if (match.boundary_vintage && match.boundary_vintage !== expectedBoundaryVintage) {
        vintageDrift.push(Object.freeze({
          key: match.key,
          observed_vintage: match.boundary_vintage,
          expected_vintage: expectedBoundaryVintage,
        }));
      }
    }
  }

  return Object.freeze({
    ok: geographies.length > 0,
    state: geographies.length ? RESOLUTION_STATES.RESOLVED : RESOLUTION_STATES.UNRESOLVED,
    geographies: Object.freeze(geographies),
    candidates: Object.freeze([]),
    vintage_drift: Object.freeze(vintageDrift),
    reason: geographies.length ? null : "no_geography_match",
    entry: Object.freeze({
      selected_key: entryResult.selected?.key || null,
      selection_policy: entryResult.selection_policy || null,
    }),
  });
}

/**
 * Store a vendor address for entity identity without emitting service geography.
 */
export function retainVendorAddressIdentity(candidate = {}) {
  const address = clean(candidate.address, 240);
  const contractId = clean(candidate.contract_id, 160)?.toUpperCase() || null;
  if (!address || !contractId) return null;
  return Object.freeze({
    role: VENDOR_ADDRESS_ROLE,
    contract_id: contractId,
    address,
    source_document_id: clean(candidate.source_document_id, 180),
    retained_for: "entity_identity",
    emits_service_geography: false,
    near_you_local_count: false,
  });
}

function emptyLensSets(lenses) {
  return Object.fromEntries(lenses.map((lens) => [lens, []]));
}

/**
 * Project resolved contractual places into a geography_items.by_key feed.
 * Only service-geography roles contribute; vendor_address never does.
 * Broad scopes do not collapse into a single centroid membership.
 */
export function projectContractPlacesIntoGeographyItems(rows = [], {
  lens = "money",
  lenses = ["land", "property", "rules", "meetings", "money"],
  builtAt = null,
} = {}) {
  const definitions = new Map();
  const byKey = new Map();
  const skipped = [];

  for (const row of Array.isArray(rows) ? rows : []) {
    const assertion = row?.assertion || (row?.kind === "vendor_address_identity" ? null : row);
    const resolution = row?.resolution || null;
    if (
      row?.kind === "vendor_address_identity"
      || row?.identity_only?.role === VENDOR_ADDRESS_ROLE
      || isVendorAddressRole(assertion?.place_role)
      || isVendorAddressRole(row?.place_role)
      || isVendorAddressRole(row?.role)
    ) {
      skipped.push({
        reason: "vendor_address_excluded_from_geography_items",
        contract_id: assertion?.contract_id || row?.identity_only?.contract_id || row?.contract_id || null,
      });
      continue;
    }
    const placeRole = normalizePlaceRole(assertion?.place_role);
    if (!placeRole) {
      skipped.push({ reason: "missing_place_role", contract_id: assertion?.contract_id || null });
      continue;
    }
    if (resolution?.state === RESOLUTION_STATES.BROAD_SCOPE) {
      skipped.push({
        reason: "broad_scope_not_collapsed_to_membership",
        contract_id: assertion.contract_id,
        scope_kind: resolution.scope_kind,
        site_labels: resolution.site_labels || [],
      });
      continue;
    }
    if (resolution?.state === RESOLUTION_STATES.AMBIGUOUS) {
      skipped.push({
        reason: "ambiguous_not_resident_accepted",
        contract_id: assertion.contract_id,
        candidate_count: resolution.candidates?.length || 0,
      });
      continue;
    }
    if (!resolution?.ok || !Array.isArray(resolution.geographies) || !resolution.geographies.length) {
      skipped.push({
        reason: "unresolved_place",
        contract_id: assertion.contract_id,
      });
      continue;
    }

    const contractId = clean(assertion.contract_id, 160);
    for (const match of resolution.geographies) {
      if (!match?.key) continue;
      if (!definitions.has(match.key)) {
        definitions.set(match.key, Object.freeze({
          key: match.key,
          type: match.type,
          id: match.id,
          label: match.label,
          class: match.class || "administrative",
          source_id: match.source_id || null,
          boundary_vintage: match.boundary_vintage || null,
        }));
      }
      if (!byKey.has(match.key)) byKey.set(match.key, emptyLensSets(lenses));
      const lensSets = byKey.get(match.key);
      if (!lensSets[lens].includes(contractId)) lensSets[lens].push(contractId);
      // Preserve place role on a parallel index so consumers need not recompute.
      if (!lensSets.place_roles) lensSets.place_roles = {};
      if (!lensSets.place_roles[contractId]) lensSets.place_roles[contractId] = [];
      if (!lensSets.place_roles[contractId].includes(placeRole)) {
        lensSets.place_roles[contractId].push(placeRole);
      }
    }
  }

  const sortedKeys = [...byKey.keys()].sort();
  return Object.freeze({
    schema: "cityscroll.geography_items.v1",
    built_at: clean(builtAt, 40),
    lenses: Object.freeze([...lenses]),
    public_types: Object.freeze([...GEOGRAPHY_NAVIGATION_LAYER_TYPES]),
    definitions: Object.freeze(Object.fromEntries(
      [...definitions.entries()].sort(([left], [right]) => left.localeCompare(right)),
    )),
    by_key: Object.freeze(Object.fromEntries(sortedKeys.map((key) => {
      const lensSets = byKey.get(key);
      const serialized = Object.fromEntries(lenses.map((name) => [
        name,
        Object.freeze([...(lensSets[name] || [])].map(String).sort()),
      ]));
      if (lensSets.place_roles) {
        serialized.place_roles = Object.freeze(
          Object.fromEntries(
            Object.entries(lensSets.place_roles)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([contractId, roles]) => [contractId, Object.freeze([...roles].sort())]),
          ),
        );
      }
      return [key, Object.freeze(serialized)];
    }))),
    skipped: Object.freeze(skipped.map((row) => Object.freeze({ ...row }))),
    note: "Contractual place membership projected from typed place roles; vendor_address and unresolved/ambiguous places are excluded.",
  });
}

export function nearYouLocalContractIds(geographyItems, geographyKey, { lens = "money" } = {}) {
  const ids = geographyItems?.by_key?.[geographyKey]?.[lens];
  return Array.isArray(ids) ? [...ids] : [];
}

export function normalizeContractPlaceRow(row = {}) {
  if (isVendorAddressRole(row.place_role || row.evidence_role || row.role)) {
    const identity = retainVendorAddressIdentity(row);
    return identity
      ? Object.freeze({ kind: "vendor_address_identity", identity_only: identity, assertion: null, resolution: null })
      : null;
  }
  const admitted = admitContractPlaceAssertion(row);
  if (!admitted.ok) return null;
  const resolution = isRecord(row.resolution)
    ? row.resolution
    : null;
  return Object.freeze({
    kind: "contract_place",
    assertion: admitted.assertion,
    resolution: resolution
      ? Object.freeze({
        ...resolution,
        geographies: Object.freeze([...(resolution.geographies || [])].map((match) => Object.freeze({ ...match }))),
        candidates: Object.freeze([...(resolution.candidates || [])].map((match) => Object.freeze({ ...match }))),
      })
      : null,
  });
}

export function buildContractServiceGeographyDocument(rows = [], {
  generatedAt = null,
  policy = null,
} = {}) {
  const normalized = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const entry = normalizeContractPlaceRow(row);
    if (entry) normalized.push(entry);
  }
  return Object.freeze({
    schema: CONTRACT_SERVICE_GEOGRAPHY_SCHEMA,
    version: 1,
    generated_at: clean(generatedAt, 40),
    policy: Object.freeze({
      vendor_address_never_service_geography: true,
      polygon_overlap_never_service_or_affecting_role: true,
      broad_scopes_not_collapsed: true,
      ambiguous_matches_not_resident_accepted: true,
      join_only_through_cited_contract_place: true,
      ...(isRecord(policy) ? policy : {}),
    }),
    rows: Object.freeze(normalized),
  });
}

export function validateContractServiceGeographyDocument(doc = {}) {
  const errors = [];
  if (doc.schema !== CONTRACT_SERVICE_GEOGRAPHY_SCHEMA) {
    errors.push("schema_mismatch");
  }
  if (doc.policy?.vendor_address_never_service_geography !== true) {
    errors.push("policy_missing_vendor_address_guard");
  }
  if (doc.policy?.polygon_overlap_never_service_or_affecting_role !== true) {
    errors.push("policy_missing_overlap_guard");
  }
  const rows = Array.isArray(doc.rows) ? doc.rows : [];
  for (const [index, row] of rows.entries()) {
    if (row.kind === "vendor_address_identity") {
      if (row.identity_only?.emits_service_geography === true) {
        errors.push(`row_${index}_vendor_address_emits_service_geography`);
      }
      continue;
    }
    if (!CONTRACT_PLACE_ROLE_SET.has(row.assertion?.place_role)) {
      errors.push(`row_${index}_missing_place_role`);
    }
    if (!row.assertion?.contract_id) errors.push(`row_${index}_missing_contract_id`);
    if (!row.assertion?.citation?.source_document_id) {
      errors.push(`row_${index}_missing_source_document`);
    }
  }
  return Object.freeze({ ok: errors.length === 0, errors: Object.freeze(errors) });
}
