// Per-dimension characterization for the multi-dimension flywheel.
//
//   node --test test/multi_flywheel_dimensions.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  evaluateDataIntegrity,
  computeNotPublishedRate,
  classifyNotPublishedClaim,
  enumerateNotPublishedClaims,
  evaluateNotPublishedClaims,
  NOT_PUBLISHED_THRESHOLDS,
} from "../ontology/dimensions/data_integrity.mjs";
import { evaluateReadability, scoreView } from "../ontology/dimensions/readability.mjs";
import { evaluateOntologyEnrichment } from "../ontology/dimensions/ontology_enrichment.mjs";
import { evaluateCoverage } from "../ontology/dimensions/coverage.mjs";
import { normalizeSourceState } from "../ontology/source_state.mjs";
import { evaluateCrossSourceConsistency } from "../ontology/dimensions/cross_source_consistency.mjs";
import { evaluateLocationResolution } from "../ontology/dimensions/location_resolution.mjs";
import {
  evaluateSurfaceLoad,
  surfaceLoadBreaches,
  emptyStateDensity,
  countApologyPhrases,
  findDuplicateCardFacts,
} from "../ontology/dimensions/surface_load.mjs";
import {
  findCurrencyLeakedDateChips,
  findPastDeadlinesInDefaultView,
  findTenseParityViolations,
  findRepeatedIdenticalButtonActions,
} from "../site/property_list_sanity.mjs";
import { DIMENSION_IDS, DIMENSION_EVALUATORS } from "../ontology/dimensions/index.mjs";
import { checkOntologyRegistrySync } from "../ontology/sync.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadJson(rel) {
  return JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
}

test("dimension catalog lists eight evaluators", () => {
  assert.deepEqual(DIMENSION_IDS, [
    "data-integrity",
    "readability",
    "ontology-enrichment",
    "coverage",
    "cross-source-consistency",
    "location-resolution",
    "surface-load",
    "ontology-coherence",
  ]);
  for (const id of DIMENSION_IDS) {
    assert.equal(typeof DIMENSION_EVALUATORS[id], "function");
  }
});

test("surface-load stays quiet for the green fixture", () => {
  const inventory = loadJson("ontology/fixtures/dimensions/surface_load.json");
  const result = evaluateSurfaceLoad({ surface_load: inventory });
  assert.equal(result.dimension, "surface-load");
  assert.equal(result.metrics.surfaces_complete, 3);
  assert.equal(result.metrics.surfaces_over_budget, 0);
  assert.deepEqual(result.cards, []);
});

test("surface-load emits one evidence-rich card per measured bad surface", () => {
  const overloaded = {
    id: "staffing",
    label: "Staffing",
    route: "#people",
    status: "ok",
    action_required: true,
    budgets: {
      words: 2500,
      links: 150,
      buttons: 80,
      max_verbatim_repeat: 25,
      max_first_action_y: 900,
    },
    measured: {
      words: 3100,
      links: 95,
      buttons: 23,
      max_verbatim_repeat: 80,
      verbatim_duplicates: [{ text: "The same explanatory sentence appears on every row", count: 80 }],
      first_action_y: 5400,
    },
  };
  assert.deepEqual(surfaceLoadBreaches({ ...overloaded, status: "incomplete" }), []);
  const result = evaluateSurfaceLoad({
    surface_load: {
      measured_at: "2026-08-03T12:00:00Z",
      viewport: { width: 1440, height: 900 },
      definitions: [{}],
      surfaces: [overloaded],
    },
  });
  assert.equal(result.metrics.surfaces_over_budget, 1);
  assert.equal(result.metrics.action_position_flags, 1);
  assert.equal(result.metrics.duplication_flags, 1);
  assert.equal(result.cards.length, 1);
  assert.match(result.cards[0].id, /surface-load-surface-staffing$/);
  assert.match(result.cards[0].title, /action-first/);
  assert.equal(result.cards[0].evidence.breaches.length, 3);
  assert.equal(result.cards[0].verify, "python3 tools/sample_surface_load.py --live --only staffing --gate");
});

test("empty-state density flags majority apology blocks and repeated phrases", () => {
  const apologyStack = emptyStateDensity({
    blocks: [
      { text: "Not yet shown here — later disposition notices live in City Record Online.", role: "empty" },
      { text: "No labeled minimum bid, upset price, or appraisal dollar is stated in this notice.", className: "note" },
      { text: "A discount signal needs both a stated appraisal and a minimum bid.", className: "note" },
      { text: "Market-basket discount is not available yet — nothing is invented here.", className: "note" },
      { text: "What is for sale", role: "content" },
    ],
  });
  assert.equal(apologyStack.flagged, true);
  assert.equal(apologyStack.majority_empty, true);
  assert.ok(apologyStack.apology.total > 1);
  assert.ok(apologyStack.apology_repeat_breach);

  const clean = emptyStateDensity({
    blocks: [
      { text: "Vehicles · AUTO AUCTION", role: "content" },
      { text: "Open the sale package on GovDeals", role: "content" },
      { text: "Registration is free", role: "content" },
    ],
  });
  assert.equal(clean.flagged, false);
  assert.equal(clean.majority_empty, false);
  assert.equal(clean.apology.total, 0);

  const counts = countApologyPhrases(
    "Not yet shown here. Not yet shown here. needs both figures.",
  );
  assert.equal(counts.total, 3);
  assert.ok(counts.phrases_hit.includes("not yet shown here"));
});

test("surface-load emits empty-state-density card when apology majority is measured", () => {
  const emptyHeavy = {
    id: "notice-property-destruction",
    label: "Destruction notice",
    route: "#notice/20260526003",
    status: "ok",
    action_required: true,
    budgets: {
      words: 1200,
      links: 80,
      buttons: 50,
      max_verbatim_repeat: 2,
      max_first_action_y: 900,
    },
    measured: {
      words: 400,
      links: 10,
      buttons: 5,
      max_verbatim_repeat: 1,
      verbatim_duplicates: [],
      first_action_y: 200,
      empty_blocks: 6,
      content_blocks: 2,
      visible_text:
        "Not yet shown here. No labeled minimum bid. needs both. not available yet. nothing is invented here.",
    },
  };
  const breaches = surfaceLoadBreaches(emptyHeavy);
  assert.ok(breaches.some((b) => b.kind === "empty-state-density"));
  const result = evaluateSurfaceLoad({
    surface_load: {
      measured_at: "2026-08-03T12:00:00Z",
      surfaces: [emptyHeavy],
    },
  });
  assert.equal(result.metrics.empty_state_flags, 1);
  assert.ok(result.cards.some((c) => /empty-state/i.test(c.title)));
  assert.equal(result.cards[0].lesson_class, "empty-state-density");
});

test("surface-load flags currency-leaked date chips and past closes in default head", () => {
  const chipBad = findCurrencyLeakedDateChips("closes $September 16, 2013");
  assert.equal(chipBad.ok, false);

  const temporalBad = findPastDeadlinesInDefaultView(
    [
      { close_date: "2013-09-16", request_id: "old-1" },
      { close_date: "2014-01-01", request_id: "old-2" },
      { close_date: "2026-09-01", request_id: "open-1" },
    ],
    { today: "2026-08-03", topN: 5 },
  );
  assert.equal(temporalBad.ok, false);
  assert.ok(temporalBad.findings.length >= 2);

  const propertySurface = {
    id: "property-default",
    label: "Property",
    route: "#property",
    status: "ok",
    action_required: true,
    budgets: {
      words: 2500,
      links: 150,
      buttons: 80,
      max_verbatim_repeat: 25,
      max_first_action_y: 900,
    },
    measured: {
      words: 400,
      links: 12,
      buttons: 8,
      max_verbatim_repeat: 1,
      verbatim_duplicates: [],
      first_action_y: 200,
      chip_texts: [
        "closes $September 16, 2013",
        "closes $January 1, 2014",
        "min bid $4,800",
      ],
      today: "2026-08-03",
      default_view_top_cards: [
        { close_date: "2013-09-16", request_id: "20130916001" },
        { close_date: "2014-01-01", request_id: "20140101001" },
      ],
    },
  };
  const breaches = surfaceLoadBreaches(propertySurface);
  assert.ok(
    breaches.some((b) => b.kind === "chip-format-currency-before-month"),
    "chip-format detector must fire",
  );
  assert.ok(
    breaches.some((b) => b.kind === "default-view-past-deadline"),
    "temporal-sanity detector must fire",
  );
  const result = evaluateSurfaceLoad({
    surface_load: {
      measured_at: "2026-08-03T12:00:00Z",
      surfaces: [propertySurface],
    },
  });
  assert.equal(result.metrics.chip_format_flags, 1);
  assert.equal(result.metrics.temporal_sanity_flags, 1);
  assert.ok(result.cards.length >= 1);
  assert.match(result.cards[0].lesson_class, /temporal-sanity|chip-format/);
});

test("surface-load flags repeated identical CTAs and past-tense mismatch in visible text", () => {
  const tenseBad = findTenseParityViolations(
    "Current auction closes July 23, 2026 and another closes 2026-01-01",
    { today: "2026-08-05" },
  );
  assert.equal(tenseBad.ok, false);
  assert.equal(tenseBad.findings.length, 2);

  const ctaBad = findRepeatedIdenticalButtonActions([
    { section: "property-list", label: "Browse GovDeals fleet", href: "https://govdeals.example" },
    { section: "property-list", label: "Browse GovDeals fleet", href: "https://govdeals.example" },
    { section: "property-list", label: "Browse GovDeals fleet", href: "https://govdeals.example" },
    { section: "property-list", label: "Browse GovDeals fleet", href: "https://govdeals.example" },
  ]);
  assert.equal(ctaBad.ok, false);
  assert.equal(ctaBad.findings.length, 1);
  assert.equal(ctaBad.findings[0].count, 4);

  const surface = {
    id: "property-list",
    label: "Property list",
    route: "#property",
    status: "ok",
    action_required: true,
    budgets: {
      words: 5000,
      links: 500,
      buttons: 100,
      max_verbatim_repeat: 149,
      max_first_action_y: 900,
    },
    measured: {
      words: 500,
      links: 120,
      buttons: 80,
      max_verbatim_repeat: 1,
      verbatim_duplicates: [],
      first_action_y: 120,
      today: "2026-08-05",
      visible_text: "Auction closes July 23, 2026 for city fleet listings.",
      action_links: [
        { section: "property-list", label: "Browse GovDeals fleet", href: "https://govdeals.example" },
        { section: "property-list", label: "Browse GovDeals fleet", href: "https://govdeals.example" },
        { section: "property-list", label: "Browse GovDeals fleet", href: "https://govdeals.example" },
        { section: "property-list", label: "Browse GovDeals fleet", href: "https://govdeals.example" },
      ],
    },
  };
  const breaches = surfaceLoadBreaches(surface);
  assert.ok(breaches.some((b) => b.kind === "tense-parity-active-past"));
  assert.ok(breaches.some((b) => b.kind === "repeated-identical-cta"));
  const result = evaluateSurfaceLoad({
    surface_load: {
      measured_at: "2026-08-05T12:00:00Z",
      surfaces: [surface],
    },
  });
  assert.equal(result.metrics.tense_parity_flags, 1);
  assert.equal(result.metrics.repeated_cta_flags, 1);
  assert.equal(result.metrics.surfaces_over_budget, 1);
  assert.ok(result.cards.length >= 1);
});

test("surface-load flags the same semantic fact repeated within one card", () => {
  const duplicateFacts = findDuplicateCardFacts([
    {
      card_id: "rule-1",
      facts: [
        { key: "comment-deadline:2026-08-19", text: "Comments open until August 19" },
        { key: "stage:public-process", text: "Public process" },
        { key: "comment-deadline:2026-08-19", text: "Comment by August 19" },
      ],
    },
    {
      card_id: "rule-2",
      facts: [
        { key: "comment-deadline:2026-09-01", text: "Comment by September 1" },
      ],
    },
  ]);
  assert.equal(duplicateFacts.ok, false);
  assert.equal(duplicateFacts.findings.length, 1);
  assert.equal(duplicateFacts.findings[0].card_id, "rule-1");
  assert.equal(duplicateFacts.findings[0].key, "comment-deadline:2026-08-19");

  const breaches = surfaceLoadBreaches({
    status: "ok",
    action_required: false,
    measured: {
      card_facts: [
        {
          card_id: "rule-1",
          facts: [
            { key: "comment-deadline:2026-08-19", text: "Comments open until August 19" },
            { key: "comment-deadline:2026-08-19", text: "Comment by August 19" },
          ],
        },
      ],
    },
  });
  assert.ok(breaches.some((breach) => breach.kind === "duplicate-card-fact"));
});

test("computeNotPublishedRate combines recent + historical population", () => {
  const rate = computeNotPublishedRate({
    recent: { size: 20, not_published: 20 },
    historical: { size: 20, not_published: 20 },
    non_null_examples: 0,
  });
  assert.equal(rate.n, 40);
  assert.equal(rate.not_published, 40);
  assert.equal(rate.rate, 1);
  assert.equal(rate.rate_label, "40/40");
  assert.equal(rate.spread_ok, true);

  const healthy = computeNotPublishedRate({
    recent: { size: 15, not_published: 2 },
    historical: { size: 15, not_published: 1 },
    non_null_examples: 27,
  });
  assert.equal(healthy.n, 30);
  assert.ok(healthy.rate < 0.2);
  assert.equal(healthy.non_null, 27);
});

test("classifyNotPublishedClaim flags ~100% when public source has data", () => {
  const rate = computeNotPublishedRate({
    recent: { size: 20, not_published: 20 },
    historical: { size: 20, not_published: 20 },
  });
  const red = classifyNotPublishedClaim(rate, {
    sample: {
      public_source_has_data: true,
      classification_hint: "mislabeled",
    },
  });
  assert.equal(red.red_flag, true);
  assert.equal(red.classification, "mislabeled");

  const withheld = classifyNotPublishedClaim(rate, {
    sample: {
      public_source_has_data: false,
      classification_hint: "genuinely_withheld",
    },
  });
  assert.equal(withheld.red_flag, false);
  assert.equal(withheld.classification, "genuinely_withheld");

  const tiny = classifyNotPublishedClaim(
    computeNotPublishedRate({ recent: { size: 2, not_published: 2 } }),
    { sample: { public_source_has_data: true } },
  );
  assert.equal(tiny.classification, "insufficient_sample");
  assert.equal(tiny.red_flag, false);
  assert.ok(NOT_PUBLISHED_THRESHOLDS.red_flag_rate >= 0.95);
});

test("data-integrity core: population not-published-rate emits red flags continuously", () => {
  const gap_taxonomy = loadJson("site/data/gap_taxonomy.json");
  const samples = loadJson("ontology/fixtures/dimensions/not_published_claim_samples.json");
  const features = loadJson("ontology/fixtures/dimensions/data_integrity_features.json");

  const enumerated = enumerateNotPublishedClaims(gap_taxonomy);
  assert.ok(enumerated.some((c) => c.id === "subsidy-field-company-place-money"));
  assert.ok(enumerated.every((c) => c.source === "gap_taxonomy" || c.id));

  const result = evaluateDataIntegrity({
    gap_taxonomy,
    not_published_samples: samples,
    features: features.features,
  });
  assert.equal(result.dimension, "data-integrity");
  assert.ok(result.metrics.not_published_claims_checked >= 5);
  assert.ok(result.metrics.not_published_red_flags >= 2, "expected ≥2 red flags");
  assert.ok(result.metrics.not_published_genuinely_withheld >= 1);
  assert.ok(result.metrics.not_published_healthy >= 1);

  // Core red flags from credibility audit
  assert.ok(
    result.cards.some((c) => c.id.includes("subsidy-field-company-place-money")),
    "Build NYC money ~100% not-published red flag",
  );
  assert.ok(
    result.cards.some((c) => c.id.includes("meeting-person-votes")),
    "person votes never-ingested red flag",
  );
  // Genuinely withheld package docs must NOT emit a red-flag bug card
  assert.ok(
    !result.cards.some((c) => c.id.includes("procurement-solicitation-documents") && c.evidence?.kind === "not_published_rate_red_flag"),
    "package documents are verified withhold, not a join bug",
  );

  const money = result.findings.find((f) => f.claim_id === "subsidy-field-company-place-money");
  assert.ok(money);
  assert.equal(money.red_flag, true);
  assert.equal(money.rate.rate, 1);
  assert.equal(money.classification, "mislabeled");

  // Secondary feature inventory still works
  assert.ok(result.metrics.features_checked >= 5);
  assert.ok(result.cards.some((c) => c.id.includes("passport.rfx_document_url")));
  assert.ok(result.cards.some((c) => c.id.includes("bid-tabulations.bid_count")));
  assert.ok(!result.cards.some((c) => c.id.includes("legistar.person_vote") && c.evidence?.method === "feature_non_null_example"));

  for (const card of result.cards) {
    assert.equal(card.dimension, "data-integrity");
    assert.ok(card.verify);
    assert.ok(card.demo_win);
  }

  // Pure path without gap taxonomy still evaluates sample inventory
  const sampleOnly = evaluateNotPublishedClaims(samples.claims);
  assert.ok(sampleOnly.metrics.red_flags >= 2);
});

test("readability scores views and cards unusable ones", () => {
  const good = scoreView({ hierarchy_score: 0.8, density_score: 0.4, dump_smell: 0.1 });
  assert.equal(good.unusable, false);
  assert.ok(good.overall >= 0.5);

  const bad = scoreView({ hierarchy_score: 0.2, density_score: 0.95, dump_smell: 0.9 });
  assert.equal(bad.unusable, true);

  const inventory = loadJson("ontology/fixtures/dimensions/readability_views.json");
  const result = evaluateReadability({ views: inventory.views });
  assert.equal(result.dimension, "readability");
  assert.ok(result.metrics.unusable >= 2);
  assert.ok(result.cards.some((c) => c.id.includes("raw-source-records-dump")));
  assert.ok(result.cards.some((c) => c.id.includes("gap-taxonomy-dense-table")));
  assert.ok(!result.cards.some((c) => c.id.includes("notice-lifecycle-money")));
  for (const card of result.cards) {
    assert.ok(card.evidence.scores);
    assert.ok(card.verify.includes("readability") || card.verify.length > 10);
  }
});

test("ontology-enrichment wraps legacy planner with dimension cards", () => {
  const source_coverage = loadJson("entity_resolution/source_coverage.json");
  const gap_taxonomy = loadJson("site/data/gap_taxonomy.json");
  const result = evaluateOntologyEnrichment({
    source_coverage,
    gap_taxonomy,
    registry_sync: checkOntologyRegistrySync(),
    cross_spine: { checked: 1, contradictions: 0 },
    actionability: { rate: 1, sample_size: 1 },
    temporal_scorecard: loadJson(
      "worker/test/fixtures/civic-time/expected_temporal_completeness.json",
    ),
    lifecycle_coherence_scorecard: loadJson(
      "worker/test/fixtures/lifecycle-coherence/expected_coherence.json",
    ),
    generated_at: "1970-01-01T00:00:00.000Z",
  });
  assert.equal(result.dimension, "ontology-enrichment");
  assert.ok(result.cards.length > 0);
  for (const card of result.cards) {
    assert.equal(card.dimension, "ontology-enrichment");
    assert.equal(card.emitted_by, "multi_flywheel");
    if (!String(card.evidence?.kind || "").includes("scorecard")) {
      assert.ok(card.evidence.legacy_class);
    }
    assert.ok(card.verify);
    assert.ok(card.demo_win);
  }
  assert.equal(result.metrics.temporal_completeness_rate, 0.9091);
  assert.equal(result.metrics.procurement_lifecycle_coherence_rate, 0.5);
  assert.equal(result.metrics.award_solicitation_recovery_rate, 0.8);
  assert.ok(result.cards.some((c) => c.id.includes("temporal-completeness")));
  assert.ok(result.cards.some((c) => c.id.includes("procurement-lifecycle-coherence")));
});

test("coverage emits for dual-write gaps and undeclared source-record coverage", () => {
  const source_contracts = loadJson("site/data/source_contracts.json");
  const source_coverage = loadJson("entity_resolution/source_coverage.json");
  const result = evaluateCoverage({ source_contracts, source_coverage });
  assert.equal(result.dimension, "coverage");
  assert.ok(result.metrics.declared_live >= 1);
  // Known dual-write gaps in source_coverage (e.g. doing-business, nycha)
  const dualWriteCards = result.cards.filter((c) => c.evidence?.kind === "dual-write-gap");
  assert.ok(dualWriteCards.length >= 1, "expected at least one dual-write gap card");
  for (const card of result.cards) {
    assert.equal(card.dimension, "coverage");
    assert.ok(card.verify);
    assert.ok(card.demo_win);
  }
});

test("coverage separates product materialization from immutable source-record coverage", () => {
  const source_contracts = loadJson("site/data/source_contracts.json");
  const source_coverage = loadJson("entity_resolution/source_coverage.json");
  const result = evaluateCoverage({ source_contracts, source_coverage });
  const expectedMaterialized = new Set([
    "ocp-recent-contract-awards",
    "zap-projects",
    "zap-bbl",
  ]);

  for (const sourceId of expectedMaterialized) {
    const contract = source_contracts.contracts.find((entry) => entry.id === sourceId);
    const state = normalizeSourceState({ contract, coverage: null });
    assert.equal(state.acquisition_status, "live");
    assert.equal(state.product_delivery_tier, "edge-materialized");
    assert.equal(state.warehouse_snapshot.status, "materialized");
    assert.equal(state.source_records_coverage.status, "not-declared");

    const card = result.cards.find((entry) => entry.evidence?.source_id === sourceId);
    assert.ok(card, `${sourceId} keeps its D1 observation gap visible`);
    assert.match(card.title, /^Add immutable observation coverage:/);
    assert.equal(card.evidence.source_state.warehouse_snapshot.status, "materialized");
    assert.equal(card.evidence.source_state.source_records_coverage.status, "not-declared");
  }

  assert.ok(!result.cards.some((card) => /^Ingest declared source:/.test(card.title)));
  assert.equal(result.metrics.product_materialized >= expectedMaterialized.size, true);
  assert.equal(result.metrics.source_records_not_declared >= expectedMaterialized.size, true);
});

test("cross-source-consistency emits open disagreements and spine failures", () => {
  const inventory = loadJson("ontology/fixtures/dimensions/cross_source_disagreements.json");
  const failPin = loadJson("ontology/fixtures/cross_spine/fail_pin_mismatch.json");
  const result = evaluateCrossSourceConsistency({
    disagreements: inventory.disagreements,
    claim_labeled_disagree_families: inventory.claim_labeled_disagree_families,
    cross_spine_bundles: [failPin],
  });
  assert.equal(result.dimension, "cross-source-consistency");
  assert.ok(result.metrics.open_disagreements >= 2);
  // Reconciled row must not emit
  assert.ok(!result.cards.some((c) => c.id.includes("demo-reconciled")));
  assert.ok(result.cards.some((c) => c.evidence?.field === "contract_amount"));
  assert.ok(result.cards.some((c) => c.evidence?.kind === "cross-spine-contradiction"));
  assert.equal(result.metrics.claim_families_checked, 2);
  assert.equal(result.metrics.claim_families_below_full_coverage, 1);
  assert.ok(result.cards.some((c) =>
    c.evidence?.join_family === "passport-contracts-x-checkbook-contracts"
    && c.evidence?.public_claim_labeled_disagree_rate === 0));
  assert.ok(!result.cards.some((c) =>
    c.evidence?.join_family === "city-record-x-ocp-awards"));
  for (const card of result.cards) {
    assert.ok(card.verify);
    assert.ok(card.demo_win);
  }
});

test("location-resolution measures corpora, districts, and boundary vintage without card flood", () => {
  const inventory = loadJson("ontology/fixtures/dimensions/location_resolution.json");
  // Healthy map aggregates: every non-empty lens has ≥1 located row.
  const healthyMap = {
    sources: {
      land: { corpus: "zap", counted: 10, located: 10 },
      property: { corpus: "property", counted: 5, located: 5 },
      meetings: { corpus: "meetings", counted: 8, located: 3 },
      rules: { corpus: "rules", counted: 4, located: 1 },
      money: { corpus: "ocp", counted: 2, located: 0 },
    },
  };
  const result = evaluateLocationResolution({
    location_resolution: inventory,
    district_activity: healthyMap,
  });
  assert.equal(result.dimension, "location-resolution");
  assert.equal(result.metrics.lens_rates["meetings-hearings"].located_rate, 1);
  assert.equal(result.metrics.lens_rates.property.located_rate, 1);
  assert.equal(result.metrics.district_rates.community_resolution_rate, 1);
  assert.equal(result.metrics.district_rates.council_resolution_rate, 1);
  assert.equal(result.metrics.district_rates.district_resolution_rate, 1);
  // Shared contracted layer stamps current labeled vintages for both sources.
  assert.equal(result.metrics.boundary_metrics.checked, 2);
  assert.equal(result.metrics.boundary_metrics.stale, 0);
  assert.equal(result.metrics.boundary_metrics.current, 2);
  assert.equal(result.metrics.boundary_metrics.boundary_vintage_current_rate, 1);
  assert.ok(inventory.boundaries.every((b) => b.status === "contracted" && b.vintage_at));
  // money counted with 0 located → map-zero-located card; place-critical lenses healthy.
  assert.ok(result.metrics.map_lens_rates.meetings.located_rate > 0);
  assert.ok(result.cards.some((c) => c.evidence?.kind === "map-zero-located" && c.evidence?.lens === "money"));
  assert.ok(!result.cards.some((c) => c.evidence?.lens === "meetings" && c.evidence?.kind === "map-zero-located"));
});

test("location-resolution emits map-zero-located when place lens is all-zero on map aggregates", () => {
  const inventory = loadJson("ontology/fixtures/dimensions/location_resolution.json");
  const brokenMap = {
    sources: {
      land: { corpus: "zap", counted: 10, located: 10 },
      property: { corpus: "property", counted: 5, located: 5 },
      meetings: { corpus: "meetings", counted: 119, located: 0 },
      rules: { corpus: "rules", counted: 100, located: 0 },
      money: { corpus: "ocp", counted: 8, located: 0 },
    },
  };
  const result = evaluateLocationResolution({
    location_resolution: inventory,
    district_activity: brokenMap,
  });
  assert.ok(result.cards.some((c) =>
    c.evidence?.kind === "map-zero-located" && c.evidence?.lens === "meetings"));
  assert.ok(result.cards.some((c) =>
    c.evidence?.kind === "map-zero-located" && c.evidence?.lens === "rules"));
  assert.equal(result.metrics.map_lens_rates.meetings.located_rate, 0);
  assert.equal(result.metrics.map_lens_rates.meetings.counted, 119);
});

test("location-resolution emits map-high-no-place-signal on residual unlocated tails", () => {
  const inventory = loadJson("ontology/fixtures/dimensions/location_resolution.json");
  const residualMap = {
    sources: {
      land: { corpus: "zap", counted: 10, located: 10 },
      property: { corpus: "property", counted: 5, located: 5 },
      meetings: { corpus: "meetings", counted: 100, located: 60 },
      rules: { corpus: "rules", counted: 4, located: 4 },
      money: { corpus: "ocp", counted: 8, located: 2 },
    },
    unlocated_reasons: {
      meetings: { no_place_signal: 35, virtual_only: 3 },
      money: { no_place_signal: 6 },
    },
    virtual: { meetings: 3 },
  };
  const result = evaluateLocationResolution({
    location_resolution: inventory,
    district_activity: residualMap,
  });
  assert.ok(result.cards.some((c) =>
    c.evidence?.kind === "map-high-no-place-signal" && c.evidence?.lens === "meetings"));
  assert.ok(result.cards.some((c) =>
    c.evidence?.kind === "map-high-no-place-signal" && c.evidence?.lens === "money"));
  assert.ok(Array.isArray(result.metrics.no_place_findings));
  assert.ok(result.metrics.no_place_findings.some((f) => f.lens === "meetings"));
});

test("location-resolution emits granularity-zero-collapse when council density is all-zero", () => {
  const inventory = loadJson("ontology/fixtures/dimensions/location_resolution.json");
  const collapsedMap = {
    sources: {
      land: { corpus: "zap", counted: 10, located: 10 },
      property: { corpus: "property", counted: 5, located: 5 },
      meetings: { corpus: "meetings", counted: 8, located: 8 },
      rules: { corpus: "rules", counted: 4, located: 4 },
      money: { corpus: "ocp", counted: 2, located: 1 },
    },
    by_level: {
      borough: {
        Manhattan: { land: 10, property: 0, rules: 0, meetings: 8, money: 0 },
      },
      community_district: {
        M01: { land: 10, property: 0, rules: 0, meetings: 0, money: 0 },
      },
      council_district: {
        "1": { land: 0, property: 0, rules: 0, meetings: 0, money: 0 },
      },
    },
    citywide: { land: 0, property: 0, rules: 4, meetings: 0, money: 0 },
    virtual: { land: 0, property: 0, rules: 0, meetings: 0, money: 0 },
    unlocated_reasons: { meetings: { virtual_only: 2 } },
  };
  const result = evaluateLocationResolution({
    location_resolution: inventory,
    district_activity: collapsedMap,
  });
  assert.ok(result.cards.some((c) =>
    c.evidence?.kind === "granularity-zero-collapse"
    && c.evidence?.lens === "land"
    && c.evidence?.level === "council_district"));
  assert.ok(result.cards.some((c) =>
    c.evidence?.kind === "granularity-zero-collapse"
    && c.evidence?.lens === "meetings"));
  assert.ok(result.cards.some((c) => c.evidence?.kind === "virtual-bucket-missing"));
  assert.ok(Array.isArray(result.metrics.granularity_findings));
  assert.ok(result.metrics.granularity_findings.length >= 1);
});
