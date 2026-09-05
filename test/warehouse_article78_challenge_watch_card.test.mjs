import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  addDaysToDate,
  ARTICLE78_CHALLENGE_WATCH_CARD_SCHEMA,
  ARTICLE78_DEADLINE_CLOCK_STATES,
  ARTICLE78_DEADLINE_CLOCK_UNKNOWN_REASONS,
  ARTICLE78_DEADLINE_RULES,
  Article78ChallengeWatchCardError,
  assertChallengeWatchCard,
  assertRenderedCard,
  buildChallengeWatchCard,
  CHALLENGE_WATCH_CARD_AUDIENCE,
  CHALLENGE_WATCH_CARD_CLOCK_ROW_KEYS,
  CHALLENGE_WATCH_CARD_ROW_KEYS,
  CHALLENGE_WATCH_CARD_ROWS,
  CHALLENGE_WATCH_CARD_TITLE,
  computeDeadlineClock,
  FORBIDDEN_CARD_FIELD_TERMS,
  latestRecordedObservation,
  renderChallengeWatchCard,
  serviceClockFor,
} from "../warehouse/lib/article78_challenge_watch_card.mjs";
import {
  CHALLENGE_WATCH_LABEL,
  deriveChallengeWatch,
  findChallengeWatchPredictionWording,
  FORBIDDEN_CHALLENGE_WATCH_PREDICTION_WORDINGS,
} from "../warehouse/lib/article78_challenge_watch.mjs";
import {
  ARTICLE78_COUNTABLE_COVERAGE_GRADES,
  ARTICLE78_LIMITATIONS_MONTHS,
  findForbiddenChallengeWatchWording,
} from "../warehouse/lib/article78_litigation.mjs";
import {
  buildChallengeWatchCardArtifacts,
  CHALLENGE_WATCH_CARD_DIR_RELATIVE,
} from "../tools/backtest_article78_ontology.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CARD_DIR = join(ROOT, CHALLENGE_WATCH_CARD_DIR_RELATIVE);

/** A minimal A78-01 determination context, valid against its own spec. */
function synthDetermination({
  finality = "final",
  finalDate = "2024-01-15",
  closesOn = null,
  key = "determination:city_planning_commission:action_watch_card_0001:2024-01-15",
} = {}) {
  return {
    record_schema: "cityscroll.article78_litigation.determination_context.v1",
    determination_key: key,
    finality,
    final_and_binding_date: finalDate,
    limitations_window_closes_on: closesOn,
  };
}

/** A78-04's watch for that determination, at a stated cutoff and grade. */
function synthWatch(determination, asOf, grade = "A") {
  return deriveChallengeWatch({ determination, coverage: { grade }, as_of: asOf });
}

function synthCard({ determination = synthDetermination(), asOf = "2024-02-01", grade = "A", ...rest } = {}) {
  return buildChallengeWatchCard({
    determination,
    watch: synthWatch(determination, asOf, grade),
    project_id: "synthetic_project",
    project_name: "Synthetic Project",
    as_of: asOf,
    ...rest,
  });
}

/** The thirteen fixture cards, built once. */
const FIXTURE_CARDS = buildChallengeWatchCardArtifacts();
const CITY_POINT = FIXTURE_CARDS.find((artifact) => artifact.project_id === "city_point");
const MOTT_HAVEN = FIXTURE_CARDS.find((artifact) => artifact.project_id === "mott_haven_educational_campus");

function rowOf(card, key) {
  return card.rows.find((row) => row.key === key);
}

// ---------------------------------------------------------------------------
// A1: nine separate rows, in the model and in a rendered card.
// ---------------------------------------------------------------------------

describe("A78-06 challenge watch card: separated components (A1)", () => {
  it("names the nine components as the documented rows, once each and in order", () => {
    assert.deepEqual(CHALLENGE_WATCH_CARD_ROW_KEYS, [
      "named_opponent_or_coalition",
      "preserved_issue",
      "limitations_clock",
      "service_clock",
      "theory_fit",
      "procedural_exposure",
      "merits_indicators",
      "remedy_exposure",
      "court_search_coverage",
    ]);
    assert.equal(new Set(CHALLENGE_WATCH_CARD_ROW_KEYS).size, 9);
  });

  it("builds a model with one row per component, each carrying its own evidence list", () => {
    const card = CITY_POINT.card;
    assert.equal(card.schema, ARTICLE78_CHALLENGE_WATCH_CARD_SCHEMA);
    assert.deepEqual(card.rows.map((row) => row.key), CHALLENGE_WATCH_CARD_ROW_KEYS);
    for (const row of card.rows) {
      assert.ok(Array.isArray(row.evidence), `${row.key} must carry its own evidence array`);
      assert.ok(row.statement.trim() !== "", `${row.key} must state what it found`);
    }
    // The row that reports records cites them.
    assert.ok(rowOf(card, "named_opponent_or_coalition").evidence.length > 0);
    assert.ok(rowOf(card, "preserved_issue").evidence.length > 0);
    assert.ok(rowOf(card, "theory_fit").evidence.length > 0);
    assert.ok(rowOf(card, "court_search_coverage").evidence.length > 0);
  });

  it("refuses two rows resting on the same upstream fact, so no row can summarize another", () => {
    const card = CITY_POINT.card;
    const sources = card.rows.map((row) => row.rests_on);
    assert.equal(new Set(sources).size, sources.length, "every row rests on its own named source");
    const duplicated = {
      ...card,
      rows: card.rows.map((row) => (row.key === "remedy_exposure"
        ? { ...row, rests_on: rowOf(card, "merits_indicators").rests_on }
        : row)),
    };
    assert.throws(() => assertChallengeWatchCard(duplicated), /rest on/);
  });

  it("refuses a card with a missing or an extra row", () => {
    const card = CITY_POINT.card;
    assert.throws(() => assertChallengeWatchCard({ ...card, rows: card.rows.slice(1) }), /exactly 9 rows/);
    assert.throws(() => assertChallengeWatchCard({ ...card, rows: [...card.rows, card.rows[0]] }), /exactly 9 rows/);
    assert.throws(
      () => assertChallengeWatchCard({ ...card, rows: [...card.rows].reverse() }),
      /documented order/,
    );
  });

  it("renders every row as its own section on the page", () => {
    const rendered = renderChallengeWatchCard(CITY_POINT.card);
    for (const definition of CHALLENGE_WATCH_CARD_ROWS) {
      assert.ok(rendered.html.includes(`data-row-key="${definition.key}"`), `${definition.key} must be a section of its own`);
      assert.ok(rendered.html.includes(definition.label), `${definition.key} must be rendered under its own label`);
    }
    assert.deepEqual(rendered.row_keys, CHALLENGE_WATCH_CARD_ROW_KEYS);
    // The rendered committed card says the same thing.
    const committed = readFileSync(join(CARD_DIR, "city-point.html"), "utf8");
    assert.equal(committed, rendered.html);
  });

  it("renders the same bytes from the same inputs", () => {
    const again = buildChallengeWatchCardArtifacts();
    assert.deepEqual(again.map((artifact) => artifact.html), FIXTURE_CARDS.map((artifact) => artifact.html));
  });
});

// ---------------------------------------------------------------------------
// A2: labelled a challenge watch, and internal.
// ---------------------------------------------------------------------------

describe("A78-06 challenge watch card: the label and the audience boundary (A2)", () => {
  it("labels the surface a challenge watch and declares itself internal", () => {
    const card = CITY_POINT.card;
    assert.equal(card.label, CHALLENGE_WATCH_LABEL);
    assert.ok(card.title.includes(CHALLENGE_WATCH_LABEL));
    assert.equal(CHALLENGE_WATCH_CARD_TITLE, `${CHALLENGE_WATCH_LABEL}, internal, diagnostic only`);
    assert.equal(card.audience, CHALLENGE_WATCH_CARD_AUDIENCE);
    assert.equal(card.no_resident_conclusion, true);
    assert.throws(() => assertChallengeWatchCard({ ...card, audience: "resident" }), /audience/);
    assert.throws(() => assertChallengeWatchCard({ ...card, no_resident_conclusion: false }), /no_resident_conclusion/);
    assert.throws(() => assertChallengeWatchCard({ ...card, label: "litigation risk" }), /labelled/);
  });

  it("states challenge watch, internal, diagnostic only in every rendered page header", () => {
    for (const name of readdirSync(CARD_DIR)) {
      const html = readFileSync(join(CARD_DIR, name), "utf8");
      assert.ok(html.includes(CHALLENGE_WATCH_CARD_TITLE), `${name} must carry the header`);
      assert.ok(html.includes(`data-audience="${CHALLENGE_WATCH_CARD_AUDIENCE}"`), `${name} must declare its audience`);
      assert.ok(html.includes('data-no-resident-conclusion="true"'), `${name} must declare the boundary`);
    }
  });

  it("carries no prediction wording in the cards, the module or the contract document", () => {
    const surfaces = [
      ...readdirSync(CARD_DIR).map((name) => `${CHALLENGE_WATCH_CARD_DIR_RELATIVE}/${name}`),
      "warehouse/lib/article78_challenge_watch_card.mjs",
      "docs/article78-challenge-watch-card-v1.md",
    ];
    const offenders = [];
    for (const file of surfaces) {
      const text = readFileSync(join(ROOT, file), "utf8");
      for (const phrase of findChallengeWatchPredictionWording(text)) offenders.push({ file, phrase });
      for (const phrase of findForbiddenChallengeWatchWording(text)) offenders.push({ file, phrase });
    }
    assert.deepEqual(offenders, [], `forbidden wording reached an A78-06 surface: ${JSON.stringify(offenders)}`);
    // The scanner this rests on really does catch the phrase this card is
    // named after, built from the constant so this file stays clean itself.
    const [predicted] = FORBIDDEN_CHALLENGE_WATCH_PREDICTION_WORDINGS;
    assert.deepEqual(findChallengeWatchPredictionWording(`A ${predicted} for this project.`), [predicted]);
  });

  it("refuses a rendered card that carries a link or names a resident route", () => {
    for (const name of readdirSync(CARD_DIR)) {
      const html = readFileSync(join(CARD_DIR, name), "utf8");
      for (const marker of ["<a ", "href=", "site/", "/browse/", "/now/"]) {
        assert.ok(!html.includes(marker), `${name} must not carry ${JSON.stringify(marker)}`);
      }
    }
    const linked = renderChallengeWatchCard(CITY_POINT.card);
    assert.throws(
      () => assertRenderedCard({ ...linked, html: `${linked.html}<a href="/browse/">resident</a>` }),
      Article78ChallengeWatchCardError,
    );
  });

  it("writes only under warehouse/reports, and no resident surface reaches back to the cards", () => {
    for (const artifact of FIXTURE_CARDS) {
      assert.ok(artifact.path.startsWith("warehouse/reports/challenge-watch-cards/"), `${artifact.path} must live under warehouse/reports`);
      assert.ok(!artifact.path.includes("site/"), `${artifact.path} must never be written under site/`);
    }
    // Nothing tracked under site/ or worker/ mentions the card directory, so
    // no resident route or Worker read can reach one. `git grep` exits 1 when
    // nothing matches, which is the passing case here.
    let matches = "";
    try {
      matches = execFileSync("git", ["grep", "-l", "challenge-watch-cards", "--", "site", "worker"], { cwd: ROOT, encoding: "utf8" });
    } catch (error) {
      assert.equal(error.status, 1, `git grep failed: ${error.message}`);
    }
    assert.equal(matches.trim(), "", `a resident-facing tree references the internal cards: ${matches}`);
  });

  it("carries no overall score, verdict or likelihood field anywhere in the model", () => {
    const card = CITY_POINT.card;
    const keys = new Set();
    const walk = (value) => {
      if (Array.isArray(value)) return value.forEach(walk);
      if (value !== null && typeof value === "object") {
        for (const [key, item] of Object.entries(value)) {
          keys.add(key);
          walk(item);
        }
      }
      return undefined;
    };
    walk(card);
    for (const term of [...FORBIDDEN_CARD_FIELD_TERMS, "score", "combined", "overall", "risk"]) {
      assert.ok(!keys.has(term), `the card must carry no ${term} field`);
    }
    // A78-04's level is deliberately absent: nine components with a level
    // above them is a summary whatever it is labelled.
    assert.ok(!keys.has("level"));
    assert.throws(
      () => assertChallengeWatchCard({ ...card, challenge_watch_level: "high" }),
      /no overall score, verdict or likelihood/,
    );
    assert.throws(
      () => assertChallengeWatchCard({ ...card, composite_score: 1 }),
      /never combined into one number/,
    );
  });
});

// ---------------------------------------------------------------------------
// A3: every component shows the grade it rests on.
// ---------------------------------------------------------------------------

describe("A78-06 challenge watch card: coverage grade on every row (A3)", () => {
  it("displays the court-search coverage grade on each of the nine rows", () => {
    for (const artifact of FIXTURE_CARDS) {
      for (const row of artifact.card.rows) {
        assert.equal(row.coverage_grade, artifact.coverage_grade, `${artifact.project_id}/${row.key} must show the grade it rests on`);
      }
      const html = readFileSync(join(ROOT, artifact.path), "utf8");
      const rendered = html.split('data-coverage-grade="').length - 1;
      assert.equal(rendered, 9, `${artifact.project_id} must render the grade on all nine rows`);
    }
  });

  it("says on every row when the grade is not good enough to support a count", () => {
    assert.ok(!ARTICLE78_COUNTABLE_COVERAGE_GRADES.includes(MOTT_HAVEN.coverage_grade));
    assert.equal(MOTT_HAVEN.card.coverage_grade_admissible, false);
    for (const row of MOTT_HAVEN.card.rows) {
      assert.equal(row.coverage_grade_admissible, false);
      assert.match(row.coverage_admissibility_note, /can be read as a complete picture/);
    }
    assert.equal(rowOf(MOTT_HAVEN.card, "named_opponent_or_coalition").state, "not_established");
    assert.equal(rowOf(MOTT_HAVEN.card, "preserved_issue").state, "not_established");
  });

  it("refuses a row that displays a grade the card does not rest on", () => {
    const card = CITY_POINT.card;
    const tampered = {
      ...card,
      rows: card.rows.map((row) => (row.key === "theory_fit" ? { ...row, coverage_grade: "A" === card.coverage_grade ? "B" : "A" } : row)),
    };
    assert.throws(() => assertChallengeWatchCard(tampered), /must display the court-search coverage grade/);
  });
});

// ---------------------------------------------------------------------------
// A4: the clocks are computed from rules, with their inputs shown.
// ---------------------------------------------------------------------------

describe("A78-06 challenge watch card: deterministic deadline clocks (A4)", () => {
  it("states each rule as data: the statute, the trigger and the period", () => {
    const limitations = ARTICLE78_DEADLINE_RULES.limitations;
    assert.equal(limitations.statute, "CPLR 217(1)");
    assert.equal(limitations.trigger_event, "determination_final_and_binding");
    assert.deepEqual(limitations.period, { months: ARTICLE78_LIMITATIONS_MONTHS });
    const service = ARTICLE78_DEADLINE_RULES.service;
    assert.equal(service.statute, "CPLR 306-b");
    assert.equal(service.trigger_event, "limitations_period_expires");
    assert.deepEqual(service.period, { days: 15 });
    for (const rule of Object.values(ARTICLE78_DEADLINE_RULES)) {
      assert.match(rule.citation, /New York Civil Practice Law and Rules/);
      assert.ok(rule.summary.trim() !== "" && rule.note.trim() !== "");
    }
  });

  it("computes an open clock, and shows every input it used", () => {
    const card = synthCard({ determination: synthDetermination({ finalDate: "2024-01-15" }), asOf: "2024-02-01" });
    const limitations = rowOf(card, "limitations_clock");
    assert.equal(limitations.state, "open");
    assert.equal(limitations.clock.trigger_date, "2024-01-15");
    assert.equal(limitations.clock.deadline, "2024-05-15");
    assert.equal(limitations.clock.deadline_source, "computed from the rule");
    assert.equal(limitations.clock.rule_id, ARTICLE78_DEADLINE_RULES.limitations.rule_id);
    const service = rowOf(card, "service_clock");
    assert.equal(service.state, "open");
    assert.equal(service.clock.trigger_date, "2024-05-15");
    assert.equal(service.clock.deadline, addDaysToDate("2024-05-15", 15));
    assert.equal(service.clock.deadline, "2024-05-30");
  });

  it("computes an expired clock once the cutoff passes the deadline", () => {
    const card = synthCard({ determination: synthDetermination({ finalDate: "2024-01-15" }), asOf: "2024-06-01" });
    assert.equal(rowOf(card, "limitations_clock").state, "expired");
    assert.equal(rowOf(card, "service_clock").state, "expired");
    // The boundary is the deadline itself: on the deadline the clock is open.
    const onDeadline = synthCard({ determination: synthDetermination({ finalDate: "2024-01-15" }), asOf: "2024-05-15" });
    assert.equal(rowOf(onDeadline, "limitations_clock").state, "open");
    const dayAfter = synthCard({ determination: synthDetermination({ finalDate: "2024-01-15" }), asOf: "2024-05-16" });
    assert.equal(rowOf(dayAfter, "limitations_clock").state, "expired");
  });

  it("keeps an unknown clock unknown, with the reason and no deadline", () => {
    const unknown = synthCard({
      determination: synthDetermination({ finality: "unknown", finalDate: null }),
      asOf: "2024-06-01",
    });
    for (const key of CHALLENGE_WATCH_CARD_CLOCK_ROW_KEYS) {
      const row = rowOf(unknown, key);
      assert.equal(row.state, "unknown");
      assert.equal(row.clock.deadline, null, "an unknown clock computes no deadline");
      assert.ok(ARTICLE78_DEADLINE_CLOCK_UNKNOWN_REASONS.includes(row.clock.unknown_reason));
    }
    assert.equal(rowOf(unknown, "limitations_clock").clock.unknown_reason, "determination_finality_unknown");
    assert.equal(rowOf(unknown, "service_clock").clock.unknown_reason, "upstream_clock_unknown");

    const nonfinal = synthCard({
      determination: synthDetermination({ finality: "nonfinal", finalDate: null }),
      asOf: "2024-06-01",
    });
    assert.equal(rowOf(nonfinal, "limitations_clock").clock.unknown_reason, "determination_not_final");
  });

  it("reports a stated closing date as stated, rather than recomputing it", () => {
    const determination = synthDetermination({ finalDate: "2024-01-15", closesOn: "2024-03-01" });
    const card = synthCard({ determination, asOf: "2024-02-01" });
    const limitations = rowOf(card, "limitations_clock");
    assert.equal(limitations.clock.deadline, "2024-03-01");
    assert.match(limitations.clock.deadline_source, /stated on the determination context/);
    assert.equal(limitations.clock.computed_deadline, "2024-05-15", "the rule's own answer is still shown beside the stated one");
    // The service clock follows the stated expiry, not the four-month default.
    assert.equal(rowOf(card, "service_clock").clock.deadline, "2024-03-16");
  });

  it("treats a trigger dated after the cutoff as unknown rather than as a started clock", () => {
    const clock = computeDeadlineClock({
      rule: ARTICLE78_DEADLINE_RULES.limitations,
      trigger_date: "2024-08-01",
      as_of: "2024-02-01",
    });
    assert.equal(clock.state, "unknown");
    assert.equal(clock.unknown_reason, "trigger_event_not_on_the_record_at_cutoff");
    assert.equal(clock.deadline, null);
  });

  it("clamps month arithmetic to the end of the target month", () => {
    const clock = computeDeadlineClock({
      rule: ARTICLE78_DEADLINE_RULES.limitations,
      trigger_date: "2018-10-31",
      as_of: "2018-11-01",
    });
    assert.equal(clock.deadline, "2019-02-28");
    assert.equal(serviceClockFor(clock, "2018-11-01").deadline, "2019-03-15");
  });

  it("reports clock states only on the clock rows, and record states only off them", () => {
    const card = CITY_POINT.card;
    for (const row of card.rows) {
      const isClock = CHALLENGE_WATCH_CARD_CLOCK_ROW_KEYS.includes(row.key);
      assert.equal(ARTICLE78_DEADLINE_CLOCK_STATES.includes(row.state), isClock, `${row.key} carries the wrong class of state`);
      assert.equal(row.clock === null, !isClock, `${row.key} carries a clock it should not`);
    }
    const tampered = {
      ...card,
      rows: card.rows.map((row) => (row.key === "limitations_clock" ? { ...row, clock: { ...row.clock, deadline: null } } : row)),
    };
    assert.throws(() => assertChallengeWatchCard(tampered), /unknown stays unknown/);
  });

  it("renders the clock inputs on the page, not only the answer", () => {
    const html = readFileSync(join(CARD_DIR, "city-point.html"), "utf8");
    for (const field of ["Rule applied", "Triggering event", "Trigger date", "Period", "Computed deadline", "State at the cutoff"]) {
      assert.ok(html.includes(field), `the clock row must render ${field}`);
    }
    assert.ok(html.includes("CPLR 217(1)") && html.includes("CPLR 306-b"));
  });

  it("computes the fixture's clocks from the determination it recorded", () => {
    const inwood = FIXTURE_CARDS.find((artifact) => artifact.project_id === "inwood_rezoning");
    const limitations = rowOf(inwood.card, "limitations_clock");
    assert.equal(limitations.clock.trigger_date, "2018-08-08");
    assert.equal(limitations.clock.deadline, "2018-12-08");
    assert.equal(limitations.state, "expired");
    assert.equal(rowOf(inwood.card, "service_clock").clock.deadline, "2018-12-23");
    // A card whose cutoff falls inside the window reports it open instead.
    const water = FIXTURE_CARDS.find((artifact) => artifact.project_id === "250_water_street");
    assert.equal(rowOf(water.card, "limitations_clock").state, "open");
    assert.equal(rowOf(water.card, "service_clock").state, "open");
  });
});

// ---------------------------------------------------------------------------
// The cutoff, and the record channels.
// ---------------------------------------------------------------------------

describe("A78-06 challenge watch card: the cutoff", () => {
  it("refuses a watch derived at a different cutoff than the card", () => {
    const determination = synthDetermination();
    assert.throws(
      () => buildChallengeWatchCard({ determination, watch: synthWatch(determination, "2024-03-01"), as_of: "2024-02-01" }),
      /cutoff/,
    );
  });

  it("takes the card cutoff from the records rather than from a clock", () => {
    assert.equal(
      latestRecordedObservation([[{ observed_at: "2024-01-01T00:00:00Z" }], [{ searched_at: "2024-05-06T12:00:00Z" }]]),
      "2024-05-06",
    );
    assert.equal(latestRecordedObservation([[{ note: "undated" }]]), null);
    for (const artifact of FIXTURE_CARDS) {
      assert.match(artifact.as_of, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(artifact.card.as_of, artifact.as_of);
    }
  });

  it("excludes a record published after the cutoff and says so on the row that would have read it", () => {
    const determination = synthDetermination({ finalDate: "2024-01-15" });
    const asOf = "2024-02-01";
    const cases = [{
      record_schema: "cityscroll.article78_litigation.judicial_case.v1",
      case_key: "judicial_case:ny_supreme_court_new_york_county:100001_2024",
      determination_key: determination.determination_key,
      caption: "Late Filed Neighbors v. City Planning Commission",
      filed_date: "2024-03-01",
      observed_at: "2024-03-05T00:00:00Z",
      source_id: "synthetic",
      source_record_id: "case/synthetic/0001",
    }];
    const card = synthCard({ determination, asOf, cases });
    const row = rowOf(card, "named_opponent_or_coalition");
    assert.equal(row.state, "not_on_the_record");
    assert.equal(row.excluded_evidence.length, 1);
    assert.match(row.excluded_evidence[0].statement, /observed after the cutoff/);

    // The same case, with a cutoff that admits it, is on the record.
    const later = synthCard({ determination, asOf: "2024-04-01", cases });
    assert.equal(rowOf(later, "named_opponent_or_coalition").state, "on_the_record");
    assert.equal(rowOf(later, "named_opponent_or_coalition").excluded_evidence.length, 0);
  });
});

// ---------------------------------------------------------------------------
// The fixture cards, and what the separation buys.
// ---------------------------------------------------------------------------

describe("A78-06 challenge watch card: the fixture cards", () => {
  it("renders one committed card per fixture project", () => {
    assert.equal(FIXTURE_CARDS.length, 13);
    const written = readdirSync(CARD_DIR).sort();
    assert.deepEqual(written, FIXTURE_CARDS.map((artifact) => artifact.path.split("/").pop()).sort());
  });

  it("reports procedure, merits and remedy as three separately recorded rows", () => {
    const gowanus = FIXTURE_CARDS.find((artifact) => artifact.project_id === "gowanus_neighborhood_rezoning").card;
    const procedural = rowOf(gowanus, "procedural_exposure");
    const merits = rowOf(gowanus, "merits_indicators");
    const remedy = rowOf(gowanus, "remedy_exposure");
    for (const row of [procedural, merits, remedy]) assert.equal(row.state, "on_the_record");
    assert.ok(procedural.value.every((entry) => "procedural_survival" in entry));
    assert.ok(merits.value.every((entry) => "durable_petitioner_relief" in entry));
    assert.ok(remedy.value.every((entry) => "remedy_exposure" in entry));
    // No row repeats another's field.
    assert.ok(!JSON.stringify(procedural.value).includes("durable_petitioner_relief"));
    assert.ok(!JSON.stringify(remedy.value).includes("procedural_survival"));
  });

  it("reads relief from the effective decision after supersession", () => {
    const havenGreen = FIXTURE_CARDS.find((artifact) => artifact.project_id === "haven_green_elizabeth_street_garden").card;
    const merits = rowOf(havenGreen, "merits_indicators");
    assert.ok(merits.value.some((entry) => entry.superseded_decision_keys.length > 0), "the reversed trial decision must be recorded as superseded");
    assert.ok(merits.detail.some((line) => line.includes("after supersession")));
  });

  it("carries the labor suppression rule onto the row that reports a labor participant", () => {
    const row = rowOf(CITY_POINT.card, "named_opponent_or_coalition");
    assert.equal(row.suppression, "no motive, misconduct, or legal-viability inference");
    assert.ok(row.detail.some((line) => line.includes("named participant and nothing more")));
    assert.equal(new Set(row.value.map((entry) => entry.name)).size, row.value.length, "a participant is named once");
  });
});
