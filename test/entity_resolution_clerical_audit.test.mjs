import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildClericalAudit,
  formatLabelSheet,
  parseLabelSheet,
  promoteLabelsToGold,
} from "../entity_resolution/eval/clerical_audit.mjs";

const observations = [
  {
    source_system: "city_record",
    source_system_id: "notice-1",
    source_record_id: "city_record:notice-1",
    vendor_name: "Acme Construction LLC",
    pin: "PIN-1",
    ingested_at: "2026-07-31T12:00:00.000Z",
  },
  {
    source_system: "city_record",
    source_system_id: "notice-2",
    source_record_id: "city_record:notice-2",
    vendor_name: "ACME CONSTRUCTION LLC",
    pin: "PIN-2",
    ingested_at: "2026-07-31T11:00:00.000Z",
  },
  {
    source_system: "city_record",
    source_system_id: "notice-3",
    source_record_id: "city_record:notice-3",
    vendor_name: "Acme Construction Group LLC",
    pin: "PIN-3",
    ingested_at: "2026-07-31T10:00:00.000Z",
  },
  {
    source_system: "city_record",
    source_system_id: "notice-4",
    source_record_id: "city_record:notice-4",
    vendor_name: "Completely Different Vendor Inc",
    pin: "PIN-4",
    ingested_at: "2026-07-31T09:00:00.000Z",
  },
];

test("clerical audit prioritizes high-similarity non-links and retains an auto-link control", () => {
  const result = buildClericalAudit(observations, {
    observedOn: "2026-07-31",
    autoLinkSize: 10,
    nearMissSize: 10,
    nearMissMinSimilarity: 0.5,
  });

  assert.deepEqual(result.receipt.strata, {
    auto_link: { eligible: 1, sampled: 1 },
    near_miss: { eligible: 2, sampled: 2 },
  });
  assert.equal(result.receipt.primary_signal, "false_split");
  assert.equal(result.sample[0].stratum, "near_miss");
  assert.equal(result.sample[0].audit_priority, "false_split");
  assert.equal(result.sample.at(-1).stratum, "auto_link");
  assert.match(result.sample[0].audit_id, /^era-[a-f0-9]{16}$/);
  assert.ok(result.sample[0].features.token_jaccard >= 0.5);
  assert.equal(result.sample[0].label, "");
  assert.equal(result.receipt.parameters.near_miss_size, 10);
  assert.equal(result.sample.at(-1).link_evidence.mode, "policy_replay");
});

test("stored canonical IDs, when present, define linked versus unlinked strata", () => {
  const stored = observations.slice(0, 3).map((row) => ({
    ...row,
    link_state_available: 1,
    canonical_entity_ids: [],
  }));
  // The non-exact variant is stored with observation 1, while exact-stem
  // observation 2 is deliberately unlinked and must become a false-split lead.
  stored[0].canonical_entity_ids = ["vendor:stored-acme"];
  stored[2].canonical_entity_ids = ["vendor:stored-acme"];
  const result = buildClericalAudit(stored, {
    observedOn: "2026-07-31",
    autoLinkSize: 10,
    nearMissSize: 10,
    nearMissMinSimilarity: 0.5,
  });

  assert.equal(result.receipt.strata.auto_link.eligible, 1);
  assert.equal(result.receipt.strata.near_miss.eligible, 2);
  assert.equal(result.sample.at(-1).link_evidence.mode, "stored_links");
  assert.deepEqual(
    result.sample.at(-1).link_evidence.shared_canonical_entity_ids,
    ["vendor:stored-acme"],
  );
  const exactStemUnlinked = result.sample.find((item) => (
    item.stratum === "near_miss" && item.link_evidence.exact_stem_policy_match
  ));
  assert.ok(exactStemUnlinked, "stored link state must expose a missing exact-stem link");
});

test("label sheet round-trips quoted names and review fields", () => {
  const { sample } = buildClericalAudit(observations, {
    observedOn: "2026-07-31",
    autoLinkSize: 1,
    nearMissSize: 1,
    nearMissMinSimilarity: 0.5,
  });
  sample[0].left.display_name = "Acme, \"North\"";
  const csv = formatLabelSheet(sample);
  const rows = parseLabelSheet(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].left_display_name, "Acme, \"North\"");
  assert.equal(rows[0].label, "");
  assert.match(csv.split("\n")[0], /label,reviewer,reviewed_at,notes/);
});

test("promotion appends reviewed cases to a new version without changing the base cases", () => {
  const { sample } = buildClericalAudit(observations, {
    observedOn: "2026-07-31",
    autoLinkSize: 1,
    nearMissSize: 1,
    nearMissMinSimilarity: 0.5,
  });
  sample[0].label = "same";
  sample[0].reviewer = "reviewer-1";
  sample[0].reviewed_at = "2026-08-01";
  const labels = formatLabelSheet(sample);
  const baseCase = {
    id: "gv0-001",
    entity_type: "vendor",
    label: "different",
    sources: ["city_record"],
    left: { source_system: "city_record", display_name: "A" },
    right: { source_system: "city_record", display_name: "B" },
  };
  const base = [
    JSON.stringify({ _meta: true, gold_version: "v0", schema_version: 1, case_count: 1 }),
    JSON.stringify(baseCase),
    "",
  ].join("\n");

  const promoted = promoteLabelsToGold({
    baseGoldText: base,
    labelSheetText: labels,
    goldVersion: "v1",
    promotedOn: "2026-08-01",
  });
  const lines = promoted.text.trim().split("\n").map(JSON.parse);
  assert.equal(lines[0].gold_version, "v1");
  assert.equal(lines[0].case_count, 2);
  assert.deepEqual(lines[1], baseCase);
  assert.equal(lines[2].id, "gv1-001");
  assert.equal(lines[2].label, "same");
  assert.match(lines[2].notes, /^Clerical audit era-/);
  assert.equal(promoted.receipt.promoted_cases, 1);
  assert.equal(promoted.receipt.skipped_unlabeled, 1);
});

test("promotion rejects invalid versions, missing review evidence, and duplicate pair membership", () => {
  const base = [
    JSON.stringify({ _meta: true, gold_version: "v0", schema_version: 1, case_count: 1 }),
    JSON.stringify({
      id: "gv0-001",
      entity_type: "vendor",
      label: "same",
      sources: ["city_record"],
      left: { source_system: "city_record", native_key: "notice-1", display_name: "Acme Construction LLC" },
      right: { source_system: "city_record", native_key: "notice-2", display_name: "ACME CONSTRUCTION LLC" },
    }),
    "",
  ].join("\n");
  const { sample } = buildClericalAudit(observations, {
    observedOn: "2026-07-31",
    autoLinkSize: 1,
    nearMissSize: 0,
  });
  sample[0].label = "same";
  sample[0].reviewer = "reviewer-1";
  sample[0].reviewed_at = "2026-08-01";
  const labels = formatLabelSheet(sample);

  assert.throws(
    () => promoteLabelsToGold({ baseGoldText: base, labelSheetText: labels, goldVersion: "v0" }),
    /newer than base/i,
  );
  assert.throws(
    () => promoteLabelsToGold({ baseGoldText: base, labelSheetText: labels, goldVersion: "v1" }),
    /already exists in base gold/i,
  );

  sample[0].reviewer = "";
  assert.throws(
    () => promoteLabelsToGold({
      baseGoldText: base.replace("notice-1", "other-1").replace("notice-2", "other-2"),
      labelSheetText: formatLabelSheet(sample),
      goldVersion: "v1",
    }),
    /reviewer and reviewed_at/i,
  );
});

test("export CLI writes the script/label/receipt contract and is idempotent for identical input", () => {
  const dir = mkdtempSync(join(tmpdir(), "er-clerical-audit-"));
  const input = join(dir, "observations.json");
  const out = join(dir, "audit");
  const tool = new URL("../tools/export_er_clerical_audit.mjs", import.meta.url);
  writeFileSync(input, `${JSON.stringify(observations)}\n`);
  const args = [
    tool.pathname,
    "--input", input,
    "--out-dir", out,
    "--observed-on", "2026-07-31",
    "--auto-link-size", "1",
    "--near-miss-size", "2",
    "--near-miss-min-similarity", "0.5",
  ];

  try {
    const first = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(existsSync(join(out, "audit_sample.jsonl")), true);
    assert.equal(existsSync(join(out, "label_sheet.csv")), true);
    assert.equal(existsSync(join(out, "receipt.json")), true);
    const receipt = JSON.parse(readFileSync(join(out, "receipt.json"), "utf8"));
    assert.equal(receipt.primary_signal, "false_split");
    assert.equal(receipt.input.kind, "offline_json");
    assert.equal(receipt.strata.near_miss.sampled, 2);
    assert.equal(receipt.strata.auto_link.sampled, 1);

    const second = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /unchanged .*audit_sample\.jsonl/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("committed live receipt preserves replay provenance and false-split weighting", () => {
  const receipt = JSON.parse(readFileSync(
    new URL("../entity_resolution/eval/audits/2026-07-31/receipt.json", import.meta.url),
    "utf8",
  ));
  assert.equal(receipt.kind, "er_clerical_audit");
  assert.equal(receipt.primary_signal, "false_split");
  assert.equal(receipt.input.kind, "live_d1_read_only");
  assert.equal(receipt.input.input_relation, "notices_replay");
  assert.equal(receipt.input.replay_reason, "source_records_empty");
  assert.equal(receipt.input.relation_counts.source_records, 0);
  assert.equal(receipt.strata.near_miss.sampled, 60);
  assert.equal(receipt.strata.auto_link.sampled, 30);
  assert.match(receipt.artifacts.sample.sha256, /^[a-f0-9]{64}$/);
  assert.match(receipt.artifacts.label_sheet.sha256, /^[a-f0-9]{64}$/);
});
