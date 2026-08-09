import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import {
  buildCrossSpineMonitorReceipt,
  loadCrossSpineGold,
} from "../tools/cross_spine_eval.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const GOLD = loadCrossSpineGold(readFileSync(resolve(ROOT, "entity_resolution/eval/cross_spine_gold_v1.jsonl"), "utf8"));
const HARNESS = resolve(ROOT, "tools/cross_spine_eval.mjs");

test("monitor emits the four relation metrics and provenance fingerprints", () => {
  const receipt = buildCrossSpineMonitorReceipt({ gold: GOLD });
  assert.equal(receipt.schema, "cityscroll.cross_spine_edge_monitor.v1");
  assert.deepEqual(Object.keys(receipt.relations).sort(), [
    "mandate_contract",
    "mandate_land_use",
    "mandate_meeting",
    "mandate_rule",
  ]);
  for (const metric of Object.values(receipt.relations)) {
    assert.equal(typeof metric.precision, "number");
    assert.equal(typeof metric.coverage, "number");
    assert.equal(typeof metric.abstention, "number");
    assert.match(metric.provenance.fingerprint, /^[a-f0-9]{16}$/);
    assert.equal(metric.provenance_drift.status, "stable");
  }
  assert.equal(receipt.provenance_drift.status, "stable");
  assert.equal(receipt.ok, true);
});

test("monitor marks a relation when its provenance baseline changes", () => {
  const baseline = buildCrossSpineMonitorReceipt({ gold: GOLD });
  baseline.relations.mandate_rule.provenance.fingerprint = "0000000000000000";
  const receipt = buildCrossSpineMonitorReceipt({ gold: GOLD, prior: baseline });
  assert.equal(receipt.relations.mandate_rule.provenance_drift.status, "drifted");
  assert.deepEqual(receipt.provenance_drift.relations, ["mandate_rule"]);
  assert.equal(receipt.ok, false);
});

test("monitor check is deterministic and does not rewrite the edge policy", () => {
  const result = spawnSync(process.execPath, [HARNESS, "--monitor", "--check"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /relation=mandate_contract/);
  assert.match(result.stdout, /precision=1/);
  assert.match(result.stdout, /coverage=1/);
  assert.match(result.stdout, /abstention=/);
  assert.match(result.stdout, /provenance_drift=stable ok=true/);
});
