import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AUTHORITY_LABEL,
  computeAuthorityMetrics,
  deriveAuthorityCases,
  loadSourceRecords,
  predictAuthorityCases,
} from "../entity_resolution/evaluation/authority.mjs";
import { extractFeatures } from "../entity_resolution/features/index.mjs";
import { scorePair } from "../entity_resolution/matchers/index.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(
  ROOT,
  "entity_resolution/eval/fixtures/source_records_authority_v0.jsonl",
);
const CLI = join(ROOT, "entity_resolution/eval/run_authority.mjs");

function fixtureRows() {
  return loadSourceRecords(readFileSync(FIXTURE, "utf8"));
}

test("source-record loader accepts D1 export snapshots and rejects malformed rows", () => {
  const rows = fixtureRows();
  assert.equal(rows.length, 9);
  assert.equal(typeof rows[0].normalized_snapshot, "object");
  assert.throws(
    () => loadSourceRecords('{"source_system":"city_record"}\n'),
    /source_system_id/,
  );
  assert.throws(() => loadSourceRecords("not json\n"), /invalid JSON/);
});

test("silver authority cases use the latest immutable snapshot and publisher hard keys", () => {
  const cases = deriveAuthorityCases(fixtureRows());
  assert.equal(cases.length, 5);

  const same = cases.filter((row) => row.authority_label === AUTHORITY_LABEL.SAME);
  const conflicts = cases.filter(
    (row) => row.authority_label === AUTHORITY_LABEL.NEVER_AUTO,
  );
  assert.equal(same.length, 4);
  assert.equal(conflicts.length, 1);
  assert.ok(same.some((row) => row.evidence.shared_hard_ids.includes("pin:84124P0003001")));
  assert.ok(
    same.some((row) =>
      row.evidence.shared_hard_ids.includes("contract:CT184120268807929")
    ),
  );
  assert.deepEqual(conflicts[0].evidence.conflicting_hard_id_families, ["pin_epin"]);
  assert.doesNotMatch(JSON.stringify(cases), /OLDPIN/);
  assert.doesNotMatch(JSON.stringify(cases), /missing-pin/);
  assert.ok(same.some((row) => row.left.source_system === row.right.source_system));
});

test("matcher recognizes contract agreement and rejects name-similar hard-id conflict", () => {
  const contractFeatures = extractFeatures(
    {
      display_name: "Professional services",
      attrs: { contract_id: "CT-100" },
    },
    {
      display_name: "Unrelated registration title",
      attrs: { contract_id: "CT100" },
    },
    { entityType: "procurement" },
  );
  assert.equal(contractFeatures.contract_id_equal, true);
  assert.equal(
    scorePair({}, {}, contractFeatures).method,
    "contract_id_equal_v0",
  );

  const conflictFeatures = extractFeatures(
    { display_name: "Bridge Inspection Services", attrs: { pin: "PIN-A" } },
    { display_name: "Bridge Inspection Services", attrs: { epin: "PIN-B" } },
    { entityType: "procurement" },
  );
  const conflictScore = scorePair({}, {}, conflictFeatures);
  assert.equal(conflictFeatures.hard_id_conflict, true);
  assert.equal(conflictScore.decision, "different");
  assert.equal(conflictScore.method, "hard_id_conflict_v0");

  const contractConflictFeatures = extractFeatures(
    { display_name: "Technology Consulting", attrs: { contract_id: "CT-100" } },
    { display_name: "Technology Consulting", attrs: { contract_id: "CT-200" } },
    { entityType: "procurement" },
  );
  assert.equal(contractConflictFeatures.contract_id_conflict, true);
  assert.equal(
    scorePair({}, {}, contractConflictFeatures).decision,
    "different",
  );

  const nullSentinelFeatures = extractFeatures(
    { display_name: "Routine Maintenance", attrs: { pin: "N/A" } },
    { display_name: "Routine Maintenance", attrs: { epin: "N/A" } },
    { entityType: "procurement" },
  );
  assert.equal(nullSentinelFeatures.pin_epin_equal, false);
  assert.equal(nullSentinelFeatures.hard_id_equal, false);
});

test("authority metrics expose false-split recall and conflict auto-link pressure", () => {
  const cases = deriveAuthorityCases(fixtureRows());
  const predictions = predictAuthorityCases(cases);
  const metrics = computeAuthorityMetrics(cases, predictions);
  assert.deepEqual(metrics, {
    authority_recall: 1,
    authority_conflict_auto_link_rate: 0,
  });

  const deliberatelyWrong = new Map(
    cases.map((row) => [
      row.id,
      row.authority_label === AUTHORITY_LABEL.SAME ? "unresolved" : "same",
    ]),
  );
  assert.deepEqual(computeAuthorityMetrics(cases, deliberatelyWrong), {
    authority_recall: 0,
    authority_conflict_auto_link_rate: 1,
  });
});

test("authority CLI prints the two stable metric keys and a machine-readable report", () => {
  const result = spawnSync(
    process.execPath,
    [CLI, "--source-records", FIXTURE, "--json"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /^authority_recall=1$/m);
  assert.match(result.stdout, /^authority_conflict_auto_link_rate=0$/m);
  assert.match(result.stdout, /"silver_same": 4/);
  assert.match(result.stdout, /"never_auto": 1/);
  assert.doesNotMatch(result.stdout, /D1 write|public route/i);
});
