/**
 * Fail-closed regulatory-effect axis for ZM project briefs.
 *
 * Verify: node --test test/land_regulatory_effect_axis.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  LAND_REGULATORY_EFFECT_OPTIONS,
  ZONING_MAX_FAR_TABLE,
  deriveLandRegulatoryEffect,
  landRegulatoryEffectChipHTML,
  landRowMatchesRegulatoryEffect,
  normalizeLandRegulatoryEffect,
} from "../site/land_regulatory_effect.mjs";

test("public regulatory-effect modules stay inside the built site boundary", () => {
  const effectModule = readFileSync(new URL("../site/land_regulatory_effect.mjs", import.meta.url), "utf8");
  const codesModule = readFileSync(new URL("../site/land_use_action_codes.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(effectModule, /(?:from|export\s+\*)\s+["']\.\.\/ontology\//);
  assert.doesNotMatch(codesModule, /(?:from|export\s+\*)\s+["']\.\.\/ontology\//);
  assert.doesNotMatch(effectModule, /^const clean\b/m);
  assert.match(effectModule, /export const ZONING_MAX_FAR_TABLE/);
  assert.match(codesModule, /export function landUseActionCodes/);
});
import {
  LAND_FAMILY_OPTIONS,
  landFacetOptionCounts,
  landUseFamilies,
} from "../site/land_status_facets.mjs";
import { filterLandSnapshot } from "../site/resident_snapshot_queries.mjs";
import { buildNearYouViewModel } from "../site/near_you_view.mjs";
import {
  routeHashFromScope,
  scopeFromRouteHash,
  scopeFromWatch,
  watchFromScope,
} from "../site/scope_v0.mjs";
import { rowToSodaShape } from "../warehouse/lib/zap_lookup.mjs";

const bedford = {
  project_id: "2026K0123",
  project_name: "1550 Bedford Avenue Rezoning",
  actions: "UK; ZM; ZR; EAS",
  project_status: "Active",
  public_status: "In Public Review",
  ulurp_non: "ULURP",
  project_brief: "1550 Bedford Avenue LLC is proposing a Zoning Map Amendment from C8-2 to R9A/C2-4 and a Zoning Text Amendment to map MIH.",
};

test("1550 Bedford derives an upzone from cited C8-2 to R9A/C2-4 districts", () => {
  const result = deriveLandRegulatoryEffect(bedford);
  assert.equal(result.effect, "upzone");
  assert.equal(result.confidence, "medium", "recognized overlay grammar lowers confidence to medium");
  assert.deepEqual(result.existing.districts.map(({ id }) => id), ["C8-2"]);
  assert.deepEqual(result.proposed.districts.map(({ id }) => id), ["R9A", "C2-4"]);
  assert.equal(result.existing.max_far, 2);
  assert.equal(result.proposed.max_far, 9.02);
  assert.equal(result.proposed.districts[0].citation.section, "ZR 23-22");
  assert.equal(result.existing.districts[0].citation.section, "ZR 33-122");
  assert.equal(result.proposed.districts[1].kind, "commercial_overlay");
});

test("materialization retains the derived stamp but not the full publisher brief", () => {
  const row = rowToSodaShape(bedford);
  assert.equal(row.regulatory_effect, "upzone");
  assert.equal(row.regulatory_effect_confidence, "medium");
  assert.equal(row.regulatory_effect_basis.existing.districts[0].id, "C8-2");
  assert.equal("project_brief" in row, false);
});

test("non-ZM and pairless ZM records fail closed", () => {
  assert.deepEqual(
    deriveLandRegulatoryEffect({
      project_id: "2026M0164",
      actions: "CM",
      project_brief: "Renewal of a previously approved special permit.",
    }),
    { effect: "unknown", confidence: "unknown", reason: "not_map_amendment" },
  );
  assert.deepEqual(
    deriveLandRegulatoryEffect({ actions: "ZM", project_brief: "A zoning map amendment in Brooklyn." }),
    { effect: "unknown", confidence: "unknown", reason: "district_pair_missing" },
  );
  assert.deepEqual(
    deriveLandRegulatoryEffect({ actions: "UK", project_brief: "Change an R4 district to an R6A district." }),
    { effect: "unknown", confidence: "unknown", reason: "unverified_map_amendment" },
  );
});

test("pair grammar strips special-district wrappers and supports parentheticals", () => {
  const result = deriveLandRegulatoryEffect({
    actions: "ZM",
    project_brief: "The proposal changes the zoning map (R6 (OP) to R7-3/C2-4 (BR)).",
  });
  assert.equal(result.effect, "upzone");
  assert.deepEqual(result.existing.districts.map(({ id }) => id), ["R6"]);
  assert.deepEqual(result.proposed.districts.map(({ id }) => id), ["R7-3", "C2-4"]);

  const pairWithoutCodes = deriveLandRegulatoryEffect({
    project_brief: "Change an R5 district to an R7A district.",
  });
  assert.equal(pairWithoutCodes.effect, "upzone", "an explicit district pair independently proves the map amendment");
  assert.equal(pairWithoutCodes.confidence, "high");
});

test("explicit overlay-only grammar is medium no-density-change", () => {
  const result = deriveLandRegulatoryEffect({
    actions: "ZM",
    project_brief: "Map a C2-4 commercial overlay in an R6 district.",
  });
  assert.equal(result.effect, "no_density_change");
  assert.equal(result.confidence, "medium");
  assert.deepEqual(result.existing.districts.map(({ id }) => id), ["R6"]);
  assert.deepEqual(result.proposed.districts.map(({ id }) => id), ["R6", "C2-4"]);
});

test("table misses and irreconcilable pairs fail closed; opposing valid pairs are mixed", () => {
  assert.equal(deriveLandRegulatoryEffect({
    actions: "ZM",
    project_brief: "Rezone from R6 to M1-6.",
  }).effect, "unknown");
  assert.equal(deriveLandRegulatoryEffect({
    actions: "ZM",
    project_brief: "Rezone from R6 to R7A and from R6 to R5D.",
  }).effect, "unknown", "the same source district cannot have two proposed districts");
  assert.equal(deriveLandRegulatoryEffect({
    actions: "ZM",
    project_brief: "Rezone from R6 to R7A. Separately rezone from R8A to R5D.",
  }).effect, "mixed");
});

test("closed FAR table is versioned and cites only published Zoning Resolution sections", () => {
  assert.equal(ZONING_MAX_FAR_TABLE.schema, "cityscroll.zoning_max_far.v1");
  assert.equal(ZONING_MAX_FAR_TABLE.as_of, "2025-12-31");
  assert.deepEqual(ZONING_MAX_FAR_TABLE.sources.map(({ section }) => section), [
    "ZR 23-21",
    "ZR 23-22",
    "ZR 33-121",
    "ZR 33-122",
  ]);
  assert.equal(ZONING_MAX_FAR_TABLE.districts.R9A.max_far, 9.02);
  assert.equal(ZONING_MAX_FAR_TABLE.districts["C8-2"].max_far, 2);
  assert.equal(ZONING_MAX_FAR_TABLE.overlays["C2-4"].kind, "commercial_overlay");
});

test("public chips show only high or medium derived effects", () => {
  const labels = {
    land_regulatory_effect_upzone: "Upzoning",
    land_regulatory_effect_downzone: "Downzoning",
    land_regulatory_effect_derived: "derived from the project brief",
  };
  const t = (key) => labels[key] || key;
  const medium = landRegulatoryEffectChipHTML(bedford, { t });
  assert.match(medium, /data-land-regulatory-effect="upzone"/);
  assert.match(medium, /Upzoning/);
  assert.match(medium, /derived from the project brief/);
  assert.equal(landRegulatoryEffectChipHTML({ actions: "ZM", project_brief: "No pair here." }, { t }), "");
  assert.equal(landRegulatoryEffectChipHTML({
    regulatory_effect: "upzone",
    regulatory_effect_confidence: "low",
  }, { t }), "");
});

test("derived effect remains orthogonal to action family and supports an honestly empty downzone facet", () => {
  const upzone = { ...bedford, regulatory_effect: "upzone", regulatory_effect_confidence: "medium" };
  const unknown = {
    project_id: "NO-PAIR",
    actions: "ZM",
    project_status: "Active",
    public_status: "In Public Review",
    ulurp_non: "ULURP",
    project_brief: "A zoning map amendment without a district pair.",
  };
  assert.deepEqual(landUseFamilies(upzone), ["rezoning"]);
  assert.equal(LAND_FAMILY_OPTIONS.some(({ id }) => ["upzone", "downzone"].includes(id)), false);
  assert.equal(normalizeLandRegulatoryEffect("down-zone"), "downzone");
  assert.equal(landRowMatchesRegulatoryEffect(upzone, "upzone"), true);
  assert.equal(landRowMatchesRegulatoryEffect(unknown, "upzone"), false);

  const counts = landFacetOptionCounts([upzone, unknown], [], {
    stage: "any",
    procedure: "review",
    family: "any",
    regulatoryEffect: "any",
  });
  assert.equal(counts.regulatory_effect.upzone, 1);
  assert.equal(counts.regulatory_effect.downzone, 0);
  assert.deepEqual(LAND_REGULATORY_EFFECT_OPTIONS.map(({ id }) => id), [
    "any", "upzone", "downzone", "mixed", "no_density_change",
  ]);

  const filtered = filterLandSnapshot([upzone, unknown], {
    status: "all",
    stage: "any",
    procedure: "review",
    regulatoryEffect: "downzone",
  });
  assert.deepEqual(filtered, []);
});

test("derived effect survives Browse, Near-you, and watch scope adapters", () => {
  const facet = encodeURIComponent(JSON.stringify({ regulatoryEffect: "downzone" }));
  const original = `#land?boro=Brooklyn&family=rezoning&facet=${facet}`;
  const scope = scopeFromRouteHash(original);
  assert.equal(scope.facets.values.family, "rezoning");
  assert.equal(scope.facets.values.regulatoryEffect, "downzone");
  assert.equal(routeHashFromScope(scope, { surface: "land" }), original);
  const watch = watchFromScope(scope, { lens: "land" });
  assert.equal(watch.filter.regulatoryEffect, "downzone");
  assert.equal(routeHashFromScope(scopeFromWatch(watch), { surface: "land" }), original);

  const activity = {
    boundary_vintage: "2026-05-26",
    built_at: "2026-08-18T12:00:00.000Z",
    by_level: { borough: { Brooklyn: { land: 2 } }, community_district: {}, council_district: {} },
    citywide: { land: 0 },
    virtual: { land: 0 },
    unlocated: { land: 0 },
    district_items: {
      by_level: { borough: { Brooklyn: { land: ["UP", "UNKNOWN"] } }, community_district: {}, council_district: {} },
      citywide: { land: [] },
      virtual: { land: [] },
      unlocated: { land: [] },
    },
    records: { land: {
      UP: { id: "UP", title: "Known upzoning", route: "/#land/UP", actions: "ZM", regulatory_effect: "upzone", regulatory_effect_confidence: "high" },
      UNKNOWN: { id: "UNKNOWN", title: "Unclassified rezoning", route: "/#land/UNKNOWN", actions: "ZM", regulatory_effect: "unknown", regulatory_effect_confidence: "unknown" },
    } },
  };
  const boundaries = {
    boundary_vintage: "2026-05-26",
    community_districts: [],
    council_districts: [],
    boroughs: [{ id: "Brooklyn", name: "Brooklyn", rings: [] }],
  };
  const upzoneScope = scopeFromRouteHash(`#land?boro=Brooklyn&facet=${encodeURIComponent(JSON.stringify({ regulatoryEffect: "upzone" }))}`);
  assert.deepEqual(buildNearYouViewModel(upzoneScope, activity, boundaries).results.ids, ["UP"]);
});

test("the rendered facet identifies the effect as derived and contains no empty-state apology", () => {
  const html = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
  assert.match(html, /id="leffect"/);
  assert.match(html, /derived from the project brief/i);
  assert.doesNotMatch(html, /no downzonings|downzonings? (?:are )?not (?:yet )?(?:available|found)/i);
});
