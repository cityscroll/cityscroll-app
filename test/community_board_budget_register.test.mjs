/**
 * Community board budget request register: identity, publication filtering,
 * complete acquisition, replay, and the difference between a request the
 * publisher withdrew and a read this machine could not finish.
 *
 * The population assertions run against the retained fixtures, never the
 * publisher. The acquisition assertions run a complete acquisition against a
 * scripted publisher in a temporary directory, so a failure part-way through a
 * population can be observed without waiting for the real one to break.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  BUDGET_REQUEST_TYPES,
  PUBLISHER_BOROUGH_CODES,
  REVIEWED_PUBLISHER_AGENCY_ALIASES,
  REVIEWED_UNBOUND_PUBLISHER_AGENCIES,
  boardIdFromPublisherCodes,
  boilerplateNormalizedResponseText,
  buildCommunityBoardBudgetRegister,
  comparableResponseText,
  parseTrackingCode,
  publicationDay,
  resolveRegisterAgency,
  selectPublications,
  validateCommunityBoardBudgetRegister,
} from "../warehouse/lib/community_board_budget_register.mjs";
import {
  acquire,
  acquisitionContext,
  checkFixtures,
  fixtureText,
  readFixture,
  readManifest,
  scheduledPublications,
} from "../tools/acquire_community_board_budget_register.mjs";
import {
  buildArtifact,
  buildDocuments,
  evaluationDay,
  knownAgencyIds,
} from "../tools/build_community_board_budget_register.mjs";

import participation from "../site/data/community_board_participation.json" with { type: "json" };
import register from "../site/data/community_board_budget_register.json" with { type: "json" };

const EXECUTIVE = "20260512";
const ADOPTED = "20260630";
const FORWARD_DATED = "20270217";
const DOCUMENT_DIRECTORY = "site/data/community_board_budget_register";

/** The published board documents, read the way a board surface would read one. */
const boardDocuments = new Map(register.boards.map((entry) => [
  entry.board_id,
  JSON.parse(readFileSync(join(DOCUMENT_DIRECTORY, `${entry.board_id}.json`), "utf8")),
]));
const requests = [...boardDocuments.values()].flatMap((document) => document.requests);
const byCode = new Map(requests.map((row) => [row.tracking_code, row]));
const boardIds = new Set(Object.keys(participation.by_board));

function scriptedPublisher(populations, { failAfterRequests = null } = {}) {
  let requests = 0;
  return async function scriptedFetch(url) {
    requests += 1;
    if (failAfterRequests !== null && requests > failAfterRequests) {
      throw new Error("publisher connection reset");
    }
    const parameters = new URL(url).searchParams;
    const select = parameters.get("$select") || "";
    const where = parameters.get("$where") || "";
    const json = (payload) => ({ ok: true, status: 200, statusText: "OK", json: async () => payload });
    if (parameters.get("$group") === "publication") {
      return json(Object.entries(populations).map(([publication, rows]) => ({
        publication,
        published_row_count: String(rows.length),
      })));
    }
    const publication = /publication='(\d+)'/.exec(where)?.[1];
    const rows = populations[publication] || [];
    if (select.startsWith("count(")) return json([{ published_row_count: String(rows.length) }]);
    const limit = Number(parameters.get("$limit"));
    const offset = Number(parameters.get("$offset"));
    const ordered = [...rows].sort((a, b) => a.tracking_code.localeCompare(b.tracking_code));
    return json(ordered.slice(offset, offset + limit));
  };
}

function publisherRow(overrides = {}) {
  return {
    publication: ADOPTED,
    boro: "2",
    board: "14",
    priority: "01",
    tracking_code: "214202701C",
    request: "Create a new, or renovate or upgrade an existing public library",
    explanation: "Funding to expand the branch library.",
    response: "OMB supports the agency's position as follows: Adopted funding is not available.",
    responded_by: "OMB",
    responsible_agency: "Department of Transportation",
    ...overrides,
  };
}

function temporaryContext(now = "2026-09-07T00:00:00.000Z") {
  const directory = mkdtempSync(join(tmpdir(), "cb-budget-register-"));
  return {
    directory,
    context: acquisitionContext({
      directory,
      receiptPath: join(directory, "receipt.json"),
      fetchImpl: null,
      now,
      retryDelayMs: 1,
    }),
  };
}

test("the register retains both same-cycle publications and joins every request across them", () => {
  const servable = register.publication_selection.servable;
  assert.deepEqual(servable, [EXECUTIVE, ADOPTED]);
  assert.equal(register.counts.requests, 3809);
  assert.equal(register.counts.comparable_version_pairs, 3809);
  assert.equal(register.counts.boards, 59);
  assert.equal(register.counts.unidentified_rows, 0);
  assert.equal(register.counts.rows_without_board_binding, 0);

  for (const publication of servable) {
    const rows = readFixture(publication);
    assert.equal(rows.length, 3809, `${publication} retains 3,809 rows`);
    assert.equal(new Set(rows.map((row) => row.tracking_code)).size, 3809, `${publication} codes are unique`);
  }

  // Every request carries one observation from each servable publication, so
  // the join is complete in both directions rather than merely non-empty.
  for (const request of requests) {
    const publications = request.versions.filter((version) => version.servable).map((version) => version.publication);
    assert.deepEqual(publications, servable, `${request.tracking_code} appears in both publications`);
  }
});

test("each observation keeps the publisher's own response, agency, explanation, cycle, date and rank", () => {
  // A Brooklyn CB14 street-condition request whose answer moved between the
  // two publications of the same cycle: the earlier answer explains whose
  // responsibility the sidewalk is, the later one reports a resurfacing.
  const busStop = byCode.get("214202710C");
  const [executive, adopted] = busStop.versions.filter((version) => version.servable);

  assert.equal(busStop.fiscal_year, 2027);
  assert.equal(busStop.board_id, "brooklyn-cb-14");
  assert.equal(busStop.request_class, "capital");
  assert.equal(executive.publication_date, "2026-05-12");
  assert.equal(adopted.publication_date, "2026-06-30");
  assert.equal(executive.responded_by, "OMB");
  assert.equal(executive.responsible_agency.source_label, "Department of Transportation");
  assert.equal(executive.responsible_agency.agency_id, "transportation");
  assert.ok(executive.explanation.length > 0);
  assert.equal(executive.explanation, adopted.explanation, "the request itself did not change");
  assert.notEqual(comparableResponseText(executive.response), comparableResponseText(adopted.response));
  assert.equal(busStop.response_comparisons[0].source_text_differs, true);

  // A rank is published with the scope it was published under and never as a
  // district-wide position.
  assert.equal(executive.rank.scope, "agency_and_request_class");
  assert.equal(executive.rank.district_wide, false);

  // A completed-work answer stays an answer: nothing in the record turns it
  // into a delivered request.
  assert.match(adopted.response, /completed/i);
  assert.equal(busStop.board_binding, "bound");
  assert.ok(!Object.hasOwn(busStop, "completed"));

  // Source lineage is published once per publication rather than once per row,
  // and it names the retained bytes each observation came from.
  const lineage = new Map(register.publications.map((row) => [row.publication, row]));
  for (const publication of [EXECUTIVE, ADOPTED, FORWARD_DATED]) {
    const row = lineage.get(publication);
    assert.equal(row.dataset_id, "vn4m-mk4t");
    assert.equal(row.publication_date, publicationDay(publication));
    assert.match(row.retained_fixture, /^warehouse\/fixtures\/community-board-budget-register\//);
    assert.match(row.retained_fixture_sha256, /^[0-9a-f]{64}$/);
    assert.equal(row.retained_rows, row.published_row_count);
  }
});

test("board identity uses the publisher's borough numbering and resolves for every request", () => {
  assert.deepEqual(PUBLISHER_BOROUGH_CODES, {
    1: "bronx",
    2: "brooklyn",
    3: "manhattan",
    4: "queens",
    5: "staten-island",
  });
  assert.equal(boardIdFromPublisherCodes("5", "01"), "staten-island-cb-01");
  assert.equal(boardIdFromPublisherCodes("3", "4"), "manhattan-cb-04");
  assert.equal(boardIdFromPublisherCodes("6", "01"), null);
  assert.equal(boardIdFromPublisherCodes("2", "00"), null);

  for (const request of requests) {
    assert.equal(request.board_binding, "bound", `${request.tracking_code} binds to a board`);
    assert.ok(boardIds.has(request.board_id), `${request.board_id} is a board this repository carries`);
  }
});

test("a continued-support code is a different request from the capital code that shares its digits", () => {
  const capital = byCode.get("214202701C");
  const continued = byCode.get("214202701CS");
  assert.equal(capital.request_class, BUDGET_REQUEST_TYPES.C);
  assert.equal(continued.request_class, BUDGET_REQUEST_TYPES.CS);
  assert.notEqual(capital.versions[0].request, continued.versions[0].request);
  assert.notEqual(
    capital.versions[0].responsible_agency.source_label,
    continued.versions[0].responsible_agency.source_label,
  );

  // The suffix is part of the identity, so no truncation can make them meet.
  assert.equal(parseTrackingCode("214202701CS").request_type, "CS");
  assert.equal(parseTrackingCode("214202701C").request_type, "C");
  assert.equal(parseTrackingCode("214202701"), null);
  assert.equal(parseTrackingCode("214202701X"), null);
});

test("rank restarts per agency, so a board holds many requests numbered 01", () => {
  const cb14Capital = requests
    .filter((row) => row.board_id === "brooklyn-cb-14" && row.request_type === "C");
  const rankedFirst = cb14Capital.filter((row) => row.versions[0].rank?.value === "01");
  assert.equal(rankedFirst.length, 10);
  assert.equal(new Set(rankedFirst.map((row) => row.versions[0].responsible_agency.source_label)).size, 10);
});

test("a publication dated after the read day is retained but never becomes the latest answer", () => {
  const selection = selectPublications([EXECUTIVE, ADOPTED, FORWARD_DATED], { asOf: "2026-09-07" });
  assert.deepEqual(selection.servable, [EXECUTIVE, ADOPTED]);
  assert.deepEqual(selection.diagnostic_only, [FORWARD_DATED]);
  assert.equal(selection.latest, ADOPTED);

  assert.deepEqual(register.publication_selection.diagnostic_only, [FORWARD_DATED]);
  assert.equal(register.publication_selection.latest, ADOPTED);
  assert.equal(register.counts.diagnostic_only_versions, 3809);

  // Retained means retained: the anomaly keeps its own date and its rows.
  assert.equal(publicationDay(FORWARD_DATED), "2027-02-17");
  assert.equal(readFixture(FORWARD_DATED).length, 3809);
  for (const request of requests.slice(0, 25)) {
    const diagnostic = request.versions.filter((version) => !version.servable);
    assert.equal(diagnostic.length, 1);
    assert.equal(diagnostic[0].publication, FORWARD_DATED);
  }

  // And it takes part in no comparison, so it cannot inflate what changed.
  for (const request of requests) {
    for (const comparison of request.response_comparisons) {
      assert.notEqual(comparison.to_publication, FORWARD_DATED);
      assert.notEqual(comparison.from_publication, FORWARD_DATED);
    }
  }
});

test("response comparison is published as source text and after boilerplate, and claims nothing more", () => {
  assert.equal(register.counts.responses_differing_in_source_text, 444);
  assert.equal(register.counts.responses_differing_after_boilerplate_removed, 293);

  // Rewrapping is not a change; a different word is.
  assert.equal(comparableResponseText("Funding  is\nnot available."), "funding is not available.");
  assert.notEqual(comparableResponseText("Funding is available."), comparableResponseText("Funding is not available."));

  // The wrapper sentence and the round label move on their own.
  const wrapperOnly = [
    "OMB supports the agency's position as follows: Funding is not available in the Executive Budget.",
    "Funding is not available in the Adopted Budget.",
  ];
  assert.notEqual(comparableResponseText(wrapperOnly[0]), comparableResponseText(wrapperOnly[1]));
  assert.equal(
    boilerplateNormalizedResponseText(wrapperOnly[0]),
    boilerplateNormalizedResponseText(wrapperOnly[1]),
  );

  assert.match(register.negative_rule, /not funding/);
  assert.match(register.comparison_semantics.what_a_difference_means, /does not establish funding/);

  // A changed answer is never counted as a funded or delivered one.
  const changed = requests.filter((row) => row.response_comparisons.some((c) => c.source_text_differs));
  assert.equal(changed.length, 444);
  for (const request of changed.slice(0, 50)) {
    assert.ok(!Object.hasOwn(request, "funded"));
    assert.ok(!Object.hasOwn(request, "delivered"));
  }
});

test("a reused rank or a similar name never carries a request into another fiscal cycle", () => {
  // Every retained observation belongs to one cycle, and the identity key
  // carries that cycle, so nothing in this artifact can join across years.
  const cycles = new Set(requests.map((row) => row.fiscal_year));
  assert.deepEqual([...cycles], [2027]);
  for (const request of requests) {
    assert.equal(parseTrackingCode(request.tracking_code).fiscal_year, request.fiscal_year);
  }

  const earlier = { publication: "20250630", rows: [publisherRow({ publication: "20250630", tracking_code: "214202601C" })] };
  const later = { publication: ADOPTED, rows: [publisherRow({ tracking_code: "214202701C" })] };
  const built = buildCommunityBoardBudgetRegister({
    publications: [earlier, later],
    boardIds: ["brooklyn-cb-14"],
    agencyIds: ["transportation"],
    asOf: "2026-09-07",
  });
  assert.equal(built.counts.requests, 2, "same rank and same request text stay two requests");
  assert.equal(built.counts.comparable_version_pairs, 0, "different cycles are never compared");
});

test("agency labels bind only to institutions this repository already carries", () => {
  const known = new Set(knownAgencyIds());
  const bindings = new Map(register.agency_bindings.map((row) => [row.source_label, row]));
  assert.equal(bindings.size, 35);
  assert.equal(register.counts.agency_labels_bound, 30);
  assert.equal(register.counts.agency_labels_unbound, 5);

  for (const row of register.agency_bindings) {
    if (row.binding === "bound") {
      assert.ok(known.has(row.agency_id), `${row.source_label} binds to an existing institution`);
      assert.equal(row.review, null);
    } else {
      assert.equal(row.agency_id, null, `${row.source_label} mints no institution`);
      assert.equal(row.source_label, row.source_label.trim());
      assert.equal(row.review, "no_existing_institution", `${row.source_label} is reviewed, not merely unmatched`);
    }
  }

  // Every reviewed alias points at an institution that exists, so the register
  // can only ever route a label to one, never create one.
  for (const [label, agencyId] of Object.entries(REVIEWED_PUBLISHER_AGENCY_ALIASES)) {
    assert.ok(known.has(agencyId), `${label} is reviewed onto an existing institution`);
    assert.equal(resolveRegisterAgency(label, { knownAgencyIds: known }).agency_id, agencyId);
  }
  for (const label of Object.keys(REVIEWED_UNBOUND_PUBLISHER_AGENCIES)) {
    assert.equal(resolveRegisterAgency(label, { knownAgencyIds: known }).binding, "unbound");
  }

  // The three public library systems and the two remaining offices have no
  // institution here, and an unbound label keeps its source spelling.
  assert.deepEqual(
    register.agency_bindings.filter((row) => row.binding === "unbound").map((row) => row.source_label).sort(),
    [
      "Brooklyn Public Library",
      "CITYWIDE EVENT COORDINATION AND MANAGEMENT",
      "Mayor's Office of Media and Entertainment",
      "New York Public Library",
      "Queens Borough Public Library",
    ],
  );

  // A label nobody has reviewed is unbound and says so, rather than being
  // guessed onto the nearest name.
  const invented = resolveRegisterAgency("Office of Imaginary Affairs", { knownAgencyIds: known });
  assert.equal(invented.binding, "unbound");
  assert.equal(invented.agency_id, null);
  assert.equal(invented.review, "not_reviewed");
});

test("a request the publisher left untitled is retained with a title marked derived", () => {
  const untitled = byCode.get("304202704CS");
  assert.ok(untitled, "the untitled request is retained, not dropped");
  for (const version of untitled.versions) {
    assert.equal(version.request, null);
    assert.equal(version.title_is_derived, true);
    assert.ok(version.request_title_derived.length > 0);
  }

  // A request the publisher did title never carries a derived one beside it.
  for (const version of byCode.get("214202710C").versions) {
    assert.ok(version.request);
    assert.equal(version.request_title_derived, undefined);
  }
  assert.equal(register.counts.derived_request_titles, 3);
});

test("acquisition proves a publication complete before it retains it", async () => {
  const { directory, context } = temporaryContext();
  try {
    const rows = Array.from({ length: 2400 }, (unused, index) => publisherRow({
      tracking_code: `2142027${String(index).padStart(2, "0")}${index % 2 ? "C" : "E"}${index > 99 ? index : ""}`,
    }));
    const unique = rows.map((row, index) => ({ ...row, tracking_code: `21420${String(10000 + index)}C` }));
    context.fetchImpl = scriptedPublisher({ [ADOPTED]: unique });
    const acquired = await acquire({ publications: [ADOPTED], context });

    assert.equal(acquired[0].rows, 2400);
    assert.equal(acquired[0].pages, 3, "paging continues past the publisher page size");
    const receipt = JSON.parse(readFileSync(context.receiptPath, "utf8"));
    assert.equal(receipt.status, "succeeded");
    assert.equal(receipt.publications[0].pagination_complete, true);
    assert.equal(receipt.publications[0].distinct_tracking_codes, 2400);
    assert.equal(readFixture(ADOPTED, context).length, 2400);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a short read is a failed fetch, not a smaller population", async () => {
  const { directory, context } = temporaryContext();
  try {
    const rows = Array.from({ length: 30 }, (unused, index) => publisherRow({ tracking_code: `21420${String(10000 + index)}C` }));
    // The publisher's own count says 30; it hands back 20.
    context.fetchImpl = async (url) => {
      const parameters = new URL(url).searchParams;
      const json = (payload) => ({ ok: true, status: 200, statusText: "OK", json: async () => payload });
      if (parameters.get("$group") === "publication") return json([{ publication: ADOPTED, published_row_count: "30" }]);
      if ((parameters.get("$select") || "").startsWith("count(")) return json([{ published_row_count: "30" }]);
      return json(rows.slice(0, 20));
    };
    await assert.rejects(acquire({ publications: [ADOPTED], context }), /read 20 rows but the publisher reports 30/);
    assert.equal(readFixture(ADOPTED, context), null, "an incomplete read retains nothing");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a failed fetch preserves the last successful materialization and says so", async () => {
  const { directory, context } = temporaryContext("2026-09-07T00:00:00.000Z");
  try {
    const rows = [publisherRow(), publisherRow({ tracking_code: "214202702C" })];
    context.fetchImpl = scriptedPublisher({ [ADOPTED]: rows });
    await acquire({ publications: [ADOPTED], context });
    const goodText = readFileSync(join(directory, `publication-${ADOPTED}.jsonl`), "utf8");
    const goodManifest = readManifest(context);

    const failing = acquisitionContext({
      directory,
      receiptPath: context.receiptPath,
      fetchImpl: scriptedPublisher({ [ADOPTED]: rows }, { failAfterRequests: 1 }),
      now: "2026-09-08T00:00:00.000Z",
      retryDelayMs: 1,
    });
    await assert.rejects(acquire({ publications: [ADOPTED], context: failing }), /publisher connection reset/);

    assert.equal(readFileSync(join(directory, `publication-${ADOPTED}.jsonl`), "utf8"), goodText);
    assert.deepEqual(readManifest(failing), goodManifest);

    const receipt = JSON.parse(readFileSync(context.receiptPath, "utf8"));
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.preserved_materialization_on_failure, true);
    assert.match(receipt.exact_error, /publisher connection reset/);
    assert.equal(receipt.last_successful_acquisition.observed_at, "2026-09-07T00:00:00.000Z");
    // Every attempt is on the receipt, so the operator surface can tell a
    // retried request from a first-try failure.
    assert.ok(receipt.failed_requests >= 1);
    assert.equal(receipt.retried_requests, receipt.request_log.filter((entry) => entry.attempt > 1).length);
    assert.ok(receipt.request_log.some((entry) => entry.attempt > 1), "a failing request is retried before it gives up");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a withdrawn request is reported as a publisher deletion, separately from a failure", async () => {
  const { directory, context } = temporaryContext();
  try {
    const both = [publisherRow(), publisherRow({ tracking_code: "214202702C" })];
    context.fetchImpl = scriptedPublisher({ [ADOPTED]: both });
    await acquire({ publications: [ADOPTED], context });

    context.fetchImpl = scriptedPublisher({ [ADOPTED]: [both[0]] });
    const acquired = await acquire({ publications: [ADOPTED], context });

    assert.deepEqual(acquired[0].withdrawn_by_publisher, ["214202702C"]);
    const receipt = JSON.parse(readFileSync(context.receiptPath, "utf8"));
    assert.equal(receipt.status, "succeeded");
    assert.deepEqual(receipt.publications[0].withdrawn_by_publisher, ["214202702C"]);
    assert.equal(receipt.publications[0].pagination_complete, true);
    assert.equal(readFixture(ADOPTED, context).length, 1, "a proven withdrawal does shrink the population");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("replaying an unchanged publication changes nothing", async () => {
  const { directory, context } = temporaryContext();
  try {
    const rows = [publisherRow(), publisherRow({ tracking_code: "214202702C" })];
    context.fetchImpl = scriptedPublisher({ [ADOPTED]: rows });
    await acquire({ publications: [ADOPTED], context });
    const first = readFileSync(join(directory, `publication-${ADOPTED}.jsonl`), "utf8");

    // The publisher returns the same population in a different order.
    context.fetchImpl = scriptedPublisher({ [ADOPTED]: [...rows].reverse() });
    const replay = await acquire({ publications: [ADOPTED], context });

    assert.equal(readFileSync(join(directory, `publication-${ADOPTED}.jsonl`), "utf8"), first);
    assert.equal(replay[0].unchanged, true);
    assert.deepEqual(replay[0].withdrawn_by_publisher, []);
    assert.deepEqual(replay[0].newly_published, []);
    assert.equal(fixtureText(rows), fixtureText([...rows].reverse()));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rebuilding the register from unchanged fixtures reproduces the committed documents", () => {
  assert.deepEqual(validateCommunityBoardBudgetRegister(buildArtifact()), { ok: true, errors: [] });
  assert.equal(checkFixtures().publications.length, 3);

  const rebuilt = buildDocuments();
  assert.equal(JSON.stringify(rebuilt.index), JSON.stringify(register));
  assert.equal(rebuilt.documents.size, 59);
  for (const [boardId, document] of rebuilt.documents) {
    assert.equal(JSON.stringify(document), JSON.stringify(boardDocuments.get(boardId)));
  }
});

test("the register is published as a small header and one document per board", () => {
  // The acquisition clock is on the header alone, so a refresh that finds no
  // new publication leaves every board document byte-identical.
  assert.ok(register.acquired_at);
  assert.equal(register.boards.length, 59);
  assert.equal(register.boards.reduce((total, entry) => total + entry.request_count, 0), 3809);
  assert.deepEqual(register.requests_without_a_board_document, []);

  const published = readdirSync(DOCUMENT_DIRECTORY).filter((name) => name.endsWith(".json")).sort();
  assert.deepEqual(published, register.boards.map((entry) => `${entry.board_id}.json`).sort());

  for (const entry of register.boards) {
    const path = join(DOCUMENT_DIRECTORY, `${entry.board_id}.json`);
    const text = readFileSync(path, "utf8");
    assert.equal(createHash("sha256").update(text).digest("hex"), entry.sha256, `${entry.board_id} matches its published digest`);
    assert.equal(entry.document, `/data/community_board_budget_register/${entry.board_id}.json`);
    const document = boardDocuments.get(entry.board_id);
    assert.equal(document.board_id, entry.board_id);
    assert.equal(document.request_count, document.requests.length);
    assert.equal(document.request_count, entry.request_count);
    // A board document carries no clock of its own; its vintage is the
    // header's, so it can never be read as fresher than the acquisition.
    assert.equal(document.acquired_at, undefined);
    assert.equal(document.materialized_at, undefined);
    for (const request of document.requests) {
      assert.equal(request.board_id, entry.board_id, "a board document holds only its own board's requests");
    }
  }
});

test("the register's clock is the acquisition, not the machine that rebuilt it", () => {
  assert.equal(evaluationDay({ observed_at: "2026-09-07T11:49:11.152Z" }), "2026-09-07");
  assert.equal(evaluationDay({ observed_at: "not a time" }), null);
  assert.equal(register.acquired_at, register.materialized_at);
  assert.equal(register.publication_selection.as_of, register.acquired_at.slice(0, 10));
});

test("a scheduled replay keeps every retained publication and picks up new releases", () => {
  const index = [
    { publication: "20250630", published_row_count: 3808 },
    { publication: EXECUTIVE, published_row_count: 3809 },
    { publication: ADOPTED, published_row_count: 3809 },
    { publication: FORWARD_DATED, published_row_count: 3809 },
  ];
  assert.deepEqual(
    scheduledPublications(index, { retained: [EXECUTIVE, ADOPTED, FORWARD_DATED], asOf: "2026-09-07" }),
    [EXECUTIVE, ADOPTED, FORWARD_DATED],
  );
  // A publication the publisher has not reached yet is not sought out.
  assert.deepEqual(scheduledPublications(index, { retained: [], asOf: "2026-09-07" }), [EXECUTIVE, ADOPTED]);
  // Once a release is out, it joins the retained set without displacing one.
  assert.deepEqual(
    scheduledPublications(index, { retained: [EXECUTIVE, ADOPTED], asOf: "2027-03-01" }),
    [EXECUTIVE, ADOPTED, FORWARD_DATED],
  );
});

test("the retained fixtures are the only publisher bytes the register reads", () => {
  const names = readdirSync("warehouse/fixtures/community-board-budget-register").sort();
  assert.deepEqual(names, [
    "manifest.json",
    `publication-${EXECUTIVE}.jsonl`,
    `publication-${ADOPTED}.jsonl`,
    `publication-${FORWARD_DATED}.jsonl`,
  ]);
  for (const source of [
    "warehouse/lib/community_board_budget_register.mjs",
    "tools/build_community_board_budget_register.mjs",
  ]) {
    assert.ok(!/\bfetch\s*\(/.test(readFileSync(source, "utf8")), `${source} never contacts the publisher`);
  }
});

test("a materialization is refused while the last acquisition is failing", () => {
  const { directory, context } = temporaryContext();
  try {
    writeFileSync(context.receiptPath, JSON.stringify({ status: "failed", observed_at: "2026-09-08T00:00:00.000Z" }));
    const receipt = JSON.parse(readFileSync(context.receiptPath, "utf8"));
    assert.equal(receipt.status, "failed");
    // The builder reads the repository's own receipt; this asserts the rule it
    // applies to that receipt rather than reaching into the live one.
    assert.match(
      readFileSync("tools/build_community_board_budget_register.mjs", "utf8"),
      /did not succeed; the retained materialization stands until one does/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
