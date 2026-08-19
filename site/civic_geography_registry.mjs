// Closed control-plane registry for civic-geography layers. Geometry and its
// independently versioned clock live in per-layer artifacts; this registry
// declares type semantics and source adapters only.

export const GEOGRAPHY_LAYER_REGISTRY_SCHEMA = "cityscroll.geography_layer_registry.v1";
export const GEOGRAPHY_LAYER_SCHEMA = "cityscroll.geography_layer.v1";
export const GEOGRAPHY_MATCHES_SCHEMA = "cityscroll.geography_matches.v1";

const definitions = [
  {
    type: "borough",
    class: "administrative",
    namespace: "nyc-dcp:borough",
    canonical_id: { source_field: "boro_code", pattern: "^[1-5]$" },
    label: { source_field: "boro_name", template: "{label}" },
    source: {
      contract_id: "community-district-boundaries",
      publisher: "NYC Department of City Planning",
      dataset_id: "5crt-au7u",
      url: "https://data.cityofnewyork.us/d/5crt-au7u",
      derivation: "borough_code_partition_from_community_district_boundaries",
    },
    source_adapter: "nyc_open_data_community_district_borough_v1",
    cardinality: "exactly_one_on_covered_land",
    coverage: { expected_feature_count: 5, comparison: "exact" },
    freshness: { max_stale_days: 730 },
    public_relations: ["located_in", "intersects"],
    declared_uses: ["resolver"],
  },
  {
    type: "community_district",
    class: "community_administrative",
    namespace: "nyc-dcp:community-district",
    canonical_id: { source_field: "boro_cd", pattern: "^(?:M|X|K|Q|R)\\d{2}$" },
    label: { source_field: "boro_cd", template: "{borough} Community District {number}" },
    source: {
      contract_id: "community-district-boundaries",
      publisher: "NYC Department of City Planning",
      dataset_id: "5crt-au7u",
      url: "https://data.cityofnewyork.us/d/5crt-au7u",
    },
    source_adapter: "nyc_open_data_community_district_v1",
    cardinality: "exactly_one_regular_or_special_area_on_covered_land",
    coverage: { expected_feature_count: 59, comparison: "at_least" },
    freshness: { max_stale_days: 730 },
    public_relations: ["located_in", "intersects"],
    declared_uses: ["resolver", "compatibility_projection"],
  },
  {
    type: "council_district",
    class: "political",
    namespace: "nyc-dcp:city-council-district",
    canonical_id: { source_field: "coundist", pattern: "^(?:[1-9]|[1-4]\\d|5[01])$" },
    label: { source_field: "coundist", template: "City Council District {id}" },
    source: {
      contract_id: "city-council-district-boundaries",
      publisher: "NYC Department of City Planning",
      dataset_id: "872g-cjhh",
      url: "https://data.cityofnewyork.us/d/872g-cjhh",
    },
    source_adapter: "nyc_open_data_council_district_v1",
    cardinality: "exactly_one_on_covered_land",
    coverage: { expected_feature_count: 51, comparison: "exact" },
    freshness: { max_stale_days: 730 },
    public_relations: ["located_in", "intersects"],
    declared_uses: ["resolver", "compatibility_projection"],
  },
  {
    type: "nta2020",
    class: "statistical",
    namespace: "nyc-dcp:nta2020",
    canonical_id: { source_field: "NTA2020", pattern: "^(?:BK|BX|MN|QN|SI)\\d{4}$" },
    label: { source_field: "NTAName", template: "{label}" },
    source: {
      contract_id: "dcp-nta2020-boundaries",
      publisher: "NYC Department of City Planning",
      dataset_id: "nynta2020_26b",
      url: "https://www.nyc.gov/content/planning/pages/resources/datasets/neighborhood-tabulation",
    },
    source_adapter: "dcp_bytes_nta2020_v1",
    cardinality: "exactly_one_on_covered_land_including_typed_special_areas",
    subtypes: {
      required: true,
      allowed: ["residential", "rikers_island", "special_use", "cemetery", "airport", "park"],
    },
    coverage: { expected_feature_count: 262, comparison: "exact" },
    freshness: { max_stale_days: 180 },
    public_relations: [],
    declared_uses: ["ingestion", "resolver", "qa"],
  },
  {
    type: "police_precinct",
    class: "service_administrative",
    namespace: "nyc-dcp:police-precinct",
    canonical_id: { source_field: "Precinct", pattern: "^(?:[1-9]|[1-9]\\d|1[01]\\d|12[0-3])$" },
    label: { source_field: "Precinct", template: "Police Precinct {id}" },
    source: {
      contract_id: "dcp-police-precinct-boundaries",
      publisher: "NYC Department of City Planning",
      dataset_id: "nypp_26b",
      url: "https://www.nyc.gov/content/planning/pages/resources/datasets/police-precincts",
    },
    source_adapter: "dcp_bytes_police_precinct_v1",
    cardinality: "exactly_one_on_covered_land",
    coverage: { expected_feature_count: 78, comparison: "exact" },
    freshness: { max_stale_days: 180 },
    public_relations: [],
    declared_uses: ["ingestion", "resolver", "native_join", "qa"],
  },
  {
    type: "sanitation_district",
    class: "service_administrative",
    namespace: "nyc-dsny:sanitation-district",
    canonical_id: { source_field: "districtcode", pattern: "^[1-5](?:0[1-9]|1[0-8])$" },
    label: { source_field: "district", template: "{label}" },
    source: {
      contract_id: "dsny-district-boundaries",
      publisher: "NYC Department of Sanitation",
      dataset_id: "i6mn-amj2",
      url: "https://data.cityofnewyork.us/d/i6mn-amj2",
    },
    source_adapter: "nyc_open_data_dsny_district_v1",
    cardinality: "exactly_one_on_covered_land",
    coverage: { expected_feature_count: 59, comparison: "exact" },
    freshness: { max_stale_days: 730 },
    public_relations: [],
    declared_uses: ["ingestion", "resolver", "community_district_equivalence_canary", "qa"],
  },
  {
    type: "business_improvement_district",
    class: "economic_institutional",
    namespace: "nyc-sbs:business-improvement-district",
    canonical_id: { source_field: "reviewed_slug", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
    label: { source_field: "f_all_bi_2", template: "{label}" },
    source: {
      contract_id: "business-improvement-district-boundaries",
      publisher: "NYC Department of Small Business Services",
      dataset_id: "7jdm-inj8",
      url: "https://data.cityofnewyork.us/d/7jdm-inj8",
    },
    source_adapter: "nyc_open_data_bid_reviewed_slug_v1",
    cardinality: "zero_or_more_overlaps_allowed",
    coverage: { expected_feature_count: 74, comparison: "exact" },
    freshness: { max_stale_days: 730 },
    public_relations: [],
    declared_uses: ["ingestion", "resolver", "qa"],
  },
];

export const CIVIC_GEOGRAPHY_LAYERS = Object.freeze(definitions.map((definition) => Object.freeze({
  ...definition,
  canonical_id: Object.freeze({ ...definition.canonical_id }),
  label: Object.freeze({ ...definition.label }),
  source: Object.freeze({ ...definition.source }),
  coverage: Object.freeze({ ...definition.coverage }),
  freshness: Object.freeze({ ...definition.freshness }),
  ...(definition.subtypes ? {
    subtypes: Object.freeze({
      ...definition.subtypes,
      allowed: Object.freeze([...definition.subtypes.allowed]),
    }),
  } : {}),
  public_relations: Object.freeze([...definition.public_relations]),
  declared_uses: Object.freeze([...definition.declared_uses]),
})));

const BY_TYPE = new Map(CIVIC_GEOGRAPHY_LAYERS.map((definition) => [definition.type, definition]));

export function civicGeographyLayer(type) {
  return BY_TYPE.get(String(type || "")) || null;
}

export function civicGeographyKey(type, id) {
  const definition = civicGeographyLayer(type);
  const value = String(id ?? "").trim();
  if (!definition || !new RegExp(definition.canonical_id.pattern).test(value)) return null;
  return `geography:${definition.type}:${value}`;
}

export function validateCivicGeographyRegistry(registry = {}) {
  const errors = [];
  if (registry.schema !== GEOGRAPHY_LAYER_REGISTRY_SCHEMA) errors.push("registry schema mismatch");
  const layers = Array.isArray(registry.layers) ? registry.layers : [];
  const seen = new Set();
  for (const layer of layers) {
    const definition = civicGeographyLayer(layer?.type);
    if (!definition) {
      errors.push(`unknown geography layer ${String(layer?.type || "(missing)")}`);
      continue;
    }
    if (seen.has(layer.type)) errors.push(`duplicate geography layer ${layer.type}`);
    seen.add(layer.type);
    if (layer.class !== definition.class) errors.push(`${layer.type}: class mismatch`);
    if (!layer.boundary_vintage) errors.push(`${layer.type}: missing boundary_vintage`);
    if (!layer.source?.contract_id || !layer.source?.dataset_id) {
      errors.push(`${layer.type}: missing source identity`);
    }
    if (!layer.artifacts?.full?.path || !layer.artifacts?.simplified?.site_path) {
      errors.push(`${layer.type}: missing versioned artifact paths`);
    }
  }
  for (const definition of CIVIC_GEOGRAPHY_LAYERS) {
    if (!seen.has(definition.type)) errors.push(`missing geography layer ${definition.type}`);
  }
  return errors.sort();
}
