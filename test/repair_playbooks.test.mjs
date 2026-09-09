// A repair the scheduler runs by itself is only safe if it is boring: the same
// signature always picks the same playbook, the playbook only ever does the one
// scripted thing, and it cannot report a repair it did not verify. These cases
// exercise every playbook against stubs, so none of them needs a publisher, a
// scheduler host, or a checkout to be pinned.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  REPAIR_DISPATCH_BUDGET_MS,
  REPAIR_JUDGMENT_CLASSES,
  REPAIR_PLAYBOOKS,
  UPSTREAM_BACKOFF_MS,
  acquisitionCommand,
  repairPlaybookRegistry,
  selectRepairPlaybook,
} from "../tools/repair_playbooks.mjs";
import { REPAIR_FAILURE_CLASSES, parseRepairSignature, upstreamFailureEvidence } from "../tools/repair_findings.mjs";
import { REPAIR_DISPATCH_TIMEOUT_MS } from "../tools/external_schedule_runner.mjs";
import { FRESHNESS_PATH_ABSENT_REASONS, FRESHNESS_PUBLICATION_PATHS } from "../tools/repair_dispatch.mjs";

const NOW = new Date("2026-09-07T12:00:00.000Z");

/** A contract whose evidence lives on the host: nothing tracked, live-only. */
function hostStateContract(overrides = {}) {
  return {
    id: "host-state-source",
    kind: "socrata",
    domain: "https://data.example.test",
    dataset_id: "abcd-1234",
    delivery_tier: "live-only",
    max_stale_days: 30,
    code_references: [{ path: "tools/build_host_state.mjs", contains: "abcd-1234" }],
    ...overrides,
  };
}

/** A contract whose evidence is a file the repository carries. */
function committedContract(overrides = {}) {
  return {
    id: "committed-source",
    kind: "socrata",
    domain: "https://data.example.test",
    dataset_id: "efgh-5678",
    delivery_tier: "edge-materialized",
    max_stale_days: 30,
    code_references: [{ path: "tools/build_committed_source.mjs", contains: "efgh-5678" }],
    warehouse_snapshot: { artifact: "site/data/committed_source.json", materialized_at: "2026-08-11T00:00:00.000Z" },
    ...overrides,
  };
}

/**
 * The seams a playbook is allowed to reach through, all recorded. Every default
 * is the benign answer, so each case states only the fact it is about.
 */
function stubContext(overrides = {}) {
  const calls = { ranJobs: [], slept: [], verified: 0, evaluated: 0 };
  const context = {
    signature: overrides.signature || "monitor:source-contracts-live:source-contract-stale:host-state-source",
    monitor: overrides.monitor || "source-contracts-live",
    subject: "subject" in overrides ? overrides.subject : "host-state-source",
    now: overrides.now || NOW,
    calls,
    upstreamEvidence: upstreamFailureEvidence,
    async sleep(ms) { calls.slept.push(ms); },
    repository: {
      async isTracked(path) { return (overrides.trackedPaths || []).includes(path); },
    },
    contracts: {
      async load() { return { contracts: overrides.contracts || [hostStateContract()] }; },
      async verifyLive() {
        calls.verified += 1;
        const answers = overrides.verifyLive || [staleAnswer(), { ok: true, detail: "abcd-1234 · 0d old", finding: null }];
        return answers[Math.min(calls.verified - 1, answers.length - 1)];
      },
    },
    schedule: {
      async job(id) {
        const registered = overrides.jobs || {
          "source-contracts-live": { id: "source-contracts-live", runner: "source-contracts" },
          // A stand-in for a scheduled job that publishes acquisition receipts.
          // This cycle registers none; the stub exercises the branch that would
          // run one, and the real registry is asserted separately.
          "an-acquisition-publisher": { id: "an-acquisition-publisher", runner: "source-acquisition" },
        };
        return registered[id] || null;
      },
      async runJob(job, options = {}) {
        calls.ranJobs.push({ id: job.id, runKey: options.runKey || null });
        return overrides.runJobResult || { result: { status: "healthy" } };
      },
      async hasResult() {
        const answers = overrides.hasResult || [false, true];
        return answers[Math.min(calls.ranJobs.length, answers.length - 1)];
      },
      async latestResult() { return "latestResult" in overrides ? overrides.latestResult : null; },
    },
    freshness: {
      publicationPath(reasons) {
        if (overrides.publicationPath !== undefined) return overrides.publicationPath;
        return (reasons || []).includes("acquisition-missing") ? "an-acquisition-publisher" : null;
      },
      pathAbsentReason(reasons) {
        for (const reason of reasons || []) {
          const declared = FRESHNESS_PATH_ABSENT_REASONS[reason];
          if (declared) return declared;
        }
        return null;
      },
      async evaluate() {
        calls.evaluated += 1;
        const answers = overrides.freshness || [{ status: "STALE", reason_codes: ["acquisition-missing"] }, { status: "CURRENT", reason_codes: [] }];
        return answers[Math.min(calls.evaluated - 1, answers.length - 1)];
      },
    },
  };
  return context;
}

/**
 * What the live verifier hands back for a freshness failure: both clocks and
 * which side is behind. The playbook reads this rather than measuring either
 * clock itself.
 */
function staleAnswer(overrides = {}) {
  return {
    ok: false,
    detail: "host-state-source: source is stale (publisher rowsUpdatedAt 2026-08-01, 37 days; limit 30)",
    finding: {
      schema: "cityscroll.source_contract_finding.v1",
      source_contract_id: "host-state-source",
      classification: "stale",
      publisher_clock_basis: "rowsUpdatedAt",
      publisher_updated_at: "2026-09-06T00:00:00.000Z",
      publisher_age_days: 1,
      limit_days: 30,
      retained_vintage_at: "2026-08-11T00:00:00.000Z",
      retained_vintage_artifact: null,
      retained_vintage_field: null,
      stale_side: "acquisition",
      ...overrides,
    },
  };
}

function playbook(id) {
  const found = REPAIR_PLAYBOOKS.find((row) => row.id === id);
  assert.ok(found, `no playbook is registered as ${id}`);
  return found;
}

/* --- selection ----------------------------------------------------------- */

test("a signature selects exactly one playbook, and only for the monitor it names", () => {
  const stale = selectRepairPlaybook("monitor:source-contracts-live:source-contract-stale:cfb-campaign-contributions");
  assert.equal(stale.playbook.id, "source-contract-stale");
  assert.equal(stale.parsed.subject, "cfb-campaign-contributions");

  // A missed slot can happen to any monitor, so its playbook declares none and
  // matches on the class alone.
  assert.equal(selectRepairPlaybook("monitor:digest-shadow-monitor:missed-slot:2026-09-07T10-10").playbook.id, "missed-slot");

  // A class the registry knows for one monitor does not silently apply to
  // another that happens to report the same word.
  assert.equal(selectRepairPlaybook("monitor:some-other-monitor:freshness-stale:x").playbook, null);
});

test("an unknown signature is judgment, never a failed repair", () => {
  // Failure means a remedy was tried and did not work, which the queue retries.
  // Nothing was tried here, so retrying would only spend attempts in silence.
  const unparseable = selectRepairPlaybook("not-a-signature");
  assert.equal(unparseable.playbook, null);
  assert.match(unparseable.reason, /monitor:class/);

  const declared = selectRepairPlaybook("monitor:action-links-live:action-link-degraded");
  assert.equal(declared.playbook, null);
  assert.match(declared.reason, /deliberately left to a person/);
  assert.match(declared.reason, /editorial decision/);
});

test("every failure class is either covered by a playbook or declared as judgment", () => {
  // A class that is neither would reach a person with no explanation of why
  // nothing was attempted, which is the silence this rail exists to remove.
  for (const failureClass of REPAIR_FAILURE_CLASSES) {
    const covered = REPAIR_PLAYBOOKS.some((row) => row.failure_class === failureClass);
    const declared = Object.prototype.hasOwnProperty.call(REPAIR_JUDGMENT_CLASSES, failureClass);
    assert.ok(covered || declared, `${failureClass} is neither repaired nor declared as judgment`);
    assert.ok(!(covered && declared), `${failureClass} is both repaired and declared as judgment`);
  }
});

test("no playbook may outlast the bound the cycle kills it at", () => {
  assert.ok(REPAIR_DISPATCH_BUDGET_MS < REPAIR_DISPATCH_TIMEOUT_MS,
    "the dispatch budget must finish inside the cycle's kill so an overrun is reported rather than lost");
  for (const row of REPAIR_PLAYBOOKS) {
    assert.ok(row.budget_ms > 0 && row.budget_ms <= REPAIR_DISPATCH_BUDGET_MS, `${row.id} declares a budget outside the dispatch bound`);
    for (const field of ["precondition", "remedy", "verification", "judgment_when"]) {
      assert.ok(typeof row[field] === "string" && row[field].length > 10, `${row.id} declares no ${field}`);
    }
  }
});

/* --- (a) source contract stale ------------------------------------------- */

test("a condition that cleared before pickup closes without a remedy", async () => {
  // The monitor's own check runs first, so a publisher that moved on between
  // the finding and the lease closes the item instead of provoking a re-run.
  const context = stubContext({ verifyLive: [{ ok: true, detail: "abcd-1234 · 0d old", finding: null }] });
  const result = await playbook("source-contract-stale").run(context);
  assert.equal(result.outcome, "repaired");
  assert.deepEqual(context.calls.ranJobs, []);
});

test("a stale source whose publisher is the stale side is judgment with both clocks", async () => {
  // Re-acquiring would faithfully retrieve the same old data, so the decision
  // is whether the declared limit still matches the publisher, not whether to
  // run anything. Which side is behind is the verifier's determination, read
  // from its finding rather than measured a second time here.
  const context = stubContext({
    contracts: [committedContract()],
    subject: "committed-source",
    verifyLive: [staleAnswer({
      stale_side: "publisher",
      publisher_updated_at: "2025-12-19T00:00:00.000Z",
      publisher_age_days: 262,
      retained_vintage_at: "2026-08-11T00:00:00.000Z",
    })],
  });
  const result = await playbook("source-contract-stale").run(context);
  assert.equal(result.outcome, "judgment");
  assert.match(result.summary, /the publisher is the stale side/);
  assert.match(result.summary, /262 days against a limit of 30/);
  assert.match(result.summary, /publisher updated_at 2025-12-19/);
  assert.match(result.summary, /retained vintage 2026-08-11/);
  assert.equal(context.calls.ranJobs.length, 0, "nothing was run for a publisher this playbook cannot move");
});

test("a source declaring no retained vintage says so rather than re-acquiring blind", async () => {
  const context = stubContext({
    verifyLive: [staleAnswer({ stale_side: "unknown", retained_vintage_at: null })],
  });
  const result = await playbook("source-contract-stale").run(context);
  assert.equal(result.outcome, "judgment");
  assert.match(result.summary, /declares no retained vintage/);
  assert.deepEqual(context.calls.ranJobs, []);
});

test("a stale source retained as a repository file is judgment naming the change", async () => {
  // The identity this rail runs under carries issue write and metadata read. A
  // remedy needing a repository change is outside it by construction.
  const context = stubContext({
    contracts: [committedContract()],
    subject: "committed-source",
    trackedPaths: ["site/data/committed_source.json"],
    verifyLive: [staleAnswer({ retained_vintage_artifact: "site/data/committed_source.json" })],
  });
  const result = await playbook("source-contract-stale").run(context);
  assert.equal(result.outcome, "judgment");
  assert.match(result.summary, /site\/data\/committed_source\.json/);
  assert.match(result.summary, /repository change this identity cannot make/);
  assert.match(result.summary, /node tools\/build_committed_source\.mjs/);
  assert.equal(context.calls.ranJobs.length, 0);
});

test("a stale source whose evidence is host state is re-acquired and re-verified", async () => {
  const context = stubContext({
    verifyLive: [staleAnswer(), { ok: true, detail: "abcd-1234 · 0d old", finding: null }],
  });
  const result = await playbook("source-contract-stale").run(context);
  assert.equal(result.outcome, "repaired");
  assert.deepEqual(context.calls.ranJobs.map((row) => row.id), ["source-contracts-live"]);
  assert.equal(context.calls.verified, 2, "the verification is the monitor's own check, before and after");
  assert.equal(result.verification.ok, true);
});

test("a re-acquired source that still does not verify is a failure, not a claimed repair", async () => {
  const context = stubContext({ verifyLive: [staleAnswer(), staleAnswer()] });
  const result = await playbook("source-contract-stale").run(context);
  assert.equal(result.outcome, "failed");
  assert.match(result.summary, /still does not verify/);
  assert.equal(result.verification.ok, false);
});

test("a live check that now reports a different fault is judgment, not an acquisition", async () => {
  // The queued finding was staleness; a schema drift surfacing in its place is
  // a different repair, and running an acquisition against it would be a guess.
  const context = stubContext({
    verifyLive: [{ ok: false, detail: "host-state-source: missing fields recipname", finding: null }],
  });
  const result = await playbook("source-contract-stale").run(context);
  assert.equal(result.outcome, "judgment");
  assert.match(result.summary, /different fault from the one queued/);
  assert.deepEqual(context.calls.ranJobs, []);
});

test("a contract with no declared acquisition tool says so instead of improvising one", async () => {
  const context = stubContext({ contracts: [hostStateContract({ code_references: [{ path: "site/reader.mjs" }] })] });
  const result = await playbook("source-contract-stale").run(context);
  assert.equal(result.outcome, "judgment");
  assert.match(result.summary, /declares no acquisition tool/);
  assert.equal(acquisitionCommand({ code_references: [{ path: "site/reader.mjs" }] }), null);
});

test("a finding naming a source this repository does not acquire is judgment", async () => {
  const context = stubContext({ subject: "not-a-registered-source" });
  const result = await playbook("source-contract-stale").run(context);
  assert.equal(result.outcome, "judgment");
  assert.match(result.summary, /does not acquire/);
});

/* --- (b) missed slot ------------------------------------------------------ */

test("a missed slot is re-run under its original slot key", async () => {
  const context = stubContext({
    signature: "monitor:source-contracts-live:missed-slot:2026-09-07T10-23",
    subject: "2026-09-07T10-23",
    hasResult: [false, true],
  });
  const result = await playbook("missed-slot").run(context);
  assert.equal(result.outcome, "repaired");
  // The original key, so the re-run lands in the slot that was missed rather
  // than opening a second one beside it.
  assert.deepEqual(context.calls.ranJobs, [{ id: "source-contracts-live", runKey: "2026-09-07T10-23" }]);
});

test("re-running a slot another cycle already recorded does nothing at all", async () => {
  // Idempotence is the property that makes an automatic retry safe: the second
  // pass over the same finding must not run the monitor a second time.
  const context = stubContext({
    signature: "monitor:source-contracts-live:missed-slot:2026-09-07T10-23",
    subject: "2026-09-07T10-23",
    hasResult: [true, true],
  });
  const result = await playbook("missed-slot").run(context);
  assert.equal(result.outcome, "repaired");
  assert.deepEqual(context.calls.ranJobs, []);
  assert.match(result.summary, /already has a recorded result/);
});

test("a slot that records nothing even after a re-run is a failure the queue may retry", async () => {
  const context = stubContext({
    signature: "monitor:source-contracts-live:missed-slot:2026-09-07T10-23",
    subject: "2026-09-07T10-23",
    hasResult: [false, false],
  });
  const result = await playbook("missed-slot").run(context);
  assert.equal(result.outcome, "failed");
});

test("a missed slot for a monitor the cycle no longer carries is judgment", async () => {
  const context = stubContext({
    signature: "monitor:retired-monitor:missed-slot:2026-09-07T10-23",
    monitor: "retired-monitor",
    subject: "2026-09-07T10-23",
  });
  const result = await playbook("missed-slot").run(context);
  assert.equal(result.outcome, "judgment");
  assert.match(result.summary, /no scheduled job is registered/);
});

/* --- (c) digest rehearsal on an upstream fault ---------------------------- */

test("a rehearsal that fails on an upstream error is retried once after a backoff", async () => {
  const context = stubContext({
    signature: "monitor:digest-shadow-monitor:digest-shadow-upstream",
    monitor: "digest-shadow-monitor",
    subject: null,
    jobs: { "digest-shadow-monitor": { id: "digest-shadow-monitor", runner: "digest-shadow" } },
    runJobResult: { result: { status: "healthy" } },
  });
  const result = await playbook("digest-shadow-upstream").run(context);
  assert.equal(result.outcome, "repaired");
  assert.deepEqual(context.calls.slept, [UPSTREAM_BACKOFF_MS]);
  assert.deepEqual(context.calls.ranJobs.map((row) => row.id), ["digest-shadow-monitor"]);
});

test("an upstream still down after the retry is deferred", async () => {
  // The next scheduled observation rechecks the publisher without owner mail.
  const context = stubContext({
    signature: "monitor:digest-shadow-monitor:digest-shadow-upstream",
    monitor: "digest-shadow-monitor",
    subject: null,
    jobs: { "digest-shadow-monitor": { id: "digest-shadow-monitor", runner: "digest-shadow" } },
    runJobResult: {
      result: {
        status: "degraded",
        http_status: 200,
        summary: { status: "NEEDS_ATTENTION", redlines: [{ code: "render_error", digest_id: "watch:rivington", evidence: { error: "SODA 524" } }] },
      },
    },
  });
  const result = await playbook("digest-shadow-upstream").run(context);
  assert.equal(result.outcome, "deferred");
  assert.match(result.summary, /waiting-upstream/);
  assert.match(result.summary, /524/);
  assert.equal(context.calls.slept.length, 1, "exactly one bounded backoff, not a retry loop");
});

test("a rehearsal that comes back degraded for a non-upstream reason is a plain failure", async () => {
  const context = stubContext({
    signature: "monitor:digest-shadow-monitor:digest-shadow-upstream",
    monitor: "digest-shadow-monitor",
    subject: null,
    jobs: { "digest-shadow-monitor": { id: "digest-shadow-monitor", runner: "digest-shadow" } },
    runJobResult: { result: { status: "degraded", http_status: 200, degraded_reason: "rehearsal-not-ready", summary: { status: "NEEDS_ATTENTION", redlines: [] } } },
  });
  const result = await playbook("digest-shadow-upstream").run(context);
  assert.equal(result.outcome, "failed");
  assert.match(result.summary, /NEEDS_ATTENTION/);
});

/* --- (d) freshness watchdog ---------------------------------------------- */

test("a freshness finding whose evidence already advanced closes without running anything", async () => {
  const context = stubContext({
    signature: "monitor:source-freshness-watchdog:freshness-stale:nyc-council-members",
    monitor: "source-freshness-watchdog",
    subject: "nyc-council-members",
    freshness: [{ status: "CURRENT", reason_codes: [] }],
  });
  const result = await playbook("freshness-stale").run(context);
  assert.equal(result.outcome, "repaired");
  assert.deepEqual(context.calls.ranJobs, []);
  assert.match(result.summary, /advanced on its own/);
});

test("a freshness finding whose publication path has not run re-runs it and re-verifies", async () => {
  const context = stubContext({
    signature: "monitor:source-freshness-watchdog:freshness-stale:nyc-council-members",
    monitor: "source-freshness-watchdog",
    subject: "nyc-council-members",
    latestResult: null,
    freshness: [{ status: "STALE", reason_codes: ["acquisition-missing"] }, { status: "CURRENT", reason_codes: [] }],
  });
  const result = await playbook("freshness-stale").run(context);
  assert.equal(result.outcome, "repaired");
  assert.deepEqual(context.calls.ranJobs.map((row) => row.id), ["an-acquisition-publisher"]);
  assert.equal(context.calls.evaluated, 2, "the watchdog's own check decides, before and after");
});

test("a publication path that ran and still did not advance the evidence is judgment naming it", async () => {
  // Two different faults wear the same symptom. A path that has not run is one
  // to re-run; a path that ran and left the evidence stale is a defect in the
  // path, and re-running it would hide that.
  const context = stubContext({
    signature: "monitor:source-freshness-watchdog:freshness-stale:nyc-council-members",
    monitor: "source-freshness-watchdog",
    subject: "nyc-council-members",
    latestResult: { observed_at: "2026-09-07T10:23:00.000Z" },
    freshness: [{ status: "STALE", reason_codes: ["acquisition-missing"] }],
  });
  const result = await playbook("freshness-stale").run(context);
  assert.equal(result.outcome, "judgment");
  assert.match(result.summary, /an-acquisition-publisher/);
  assert.match(result.summary, /is not advancing this source's evidence/);
  assert.deepEqual(context.calls.ranJobs, []);
});

test("an acquisition finding with no acquisition publisher says why, not that a path ran", async () => {
  // The real registry, not a stub: acquisition-missing maps at nothing, because
  // no scheduled job on this cycle publishes acquisition receipts. The summary
  // has to say that rather than claiming a publication path ran and failed to
  // advance the evidence — which is what re-running a check-only job produced,
  // once per source, every day.
  const context = stubContext({
    signature: "monitor:source-freshness-watchdog:freshness-stale:city-record",
    monitor: "source-freshness-watchdog",
    subject: "city-record",
    publicationPath: FRESHNESS_PUBLICATION_PATHS["acquisition-missing"],
    freshness: [{ status: "STALE", reason_codes: ["acquisition-missing"] }],
  });
  const result = await playbook("freshness-stale").run(context);
  assert.equal(result.outcome, "judgment");
  assert.match(result.summary, /no scheduled job on this cycle publishes acquisition receipts/);
  assert.doesNotMatch(result.summary, /did not advance/);
  assert.equal(context.calls.ranJobs.length, 0, "nothing may be re-run when no path publishes the evidence");
});

test("a freshness reason with no scheduled publication path is judgment, never a guess", async () => {
  const context = stubContext({
    signature: "monitor:source-freshness-watchdog:freshness-stale:nyc-council-members",
    monitor: "source-freshness-watchdog",
    subject: "nyc-council-members",
    freshness: [{ status: "STALE", reason_codes: ["monitor-missing"] }],
  });
  const result = await playbook("freshness-stale").run(context);
  assert.equal(result.outcome, "judgment");
  assert.match(result.summary, /no scheduled publication path is registered/);
});

/* --- the registry as data ------------------------------------------------ */

test("the registry renders as data an operator can read beside the documentation", () => {
  const registry = repairPlaybookRegistry();
  assert.equal(registry.playbooks.length, REPAIR_PLAYBOOKS.length);
  assert.equal(registry.judgment_classes.length, Object.keys(REPAIR_JUDGMENT_CLASSES).length);
  for (const row of registry.playbooks) {
    assert.ok(parseRepairSignature(`monitor:${row.monitor || "any-monitor"}:${row.failure_class}`),
      `${row.id} declares a class no signature can carry`);
  }
});

test("the documented playbook table is the registry, not a second description of it", () => {
  // The operator reads the table; the cycle runs the registry. A table that
  // drifts from the registry is worse than no table, because it reads as a
  // promise about what the scheduler will do by itself.
  const docs = readFileSync(fileURLToPath(new URL("../docs/external-schedule-outbox.md", import.meta.url)), "utf8");
  assert.match(docs, /## Automatic repair/);
  assert.match(docs, /CITYSCROLL_REPAIR_DISPATCH_COMMAND/);
  for (const row of REPAIR_PLAYBOOKS) {
    assert.ok(docs.includes(`\`${row.id}\``), `${row.id} is undocumented`);
    for (const field of ["precondition", "remedy", "verification", "judgment_when", ...(row.deferred_when ? ["deferred_when"] : [])]) {
      assert.ok(docs.includes(row[field]), `${row.id} documents a different ${field} from the one it runs`);
    }
  }
  for (const failureClass of Object.keys(REPAIR_JUDGMENT_CLASSES)) {
    assert.ok(docs.includes(`\`${failureClass}\``), `${failureClass} is not documented as a judgment class`);
  }
  // The exit codes are the contract between two files and one operator, so the
  // documentation states them rather than implying them.
  for (const line of ["| `0` | `repaired` |", "| `2` | `judgment` |", "| `4` | `deferred` |", "| anything else | `failed` |"]) {
    assert.ok(docs.includes(line), `the exit-code contract does not document ${line}`);
  }
});


test("an explicit upstream source fault is deferred without a render-error redline", async () => {
  const context = stubContext({
    monitor: "digest-shadow-monitor",
    jobs: { "digest-shadow-monitor": { id: "digest-shadow-monitor" } },
    runJobResult: { result: { status: "degraded", http_status: 200, fault_domain: "upstream_source", summary: { status: "DEGRADED_UPSTREAM" } } },
  });
  assert.equal((await playbook("digest-shadow-upstream").run(context)).outcome, "deferred");
});

test("a source outage rechecks the publisher and defers only an outage", async () => {
  for (const [answer, expected] of [
    [{ ok: false, detail: "metadata fetch failed: HTTP 524" }, "deferred"],
    [{ ok: true, detail: "publisher answers normally" }, "repaired"],
    [{ ok: false, detail: "missing fields: id" }, "judgment"],
    [staleAnswer(), "judgment"],
  ]) {
    const context = stubContext({ verifyLive: [answer] });
    assert.equal((await playbook("source-contract-outage").run(context)).outcome, expected);
    assert.equal(context.calls.verified, 1);
    assert.deepEqual(context.calls.ranJobs, []);
  }
});
