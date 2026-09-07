/**
 * The measurement review lane. What is asserted here is mostly what the lane refuses to do:
 * read a clock, schedule itself, reach an outward surface, carry private material, or turn an
 * unavailable check into a failed measurement.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import { withTempDir } from "../tools/lib/with_temp_dir.mjs";

import {
  ANALYTICS_COLLECTOR_SURFACES,
  ANALYTICS_ROUTE_SURFACES,
} from "../site/analytics_surface_taxonomy.mjs";
import {
  MEASUREMENT_REVIEW_CHECKS,
  MEASUREMENT_REVIEW_FINDING_KINDS,
  MEASUREMENT_REVIEW_JOB_ID,
  MEASUREMENT_REVIEW_SCHEMA,
  buildMeasurementReviewReport,
  measurementReviewDelta,
  measurementReviewFindingId,
  measurementReviewRoutePath,
  renderMeasurementReviewSection,
  validateMeasurementReviewReport,
} from "../site/measurement_review_source.mjs";
import {
  checkMeasurementReviewReferences,
  collectorDocuments,
  parseArgs,
  statsWorkedPaths,
} from "../tools/build_measurement_review.mjs";

const ROOT = new URL("../", import.meta.url);

const routeManifest = JSON.parse(readFileSync(new URL("site/data/performance-classification-manifest.v1.json", ROOT), "utf8"));
const sourceContracts = JSON.parse(readFileSync(new URL("site/data/source_contracts.json", ROOT), "utf8"));
const coverageSnapshot = JSON.parse(readFileSync(new URL("site/data/served_coverage_snapshot.json", ROOT), "utf8"));
const demoManifest = JSON.parse(readFileSync(new URL("site/demo/demo-links.json", ROOT), "utf8"));

function report(overrides = {}) {
  return buildMeasurementReviewReport({
    routeSurfaces: ANALYTICS_ROUTE_SURFACES,
    collectorSurfaces: ANALYTICS_COLLECTOR_SURFACES,
    routeManifest,
    collectorDocuments: collectorDocuments(),
    sourceContracts,
    coverageSnapshot,
    workedPaths: statsWorkedPaths(),
    demoManifest,
    checkedAt: "2026-09-06",
    observedCommit: "0".repeat(40),
    runKey: "2026-W36",
    ...overrides,
  });
}

test("the tracked contracts answer for each other today", () => {
  assert.deepEqual(checkMeasurementReviewReferences(), []);
});

test("the report is a pure function of its inputs", () => {
  const first = report();
  const second = report();
  assert.equal(first.content_hash, second.content_hash);
  assert.deepEqual(first, second);
  assert.deepEqual(validateMeasurementReviewReport(first), []);
  assert.equal(first.schema, MEASUREMENT_REVIEW_SCHEMA);
  assert.equal(first.job_id, MEASUREMENT_REVIEW_JOB_ID);
  assert.deepEqual(first.checks.map((check) => check.id), [
    "source_participation",
    "route_taxonomy_compatibility",
    "metric_reconciliation",
    "example_validity",
    "missing_publication",
  ]);
});

test("all five checks are exercised, and each one raises what it is for", () => {
  const raised = report({
    // A source the coverage counts that the registry no longer holds.
    coverageSnapshot: {
      domains: [{
        domain_id: "contracts",
        units: [{ unit_id: "registered-contracts", state: "measured", source_id: "a-source-nobody-registered", sources: [] }],
      }],
    },
    // A route-map surface the vocabulary does not answer for.
    routeManifest: {
      surfaces: [
        ...routeManifest.surfaces,
        { surface_id: "brand-new-thing", route_family: "brand-new", public_safe_matcher: [{ kind: "exact", pathname: "/brand-new" }] },
      ],
    },
    // A stored day that no longer matches the receipts, and a recoverable gap.
    reconciliation: {
      rows: [{ day: "2026-09-02", state: "divergent", stored: { searches_run: 3 }, recomputed: { searches_run: 1 } }],
      missing_days: ["2026-09-03", "2026-06-01"],
      unrecoverable_days: ["2026-06-01"],
    },
    // A worked path pointing at a route nothing registers.
    workedPaths: [{ href: "notices/20231222103" }, { href: "invented/route/" }, { href: "x", demo_id: "not-a-demo" }],
    // A promised snapshot that was not published.
    publication: { ok: false, failing_stage: "missing-daily-aggregate", promised_day: "2026-09-04", evidence: { newest_day: "2026-09-01" } },
  });
  const byKind = Object.fromEntries(MEASUREMENT_REVIEW_FINDING_KINDS.map((kind) => [
    kind, raised.findings.filter((item) => item.kind === kind).map((item) => item.subject),
  ]));
  assert.deepEqual(byKind.source_participation, ["registered-contracts:a-source-nobody-registered"]);
  assert.ok(byKind.route_taxonomy_drift.includes("route-map:brand-new-thing"));
  assert.deepEqual(byKind.metric_reconciliation, ["divergent:2026-09-02", "gap:2026-09-03"],
    "a gap beyond the receipts is not raised as work a rerun could do");
  assert.ok(byKind.example_invalid.includes("route:/invented/route/"));
  assert.ok(byKind.example_invalid.includes("demo:not-a-demo"));
  assert.deepEqual(byKind.publication_missing, ["publication:missing-daily-aggregate"]);
  assert.deepEqual(byKind.check_unavailable, [], "every check ran");
  assert.deepEqual(validateMeasurementReviewReport(raised), []);
});

test("an absent observation is a check that could not run, never a measurement that went wrong", () => {
  const bare = report();
  const kinds = bare.findings.map((item) => item.kind);
  assert.deepEqual([...new Set(kinds)], ["check_unavailable"]);
  assert.deepEqual(
    bare.findings.map((item) => item.subject).sort(),
    ["daily publication", "metric reconciliation"],
  );
  const unreadable = report({ publication: { ok: false, failing_stage: "observation-unavailable" } });
  assert.equal(
    unreadable.findings.find((item) => item.subject === "daily publication").kind,
    "check_unavailable",
  );
});

test("the same observation twice is the same finding, and a delta reports only what moved", () => {
  const first = report({ publication: { ok: false, failing_stage: "frozen-publisher", promised_day: "2026-09-04" } });
  const second = report({
    publication: { ok: false, failing_stage: "frozen-publisher", promised_day: "2026-09-04" },
    checkedAt: "2026-09-13",
    runKey: "2026-W37",
  });
  const publicationFinding = (candidate) => candidate.findings.find((item) => item.kind === "publication_missing");
  assert.equal(publicationFinding(first).finding_id, publicationFinding(second).finding_id);
  assert.equal(
    publicationFinding(first).finding_id,
    measurementReviewFindingId("publication_missing", "publication:frozen-publisher"),
  );
  const delta = measurementReviewDelta(first, second);
  assert.deepEqual(delta.new_ids, []);
  assert.equal(delta.persisting_ids.length, second.findings.length);
  assert.deepEqual(delta.resolved_ids, []);

  const recovered = report({ publication: { ok: true, promised_day: "2026-09-04" } });
  assert.ok(measurementReviewDelta(first, recovered).resolved_ids.includes(publicationFinding(first).finding_id));
});

test("the section a review includes is plain, sorted, and names no reviewer", () => {
  const text = renderMeasurementReviewSection(report({
    publication: { ok: false, failing_stage: "missing-daily-aggregate", promised_day: "2026-09-04" },
  }));
  assert.match(text, /^## Published measurement$/m);
  assert.match(text, /### publication missing/);
  assert.doesNotMatch(text, /assignee|reviewer|queue|approve|reject/i);
  assert.match(renderMeasurementReviewSection(report({
    reconciliation: { rows: [], missing_days: [], unrecoverable_days: [] },
    publication: { ok: true },
  })), /All five checks ran and found nothing to look at\./);
});

test("a report carrying private material is refused rather than handed on", () => {
  const leaking = report();
  leaking.findings[0].evidence = { subscriber: "someone" };
  const errors = validateMeasurementReviewReport(leaking);
  assert.ok(errors.some((error) => error.includes("private material")));
});

test("a route path is a same-site path with its query and fragment removed", () => {
  assert.equal(measurementReviewRoutePath("notices/20231222103?walk=abc"), "/notices/20231222103");
  assert.equal(measurementReviewRoutePath("browse/zoning/#land/2022M0258"), "/browse/zoning/");
  assert.equal(measurementReviewRoutePath("https://example.org/notices/1"), null);
  assert.equal(measurementReviewRoutePath("//example.org/x"), null);
});

test("the lane adds no scheduler, no mail route, and no clock of its own", () => {
  const jobs = JSON.parse(readFileSync(new URL("tools/external_schedule_jobs.json", ROOT), "utf8"));
  assert.equal(jobs.scheduler.ownership, "independent");
  assert.equal(
    jobs.jobs.map((job) => job.id).includes(MEASUREMENT_REVIEW_JOB_ID),
    false,
    "the weekly review lane must not register a daily schedule here",
  );
  const tool = readFileSync(new URL("tools/build_measurement_review.mjs", ROOT), "utf8");
  assert.equal(/setInterval|setTimeout|cron|launchd/i.test(tool), false);
  assert.equal(/createGitHubClient|GITHUB_TOKEN|sendMail|recipients|subscribers/.test(tool), false);
  assert.match(tool, /mode: "none"/);
  assert.match(tool, /NO_MUTATION_CLIENT/);
  const source = readFileSync(new URL("site/measurement_review_source.mjs", ROOT), "utf8");
  assert.equal(/Date\.now|new Date\(/.test(source), false, "the projection must not read a clock");
  assert.throws(() => report({ checkedAt: undefined }), /checked_at/);
});

test("the command line refuses an argument it does not understand", () => {
  assert.deepEqual(parseArgs(["--check"]), { check: true });
  assert.deepEqual(parseArgs(["--checked-at=2026-09-06"]), { "checked-at": "2026-09-06" });
  assert.throws(() => parseArgs(["-c"]), /unrecognized argument/);
});

test("a rehearsal reaches no outward surface and a replay produces no second event", async () => {
  await withTempDir("measurement-review", async (stateDir) => {
  const run = () => execFileSync(process.execPath, [
    "tools/build_measurement_review.mjs",
    "--rehearse",
    "--checked-at=2026-09-06",
    "--run-key=2026-W36",
    `--state-dir=${stateDir}`,
  ], { cwd: new URL(".", ROOT).pathname, encoding: "utf8" });
  const first = run();
  assert.match(first, /replay ok/);
  const second = run();
  assert.match(second, /0 new, \d+ unchanged, 0 resolved/);
  assert.equal(first.match(/event ([0-9a-f]{32})/)[1], second.match(/event ([0-9a-f]{32})/)[1]);
  });
});

test("every check the lane declares has a finding kind that can express it", () => {
  for (const check of MEASUREMENT_REVIEW_CHECKS) {
    assert.ok(check.question.endsWith("?"), check.id);
  }
  assert.deepEqual(MEASUREMENT_REVIEW_FINDING_KINDS, [...MEASUREMENT_REVIEW_FINDING_KINDS].sort());
});
