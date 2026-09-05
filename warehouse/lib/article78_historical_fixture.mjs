/**
 * A78-02: the QA-only historical fixture loader.
 *
 * Thirteen documented environmental-review projects and their thirty-six
 * litigation events exist here for one reason: to catch a behavioral
 * regression in A78-01's challenge-watch and decision-supersession
 * derivations (`warehouse/lib/article78_litigation.mjs`). They were selected
 * for being interesting, which is exactly why they must never be fit on --
 * training a model on a hand-picked sample of newsworthy litigation would
 * report the selection as filing prevalence. Three things make that refusal
 * real instead of a comment:
 *
 *  - every record under `warehouse/fixtures/article78/historical/` carries
 *    `fixture_role: "qa_historical"`, so a consumer can filter it out by a
 *    field rather than by convention;
 *  - `assertFixtureExcluded` is a construction-time check a corpus or fold
 *    builder can call on itself, which throws by name rather than trusting
 *    that nobody wires the fixture in;
 *  - `diagnosticMetric` is the only way a number computed over this fixture
 *    may leave this module, and it always says so.
 *
 * The fixture also carries a bounded-search receipt per project, so that
 * A78-03's coverage grading (`warehouse/lib/article78_search_coverage.mjs`)
 * is exercised by the same expectations: a `coverage_grade` expectation runs
 * the grader over one project's receipts and pins the grade it produces.
 *
 * This module adds no record shape. Every event here is exactly one of
 * A78-01's five entities or its `determination_context`, validated with
 * A78-01's own validators after the two loader-owned decorations
 * (`fixture_role`, `project_id`) and the optional `synthetic` flag are
 * stripped off. A second litigation schema is exactly the thing this card was
 * told not to build.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyDecisionSupersession,
  ARTICLE78_DECISION_FILING_TYPES,
  challengeWatchValue,
  validateArticle78RecordSet,
  validateDeterminationContext,
} from "./article78_litigation.mjs";
import { gradeCoverage } from "./article78_search_coverage.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const HISTORICAL_FIXTURE_DIR = join(ROOT, "fixtures/article78/historical");

export const ARTICLE78_HISTORICAL_FIXTURE_SCHEMA = "cityscroll.article78_historical_fixture.v1";
export const HISTORICAL_FIXTURE_ROLE = "qa_historical";

export class Article78HistoricalFixtureError extends Error {
  constructor(message) {
    super(message);
    this.name = "Article78HistoricalFixtureError";
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Remove the loader-owned decorations before handing a record to an A78-01
 * validator, which rejects any field it does not itself define. Stripping
 * exactly these three documented fields is not laundering bad data -- it is
 * the seam between "this row is QA-only fixture metadata" and "this row is an
 * A78-01 record", and every other field is left untouched.
 */
function stripFixtureDecorations(row) {
  const { fixture_role, project_id, synthetic, ...record } = row;
  return record;
}

/** Stable JSON: object keys sorted at every depth, so a hash of it is stable. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * A78-01's stable-key-shaped fields. Ordered with each record type's own
 * primary key first (`case_key` before the `determination_key` a
 * `judicial_case` also carries as a foreign key), so `stableKeyOf` names a
 * record by what it IS rather than by what it merely points to.
 */
const STABLE_KEY_FIELDS = Object.freeze([
  "case_key",
  "filing_key",
  "claim_key",
  "coverage_key",
  "supersession_key",
  "determination_key",
]);

/** The record's own stable A78-01 key, for naming it in an error or offender report. */
function stableKeyOf(record) {
  for (const field of STABLE_KEY_FIELDS) {
    if (typeof record[field] === "string") return record[field];
  }
  return null;
}

/**
 * Every stable-key-shaped field this record carries, primary or foreign
 * (a `judicial_case` carries both `case_key` and `determination_key`; a
 * `case_filing` carries both `filing_key` and `case_key`). The exclusion
 * signature must cover all of them: a corpus row naming this fixture's
 * determination is as much a leak as one naming its case.
 */
function allStableKeysOf(record) {
  return STABLE_KEY_FIELDS
    .map((field) => record[field])
    .filter((value) => typeof value === "string");
}

/**
 * Load the thirteen-project QA fixture, validating every underlying record
 * against A78-01's own validators. Throws on the first invalid row: a
 * historical fixture that does not validate cannot honestly stand in for a
 * regression test.
 */
export function loadHistoricalFixture() {
  const index = readJson(join(HISTORICAL_FIXTURE_DIR, "index.json"));
  const determinations = readJson(join(HISTORICAL_FIXTURE_DIR, "determinations.json"));
  const coverage = readJson(join(HISTORICAL_FIXTURE_DIR, "coverage.json"));
  const cases = readJson(join(HISTORICAL_FIXTURE_DIR, "cases.json"));
  const filings = readJson(join(HISTORICAL_FIXTURE_DIR, "filings.json"));
  const claims = readJson(join(HISTORICAL_FIXTURE_DIR, "claims.json"));
  const supersessions = readJson(join(HISTORICAL_FIXTURE_DIR, "supersessions.json"));

  const allRows = [
    ...determinations.map((row) => ({ row, kind: "determination_context" })),
    ...coverage.map((row) => ({ row, kind: "search_coverage" })),
    ...cases.map((row) => ({ row, kind: "judicial_case" })),
    ...filings.map((row) => ({ row, kind: "case_filing" })),
    ...claims.map((row) => ({ row, kind: "claim_theory" })),
    ...supersessions.map((row) => ({ row, kind: "decision_supersession" })),
  ];
  for (const { row, kind } of allRows) {
    if (row.fixture_role !== HISTORICAL_FIXTURE_ROLE) {
      throw new Article78HistoricalFixtureError(
        `loadHistoricalFixture: ${kind} ${JSON.stringify(stableKeyOf(row))} is missing fixture_role: ${JSON.stringify(HISTORICAL_FIXTURE_ROLE)}`,
      );
    }
    if (typeof row.project_id !== "string" || row.project_id.trim() === "") {
      throw new Article78HistoricalFixtureError(`loadHistoricalFixture: ${kind} ${JSON.stringify(stableKeyOf(row))} is missing project_id`);
    }
  }

  const findings = [];
  determinations.forEach((row, i) => findings.push(...validateDeterminationContext(stripFixtureDecorations(row), `determinations[${i}]`)));
  findings.push(...validateArticle78RecordSet({
    cases: cases.map(stripFixtureDecorations),
    filings: filings.map(stripFixtureDecorations),
    claims: claims.map(stripFixtureDecorations),
    coverage: coverage.map(stripFixtureDecorations),
    supersessions: supersessions.map(stripFixtureDecorations),
  }));
  if (findings.length > 0) {
    throw new Article78HistoricalFixtureError(`loadHistoricalFixture: the historical fixture does not validate: ${findings.join("; ")}`);
  }

  const projectIds = new Set(index.projects.map((project) => project.project_id));
  for (const { row, kind } of allRows) {
    if (!projectIds.has(row.project_id)) {
      throw new Article78HistoricalFixtureError(`loadHistoricalFixture: ${kind} ${JSON.stringify(stableKeyOf(row))} names unknown project_id ${JSON.stringify(row.project_id)}`);
    }
  }
  if (index.projects.length !== 13) {
    throw new Article78HistoricalFixtureError(`loadHistoricalFixture: expected 13 documented projects, found ${index.projects.length}`);
  }

  const expectations = index.projects.flatMap((project) => project.expectations ?? []);

  return {
    schema: ARTICLE78_HISTORICAL_FIXTURE_SCHEMA,
    fixture_role: HISTORICAL_FIXTURE_ROLE,
    projects: index.projects,
    determinations,
    coverage,
    cases,
    filings,
    claims,
    supersessions,
    expectations,
    // Validated, A78-01-shaped rows with the loader's own decorations
    // stripped -- the shape every A78-01 derivation (challengeWatchValue,
    // applyDecisionSupersession, ...) expects as input.
    clean: {
      determinations: determinations.map(stripFixtureDecorations),
      coverage: coverage.map(stripFixtureDecorations),
      cases: cases.map(stripFixtureDecorations),
      filings: filings.map(stripFixtureDecorations),
      claims: claims.map(stripFixtureDecorations),
      supersessions: supersessions.map(stripFixtureDecorations),
    },
  };
}

/** Every stable key and content fingerprint the fixture is known by. */
function collectFixtureSignature(fixture) {
  const ids = new Set();
  for (const project of fixture.projects) ids.add(project.project_id);
  const fingerprints = new Set();
  const rowGroups = [
    fixture.determinations, fixture.coverage, fixture.cases,
    fixture.filings, fixture.claims, fixture.supersessions,
  ];
  for (const rows of rowGroups) {
    for (const row of rows) {
      for (const key of allStableKeysOf(row)) ids.add(key);
      fingerprints.add(sha256Hex(canonicalJson(stripFixtureDecorations(row))));
    }
  }
  return { ids, fingerprints };
}

/** Does any string value in `value` name a forbidden id? Walks arrays and objects. */
function containsForbiddenId(value, forbiddenIds) {
  if (typeof value === "string") return forbiddenIds.has(value);
  if (Array.isArray(value)) return value.some((item) => containsForbiddenId(item, forbiddenIds));
  if (value !== null && typeof value === "object") {
    return Object.values(value).some((item) => containsForbiddenId(item, forbiddenIds));
  }
  return false;
}

/**
 * Scan one collection of corpus rows (fold rows, fold assignments, train
 * partitions, whatever a corpus or fold builder calls its rows) for a
 * fixture id anywhere in the row, or a row whose own content fingerprint
 * matches a fixture record byte-for-byte. Either is a leak.
 */
function scanForFixtureLeakage(rows, signature, label, offenders) {
  rows.forEach((row, index) => {
    if (containsForbiddenId(row, signature.ids)) {
      offenders.push({ location: `${label}[${index}]`, reason: "row names a historical QA fixture id", row_key: stableKeyOf(row) ?? row?.row_key ?? row?.review_key ?? null });
      return;
    }
    const fingerprint = sha256Hex(canonicalJson(row));
    if (signature.fingerprints.has(fingerprint)) {
      offenders.push({ location: `${label}[${index}]`, reason: "row content fingerprint matches a historical QA fixture record", row_key: row?.row_key ?? row?.review_key ?? null });
    }
  });
}

/**
 * Throw, naming the offending row, if any historical-fixture id or record
 * fingerprint appears anywhere in `corpus`'s rows or fold assignments. This
 * is the construction-time form of A78-02's boundary rule (A1): a corpus or
 * fold builder calls this on its own output, so the fixture cannot enter a
 * training partition by way of a later refactor nobody remembered to guard.
 *
 * `corpus` is read structurally, not by a fixed schema, because every corpus
 * or fold builder in this repository names its own row array differently
 * (`rows` / `fold_assignments` here, something else elsewhere). Any array
 * found under `rows`, `fold_assignments`, `folds`, `train`, `test`, or
 * `partitions` is scanned; a corpus that names its rows something else should
 * pass that array in directly via `extraRowGroups`.
 */
export function assertFixtureExcluded(corpus, { context = "corpus", extraRowGroups = {} } = {}) {
  if (!corpus || typeof corpus !== "object") {
    throw new Article78HistoricalFixtureError(`${context}: assertFixtureExcluded requires a corpus object`);
  }
  const fixture = loadHistoricalFixture();
  const signature = collectFixtureSignature(fixture);

  const candidateGroups = { rows: corpus.rows, fold_assignments: corpus.fold_assignments, folds: corpus.folds, train: corpus.train, test: corpus.test, partitions: corpus.partitions, ...extraRowGroups };
  const offenders = [];
  let checkedGroups = 0;
  for (const [label, rows] of Object.entries(candidateGroups)) {
    if (!Array.isArray(rows)) continue;
    checkedGroups += 1;
    scanForFixtureLeakage(rows, signature, label, offenders);
  }
  if (checkedGroups === 0) {
    throw new Article78HistoricalFixtureError(
      `${context}: assertFixtureExcluded found no row array to check (looked for rows/fold_assignments/folds/train/test/partitions); pass extraRowGroups to name the corpus's own row arrays`,
    );
  }
  if (offenders.length > 0) {
    throw new Article78HistoricalFixtureError(
      `${context}: the QA-only historical fixture (A78-02) must never enter a training corpus or fold; offending row(s) ${JSON.stringify(offenders)}`,
    );
  }
  return { ok: true, checked_groups: checkedGroups, checked_fixture_ids: signature.ids.size, checked_fixture_fingerprints: signature.fingerprints.size };
}

/**
 * Wrap a metric computed over the historical fixture so a consumer cannot
 * emit it unmarked. This is the only exported way a number derived from
 * `loadHistoricalFixture()`'s data may be reported (A3): it is never a
 * production metric, and it is never a measurement of real-world filing
 * prevalence.
 */
export function diagnosticMetric(name, value) {
  if (typeof name !== "string" || name.trim() === "") {
    throw new Article78HistoricalFixtureError("diagnosticMetric requires a non-empty name");
  }
  return Object.freeze({ name, value, scope: "fixture", diagnostic_only: true });
}

/** Every metric name/value pair in `metrics` carries diagnostic_only: true. */
export function assertAllMetricsDiagnostic(metrics, context = "fixture metrics") {
  const offenders = metrics.filter((metric) => metric?.diagnostic_only !== true || metric?.scope !== "fixture");
  if (offenders.length > 0) {
    throw new Article78HistoricalFixtureError(`${context}: metric(s) not wrapped by diagnosticMetric: ${JSON.stringify(offenders)}`);
  }
  return { ok: true, checked_count: metrics.length };
}

// ---------------------------------------------------------------------------
// A2: run every documented expectation through A78-01's own derivations.
// ---------------------------------------------------------------------------

/** Run one documented expectation, never throwing: the offline backtest needs every result, not just the first failure. */
function evaluateOneExpectation(fixture, effectiveByCase, expectation) {
  try {
    switch (expectation.kind) {
      case "challenge_watch": {
        const determination = fixture.clean.determinations.find((row) => row.determination_key === expectation.determination_key);
        const result = challengeWatchValue({ determination, cases: fixture.clean.cases, coverage: fixture.clean.coverage });
        const actual = { value: result.value, reason: result.basis.reason };
        const ok = actual.value === expectation.expect.value && actual.reason === expectation.expect.reason;
        return { key: expectation.key, kind: expectation.kind, ok, actual, expect: expectation.expect };
      }
      case "case_outcome": {
        const effective = effectiveByCase.get(expectation.case_key);
        const actual = effective ? effective.case_outcome : null;
        const ok = Boolean(actual) && Object.entries(expectation.expect).every(([field, value]) => actual[field] === value);
        return { key: expectation.key, kind: expectation.kind, ok, actual, expect: expectation.expect };
      }
      case "claim_theory": {
        const claim = fixture.clean.claims.find((row) => row.case_key === expectation.case_key);
        const effective = effectiveByCase.get(expectation.case_key);
        const actual = { theory_category: claim?.theory_category ?? null, case_outcome: effective?.case_outcome ?? null };
        const categoryOk = actual.theory_category === expectation.expect.theory_category;
        const outcomeOk = Object.entries(expectation.expect.case_outcome ?? {}).every(([field, value]) => actual.case_outcome?.[field] === value);
        return { key: expectation.key, kind: expectation.kind, ok: categoryOk && outcomeOk, actual, expect: expectation.expect };
      }
      case "diagnostic": {
        const metric = diagnosticMetric(expectation.metric_name, expectation.metric_value);
        const ok = metric.diagnostic_only === true && metric.scope === "fixture" && metric.value === expectation.metric_value;
        return { key: expectation.key, kind: expectation.kind, ok, actual: metric, expect: { metric_name: expectation.metric_name, metric_value: expectation.metric_value } };
      }
      case "coverage_grade": {
        const determination = fixture.clean.determinations.find((row) => row.determination_key === expectation.determination_key);
        const graded = gradeCoverage({ determination, receipts: fixture.clean.coverage });
        const actual = {
          grade: graded.grade,
          receipts_considered: graded.receipts_considered,
          systems_searched: graded.systems_searched.map((entry) => entry.system),
          identifiers_used: graded.identifiers_used.map((entry) => entry.kind),
        };
        const ok = actual.grade === expectation.expect.grade;
        return { key: expectation.key, kind: expectation.kind, ok, actual, expect: expectation.expect };
      }
      case "coverage_note_contains": {
        const coverage = fixture.clean.coverage.find((row) => row.coverage_key === expectation.coverage_key);
        const note = coverage?.coverage_note ?? null;
        const ok = Boolean(note) && note.toLowerCase().includes(expectation.contains.toLowerCase());
        return { key: expectation.key, kind: expectation.kind, ok, actual: { coverage_note: note }, expect: { contains: expectation.contains } };
      }
      default:
        return { key: expectation.key, kind: expectation.kind, ok: false, actual: null, expect: expectation, error: `unknown expectation kind ${JSON.stringify(expectation.kind)}` };
    }
  } catch (error) {
    return { key: expectation.key, kind: expectation.kind, ok: false, actual: null, expect: expectation, error: error.message };
  }
}

/**
 * Run every documented expectation in the fixture's index through A78-01's
 * own derivations (`challengeWatchValue`, `applyDecisionSupersession`) and
 * report the result. The whole report is diagnostic-only (A3): it pins
 * regressions in A78-01's behavior against a hand-picked sample, and it is
 * never a claim about real-world filing prevalence or model performance.
 */
export function evaluateHistoricalFixtureExpectations(fixture = loadHistoricalFixture()) {
  const decisions = fixture.clean.filings.filter((row) => ARTICLE78_DECISION_FILING_TYPES.includes(row.filing_type));
  const effectiveByCase = new Map(applyDecisionSupersession(decisions, fixture.clean.supersessions).map((row) => [row.case_key, row]));
  const expectations = fixture.expectations.map((expectation) => evaluateOneExpectation(fixture, effectiveByCase, expectation));
  const failed = expectations.filter((row) => !row.ok);
  return {
    schema: "cityscroll.article78_historical_fixture.expectation_report.v1",
    scope: "fixture",
    diagnostic_only: true,
    project_count: fixture.projects.length,
    event_count: fixture.coverage.length + fixture.cases.length + fixture.filings.length + fixture.claims.length + fixture.supersessions.length,
    expectation_count: expectations.length,
    failed_count: failed.length,
    expectations,
  };
}
