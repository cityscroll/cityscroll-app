import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  BACKFILL_RANKING_WEIGHTS,
  compareCitations,
  coverageForProvision,
  coverageIntervals,
  historicalCodeChanges,
  historicalConflicts,
  historicalObservations,
  parseHistoryNote,
  provisionBackfillCoverage,
  rankBackfillCandidates,
  renderProvisionBackfillCoverage,
  retainHistoricalVersions,
  selectBackfillBatch,
  unknownIntervals,
} from "../site/code_history_backfill.mjs";
import {
  buildProvisionHistoryIndex,
  getProvisionAsOf,
} from "../site/code_provision_history.mjs";
import { legalChangeGraph } from "../ontology/legal_change.mjs";
import { renderAdminCodeProvisionDocument } from "../site/admin_code.mjs";
import { buildBackfill } from "../tools/build_code_history_backfill.mjs";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/code_history_backfill.json", import.meta.url), "utf8"));
const readModel = JSON.parse(readFileSync(new URL("../site/data/code_history_backfill.json", import.meta.url), "utf8"));

const provision = fixtures.provision;

function observationsFor(row) {
  return historicalObservations(row);
}

test("A1 the published batch names its sections, sources, coverage, and open periods", () => {
  const { batch } = readModel;
  assert.equal(batch.schema, "cityscroll.code_history_backfill_batch.v1");
  assert.equal(batch.complete_history, false);
  assert.equal(batch.scope, "prioritized sections only");
  assert.ok(batch.selected.length > 0, "batch names at least one section");
  assert.equal(batch.selected.length, batch.selected_count);
  assert.ok(batch.selected.length <= batch.cutoff.limit, "batch stays inside its own limit");
  for (const selection of batch.selected) {
    assert.match(selection.provision_id, /^nyc-administrative-code:/);
    assert.ok(selection.citation, "each selected section carries a citation");
    assert.ok(selection.score >= batch.cutoff.minimum_score, "each selection clears the stated minimum");
    assert.ok(selection.inputs.retained_change_count >= batch.eligibility.minimum_recorded_changes);
  }

  assert.ok(batch.sources.length >= 2, "the batch names the sources it depends on");
  const retained = batch.sources.filter((source) => source.acquisition_status === "retained");
  const notAcquired = batch.sources.filter((source) => source.acquisition_status === "not_acquired");
  assert.ok(retained.length >= 1, "at least one source is already retained");
  assert.ok(notAcquired.length >= 1, "acquisition gaps stay named");
  for (const source of notAcquired) assert.ok(source.acquisition_note, "an unacquired source records why");

  assert.equal(readModel.coverage.length, batch.selected.length);
  const openIntervals = readModel.coverage.flatMap((row) => row.unknown_intervals);
  assert.ok(openIntervals.length > 0, "the batch keeps its remaining unknown periods visible");
  for (const row of readModel.coverage) {
    assert.equal(row.complete_history, false);
    assert.equal(row.batch_id, batch.batch_id);
    assert.ok(row.intervals.length >= 1);
  }
});

test("A1 the cutoff is explicit and widening the batch stays a decision", () => {
  const { batch } = readModel;
  assert.ok(batch.cutoff.rule.length > 0);
  assert.equal(typeof batch.cutoff.limit, "number");
  assert.equal(typeof batch.cutoff.minimum_score, "number");
  assert.ok(batch.cutoff.lowest_selected_score >= batch.cutoff.minimum_score);
  if (batch.cutoff.next_excluded) {
    assert.ok(batch.cutoff.next_excluded.score <= batch.cutoff.lowest_selected_score);
  }
  assert.ok(batch.eligibility.without_recorded_change_count > 0);
  assert.ok(
    batch.eligibility.highest_ranked_without_recorded_change.length > 0,
    "a highly referenced section with no recorded change is named rather than dropped silently",
  );
  for (const row of batch.eligibility.highest_ranked_without_recorded_change) {
    assert.ok(row.reason.length > 0);
  }
});

test("A1 ranking is deterministic, weighted, and recomputable from its recorded inputs", () => {
  const ranking = rankBackfillCandidates(fixtures.ranking_candidates);
  const again = rankBackfillCandidates([...fixtures.ranking_candidates].reverse());
  assert.deepEqual(
    ranking.candidates.map((row) => row.provision_id),
    again.candidates.map((row) => row.provision_id),
    "input order does not change the ranking",
  );
  for (const candidate of ranking.candidates) {
    const expected = (candidate.inputs.inbound_reference_count * BACKFILL_RANKING_WEIGHTS.inbound_reference)
      + (candidate.inputs.retained_change_count * BACKFILL_RANKING_WEIGHTS.retained_change)
      + (candidate.inputs.distinct_instrument_count * BACKFILL_RANKING_WEIGHTS.distinct_instrument)
      + (candidate.inputs.mandate_join_count * BACKFILL_RANKING_WEIGHTS.mandate_join)
      + (candidate.inputs.authority_citation_count * BACKFILL_RANKING_WEIGHTS.authority_citation);
    assert.equal(candidate.score, expected, `${candidate.citation} score recomputes from its inputs`);
  }
  const tied = ranking.candidates.filter((row) => row.citation === "§ 20-9" || row.citation === "§ 20-10");
  assert.deepEqual(tied.map((row) => row.citation), ["§ 20-9", "§ 20-10"], "ties break in citation order");
  assert.ok(compareCitations("§ 20-9", "§ 20-10") < 0);

  const batch = selectBackfillBatch(ranking, { batch_id: "batch-test", limit: 2, minimum_score: 10 });
  assert.equal(batch.selected.length, 2);
  assert.equal(batch.complete_history, false);
  assert.ok(batch.eligibility.without_recorded_change_count >= 1, "a zero-change candidate is ineligible");
  assert.ok(!batch.selected.some((row) => row.citation === "§ 25-412"));
});

test("A1 published ranking inputs that are not materialized stay declared", () => {
  assert.ok(readModel.unavailable_inputs.length >= 1);
  for (const input of readModel.unavailable_inputs) {
    assert.equal(input.status, "not_materialized");
    assert.ok(input.reason.length > 0);
    assert.ok(input.effect.length > 0);
    for (const row of readModel.batch.selected) {
      assert.equal(row.inputs[input.input], 0, "an unmaterialized input contributes nothing to the order");
    }
  }
});

test("the publisher note yields source-stated operations, instruments, and effective dates", () => {
  const parsed = parseHistoryNote(fixtures.notes.add_then_amend);
  assert.deepEqual(parsed.entries.map((entry) => entry.operation), ["add", "amend"]);
  assert.deepEqual(parsed.entries.map((entry) => entry.instrument_ref), ["local-law:27-2015", "local-law:183-2017"]);
  assert.deepEqual(parsed.entries.map((entry) => entry.effective_at), ["2015-05-29", "2017-10-08"]);
  assert.equal(parsed.entries[0].signed_at, "2015-03-30");
  assert.equal(parsed.unparsed.length, 0);

  const repeal = parseHistoryNote(fixtures.notes.repeal);
  assert.deepEqual(repeal.entries.map((entry) => entry.operation), ["add", "repeal"]);
  assert.equal(repeal.entries[1].instrument_ref, "local-law:113-2015");

  const renumberedAndAmended = parseHistoryNote(fixtures.notes.renumbered_and_amended);
  assert.deepEqual(
    renumberedAndAmended.entries.map((entry) => entry.operation),
    ["redesignate", "amend"],
    "one compound instruction becomes two discrete operations",
  );
});

test("A2 an amendment changes the version, never the provision identity", () => {
  const observations = observationsFor(provision);
  const changes = historicalCodeChanges(observations, { provision });
  assert.equal(changes.length, 2);
  for (const change of changes) {
    assert.equal(change.target.provision_id, provision.id, "every change keeps the same persistent provision id");
    assert.equal(change.target.corpus_id, "nyc-administrative-code");
  }
  assert.deepEqual(changes.map((change) => change.operation), ["add", "amend"]);

  const { versions, rejected } = retainHistoricalVersions(provision, fixtures.acquired.well_evidenced);
  assert.equal(rejected.length, 0);
  assert.equal(versions.length, 2);
  for (const version of versions) {
    assert.equal(version.provision_id, provision.id);
    assert.ok(Object.isFrozen(version), "a retained version is immutable");
    assert.equal(version.materialization_status, "materialized");
    assert.ok(version.content_hash.startsWith("sha256:"));
  }
  assert.deepEqual(versions.map((version) => [version.valid_from, version.valid_to]), [
    ["2015-05-29", "2017-10-08"],
    ["2017-10-08", null],
  ], "versions carry distinct legal-validity intervals");

  const earlier = getProvisionAsOf({
    provision_id: provision.id,
    provision,
    versions,
    changes,
    as_of: "2016-06-01",
  });
  assert.equal(earlier.status, "current");
  assert.equal(earlier.text, "Original statutory text as enacted in 2015.");
  assert.equal(earlier.used_publisher_current_text, false);
});

test("A2 a historical version stays traversable to the law that changed it", () => {
  const observations = observationsFor(provision);
  const changes = historicalCodeChanges(observations, { provision });
  const { versions } = retainHistoricalVersions(provision, fixtures.acquired.well_evidenced);
  const amend = changes.find((change) => change.operation === "amend");
  assert.equal(amend.legal_instrument_id, "local-law:183-2017");
  assert.equal(amend.state, "enacted");
  assert.equal(amend.change_basis, "source_stated");
  assert.equal(amend.source.instruction_text, "Am. L.L. 2017/183, 10/8/2017, eff. 10/8/2017");
  assert.equal(amend.source.url, provision.source.url);

  const version = versions.find((row) => row.valid_from === amend.effective_at);
  assert.ok(version, "a retained version starts at the change's stated effective date");

  const graph = legalChangeGraph({
    matter: { id: "matter:local-law:183-2017" },
    local_law: {
      id: "local-law:183-2017",
      matter_id: "matter:local-law:183-2017",
      local_law_number: "183 of 2017",
      enacted_at: "2017-10-08",
      effective_at: "2017-10-08",
    },
    changes: [amend],
  });
  const index = buildProvisionHistoryIndex({
    graphs: [graph],
    versions: { [provision.id]: versions },
    provisions: { [provision.id]: provision },
  });
  const row = index.by_provision[provision.id];
  assert.equal(row.changes.length, 1);
  assert.equal(row.changes[0].legal_instrument_id, "local-law:183-2017");
  assert.equal(row.versions.length, 2);
  assert.deepEqual(index.by_law["local-law:183-2017"].provision_ids, [provision.id]);
});

test("A2 delayed, retroactive, and unstated effective dates are never applied as a blanket date", () => {
  const delayed = parseHistoryNote(fixtures.notes.delayed_effect).entries[0];
  assert.equal(delayed.signed_at, "2021-07-18");
  assert.equal(delayed.effective_at, "2021-11-15");
  assert.equal(delayed.effective_basis, "stated");

  const retroactive = parseHistoryNote(fixtures.notes.state_chapter_law).entries[0];
  assert.equal(retroactive.effective_at, "2021-01-01");
  assert.equal(retroactive.effective_basis, "retroactive");
  assert.equal(retroactive.signed_at, "2022-08-31");

  const absent = parseHistoryNote(fixtures.notes.effective_date_absent).entries[0];
  assert.equal(absent.effective_at, null);
  assert.equal(absent.effective_basis, "unknown");
  assert.equal(absent.signed_at, "2024-02-02", "the signing date never becomes the effective date");

  const conditional = parseHistoryNote(fixtures.notes.conditional_clause);
  assert.deepEqual(conditional.entries.map((entry) => entry.effective_at), ["2024-05-15", null]);
  const intervals = coverageIntervals({
    observations: historicalObservations({
      ...provision,
      current_text: fixtures.notes.conditional_clause,
    }),
    versions: [],
    observed_at: "2026-08-24",
  });
  assert.deepEqual(
    intervals.map((interval) => [interval.from, interval.to]),
    [[null, "2024-05-15"], ["2024-05-15", "2026-08-24"]],
    "an entry with no stated effective date adds no interval boundary",
  );
});

test("A2 a change effective after the snapshot keeps the timeline in order", () => {
  const observations = historicalObservations({
    ...provision,
    current_text: fixtures.notes.effective_after_snapshot,
  });
  const intervals = coverageIntervals({ observations, versions: [], observed_at: "2026-08-24" });
  assert.deepEqual(intervals.map((interval) => [interval.from, interval.to]), [
    [null, "2021-11-15"],
    ["2021-11-15", "2026-08-24"],
    ["2026-08-24", "2026-12-31"],
  ], "a future effective date extends the timeline rather than reversing it");
  for (const interval of intervals) {
    if (interval.from && interval.to) assert.ok(interval.from < interval.to, "each interval runs forwards");
  }
  assert.equal(intervals.at(-1).status, "covered_by_current_snapshot");
  assert.equal(intervals[0].status, "before_enactment");
});

test("A2 a repeal keeps the provision addressable and terminal", () => {
  const row = fixtures.repealed_provision;
  const observations = observationsFor(row);
  const changes = historicalCodeChanges(observations, { provision: row });
  const repeal = changes.find((change) => change.operation === "repeal");
  assert.ok(repeal, "the repealing instruction is retained");
  assert.equal(repeal.legal_instrument_id, "local-law:113-2015");
  assert.equal(repeal.effective_at, "2016-04-08");
  assert.equal(repeal.target.provision_id, row.id, "the repealed provision keeps its identity");

  const coverage = provisionBackfillCoverage({
    provision: row,
    observations,
    changes,
    versions: [],
    observed_at: "2026-08-24",
  });
  assert.equal(coverage.provision_id, row.id);
  assert.ok(coverage.retained_change_count >= 2);
  const page = renderAdminCodeProvisionDocument(row, { backfill: coverage, changes });
  assert.match(page, /data-code-change-operation="repeal"/);
  assert.match(page, /Status: repealed/);
});

test("A2 a redesignation keeps the former numbering and its provenance", () => {
  const row = fixtures.redesignated_provision;
  const observations = observationsFor(row);
  const redesignation = observations.find((item) => item.operation === "redesignate");
  assert.equal(redesignation.former_citation, "3-120");
  assert.equal(redesignation.instrument_ref, "local-law:46-2021");

  const changes = historicalCodeChanges(observations, { provision: row });
  const change = changes.find((item) => item.operation === "redesignate");
  assert.equal(change.redesignation.former_citation, "§ 3-120");
  assert.equal(change.redesignation.successor_provision_id, row.id);

  const page = renderAdminCodeProvisionDocument(row, { changes });
  assert.match(page, /Formerly § 3-120/);
});

test("A2 one law across many sections produces discrete changes per section", () => {
  const [first, second] = fixtures.multi_target_provisions;
  const firstChanges = historicalCodeChanges(observationsFor(first), { provision: first });
  const secondChanges = historicalCodeChanges(observationsFor(second), { provision: second });
  const all = [...firstChanges, ...secondChanges];
  assert.ok(all.every((change) => change.legal_instrument_id === "local-law:80-2021"));
  assert.equal(new Set(all.map((change) => change.id)).size, all.length, "each change has its own identity");
  assert.deepEqual(
    [...new Set(all.map((change) => change.target.provision_id))].sort(),
    ["nyc-administrative-code:20-626", "nyc-administrative-code:20-628"],
  );
  assert.deepEqual(firstChanges.map((change) => change.operation), ["redesignate", "amend"]);
  assert.deepEqual(secondChanges.map((change) => change.operation), ["redesignate"]);
});

test("A2 a state chapter law keeps its own instrument identity", () => {
  const row = fixtures.state_amended_provision;
  const observations = observationsFor(row);
  const [entry] = observations;
  assert.equal(entry.instrument_kind, "state_law");
  assert.equal(entry.instrument_ref, "ny-laws:2022:ch-555");
  assert.equal(entry.local_law_number, null, "a state chapter law is never recorded as a Local Law");

  const coverage = provisionBackfillCoverage({
    provision: row,
    observations,
    changes: historicalCodeChanges(observations, { provision: row }),
    observed_at: "2026-08-24",
  });
  assert.deepEqual(coverage.local_law_refs, []);
  assert.deepEqual(coverage.state_law_refs, ["ny-laws:2022:ch-555"]);
  assert.equal(coverage.corpus_id, "nyc-administrative-code", "the target corpus stays the Administrative Code");
});

test("A3 a failed reconstruction keeps the change and fabricates no version", () => {
  const observations = observationsFor(provision);
  const changes = historicalCodeChanges(observations, { provision });
  const { versions, rejected } = retainHistoricalVersions(provision, fixtures.acquired.patch_failure);
  assert.equal(versions.length, 0, "no version is fabricated from insufficient evidence");
  assert.equal(rejected.length, fixtures.acquired.patch_failure.length);
  assert.deepEqual(rejected.map((row) => row.reason).sort(), [
    "observation carries a different provision identity",
    "source carries no historical text",
    "source reference is absent",
    "source states no legal validity start",
  ]);
  assert.equal(changes.length, 2, "the well-supported changes survive the failed reconstruction");
  for (const change of changes) assert.equal(change.materialization_status, "unresolved");

  const coverage = provisionBackfillCoverage({
    provision,
    observations,
    changes,
    versions,
    observed_at: "2026-08-24",
  });
  assert.equal(coverage.historical_version_count, 0);
  assert.equal(coverage.materialization.materialized, 0);
  assert.equal(coverage.materialization.unresolved, 2);
});

test("A3 a period with no retained text stays unknown instead of being interpolated", () => {
  const observations = observationsFor(provision);
  const partial = retainHistoricalVersions(provision, [fixtures.acquired.well_evidenced[1]]).versions;
  const intervals = coverageIntervals({ observations, versions: partial, observed_at: "2026-08-24" });
  const open = intervals.find((interval) => interval.from === "2015-05-29");
  assert.equal(open.status, "unknown");
  assert.match(open.reason, /historical text not acquired/);

  const asOf = getProvisionAsOf({
    provision_id: provision.id,
    provision,
    versions: partial,
    changes: historicalCodeChanges(observations, { provision }),
    as_of: "2016-06-01",
  });
  assert.equal(asOf.status, "unknown");
  assert.equal(asOf.text, null);
  assert.equal(asOf.used_publisher_current_text, false);

  const unknownOnly = unknownIntervals({ observations, versions: partial, observed_at: "2026-08-24" });
  assert.ok(unknownOnly.every((interval) => interval.status === "unknown"));
  assert.ok(unknownOnly.length < intervals.length);
});

test("A3 disagreeing sources are retained side by side rather than resolved", () => {
  const conflicts = historicalConflicts(fixtures.conflicting_observations, {
    duplicate_records: fixtures.duplicate_records,
  });
  const dateConflict = conflicts.find((row) => row.kind === "effective_date_disagreement");
  assert.deepEqual(dateConflict.stated_effective_dates, ["2017-10-08", "2018-01-06"]);
  assert.equal(dateConflict.resolution, "unresolved");
  assert.equal(dateConflict.observations.length, 2, "both source observations are kept");

  const duplicate = conflicts.find((row) => row.kind === "duplicate_publisher_record");
  assert.equal(duplicate.provision_id, "nyc-administrative-code:3-119.5");
  assert.equal(duplicate.observations.length, 2);
  assert.equal(duplicate.resolution, "unresolved");

  const coverage = provisionBackfillCoverage({
    provision,
    observations: fixtures.conflicting_observations,
    changes: [],
    conflicts,
    observed_at: "2026-08-24",
  });
  const html = renderProvisionBackfillCoverage(coverage);
  assert.match(html, /data-conflict-kind="effective_date_disagreement"/);
  assert.match(html, /2017-10-08, 2018-01-06/);
  assert.match(html, /data-conflict-kind="duplicate_publisher_record"/);
});

test("A3 the published batch retains its corpus conflicts without promoting a source", () => {
  assert.ok(readModel.conflicts.corpus_summary.total > 0);
  assert.equal(
    readModel.conflicts.corpus_summary.total,
    readModel.conflicts.corpus_summary.duplicate_publisher_record
      + readModel.conflicts.corpus_summary.effective_date_disagreement,
  );
  assert.match(readModel.conflicts.corpus_summary.resolution, /no source is promoted/);
  for (const conflict of readModel.conflicts.outside_batch_examples) {
    assert.equal(conflict.resolution, "unresolved");
    assert.ok(conflict.observations.length >= 2);
  }
});

test("a note with no instrument stays unparsed rather than guessed", () => {
  const parsed = parseHistoryNote(fixtures.notes.no_instrument);
  assert.equal(parsed.note_text, null, "a parenthetical with no instrument is not a history note");
  assert.equal(parsed.entries.length, 0);

  const mixed = historicalObservations({
    ...provision,
    current_text: "Body text.\n\n(L.L. 2015/027, 3/30/2015, eff. 5/29/2015; see the rules of the department)",
  });
  const unparsedRow = mixed.find((row) => row.status === "unparsed");
  assert.ok(unparsedRow, "a fragment with no instrument is retained as unparsed");
  assert.equal(unparsedRow.reason, "no stated instrument");
  assert.equal(unparsedRow.operation, null);
});

test("the provision page shows historical coverage beside the existing joins", () => {
  const observations = observationsFor(provision);
  const changes = historicalCodeChanges(observations, { provision });
  const coverage = provisionBackfillCoverage({
    provision,
    observations,
    changes,
    versions: [],
    batch_id: "batch-1",
    rank: 9,
    observed_at: provision.source.observed_at,
  });
  const page = renderAdminCodeProvisionDocument(provision, {
    currentHref: "https://cityscroll.org/administrative-code/21-955/",
    backfill: coverage,
    changes,
  });
  assert.match(page, /id="historical-coverage"/);
  assert.match(page, /Historical backfill batch-1, priority rank 9/);
  assert.match(page, /data-legal-instrument-id="local-law:183-2017"/);
  assert.match(page, /data-coverage-status="unknown"/);
  assert.match(page, /data-coverage-status="covered_by_current_snapshot"/);
  assert.doesNotMatch(page, /data-coverage-status="covered_by_retained_version"/);

  const other = renderAdminCodeProvisionDocument(fixtures.repealed_provision, { backfill: coverage });
  assert.doesNotMatch(other, /id="historical-coverage"/, "coverage never renders on a different provision");
});

test("the published read model resolves coverage for every section it names", () => {
  for (const selection of readModel.batch.selected) {
    const coverage = coverageForProvision(readModel, selection.provision_id);
    assert.ok(coverage, `${selection.citation} resolves to a coverage row`);
    assert.equal(coverage.rank, selection.rank);
    assert.equal(coverage.retained_change_count, selection.inputs.retained_change_count);
    const changes = readModel.changes[selection.provision_id];
    assert.ok(Array.isArray(changes) && changes.length > 0, `${selection.citation} keeps its change records`);
    for (const change of changes) {
      assert.equal(change.target.provision_id, selection.provision_id);
      assert.equal(change.materialization_status, "unresolved");
      assert.ok(change.legal_instrument_id, "each retained change names its instrument");
      assert.ok(change.source.url, "each retained change keeps a source URL");
    }
  }
});

test("the committed read model is what the builder derives from the current corpus", () => {
  const { serialized } = buildBackfill();
  const committed = readFileSync(new URL("../site/data/code_history_backfill.json", import.meta.url), "utf8");
  assert.equal(
    serialized,
    committed,
    "run node tools/build_code_history_backfill.mjs after changing the ranking, batch, or corpus",
  );
  assert.equal(JSON.parse(serialized).fingerprint, readModel.fingerprint);
});
