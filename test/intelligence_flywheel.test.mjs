// Characterization for the MAPE intelligence flywheel (fixture mode).
//
//   node --test test/intelligence_flywheel.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
  buildIntelligenceReceipt,
  planEnrichmentCards,
  attachCards,
  INTELLIGENCE_RECEIPT_SCHEMA,
  FLYWHEEL_POLICY_VERSION,
} from "../ontology/flywheel.mjs";
import {
  validateCrossSpineBundle,
  CROSS_SPINE_SCHEMA,
} from "../ontology/cross_spine.mjs";
import { checkOntologyRegistrySync } from "../ontology/sync.mjs";
import { readFileSync as read } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadJson(rel) {
  return JSON.parse(read(join(ROOT, rel), "utf8"));
}

test("buildIntelligenceReceipt is deterministic for fixed inputs", () => {
  const source_coverage = loadJson("entity_resolution/source_coverage.json");
  const gap_taxonomy = loadJson("site/data/gap_taxonomy.json");
  const registry_sync = checkOntologyRegistrySync();
  const a = buildIntelligenceReceipt({
    mode: "fixture",
    generated_at: "1970-01-01T00:00:00.000Z",
    source_coverage,
    gap_taxonomy,
    registry_sync,
    cross_spine: { checked: 3, contradictions: 0 },
    // Deliberate all-deep stand-in for hash stability only — production paths
    // measure destination class via ontology/actionability_sample.mjs.
    actionability: { sample_size: 4, actionable: 4, rate: 1 },
  });
  const b = buildIntelligenceReceipt({
    mode: "fixture",
    generated_at: "1970-01-01T00:00:00.000Z",
    source_coverage,
    gap_taxonomy,
    registry_sync,
    cross_spine: { checked: 3, contradictions: 0 },
    actionability: { sample_size: 4, actionable: 4, rate: 1 },
  });
  assert.equal(a.schema, INTELLIGENCE_RECEIPT_SCHEMA);
  assert.equal(a.window.policy_version, FLYWHEEL_POLICY_VERSION);
  assert.equal(a.provenance.content_hash, b.provenance.content_hash);
  assert.equal(a.metrics.source_coverage_rate, source_coverage.measurement.after.rate);
  assert.ok(a.metrics.gap_class_a_open >= 0);
  assert.equal(a.metrics.registry_sync_ok, true);
});

test("planEnrichmentCards emits coverage cards for dual-write gaps (P3+)", () => {
  const source_coverage = loadJson("entity_resolution/source_coverage.json");
  const gap_taxonomy = loadJson("site/data/gap_taxonomy.json");
  const receipt = buildIntelligenceReceipt({
    mode: "fixture",
    generated_at: "1970-01-01T00:00:00.000Z",
    source_coverage,
    gap_taxonomy,
    registry_sync: { ok: true, summary: "ok" },
    cross_spine: { checked: 1, contradictions: 0 },
    actionability: { rate: 1, sample_size: 1 },
  });
  const cards = planEnrichmentCards({
    receipt,
    source_coverage,
    gap_taxonomy,
    registry_sync: { ok: true },
    cross_spine: { contradictions: 0 },
  });
  assert.ok(cards.length > 0, "expected flywheel-emitted cards");
  const coverage = cards.filter((c) => c.class === "coverage");
  // Prefer a still-open dual-write gap when present; otherwise any gap class card.
  const openGaps = (source_coverage.sources || []).filter((s) => s.dual_write?.after === "gap");
  if (openGaps.length) {
    assert.ok(
      coverage.some((c) => openGaps.some((g) => c.id.includes(g.id))),
      `expected coverage card for one of ${openGaps.map((g) => g.id).join(",")}`,
    );
  } else {
    assert.ok(cards.length > 0, "expected flywheel-emitted cards even without dual-write gaps");
  }
  for (const card of cards) {
    assert.equal(card.emitted_by, "intelligence_flywheel");
    assert.ok(card.verify && card.verify.length > 0);
    assert.ok(Number.isInteger(card.rank) && card.rank >= 1);
  }
  const withCards = attachCards(receipt, cards);
  assert.equal(withCards.cards_emitted.length, cards.length);
  assert.ok(withCards.provenance.content_hash);
});

test("cross-spine pass fixture agrees; fail fixtures contradict", () => {
  const pass = loadJson("ontology/fixtures/cross_spine/pass_hntb.json");
  const failPin = loadJson("ontology/fixtures/cross_spine/fail_pin_mismatch.json");
  const failSep = loadJson("ontology/fixtures/cross_spine/fail_confirmed_separate.json");
  assert.equal(pass.schema, CROSS_SPINE_SCHEMA);
  const passResult = validateCrossSpineBundle(pass);
  assert.equal(passResult.ok, true, JSON.stringify(passResult.checks.filter((c) => !c.pass)));
  const pinResult = validateCrossSpineBundle(failPin);
  assert.equal(pinResult.ok, false);
  assert.ok(pinResult.checks.some((c) => c.id === "pin_identity" && !c.pass));
  const sepResult = validateCrossSpineBundle(failSep);
  assert.equal(sepResult.ok, false);
  assert.ok(sepResult.checks.some((c) => c.id === "confirmed_vs_er_separate" && !c.pass));
});

test("CLI flywheel emits receipt.json and cards under --emit-cards", () => {
  const dir = mkdtempSync(join(tmpdir(), "cs-flywheel-"));
  const result = spawnSync(
    process.execPath,
    [
      join(ROOT, "tools/intelligence_flywheel.mjs"),
      "--fixture",
      "--emit-cards",
      dir,
      "--generated-at",
      "1970-01-01T00:00:00.000Z",
    ],
    { encoding: "utf8", cwd: ROOT },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(existsSync(join(dir, "receipt.json")));
  assert.ok(existsSync(join(dir, "cards.jsonl")));
  const receipt = JSON.parse(readFileSync(join(dir, "receipt.json"), "utf8"));
  assert.equal(receipt.schema, INTELLIGENCE_RECEIPT_SCHEMA);
  assert.ok(receipt.cards_emitted.length > 0);
  const md = readdirSync(join(dir, "cards")).filter((n) => n.endsWith(".md"));
  assert.equal(md.length, receipt.cards_emitted.length);
});

test("cross_spine_validate suite exits 0 on committed fixtures", () => {
  const result = spawnSync(
    process.execPath,
    [join(ROOT, "tools/cross_spine_validate.mjs")],
    { encoding: "utf8", cwd: ROOT },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /suite_ok=true/);
});
