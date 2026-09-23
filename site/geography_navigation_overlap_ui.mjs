/**
 * Selected-area overlap drawer: shared view model and markup for server and client.
 *
 * Point containment ("At this location") and area intersection ("This neighborhood
 * overlaps") stay separate. The browser never invents percentages from simplified
 * shapes; it only presents committed crosswalk rows or an explicit unavailable state.
 */

import {
  GEOGRAPHY_NAVIGATION_AREA_OVERLAP_EXAMPLE,
  GEOGRAPHY_NAVIGATION_POINT_BUNDLES,
  GEOGRAPHY_NAVIGATION_RELATION_RULES,
  geographyNavigationLayer,
  geographyNavigationMoreBoundaryLayers,
  geographyNavigationPrimaryLayers,
} from "./geography_navigation_capability.mjs";
import {
  GEOGRAPHY_CROSSWALK_MATERIALITY,
  GEOGRAPHY_CROSSWALK_TARGET_TYPES,
  isMaterialForNavigation,
} from "./geography_crosswalk_artifacts.mjs";
import { civicGeographyLayer } from "./civic_geography_registry.mjs";
import {
  GEOGRAPHY_NAVIGATION_DRAWER_CLOSED,
  GEOGRAPHY_NAVIGATION_DRAWER_OPEN,
  GEOGRAPHY_NAVIGATION_SURFACE_MAP,
  GEOGRAPHY_NAVIGATION_SURFACE_RECORDS,
  geographyNavigationUrlWithFilters as geographyNavigationUrlFromState,
} from "./geography_navigation_state.mjs";
import { BOUNDARIES_AT_LOCATION_HEADING } from "./geography_navigation_entry.mjs";
import { GEOGRAPHY_RECORD_LENS_LABELS } from "./geography_navigation_records.mjs";

/** Schema id avoids the private-terms geography+navigation fold. */
export const RESIDENT_GEOGRAPHY_OVERLAP_SCHEMA = "cityscroll.resident_geography_overlap.v1";

export const OVERLAP_COMPARISON_UNAVAILABLE = "Comparison details unavailable";
export const OVERLAP_POINT_HEADING = GEOGRAPHY_NAVIGATION_RELATION_RULES.point_membership.resident_phrase;
export const OVERLAP_AREA_PHRASE = GEOGRAPHY_NAVIGATION_RELATION_RULES.area_relationship.resident_phrase;
export const OVERLAP_SOURCE_DETAILS_SUMMARY = "Source and exact figures";
export const OVERLAP_SELECT_ACTION_LABEL = "Select this area";
export const OVERLAP_NO_MATERIAL_COPY = "No material overlap with this boundary layer.";
export const OVERLAP_RECORDS_CONTINUATION_PREFIX = "See records in this";

const BOROUGH_BY_CODE = Object.freeze({
  M: "Manhattan",
  X: "Bronx",
  K: "Brooklyn",
  Q: "Queens",
  R: "Staten Island",
});

const METHOD_COPY = Object.freeze({
  polygon_intersection_epsg2263: "Direct polygon intersection on EPSG:2263 land coordinates",
  direct_polygon_intersection: "Direct polygon intersection on EPSG:2263 land coordinates",
  independent_per_layer_point_in_polygon: "Independent point-in-polygon check per boundary layer",
});

function freezeDeep(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const entry of value) freezeDeep(entry);
    return Object.freeze(value);
  }
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function parseGeographyKey(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const match = /^geography:([a-z0-9_]+):(.+)$/.exec(text)
    || /^([a-z0-9_]+):(.+)$/.exec(text);
  if (!match) return null;
  return { type: match[1], id: match[2], key: `geography:${match[1]}:${match[2]}` };
}

/** Approximate primary percentage; exact values stay in details. */
export function formatOverlapDisplayPercent(pctFrom) {
  const value = Number(pctFrom);
  if (!Number.isFinite(value)) return null;
  if (value >= 99.5) return "~100%";
  return `${value.toFixed(1)}%`;
}

export function formatOverlapExactPercent(pctFrom) {
  const value = Number(pctFrom);
  if (!Number.isFinite(value)) return null;
  return `${value.toFixed(6)}%`;
}

export function readableOverlayMethod(method) {
  const key = String(method || "").trim();
  if (!key) return "Direct polygon intersection";
  return METHOD_COPY[key] || key.replaceAll("_", " ");
}

export function labelForGeographyId(type, id, { labelIndex = null } = {}) {
  const key = `geography:${type}:${id}`;
  if (labelIndex && typeof labelIndex === "object") {
    const fromIndex = labelIndex[key] || labelIndex[`${type}:${id}`] || labelIndex[id];
    if (fromIndex) return String(fromIndex);
  }
  if (type === "council_district") return `City Council District ${id}`;
  if (type === "police_precinct") return `Police Precinct ${id}`;
  if (type === "nta2020") return String(id);
  if (type === "community_district") {
    const code = String(id || "");
    const borough = BOROUGH_BY_CODE[code[0]] || null;
    const number = code.slice(1).replace(/^0+/, "") || code.slice(1);
    return borough ? `${borough} Community District ${number}` : `Community District ${id}`;
  }
  return String(id);
}

function isBareNtaCode(label) {
  return /^[A-Z]{2}\d{4}$/.test(String(label || "").trim());
}

/**
 * Resolve resident identity + boundary vintage from geography owners
 * (label index, layer document, explicit selected fields). Records/activity
 * state must not invent these values.
 */
export function resolveGeographyOwnerPresentation({
  type = null,
  id = null,
  key = null,
  label = null,
  boundary_vintage = null,
  labelIndex = null,
  layerDoc = null,
} = {}) {
  const resolvedType = type || layerDoc?.type || null;
  const resolvedId = id == null ? null : String(id);
  const resolvedKey = key
    || (resolvedType && resolvedId ? `geography:${resolvedType}:${resolvedId}` : null);
  const layerFeature = resolvedId && Array.isArray(layerDoc?.features)
    ? layerDoc.features.find((feature) => (
      String(feature?.id) === resolvedId
      || feature?.key === resolvedKey
      || feature?.key === `${resolvedType}:${resolvedId}`
    )) || null
    : null;

  let resolvedLabel = label || layerFeature?.label || null;
  if (!resolvedLabel && resolvedType && resolvedId) {
    resolvedLabel = labelForGeographyId(resolvedType, resolvedId, { labelIndex });
  } else if (resolvedLabel && resolvedType === "nta2020" && isBareNtaCode(resolvedLabel) && labelIndex) {
    const indexed = labelForGeographyId(resolvedType, resolvedId, { labelIndex });
    if (indexed && !isBareNtaCode(indexed)) resolvedLabel = indexed;
  }

  let resolvedVintage = boundary_vintage
    || layerFeature?.boundary_vintage
    || layerDoc?.vintage?.id
    || null;
  if (resolvedVintage != null) resolvedVintage = String(resolvedVintage);

  const friendly = Boolean(
    resolvedLabel
    && !(resolvedType === "nta2020" && isBareNtaCode(resolvedLabel)),
  );

  return Object.freeze({
    key: resolvedKey,
    type: resolvedType,
    id: resolvedId,
    label: resolvedLabel,
    boundary_vintage: resolvedVintage,
    has_friendly_label: friendly,
    geometry_available: Boolean(layerFeature || resolvedVintage || (layerDoc && Array.isArray(layerDoc.features))),
  });
}

function selectedLabel(selected, { labelIndex = null } = {}) {
  if (selected?.label) return String(selected.label);
  if (!selected?.type || !selected?.id) return "Selected place";
  return labelForGeographyId(selected.type, selected.id, { labelIndex });
}

function selectedTypeExplanation(type) {
  const layer = geographyNavigationLayer(type);
  return layer?.detail_label || "Selected geography.";
}

function comparisonNoun(type) {
  const layer = geographyNavigationLayer(type);
  return layer?.comparison_noun || "areas";
}

function selectionNoun(type) {
  const layer = geographyNavigationLayer(type);
  return layer?.selection_noun || "place";
}

function sourceNameForType(type) {
  const layer = geographyNavigationLayer(type) || civicGeographyLayer(type);
  const publisher = layer?.source?.publisher;
  const contract = layer?.source?.contract_id;
  if (publisher && contract) return `${publisher} (${contract})`;
  if (publisher) return publisher;
  if (contract) return contract;
  return "Published civic geography boundaries";
}

function normalizeSelected(input) {
  if (!input) return null;
  if (typeof input === "string") {
    const parsed = parseGeographyKey(input);
    return parsed ? { ...parsed, label: null, boundary_vintage: null } : null;
  }
  const parsed = parseGeographyKey(input.key || (input.type && input.id ? `${input.type}:${input.id}` : ""));
  if (!parsed) return null;
  return {
    ...parsed,
    label: input.label ?? null,
    boundary_vintage: input.boundary_vintage ?? input.vintage ?? null,
    subtype: input.subtype ?? null,
  };
}

function rowIdentity(row) {
  if (row?.to_key) {
    const parsed = parseGeographyKey(row.to_key);
    if (parsed) return parsed;
  }
  if (row?.type && row?.id) {
    return { type: row.type, id: String(row.id), key: `geography:${row.type}:${row.id}` };
  }
  if (row?.to_type && row?.to_id) {
    return { type: row.to_type, id: String(row.to_id), key: `geography:${row.to_type}:${row.to_id}` };
  }
  return null;
}

/**
 * Sort material overlap rows by descending pct_from, then canonical id.
 */
export function sortOverlapRows(rows = []) {
  return [...rows].sort((left, right) => {
    const pct = (Number(right.pct_from) || 0) - (Number(left.pct_from) || 0);
    if (pct !== 0) return pct;
    const leftId = String(left.id || left.to_id || "");
    const rightId = String(right.id || right.to_id || "");
    return leftId.localeCompare(rightId, "en");
  });
}

export function projectOverlapRow(row, {
  compareType = null,
  labelIndex = null,
} = {}) {
  const identity = rowIdentity(row);
  if (!identity) return null;
  if (compareType && identity.type !== compareType) return null;
  const pctFrom = Number(row.pct_from);
  const material = row.material_for_navigation == null
    ? isMaterialForNavigation(pctFrom)
    : Boolean(row.material_for_navigation);
  const label = row.label || labelForGeographyId(identity.type, identity.id, { labelIndex });
  const relation = String(row.relation || "intersects");
  const status = material
    ? "material"
    : (relation === "below_threshold" ? "below_threshold" : "immaterial");
  return freezeDeep({
    key: identity.key,
    type: identity.type,
    id: identity.id,
    label,
    relation,
    status,
    material_for_navigation: material,
    pct_from: Number.isFinite(pctFrom) ? pctFrom : null,
    pct_to: Number.isFinite(Number(row.pct_to)) ? Number(row.pct_to) : null,
    display_pct: material ? formatOverlapDisplayPercent(pctFrom) : null,
    exact_pct_from: formatOverlapExactPercent(pctFrom),
    exact_pct_to: formatOverlapExactPercent(row.pct_to),
    boundary_vintage: row.boundary_vintage
      || row.to_vintage
      || row.source_vintages?.to
      || null,
    method: row.method || null,
    intersection_area_sqft: row.intersection_area_sqft ?? row.area_sq_ft ?? null,
  });
}

export function filterRowsForCompare(rows, compareType) {
  return (rows || [])
    .map((row) => projectOverlapRow(row, { compareType }))
    .filter(Boolean);
}

/**
 * Build the shared selected-area overlap view model.
 *
 * @param {object} options
 * @param {object|string} options.selected selected geography
 * @param {string|null} options.compareType comparison layer type
 * @param {Array|null} options.crosswalkRows committed crosswalk rows for the selection
 * @param {boolean} [options.crosswalkAvailable=true] false yields unavailable copy
 * @param {object|null} options.pointBundle optional point membership bundle
 * @param {object|null} options.labelIndex optional key→label map
 * @param {string} [options.base="/near-you/"] URL base for native links
 * @param {string} [options.surface="map"]
 * @param {string|null} [options.drawer]
 * @param {string|null} [options.focusToken] focus restore token for the invoker
 * @param {string|null} [options.recordsHref]
 * @param {object|null} [options.recordLenses] exact keyed lens projections
 */
export function buildSelectedGeographyOverlapViewModel({
  selected: selectedInput = null,
  compareType = null,
  crosswalkRows = null,
  crosswalkAvailable = true,
  pointBundle = null,
  labelIndex = null,
  base = "/near-you/",
  surface = GEOGRAPHY_NAVIGATION_SURFACE_MAP,
  drawer = GEOGRAPHY_NAVIGATION_DRAWER_OPEN,
  focusToken = null,
  recordsHref = null,
  recordLenses = null,
  relatedDistricts = [],
} = {}) {
  const selected = normalizeSelected(selectedInput);
  if (!selected) {
    return freezeDeep({
      schema: RESIDENT_GEOGRAPHY_OVERLAP_SCHEMA,
      ok: false,
      empty: true,
      selected: null,
      compare_type: null,
      summary: null,
      point_section: null,
      area_section: null,
      details: null,
      continuation: null,
      drawer,
      focus_token: focusToken,
      hard_negatives: Object.freeze([
        "your district",
        "sole district",
        "the district for this neighborhood",
      ]),
    });
  }

  const effectiveCompare = GEOGRAPHY_CROSSWALK_TARGET_TYPES.includes(String(compareType || ""))
    ? String(compareType)
    : null;

  const selectedLabelText = selectedLabel(selected, { labelIndex });
  const typeExplanation = selectedTypeExplanation(selected.type);

  let areaSection = null;
  let details = {
    selected: {
      key: selected.key,
      type: selected.type,
      id: selected.id,
      label: selectedLabelText,
      source_name: sourceNameForType(selected.type),
      boundary_vintage: selected.boundary_vintage,
      type_explanation: typeExplanation,
    },
    target_layer: effectiveCompare ? {
      type: effectiveCompare,
      label: geographyNavigationLayer(effectiveCompare)?.primary_label || effectiveCompare,
      source_name: sourceNameForType(effectiveCompare),
      comparison_noun: comparisonNoun(effectiveCompare),
    } : null,
    method: null,
    materiality: GEOGRAPHY_CROSSWALK_MATERIALITY,
    retained_immaterial: Object.freeze([]),
    unavailable: false,
    unavailable_message: null,
  };

  if (effectiveCompare) {
    if (!crosswalkAvailable) {
      details.unavailable = true;
      details.unavailable_message = OVERLAP_COMPARISON_UNAVAILABLE;
      areaSection = freezeDeep({
        available: false,
        language: GEOGRAPHY_NAVIGATION_RELATION_RULES.area_relationship.language,
        heading: OVERLAP_COMPARISON_UNAVAILABLE,
        summary: OVERLAP_COMPARISON_UNAVAILABLE,
        rows: Object.freeze([]),
        source_context: {
          selected_source: details.selected.source_name,
          target_source: details.target_layer.source_name,
          selected_vintage: selected.boundary_vintage,
        },
      });
    } else {
      const projected = filterRowsForCompare(crosswalkRows || [], effectiveCompare);
      const material = sortOverlapRows(projected.filter((row) => row.material_for_navigation));
      const immaterial = sortOverlapRows(projected.filter((row) => !row.material_for_navigation));
      const method = projected.find((row) => row.method)?.method
        || GEOGRAPHY_NAVIGATION_AREA_OVERLAP_EXAMPLE.method;
      details.method = readableOverlayMethod(method);
      details.retained_immaterial = Object.freeze(immaterial);
      const noun = comparisonNoun(effectiveCompare);
      const summary = material.length
        ? `${OVERLAP_AREA_PHRASE} ${material.length} ${noun}.`
        : OVERLAP_NO_MATERIAL_COPY;
      areaSection = freezeDeep({
        available: true,
        language: GEOGRAPHY_NAVIGATION_RELATION_RULES.area_relationship.language,
        heading: OVERLAP_AREA_PHRASE,
        summary,
        rows: Object.freeze(material.map((row) => ({
          ...row,
          highlight_focus: row.key,
          select_href: geographyNavigationUrlFromState({
            ok: true,
            geo: `${row.type}:${row.id}`,
            key: row.key,
            type: row.type,
            id: row.id,
            surface,
            drawer: GEOGRAPHY_NAVIGATION_DRAWER_OPEN,
          }, { base }),
        }))),
      });
    }
  }

  let pointSection = null;
  if (pointBundle && typeof pointBundle === "object") {
    const membership = pointBundle.membership || pointBundle.by_type || null;
    const lines = [];
    if (membership) {
      const order = ["nta2020", "community_district", "council_district", "police_precinct"];
      for (const type of order) {
        const entry = Array.isArray(membership[type])
          ? membership[type][0]
          : membership[type];
        if (!entry) continue;
        const id = entry.id || entry;
        const label = entry.label || labelForGeographyId(type, id, { labelIndex });
        lines.push(freezeDeep({
          type,
          id: String(id),
          key: `geography:${type}:${id}`,
          label,
          boundary_vintage: entry.boundary_vintage || null,
          language: GEOGRAPHY_NAVIGATION_RELATION_RULES.point_membership.language,
        }));
      }
    }
    if (lines.length) {
      pointSection = freezeDeep({
        heading: OVERLAP_POINT_HEADING,
        boundaries_heading: BOUNDARIES_AT_LOCATION_HEADING,
        language: GEOGRAPHY_NAVIGATION_RELATION_RULES.point_membership.language,
        lines: Object.freeze(lines),
        bundle_id: pointBundle.id || null,
        bundle_label: pointBundle.label || null,
      });
    }
  }

  const compareControls = freezeDeep(
    [...geographyNavigationPrimaryLayers(), ...geographyNavigationMoreBoundaryLayers()]
      .filter((layer) => layer.type !== selected.type)
      .map((layer) => ({
        type: layer.type,
        label: layer.primary_label,
        pressed: layer.type === effectiveCompare,
        href: geographyNavigationUrlFromState({
          ok: true,
          geo: `${selected.type}:${selected.id}`,
          key: selected.key,
          type: selected.type,
          id: selected.id,
          compare: layer.type,
          surface,
          drawer: drawer || GEOGRAPHY_NAVIGATION_DRAWER_OPEN,
          focus: focusToken,
        }, { base }),
      })),
  );

  const selectedHref = geographyNavigationUrlFromState({
    ok: true,
    geo: `${selected.type}:${selected.id}`,
    key: selected.key,
    type: selected.type,
    id: selected.id,
    compare: effectiveCompare,
    surface,
    drawer: drawer || GEOGRAPHY_NAVIGATION_DRAWER_OPEN,
  }, { base });

  const continuationHref = recordsHref || geographyNavigationUrlFromState({
    ok: true,
    geo: `${selected.type}:${selected.id}`,
    key: selected.key,
    type: selected.type,
    id: selected.id,
    surface: "records",
  }, { base });
  const noun = selectionNoun(selected.type);
  const recordLensRows = Object.entries(recordLenses || {})
    .filter(([, projection]) => projection?.exact)
    .map(([lens, projection]) => ({
      lens,
      label: GEOGRAPHY_RECORD_LENS_LABELS[lens] || lens,
      count: projection.count,
      href: geographyNavigationUrlFromState({
        ok: true,
        geo: `${selected.type}:${selected.id}`,
        key: selected.key,
        type: selected.type,
        id: selected.id,
        surface: GEOGRAPHY_NAVIGATION_SURFACE_RECORDS,
        lens,
      }, { base }),
    }));

  // Broader-district suggestions stay labeled and never enter exact neighborhood counts.
  const broaderDistricts = Object.freeze((Array.isArray(relatedDistricts) ? relatedDistricts : [])
    .filter((row) => row && (row.key || row.id) && row.href)
    .map((row) => freezeDeep({
      key: String(row.key || ""),
      id: row.id == null ? null : String(row.id),
      label: String(row.label || row.key || ""),
      href: String(row.href),
      scope: "broader",
      count: null,
    })));

  return freezeDeep({
    schema: RESIDENT_GEOGRAPHY_OVERLAP_SCHEMA,
    ok: true,
    empty: false,
    selected: {
      key: selected.key,
      type: selected.type,
      id: selected.id,
      label: selectedLabelText,
      type_explanation: typeExplanation,
      selection_noun: noun,
      boundary_vintage: selected.boundary_vintage,
      href: selectedHref,
    },
    compare_type: effectiveCompare,
    compare_controls: compareControls,
    summary: {
      label: selectedLabelText,
      type_explanation: typeExplanation,
      area: areaSection?.summary || null,
      point: pointSection ? OVERLAP_POINT_HEADING : null,
    },
    point_section: pointSection,
    area_section: areaSection,
    details,
    continuation: {
      label: `${OVERLAP_RECORDS_CONTINUATION_PREFIX} ${noun}`,
      href: continuationHref,
    },
    record_lenses: Object.freeze(recordLensRows),
    related_districts: broaderDistricts,
    drawer: drawer || GEOGRAPHY_NAVIGATION_DRAWER_OPEN,
    focus_token: focusToken,
    hard_negatives: Object.freeze([
      "your district",
      "sole Council district",
      "the Council district for this neighborhood",
      "BK1503 is in Council District 48 only",
    ]),
  });
}

/**
 * Seeded BK1503 council-compare model used by tests and capture fixtures.
 */
export function buildBk1503CouncilOverlapFixtureModel(options = {}) {
  const fixture = GEOGRAPHY_NAVIGATION_AREA_OVERLAP_EXAMPLE;
  const rows = fixture.relations.filter((row) => row.type === "council_district");
  return buildSelectedGeographyOverlapViewModel({
    selected: fixture.selected,
    compareType: "council_district",
    crosswalkRows: rows,
    crosswalkAvailable: true,
    ...options,
  });
}

/**
 * Seeded station-point model: area overlaps stay separate from point containment.
 */
export function buildSheepsheadStationOverlapFixtureModel(options = {}) {
  const fixture = GEOGRAPHY_NAVIGATION_AREA_OVERLAP_EXAMPLE;
  const station = GEOGRAPHY_NAVIGATION_POINT_BUNDLES.find((row) => row.id === "sheepshead-bay-station");
  return buildSelectedGeographyOverlapViewModel({
    selected: fixture.selected,
    compareType: "council_district",
    crosswalkRows: fixture.relations,
    crosswalkAvailable: true,
    pointBundle: station,
    ...options,
  });
}

export function buildCityHallPointOverlapFixtureModel(options = {}) {
  const hall = GEOGRAPHY_NAVIGATION_POINT_BUNDLES.find((row) => row.id === "new-york-city-hall");
  const selected = hall.membership.nta2020;
  return buildSelectedGeographyOverlapViewModel({
    selected: {
      type: "nta2020",
      id: selected.id,
      key: `geography:nta2020:${selected.id}`,
      label: selected.label,
      boundary_vintage: selected.boundary_vintage,
      subtype: selected.subtype,
    },
    compareType: options.compareType ?? "council_district",
    crosswalkRows: options.crosswalkRows ?? null,
    crosswalkAvailable: options.crosswalkAvailable ?? false,
    pointBundle: hall,
    ...options,
  });
}

function renderOverlapRowHtml(row) {
  const pct = row.display_pct ? `<span class="near-geo-overlap-pct">${esc(row.display_pct)}</span>` : "";
  return `<li class="near-geo-overlap-row" data-geography-overlap-key="${esc(row.key)}" data-geography-overlap-id="${esc(row.id)}" data-geography-overlap-material="true">
      <button type="button" class="near-geo-overlap-highlight" data-geography-overlap-highlight="${esc(row.key)}" data-geography-focus-target="${esc(row.key)}">
        <span class="near-geo-overlap-label">${esc(row.label)}</span>
        ${pct}
      </button>
      <a class="near-geo-overlap-select" data-geography-overlap-select="${esc(row.key)}" href="${esc(row.select_href)}">${esc(OVERLAP_SELECT_ACTION_LABEL)}</a>
    </li>`;
}

function renderImmaterialDetails(rows) {
  if (!rows?.length) return "<p>No retained below-threshold relations for this comparison.</p>";
  const items = rows.map((row) => {
    const status = row.status === "below_threshold" ? "below threshold" : "not material for navigation";
    const pct = row.exact_pct_from || "n/a";
    return `<li data-geography-overlap-immaterial="${esc(row.key)}" data-geography-overlap-status="${esc(row.status)}"><span>${esc(row.label)}</span> · ${esc(status)} · exact share ${esc(pct)}</li>`;
  }).join("");
  return `<ul class="near-geo-overlap-immaterial">${items}</ul>`;
}

/**
 * Render drawer body markup. Desktop sidebar and mobile bottom drawer share this order.
 */
export function renderSelectedGeographyOverlapDrawerHtml(model, {
  includeUnselectedHint = true,
} = {}) {
  if (!model || model.empty || !model.selected) {
    if (!includeUnselectedHint) return "";
    return `<div class="near-geo-rail-body" data-geography-overlap-empty="true">
      <p class="near-kicker">Choose a place</p>
      <p>The list shows the same places as the map.</p>
    </div>`;
  }

  const selected = model.selected;
  const compareButtons = (model.compare_controls || []).map((control) => (
    `<a class="near-geo-layer${control.pressed ? " is-active" : ""}" data-geography-compare="${esc(control.type)}" href="${esc(control.href)}"${control.pressed ? ' aria-current="true"' : ""}>${esc(control.label)}</a>`
  )).join("");

  const pointHtml = model.point_section
    ? `<section class="near-geo-overlap-point" data-geography-overlap-point aria-labelledby="near-geo-overlap-point-heading">
        <h3 id="near-geo-overlap-point-heading">${esc(model.point_section.heading)}</h3>
        <ul>${model.point_section.lines.map((line) => (
          `<li data-geography-point-key="${esc(line.key)}">${esc(line.label)}</li>`
        )).join("")}</ul>
      </section>`
    : "";

  let areaHtml = "";
  if (model.area_section) {
    if (!model.area_section.available) {
      areaHtml = `<section class="near-geo-overlap-area" data-geography-overlap-area data-geography-overlap-unavailable="true" aria-labelledby="near-geo-overlap-area-heading">
        <h3 id="near-geo-overlap-area-heading">${esc(OVERLAP_COMPARISON_UNAVAILABLE)}</h3>
        <p data-geography-overlap-unavailable-copy>${esc(model.area_section.summary)}</p>
        <p class="near-geo-overlap-source-context">Selected source: ${esc(model.area_section.source_context?.selected_source || "")}. Comparison source: ${esc(model.area_section.source_context?.target_source || "")}.</p>
      </section>`;
    } else {
      const rows = model.area_section.rows || [];
      areaHtml = `<section class="near-geo-overlap-area" data-geography-overlap-area aria-labelledby="near-geo-overlap-area-heading">
        <h3 id="near-geo-overlap-area-heading">${esc(model.area_section.heading)}</h3>
        <p data-geography-overlap-summary>${esc(model.area_section.summary)}</p>
        ${rows.length
          ? `<ol class="near-geo-overlap-list" data-geography-overlap-list>${rows.map(renderOverlapRowHtml).join("")}</ol>`
          : `<p data-geography-overlap-empty-layer>${esc(OVERLAP_NO_MATERIAL_COPY)}</p>`}
      </section>`;
    }
  } else {
    areaHtml = `<section class="near-geo-overlap-area" data-geography-overlap-area>
      <p>Choose a boundary layer to compare with this ${esc(selected.selection_noun)}.</p>
    </section>`;
  }

  const details = model.details || {};
  const detailsHtml = `<details class="near-geo-overlap-details" data-geography-overlap-details>
      <summary>${esc(OVERLAP_SOURCE_DETAILS_SUMMARY)}</summary>
      <dl>
        <div><dt>Selected id</dt><dd data-geography-detail="selected-id">${esc(selected.id)}</dd></div>
        <div><dt>Selected key</dt><dd data-geography-detail="selected-key">${esc(selected.key)}</dd></div>
        <div><dt>Selected source</dt><dd data-geography-detail="selected-source">${esc(details.selected?.source_name || "")}</dd></div>
        <div><dt>Selected vintage</dt><dd data-geography-detail="selected-vintage">${esc(details.selected?.boundary_vintage || "not published")}</dd></div>
        <div><dt>Comparison layer</dt><dd data-geography-detail="compare-type">${esc(model.compare_type || "none")}</dd></div>
        <div><dt>Comparison source</dt><dd data-geography-detail="compare-source">${esc(details.target_layer?.source_name || "n/a")}</dd></div>
        <div><dt>Overlay method</dt><dd data-geography-detail="method">${esc(details.method || "n/a")}</dd></div>
      </dl>
      ${(model.area_section?.rows || []).map((row) => (
        `<p data-geography-detail-row="${esc(row.key)}">${esc(row.label)} · exact share of selected area ${esc(row.exact_pct_from || "n/a")}${row.exact_pct_to ? ` · exact share of target ${esc(row.exact_pct_to)}` : ""}</p>`
      )).join("")}
      <h4>Retained non-material relations</h4>
      ${renderImmaterialDetails(details.retained_immaterial)}
    </details>`;

  return `<div class="near-geo-rail-body" data-geography-overlap-root data-geography-selected-key="${esc(selected.key)}" data-geography-compare="${esc(model.compare_type || "")}"${model.focus_token ? ` data-geography-focus-restore="${esc(model.focus_token)}"` : ""}>
      <p class="near-kicker">Selected place</p>
      <h2 id="near-geo-overlap-heading" data-geography-selected-label>${esc(selected.label)}</h2>
      <p data-geography-selected-type>${esc(selected.type_explanation)}</p>
      ${(model.related_districts || []).length ? `<section class="near-geo-record-lenses near-geo-broader-suggestions" data-geography-broader-suggestions aria-label="Broader district suggestions">
        <h3>Events and actions in overlapping districts</h3>
        <p>These community districts overlap this neighborhood. Their records cover a broader area and are not counted as exact neighborhood records.</p>
        <ul>${model.related_districts.map((row) => `<li><a data-geography-related-district data-geography-related-scope="broader" data-geography-key="${esc(row.key)}" href="${esc(row.href)}">${esc(row.label)}</a> <span class="near-geo-broader-label">broader</span></li>`).join("")}</ul>
      </section>` : ""}
      <div class="near-geo-overlap-compare" data-geography-compare-controls role="group" aria-label="Compare with">
        <p class="near-geo-overlap-compare-label">Compare with</p>
        <div class="near-geo-layers-primary">${compareButtons}</div>
      </div>
      ${pointHtml}
      ${areaHtml}
      ${detailsHtml}
      ${(model.record_lenses || []).length
        ? `<section class="near-geo-record-lenses" data-geography-record-lenses aria-labelledby="near-geo-record-lenses-heading">
        <h3 id="near-geo-record-lenses-heading">Records in this ${esc(selected.selection_noun)}</h3>
        <ul aria-label="Available record lenses">${model.record_lenses.map((row) => `<li><a data-geography-record-lens="${esc(row.lens)}" href="${esc(row.href)}" aria-label="${esc(`${row.label}: ${row.count} records in this ${selected.selection_noun}`)}">${esc(row.label)} <span class="near-geo-record-lens-count" aria-hidden="true">${esc(row.count)}</span></a></li>`).join("")}</ul>
      </section>`
        : ""}
      <p class="near-geo-overlap-continuation"><a data-geography-overlap-records href="${esc(model.continuation.href)}">${esc(model.continuation.label)}</a></p>
    </div>`;
}

export function renderGeographyOverlapWorkspaceChrome(model, {
  mapSectionHtml = "",
  drawerState = null,
} = {}) {
  const state = drawerState
    || model?.drawer
    || GEOGRAPHY_NAVIGATION_DRAWER_OPEN;
  const open = state !== GEOGRAPHY_NAVIGATION_DRAWER_CLOSED;
  const body = renderSelectedGeographyOverlapDrawerHtml(model);
  return `<div class="near-geo-workspace" data-geography-workspace data-geography-drawer-state="${esc(open ? GEOGRAPHY_NAVIGATION_DRAWER_OPEN : GEOGRAPHY_NAVIGATION_DRAWER_CLOSED)}"${model?.focus_token ? ` data-geography-focus-restore="${esc(model.focus_token)}"` : ""}>
      <aside class="near-geo-rail near-geo-drawer" data-geography-drawer aria-labelledby="near-geo-overlap-heading">
        <button type="button" class="near-geo-drawer-toggle js-only" data-geography-drawer-toggle hidden aria-expanded="${open ? "true" : "false"}">Map details</button>
        ${body}
      </aside>
      ${mapSectionHtml}
    </div>`;
}

/**
 * Focus restoration helpers for mobile drawer dismiss.
 */
export function rememberOverlapInvoker(token, element, store = globalThis) {
  if (!token || !element) return;
  const bag = store.__cityscrollOverlapFocus__ || (store.__cityscrollOverlapFocus__ = Object.create(null));
  bag[String(token)] = element;
}

export function restoreOverlapInvokerFocus(token, {
  store = globalThis,
  root = null,
} = {}) {
  const key = String(token || "");
  const bag = store.__cityscrollOverlapFocus__ || Object.create(null);
  const remembered = bag[key];
  if (remembered && typeof remembered.focus === "function") {
    remembered.focus({ preventScroll: true });
    return remembered;
  }
  if (!root) return null;
  const fallback = root.querySelector(
    `[data-geography-key="${cssEscape(key)}"], [data-geography-overlap-highlight="${cssEscape(key)}"], #near-map-heading, [data-geography-layer-active]`,
  );
  fallback?.focus?.({ preventScroll: true });
  return fallback || null;
}

function cssEscape(value) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return String(value).replace(/["\\]/g, "\\$&");
}

/**
 * Escape dismisses transient hover/help only; durable selection stays.
 */
export function overlapEscapePolicy() {
  return freezeDeep({
    clears_hover: true,
    clears_focus_ring: true,
    clears_help: true,
    clears_selection: false,
    closes_drawer: false,
  });
}

/**
 * Load committed crosswalk rows for one selection from an in-memory manifest+shards map.
 * Browser code should fetch JSON then call this; never recompute from simplified geometry.
 */
export function crosswalkRowsFromCommittedArtifacts({
  selectedKey,
  compareType,
  manifest,
  shards,
} = {}) {
  if (!selectedKey || !compareType || !manifest || !shards) {
    return { available: false, rows: Object.freeze([]), reason: "missing_inputs" };
  }
  const pairId = `nta2020__${compareType}`;
  const shardMeta = (manifest.shards || []).find((entry) => entry.pair_id === pairId);
  const shard = shards[pairId] || (shardMeta ? shards[shardMeta.path] : null);
  if (!shard) {
    return { available: false, rows: Object.freeze([]), reason: "missing_shard" };
  }
  const expectedFrom = manifest.source_layers?.nta2020?.boundary_vintage;
  const expectedTo = manifest.source_layers?.[compareType]?.boundary_vintage;
  if (
    expectedFrom
    && shard.source_vintages?.from
    && shard.source_vintages.from !== expectedFrom
  ) {
    return { available: false, rows: Object.freeze([]), reason: "stale_from_vintage" };
  }
  if (
    expectedTo
    && shard.source_vintages?.to
    && shard.source_vintages.to !== expectedTo
  ) {
    return { available: false, rows: Object.freeze([]), reason: "stale_to_vintage" };
  }
  const rows = (shard.rows || []).filter((row) => row.from_key === selectedKey);
  return {
    available: true,
    rows: Object.freeze(rows.map((row) => freezeDeep({ ...row }))),
    reason: null,
    method: shard.method || null,
    source_vintages: shard.source_vintages || null,
  };
}

export function siteCrosswalkManifestUrl(siteRoot = "/") {
  const root = String(siteRoot || "/").replace(/\/?$/, "/");
  return `${root}data/geography/crosswalks/manifest.json`;
}

export function siteCrosswalkShardUrl(relativePath, siteRoot = "/") {
  const root = String(siteRoot || "/").replace(/\/?$/, "/");
  const cleaned = String(relativePath || "").replace(/^site\//, "").replace(/^\//, "");
  return `${root}${cleaned}`;
}

/**
 * Async browser/server loader over committed shards. Failures become unavailable.
 */
export async function loadCrosswalkRowsForSelection(selectedKey, compareType, {
  fetchImpl = globalThis.fetch,
  siteRoot = "/",
} = {}) {
  if (!selectedKey || !compareType) {
    return { available: false, rows: Object.freeze([]), reason: "missing_inputs" };
  }
  try {
    const manifestResponse = await fetchImpl(siteCrosswalkManifestUrl(siteRoot), {
      headers: { Accept: "application/json" },
    });
    if (!manifestResponse?.ok) {
      return { available: false, rows: Object.freeze([]), reason: "manifest_unavailable" };
    }
    const manifest = await manifestResponse.json();
    const pairId = `nta2020__${compareType}`;
    const shardMeta = (manifest.shards || []).find((entry) => entry.pair_id === pairId);
    if (!shardMeta?.path) {
      return { available: false, rows: Object.freeze([]), reason: "missing_shard" };
    }
    const shardResponse = await fetchImpl(siteCrosswalkShardUrl(shardMeta.path, siteRoot), {
      headers: { Accept: "application/json" },
    });
    if (!shardResponse?.ok) {
      return { available: false, rows: Object.freeze([]), reason: "shard_unavailable" };
    }
    const shard = await shardResponse.json();
    return crosswalkRowsFromCommittedArtifacts({
      selectedKey,
      compareType,
      manifest,
      shards: { [pairId]: shard },
    });
  } catch {
    return { available: false, rows: Object.freeze([]), reason: "load_failed" };
  }
}

export const __test__ = Object.freeze({
  parseGeographyKey,
  labelForGeographyId,
  selectedTypeExplanation,
  METHOD_COPY,
});
