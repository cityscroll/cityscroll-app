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
import { loadLedgerStore } from "../ontology/ledger_store.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadJson(rel) {
  return JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
}

// Full ladder emission order when every threshold fails (v1 → v2 → v3 blocks).
const FULL_LADDER_EMIT_ORDER = [
  "crol-list/mf-ontology-enrichment-cg-v1-paid-under-registry",
  "crol-list/mf-ontology-enrichment-cg-v1-payment-row-surface",
  "crol-list/mf-ontology-enrichment-cg-v2-influence-link-types",
  "crol-list/mf-ontology-enrichment-cg-v2-rollcall-event-densify",
  "crol-list/mf-ontology-enrichment-cg-v2-official-walk-surface",
  "crol-list/mf-ontology-enrichment-cg-v3-mandate-report-candidates",
  "crol-list/mf-ontology-enrichment-cg-v3-mandate-rule-evidence-stamps",
  "crol-list/mf-ontology-enrichment-cg-v3-mandate-contract-backlinks",
];

// Rank order (score desc, id) for the full open ladder.
const FULL_LADDER_RANKED = [
  "crol-list/mf-ontology-enrichment-cg-v1-paid-under-registry",
  "crol-list/mf-ontology-enrichment-cg-v1-payment-row-surface",
  "crol-list/mf-ontology-enrichment-cg-v2-influence-link-types",
  "crol-list/mf-ontology-enrichment-cg-v2-rollcall-event-densify",
  "crol-list/mf-ontology-enrichment-cg-v3-mandate-report-candidates",
  "crol-list/mf-ontology-enrichment-cg-v2-official-walk-surface",
  "crol-list/mf-ontology-enrichment-cg-v3-mandate-rule-evidence-stamps",
  "crol-list/mf-ontology-enrichment-cg-v3-mandate-contract-backlinks",
];

// Currently open after paid_under + payment-row surface + official walk ship.
// report/rule cards quiet (observed_count>0); contract card remains until
// backlink edges reach 10.
const OPEN_LADDER_EMIT_ORDER = [
  "crol-list/mf-ontology-enrichment-cg-v2-influence-link-types",
  "crol-list/mf-ontology-enrichment-cg-v2-rollcall-event-densify",
  "crol-list/mf-ontology-enrichment-cg-v3-mandate-contract-backlinks",
];

const OPEN_LADDER_RANKED = [
  "crol-list/mf-ontology-enrichment-cg-v2-influence-link-types",
  "crol-list/mf-ontology-enrichment-cg-v2-rollcall-event-densify",
  "crol-list/mf-ontology-enrichment-cg-v3-mandate-contract-backlinks",
];

/** Synthetic full-fail ladder (every threshold open) for full-ladder characterization. */
function fullFailLadder(base) {
  const ladder = structuredClone(base);
  ladder.metrics.payment = {
    ...ladder.metrics.payment,
    object_grounding: "gap",
    object_status: "registered",
    paid_under_status: "unregistered",
    paid_under_grounding: "gap",
    paid_under_reason_stale: true,
    retention_usefulness: 0.44,
    retention_precision: 1.0,
    retention_materialize: true,
    payment_row_surface_shipped: false,
  };
  ladder.metrics.official_influence = {
    ...ladder.metrics.official_influence,
    hub_promoted: true,
    lobby_edge_count: 2440,
    cfb_edge_count: 1398,
    lobby_precision: 1.0,
    cfb_precision: 1.0,
    registry_has_lobby_link_type: false,
    registry_has_cfb_link_type: false,
    official_walk_surface_shipped: false,
  };
  ladder.metrics.votes = {
    ...ladder.metrics.votes,
    eligible_event_count: 12,
    constellation_event_bar: 30,
    retention_pass: true,
    event_count_pass: false,
    constellation_promoted: false,
  };
  ladder.metrics.mandates = {
    ...ladder.metrics.mandates,
    mandate_count: 2931,
    observed_count: 0,
    notice_backlink_edges: 1,
    notice_backlink_notices: 1,
  };
  return ladder;
}

test("committed fixture emits the still-open cg-v ladder cards", () => {
  const ladder = loadJson("ontology/fixtures/dimensions/civic_graph_capability_ladder.json");
  assert.equal(ladder.schema, LADDER_SCHEMA);
  assert.ok(Array.isArray(ladder.already_in_flywheel));
  assert.ok(ladder.already_in_flywheel.length >= 5);

  const cards = civicGraphCapabilityCards({ civic_graph_capability_ladder: ladder });
  assert.deepEqual(cards.map((c) => c.id), OPEN_LADDER_EMIT_ORDER);

  for (const card of cards) {
    assert.equal(card.schema, MULTI_CARD_SCHEMA);
    assert.equal(card.dimension, "ontology-enrichment");
    assert.equal(card.emitted_by, "multi_flywheel");
    assert.equal(card.evidence.kind, "civic-graph-capability");
    assert.ok(card.verify && card.verify.length > 10, card.id);
    assert.ok(card.demo_win && card.demo_win.length > 10, card.id);
    assert.ok(Number(card.rank_score) >= 88, card.id);
  }

  const byScore = [...cards].sort(
    (a, b) => (b.rank_score - a.rank_score) || String(a.id).localeCompare(String(b.id)),
  );
  assert.deepEqual(byScore.map((c) => c.id), OPEN_LADDER_RANKED);
  assert.equal(byScore[0].rank_score, 94);
  assert.equal(byScore[1].rank_score, 93);

  const metrics = civicGraphCapabilityMetrics({ civic_graph_capability_ladder: ladder });
  assert.equal(metrics.civic_graph_ladder_loaded, true);
  assert.equal(metrics.civic_graph_capability_cards, OPEN_LADDER_EMIT_ORDER.length);
  assert.equal(metrics.paid_under_status, "registered");
  assert.equal(metrics.rollcall_event_count, 12);
  // Mandate densify on main raised observed_count; report/rule cards quiet.
  assert.ok(Number(metrics.mandate_observed_count) > 0);
});

test("full-fail metrics still emit the complete eight-card ladder", () => {
  const base = loadJson("ontology/fixtures/dimensions/civic_graph_capability_ladder.json");
  const ladder = fullFailLadder(base);
  const cards = civicGraphCapabilityCards({ civic_graph_capability_ladder: ladder });
  assert.equal(cards.length, 8);
  assert.deepEqual(cards.map((c) => c.id), FULL_LADDER_EMIT_ORDER);
  const byScore = [...cards].sort(
    (a, b) => (b.rank_score - a.rank_score) || String(a.id).localeCompare(String(b.id)),
  );
  assert.deepEqual(byScore.map((c) => c.id), FULL_LADDER_RANKED);
});

test("emitter stays quiet without a ladder inventory", () => {
  assert.deepEqual(civicGraphCapabilityCards({}), []);
  assert.deepEqual(civicGraphCapabilityCards({ civic_graph_capability_ladder: null }), []);
  assert.equal(
    civicGraphCapabilityMetrics({}).civic_graph_ladder_loaded,
    false,
  );
});

test("both v1 payment cards quiet when registry built and surface shipped", () => {
  const ladder = loadJson("ontology/fixtures/dimensions/civic_graph_capability_ladder.json");
  const open = civicGraphCapabilityCards({ civic_graph_capability_ladder: ladder });
  assert.equal(
    open.filter((c) => String(c.id).includes("cg-v1-")).length,
    0,
    "both v1 cards quiet on committed fixture",
  );
  assert.ok(open.some((c) => c.id.includes("cg-v2-")));

  const reopened = structuredClone(ladder);
  reopened.metrics.payment = {
    ...reopened.metrics.payment,
    payment_row_surface_shipped: false,
  };
  const surfaceOpen = civicGraphCapabilityCards({ civic_graph_capability_ladder: reopened });
  assert.equal(
    surfaceOpen.some((c) => String(c.id).endsWith("cg-v1-payment-row-surface")),
    true,
    "surface card reopens when payment_row_surface_shipped is false",
  );
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
  // Live fixture already has observed_count>0 — report/rule quiet. Force zero then clear.
  const open = structuredClone(ladder);
  open.metrics.mandates = {
    ...open.metrics.mandates,
    observed_count: 0,
    notice_backlink_edges: 1,
  };
  assert.ok(
    civicGraphCapabilityCards({ civic_graph_capability_ladder: open })
      .some((c) => c.id.includes("cg-v3-mandate-report")),
  );

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

test("ontology-enrichment + default flywheel rank open cg-v ladder first", () => {
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
  assert.equal(
    enrichment.metrics.civic_graph_capability_cards,
    OPEN_LADDER_EMIT_ORDER.length,
  );
  for (const id of OPEN_LADDER_EMIT_ORDER) {
    assert.ok(
      enrichment.cards.some((c) => c.id === id),
      `missing enrichment card ${id}`,
    );
  }

  const inputs = loadDefaultInputs(ROOT, { mode: "fixture" });
  assert.ok(inputs.civic_graph_capability_ladder);
  assert.equal(inputs.civic_graph_capability_ladder.schema, LADDER_SCHEMA);

  // Production ledger already holds older proposed cards open. Strip any cg-v
  // entries so this test models the first emit of the still-open ladder.
  // Fold the per-card store (ledger.json is a thin pointer, not the cards map).
  const liveLedger = loadLedgerStore(join(ROOT, "ontology/queue/ledger.json"));
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

  const topN = queue.cards.slice(0, OPEN_LADDER_RANKED.length).map((c) => c.id);
  assert.deepEqual(topN, OPEN_LADDER_RANKED);
  for (let i = 0; i < OPEN_LADDER_RANKED.length; i += 1) {
    assert.equal(queue.cards[i].rank, i + 1);
    assert.equal(queue.cards[i].evidence.kind, "civic-graph-capability");
  }
  assert.equal(
    queue.dimension_metrics["ontology-enrichment"]?.civic_graph_capability_cards,
    OPEN_LADDER_EMIT_ORDER.length,
  );

  // Empty-ledger path still ranks open ladder cards relative to each other.
  const fresh = runMultiFlywheel({
    inputs,
    ledger: emptyLedger({ updated_at: "1970-01-01T00:00:00.000Z" }),
    generated_at: "1970-01-01T00:00:00.000Z",
    limit: 100,
  });
  const ladderOnly = fresh.queue.cards
    .filter((c) => String(c.id).includes("mf-ontology-enrichment-cg-v"))
    .map((c) => c.id);
  assert.deepEqual(ladderOnly, OPEN_LADDER_RANKED);

  // Full-fail synthetic ladder still tops ranks 1–8 when seeded alone.
  const fullInputs = {
    ...inputs,
    civic_graph_capability_ladder: fullFailLadder(ladder),
  };
  const fullRun = runMultiFlywheel({
    inputs: fullInputs,
    ledger: seedLedger,
    generated_at: "1970-01-01T00:00:00.000Z",
    limit: 100,
  });
  assert.deepEqual(
    fullRun.queue.cards.slice(0, 8).map((c) => c.id),
    FULL_LADDER_RANKED,
  );
});
