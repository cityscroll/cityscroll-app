// Authoritative-source adapters for the first four geography-spine layers.
// Upstream field names, reviewed BID identity, and source rejection policy stop
// here; the generic layer builder receives only canonical features.

const NTA_SUBTYPE_BY_CODE = Object.freeze({
  "0": "residential",
  "5": "rikers_island",
  "6": "special_use",
  "7": "cemetery",
  "8": "airport",
  "9": "park",
});

function coordinatesAsMultiPolygon(geometry) {
  if (geometry?.type === "Polygon" && Array.isArray(geometry.coordinates)) {
    return [geometry.coordinates];
  }
  if (geometry?.type === "MultiPolygon" && Array.isArray(geometry.coordinates)) {
    return geometry.coordinates;
  }
  return [];
}

function requiredGeometry(feature, label) {
  const coordinates = coordinatesAsMultiPolygon(feature?.geometry);
  if (!coordinates.length) throw new Error(`${label}: missing Polygon/MultiPolygon geometry`);
  return { type: "MultiPolygon", coordinates };
}

function assertUnique(features, type) {
  const seen = new Set();
  for (const feature of features) {
    if (seen.has(feature.id)) throw new Error(`${type}: duplicate canonical id ${feature.id}`);
    seen.add(feature.id);
  }
  return features;
}

function property(properties, ...names) {
  for (const name of names) {
    if (properties?.[name] !== undefined && properties?.[name] !== null) return properties[name];
  }
  return null;
}

export function normalizeNta2020Source(geojson = {}) {
  const features = (geojson.features || []).map((feature, index) => {
    const properties = feature.properties || {};
    const id = String(property(properties, "NTA2020", "nta2020") ?? "").trim().toUpperCase();
    const label = String(property(properties, "NTAName", "ntaname") ?? "").trim();
    const subtypeCode = String(property(properties, "NTAType", "ntatype") ?? "").trim();
    const subtype = NTA_SUBTYPE_BY_CODE[subtypeCode];
    if (!/^(?:BK|BX|MN|QN|SI)\d{4}$/.test(id)) throw new Error(`nta2020 row ${index}: invalid NTA2020`);
    if (!label) throw new Error(`nta2020:${id}: missing NTAName`);
    if (!subtype) throw new Error(`nta2020:${id}: unknown NTAType ${subtypeCode || "(missing)"}`);
    return {
      id,
      label,
      subtype,
      source_properties: {
        NTA2020: id,
        NTAName: label,
        NTAType: subtypeCode,
        BoroCode: String(property(properties, "BoroCode", "borocode") ?? ""),
        CDTA2020: String(property(properties, "CDTA2020", "cdta2020") ?? ""),
      },
      geometry: requiredGeometry(feature, `nta2020:${id}`),
    };
  });
  return assertUnique(features, "nta2020").sort((left, right) => left.id.localeCompare(right.id));
}

export function normalizePolicePrecinctSource(geojson = {}) {
  const features = (geojson.features || []).map((feature, index) => {
    const raw = property(feature.properties, "Precinct", "precinct");
    const id = String(Number(raw));
    if (!/^(?:[1-9]|[1-9]\d|1[01]\d|12[0-3])$/.test(id)) {
      throw new Error(`police_precinct row ${index}: invalid Precinct ${String(raw)}`);
    }
    return {
      id,
      label: `Police Precinct ${id}`,
      subtype: null,
      source_properties: { Precinct: id },
      geometry: requiredGeometry(feature, `police_precinct:${id}`),
    };
  });
  return assertUnique(features, "police_precinct").sort((left, right) => Number(left.id) - Number(right.id));
}

export function normalizeSanitationDistrictSource(geojson = {}) {
  const features = (geojson.features || []).map((feature, index) => {
    const properties = feature.properties || {};
    const id = String(property(properties, "districtcode", "DISTRICTCODE") ?? "").trim();
    const label = String(property(properties, "district", "DISTRICT") ?? "").trim();
    const sourceRowId = String(property(properties, "objectid", "OBJECTID") ?? "").trim();
    if (!/^[1-5](?:0[1-9]|1[0-8])$/.test(id)) {
      throw new Error(`sanitation_district row ${index}: invalid districtcode ${id || "(missing)"}`);
    }
    if (!label || !sourceRowId) throw new Error(`sanitation_district:${id}: missing publisher label/row id`);
    return {
      id,
      label,
      subtype: null,
      source_properties: { districtcode: id, district: label, source_row_id: sourceRowId },
      geometry: requiredGeometry(feature, `sanitation_district:${id}`),
    };
  });
  return assertUnique(features, "sanitation_district").sort((left, right) => Number(left.id) - Number(right.id));
}

function reviewedBidLookup(reviewedRegistry = {}) {
  if (reviewedRegistry.schema !== "cityscroll.reviewed_bid_identity_registry.v1") {
    throw new Error("BID reviewed identity registry schema mismatch");
  }
  const byBinding = new Map();
  const slugs = new Set();
  for (const entry of reviewedRegistry.entries || []) {
    const rowId = String(entry.source_row_id || "").trim();
    const name = String(entry.source_name || "").trim();
    const slug = String(entry.canonical_slug || "").trim();
    if (!/^[1-9]\d*$/.test(rowId) || !name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      throw new Error(`invalid reviewed BID identity ${rowId || "(missing)"}:${name || "(missing)"}`);
    }
    const binding = `${rowId}\u0000${name}`;
    if (byBinding.has(binding)) throw new Error(`duplicate reviewed BID binding ${rowId}:${name}`);
    if (slugs.has(slug)) throw new Error(`duplicate reviewed BID slug ${slug}`);
    byBinding.set(binding, slug);
    slugs.add(slug);
  }
  return byBinding;
}

export function normalizeBusinessImprovementDistrictSource(geojson = {}, reviewedRegistry = {}) {
  const reviewed = reviewedBidLookup(reviewedRegistry);
  const features = [];
  const rejections = [];
  for (const [index, feature] of (geojson.features || []).entries()) {
    const properties = feature.properties || {};
    const sourceRowId = String(property(properties, "objectid_2", "OBJECTID_2") ?? "").trim();
    const sourceName = String(property(properties, "f_all_bi_2", "F_ALL_BI_2") ?? "").trim();
    const legacySourceId = String(property(properties, "f_all_bids", "F_ALL_BIDs") ?? "").trim();
    if (!/^[1-9]\d*$/.test(sourceRowId)) {
      rejections.push({
        source_index: index,
        source_row_id: sourceRowId || null,
        source_name: sourceName || null,
        reason: "zero_or_invalid_source_row_id",
      });
      continue;
    }
    const slug = reviewed.get(`${sourceRowId}\u0000${sourceName}`);
    if (!slug) throw new Error(`BID ${sourceRowId}:${sourceName || "(missing)"} lacks reviewed canonical slug`);
    features.push({
      id: slug,
      label: sourceName,
      subtype: null,
      source_properties: {
        reviewed_slug: slug,
        source_row_id: sourceRowId,
        source_name: sourceName,
        rejected_legacy_source_id: legacySourceId || null,
      },
      geometry: requiredGeometry(feature, `business_improvement_district:${slug}`),
    });
  }
  assertUnique(features, "business_improvement_district");
  return {
    features: features.sort((left, right) => left.id.localeCompare(right.id)),
    rejections: rejections.sort((left, right) => left.source_index - right.source_index),
    identity_field_rejections: [
      { field: "id", reason: "publisher column is zero for every current row" },
      { field: "objectid_1", reason: "publisher column is zero for every current row" },
      { field: "f_all_bids", reason: "publisher column contains duplicate zero identifiers" },
    ],
  };
}

export { NTA_SUBTYPE_BY_CODE };
