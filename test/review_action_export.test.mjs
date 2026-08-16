import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  exportReviewActionsToGoldCases,
  formatReviewActionGoldJsonl,
  normalizeReviewActionRow,
} from "../entity_resolution/eval/review_action_export.mjs";
import {
  CURATION_EFFECT_VERSION,
  CURATION_REVIEW_POLICY_VERSION,
  CURATION_VERDICT_SCHEMA_VERSION,
  buildCurationVerdictReceipt,
  projectCurationVerdictState,
} from "../entity_resolution/review/curation_verdicts.mjs";
import {
  appendCurationVerdict,
  readCurationVerdicts,
} from "../worker/src/lib/curation_verdicts.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = JSON.parse(readFileSync(
  join(ROOT, "entity_resolution/eval/fixtures/review_actions_v0.json"),
  "utf8",
));

function verdictInput(overrides = {}) {
  return {
    id: "verdict-accept-001",
    actor: "desk:fixture-1",
    decision: "ACCEPT",
    target: {
      kind: "entity_link",
      id: "pair-hntb-truncation",
      edge_family: "vendor_identity",
      edge: {
        id: "link-curated-001",
        source_record_id: "city_record:20260623008:hash-l",
        canonical_entity_id: "vendor:hntb",
        method: "curation_accept",
        matcher_version: "conventional_v2",
        evidence: { pair_id: "pair-hntb-truncation" },
      },
    },
    evidence_refs: [
      { kind: "source_record", id: "city_record:20260623008:hash-l" },
      { kind: "source_record", id: "checkbook:CT184120268807929:hash-r" },
    ],
    model_version: "conventional_v2",
    rule_version: CURATION_REVIEW_POLICY_VERSION,
    review_policy: {
      version: CURATION_REVIEW_POLICY_VERSION,
      status: "satisfied",
      reasons: ["authenticated_review_complete"],
    },
    timestamp: "2026-08-15T12:00:00.000Z",
    ...overrides,
  };
}

function d1(sqlite) {
  return {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return {
        bind(...args) {
          return {
            async all() { return { results: statement.all(...args) }; },
            async run() { return statement.run(...args); },
          };
        },
      };
    },
    async batch(statements) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  };
}

test("normalizeReviewActionRow exports same/different and skips defer without personal data", () => {
  const same = normalizeReviewActionRow(FIXTURE.rows[0]);
  assert.equal(same.status, "exportable");
  assert.equal(same.decision, "same");
  assert.equal(same.left.display_name.includes("HNTB"), true);

  const deferred = normalizeReviewActionRow(FIXTURE.rows[2]);
  assert.equal(deferred.status, "skipped");
  assert.equal(deferred.reason, "non_exportable_decision");

  const fixtureEmail = ["reviewer", "example.com"].join("@");
  const withActor = normalizeReviewActionRow({
    ...FIXTURE.rows[0],
    actor: fixtureEmail,
    note: "private free text",
    email: fixtureEmail,
  });
  const encoded = JSON.stringify(withActor);
  assert.equal(encoded.includes(fixtureEmail), false);
  assert.equal(encoded.includes("private free text"), false);
  assert.equal(encoded.includes("reviewer"), false);
});

test("exportReviewActionsToGoldCases builds known arithmetic and provenance", () => {
  const exported = exportReviewActionsToGoldCases(FIXTURE.rows, {
    goldVersion: "v1",
    exportedOn: "2026-08-01",
  });
  assert.equal(exported.cases.length, 2);
  assert.equal(exported.skipped.length, 1);
  assert.equal(exported.receipt.exportable_cases, 2);
  assert.equal(exported.receipt.skipped_rows, 1);
  assert.equal(exported.receipt.skipped_reasons.non_exportable_decision, 1);
  assert.deepEqual(exported.cases.map((item) => item.label).sort(), ["different", "same"]);
  for (const item of exported.cases) {
    assert.ok(item.review_action_provenance.action_id);
    assert.ok(item.review_action_provenance.pair_id);
    assert.equal(item.review_action_provenance.export_method, "review_action_export_v1");
  }
  const jsonl = formatReviewActionGoldJsonl(exported.cases, exported.receipt);
  assert.match(jsonl, /"kind":"review_action_gold_candidates"/);
  assert.equal(jsonl.includes("example.com"), false);
});

test("fixture CLI prints deterministic counts", () => {
  const result = spawnSync(
    process.execPath,
    ["tools/export_review_actions_to_gold.mjs", "--fixtures", "--gold-version", "v1"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /exportable_cases=2/);
  assert.match(result.stdout, /skipped_rows=1/);
  assert.match(result.stdout, /skip reason=non_exportable_decision/);
  assert.equal(result.stdout.includes("example.com"), false);
});

test("curation receipt fixes a versioned, reversible shape and withholds ineligible accepts", () => {
  const accepted = buildCurationVerdictReceipt(verdictInput());
  assert.equal(accepted.schema_version, CURATION_VERDICT_SCHEMA_VERSION);
  assert.equal(accepted.decision, "ACCEPT");
  assert.equal(accepted.review_policy.status, "satisfied");
  assert.equal(accepted.reversible_effect.version, CURATION_EFFECT_VERSION);
  assert.equal(accepted.reversible_effect.operation, "materialize_edge");
  assert.equal(accepted.reversible_effect.status, "applied");
  assert.equal(accepted.reversible_effect.reversible, true);
  assert.deepEqual(accepted.reversible_effect.undo, {
    operation: "append_verdict",
    target_id: "pair-hntb-truncation",
    reverses_receipt_id: "verdict-accept-001",
  });

  const withheld = buildCurationVerdictReceipt(verdictInput({
    id: "verdict-withheld-001",
    review_policy: {
      version: CURATION_REVIEW_POLICY_VERSION,
      status: "unsatisfied",
      reasons: ["conflicting_authority_key"],
    },
  }));
  assert.equal(withheld.decision, "ACCEPT");
  assert.equal(withheld.review_policy.status, "unsatisfied");
  assert.equal(withheld.reversible_effect.status, "withheld");
  assert.equal(withheld.reversible_effect.provisional_state, "accept_withheld");
  assert.equal(withheld.reversible_effect.edge, null);
});

test("curation verdict store appends accepted edges, promotions, and provisional decisions", async () => {
  const sqlite = new DatabaseSync(":memory:");
  for (const migration of [
    "0009_entity_link.sql",
    "0017_resolution_provenance.sql",
    "0021_curation_verdicts.sql",
  ]) {
    sqlite.exec(readFileSync(new URL(`../worker/migrations/${migration}`, import.meta.url), "utf8"));
  }
  sqlite.prepare(
    `INSERT INTO canonical_entity
       (id, entity_type, display_name, attrs_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("vendor:hntb", "vendor", "HNTB", null, "2026-08-15T11:00:00.000Z", "2026-08-15T11:00:00.000Z");
  sqlite.prepare(
    `INSERT INTO entity_link
       (id, source_record_id, canonical_entity_id, decision, confidence, method,
        matcher_version, evidence_json, resolution_run_id, review_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "link-provisional-001",
    "checkbook:CT184120268807929:hash-r",
    "vendor:hntb",
    "review",
    0.84,
    "token_v0",
    "conventional_v2",
    "{}",
    null,
    "pending",
    "2026-08-15T11:30:00.000Z",
  );
  const DB = d1(sqlite);

  try {
    const accepted = await appendCurationVerdict(DB, verdictInput());
    assert.equal(accepted.reversible_effect.operation, "materialize_edge");
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM entity_link WHERE id = ?").get("link-curated-001").n, 1);

    const promoted = await appendCurationVerdict(DB, verdictInput({
      id: "verdict-promote-001",
      target: {
        ...verdictInput().target,
        id: "pair-hntb-existing",
        provisional_edge_id: "link-provisional-001",
        edge: {
          ...verdictInput().target.edge,
          id: "link-curated-002",
          source_record_id: "checkbook:CT184120268807929:hash-r",
        },
      },
      timestamp: "2026-08-15T12:01:00.000Z",
    }));
    assert.equal(promoted.reversible_effect.operation, "promote_edge");
    assert.deepEqual(
      { ...sqlite.prepare(
        "SELECT superseding_link_id, superseded_link_id, reason FROM entity_link_supersession WHERE superseding_link_id = ?",
      ).get("link-curated-002") },
      {
        superseding_link_id: "link-curated-002",
        superseded_link_id: "link-provisional-001",
        reason: "curation_accept",
      },
    );

    const withheld = await appendCurationVerdict(DB, verdictInput({
      id: "verdict-withheld-002",
      target: { ...verdictInput().target, id: "pair-withheld", edge: { ...verdictInput().target.edge, id: "link-withheld" } },
      review_policy: { version: CURATION_REVIEW_POLICY_VERSION, status: "unsatisfied", reasons: ["evidence_conflict"] },
      timestamp: "2026-08-15T12:02:00.000Z",
    }));
    assert.equal(withheld.reversible_effect.status, "withheld");
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM entity_link WHERE id = ?").get("link-withheld").n, 0);

    for (const [index, decision] of ["REJECT", "REVIEW"].entries()) {
      const receipt = await appendCurationVerdict(DB, verdictInput({
        id: `verdict-${decision.toLowerCase()}-001`,
        decision,
        target: { kind: "entity_link", id: `pair-${decision.toLowerCase()}` },
        review_policy: { version: CURATION_REVIEW_POLICY_VERSION, status: "not_applicable" },
        timestamp: `2026-08-15T12:0${index + 3}:00.000Z`,
      }));
      assert.equal(receipt.reversible_effect.operation, "retain_provisional");
      assert.equal(receipt.reversible_effect.provisional_state, decision === "REJECT" ? "rejected" : "review");
    }

    const reversal = await appendCurationVerdict(DB, verdictInput({
      id: "verdict-reverse-001",
      decision: "REJECT",
      target: { kind: "entity_link", id: "pair-hntb-truncation" },
      review_policy: { version: CURATION_REVIEW_POLICY_VERSION, status: "not_applicable" },
      reverses_receipt_id: "verdict-accept-001",
      timestamp: "2026-08-15T12:06:00.000Z",
    }));
    assert.equal(reversal.reverses_receipt_id, "verdict-accept-001");
    const history = await readCurationVerdicts(DB, ["pair-hntb-truncation"]);
    assert.deepEqual(history.map((receipt) => receipt.id), ["verdict-accept-001", "verdict-reverse-001"]);
    assert.deepEqual(projectCurationVerdictState(history, "pair-hntb-truncation"), {
      state: "rejected",
      receipt_count: 2,
      active_receipt_id: "verdict-reverse-001",
      edge: null,
    });

    assert.throws(
      () => sqlite.prepare("UPDATE curation_verdict_receipt SET actor = 'changed' WHERE id = ?").run("verdict-accept-001"),
      /append-only/,
    );
    assert.throws(
      () => sqlite.prepare("DELETE FROM curation_verdict_receipt WHERE id = ?").run("verdict-accept-001"),
      /append-only/,
    );
  } finally {
    sqlite.close();
  }
});
