import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  BOARD_ACQUISITION_DEPLOYED_PARITY_SCHEMA,
  DEPLOYED_PARITY_BOARDS,
  DEPLOYED_PARITY_RECOVERY_BASES,
  boardIdentitiesDigest,
  buildBoardAcquisitionDeployedParityObservation,
  deriveBoardSourceResult,
  deriveDeployedParityStatus,
  evidenceBindingDigest,
  validateBoardAcquisitionDeployedParityObservation,
} from "../tools/board_acquisition_deployed_parity.mjs";

const COMMIT = "6d31540f160459c22933cf85f8419a8b1275aa3f";
const OTHER_COMMIT = "b150a8489485c08d75566536b380ce3f9af7a483";
const OBSERVED_AT = "2026-10-14T12:00:00.000Z";
const RUN_ID = "0f0e0d0c-1111-4222-8333-444455556666";

const TRACKED_BOARDS = {
  "bronx-cb-06": { board_name: "Bronx Community Board 6", state: "indexed", record_count: 13, source_url: "https://cbbronx.cityofnewyork.us/cb6/calendar/", observed_at: "2026-09-30T12:59:02.901Z" },
  "bronx-cb-08": { board_name: "Bronx Community Board 8", state: "indexed", record_count: 8, source_url: "https://cbbronx.cityofnewyork.us/cb8/events/list/", observed_at: "2026-09-30T12:59:02.901Z" },
  "manhattan-cb-02": { board_name: "Manhattan Community Board 2", state: "indexed", record_count: 10, source_url: "https://cbmanhattan.cityofnewyork.us/cb2/calendar/", observed_at: "2026-09-30T12:59:02.901Z" },
  "manhattan-cb-04": { board_name: "Manhattan Community Board 4", state: "indexed", record_count: 13, source_url: "https://cbmanhattan.cityofnewyork.us/cb4/calendar/", observed_at: "2026-09-30T12:59:02.901Z" },
  "manhattan-cb-10": { board_name: "Manhattan Community Board 10", state: "indexed", record_count: 21, source_url: "https://cbmanhattan.cityofnewyork.us/cb10/events/", observed_at: "2026-09-30T12:59:02.901Z" },
  "manhattan-cb-11": { board_name: "Manhattan Community Board 11", state: "indexed", record_count: 125, source_url: "https://www.cb11m.org/calendar/", observed_at: "2026-09-30T12:59:02.901Z" },
  "manhattan-cb-12": { board_name: "Manhattan Community Board 12", state: "indexed", record_count: 30, source_url: "https://cb12m.org/en/calendar", observed_at: "2026-09-30T12:59:02.901Z" },
};

function boardRow(boardId, index = 1, overrides = {}) {
  const url = `${TRACKED_BOARDS[boardId].source_url}event/sample-${index}/`;
  return {
    meeting_id: `meeting:community_board:${url}`,
    event_date: `2026-11-0${(index % 9) + 1}T18:30:00-04:00`,
    title: `Community Board ${index} full board meeting`,
    board_id: boardId,
    board_name: TRACKED_BOARDS[boardId].board_name,
    source_record: {
      source_system: "community_board",
      board_id: boardId,
      role: "upcoming_meetings",
      receipt: {
        schema: "cityscroll.community_board_source_receipt.v1",
        source_url: TRACKED_BOARDS[boardId].source_url,
        observed_at: TRACKED_BOARDS[boardId].observed_at,
        status: "ok",
        fetch_status: "200",
        parser: "html_pdf_v1",
        content_sha256: "a".repeat(64),
      },
    },
    ...overrides,
  };
}

function browseFor(boardId, { rowCount } = {}) {
  const count = rowCount ?? TRACKED_BOARDS[boardId].record_count;
  const rows = Array.from({ length: count }, (_, index) => boardRow(boardId, index + 1));
  return {
    pages: [{
      availability: count > 0 ? "complete" : "empty",
      rows,
      total_matches: count,
      response_status: 200,
    }],
    truncated: false,
    communityBoardSourceStatus: "stale",
    communityBoardGeneratedAt: "2026-09-30T12:59:02.901Z",
  };
}

function buildObservation(browses = {}, overrides = {}) {
  const boardBrowses = {};
  for (const boardId of DEPLOYED_PARITY_BOARDS) {
    boardBrowses[boardId] = browses[boardId] === undefined ? browseFor(boardId) : browses[boardId];
  }
  return buildBoardAcquisitionDeployedParityObservation({
    health: { response_status: 200, commit: COMMIT, environment: "production" },
    boardBrowses,
    trackedIndex: {
      generated_at: "2026-09-30T12:59:02.901Z",
      code_revision: "c9381ab637d8970e8653a0e7616d76f5faa45653",
      boards: TRACKED_BOARDS,
    },
    observedAt: OBSERVED_AT,
    runId: RUN_ID,
    originMainTip: COMMIT,
    commitIsAncestorOfOriginMain: true,
    ...overrides,
  });
}

function refute(observation, expectedError) {
  const verdict = validateBoardAcquisitionDeployedParityObservation(observation);
  assert.equal(verdict.valid, false, `expected refusal, got errors: ${verdict.errors.join(",")}`);
  if (expectedError) assert.ok(
    verdict.errors.includes(expectedError),
    `expected error ${expectedError} in [${verdict.errors.join(", ")}]`,
  );
  return verdict;
}

test("schema id is the declared one and boards match the acquisition invariant list", () => {
  assert.equal(BOARD_ACQUISITION_DEPLOYED_PARITY_SCHEMA, "cityscroll.board_acquisition_deployed_parity.v1");
  assert.equal(DEPLOYED_PARITY_BOARDS.length, 7);
  // The contract module restates the acquisition builder's frozen board list
  // (that builder's import graph loads materialized data a reduced checkout
  // may not hold, so it cannot be imported here). Lock the two lists together
  // by reading the builder's own source text.
  const builderSource = readFileSync(
    new URL("../tools/build_community_board_meeting_index.mjs", import.meta.url),
    "utf8",
  );
  const match = builderSource.match(
    /BOARD_MEETING_ACQUISITION_PRESENCE_POPULATION_BOARDS = Object\.freeze\(\[([\s\S]*?)\]\)/,
  );
  assert.ok(match, "acquisition builder must still declare its frozen board list");
  const builderBoards = [...match[1].matchAll(/"([a-z]+-cb-\d+)"/g)].map((entry) => entry[1]);
  assert.deepEqual([...DEPLOYED_PARITY_BOARDS], builderBoards);
});

test("seven-of-seven deployed observation validates and derives every status", () => {
  const observation = buildObservation();
  const verdict = validateBoardAcquisitionDeployedParityObservation(observation);
  assert.deepEqual(verdict, { valid: true, errors: [] });
  assert.equal(observation.status, "all_sources_recovered");
  assert.deepEqual(observation.counts, { sources_attempted: 7, sources_observed: 7, sources_recovered: 7 });
  for (const source of observation.sources) {
    assert.equal(source.recovered, true);
    assert.equal(source.recovery_basis, "record_identity_binding");
    assert.equal(source.count_parity, "exact");
    assert.ok(source.record_binding.identities.length >= 1);
  }
  // Survives a JSON round trip: committed evidence re-validates offline.
  const roundTrip = JSON.parse(JSON.stringify(observation));
  assert.deepEqual(
    validateBoardAcquisitionDeployedParityObservation(roundTrip),
    { valid: true, errors: [] },
  );
});

test("a source that carries only status and count is refused", () => {
  const observation = buildObservation();
  for (const boardId of ["bronx-cb-06", "manhattan-cb-11"]) {
    const stripped = JSON.parse(JSON.stringify(observation));
    const source = stripped.sources.find((entry) => entry.board_id === boardId);
    // Status plus count only: keep recovered/counts, drop the record binding.
    delete source.record_binding;
    refute(stripped, `${boardId}:record_binding`);

    const emptyBinding = JSON.parse(JSON.stringify(observation));
    const emptySource = emptyBinding.sources.find((entry) => entry.board_id === boardId);
    emptySource.record_binding.identities = [];
    emptySource.record_binding.identities_count = 0;
    emptySource.record_binding.examined_row_count = 0;
    emptySource.record_binding.rows_bound_to_board = 0;
    refute(emptyBinding, `${boardId}:record_binding_empty`);
  }
});

test("a digest that does not cover the embedded identities is refused", () => {
  const observation = buildObservation();
  const tampered = JSON.parse(JSON.stringify(observation));
  const source = tampered.sources[0];
  source.record_binding.identities[0].title = "A different, plausible-looking title";
  // Leave the recorded digest untouched: it no longer covers the content.
  refute(tampered, `${source.board_id}:identities_sha256_mismatch`);

  const swappedDigest = JSON.parse(JSON.stringify(observation));
  const swapSource = swappedDigest.sources[0];
  swapSource.record_binding.identities_sha256 = "b".repeat(64);
  refute(swappedDigest, `${swapSource.board_id}:identities_sha256_mismatch`);
});

test("a usable-looking but wrong body fails the per-source derivation", () => {
  // Another board's rows served under this board's browse.
  const wrongBoard = deriveBoardSourceResult({
    boardId: "bronx-cb-06",
    browse: {
      pages: [{
        availability: "complete",
        rows: [boardRow("manhattan-cb-02", 1), boardRow("manhattan-cb-02", 2)],
        total_matches: 2,
        response_status: 200,
      }],
      truncated: false,
    },
    tracked: TRACKED_BOARDS["bronx-cb-06"],
  });
  assert.equal(wrongBoard.recovered, false);
  assert.equal(wrongBoard.recovery_basis, "board_binding_failed");

  // Right board, but acquired from an unregistered URL.
  const row = boardRow("bronx-cb-06", 1);
  row.source_record.receipt.source_url = "https://example.invalid/calendar";
  const wrongUrl = deriveBoardSourceResult({
    boardId: "bronx-cb-06",
    browse: { pages: [{ availability: "complete", rows: [row], total_matches: 1, response_status: 200 }], truncated: false },
    tracked: TRACKED_BOARDS["bronx-cb-06"],
  });
  assert.equal(wrongUrl.recovered, false);
  assert.equal(wrongUrl.recovery_basis, "registered_source_url_mismatch");

  // Well-formed but record-free.
  const empty = deriveBoardSourceResult({
    boardId: "bronx-cb-06",
    browse: browseFor("bronx-cb-06", { rowCount: 0 }),
    tracked: TRACKED_BOARDS["bronx-cb-06"],
  });
  assert.equal(empty.recovered, false);
  assert.equal(empty.recovery_basis, "no_records_served");

  // Deployed browse answered unavailable.
  const unavailable = deriveBoardSourceResult({
    boardId: "bronx-cb-06",
    browse: { pages: [{ availability: "unavailable", rows: [], total_matches: 0, response_status: 200 }], truncated: false },
    tracked: TRACKED_BOARDS["bronx-cb-06"],
  });
  assert.equal(unavailable.recovered, false);
  assert.equal(unavailable.recovery_basis, "browse_unavailable");

  // No usable browse response at all.
  const unread = deriveBoardSourceResult({
    boardId: "bronx-cb-06",
    browse: { pages: [], truncated: false },
    tracked: TRACKED_BOARDS["bronx-cb-06"],
  });
  assert.equal(unread.recovered, false);
  assert.equal(unread.recovery_basis, "not_observed");

  for (const result of [wrongBoard, wrongUrl, empty, unavailable, unread]) {
    assert.ok(DEPLOYED_PARITY_RECOVERY_BASES.includes(result.recovery_basis));
  }
});

test("provenance marked replay, rehearsal, or isolated is refused", () => {
  for (const kind of ["replay", "rehearsal", "isolated"]) {
    const observation = buildObservation();
    observation.provenance.kind = kind;
    refute(observation, "provenance.kind:not_deployed");
  }
  const intercepted = buildObservation();
  intercepted.provenance.transport = "loopback";
  refute(intercepted, "provenance.transport");
  const overridden = buildObservation();
  overridden.provenance.fetch_overridden = true;
  refute(overridden, "provenance.fetch_overridden");
});

test("a deployment commit not proven an ancestor of origin/main is refused", () => {
  const unproven = buildObservation();
  unproven.deployment.commit_is_ancestor_of_origin_main = false;
  refute(unproven, "deployment.commit_is_ancestor_of_origin_main");

  const noTip = buildObservation();
  noTip.deployment.origin_main_tip_at_capture = null;
  refute(noTip, "deployment.origin_main_tip_at_capture");

  const shortCommit = buildObservation();
  shortCommit.deployment.commit = "6d31540";
  refute(shortCommit, "deployment.commit");
});

test("counted zeros carry their denominator: six-of-seven, seven-of-seven, and an unread source are distinguishable", () => {
  const full = buildObservation();
  const sixOfSeven = buildObservation({
    "bronx-cb-08": browseFor("bronx-cb-08", { rowCount: 0 }),
  });
  const unread = buildObservation({
    "manhattan-cb-11": { pages: [], truncated: false, communityBoardSourceStatus: null, communityBoardGeneratedAt: null },
  });

  for (const observation of [full, sixOfSeven, unread]) {
    assert.equal(
      validateBoardAcquisitionDeployedParityObservation(observation).valid,
      true,
      `${observation.status} must be an honest, valid observation`,
    );
  }
  assert.equal(full.status, "all_sources_recovered");
  assert.deepEqual(full.counts, { sources_attempted: 7, sources_observed: 7, sources_recovered: 7 });
  assert.equal(sixOfSeven.status, "partial_recovery");
  assert.deepEqual(sixOfSeven.counts, { sources_attempted: 7, sources_observed: 7, sources_recovered: 6 });
  assert.equal(unread.status, "observation_incomplete");
  assert.deepEqual(unread.counts, { sources_attempted: 7, sources_observed: 6, sources_recovered: 6 });
  assert.equal(new Set([full.status, sixOfSeven.status, unread.status]).size, 3);

  // The honest denominators cannot be inflated after the fact.
  const inflated = JSON.parse(JSON.stringify(sixOfSeven));
  inflated.counts.sources_recovered = 7;
  refute(inflated, "counts.sources_recovered_mismatch");

  const inflatedStatus = JSON.parse(JSON.stringify(sixOfSeven));
  inflatedStatus.status = "all_sources_recovered";
  refute(inflatedStatus, "status_not_derived");
});

test("tampering positive control for every protected field", () => {
  const base = () => JSON.parse(JSON.stringify(buildObservation()));

  const staleTimestamp = base();
  staleTimestamp.observed_at = "2026-10-13T09:00:00.000Z";
  refute(staleTimestamp, "evidence_binding.digest_mismatch");

  const reusedRun = base();
  reusedRun.provenance.run_id = "99999999-9999-4999-8999-999999999999";
  refute(reusedRun, "evidence_binding.digest_mismatch");

  const reCommit = base();
  reCommit.deployment.commit = OTHER_COMMIT;
  reCommit.deployment.commit_shape_valid = true;
  refute(reCommit, "evidence_binding.digest_mismatch");

  const flipRecovered = base();
  const flipSource = flipRecovered.sources.find((entry) => entry.board_id === "manhattan-cb-04");
  flipSource.recovered = false;
  flipSource.recovery_basis = "no_records_served";
  flipRecovered.counts.sources_recovered = 6;
  flipRecovered.status = deriveDeployedParityStatus(flipRecovered.counts);
  flipRecovered.evidence_binding.digest = evidenceBindingDigest({
    schema: flipRecovered.schema,
    observedAt: flipRecovered.observed_at,
    runId: flipRecovered.provenance.run_id,
    commit: flipRecovered.deployment.commit,
    sources: flipRecovered.sources,
  });
  // Every derived field was made consistent — but a basis asserting no
  // records were served cannot coexist with the thirteen served identities
  // this source still embeds.
  const flipVerdict = validateBoardAcquisitionDeployedParityObservation(flipRecovered);
  assert.equal(flipVerdict.valid, false);
  assert.ok(flipVerdict.errors.includes("manhattan-cb-04:basis_record_contradiction"));

  const forgedStatus = base();
  forgedStatus.status = "partial_recovery";
  refute(forgedStatus, "status_not_derived");

  const forgedObserved = base();
  forgedObserved.counts.sources_observed = 6;
  refute(forgedObserved, "counts.sources_observed_mismatch");

  const forgedDigest = base();
  forgedDigest.evidence_binding.digest = "c".repeat(64);
  refute(forgedDigest, "evidence_binding.digest_mismatch");

  const swappedUrl = base();
  const urlSource = swappedUrl.sources.find((entry) => entry.board_id === "bronx-cb-06");
  urlSource.served_source_url = "https://cbbronx.cityofnewyork.us/cb6/other/";
  refute(swappedUrl, "bronx-cb-06:source_url_disagreement");

  const lostEvidenceClass = base();
  lostEvidenceClass.evidence_class = "cloudflare_os_deployed";
  refute(lostEvidenceClass, "evidence_class");
});

test("digest helpers bind the whole run, so evidence cannot be reused across runs", () => {
  const first = buildObservation();
  const second = buildObservation(undefined, { observedAt: "2026-10-15T12:00:00.000Z", runId: "11111111-2222-4333-8444-555566667777" });
  assert.notEqual(first.evidence_binding.digest, second.evidence_binding.digest);
  // A reused first-run payload under the second run's identity is refused.
  const reused = JSON.parse(JSON.stringify(first));
  reused.provenance.run_id = second.provenance.run_id;
  refute(reused, "evidence_binding.digest_mismatch");
});

test("the capture tool keeps a real-transport boundary: no fetch override, no fixtures, no local handlers", () => {
  const source = readFileSync(new URL("../tools/capture_board_acquisition_deployed_parity.mjs", import.meta.url), "utf8");
  assert.equal(/fetchImpl|fetch_impl/i.test(source), false, "capture tool must not accept a fetch implementation");
  assert.equal(/fixtures?\//i.test(source), false, "capture tool must not read fixtures");
  assert.equal(/handleMcp|worker\/src\//.test(source), false, "capture tool must not import Worker handlers");
  assert.ok(/await fetch\(/.test(source), "capture tool must use the global fetch");
});

test("committed deployed parity observation re-validates offline", () => {
  const path = new URL("../docs/evidence/board-acquisition/deployed-parity-readback.json", import.meta.url);
  const committed = JSON.parse(readFileSync(path, "utf8"));
  const verdict = validateBoardAcquisitionDeployedParityObservation(committed);
  assert.deepEqual(verdict, { valid: true, errors: [] });
  assert.equal(committed.schema, BOARD_ACQUISITION_DEPLOYED_PARITY_SCHEMA);
  // The helpers the validator recomputes with must agree with the file's own digests.
  for (const source of committed.sources) {
    assert.equal(boardIdentitiesDigest(source.record_binding.identities), source.record_binding.identities_sha256);
  }
  assert.equal(
    evidenceBindingDigest({
      schema: committed.schema,
      observedAt: committed.observed_at,
      runId: committed.provenance.run_id,
      commit: committed.deployment.commit,
      sources: committed.sources,
    }),
    committed.evidence_binding.digest,
  );
});
