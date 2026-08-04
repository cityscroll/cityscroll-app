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

  // Granularity regression: borough (or CD) density with all-zero finer level = finding.
  // Pure helper lives next to the map model so tests can call it without the flywheel.
  const granularity_findings = [];
  if (mapActivity?.by_level) {
    const levelTotal = (level, lens) => {
      const bag = mapActivity.by_level[level] || {};
      let sum = 0;
      for (const [id, counts] of Object.entries(bag)) {
        if (level === "borough" && (id === "Citywide" || id === "Virtual")) continue;
        sum += Number(counts?.[lens]) || 0;
      }
      return sum;
    };
    for (const lensId of ["land", "property", "meetings"]) {
      const boroughN = levelTotal("borough", lensId);
      const cdN = levelTotal("community_district", lensId);
      const councilN = levelTotal("council_district", lensId);
      if (boroughN > 0 && cdN === 0) {
        const finding = {
          kind: "granularity-zero-collapse",
          lens: lensId,
          level: "community_district",
          borough: boroughN,
          community_district: cdN,
          council_district: councilN,
        };
        granularity_findings.push(finding);
        cards.push(makeDimensionCard({
          dimension: DIMENSION_ID,
          slug: `map-granularity-cd-${lensId}`,
          title: `Map ${lensId} density collapses to zero at community-district level`,
          rank_score: 94,
          evidence: { ...finding, surface: "district_activity" },
          verify: "node tools/build_district_activity.mjs --check",
          demo_win: `${lensId} events that resolve to a borough also resolve to community districts when the publisher or venue supports it.`,
          context: [
            "site/data/district_activity.json",
            "tools/lib/district_activity.mjs",
            "site/civic_address_geocode.mjs",
          ],
          lesson_class: "spatial-map-granularity",
        }));
      }
      if ((boroughN > 0 || cdN > 0) && councilN === 0) {
        const finding = {
          kind: "granularity-zero-collapse",
          lens: lensId,
          level: "council_district",
          borough: boroughN,
          community_district: cdN,
          council_district: councilN,
        };
        granularity_findings.push(finding);
        cards.push(makeDimensionCard({
          dimension: DIMENSION_ID,
          slug: `map-granularity-council-${lensId}`,
          title: `Map ${lensId} density collapses to zero at council-district level`,
          rank_score: 94,
          evidence: { ...finding, surface: "district_activity" },
          verify: "node tools/build_district_activity.mjs --check",
          demo_win: `${lensId} events that resolve to a community district also join a City Council district via publisher field or geometry.`,
          context: [
            "site/data/district_activity.json",
            "tools/lib/district_activity.mjs",
            "site/civic_address_geocode.mjs",
          ],
          lesson_class: "spatial-map-granularity",
        }));
      }
    }
    // Virtual-only meetings must surface as a virtual bag, not silent unlocated.
    const virtReason = Number(mapActivity.unlocated_reasons?.meetings?.virtual_only) || 0;
    const virtBag = Number(mapActivity.virtual?.meetings) || 0;
    if (virtReason > 0 && virtBag === 0) {
      granularity_findings.push({
        kind: "virtual-bucket-missing",
        lens: "meetings",
        virtual_reasons: virtReason,
        virtual_bag: virtBag,
      });
      cards.push(makeDimensionCard({
        dimension: DIMENSION_ID,
        slug: "map-virtual-bucket-missing",
        title: "Virtual-only meetings are unlocated without a virtual map bucket",
        rank_score: 90,
        evidence: {
          kind: "virtual-bucket-missing",
          lens: "meetings",
          virtual_reasons: virtReason,
          virtual_bag: virtBag,
          surface: "district_activity",
        },
        verify: "node tools/build_district_activity.mjs --check",
        demo_win: "Virtual-only meetings appear in a labeled Virtual bucket on the map surface.",
        context: ["site/data/district_activity.json", "tools/lib/district_activity.mjs"],
        lesson_class: "spatial-map-granularity",
      }));
    }
  }

  // Residual no_place_signal tail: human-derivation left a high share of a
  // non-empty map corpus without any place signal. Distinct from zero-located
  // wiring bugs — this is extractor coverage debt. Runs without by_level.
  if (mapActivity) {
    const reasons = mapActivity.unlocated_reasons && typeof mapActivity.unlocated_reasons === "object"
      ? mapActivity.unlocated_reasons
      : {};
    for (const lensId of MAP_PLACE_LENSES) {
      const src = mapSources[lensId] || {};
      const counted = Number(src.counted) || 0;
      if (counted < 3) continue;
      const noPlace = Number(reasons?.[lensId]?.no_place_signal) || 0;
      if (noPlace < 1) continue;
      const share = noPlace / counted;
      // Threshold: ≥25% of corpus still no_place_signal (or ≥8 absolute).
      if (share < 0.25 && noPlace < 8) continue;
      const finding = {
        kind: "map-high-no-place-signal",
        lens: lensId,
        counted,
        no_place_signal: noPlace,
        no_place_share: share,
        surface: "district_activity",
      };
      granularity_findings.push(finding);
      cards.push(makeDimensionCard({
        dimension: DIMENSION_ID,
        slug: `map-high-no-place-signal-${lensId}`,
        title: `Map ${lensId} corpus still has a high no_place_signal residual`,
        rank_score: lensId === "meetings" || lensId === "money" ? 87 : 84,
        evidence: finding,
        verify: "node tools/build_district_activity.mjs --check",
        demo_win: `${lensId} events either resolve to a place/citywide/virtual bag or document a more specific unlocated reason than generic no_place_signal.`,
        context: [
          "site/data/district_activity.json",
          "site/location_derivation.mjs",
          "tools/lib/district_activity.mjs",
        ],
        lesson_class: "spatial-no-place-residual",
      }));
    }
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

  const no_place_findings = (granularity_findings || []).filter(
    (f) => f?.kind === "map-high-no-place-signal",
  );

  return {
    dimension: DIMENSION_ID,
    metrics: {
      lens_rates,
      map_lens_rates,
      district_rates,
      boundary_metrics,
      granularity_findings,
      no_place_findings,
    },
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
