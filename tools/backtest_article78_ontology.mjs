#!/usr/bin/env node

/**
 * A78-01 offline backtest.
 *
 * Runs the litigation-ontology derivations over the committed synthetic
 * fixture at `warehouse/fixtures/article78/` and compares the whole result
 * against the expected outputs committed next to it. Any mismatch is a
 * non-zero exit; there is no tolerance, no clock and no network.
 *
 * The six scenarios exist to pin the five ways a challenge-watch value comes
 * out over a determination, and the one way a decision can be undone:
 *
 *   located_challenge               an adequate search located one challenge
 *   adequate_search_zero_challenges an adequate search found nothing -- a real
 *                                   zero, attached to the search that produced it
 *   nonfinal_determination          the challenge window has not opened -> null
 *   inadequate_coverage             the recorded search is too narrow -> null
 *   open_limitations_window         adequate in scope, premature in time -> null
 *   trial_decision_reversed         a trial annulment reversed on appeal, which
 *                                   must not still read as durable relief
 *
 * The receipt carries the fixture's own content hash, so editing the fixture
 * without regenerating the expected outputs fails here rather than quietly
 * changing what the gate asserts.
 *
 * A78-04's cutoff-aware challenge-watch signals run alongside it in the same
 * diagnostic_only register, over the fixture projects that carry documented
 * challenge-watch inputs. Every level printed there is a challenge watch
 * over evidence public by a stated cutoff, never a forecast about a court, and
 * the section asserts its own renderings against the forbidden prediction
 * register before printing them.
 *
 * A78-02's thirteen-project historical QA fixture runs alongside this same
 * gate: `evaluateHistoricalFixtureExpectations` (`warehouse/lib/
 * article78_historical_fixture.mjs`) checks every documented expectation
 * against A78-01's own derivations and is printed under a `diagnostic_only`
 * section. It is not byte-compared against a committed expected file the way
 * the six scenarios above are -- there is no `--write` step for it -- because
 * it is a pass/fail check on live derivations, not a golden-file diff. Any
 * expectation failure there is also a non-zero exit.
 *
 * A78-05's litigation backtest (`warehouse/lib/article78_backtest.mjs`) runs
 * over that same historical fixture and is printed under its own
 * `litigation_backtest` section, on the same footing and for the same reason:
 * its oracle is the seed diagnostic the module carries as data, so a second
 * committed golden file would only be somewhere for the same numbers to drift
 * apart. Filing and durable relief are scored as two independent heads and are
 * never blended; the section exits non-zero when the seed diagnostic is not
 * reproduced exactly.
 *
 * A78-06's internal challenge-watch cards
 * (`warehouse/lib/article78_challenge_watch_card.mjs`) are rendered by this
 * same command, one per fixture project, into
 * `warehouse/reports/challenge-watch-cards/`. They are committed and compared
 * byte for byte in check mode, on the same terms as the environmental-review
 * workstream's other generated reports: edit the builder, never the output.
 * The cards are internal review pages. They carry no route, no link and no
 * combined figure, and the nine components each stand on their own row with
 * their own evidence and the court-search coverage grade they rest on.
 *
 * Usage:
 *   node tools/backtest_article78_ontology.mjs           # check (the gate)
 *   node tools/backtest_article78_ontology.mjs --write   # regenerate expected
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyDecisionSupersession,
  ARTICLE78_DECISION_FILING_TYPES,
  ARTICLE78_LITIGATION_SCHEMA,
  assertNoCombinedOutcomeScore,
  assertNoForbiddenChallengeWatchWording,
  challengeWatchValue,
  limitationsWindow,
  projectToOntologyEntities,
  renderChallengeWatchValue,
  validateArticle78RecordSet,
  validateDeterminationContext,
} from "../warehouse/lib/article78_litigation.mjs";
import {
  assertAllMetricsDiagnostic,
  deriveFixtureChallengeWatches,
  diagnosticMetric,
  evaluateHistoricalFixtureExpectations,
  loadHistoricalFixture,
} from "../warehouse/lib/article78_historical_fixture.mjs";
import {
  buildChallengeWatchCard,
  CHALLENGE_WATCH_CARD_ROW_KEYS,
  CHALLENGE_WATCH_CARD_TITLE,
  latestRecordedObservation,
  renderChallengeWatchCard,
} from "../warehouse/lib/article78_challenge_watch_card.mjs";
import {
  assertNoChallengeWatchPredictionWording,
  CHALLENGE_WATCH_LABEL,
  CHALLENGE_WATCH_LEVELS,
  CHALLENGE_WATCH_POLICY,
  deriveChallengeWatch,
} from "../warehouse/lib/article78_challenge_watch.mjs";
import {
  admitNegatives,
  assertDerivedDenominator,
  assertBoundedSearchReceipts,
  COVERAGE_GRADE_POLICY,
  eligibleDenominator,
  gradeCoverage,
} from "../warehouse/lib/article78_search_coverage.mjs";
import {
  ARTICLE78_BACKTEST_HEADS,
  ARTICLE78_BACKTEST_OUTCOME_CLASSES,
  ARTICLE78_BACKTEST_POLICY,
  ARTICLE78_BACKTEST_SEED_DIAGNOSTIC,
  assertSeedDiagnostic,
  backtestLitigation,
} from "../warehouse/lib/article78_backtest.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const BACKTEST_SCHEMA = "cityscroll.article78_litigation.backtest_receipt.v1";
export const FIXTURE_PATH = join(ROOT, "warehouse/fixtures/article78/litigation_backtest_fixture.v1.json");
export const EXPECTED_PATH = join(ROOT, "warehouse/fixtures/article78/litigation_backtest_expected.v1.json");
export const CHALLENGE_WATCH_CARD_DIR_RELATIVE = "warehouse/reports/challenge-watch-cards";
export const CHALLENGE_WATCH_CARD_DIR = join(ROOT, CHALLENGE_WATCH_CARD_DIR_RELATIVE);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Run every derivation over one fixture and return the receipt. Pure: the same
 * fixture always produces the same object, byte for byte once serialized.
 */
export function runArticle78Backtest(fixture) {
  const findings = validateArticle78RecordSet(fixture);
  for (const [index, determination] of fixture.determinations.entries()) {
    findings.push(...validateDeterminationContext(determination, `determination_context[${index}]`));
  }

  // A3, over the fixture's own field names rather than only over the spec: a
  // record set that smuggled in a combined outcome score would fail here even
  // if the validator's closed property set were later widened.
  const outcomeFieldNames = fixture.filings
    .filter((row) => row.decision)
    .flatMap((row) => Object.keys(row.decision));
  assertNoCombinedOutcomeScore([...new Set(outcomeFieldNames)], "backtest case outcomes");

  const challengeWatch = fixture.determinations.map((determination) => {
    const result = challengeWatchValue({
      determination,
      cases: fixture.cases,
      coverage: fixture.coverage,
    });
    return {
      determination_key: result.determination_key,
      value: result.value,
      reason: result.basis.reason,
      as_of: result.basis.as_of,
      coverage_keys: result.basis.coverage_keys,
      located_case_keys: result.basis.located_case_keys,
      limitations_window: limitationsWindow(determination),
      rendered: renderChallengeWatchValue(result),
    };
  });

  // A2: nothing this backtest renders may read as a fact about the world.
  assertNoForbiddenChallengeWatchWording(challengeWatch.map((row) => row.rendered), "backtest renderings");

  const decisions = fixture.filings.filter((row) => ARTICLE78_DECISION_FILING_TYPES.includes(row.filing_type));
  const effectiveDecisions = applyDecisionSupersession(decisions, fixture.supersessions);

  const projected = projectToOntologyEntities(fixture);

  // A78-03. Every receipt must record what it searched, under which variants,
  // and which docket fields its source could not show -- otherwise the grade
  // below is being read off a receipt that never said what it did.
  assertBoundedSearchReceipts(fixture.coverage, "backtest search coverage");
  const coverage = runCoverageSection(fixture);

  return {
    schema: BACKTEST_SCHEMA,
    module_schema: ARTICLE78_LITIGATION_SCHEMA,
    fixture_schema: fixture.schema,
    record_set_findings: findings,
    counts: {
      determinations: fixture.determinations.length,
      searches: fixture.coverage.length,
      cases: fixture.cases.length,
      filings: fixture.filings.length,
      decisions: decisions.length,
      claims: fixture.claims.length,
      supersessions: fixture.supersessions.length,
    },
    challenge_watch: challengeWatch,
    effective_decisions: effectiveDecisions,
    projected_entity_counts: Object.fromEntries(
      Object.entries(projected).map(([entityType, rows]) => [entityType, rows.length]).sort(),
    ),
    coverage,
  };
}

/**
 * A78-03's coverage section: a grade per determination, the admission split,
 * and the eligible denominator with its excluded remainder.
 *
 * Every count here is wrapped by A78-02's `diagnosticMetric`. That is not
 * decoration: these numbers are computed over a small synthetic fixture, and
 * an eligible-determination count that escaped this receipt unmarked would
 * read as a statement about how often land-use approvals are searched, which
 * it is not and can never be.
 */
function runCoverageSection(fixture) {
  const entries = fixture.determinations.map((determination) => ({ determination, receipts: fixture.coverage }));
  const grades = entries.map((entry) => gradeCoverage(entry));
  const admission = admitNegatives(entries);
  const denominator = eligibleDenominator(entries);
  assertDerivedDenominator(denominator, "backtest eligible denominator");

  return {
    policy_id: COVERAGE_GRADE_POLICY.policy_id,
    documented_margin_days: COVERAGE_GRADE_POLICY.horizon.documented_margin_days,
    grades: grades.map((row) => ({
      determination_key: row.determination_key,
      grade: row.grade,
      receipts_considered: row.receipts_considered,
      systems_searched: row.systems_searched.map((entry) => (entry.system === "other" ? `other:${entry.label}` : entry.system)),
      identifiers_used: row.identifiers_used.map((entry) => entry.kind),
      spans_limitations_window: row.horizon.spans_limitations_window,
      margin_days_after_close: row.horizon.margin_days_after_close,
      docket_details_unavailable: row.docket_details_unavailable,
      reasons: row.reasons,
    })),
    admitted_determination_keys: admission.admitted.map((row) => row.determination_key),
    excluded_determination_keys: {
      C: admission.excluded.C.map((row) => row.determination_key),
      U: admission.excluded.U.map((row) => row.determination_key),
    },
    metrics: [
      diagnosticMetric("article78_coverage_examined_determinations", denominator.examined_determination_count),
      diagnosticMetric("article78_coverage_eligible_determinations", denominator.eligible_determination_count),
      diagnosticMetric("article78_coverage_excluded_remainder", denominator.excluded_remainder.count),
      ...Object.entries(denominator.by_grade).sort().map(([grade, count]) => diagnosticMetric(`article78_coverage_grade_${grade}_determinations`, count)),
    ],
    note: denominator.note,
  };
}

/**
 * A78-05's `litigation_backtest` section: both heads' confusion counts, the
 * censored rows, and one row per scored unit.
 *
 * The two heads never meet in this section. There is no combined figure, no
 * ordering of one head by the other, and every count leaves here wrapped by
 * A78-02's `diagnosticMetric` -- asserted rather than assumed, because a
 * confusion count that escaped unmarked would read as "the challenge watch is
 * right ninety-one percent of the time", which is a claim about thirteen
 * hand-picked projects and about nothing else.
 */
const LITIGATION_BACKTEST_EXPECTED_LABELS = Object.freeze({
  filing: Object.freeze({ positive: "challenge_to_this_determination", negative: "no_challenge_to_this_determination" }),
  durable_relief: Object.freeze({ positive: "durable_relief_obtained", negative: "no_durable_relief_obtained" }),
});

export function buildLitigationBacktestSection(report) {
  const heads = ARTICLE78_BACKTEST_HEADS.map((head) => {
    const section = report.heads[head];
    const labels = LITIGATION_BACKTEST_EXPECTED_LABELS[head];
    return {
      head,
      question: section.question,
      unit: section.unit,
      predicted_positive_levels: section.predicted_positive_levels,
      counts: section.counts,
      metrics: section.metrics,
      censored: section.censored,
      rows: section.rows.map((row) => ({
        case: row.case_key ?? row.determination_key,
        head,
        // What the fixture's own record says happened, or that it does not yet
        // say -- never a blank that a reader could take for a negative.
        expected: row.observed_positive === null
          ? "not_determinable_at_cutoff"
          : (row.observed_positive ? labels.positive : labels.negative),
        // What the challenge watch supported at this unit's cutoff.
        observed: row.predicted_positive ? "watch_at_or_above_threshold" : "watch_below_threshold",
        outcome_class: row.outcome_class,
        challenge_watch_level: row.challenge_watch_level,
        as_of: row.as_of,
        reason: row.reason,
      })),
    };
  });
  const metrics = heads.flatMap((head) => head.metrics);
  assertAllMetricsDiagnostic(metrics, "article78 litigation backtest metrics");
  return {
    policy_id: report.policy_id,
    as_of_policy: report.as_of_policy,
    eligible_determination_count: report.eligible_determination_count,
    excluded_determinations: report.excluded_determinations,
    heads,
    seed_diagnostic: ARTICLE78_BACKTEST_SEED_DIAGNOSTIC,
    statement: report.statement,
  };
}

/** Render A78-05's two heads, side by side and never added together. */
function renderLitigationBacktestSection(section) {
  const lines = [
    `  litigation backtest (A78-05, policy ${section.policy_id}, cutoffs ${section.as_of_policy}, diagnostic_only -- fixture diagnostics, never population performance):`,
    `    ${section.eligible_determination_count} eligible determination(s); ${section.excluded_determinations.length} excluded because their court-record search is not admissible`,
  ];
  for (const head of section.heads) {
    lines.push(`    head ${head.head} -- ${head.question}`);
    lines.push(`      unit: ${head.unit}; predicted positive at watch level ${head.predicted_positive_levels.join("/")}`);
    lines.push(`      ${ARTICLE78_BACKTEST_OUTCOME_CLASSES.map((cell) => `${cell}=${head.counts[cell]}`).join(" ")} -- diagnostic_only`);
    for (const row of head.rows) {
      lines.push(`      ${row.outcome_class.padEnd(15)} ${row.case}`);
      lines.push(`         expected ${row.expected}; watch ${row.challenge_watch_level} (${row.observed}) as of ${row.as_of}`);
      lines.push(`         ${row.reason}`);
    }
    if (head.censored.length > 0) {
      lines.push(`      censored: ${head.censored.map((row) => `${row.case_key ?? row.determination_key} (${row.censoring_reason})`).join(", ")}`);
    }
  }
  lines.push(`    ${section.statement}`);
  return lines.join("\n");
}

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** The first place the two documents differ, as a dotted path. */
function firstDifference(actual, expected, path = "$") {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return null;
  if (Array.isArray(actual) && Array.isArray(expected)) {
    if (actual.length !== expected.length) return `${path}: length ${actual.length} != expected ${expected.length}`;
    for (const [index, item] of actual.entries()) {
      const diff = firstDifference(item, expected[index], `${path}[${index}]`);
      if (diff) return diff;
    }
  }
  if (actual && expected && typeof actual === "object" && typeof expected === "object" && !Array.isArray(actual)) {
    const keys = [...new Set([...Object.keys(actual), ...Object.keys(expected)])].sort();
    for (const key of keys) {
      const diff = firstDifference(actual[key], expected[key], `${path}.${key}`);
      if (diff) return diff;
    }
  }
  return `${path}: ${JSON.stringify(actual)} != expected ${JSON.stringify(expected)}`;
}

/** Render A78-03's coverage grades, admission split and eligible denominator. */
function renderCoverageSection(coverage) {
  const eligible = coverage.metrics.find((metric) => metric.name === "article78_coverage_eligible_determinations");
  const examined = coverage.metrics.find((metric) => metric.name === "article78_coverage_examined_determinations");
  const remainder = coverage.metrics.find((metric) => metric.name === "article78_coverage_excluded_remainder");
  return [
    `  search coverage (A78-03, policy ${coverage.policy_id}, documented margin ${coverage.documented_margin_days}d):`,
    ...coverage.grades.map((row) => `    ${row.grade}  ${row.determination_key}\n       systems ${row.systems_searched.join(", ") || "none"}; identifiers ${row.identifiers_used.join(", ") || "none"}; margin ${row.margin_days_after_close ?? "n/a"}`),
    `    eligible denominator ${eligible.value} of ${examined.value} examined, excluded remainder ${remainder.value} (C ${coverage.excluded_determination_keys.C.length}, U ${coverage.excluded_determination_keys.U.length}) -- diagnostic_only, derived from recorded coverage and never from an asserted total`,
    `    ${coverage.note}`,
  ].join("\n");
}

/** Render the diagnostic_only historical-fixture section of the receipt (A78-02). */
function renderHistoricalFixtureSection(report) {
  const rows = report.expectations.map((row) => `  ${row.ok ? "OK  " : "FAIL"} ${row.kind.padEnd(18)} ${row.key}${row.error ? ` (${row.error})` : ""}`);
  return [
    "  historical QA fixture (A78-02, diagnostic_only -- never model performance, never real filing prevalence):",
    `    projects=${report.project_count} events=${report.event_count} expectations=${report.expectation_count} failed=${report.failed_count}`,
    ...rows,
  ].join("\n");
}

/**
 * A78-04's challenge-watch section: the level derived for every fixture
 * project that carries documented watch inputs, with the features that
 * produced it and the evidence its cutoff excluded.
 *
 * Diagnostic_only, on the same footing as the historical-fixture section above
 * and for the same reason: these levels are computed over a hand-picked sample
 * of newsworthy projects, and a distribution of watch levels read off them
 * would report the selection rather than anything about land-use approvals.
 *
 * The section also enforces the card's two hard boundaries over its own
 * output rather than trusting the module that produced it: no watch whose
 * only present features are conspicuousness reaches above baseline, and
 * nothing rendered here reads as a prediction.
 */
function renderChallengeWatchSection(report) {
  const conspicuousOnly = report.watches.filter((row) => (
    row.present_features.length > 0
    && row.present_features.every((key) => CHALLENGE_WATCH_POLICY.conspicuousness_only_features.includes(key))
    && row.level !== "baseline"
  ));
  if (conspicuousOnly.length > 0) {
    throw new Error(`article78 backtest: ${CHALLENGE_WATCH_POLICY.document_class_ceiling.statement} Offending watches ${JSON.stringify(conspicuousOnly)}`);
  }
  assertNoChallengeWatchPredictionWording(report.watches.map((row) => row.statement), "backtest challenge watch section");

  const byLevel = CHALLENGE_WATCH_LEVELS
    .map((level) => `${level}=${report.watches.filter((row) => row.level === level).length}`)
    .join(" ");
  const metrics = CHALLENGE_WATCH_LEVELS.map((level) => (
    diagnosticMetric(`article78_challenge_watch_level_${level}`, report.watches.filter((row) => row.level === level).length)
  ));
  return [
    `  ${CHALLENGE_WATCH_LABEL} signals (A78-04, policy ${CHALLENGE_WATCH_POLICY.policy_id}, diagnostic_only -- a watch over recorded evidence as of a cutoff, never a forecast):`,
    `    ${report.watch_count} watch(es) over the fixture's documented inputs; ${byLevel}`,
    ...report.watches.map((row) => [
      `    ${row.level.padEnd(8)} ${row.project_id} as of ${row.as_of} (coverage ${row.coverage_grade}, ${row.coverage_grade_source})`,
      `       ${row.level === "null" ? row.null_reason : `features ${row.present_features.join(", ") || "none"}`}`,
      `       ${row.excluded_evidence.length > 0 ? `excluded by the cutoff: ${row.excluded_evidence.join(", ")}` : "nothing excluded by the cutoff"}`,
    ].join("\n")),
    `    ${metrics.map((metric) => `${metric.name}=${metric.value}`).join(" ")} -- diagnostic_only`,
  ].join("\n");
}

/**
 * A78-06's internal challenge-watch cards: one per fixture project.
 *
 * Each card is built at the close of that project's recorded observation
 * window -- the last day anything about it was observed -- so nothing recorded
 * is hidden behind the cutoff and nothing after it is invented. That is a
 * display choice and not a scoring one: A78-05 scores at its own documented
 * cutoff policy, and the two are deliberately separate, which is why each card
 * prints the cutoff it was built at.
 *
 * The cards are internal and diagnostic only, on the same footing as every
 * other number computed over this hand-picked fixture. A card is a display of
 * separated components; it is not a measurement of anything.
 */
export function buildChallengeWatchCardArtifacts(fixture = loadHistoricalFixture()) {
  return fixture.projects.map((project) => {
    const determination = fixture.clean.determinations.find((row) => row.determination_key === project.determination_key);
    const cases = fixture.clean.cases.filter((row) => row.determination_key === determination.determination_key);
    const caseKeys = new Set(cases.map((row) => row.case_key));
    const filings = fixture.clean.filings.filter((row) => caseKeys.has(row.case_key));
    const claims = fixture.clean.claims.filter((row) => caseKeys.has(row.case_key));
    const supersessions = fixture.clean.supersessions.filter((row) => caseKeys.has(row.case_key));
    const receipts = fixture.clean.coverage.filter((row) => row.determination_key === determination.determination_key
      || (row.scope?.determination_filters ?? []).includes(determination.determination_key));
    const inputs = project.challenge_watch_inputs ?? null;
    const asOf = latestRecordedObservation([
      receipts, cases, filings, claims, supersessions,
      inputs?.review?.events ?? [], inputs?.review?.actions ?? [], inputs?.positions ?? [], inputs?.signals ?? [],
    ]);
    if (asOf === null) {
      throw new Error(`article78 challenge watch card: ${project.project_id} carries no dated record to take a cutoff from`);
    }
    const watch = deriveChallengeWatch({
      determination,
      review: inputs?.review ?? null,
      positions: inputs?.positions ?? [],
      signals: inputs?.signals ?? [],
      coverage: fixture.clean.coverage,
      as_of: asOf,
    });
    const card = buildChallengeWatchCard({
      determination,
      watch,
      project_id: project.project_id,
      project_name: project.name,
      coverage: fixture.clean.coverage,
      cases: fixture.clean.cases,
      filings: fixture.clean.filings,
      claims: fixture.clean.claims,
      supersessions: fixture.clean.supersessions,
      as_of: asOf,
    });
    const rendered = renderChallengeWatchCard(card);
    return {
      project_id: project.project_id,
      determination_key: card.determination_key,
      as_of: card.as_of,
      coverage_grade: card.coverage_grade,
      coverage_grade_admissible: card.coverage_grade_admissible,
      path: `${CHALLENGE_WATCH_CARD_DIR_RELATIVE}/${rendered.file_name}`,
      html: rendered.html,
      card,
    };
  });
}

/** Render A78-06's card section: one line per card, and the row states on it. */
function renderChallengeWatchCardSection(artifacts) {
  for (const artifact of artifacts) {
    if (artifact.path.includes("site/") || !artifact.path.startsWith("warehouse/reports/")) {
      throw new Error(`article78 challenge watch card: ${artifact.path} must be written under warehouse/reports/, never under site/`);
    }
  }
  return [
    `  ${CHALLENGE_WATCH_CARD_TITLE} cards (A78-06, ${CHALLENGE_WATCH_CARD_ROW_KEYS.length} separated components per card, no combined figure):`,
    `    written under ${CHALLENGE_WATCH_CARD_DIR_RELATIVE}/ -- no route, no link, no resident surface`,
    ...artifacts.map((artifact) => [
      `    ${artifact.project_id.padEnd(38)} as of ${artifact.as_of} (coverage ${artifact.coverage_grade}${artifact.coverage_grade_admissible ? "" : ", not admissible"})`,
      `       ${artifact.card.rows.map((row) => `${row.key}=${row.state}`).join(" ")}`,
    ].join("\n")),
  ].join("\n");
}

function main(argv) {
  const write = argv.includes("--write");
  const fixtureText = readFileSync(FIXTURE_PATH, "utf8");
  const fixture = JSON.parse(fixtureText);
  const receipt = { ...runArticle78Backtest(fixture), fixture_sha256: sha256Hex(fixtureText) };
  const historicalReport = evaluateHistoricalFixtureExpectations();
  const challengeWatchReport = deriveFixtureChallengeWatches();
  const litigationBacktest = buildLitigationBacktestSection(backtestLitigation({}));
  const cardArtifacts = buildChallengeWatchCardArtifacts();

  if (write) {
    writeFileSync(EXPECTED_PATH, serialize(receipt), "utf8");
    mkdirSync(CHALLENGE_WATCH_CARD_DIR, { recursive: true });
    for (const artifact of cardArtifacts) writeFileSync(join(ROOT, artifact.path), artifact.html, "utf8");
    process.stdout.write(
      `article78 backtest: wrote expected outputs to warehouse/fixtures/article78/${EXPECTED_PATH.split("/").pop()}`
      + ` and ${cardArtifacts.length} challenge watch card(s) to ${CHALLENGE_WATCH_CARD_DIR_RELATIVE}/\n`,
    );
    return 0;
  }

  const expected = readJson(EXPECTED_PATH);
  const mismatch = firstDifference(receipt, expected);
  const rows = receipt.challenge_watch.map((row) => `  ${row.value === null ? "null" : row.value}  ${row.reason.padEnd(46)} ${row.rendered}`);
  process.stdout.write([
    "article78 litigation ontology backtest",
    `  fixture      warehouse/fixtures/article78/litigation_backtest_fixture.v1.json (sha256 ${receipt.fixture_sha256.slice(0, 12)})`,
    `  records      ${Object.entries(receipt.counts).map(([name, count]) => `${name}=${count}`).join(" ")}`,
    `  validation   ${receipt.record_set_findings.length} finding(s)`,
    "  challenge watch:",
    ...rows,
    "  effective decisions:",
    ...receipt.effective_decisions.map((entry) => `  ${entry.case_key}\n    effective ${entry.effective_decision_key ?? "none"} (${entry.effective_decision_court_level ?? "n/a"})\n    procedural_survival=${entry.case_outcome.procedural_survival} durable_petitioner_relief=${entry.case_outcome.durable_petitioner_relief} remedy_exposure=${entry.case_outcome.remedy_exposure}\n    superseded ${entry.superseded_decision_keys.length}, unresolved ${entry.unresolved ?? "none"}`),
    renderCoverageSection(receipt.coverage),
    renderHistoricalFixtureSection(historicalReport),
    renderChallengeWatchSection(challengeWatchReport),
    renderLitigationBacktestSection(litigationBacktest),
    renderChallengeWatchCardSection(cardArtifacts),
    "",
  ].join("\n"));

  const staleCards = cardArtifacts.filter((artifact) => {
    let current = null;
    try {
      current = readFileSync(join(ROOT, artifact.path), "utf8");
    } catch {
      current = null;
    }
    return current !== artifact.html;
  });

  if (receipt.record_set_findings.length > 0) {
    process.stderr.write(`article78 backtest FAILED: the fixture record set does not validate:\n  ${receipt.record_set_findings.join("\n  ")}\n`);
    return 1;
  }
  if (mismatch) {
    process.stderr.write(`article78 backtest FAILED: derived output does not match the committed expectation.\n  ${mismatch}\nRegenerate deliberately with: node tools/backtest_article78_ontology.mjs --write\n`);
    return 1;
  }
  if (staleCards.length > 0) {
    process.stderr.write(
      "article78 backtest FAILED: committed challenge watch card(s) do not reproduce:\n  "
      + `${staleCards.map((artifact) => artifact.path).join("\n  ")}\n`
      + "Regenerate deliberately with: node tools/backtest_article78_ontology.mjs --write\n",
    );
    return 1;
  }
  if (historicalReport.failed_count > 0) {
    const failures = historicalReport.expectations.filter((row) => !row.ok);
    process.stderr.write(`article78 backtest FAILED: the historical QA fixture's documented expectations did not hold:\n  ${JSON.stringify(failures, null, 2)}\n`);
    return 1;
  }
  // A78-05's A2: the seed diagnostic is the oracle, and it is checked last so
  // the section above has already printed the numbers a reader needs to see
  // the discrepancy rather than only being told there is one.
  try {
    assertSeedDiagnostic(backtestLitigation({}));
  } catch (error) {
    process.stderr.write(
      `article78 backtest FAILED: the litigation backtest did not reproduce the documented seed diagnostic.\n  ${error.message}\n`
      + `The seed is documented in docs/article78-litigation-backtest-v1.md and carried as ARTICLE78_BACKTEST_SEED_DIAGNOSTIC.\n`
      + "Neither the fixture nor the scorer may be adjusted to close this gap without deciding which of the two is wrong.\n",
    );
    return 1;
  }
  process.stdout.write(
    "article78 backtest OK: derived output matches the committed expectation, every historical-fixture expectation holds, "
    + `the litigation backtest reproduces its seed diagnostic (filing and ${ARTICLE78_BACKTEST_POLICY.heads.durable_relief.head} scored separately), `
    + `and ${cardArtifacts.length} committed challenge watch card(s) reproduce byte for byte.\n`,
  );
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
