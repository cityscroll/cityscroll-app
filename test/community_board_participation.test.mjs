import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  COMMUNITY_BOARD_PARTICIPATION_UNKNOWN,
  buildCommunityBoardParticipationLookup,
  communityBoardApplicationAvailability,
  projectCommunityBoardParticipation,
} from "../site/community_board_participation.mjs";
import { buildCommunityBoardParticipationArtifacts } from "../tools/build_community_board_participation.mjs";

const bylaws = JSON.parse(readFileSync(new URL("../site/data/community_board_bylaws.json", import.meta.url), "utf8"));
const sources = JSON.parse(readFileSync(new URL("../site/data/community_board_participation_sources.json", import.meta.url), "utf8"));
const board = (boardId) => ({ body_id: boardId, body_type: "community_board" });

test("retained bylaw facts project with board, committee scope, authority, locator, and source vintage", () => {
  const projection = projectCommunityBoardParticipation({
    board_id: "manhattan-cb-06",
    bylaws,
    as_of: "2026-08-27T00:00:00.000Z",
  });
  const committee = projection.participation.find((row) => row.participation_kind === "public_committee_membership");
  assert.equal(committee.board_id, "manhattan-cb-06");
  assert.equal(committee.committee_id, null);
  assert.equal(committee.eligibility.status, "established");
  assert.equal(committee.appointing_authority.value.appointing_authority, "Board Chair");
  assert.equal(committee.appointing_authority.value.consultation, "committee chairs");
  assert.equal(committee.bylaw_version_id, "bylaw-version:manhattan-cb-06:2023-03-08");
  assert.equal(committee.source.document_id, "2023-03-13-Bylaws-March-2023-revision-FINAL-VERSION.pdf");
  assert.match(committee.source.locator, /Article VIII/);
  assert.equal(committee.source.observed_at, "2026-08-27T00:00:00Z");
  assert.equal(committee.source.effective_at, "2023-03-08");
  assert.equal(committee.cross_board_inference, false);
  assert.deepEqual(projection.governance.superseded_versions.map((row) => row.id), ["bylaw-version:manhattan-cb-06:2020"]);
});

test("current bylaw selection keeps superseded rules out of the current projection", () => {
  const projection = projectCommunityBoardParticipation({
    board_id: "manhattan-cb-06",
    bylaws,
    as_of: "2026-08-27T00:00:00.000Z",
  });
  const committee = projection.participation.find((row) => row.participation_kind === "public_committee_membership");
  assert.equal(committee.eligibility.value.maximum_fraction, "one-third");
  assert.equal(committee.eligibility.value.scope, undefined);
  assert.equal(committee.appointing_authority.value.appointing_authority, "Board Chair");
  assert.equal(projection.participation.some((row) => row.source?.bylaw_version_id === "bylaw-version:manhattan-cb-06:2020"), false);
});

test("application sources require explicit board scope and never leak to another board", () => {
  const projection = projectCommunityBoardParticipation({
    board_id: "queens-cb-06",
    bylaws,
    application_sources: [{
      ...sources.sources.find((source) => source.id === "participation-source:queens-cb-06:missing"),
      id: "participation-source:fixture:queens-cb-06",
      participation_kind: "full_board_membership",
      applies_to_board_ids: ["manhattan-cb-06"],
      source_url: "https://example.test/manhattan-application",
      application_status: "open",
      application_destination: "https://example.test/apply",
      observed_at: "2026-08-27T00:00:00Z",
    }],
    as_of: "2026-08-27T00:00:00.000Z",
  });
  const fullBoard = projection.participation.find((row) => row.participation_kind === "full_board_membership");
  assert.equal(fullBoard.application_status, "not_applicable");
  assert.equal(fullBoard.application_cta, false);
  assert.equal(fullBoard.eligibility.status, COMMUNITY_BOARD_PARTICIPATION_UNKNOWN);
});

test("closed and unknown application windows retain evidence but cannot create an Apply now CTA", () => {
  const closed = projectCommunityBoardParticipation({
    board_id: "manhattan-cb-06",
    bylaws,
    application_sources: sources.sources,
    as_of: "2026-08-27T00:00:00.000Z",
  }).participation.find((row) => row.participation_kind === "full_board_membership");
  assert.equal(closed.application_status, "closed");
  assert.equal(closed.application_availability.state, "closed");
  assert.equal(closed.application_cta, false);
  assert.equal(closed.application_destination, "https://bpbhs.com/cb");

  const unknown = projectCommunityBoardParticipation({
    board_id: "queens-cb-02",
    bylaws,
    application_sources: sources.sources,
    as_of: "2026-08-27T00:00:00.000Z",
  }).participation.find((row) => row.participation_kind === "public_committee_membership");
  assert.equal(unknown.application_status, "unknown");
  assert.equal(unknown.application_availability.state, "unknown");
  assert.equal(unknown.application_cta, false);
  assert.equal(unknown.application_destination, "https://forms.gle/RMhAwKYmjUXn1Vsh6");
});

test("stale open evidence is unknown, while a fresh open window is actionable", () => {
  const open = {
    id: "participation-source:fixture:open",
    participation_kind: "full_board_membership",
    applies_to_board_ids: ["bronx-cb-01"],
    eligibility: { value: "NYC resident", statement: "Fixture eligibility" },
    appointing_authority: { value: "Borough President", statement: "Fixture authority" },
    application_status: "open",
    application_open_at: "2026-08-01T00:00:00Z",
    application_close_at: "2026-09-01T00:00:00Z",
    application_destination: "https://example.test/apply",
    source_url: "https://example.test/source",
    document_id: "fixture-document",
    locator: "fixture application window",
    observed_at: "2026-08-20T00:00:00Z",
    receipt: { status: "ok", observed_at: "2026-08-20T00:00:00Z" },
  };
  assert.equal(communityBoardApplicationAvailability(open, { asOf: "2026-08-27T00:00:00Z" }).cta, true);
  assert.equal(communityBoardApplicationAvailability({ ...open, receipt: { status: "unknown" } }, { asOf: "2026-08-27T00:00:00Z" }).reason, "application_source_receipt_unknown");
  assert.equal(communityBoardApplicationAvailability({ ...open, observed_at: "2025-01-01T00:00:00Z" }, { asOf: "2026-08-27T00:00:00Z" }).reason, "application_source_stale");
  const staleProjection = projectCommunityBoardParticipation({ board_id: "bronx-cb-01", applications: [{ ...open, observed_at: "2025-01-01T00:00:00Z" }], as_of: "2026-08-27T00:00:00Z" });
  assert.equal(staleProjection.participation.find((row) => row.participation_kind === "full_board_membership").application_cta, false);
});

test("a board with no retained equivalent evidence stays explicit unknown", () => {
  const projection = projectCommunityBoardParticipation({
    board_id: "bronx-cb-02",
    bylaws,
    application_sources: [],
    as_of: "2026-08-27T00:00:00.000Z",
  });
  assert.equal(projection.governance.status, COMMUNITY_BOARD_PARTICIPATION_UNKNOWN);
  assert.deepEqual(projection.participation.map((row) => row.eligibility.status), [
    COMMUNITY_BOARD_PARTICIPATION_UNKNOWN,
    COMMUNITY_BOARD_PARTICIPATION_UNKNOWN,
    COMMUNITY_BOARD_PARTICIPATION_UNKNOWN,
  ]);
  assert.equal(projection.cross_board_inference, false);
});

test("lookup is a scheduled build artifact and does not perform resident-request source fetches", () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("publisher fetch is not allowed"); };
  try {
    const lookup = buildCommunityBoardParticipationLookup({
      boards: [board("manhattan-cb-06"), board("bronx-cb-02")],
      bylaws,
      application_sources: sources.sources,
      as_of: "2026-08-27T00:00:00.000Z",
    });
    assert.equal(lookup.board_count, 2);
    assert.equal(lookup.by_board["manhattan-cb-06"].participation.length, 3);
    assert.equal(lookup.by_board["bronx-cb-02"].governance.status, COMMUNITY_BOARD_PARTICIPATION_UNKNOWN);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("committed source and receipt artifacts are reproducible by the scheduled builder", () => {
  const artifacts = buildCommunityBoardParticipationArtifacts();
  const materialized = JSON.parse(readFileSync(new URL("../site/data/community_board_participation.json", import.meta.url), "utf8"));
  const receipt = JSON.parse(readFileSync(new URL("../warehouse/receipts/proof/community_board_participation_latest.json", import.meta.url), "utf8"));
  assert.deepEqual(artifacts.payload, materialized);
  assert.deepEqual(artifacts.receipt, receipt);
  assert.equal(receipt.measurement.scheduled_acquisition, true);
  assert.equal(receipt.measurement.resident_request_time_fetch, false);
  assert.equal(receipt.measurement.cross_board_inference, false);
});
