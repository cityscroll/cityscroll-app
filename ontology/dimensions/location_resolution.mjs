// Dimension: location-resolution
// Measures whether lens records are located, geocoded pins resolve both
// resident-facing district types, boundary data carries a current vintage,
// and the map surface's per-district aggregates are not silently zero-located.

import { makeDimensionCard } from "./shared.mjs";

export const DIMENSION_ID = "location-resolution";

/** Place-based map lenses that must not ship as all-zero when the corpus has rows. */
export const MAP_PLACE_LENSES = Object.freeze([
  "land",
  "property",
  "rules",
  "meetings",
  "money",
]);

const rate = (numerator, denominator) => denominator > 0 ? numerator / denominator : null;

export function evaluateLocationResolution(input = {}) {
  const inventory = input.location_resolution || {};
  const lenses = Array.isArray(inventory.lenses) ? inventory.lenses : [];
  const pins = Array.isArray(inventory.geocoded_pins) ? inventory.geocoded_pins : [];
  const boundaries = Array.isArray(inventory.boundaries) ? inventory.boundaries : [];
  // Map aggregates: prefer explicit input (live flywheel), else inventory stamp.
  const mapActivity = input.district_activity
    || inventory.map_aggregates
    || inventory.district_activity
    || null;
  const cards = [];

  const lens_rates = {};
  for (const lens of lenses) {
    const id = slugify(lens.lens || lens.id);
    const expected = Number(lens.expected_located) || 0;
    const located = Number(lens.located) || 0;
    const locatedRate = rate(located, expected);
    lens_rates[id] = {
      corpus: lens.corpus || null,
      expected_located: expected,
      located,
      located_rate: locatedRate,
      missed_ids: lens.missed_ids || [],
    };
    if (locatedRate == null || locatedRate >= 1) continue;
    cards.push(makeDimensionCard({
      dimension: DIMENSION_ID,
      slug: `located-${id}`,
      title: `Resolve unlocated ${lens.label || id} records in the golden corpus`,
      rank_score: 88,
      evidence: {
        kind: "located-rate",
        lens: id,
        corpus: lens.corpus || null,
        located,
        expected_located: expected,
        located_rate: locatedRate,
        missed_ids: lens.missed_ids || [],
      },
      verify: "node tools/build_location_resolution_inventory.mjs --check --gate located",
      demo_win: `${lens.label || id} records with stated geography resolve to a reader-visible place.`,
      context: [lens.corpus, "ontology/fixtures/dimensions/location_resolution.json"].filter(Boolean),
      lesson_class: "spatial-location-recall",
    }));
  }

  // Map surface: zero-located lens on a non-empty district_activity corpus is a wiring bug
  // (extractors locate but precompute never counted). Distinct from golden-corpus rates.
  const map_lens_rates = {};
  const mapSources = mapActivity?.sources && typeof mapActivity.sources === "object"
    ? mapActivity.sources
    : {};
  for (const lensId of MAP_PLACE_LENSES) {
    const src = mapSources[lensId] || {};
    const counted = Number(src.counted) || 0;
    const located = Number(src.located) || 0;
    const locatedRate = rate(located, counted);
    map_lens_rates[lensId] = {
      corpus: src.corpus || null,
      counted,
      located,
      located_rate: locatedRate,
    };
    if (counted < 1) continue;
    if (located >= 1) continue;
    // money often has no serving geography in the OCP warehouse slice — still flag when
    // counted>0 and located=0 so the wiring gap is visible; rank below place-critical lenses.
    const placeCritical = lensId === "meetings" || lensId === "land" || lensId === "property";
    cards.push(makeDimensionCard({
      dimension: DIMENSION_ID,
      slug: `map-zero-located-${lensId}`,
      title: `Map density shows zero located ${lensId} events citywide`,
      rank_score: placeCritical ? 95 : 86,
      evidence: {
        kind: "map-zero-located",
        lens: lensId,
        corpus: src.corpus || null,
        counted,
        located,
        located_rate: locatedRate,
        surface: "district_activity",
      },
      verify: "node tools/build_district_activity.mjs --check",
      demo_win: `The map density view shows nonzero located ${lensId} activity where the corpus has placeable rows.`,
      context: [
        "site/data/district_activity.json",
        "tools/lib/district_activity.mjs",
        "ontology/fixtures/dimensions/location_resolution.json",
      ],
      lesson_class: "spatial-map-aggregate-wiring",
    }));
  }

  const geocoded = pins.filter((pin) => hasCoordinates(pin));
  const communityResolved = geocoded.filter((pin) => clean(pin.community_district)).length;
  const councilResolved = geocoded.filter((pin) => clean(pin.council_district)).length;
  const bothResolved = geocoded.filter(
    (pin) => clean(pin.community_district) && clean(pin.council_district),
  ).length;
  const district_rates = {
    geocoded_pins: geocoded.length,
    community_resolved: communityResolved,
    community_resolution_rate: rate(communityResolved, geocoded.length),
    council_resolved: councilResolved,
    council_resolution_rate: rate(councilResolved, geocoded.length),
    both_resolved: bothResolved,
    district_resolution_rate: rate(bothResolved, geocoded.length),
  };
  if (geocoded.length && bothResolved < geocoded.length) {
    cards.push(makeDimensionCard({
      dimension: DIMENSION_ID,
      slug: "district-resolution",
      title: "Resolve community and council districts on every geocoded pin",
      rank_score: 92,
      evidence: {
        kind: "district-resolution-rate",
        ...district_rates,
        unresolved_pin_ids: geocoded
          .filter((pin) => !clean(pin.community_district) || !clean(pin.council_district))
          .map((pin) => pin.id),
      },
      verify: "node tools/build_location_resolution_inventory.mjs --check --gate districts",
      demo_win: "Every mapped place identifies both the community district and City Council district serving it.",
      context: ["worker/src/lib/civic_scope.mjs", "ontology/fixtures/dimensions/location_resolution.json"],
      lesson_class: "spatial-district-resolution",
    }));
  }

  const measuredAt = parseDate(inventory.measured_at);
  const staleBoundaries = boundaries.filter((boundary) => boundaryIsStale(boundary, measuredAt));
  const boundary_metrics = {
    checked: boundaries.length,
    current: boundaries.length - staleBoundaries.length,
    stale: staleBoundaries.length,
    boundary_vintage_current_rate: rate(boundaries.length - staleBoundaries.length, boundaries.length),
  };
  if (staleBoundaries.length) {
    cards.push(makeDimensionCard({
      dimension: DIMENSION_ID,
      slug: "boundary-vintage",
      title: "Contract district boundaries with a current labeled vintage",
      rank_score: 93,
      evidence: {
        kind: "boundary-vintage-staleness",
        measured_at: inventory.measured_at || null,
        ...boundary_metrics,
        stale_boundaries: staleBoundaries.map((boundary) => ({
          id: boundary.id,
          dataset_id: boundary.dataset_id || null,
          vintage_at: boundary.vintage_at || null,
          max_stale_days: boundary.max_stale_days ?? null,
        })),
      },
      verify: "node tools/build_location_resolution_inventory.mjs --check --gate boundary-vintage",
      demo_win: "District labels identify the authoritative boundary release used to resolve each resident-facing pin.",
      context: ["site/data/source_contracts.json", "ontology/fixtures/dimensions/location_resolution.json"],
      lesson_class: "spatial-boundary-vintage",
    }));
  }

  return {
    dimension: DIMENSION_ID,
    metrics: { lens_rates, map_lens_rates, district_rates, boundary_metrics },
    cards,
  };
}

function boundaryIsStale(boundary, measuredAt) {
  const vintageAt = parseDate(boundary?.vintage_at);
  if (!vintageAt || !measuredAt) return true;
  const maxStaleDays = Number(boundary.max_stale_days);
  if (!(maxStaleDays >= 0)) return true;
  return measuredAt.getTime() - vintageAt.getTime() > maxStaleDays * 86400000;
}

function parseDate(value) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
}

function hasCoordinates(pin) {
  return Number.isFinite(pin?.latitude) && Number.isFinite(pin?.longitude);
}

function clean(value) {
  return String(value ?? "").trim();
}

function slugify(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown";
}
