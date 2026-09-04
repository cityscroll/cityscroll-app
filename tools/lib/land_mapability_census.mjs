/**
 * Denominator-first Land mapability census.
 *
 * Joins the pinned default Land snapshot to exact WH-06 BBL keys and finite
 * retained MapPLUTO centroids. Runtime geocoding, borough/district guesses,
 * neighboring parcels, and outcome-only points do not participate.
 */

import { centroidEntry, normalizeBbl } from "../../site/bbl_mappluto_centroids.mjs";

export const LAND_MAPABILITY_CENSUS_SCHEMA = "cityscroll.land_mapability_census.v1";
export const LAND_MAPABILITY_JOIN_VERSION = "exact_project_id_wh06_bbl_mappluto_centroid_v1";
export const LAND_MAPABILITY_DENOMINATOR = 40;
export const LAND_MAPABILITY_LIST_BYTES = 249323;

export const LAND_MAPABILITY_METHODS = Object.freeze({
  SINGLE_BBL_CENTROID: "single_bbl_centroid",
  MULTI_BBL_ANCHOR: "multi_bbl_anchor",
  PUBLISHER_POINT: "publisher_point",
  PROPERTY_COORDINATE: "property_coordinate",
  GEOMETRY_REPRESENTATIVE_POINT: "geometry_representative_point",
  UNMAPPED: "unmapped",
});

export const LAND_MAPABILITY_UNMAPPED_REASONS = Object.freeze({
  NO_RETAINED_BBL: "no_retained_bbl",
  EXACT_BBL_MISSING_CENTROID: "exact_bbl_missing_centroid",
});

export const REJECTED_PLACEMENT_METHODS = Object.freeze([
  "address_geocode",
  "borough_centroid",
  "district_guess",
  "neighboring_parcel",
  "outcome_point",
]);

export const LAND_MAPABILITY_SPECIMENS = Object.freeze({
  multi_bbl: "2025K0305",
  no_retained_bbl: ["2026K0123", "2025R0222"],
});

function trimId(value) {
  return String(value ?? "").trim();
}

function finitePoint(record) {
  const pairs = [
    [record?.latitude, record?.longitude],
    [record?.lat, record?.lon],
  ];
  for (const [lat, lon] of pairs) {
    const y = Number(lat);
    const x = Number(lon);
    if (Number.isFinite(y) && Number.isFinite(x)) return { lat: y, lon: x };
  }
  return null;
}

function exactBblsForProject(zapBbl, projectId) {
  const wanted = trimId(projectId);
  if (!wanted) return [];
  const rows = Array.isArray(zapBbl?.rows) ? zapBbl.rows : [];
  const out = [];
  for (const row of rows) {
    if (trimId(row?.project_id) !== wanted) continue;
    for (const value of Array.isArray(row?.bbls) ? row.bbls : []) {
      const bbl = normalizeBbl(value);
      if (bbl) out.push(bbl);
    }
  }
  return out;
}

function matchedCentroidsFor(bbls, byBbl) {
  const matched = [];
  for (const bbl of bbls) {
    const entry = centroidEntry(bbl, byBbl?.[bbl]);
    if (!entry) continue;
    matched.push({ bbl, lat: entry.lat, lon: entry.lon });
  }
  return matched;
}

function collectPropertyBbls(propertyObservations) {
  const out = new Set();
  const rows = Array.isArray(propertyObservations?.property_rows)
    ? propertyObservations.property_rows
    : [];
  for (const row of rows) {
    const loc = row?.property_location || {};
    const values = [];
    if (loc.bbl) values.push(loc.bbl);
    if (Array.isArray(loc.bbls)) values.push(...loc.bbls);
    for (const address of Array.isArray(loc.addresses) ? loc.addresses : []) {
      if (address?.bbl) values.push(address.bbl);
    }
    for (const value of values) {
      const bbl = normalizeBbl(value);
      if (bbl) out.add(bbl);
    }
  }
  return out;
}

function methodForMatched(uniqueMatchedCount) {
  if (uniqueMatchedCount === 1) return LAND_MAPABILITY_METHODS.SINGLE_BBL_CENTROID;
  if (uniqueMatchedCount > 1) return LAND_MAPABILITY_METHODS.MULTI_BBL_ANCHOR;
  return LAND_MAPABILITY_METHODS.UNMAPPED;
}

/**
 * Measure default-Land mapability from already retained artifacts.
 * Extra keys (geocode, district centroids, neighbor parcels, live fetch)
 * are ignored by construction: they are not read.
 *
 * @param {object} inputs
 * @param {object} inputs.landDefault
 * @param {object} inputs.zapBbl
 * @param {object} inputs.mapplutoCentroids
 * @param {object} [inputs.propertyObservations]
 * @param {number} inputs.listBytes
 * @param {{ land_default: string, zap_bbl: string, mappluto_centroids: string, property_observations?: string }} inputs.artifactHashes
 */
export function censusLandMapability(inputs = {}) {
  const landDefault = inputs.landDefault && typeof inputs.landDefault === "object" ? inputs.landDefault : {};
  const zapBbl = inputs.zapBbl && typeof inputs.zapBbl === "object" ? inputs.zapBbl : {};
  const centroidsDoc =
    inputs.mapplutoCentroids && typeof inputs.mapplutoCentroids === "object" ? inputs.mapplutoCentroids : {};
  const byBbl = centroidsDoc.by_bbl && typeof centroidsDoc.by_bbl === "object" ? centroidsDoc.by_bbl : {};
  const projects = Array.isArray(landDefault.projects) ? landDefault.projects : [];
  const hashes = inputs.artifactHashes && typeof inputs.artifactHashes === "object" ? inputs.artifactHashes : {};
  const propertyBbls = collectPropertyBbls(inputs.propertyObservations);

  let bblOccurrences = 0;
  const uniqueBblKeys = new Set();
  let matchedCentroidOccurrences = 0;
  const uniqueCentroidKeys = new Set();
  let exactBblProjects = 0;
  let publisherPoints = 0;
  let propertyJoins = 0;
  const methodCounts = {
    [LAND_MAPABILITY_METHODS.SINGLE_BBL_CENTROID]: 0,
    [LAND_MAPABILITY_METHODS.MULTI_BBL_ANCHOR]: 0,
    [LAND_MAPABILITY_METHODS.PUBLISHER_POINT]: 0,
    [LAND_MAPABILITY_METHODS.PROPERTY_COORDINATE]: 0,
    [LAND_MAPABILITY_METHODS.GEOMETRY_REPRESENTATIVE_POINT]: 0,
    [LAND_MAPABILITY_METHODS.UNMAPPED]: 0,
  };
  const rows = [];

  for (const project of projects) {
    const projectId = trimId(project?.project_id);
    if (finitePoint(project)) publisherPoints += 1;
    const exactBbls = exactBblsForProject(zapBbl, projectId);
    const uniqueExact = [...new Set(exactBbls)];
    bblOccurrences += exactBbls.length;
    for (const bbl of uniqueExact) uniqueBblKeys.add(bbl);
    if (uniqueExact.length) exactBblProjects += 1;

    const matched = matchedCentroidsFor(exactBbls, byBbl);
    matchedCentroidOccurrences += matched.length;
    const uniqueMatched = [];
    const seenMatched = new Set();
    for (const hit of matched) {
      uniqueCentroidKeys.add(hit.bbl);
      if (seenMatched.has(hit.bbl)) continue;
      seenMatched.add(hit.bbl);
      uniqueMatched.push(hit);
    }

    let propertyJoin = false;
    for (const bbl of uniqueExact) {
      if (propertyBbls.has(bbl)) {
        propertyJoin = true;
        break;
      }
    }
    if (propertyJoin) propertyJoins += 1;

    const method = methodForMatched(uniqueMatched.length);
    methodCounts[method] += 1;
    const mapped = method !== LAND_MAPABILITY_METHODS.UNMAPPED;
    const unmappedReason = mapped
      ? null
      : uniqueExact.length
        ? LAND_MAPABILITY_UNMAPPED_REASONS.EXACT_BBL_MISSING_CENTROID
        : LAND_MAPABILITY_UNMAPPED_REASONS.NO_RETAINED_BBL;
    const point = uniqueMatched[0] || null;
    rows.push({
      project_id: projectId,
      project_name: String(project?.project_name || ""),
      mapped,
      method,
      unmapped_reason: unmappedReason,
      exact_bbl_count: exactBbls.length,
      unique_exact_bbl_count: uniqueExact.length,
      exact_bbl_keys: exactBbls,
      matched_centroid_count: matched.length,
      unique_matched_centroid_count: uniqueMatched.length,
      matched_centroids: uniqueMatched,
      point,
      point_role: mapped
        ? method === LAND_MAPABILITY_METHODS.MULTI_BBL_ANCHOR
          ? "existence_proof"
          : LAND_MAPABILITY_METHODS.SINGLE_BBL_CENTROID
        : null,
      join_version: LAND_MAPABILITY_JOIN_VERSION,
    });
  }

  const mappedRows = rows.filter((row) => row.mapped);
  const unmappedRows = rows.filter((row) => !row.mapped);
  const exactMissingCentroid = unmappedRows
    .filter((row) => row.unmapped_reason === LAND_MAPABILITY_UNMAPPED_REASONS.EXACT_BBL_MISSING_CENTROID)
    .map((row) => row.project_id);
  const noRetainedBbl = unmappedRows
    .filter((row) => row.unmapped_reason === LAND_MAPABILITY_UNMAPPED_REASONS.NO_RETAINED_BBL)
    .map((row) => row.project_id);
  const denominator = projects.length;
  const mappedCount = mappedRows.length;
  const coverageRate = denominator ? Number((mappedCount / denominator).toFixed(3)) : 0;

  return {
    schema: LAND_MAPABILITY_CENSUS_SCHEMA,
    join_version: LAND_MAPABILITY_JOIN_VERSION,
    new_publisher_work: false,
    runtime_network: false,
    geocoder_input: false,
    rum_receipt: null,
    derivation: "node tools/build_land_mapability_census.mjs",
    artifacts: {
      land_default: {
        path: "site/data/land_default_ulurp.json",
        count_field: Number(landDefault.count),
        generated_at: landDefault.generated_at || null,
        bytes: Number(inputs.listBytes),
        sha256: hashes.land_default || null,
      },
      zap_bbl: {
        path: "site/data/zap_bbl_warehouse_lookup.json",
        phase: zapBbl.phase || null,
        dataset_id: zapBbl.dataset_id || null,
        mode: zapBbl.mode || null,
        materialized_at: zapBbl.materialized_at || null,
        project_count: Number(zapBbl.project_count),
        bbl_row_count: Number(zapBbl.bbl_row_count),
        sha256: hashes.zap_bbl || null,
      },
      mappluto_centroids: {
        path: "site/data/bbl_mappluto_centroids_lookup.json",
        source: centroidsDoc.source || null,
        mode: centroidsDoc.mode || null,
        materialized_at: centroidsDoc.materialized_at || null,
        bbl_count: Number(centroidsDoc.bbl_count),
        sha256: hashes.mappluto_centroids || null,
      },
      property_observations: {
        path: "site/data/property_domain_observations.json",
        property_count: Number(inputs.propertyObservations?.property_count || 0),
        sha256: hashes.property_observations || null,
        consulted_for_mapping: false,
      },
    },
    aggregations: {
      denominator,
      mapped: mappedCount,
      unmapped: unmappedRows.length,
      coverage_percent: Number((coverageRate * 100).toFixed(1)),
      exact_bbl_projects: exactBblProjects,
      bbl_occurrences: bblOccurrences,
      unique_bbl_keys: uniqueBblKeys.size,
      matched_centroid_occurrences: matchedCentroidOccurrences,
      unique_centroid_keys: uniqueCentroidKeys.size,
      methods: {
        [LAND_MAPABILITY_METHODS.SINGLE_BBL_CENTROID]:
          methodCounts[LAND_MAPABILITY_METHODS.SINGLE_BBL_CENTROID],
        [LAND_MAPABILITY_METHODS.MULTI_BBL_ANCHOR]:
          methodCounts[LAND_MAPABILITY_METHODS.MULTI_BBL_ANCHOR],
        [LAND_MAPABILITY_METHODS.PUBLISHER_POINT]: publisherPoints,
        [LAND_MAPABILITY_METHODS.PROPERTY_COORDINATE]: propertyJoins,
        [LAND_MAPABILITY_METHODS.GEOMETRY_REPRESENTATIVE_POINT]: 0,
      },
      list_baseline: {
        rows: denominator,
        bytes: Number(inputs.listBytes),
      },
    },
    unmapped_project_ids: unmappedRows.map((row) => row.project_id),
    unmapped_exact_bbl_missing_centroid: exactMissingCentroid,
    unmapped_no_retained_bbl: noRetainedBbl,
    projects: rows,
    rejected_placement_methods: [...REJECTED_PLACEMENT_METHODS],
  };
}

export function landMapabilityContractFindings(census, opts = {}) {
  const findings = [];
  if (!census || typeof census !== "object") {
    return ["land mapability census missing"];
  }
  if (census.schema !== LAND_MAPABILITY_CENSUS_SCHEMA) {
    findings.push(`schema ${JSON.stringify(census.schema)} != ${LAND_MAPABILITY_CENSUS_SCHEMA}`);
  }
  if (census.join_version !== LAND_MAPABILITY_JOIN_VERSION) {
    findings.push(`join_version ${JSON.stringify(census.join_version)} != ${LAND_MAPABILITY_JOIN_VERSION}`);
  }
  if (census.new_publisher_work !== false) findings.push("new_publisher_work must be false");
  if (census.runtime_network !== false) findings.push("runtime_network must be false");
  if (census.geocoder_input !== false) findings.push("geocoder_input must be false");
  const required = opts.requireDefaultDenominator !== false;
  const agg = census.aggregations || {};
  if (required) {
    if (agg.denominator !== LAND_MAPABILITY_DENOMINATOR) {
      findings.push(`denominator ${agg.denominator} != ${LAND_MAPABILITY_DENOMINATOR}`);
    }
    if (agg.mapped !== 33) findings.push(`mapped ${agg.mapped} != 33`);
    if (agg.unmapped !== 7) findings.push(`unmapped ${agg.unmapped} != 7`);
    if (agg.coverage_percent !== 82.5) findings.push(`coverage_percent ${agg.coverage_percent} != 82.5`);
    if (agg.exact_bbl_projects !== 39) findings.push(`exact_bbl_projects ${agg.exact_bbl_projects} != 39`);
    if (agg.bbl_occurrences !== 284) findings.push(`bbl_occurrences ${agg.bbl_occurrences} != 284`);
    if (agg.unique_bbl_keys !== 277) findings.push(`unique_bbl_keys ${agg.unique_bbl_keys} != 277`);
    if (agg.matched_centroid_occurrences !== 233) {
      findings.push(`matched_centroid_occurrences ${agg.matched_centroid_occurrences} != 233`);
    }
    if (agg.unique_centroid_keys !== 226) findings.push(`unique_centroid_keys ${agg.unique_centroid_keys} != 226`);
    if (agg.methods?.[LAND_MAPABILITY_METHODS.SINGLE_BBL_CENTROID] !== 11) {
      findings.push("single_bbl_centroid count != 11");
    }
    if (agg.methods?.[LAND_MAPABILITY_METHODS.MULTI_BBL_ANCHOR] !== 22) {
      findings.push("multi_bbl_anchor count != 22");
    }
    if (agg.methods?.[LAND_MAPABILITY_METHODS.PUBLISHER_POINT] !== 0) {
      findings.push("publisher_point count must be 0");
    }
    if (agg.methods?.[LAND_MAPABILITY_METHODS.PROPERTY_COORDINATE] !== 0) {
      findings.push("property_coordinate count must be 0");
    }
    if (agg.list_baseline?.bytes !== LAND_MAPABILITY_LIST_BYTES) {
      findings.push(`list baseline bytes ${agg.list_baseline?.bytes} != ${LAND_MAPABILITY_LIST_BYTES}`);
    }
    if (!Array.isArray(census.unmapped_project_ids) || census.unmapped_project_ids.length !== 7) {
      findings.push("unmapped_project_ids must name 7 projects");
    }
    if (Array.isArray(census.projects) && census.projects.length !== LAND_MAPABILITY_DENOMINATOR) {
      findings.push("project table must preserve the 40-row denominator");
    }
  }
  if (Array.isArray(census.projects)) {
    const mappedIds = new Set();
    const listedIds = new Set();
    for (const row of census.projects) {
      listedIds.add(row.project_id);
      if (row.mapped) mappedIds.add(row.project_id);
      if (row.mapped && !row.point) findings.push(`${row.project_id} mapped without a finite centroid`);
      if (!row.mapped && row.point) findings.push(`${row.project_id} unmapped but received a point`);
      if (REJECTED_PLACEMENT_METHODS.includes(row.method)) {
        findings.push(`${row.project_id} used rejected method ${row.method}`);
      }
    }
    for (const id of census.unmapped_project_ids || []) {
      if (mappedIds.has(id)) findings.push(`${id} is both mapped and unmapped`);
      if (!listedIds.has(id)) findings.push(`${id} unmapped id is missing from the denominator`);
    }
  }
  return findings;
}

export function assertLandMapabilityContract(census, opts = {}) {
  const findings = landMapabilityContractFindings(census, opts);
  if (findings.length) throw new Error(findings.join("; "));
  return true;
}

function mdTable(rows) {
  return rows.map((row) => `| ${row.join(" | ")} |`).join("\n");
}

export function renderLandMapabilityCensusMarkdown(census) {
  const agg = census.aggregations;
  const unmapped = census.unmapped_project_ids.join(", ");
  const exactMissing = census.unmapped_exact_bbl_missing_centroid.join(", ");
  const noBbl = census.unmapped_no_retained_bbl.join(", ");
  const projectRows = [
    ["Project", "Mapped", "Method", "Exact BBLs", "Centroid keys", "Missingness"],
    ["---", "---", "---", "---:", "---:", "---"],
    ...census.projects.map((row) => [
      `\`${row.project_id}\``,
      row.mapped ? "yes" : "no",
      row.method,
      String(row.exact_bbl_count),
      String(row.unique_matched_centroid_count),
      row.unmapped_reason || "—",
    ]),
  ];
  return `# Land default-corpus mapability census

This receipt measures how much of the current 40-row Land default snapshot can be placed with sources already retained in the repository. It does not ship a browse Map, change Land filters or watches, or acquire a new publisher.

## Bottom line

**${agg.mapped} of ${agg.denominator} projects (${agg.coverage_percent} percent)** have at least one exact WH-06 BBL with a finite retained MapPLUTO centroid. **${agg.unmapped} projects remain unmapped** and stay in the List denominator. No runtime geocoder, live GIS request, borough or district guess, neighboring parcel, or outcome-only point is counted as deterministic placement.

\`${agg.mapped} / ${agg.denominator} = ${agg.coverage_percent}%\`

Unmapped project ids: ${unmapped}.

## Aggregation

${mdTable([
    ["Quantity", "Value"],
    ["---", "---:"],
    ["Default Land projects (denominator)", String(agg.denominator)],
    ["Deterministically mapped", String(agg.mapped)],
    ["Unmapped", String(agg.unmapped)],
    ["Exact-BBL projects", String(agg.exact_bbl_projects)],
    ["BBL occurrences", String(agg.bbl_occurrences)],
    ["Unique BBL keys", String(agg.unique_bbl_keys)],
    ["Matched centroid occurrences", String(agg.matched_centroid_occurrences)],
    ["Unique centroid keys", String(agg.unique_centroid_keys)],
    ["single_bbl_centroid", String(agg.methods.single_bbl_centroid)],
    ["multi_bbl_anchor", String(agg.methods.multi_bbl_anchor)],
    ["publisher_point", String(agg.methods.publisher_point)],
    ["property_coordinate", String(agg.methods.property_coordinate)],
    ["geometry_representative_point", String(agg.methods.geometry_representative_point)],
    ["List snapshot bytes", String(agg.list_baseline.bytes)],
    ["New publisher work", "false"],
  ])}

Exact-BBL projects without a retained centroid: ${exactMissing}.
Projects with no retained WH-06 BBL: ${noBbl}.

## Specimens

- \`2025K0305\` is a positive multi-BBL case: 25 retained BBLs and 25 centroid matches, method \`multi_bbl_anchor\`. The census records those exact keys; it does not claim the later nearest-mean anchor resolver.
- \`2026K0123\` and \`2025R0222\` have no retained WH-06 BBL. A MapPLUTO canary BBL for another lookup, a district label, or an outcome coordinate must not mint a marker.

## Artifacts

${mdTable([
    ["Artifact", "Vintage / identity", "SHA-256"],
    ["---", "---", "---"],
    [
      `\`site/data/land_default_ulurp.json\``,
      census.artifacts.land_default.generated_at || "—",
      `\`${census.artifacts.land_default.sha256}\``,
    ],
    [
      `\`site/data/zap_bbl_warehouse_lookup.json\``,
      `${census.artifacts.zap_bbl.materialized_at || "—"} (${census.artifacts.zap_bbl.phase}, ${census.artifacts.zap_bbl.dataset_id})`,
      `\`${census.artifacts.zap_bbl.sha256}\``,
    ],
    [
      `\`site/data/bbl_mappluto_centroids_lookup.json\``,
      `${census.artifacts.mappluto_centroids.materialized_at || "—"} (${census.artifacts.mappluto_centroids.mode})`,
      `\`${census.artifacts.mappluto_centroids.sha256}\``,
    ],
  ])}

Join version: \`${census.join_version}\`. Rebuild with \`${census.derivation}\` or check the committed bytes with \`node tools/build_land_mapability_census.mjs --check\`.

## Forty-row table

${mdTable(projectRows)}

## Boundary

List continues to display all ${agg.denominator} current rows. A later Map may render only accepted points and must keep the unmapped count visible. This receipt does not decide whether Map becomes a default view.
`;
}
