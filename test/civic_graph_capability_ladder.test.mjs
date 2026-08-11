// Civic Graph capability ladder → multi-flywheel cards.
//
//   node --test test/civic_graph_capability_ladder.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  civicGraphCapabilityCards,
  civicGraphCapabilityMetrics,
  LADDER_SCHEMA,
} from "../ontology/dimensions/civic_graph_capability.mjs";
import { evaluateOntologyEnrichment } from "../ontology/dimensions/ontology_enrichment.mjs";
import {
  loadDefaultInputs,
  runMultiFlywheel,
} from "../ontology/flywheel_run.mjs";
import { MULTI_CARD_SCHEMA } from "../ontology/dimensions/shared.mjs";
import { emptyLedger } from "../ontology/card_queue.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadJson(rel) {
  return JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
}

// Rank order after rankCards (score desc, then id) — what the queue emits at #1–#8.
const EXPECTED_RANKED_LADDER_IDS = [
  "crol-list/mf-ontology-enrichment-cg-v1-paid-under-registry",
  "crol-list/mf-ontology-enrichment-cg-v1-payment-row-surface",
  "crol-list/mf-ontology-enrichment-cg-v2-influence-link-types",
  "crol-list/mf-ontology-enrichment-cg-v2-rollcall-event-densify",
  "crol-list/mf-ontology-enrichment-cg-v3-mandate-report-candidates",
  "crol-list/mf-ontology-enrichment-cg-v2-official-walk-surface",
  "crol-list/mf-ontology-enrichment-cg-v3-mandate-rule-evidence-stamps",
  "crol-list/mf-ontology-enrichment-cg-v3-mandate-contract-backlinks",
];

// Emission order from civicGraphCapabilityCards (v1 → v2 → v3 blocks).
const EXPECTED_EMIT_ORDER_IDS = [
  "crol-list/mf-ontology-enrichment-cg-v1-paid-under-registry",
  "crol-list/mf-ontology-enrichment-cg-v1-payment-row-surface",
  "crol-list/mf-ontology-enrichment-cg-v2-influence-link-types",
  "crol-list/mf-ontology-enrichment-cg-v2-rollcall-event-densify",
  "crol-list/mf-ontology-enrichment-cg-v2-official-walk-surface",
  "crol-list/mf-ontology-enrichment-cg-v3-mandate-report-candidates",
  "crol-list/mf-ontology-enrichment-cg-v3-mandate-rule-evidence-stamps",
  "crol-list/mf-ontology-enrichment-cg-v3-mandate-contract-backlinks",
];

test("fixture ladder loads and emits eight cg-v cards while metrics fail", () => {
  const ladder = loadJson("ontology/fixtures/dimensions/civic_graph_capability_ladder.json");
  assert.equal(ladder.schema, LADDER_SCHEMA);
  assert.ok(Array.isArray(ladder.already_in_flywheel));
  assert.ok(ladder.already_in_flywheel.length >= 5);

  const cards = civicGraphCapabilityCards({ civic_graph_capability_ladder: ladder });
  assert.equal(cards.length, 8);
  assert.deepEqual(
    cards.map((c) => c.id),
    EXPECTED_EMIT_ORDER_IDS,
  );

  for (const card of cards) {
    assert.equal(card.schema, MULTI_CARD_SCHEMA);
    assert.equal(card.dimension, "ontology-enrichment");
    assert.equal(card.emitted_by, "multi_flywheel");
    assert.equal(card.evidence.kind, "civic-graph-capability");
    assert.ok(card.verify && card.verify.length > 10, card.id);
    assert.ok(card.demo_win && card.demo_win.length > 10, card.id);
    assert.ok(Number(card.rank_score) >= 88, card.id);
  }

  // Rank scores put v1 payment first, then influence / roll-call densify.
  const byScore = [...cards].sort(
    (a, b) => (b.rank_score - a.rank_score) || String(a.id).localeCompare(String(b.id)),
  );
  assert.deepEqual(byScore.map((c) => c.id), EXPECTED_RANKED_LADDER_IDS);
  assert.equal(byScore[0].rank_score, 97);
  assert.equal(byScore[1].rank_score, 95);
  assert.equal(byScore[2].rank_score, 94);
  assert.equal(byScore[3].rank_score, 93);

  const metrics = civicGraphCapabilityMetrics({ civic_graph_capability_ladder: ladder });
  assert.equal(metrics.civic_graph_ladder_loaded, true);
  assert.equal(metrics.civic_graph_capability_cards, 8);
  assert.equal(metrics.paid_under_status, "unregistered");
  assert.equal(metrics.rollcall_event_count, 12);
  assert.equal(metrics.mandate_observed_count, 0);
});

test("emitter stays quiet without a ladder inventory", () => {
  assert.deepEqual(civicGraphCapabilityCards({}), []);
  assert.deepEqual(civicGraphCapabilityCards({ civic_graph_capability_ladder: null }), []);
  assert.equal(
    civicGraphCapabilityMetrics({}).civic_graph_ladder_loaded,
    false,
  );
});

test("cards quiet when payment registry metrics clear", () => {
  const ladder = loadJson("ontology/fixtures/dimensions/civic_graph_capability_ladder.json");
  const cleared = structuredClone(ladder);
  cleared.metrics.payment = {
    ...cleared.metrics.payment,
    object_grounding: "built",
    object_status: "registered",
    paid_under_status: "registered",
    paid_under_grounding: "built",
    paid_under_reason_stale: false,
  };
  const cards = civicGraphCapabilityCards({ civic_graph_capability_ladder: cleared });
  assert.equal(
    cards.filter((c) => String(c.id).includes("cg-v1-")).length,
    0,
    "v1 payment cards must quiet when paid_under is registered and non-gap",
  );
  assert.ok(cards.some((c) => c.id.includes("cg-v2-")));
});

test("roll-call densify quiets past the constellation event bar", () => {
  const ladder = loadJson("ontology/fixtures/dimensions/civic_graph_capability_ladder.json");
  const cleared = structuredClone(ladder);
  cleared.metrics.votes = {
    ...cleared.metrics.votes,
    eligible_event_count: 40,
    event_count_pass: true,
    constellation_promoted: true,
  };
  const cards = civicGraphCapabilityCards({ civic_graph_capability_ladder: cleared });
  assert.equal(
    cards.some((c) => c.id.endsWith("cg-v2-rollcall-event-densify")),
    false,
  );
});

test("mandate densify quiets when observed_count and backlinks clear", () => {
  const ladder = loadJson("ontology/fixtures/dimensions/civic_graph_capability_ladder.json");
  const cleared = structuredClone(ladder);
  cleared.metrics.mandates = {
    ...cleared.metrics.mandates,
    observed_count: 12,
    notice_backlink_edges: 12,
  };
  const cards = civicGraphCapabilityCards({ civic_graph_capability_ladder: cleared });
  assert.equal(
    cards.filter((c) => String(c.id).includes("cg-v3-")).length,
    0,
  );
});

test("ontology-enrichment + default flywheel rank cg-v ladder #1–#8", () => {
  const ladder = loadJson("ontology/fixtures/dimensions/civic_graph_capability_ladder.json");
  const enrichment = evaluateOntologyEnrichment({
    civic_graph_capability_ladder: ladder,
    source_coverage: loadJson("entity_resolution/source_coverage.json"),
    gap_taxonomy: loadJson("site/data/gap_taxonomy.json"),
    registry_sync: { ok: true },
    cross_spine: { checked: 1, contradictions: 0 },
    actionability: { rate: 1, sample_size: 1 },
    generated_at: "1970-01-01T00:00:00.000Z",
  });
  assert.equal(enrichment.metrics.civic_graph_ladder_loaded, true);
  assert.equal(enrichment.metrics.civic_graph_capability_cards, 8);
  for (const id of EXPECTED_RANKED_LADDER_IDS) {
    assert.ok(
      enrichment.cards.some((c) => c.id === id),
      `missing enrichment card ${id}`,
    );
  }

  const inputs = loadDefaultInputs(ROOT, { mode: "fixture" });
  assert.ok(inputs.civic_graph_capability_ladder);
  assert.equal(inputs.civic_graph_capability_ladder.schema, LADDER_SCHEMA);

  // Production ledger already holds older proposed cards open. Strip any cg-v
  // entries so this test models the first emit of the ladder (fresh propose).
  const liveLedger = loadJson("ontology/queue/ledger.json");
  const seedLedger = {
    ...liveLedger,
    cards: Object.fromEntries(
      Object.entries(liveLedger.cards || {}).filter(
        ([id]) => !id.includes("mf-ontology-enrichment-cg-v"),
      ),
    ),
  };

  const { queue } = runMultiFlywheel({
    inputs,
    ledger: seedLedger,
    generated_at: "1970-01-01T00:00:00.000Z",
    limit: 100,
  });

  const top8 = queue.cards.slice(0, 8).map((c) => c.id);
  assert.deepEqual(top8, EXPECTED_RANKED_LADDER_IDS);
  for (let i = 0; i < 8; i += 1) {
    assert.equal(queue.cards[i].rank, i + 1);
    assert.equal(queue.cards[i].evidence.kind, "civic-graph-capability");
  }
  assert.equal(
    queue.dimension_metrics["ontology-enrichment"]?.civic_graph_capability_cards,
    8,
  );

  // Empty-ledger path still ranks all eight ladder cards relative to each other.
  const fresh = runMultiFlywheel({
    inputs,
    ledger: emptyLedger({ updated_at: "1970-01-01T00:00:00.000Z" }),
    generated_at: "1970-01-01T00:00:00.000Z",
    limit: 100,
  });
  const ladderOnly = fresh.queue.cards
    .filter((c) => String(c.id).includes("mf-ontology-enrichment-cg-v"))
    .map((c) => c.id);
  assert.deepEqual(ladderOnly, EXPECTED_RANKED_LADDER_IDS);
});
