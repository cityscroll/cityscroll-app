import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BLOCKING_FINDING_TYPES,
  DOCUMENTATION_CLAIM_FINDINGS,
  DocumentationClaimError,
  observeDocumentationClaims,
  segmentDocument,
} from "../tools/documentation_claim_observer.mjs";
import {
  CLAIM_REGISTRY_PATH,
  FROZEN_CASE_PATH,
  buildDocumentationReviewReport,
  buildResidentReadFacts,
  collectDocumentationFacts,
  coveredDocuments,
  documentationReviewDelta,
  loadClaimRegistry,
  observeRepository,
  rehearseConsumerLineage,
} from "../tools/documentation_drift_review.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = loadClaimRegistry();
const CLAIMS = REGISTRY.claims;
const FROZEN = JSON.parse(readFileSync(join(ROOT, FROZEN_CASE_PATH), "utf8"));
const COMMIT = "0".repeat(40);

function observe(section) {
  return observeDocumentationClaims({ ...section, claims: CLAIMS });
}

function findingsOfType(report, type) {
  return report.findings.filter((item) => item.type === type);
}

test("a claim written inside a fenced diagram is read, not stripped", () => {
  const segments = segmentDocument("docs/architecture.md", [
    "Prose above.",
    "",
    "```",
    "R2: SOURCE_VAULT — content-addressed custody for approved public documents",
    "Cron (daily 13:00 UTC): the only schedule",
    "```",
  ].join("\n"));
  const fenced = segments.filter((segment) => segment.fenced);
  assert.equal(fenced.length, 2);
  assert.equal(fenced[0].line, 4);
  assert.match(fenced[0].text, /content-addressed custody/);
});

test("a long paragraph is matched in full rather than truncated", () => {
  const tail = "no third-party trackers";
  const [segment] = segmentDocument("docs/architecture.md", `${"filler word ".repeat(200)}${tail}`);
  assert.match(segment.text, /no third-party trackers$/);
});

test("each list item is its own claim, so a later bullet cannot excuse an earlier one", () => {
  const segments = segmentDocument("ARCHITECTURE.md", [
    "- First bullet asserting something.",
    "- Second bullet carrying the qualifier.",
  ].join("\n"));
  assert.equal(segments.length, 2);
  assert.equal(segments[1].line, 2);
});

test("the registry only covers documents it declares, and every claim is well formed", () => {
  const covered = coveredDocuments(REGISTRY);
  assert.deepEqual(covered, [
    "ARCHITECTURE.md",
    "docs/architecture.md",
    "docs/release/cloudflare-native-builds.json",
    "docs/release/cloudflare-native-builds.md",
    "worker/README.md",
  ]);
  for (const claim of CLAIMS) {
    assert.ok(claim.owner?.path, `${claim.id} names a committed owner`);
    assert.ok(claim.why, `${claim.id} says why the claim would be wrong`);
  }
});

test("a claim registered against an undeclared document fails closed", () => {
  const broken = { ...REGISTRY, claims: [{ ...CLAIMS[0], documents: ["README.md"] }] };
  assert.throws(() => coveredDocuments(broken), /does not declare/);
});

test("a claim that would check nothing fails closed", () => {
  const claim = CLAIMS.find((item) => item.rule === "absolute");
  for (const broken of [
    { ...claim, patterns: [] },
    { ...claim, false_when: undefined },
    { ...CLAIMS.find((item) => item.rule === "qualified"), qualifier: undefined },
    { ...CLAIMS.find((item) => item.rule === "reference"), required_reference: [] },
    { ...CLAIMS.find((item) => item.rule === "semantic"), adjudicated_by: undefined },
  ]) {
    assert.throws(() => observeDocumentationClaims({
      documents: { "ARCHITECTURE.md": "" },
      facts: FROZEN.collapsed.facts,
      claims: [broken],
    }), DocumentationClaimError, `${broken.rule} claim missing a required field`);
  }
});

test("a claim repeated inside one statement is read as the several claims it is", () => {
  const report = observe({
    documents: {
      ...Object.fromEntries(coveredDocuments(REGISTRY).map((path) => [path, ""])),
      "docs/architecture.md":
        "Under one hard rule: no third-party trackers, and to be clear, no third-party tracker of any kind.\n",
    },
    facts: FROZEN.collapsed.facts,
  });
  const raised = report.findings.filter((item) => item.claim_id === "third-party-loader-absence");
  assert.equal(raised.length, 2);
  assert.deepEqual(raised.map((item) => item.excerpt).sort(),
    ["no third-party tracker", "no third-party trackers"]);
});

test("a claim whose truth cannot be derived is an error, never a quiet pass", () => {
  assert.throws(() => observeDocumentationClaims({
    documents: { "ARCHITECTURE.md": "no third-party trackers" },
    facts: {},
    claims: [CLAIMS.find((claim) => claim.id === "third-party-loader-absence")],
  }), DocumentationClaimError);
});

test("the frozen audited fixture reproduces every audited counterexample", () => {
  const report = observe(FROZEN.collapsed);
  assert.equal(report.status, "drift");
  for (const type of FROZEN.expected_finding_types) {
    assert.ok(report.counts[type] > 0, `${type} is visible on the audited fixture`);
  }
  const byClaim = new Set(report.findings.map((item) => item.claim_id));
  for (const claimId of [
    "worker-release-classification",
    "worker-cron-count",
    "worker-cron-diagram-sole-schedule",
    "r2-source-vault-custody",
    "third-party-loader-absence",
    "public-stats-product-use",
    "materialization-completed",
    "materialization-exception-closure",
    "materialization-exception-reference",
  ]) {
    assert.ok(byClaim.has(claimId), `${claimId} raises a named finding on the audited fixture`);
  }
});

test("every audited finding carries a claim locator and a source locator", () => {
  for (const item of observe(FROZEN.collapsed).findings) {
    assert.ok(item.document, "the finding names the document");
    assert.ok(Number.isInteger(item.line) && item.line > 0, "the finding names the line");
    assert.ok(item.excerpt.length > 0, "the finding quotes the claim");
    assert.ok(item.source.path, "the finding names the committed owner");
    assert.ok(item.claim_id && item.claim_title, "the finding is named");
  }
});

test("the audited statement register points every finding back to the pinned revision", () => {
  assert.equal(FROZEN.pinned_revision, "3173824eed3f503858b01ae3cd6a0c7e1a705a16");
  const registered = new Set(FROZEN.audited_statements.map((row) => row.claim_id));
  const raised = new Set(observe(FROZEN.collapsed).findings
    .filter((item) => item.blocking)
    .map((item) => item.claim_id));
  for (const claimId of raised) {
    assert.ok(registered.has(claimId), `${claimId} is registered in audited_statements`);
  }
  for (const row of FROZEN.audited_statements) {
    assert.ok(row.document && Number.isInteger(row.line), `${row.claim_id} names its pinned locator`);
  }
});

test("every positive control holds at its declared status", () => {
  for (const [id, control] of Object.entries(FROZEN.controls)) {
    const report = observe(control);
    assert.equal(report.status, control.status || "healthy", `control ${id}`);
    if ((control.status || "healthy") !== "drift") {
      assert.deepEqual(report.findings.filter((item) => item.blocking), [], `control ${id} raises no contradiction`);
    }
  }
});

test("the same audited wording is clean when the configuration makes it true", () => {
  const control = FROZEN.controls["same-wording-true-under-different-configuration"];
  const report = observe(control);
  assert.equal(report.status, "healthy");
  const drifted = observe({ documents: control.documents, facts: FROZEN.collapsed.facts });
  assert.ok(drifted.findings.some((item) => item.blocking),
    "the identical wording is a finding only because the facts contradict it");
});

test("explicit target-policy language stays a review obligation, never a contradiction", () => {
  const report = observe(FROZEN.controls["explicit-target-policy-language"]);
  assert.equal(report.status, "review");
  assert.equal(findingsOfType(report, DOCUMENTATION_CLAIM_FINDINGS.REVIEW_NEEDED).length > 0, true);
  for (const item of report.findings) assert.equal(item.blocking, false);
});

test("a review-needed observation names who adjudicates it and never carries a review date", () => {
  const report = observeRepository();
  const review = findingsOfType(report, DOCUMENTATION_CLAIM_FINDINGS.REVIEW_NEEDED);
  assert.ok(review.length > 0, "unsupported claims stay visible");
  for (const item of review) {
    assert.ok(item.expected.adjudicated_by, "the owner who can settle it is named");
    assert.ok(!("reviewed_at" in item) && !("last_reviewed" in item),
      "a machine observation never proposes an editorial review date");
  }
});

test("the working tree carries no contradicted claim, and does not report a bare green", () => {
  const report = observeRepository();
  assert.deepEqual(report.findings.filter((item) => item.blocking), []);
  assert.equal(report.status, "review");
  assert.deepEqual(report.uncovered_documents, []);
});

test("re-running unchanged inputs is deterministic", () => {
  const first = observeRepository();
  const second = observeRepository();
  assert.deepEqual(second, first);
});

test("an unrelated text edit does not present a standing finding as new", () => {
  const documents = { ...FROZEN.collapsed.documents };
  const observation = { documents, facts: FROZEN.collapsed.facts };
  const before = buildDocumentationReviewReport({
    observation: observe(observation),
    checkedAt: "2026-09-07",
    observedCommit: COMMIT,
    coveredDocuments: coveredDocuments(REGISTRY),
  });
  const edited = {
    documents: {
      ...documents,
      "ARCHITECTURE.md": `An unrelated new paragraph about naming.\n\n${documents["ARCHITECTURE.md"]}\n\nA closing note.\n`,
    },
    facts: FROZEN.collapsed.facts,
  };
  const after = buildDocumentationReviewReport({
    observation: observe(edited),
    checkedAt: "2026-09-08",
    observedCommit: COMMIT,
    coveredDocuments: coveredDocuments(REGISTRY),
  });
  assert.equal(after.content_hash, before.content_hash);
  assert.deepEqual(documentationReviewDelta(before, after).new_ids, []);
});

test("a changed source fact invalidates the review", () => {
  const base = observe(FROZEN.collapsed);
  const facts = JSON.parse(JSON.stringify(FROZEN.collapsed.facts));
  facts.release_infrastructure.crons.push({ schedule: "0 15 * * *" });
  const moved = observe({ documents: FROZEN.collapsed.documents, facts });
  assert.notEqual(moved.facts_digest, base.facts_digest);
});

test("a changed claim owner invalidates the review", () => {
  const base = observe(FROZEN.collapsed);
  const claims = JSON.parse(JSON.stringify(CLAIMS));
  claims[0].owner.path = "docs/somewhere-else.md";
  const moved = observeDocumentationClaims({ ...FROZEN.collapsed, claims });
  assert.notEqual(moved.claims_digest, base.claims_digest);
});

test("resident-read facts are read from the committed manifests, never re-derived", () => {
  const facts = buildResidentReadFacts();
  assert.ok(facts.open_debt_routes.includes("/notice"),
    "the recorded notice departure is still open, which is what the completion claims contradict");
  assert.equal(facts.gate, "tools/no_live_external_reads.mjs");
  assert.equal(facts.manifest, "architecture/no-live-external-debt.json");
  for (const route of facts.open_debt_routes) {
    assert.ok(facts.declared_debt_routes.includes(route), `${route} is a declared temporary-debt route`);
  }
});

test("the derived facts come from the existing derivers and stay consistent with them", () => {
  const facts = collectDocumentationFacts();
  assert.equal(facts.release_infrastructure.pipelines["cloudflare-worker"].manual_only, false);
  assert.equal(facts.release_infrastructure.crons.length, 3);
  assert.equal(facts.release_infrastructure.binding_active.SOURCE_VAULT, false);
  assert.equal(facts.collection_boundary.third_party_loader.configured, true);
  assert.equal(facts.collection_boundary.public_search_usage.metric_ids.length, 2);
});

test("the frozen facts still match the facts derived at this revision", () => {
  const live = collectDocumentationFacts();
  const frozen = FROZEN.collapsed.facts;
  assert.equal(frozen.release_infrastructure.pipelines["cloudflare-worker"].manual_only,
    live.release_infrastructure.pipelines["cloudflare-worker"].manual_only);
  assert.equal(frozen.release_infrastructure.crons.length, live.release_infrastructure.crons.length);
  assert.equal(frozen.release_infrastructure.binding_active.SOURCE_VAULT,
    live.release_infrastructure.binding_active.SOURCE_VAULT);
  assert.equal(frozen.collection_boundary.third_party_loader.configured,
    live.collection_boundary.third_party_loader.configured);
  assert.deepEqual(frozen.collection_boundary.public_search_usage.metric_ids,
    live.collection_boundary.public_search_usage.metric_ids);
  assert.deepEqual(frozen.resident_read.open_debt_routes, live.resident_read.open_debt_routes);
});

test("a report never carries a build clock in place of a review date", () => {
  assert.throws(() => buildDocumentationReviewReport({
    observation: observeRepository(),
    observedCommit: COMMIT,
  }), /never reads a clock/);
});

test("the consumer rehearsal proves occurrence, deduplication, resolution and recurrence", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "documentation-review-"));
  try {
    const receipt = await rehearseConsumerLineage({ stateDir });
    const stages = Object.fromEntries(receipt.stages.map((stage) => [stage.stage, stage]));
    assert.equal(stages["first-occurrence"].new_findings, 16);
    assert.equal(stages["unchanged-replay-same-slot"].new_findings, 0);
    assert.equal(stages["unchanged-replay-same-slot"].event_id, stages["first-occurrence"].event_id);
    assert.equal(stages["unchanged-replay-same-slot"].outbox_events, 1);
    assert.equal(stages["unchanged-replay-next-slot"].new_findings, 0);
    assert.equal(stages["unchanged-replay-next-slot"].content_hash, stages["first-occurrence"].content_hash);
    assert.equal(stages.resolution.resolved_findings, 16);
    assert.equal(stages.resolution.report_status, "healthy");
    assert.equal(stages.recurrence.new_findings, 16);
    assert.equal(stages.recurrence.recurs_under_first_occurrence_identity, true);
    for (const stage of receipt.stages) {
      assert.equal(stage.outbox_intent, "none", "the rehearsal opens, comments on, and closes nothing");
      assert.deepEqual(stage.replay_errors, []);
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("the committed rehearsal receipt is what the rehearsal produces", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "documentation-review-receipt-"));
  try {
    const receipt = await rehearseConsumerLineage({ stateDir });
    const committed = JSON.parse(readFileSync(
      join(ROOT, "docs/evidence/documentation-drift-review/consumer-rehearsal-receipt.json"), "utf8"));
    assert.deepEqual(receipt, committed);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("the finding vocabulary stays closed", () => {
  const declared = new Set(Object.values(DOCUMENTATION_CLAIM_FINDINGS));
  for (const item of observe(FROZEN.collapsed).findings) assert.ok(declared.has(item.type));
  for (const type of BLOCKING_FINDING_TYPES) assert.ok(declared.has(type));
  for (const claim of CLAIMS) {
    if (claim.finding_type) assert.ok(BLOCKING_FINDING_TYPES.includes(claim.finding_type));
  }
});

test("--check exits clean on the working tree and still prints the review obligations", () => {
  const result = execFileSync(process.execPath, ["tools/documentation_drift_review.mjs", "--check"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.match(result, /documentation-review-needed:/);
  assert.match(result, /0 contradicted/);
  assert.match(result, /status review/);
});

test("the claim registry is the only place a covered document is added", () => {
  const text = readFileSync(join(ROOT, CLAIM_REGISTRY_PATH), "utf8");
  assert.match(text, /"schema": "cityscroll\.architecture\.documentation_claim_registry\.v1"/);
  assert.equal(JSON.parse(text).documents.length, 5);
});
