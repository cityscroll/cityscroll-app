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
];

export const CIVIC_GEOGRAPHY_LAYERS = Object.freeze(definitions.map((definition) => Object.freeze({
  ...definition,
  canonical_id: Object.freeze({ ...definition.canonical_id }),
  label: Object.freeze({ ...definition.label }),
  source: Object.freeze({ ...definition.source }),
  coverage: Object.freeze({ ...definition.coverage }),
  freshness: Object.freeze({ ...definition.freshness }),
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
