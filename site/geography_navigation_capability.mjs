/**
 * Resident geography navigation capability projected from the closed
 * civic-geography registry.
 *
 * This module does not invent a second registry. It names the first-slice
 * Near You layer order, resident copy, point-versus-area language, public
 * eligibility, explicit omissions, typed-relation policy, NTA subtype
 * handling, fallback behavior, and the seeded fixtures later cards consume.
 */

import {
  CIVIC_GEOGRAPHY_LAYERS,
  civicGeographyKey,
  civicGeographyLayer,
} from "./civic_geography_registry.mjs";
import {
  EXPLICITLY_UNTYPED_GEOGRAPHY,
  geographyRelationMapping,
} from "./geography_relations.mjs";

export const GEOGRAPHY_NAVIGATION_CAPABILITY_SCHEMA =
  "cityscroll.resident_geography_capability.v1";

export const GEOGRAPHY_NAVIGATION_POINT_LANGUAGE = "at_this_location";
export const GEOGRAPHY_NAVIGATION_AREA_LANGUAGE = "overlaps";

/** Closed first-slice navigation types. Order is significant. */
export const GEOGRAPHY_NAVIGATION_LAYER_TYPES = Object.freeze([
  "nta2020",
  "community_district",
  "council_district",
  "police_precinct",
]);

/**
 * Layers considered for the first slice and deliberately omitted from the
 * resident layer switcher. Absence is an explicit capability decision, never a
 * disabled option.
 */
export const GEOGRAPHY_NAVIGATION_EXPLICIT_OMISSIONS = Object.freeze({
  state_assembly:
    "State Assembly districts are out of scope until an independently versioned source, resident meaning, and useful record or representation destination exist.",
  state_senate:
    "State Senate districts are out of scope until an independently versioned source, resident meaning, and useful record or representation destination exist.",
  sanitation_district:
    "Sanitation districts remain ingested for QA and equivalence canaries but are not a first-slice Near You orientation layer.",
  business_improvement_district:
    "Business improvement districts remain ingested for resolver and QA use but are not a first-slice Near You orientation layer.",
  borough:
    "Borough remains available as an administrative partition for scopes that already use it; it is not a first-slice layer-switcher choice beside Neighborhoods.",
});

const LAYER_COPY = Object.freeze({
  nta2020: Object.freeze({
    type: "nta2020",
    primary_label: "Neighborhoods",
    group: "primary",
    detail_label: "NYC Neighborhood Tabulation Area (NTA 2020).",
    selection_noun: "neighborhood",
    comparison_noun: "neighborhoods",
    default_selected: true,
  }),
  community_district: Object.freeze({
    type: "community_district",
    primary_label: "Community districts",
    group: "primary",
    detail_label: "NYC Community District.",
    selection_noun: "community district",
    comparison_noun: "community districts",
    default_selected: false,
  }),
  council_district: Object.freeze({
    type: "council_district",
    primary_label: "Council districts",
    group: "primary",
    detail_label: "NYC City Council District.",
    selection_noun: "Council district",
    comparison_noun: "Council districts",
    default_selected: false,
  }),
  police_precinct: Object.freeze({
    type: "police_precinct",
    primary_label: "Precincts",
    group: "more_boundaries",
    detail_label: "NYPD Police Precinct.",
    selection_noun: "police precinct",
    comparison_noun: "police precincts",
    default_selected: false,
  }),
});

const NTA_SUBTYPES = Object.freeze(
  civicGeographyLayer("nta2020")?.subtypes?.allowed
    ? [...civicGeographyLayer("nta2020").subtypes.allowed]
    : ["residential", "rikers_island", "special_use", "cemetery", "airport", "park"],
);

export const GEOGRAPHY_NAVIGATION_NTA_RESIDENTIAL_SUBTYPE = "residential";
export const GEOGRAPHY_NAVIGATION_NTA_SPECIAL_SUBTYPES = Object.freeze(
  NTA_SUBTYPES.filter((subtype) => subtype !== GEOGRAPHY_NAVIGATION_NTA_RESIDENTIAL_SUBTYPE),
);

/**
 * Seeded point-membership fixtures verified against committed full-fidelity
 * layers. Coordinates are [longitude, latitude].
 */
export const GEOGRAPHY_NAVIGATION_POINT_BUNDLES = Object.freeze([
  Object.freeze({
    id: "sheepshead-bay-station",
    label: "Sheepshead Bay station",
    coordinates: Object.freeze([-73.9542, 40.5869]),
    membership: Object.freeze({
      nta2020: Object.freeze({
        id: "BK1503",
        label: "Sheepshead Bay-Manhattan Beach-Gerritsen Beach",
        boundary_vintage: "26B",
        subtype: "residential",
      }),
      community_district: Object.freeze({
        id: "K15",
        label: "Brooklyn Community District 15",
        boundary_vintage: "2026-05-26",
      }),
      council_district: Object.freeze({
        id: "48",
        label: "City Council District 48",
        boundary_vintage: "2026-05-26",
      }),
      police_precinct: Object.freeze({
        id: "61",
        label: "Police Precinct 61",
        boundary_vintage: "26B",
      }),
    }),
  }),
  Object.freeze({
    id: "new-york-city-hall",
    label: "New York City Hall",
    coordinates: Object.freeze([-74.0060, 40.7128]),
    membership: Object.freeze({
      nta2020: Object.freeze({
        id: "MN0102",
        label: "Tribeca-Civic Center",
        boundary_vintage: "26B",
        subtype: "residential",
      }),
      community_district: Object.freeze({
        id: "M01",
        label: "Manhattan Community District 1",
        boundary_vintage: "2026-05-26",
      }),
      council_district: Object.freeze({
        id: "1",
        label: "City Council District 1",
        boundary_vintage: "2026-05-26",
      }),
      police_precinct: Object.freeze({
        id: "1",
        label: "Police Precinct 1",
        boundary_vintage: "26B",
      }),
    }),
  }),
]);

/**
 * Seeded direct area-overlap fixture for geography:nta2020:BK1503. Percentages
 * are of the selected NTA under full-fidelity EPSG:2263 overlay. Materiality
 * for primary navigation is pct_from >= 0.1; smaller retained rows stay
 * inspectable in source detail.
 */
export const GEOGRAPHY_NAVIGATION_AREA_OVERLAP_EXAMPLE = Object.freeze({
  selected: Object.freeze({
    type: "nta2020",
    id: "BK1503",
    key: "geography:nta2020:BK1503",
    label: "Sheepshead Bay-Manhattan Beach-Gerritsen Beach",
    boundary_vintage: "26B",
  }),
  method: "direct_polygon_intersection",
  projection: "EPSG:2263",
  materiality_rule: Object.freeze({
    field: "pct_from",
    minimum_for_navigation: 0.1,
  }),
  relations: Object.freeze([
    Object.freeze({
      type: "council_district",
      id: "46",
      label: "City Council District 46",
      boundary_vintage: "2026-05-26",
      relation: "intersects",
      pct_from: 31.008101,
      material_for_navigation: true,
      display_pct: "31.0%",
    }),
    Object.freeze({
      type: "council_district",
      id: "48",
      label: "City Council District 48",
      boundary_vintage: "2026-05-26",
      relation: "intersects",
      pct_from: 68.986772,
      material_for_navigation: true,
      display_pct: "69.0%",
    }),
    Object.freeze({
      type: "community_district",
      id: "K15",
      label: "Brooklyn Community District 15",
      boundary_vintage: "2026-05-26",
      relation: "intersects",
      pct_from: 99.994497,
      material_for_navigation: true,
      display_pct: "~100%",
    }),
    Object.freeze({
      type: "community_district",
      id: "K13",
      label: "Brooklyn Community District 13",
      boundary_vintage: "2026-05-26",
      relation: "intersects",
      pct_from: 0.000327,
      material_for_navigation: false,
      display_pct: null,
    }),
    Object.freeze({
      type: "community_district",
      id: "K18",
      label: "Brooklyn Community District 18",
      boundary_vintage: "2026-05-26",
      relation: "below_threshold",
      pct_from: 0.000049,
      area_sq_ft: 30.874,
      material_for_navigation: false,
      display_pct: null,
    }),
    Object.freeze({
      type: "police_precinct",
      id: "61",
      label: "Police Precinct 61",
      boundary_vintage: "26B",
      relation: "intersects",
      pct_from: 99.999991,
      material_for_navigation: true,
      display_pct: "~100%",
    }),
    Object.freeze({
      type: "police_precinct",
      id: "60",
      label: "Police Precinct 60",
      boundary_vintage: "26B",
      relation: "below_threshold",
      pct_from: 0,
      area_sq_ft: 0.004,
      material_for_navigation: false,
      display_pct: null,
    }),
  ]),
});

function requireRegisteredNavigationType(type) {
  const definition = civicGeographyLayer(type);
  if (!definition) {
    throw new TypeError(`geography_navigation_capability: unknown geography layer "${type}"`);
  }
  if (!GEOGRAPHY_NAVIGATION_LAYER_TYPES.includes(type)) {
    throw new TypeError(`geography_navigation_capability: "${type}" is not a first-slice navigation layer`);
  }
  return definition;
}

for (const type of GEOGRAPHY_NAVIGATION_LAYER_TYPES) {
  requireRegisteredNavigationType(type);
}

function typedRelationPolicy(type) {
  const mapping = geographyRelationMapping(type);
  if (mapping) {
    return Object.freeze({
      status: "typed",
      predicate: mapping.predicate,
      institutional_basis: mapping.institutional_basis,
    });
  }
  const untypedReason = EXPLICITLY_UNTYPED_GEOGRAPHY[type] || null;
  return Object.freeze({
    status: "explicitly_untyped",
    predicate: null,
    reason: untypedReason,
  });
}

function layerCapability(type) {
  const definition = requireRegisteredNavigationType(type);
  const copy = LAYER_COPY[type];
  return Object.freeze({
    type,
    class: definition.class,
    namespace: definition.namespace,
    primary_label: copy.primary_label,
    group: copy.group,
    detail_label: copy.detail_label,
    selection_noun: copy.selection_noun,
    comparison_noun: copy.comparison_noun,
    default_selected: copy.default_selected,
    source: Object.freeze({ ...definition.source }),
    typed_relation: typedRelationPolicy(type),
    ...(definition.subtypes ? {
      subtypes: Object.freeze({
        required: definition.subtypes.required,
        allowed: Object.freeze([...definition.subtypes.allowed]),
        residential: GEOGRAPHY_NAVIGATION_NTA_RESIDENTIAL_SUBTYPE,
        special: GEOGRAPHY_NAVIGATION_NTA_SPECIAL_SUBTYPES,
      }),
    } : {}),
  });
}

const NAVIGATION_LAYERS = Object.freeze(
  GEOGRAPHY_NAVIGATION_LAYER_TYPES.map((type) => layerCapability(type)),
);

/**
 * Whether an NTA subtype may be casually labeled as someone's neighborhood.
 * Only the residential subtype may; parks, cemeteries, airports, Rikers, and
 * other special statistical areas stay named as special areas.
 */
export function isResidentialNeighborhoodSubtype(subtype) {
  return String(subtype || "") === GEOGRAPHY_NAVIGATION_NTA_RESIDENTIAL_SUBTYPE;
}

/** Resident-facing label policy for an NTA feature subtype. */
export function ntaResidentLabelPolicy(subtype) {
  const value = String(subtype || "").trim();
  if (!value) {
    return Object.freeze({
      subtype: null,
      may_label_as_neighborhood: false,
      reason: "NTA subtype is required before a neighborhood label is offered.",
    });
  }
  if (!NTA_SUBTYPES.includes(value)) {
    return Object.freeze({
      subtype: value,
      may_label_as_neighborhood: false,
      reason: "Unknown NTA subtype is not treated as a residential neighborhood.",
    });
  }
  if (isResidentialNeighborhoodSubtype(value)) {
    return Object.freeze({
      subtype: value,
      may_label_as_neighborhood: true,
      reason: "Residential NTA 2020 areas may use the Neighborhoods primary label while details keep the statistical qualifier.",
    });
  }
  return Object.freeze({
    subtype: value,
    may_label_as_neighborhood: false,
    reason: "Special-use NTA areas (parks, cemeteries, airports, and other non-residential statistical areas) are named as special areas, not as someone's neighborhood.",
  });
}

/** Lookup one first-slice navigation layer, or null. */
export function geographyNavigationLayer(type) {
  return NAVIGATION_LAYERS.find((layer) => layer.type === String(type || "")) || null;
}

/** Primary layer-switcher choices in declared order. */
export function geographyNavigationPrimaryLayers() {
  return Object.freeze(NAVIGATION_LAYERS.filter((layer) => layer.group === "primary"));
}

/** Layers under More boundaries. */
export function geographyNavigationMoreBoundaryLayers() {
  return Object.freeze(NAVIGATION_LAYERS.filter((layer) => layer.group === "more_boundaries"));
}

/**
 * Resolve a public navigation key. Unknown or malformed keys recover to the
 * unselected navigator with an explanation rather than inventing a selection.
 */
export function resolveGeographyNavigationKey(rawKey) {
  const text = String(rawKey || "").trim();
  if (!text) {
    return Object.freeze({
      ok: false,
      key: null,
      type: null,
      id: null,
      reason: "missing_geography_key",
      explanation: "No geography is selected.",
    });
  }
  const match = /^geography:([a-z0-9_]+):(.+)$/.exec(text)
    || /^([a-z0-9_]+):(.+)$/.exec(text);
  if (!match) {
    return Object.freeze({
      ok: false,
      key: text,
      type: null,
      id: null,
      reason: "malformed_geography_key",
      explanation: "That geography key is not recognized, so the navigator stays unselected.",
    });
  }
  const type = match[1];
  const id = match[2];
  if (!geographyNavigationLayer(type)) {
    return Object.freeze({
      ok: false,
      key: text,
      type,
      id,
      reason: "layer_not_in_first_slice",
      explanation: "That geography layer is not part of the resident navigation switcher.",
    });
  }
  const canonical = civicGeographyKey(type, id);
  if (!canonical) {
    return Object.freeze({
      ok: false,
      key: text,
      type,
      id,
      reason: "invalid_geography_id",
      explanation: "That geography id is not valid for its layer, so the navigator stays unselected.",
    });
  }
  return Object.freeze({
    ok: true,
    key: canonical,
    type,
    id,
    reason: null,
    explanation: null,
  });
}

/**
 * Contract statements later UI and tests share. Point membership is resolved
 * independently per layer; area relationships are direct polygon intersections
 * and never inferred through an NTA → community district → Council chain.
 */
export const GEOGRAPHY_NAVIGATION_RELATION_RULES = Object.freeze({
  point_membership: Object.freeze({
    method: "independent_per_layer_point_in_polygon",
    language: GEOGRAPHY_NAVIGATION_POINT_LANGUAGE,
    resident_phrase: "At this location",
    prohibits: Object.freeze([
      "derive_council_from_nta_via_community_district",
      "derive_any_layer_from_another_layer",
    ]),
  }),
  area_relationship: Object.freeze({
    method: "direct_polygon_intersection",
    language: GEOGRAPHY_NAVIGATION_AREA_LANGUAGE,
    resident_phrase: "This neighborhood overlaps",
    prohibits: Object.freeze([
      "nta_to_community_district_to_council_inference",
      "centroid_or_dominant_district_shortcut",
    ]),
  }),
  selection_versus_comparison: Object.freeze({
    selection_persists_when_comparison_changes: true,
    comparison_does_not_replace_selected_outline: true,
  }),
});

/** Full capability record projected for consumers. */
export function projectGeographyNavigationCapability() {
  const registeredTypes = new Set(CIVIC_GEOGRAPHY_LAYERS.map((layer) => layer.type));
  for (const type of GEOGRAPHY_NAVIGATION_LAYER_TYPES) {
    if (!registeredTypes.has(type)) {
      throw new TypeError(`geography_navigation_capability: missing registry layer "${type}"`);
    }
  }
  return Object.freeze({
    schema: GEOGRAPHY_NAVIGATION_CAPABILITY_SCHEMA,
    layers: NAVIGATION_LAYERS,
    primary_layers: geographyNavigationPrimaryLayers(),
    more_boundaries: geographyNavigationMoreBoundaryLayers(),
    default_layer_type: "nta2020",
    relation_rules: GEOGRAPHY_NAVIGATION_RELATION_RULES,
    explicit_omissions: GEOGRAPHY_NAVIGATION_EXPLICIT_OMISSIONS,
    nta_subtypes: Object.freeze({
      allowed: Object.freeze([...NTA_SUBTYPES]),
      residential: GEOGRAPHY_NAVIGATION_NTA_RESIDENTIAL_SUBTYPE,
      special: GEOGRAPHY_NAVIGATION_NTA_SPECIAL_SUBTYPES,
    }),
    point_fixtures: GEOGRAPHY_NAVIGATION_POINT_BUNDLES,
    area_overlap_fixture: GEOGRAPHY_NAVIGATION_AREA_OVERLAP_EXAMPLE,
    licensing: Object.freeze({
      repository: "MIT",
      betanyc_source_css_assets_tokens_or_runtime: false,
    }),
  });
}
