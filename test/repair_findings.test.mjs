// A monitor finding only reaches the repair rail if it can be named the same
// way twice. These cases pin the naming: the signature a condition gets, the
// scope a recovery closes, and the bound on both.
import assert from "node:assert/strict";
import test from "node:test";

import {
  REPAIR_FAILURE_CLASSES,
  REPAIR_FINDING_LIMIT,
  REPAIR_SIGNATURE_LIMIT,
  digestShadowFailureClass,
  mergeRepairFindings,
  missedSlotFindings,
  monitorRepairFindings,
  parseRepairSignature,
  repairScopePrefix,
  repairSignature,
  sanitizeFindingText,
  sourceContractFailureClass,
  upstreamFailureEvidence,
} from "../tools/repair_findings.mjs";

const OBSERVED = "2026-09-07T10:24:11.166Z";

const SOURCE_JOB = { id: "source-contracts-live", runner: "source-contracts" };
const FRESHNESS_JOB = { id: "source-freshness-watchdog", runner: "source-freshness" };
const DIGEST_JOB = { id: "digest-shadow-monitor", runner: "digest-shadow" };

test("a signature names the monitor, the failure class and the subject, and nothing else", () => {
  const signature = repairSignature({
    monitor: "source-contracts-live",
    failureClass: "source-contract-stale",
    subject: "cfb-campaign-contributions",
  });
  assert.equal(signature, "monitor:source-contracts-live:source-contract-stale:cfb-campaign-contributions");
  assert.deepEqual(parseRepairSignature(signature), {
    monitor: "source-contracts-live",
    failure_class: "source-contract-stale",
    subject: "cfb-campaign-contributions",
  });
  // The recovery scope is the same identity with the subject dropped, so a
  // recovered monitor closes every subject it no longer reports.
  assert.equal(
    repairScopePrefix({ monitor: "source-contracts-live", failureClass: "source-contract-stale" }),
    "monitor:source-contracts-live:source-contract-stale",
  );
});

test("a failure class outside the closed vocabulary produces no signature at all", () => {
  assert.equal(repairSignature({ monitor: "source-contracts-live", failureClass: "whatever-broke" }), null);
  assert.equal(parseRepairSignature("monitor:source-contracts-live:whatever-broke"), null);
  // A signature is a stored key and a playbook selector, so the shapes that are
  // neither are refused rather than half-read.
  assert.equal(parseRepairSignature("source-contracts-live:source-contract-stale"), null);
  assert.equal(parseRepairSignature("monitor:a:source-contract-stale:b:c"), null);
  assert.equal(parseRepairSignature(`monitor:${"a".repeat(200)}:source-contract-stale`), null);
});

test("a subject that is prose rather than an identifier still yields a bounded key", () => {
  const signature = repairSignature({
    monitor: "source-contracts-live",
    failureClass: "source-contract-stale",
    subject: "some source; rm -rf / && echo $(whoami)",
  });
  assert.ok(signature.length <= REPAIR_SIGNATURE_LIMIT);
  assert.match(signature, /^monitor:[A-Za-z0-9._:-]+$/);
  assert.equal(parseRepairSignature(signature)?.failure_class, "source-contract-stale");
});

test("finding text is redacted and bounded before it leaves the host", () => {
  const text = sanitizeFindingText(`contacted resident@example.com with Authorization: Bearer abc123 ${"x".repeat(500)}`);
  assert.doesNotMatch(text, /resident@example\.com/);
  assert.doesNotMatch(text, /abc123/);
  assert.ok(text.length <= 200);
});

test("each failing source contract becomes one item, and the healthy rest recover as a scope", () => {
  const observed = monitorRepairFindings(SOURCE_JOB, {
    result: {
      observed_at: OBSERVED,
      status: "degraded",
      failures: [
        { id: "cfb-campaign-contributions", detail: "source is stale (261 days; limit 30)" },
        { id: "some-outage-source", detail: "fetch failed for machine endpoint" },
      ],
      healthy: ["nyc-community-boards"],
    },
  });
  assert.deepEqual(observed.findings.map((row) => row.signature), [
    "monitor:source-contracts-live:source-contract-stale:cfb-campaign-contributions",
    "monitor:source-contracts-live:source-contract-outage:some-outage-source",
  ]);
  assert.equal(observed.findings[0].guard, "source-contracts-live");
  assert.equal(observed.findings[0].stage, "source-contract-stale");
  assert.match(observed.findings[0].findings[0], /261 days; limit 30/);

  // Each class of source-contract failure is a closed scope: the monitor
  // evaluated every contract, so anything not still failing has recovered.
  const stale = observed.recovered.find((row) => row.prefix.endsWith("source-contract-stale"));
  assert.deepEqual(stale.still_failing, ["cfb-campaign-contributions"]);
  const drift = observed.recovered.find((row) => row.prefix.endsWith("source-contract-schema-drift"));
  assert.deepEqual(drift.still_failing, []);
});

test("a monitor that fully recovers closes its scope without having to remember what failed", () => {
  const observed = monitorRepairFindings(SOURCE_JOB, {
    result: { observed_at: OBSERVED, status: "healthy", failures: [], healthy: ["a", "b"] },
  });
  assert.deepEqual(observed.findings, []);
  assert.equal(observed.recovered.length, 3);
  for (const row of observed.recovered) assert.deepEqual(row.still_failing, []);
});

test("the source-contract classification is the monitor's own, not a second opinion", () => {
  assert.equal(sourceContractFailureClass("source is stale (261 days; limit 30)"), "source-contract-stale");
  assert.equal(sourceContractFailureClass("metadata fetch failed"), "source-contract-outage");
  assert.equal(sourceContractFailureClass("missing fields recipname"), "source-contract-schema-drift");
});

test("an upstream gateway error inside a redline is read as an upstream fault", () => {
  // The rehearsal answers the probe with 200 and reports the outage in a
  // redline, so a classifier that only read the probe status would call a
  // gateway failure a content defect.
  const result = {
    status: "degraded",
    http_status: 200,
    summary: {
      status: "NEEDS_ATTENTION",
      redlines: [
        { code: "render_error", digest_id: "watch:rivington", evidence: { error: "SODA 524" } },
      ],
    },
  };
  assert.match(upstreamFailureEvidence(result), /watch:rivington/);
  assert.equal(digestShadowFailureClass(result), "digest-shadow-upstream");

  const contentOnly = { status: "degraded", http_status: 200, summary: { redlines: [{ code: "historical_watch_zero" }] } };
  assert.equal(upstreamFailureEvidence(contentOnly), null);
  assert.equal(digestShadowFailureClass(contentOnly), "digest-shadow-degraded");

  assert.equal(digestShadowFailureClass({ degraded_reason: "admin-credential-missing" }), "digest-shadow-credential");
  assert.equal(digestShadowFailureClass({ http_status: 503 }), "digest-shadow-upstream");
});

test("a stale freshness watchdog files one item per source and one scope for the rest", () => {
  const observed = monitorRepairFindings(FRESHNESS_JOB, {
    result: {
      observed_at: OBSERVED,
      status: "degraded",
      stale_sources: [
        { source_contract_id: "nyc-council-members", reasons: ["acquisition-missing"] },
      ],
      publication_cycle: { failing_stage: null, findings: [] },
    },
  });
  assert.deepEqual(observed.findings.map((row) => row.signature), [
    "monitor:source-freshness-watchdog:freshness-stale:nyc-council-members",
  ]);
  assert.match(observed.findings[0].findings[0], /acquisition-missing/);
  const cycle = observed.recovered.find((row) => row.prefix.endsWith("publication-cycle-stalled"));
  assert.deepEqual(cycle.still_failing, []);
});

test("a degraded rehearsal is one item for the rehearsal, not one per digest", () => {
  // The unit of repair is the rehearsal: re-running it addresses every digest
  // it built, so one item per digest would buy identical re-runs.
  const observed = monitorRepairFindings(DIGEST_JOB, {
    result: {
      observed_at: OBSERVED,
      status: "degraded",
      http_status: 200,
      summary: { status: "NEEDS_ATTENTION", redlines: [{ code: "render_error", digest_id: "watch:rivington", evidence: { error: "SODA 524" } }] },
    },
  });
  assert.equal(observed.findings.length, 1);
  assert.equal(observed.findings[0].signature, "monitor:digest-shadow-monitor:digest-shadow-upstream");
  const upstream = observed.recovered.find((row) => row.prefix.endsWith("digest-shadow-upstream"));
  assert.ok(upstream.still_failing.length > 0, "a scope-level finding still open reports something failing");
  const degraded = observed.recovered.find((row) => row.prefix.endsWith("digest-shadow-degraded"));
  assert.deepEqual(degraded.still_failing, []);
});

test("an attempted slot that threw becomes a finding and carries no recovery scope", () => {
  const observed = missedSlotFindings(SOURCE_JOB, ["2026-09-07T10-23"], { observedAt: OBSERVED });
  assert.equal(observed.findings[0].signature, "monitor:source-contracts-live:missed-slot:2026-09-07T10-23");
  assert.match(observed.findings[0].findings[0], /left no recorded result/);
  // A scope closes items a monitor has stopped reporting, and the slot ledger
  // stops reporting a missed slot immediately — it accounts for one exactly
  // once and advances past it. A scope here would therefore close the item on
  // the very next cycle, before anything had a chance to re-run the slot.
  assert.deepEqual(observed.recovered, []);
});

test("merging many monitor runs is idempotent and bounded", () => {
  const one = monitorRepairFindings(SOURCE_JOB, {
    result: { observed_at: OBSERVED, failures: [{ id: "a", detail: "source is stale (9 days; limit 1)" }] },
  });
  // The same condition observed twice folds to one item, because the signature
  // is the identity and nothing about recency is part of it.
  const merged = mergeRepairFindings([one, one]);
  assert.equal(merged.findings.length, 1);
  const flood = mergeRepairFindings([monitorRepairFindings(SOURCE_JOB, {
    result: {
      observed_at: OBSERVED,
      failures: Array.from({ length: 60 }, (_row, index) => ({ id: `source-${index}`, detail: "source is stale (9 days; limit 1)" })),
    },
  })]);
  assert.equal(flood.findings.length, REPAIR_FINDING_LIMIT);
});

test("the closed vocabulary is the whole vocabulary", () => {
  // Every class a monitor can produce has to be one the playbook registry and
  // the queue both already know, or a finding would arrive with a name nothing
  // downstream can act on.
  assert.ok(REPAIR_FAILURE_CLASSES.length > 0);
  assert.deepEqual([...REPAIR_FAILURE_CLASSES].sort(), [...new Set(REPAIR_FAILURE_CLASSES)].sort());
  for (const failureClass of REPAIR_FAILURE_CLASSES) {
    assert.match(failureClass, /^[a-z][a-z-]+$/, `${failureClass} is not a signature-safe class name`);
  }
});
