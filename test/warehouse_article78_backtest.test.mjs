import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ARTICLE78_AS_OF_POLICY_IDS,
  ARTICLE78_BACKTEST_CENSORING_REASONS,
  ARTICLE78_BACKTEST_CONFUSION_CELLS,
  ARTICLE78_BACKTEST_HEADS,
  ARTICLE78_BACKTEST_OUTCOME_CLASSES,
  ARTICLE78_BACKTEST_POLICY,
  ARTICLE78_BACKTEST_SEED_DIAGNOSTIC,
  ARTICLE78_LITIGATION_BACKTEST_SCHEMA,
  Article78BacktestError,
  assertCensoredRowsAreNotNegatives,
  assertHeadsScoredSeparately,
  assertSeedDiagnostic,
  backtestLitigation,
  DURABLE_RELIEF_STATES,
  resolveBacktestCutoff,
} from "../warehouse/lib/article78_backtest.mjs";
import { ARTICLE78_PETITIONER_RELIEF_STATES } from "../warehouse/lib/article78_litigation.mjs";
import { CHALLENGE_WATCH_LEVELS } from "../warehouse/lib/article78_challenge_watch.mjs";
import { loadHistoricalFixture } from "../warehouse/lib/article78_historical_fixture.mjs";
import { buildLitigationBacktestSection } from "../tools/backtest_article78_ontology.mjs";

const FIXTURE = loadHistoricalFixture();
const SOHO_NOHO = "determination:city_planning_commission:action_soho_noho_0001:2021-12-20";
const INWOOD = "determination:city_planning_commission:action_inwood_rezoning_0001:2018-08-08";

/** The report under the documented default policy, computed once. */
const REPORT = backtestLitigation({ fixture: FIXTURE });

describe("A78-05 litigation backtest: two heads (A1)", () => {
  it("reports filing and durable relief as separate heads with their own counts", () => {
    assert.equal(REPORT.schema, ARTICLE78_LITIGATION_BACKTEST_SCHEMA);
    assert.deepEqual(Object.keys(REPORT.heads).sort(), [...ARTICLE78_BACKTEST_HEADS].sort());
    for (const head of ARTICLE78_BACKTEST_HEADS) {
      const section = REPORT.heads[head];
      assert.equal(section.head, head);
      for (const cell of ARTICLE78_BACKTEST_OUTCOME_CLASSES) {
        assert.equal(typeof section.counts[cell], "number", `${head}.${cell} must be reported`);
      }
    }
    // The two heads are genuinely independent numbers, not one figure printed
    // twice: on this fixture their confusion counts differ.
    assert.notDeepEqual(REPORT.heads.filing.counts, REPORT.heads.durable_relief.counts);
  });

  it("gives each head its own predicted-positive threshold, and the relief head's is stricter", () => {
    const filing = ARTICLE78_BACKTEST_POLICY.heads.filing.predicted_positive_levels;
    const relief = ARTICLE78_BACKTEST_POLICY.heads.durable_relief.predicted_positive_levels;
    assert.ok(relief.every((level) => filing.includes(level)), "the relief threshold must be a subset of the filing threshold");
    assert.ok(relief.length < filing.length, "the relief head must be strictly harder to call positive");
    for (const level of [...filing, ...relief]) assert.ok(CHALLENGE_WATCH_LEVELS.includes(level));
    // Thresholds live in the policy object rather than in the scorer's branches.
    assert.equal(ARTICLE78_BACKTEST_POLICY.policy_id, REPORT.policy_id);
  });

  it("never blends the two heads into one number", () => {
    assert.deepEqual(assertHeadsScoredSeparately(REPORT), { ok: true, heads: 2 });
    assert.throws(
      () => assertHeadsScoredSeparately({
        ...REPORT,
        heads: { ...REPORT.heads, combined_litigation: { counts: {} } },
      }),
      /expected exactly the heads/,
    );
    // A field renamed into a combined figure fails on A78-01's own scanner.
    assert.throws(
      () => assertHeadsScoredSeparately({ ...REPORT, overall_backtest: 1 }),
      /never combined into one number/,
    );
  });

  it("scores durable relief from A78-01 relief states, naming the ones it does not score as durable", () => {
    for (const state of DURABLE_RELIEF_STATES) {
      assert.ok(ARTICLE78_PETITIONER_RELIEF_STATES.includes(state), `${state} must be an A78-01 relief state`);
    }
    const documented = ARTICLE78_BACKTEST_POLICY.relief_states_not_scored_durable.map((row) => row.relief_state);
    assert.deepEqual(
      [...DURABLE_RELIEF_STATES, ...documented].sort(),
      [...ARTICLE78_PETITIONER_RELIEF_STATES].sort(),
      "every A78-01 relief state is either scored as durable or carries a documented reason it is not",
    );
    for (const row of ARTICLE78_BACKTEST_POLICY.relief_states_not_scored_durable) {
      assert.ok(row.reason.length > 20, `${row.relief_state} must carry a reason, not a label`);
    }
  });
});

describe("A78-05 litigation backtest: the seed diagnostic (A2)", () => {
  it("reproduces the documented seed diagnostic exactly from the fixture", () => {
    assert.deepEqual(REPORT.heads.filing.counts, {
      true_positive: 10,
      false_positive: 1,
      false_negative: 0,
      true_negative: 0,
      censored: 2,
    });
    assert.deepEqual(REPORT.heads.durable_relief.counts, {
      true_positive: 1,
      false_positive: 3,
      false_negative: 0,
      true_negative: 6,
      censored: 3,
    });
    assert.deepEqual(assertSeedDiagnostic(REPORT).ok, true);
  });

  it("keeps the documented seed and the module's own constant in step", () => {
    assert.equal(ARTICLE78_BACKTEST_SEED_DIAGNOSTIC.as_of_policy, REPORT.as_of_policy);
    for (const head of ARTICLE78_BACKTEST_HEADS) {
      assert.deepEqual(REPORT.heads[head].counts, { ...ARTICLE78_BACKTEST_SEED_DIAGNOSTIC.heads[head] });
    }
  });

  it("retains the fixture's deliberate false positive rather than cleaning it up", () => {
    const falsePositives = REPORT.heads.filing.rows.filter((row) => row.outcome_class === "false_positive");
    assert.equal(falsePositives.length, 1);
    const [row] = falsePositives;
    const located = FIXTURE.clean.cases.find((entry) => entry.case_key === row.case_key);
    assert.ok(located, "the false positive names a case the fixture carries");
    assert.notEqual(located.determination_key, row.determination_key,
      "the deliberate false positive is a located case belonging to a different determination");
    assert.match(row.reason, /challenges a different determination/);
  });

  it("fails loudly, naming every differing count, when the seed is not reproduced", () => {
    const bent = {
      ...REPORT,
      heads: {
        ...REPORT.heads,
        filing: { ...REPORT.heads.filing, counts: { ...REPORT.heads.filing.counts, true_positive: 9, censored: 3 } },
      },
    };
    assert.throws(() => assertSeedDiagnostic(bent), (error) => {
      assert.ok(error instanceof Article78BacktestError);
      assert.match(error.message, /"head":"filing","class":"true_positive","expected":10,"observed":9/);
      assert.match(error.message, /"class":"censored","expected":2,"observed":3/);
      return true;
    });
  });

  it("refuses to check the seed against a report computed under another cutoff policy", () => {
    const later = backtestLitigation({ fixture: FIXTURE, as_of_policy: "observation_close" });
    assert.throws(() => assertSeedDiagnostic(later), /documented under the "determination_final" cutoff policy/);
  });
});

describe("A78-05 litigation backtest: diagnostic-only boundary (A3)", () => {
  it("marks every emitted metric diagnostic only", () => {
    assert.equal(REPORT.diagnostic_only, true);
    assert.equal(REPORT.scope, "fixture");
    for (const head of ARTICLE78_BACKTEST_HEADS) {
      const metrics = REPORT.heads[head].metrics;
      assert.equal(metrics.length, ARTICLE78_BACKTEST_OUTCOME_CLASSES.length);
      for (const metric of metrics) {
        assert.equal(metric.diagnostic_only, true, `${metric.name} must be diagnostic only`);
        assert.equal(metric.scope, "fixture");
      }
      // The wrapped metrics say the same thing as the counts they wrap.
      for (const cell of ARTICLE78_BACKTEST_OUTCOME_CLASSES) {
        const metric = metrics.find((row) => row.name === `article78_backtest_${head}_${cell}`);
        assert.equal(metric.value, REPORT.heads[head].counts[cell]);
      }
    }
  });

  it("carries a receipt-level statement that these are fixture diagnostics", () => {
    assert.match(REPORT.statement, /fixture diagnostic/);
    assert.match(REPORT.statement, /never a measurement/);
    const section = buildLitigationBacktestSection(REPORT);
    assert.equal(section.statement, REPORT.statement);
    assert.equal(section.as_of_policy, "determination_final");
    for (const head of section.heads) {
      assert.equal(head.rows.length, REPORT.heads[head.head].rows.length);
      for (const row of head.rows) {
        assert.ok(row.case, "every emitted row names its unit");
        assert.equal(row.head, head.head);
        assert.ok(row.expected, "every emitted row names the outcome the fixture records");
        assert.ok(row.observed, "every emitted row names what the watch supported");
        assert.ok(row.reason.length > 0, "every emitted row carries its reason");
      }
    }
  });

  it("excludes determinations whose court-record search is not admissible, rather than scoring them", () => {
    assert.equal(REPORT.excluded_determination_count, 3);
    for (const row of REPORT.excluded_determinations) {
      assert.equal(row.reason, "coverage_grade_not_admissible");
      assert.ok(["C", "U"].includes(row.coverage_grade));
    }
    const excludedKeys = new Set(REPORT.excluded_determinations.map((row) => row.determination_key));
    for (const head of ARTICLE78_BACKTEST_HEADS) {
      for (const row of REPORT.heads[head].rows) {
        assert.ok(!excludedKeys.has(row.determination_key), `${row.determination_key} must not be scored in ${head}`);
      }
    }
  });
});

describe("A78-05 litigation backtest: censoring (A4)", () => {
  it("reports censored rows as a class of their own and never inside a confusion cell", () => {
    assert.deepEqual(assertCensoredRowsAreNotNegatives(REPORT), { ok: true, heads: 2 });
    for (const head of ARTICLE78_BACKTEST_HEADS) {
      const section = REPORT.heads[head];
      const censoredRows = section.rows.filter((row) => row.outcome_class === "censored");
      assert.equal(censoredRows.length, section.counts.censored);
      assert.equal(section.censored.length, section.counts.censored);
      for (const row of censoredRows) {
        assert.ok(ARTICLE78_BACKTEST_CENSORING_REASONS.includes(row.censoring_reason));
        assert.equal(row.observed_positive, null, "a censored row has no observed outcome");
      }
      const scored = ARTICLE78_BACKTEST_CONFUSION_CELLS.reduce((total, cell) => total + section.counts[cell], 0);
      assert.equal(scored + section.counts.censored, section.rows.length,
        "every row lands in exactly one class, so nothing can be dropped into a negative");
      assert.equal(scored, section.scored_row_count);
    }
  });

  it("moving a case's cutoff into its open limitations window turns a negative into a censored row and lowers the true-negative count", () => {
    const settled = backtestLitigation({ fixture: FIXTURE, as_of_policy: "observation_close" });
    const before = settled.heads.durable_relief;
    const sohoBefore = before.rows.find((row) => row.determination_key === SOHO_NOHO);
    assert.equal(sohoBefore.outcome_class, "true_negative",
      "with a cutoff after its window closed, an adequately searched determination with no challenge is a real negative");

    // 2022-03-01 falls inside this determination's limitations window
    // (2021-12-20 to 2022-04-20): somebody could still have filed.
    const moved = backtestLitigation({
      fixture: FIXTURE,
      as_of_policy: { policy: "observation_close", cutoffs: { [SOHO_NOHO]: "2022-03-01" } },
    });
    const after = moved.heads.durable_relief;
    const sohoAfter = after.rows.find((row) => row.determination_key === SOHO_NOHO);
    assert.equal(sohoAfter.outcome_class, "censored");
    assert.equal(sohoAfter.censoring_reason, "open_limitations_window");
    assert.equal(after.counts.true_negative, before.counts.true_negative - 1);
    assert.equal(after.counts.censored, before.counts.censored + 1);
    // The rest of the head is untouched: only the moved unit changed class.
    assert.equal(after.counts.true_positive, before.counts.true_positive);
    assert.equal(after.counts.false_positive, before.counts.false_positive);
    assert.equal(after.counts.false_negative, before.counts.false_negative);
  });

  it("censors a unit whose determination was not final and binding at its cutoff", () => {
    const early = backtestLitigation({
      fixture: FIXTURE,
      as_of_policy: { policy: "determination_final", cutoffs: { [INWOOD]: "2017-01-01" } },
    });
    const rows = early.heads.durable_relief.rows.filter((row) => row.determination_key === INWOOD);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome_class, "censored");
    assert.equal(rows[0].censoring_reason, "determination_not_final_at_cutoff");
    assert.equal(early.heads.durable_relief.counts.true_negative, REPORT.heads.durable_relief.counts.true_negative - 1);
  });

  it("settles more negatives at a later cutoff and never fewer", () => {
    const settled = backtestLitigation({ fixture: FIXTURE, as_of_policy: "observation_close" });
    for (const head of ARTICLE78_BACKTEST_HEADS) {
      assert.ok(settled.heads[head].counts.censored <= REPORT.heads[head].counts.censored,
        `${head}: a later cutoff can only settle more rows`);
      assert.ok(settled.heads[head].scored_row_count >= REPORT.heads[head].scored_row_count);
    }
  });

  it("refuses a report that counted a censored row as a negative", () => {
    const head = REPORT.heads.durable_relief;
    const censoredRow = head.rows.find((row) => row.outcome_class === "censored");
    const bent = {
      ...REPORT,
      heads: {
        ...REPORT.heads,
        durable_relief: {
          ...head,
          counts: { ...head.counts, true_negative: head.counts.true_negative + 1, censored: head.counts.censored - 1 },
          rows: head.rows.map((row) => (row === censoredRow ? { ...row, outcome_class: "true_negative" } : row)),
        },
      },
    };
    assert.throws(() => assertCensoredRowsAreNotNegatives(bent), /is a not-yet and is never a true negative/);
  });

  it("refuses a censored row that does not say why it was censored", () => {
    const head = REPORT.heads.filing;
    const bent = {
      ...REPORT,
      heads: {
        ...REPORT.heads,
        filing: {
          ...head,
          rows: head.rows.map((row) => (row.outcome_class === "censored" ? { ...row, censoring_reason: null } : row)),
        },
      },
    };
    assert.throws(() => assertCensoredRowsAreNotNegatives(bent), /without saying why/);
  });
});

describe("A78-05 litigation backtest: the cutoff policy", () => {
  it("derives a cutoff from the determination, from the observation record, or from the caller", () => {
    const determination = FIXTURE.clean.determinations.find((row) => row.determination_key === SOHO_NOHO);
    assert.deepEqual(
      resolveBacktestCutoff({ determination, coverage: FIXTURE.clean.coverage, as_of_policy: "determination_final" }),
      { as_of: "2021-12-20", source: "determination_final" },
    );
    assert.equal(
      resolveBacktestCutoff({ determination, coverage: FIXTURE.clean.coverage, as_of_policy: "observation_close" }).source,
      "observation_close",
    );
    assert.deepEqual(
      resolveBacktestCutoff({
        determination,
        coverage: FIXTURE.clean.coverage,
        as_of_policy: { policy: "explicit", cutoffs: { [SOHO_NOHO]: "2023-01-31T00:00:00Z" } },
      }),
      { as_of: "2023-01-31", source: "stated_by_caller" },
    );
  });

  it("refuses an unknown policy, an unparseable cutoff, and an explicit policy with a missing cutoff", () => {
    const determination = FIXTURE.clean.determinations.find((row) => row.determination_key === SOHO_NOHO);
    assert.throws(() => backtestLitigation({ fixture: FIXTURE, as_of_policy: "whenever" }), Article78BacktestError);
    assert.throws(
      () => resolveBacktestCutoff({ determination, as_of_policy: { policy: "explicit", cutoffs: { [SOHO_NOHO]: "last summer" } } }),
      /must be a parseable ISO date/,
    );
    assert.throws(
      () => resolveBacktestCutoff({ determination, as_of_policy: "explicit" }),
      /requires a cutoff for every determination/,
    );
    for (const policy of ARTICLE78_AS_OF_POLICY_IDS) {
      assert.equal(typeof policy, "string");
    }
  });

  it("records on every row which cutoff it used and where the cutoff came from", () => {
    for (const head of ARTICLE78_BACKTEST_HEADS) {
      for (const row of REPORT.heads[head].rows) {
        assert.match(row.as_of, /^\d{4}-\d{2}-\d{2}$/);
        assert.equal(row.as_of_source, "determination_final");
      }
    }
  });
});
