import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  APPLY_NOW_LABEL,
  COMMUNITY_BOARD_PARTICIPATION_UNKNOWN,
  buildCommunityBoardParticipationLookup,
  communityBoardApplicationAvailability,
  communityBoardParticipationPaths,
  projectCommunityBoardParticipation,
  renderCommunityBoardParticipationSection,
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

test("Manhattan CB2 keeps its board-local participation facts and source vintage", () => {
  const projection = projectCommunityBoardParticipation({
    board_id: "manhattan-cb-02",
    bylaws,
    application_sources: sources.sources,
    as_of: "2026-08-27T00:00:00.000Z",
  });
  const committee = projection.participation.find((row) => row.participation_kind === "public_committee_membership");
  const fullBoard = projection.participation.find((row) => row.participation_kind === "full_board_membership");
  assert.equal(projection.governance.current_bylaw_version_id, "bylaw-version:manhattan-cb-02:current");
  assert.equal(committee.eligibility.value.non_board_members, true);
  assert.equal(committee.appointing_authority.status, COMMUNITY_BOARD_PARTICIPATION_UNKNOWN);
  assert.equal(committee.source.document_id, "cb2-manhattan-by-laws-page");
  assert.equal(committee.source.locator, "Article 7, Public Committee Members");
  assert.equal(fullBoard.appointing_authority.value, "Manhattan Borough President");
  assert.equal(fullBoard.application_status, "closed");
  assert.equal(fullBoard.application_cta, false);
  assert.equal(fullBoard.source.source_id, "participation-source:manhattan-bp:2026");
  assert.equal(projection.cross_board_inference, false);
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

test("Manhattan CB2 ways-to-participate keeps board-local verbs, closed applications, and source receipts", () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("publisher fetch is not allowed"); };
  try {
    const participation = projectCommunityBoardParticipation({
      board_id: "manhattan-cb-02",
      bylaws,
      application_sources: sources.sources,
      as_of: "2026-08-27T00:00:00.000Z",
    });
    const meeting = {
      relation: "hosts_meeting",
      status: "promoted",
      promoted: true,
      from: "community-board:manhattan-cb-02",
      to: "meeting:community_board:cb2-full-board",
      target_id: "meeting:community_board:cb2-full-board",
      target_name: "Manhattan CB2 Full Board",
      href: "/meetings/meeting%3Acommunity_board%3Acb2-full-board",
      date: "2026-09-10",
      provenance: { source_url: "https://cbmanhattan.cityofnewyork.us/cb2/calendar/" },
      source_receipt: { status: "ok", observed_at: "2026-08-27T00:00:00Z" },
    };
    const paths = communityBoardParticipationPaths({
      board_id: "manhattan-cb-02",
      board: {
        body_id: "manhattan-cb-02",
        homepage_url: "https://cbmanhattan.cityofnewyork.us/cb2/",
        directory_url: "https://www.nyc.gov/site/communityboards/about/manhattan-boards.page",
      },
      participation,
      meetings: [meeting],
      committees: [{ target_id: "community-board-committee:manhattan-cb-02:land-use", label: "Land Use" }],
      as_of: "2026-08-27T00:00:00.000Z",
    });
    const byKind = Object.fromEntries(paths.map((path) => [path.kind, path]));
    assert.equal(byKind.attend_meeting.verb, "Attend the next board meeting");
    assert.equal(byKind.attend_meeting.href, meeting.href);
    assert.equal(byKind.add_to_calendar.verb, "Add to calendar");
    assert.match(byKind.follow_board.href, /lens=meetings/);
    assert.match(byKind.follow_board.href, /manhattan-cb-02/);
    assert.equal(byKind.contact_board.href, "https://cbmanhattan.cityofnewyork.us/cb2/");
    assert.equal(byKind.apply_public_committee_membership.cta, false);
    assert.notEqual(byKind.apply_public_committee_membership.verb, APPLY_NOW_LABEL);
    assert.equal(byKind.apply_full_board_membership.cta, false);
    assert.equal(byKind.apply_full_board_membership.state, "closed");
    assert.equal(byKind.apply_full_board_membership.evidence.source_id, "participation-source:manhattan-bp:2026");
    assert.equal(byKind.apply_full_board_membership.evidence.document_id, "manhattan-bp-2026-community-board-applications-open");
    assert.equal(byKind.speak_or_comment, undefined);
    assert.equal(byKind.follow_committee, undefined);
    const html = renderCommunityBoardParticipationSection(paths);
    assert.match(html, /Ways to participate/);
    assert.match(html, /Attend the next board meeting/);
    assert.match(html, /Add to calendar/);
    assert.match(html, /Follow Manhattan Community Board 2/);
    assert.match(html, /Contact this board/);
    assert.match(html, /Public committee membership/);
    assert.match(html, /The published application window is closed/);
    assert.match(html, /participation-source:manhattan-bp:2026/);
    assert.match(html, /Article 7, Public Committee Members/);
    assert.doesNotMatch(html, /Apply now/);
    assert.doesNotMatch(html, /Follow this committee/);
    assert.doesNotMatch(html, /Speak or comment/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a board without equivalent evidence omits service and application opportunities", () => {
  const participation = projectCommunityBoardParticipation({
    board_id: "bronx-cb-02",
    bylaws,
    application_sources: [],
    as_of: "2026-08-27T00:00:00.000Z",
  });
  const paths = communityBoardParticipationPaths({
    board_id: "bronx-cb-02",
    board: {
      body_id: "bronx-cb-02",
      homepage_url: "https://www.nyc.gov/site/bronxcb2/index.page",
    },
    participation,
    meetings: [],
    as_of: "2026-08-27T00:00:00.000Z",
  });
  assert.deepEqual(paths.map((path) => path.kind), ["follow_board", "contact_board"]);
  assert.equal(paths.every((path) => path.cross_board_inference === false), true);
  const html = renderCommunityBoardParticipationSection(paths);
  assert.match(html, /Follow Bronx Community Board 2/);
  assert.match(html, /Contact this board/);
  assert.doesNotMatch(html, /Apply now/);
  assert.doesNotMatch(html, /Public committee membership/);
  assert.doesNotMatch(html, /Community Board membership/);
  assert.doesNotMatch(html, /Attend the next/);
  assert.doesNotMatch(html, /Speak or comment/);
  assert.doesNotMatch(html, /manhattan-cb-02|participation-source:manhattan-bp:2026/);
});

test("Manhattan CB6 can offer source-backed speaking without creating an application CTA", () => {
  const participation = projectCommunityBoardParticipation({
    board_id: "manhattan-cb-06",
    bylaws,
    as_of: "2026-08-27T00:00:00.000Z",
  });
  const paths = communityBoardParticipationPaths({
    board_id: "manhattan-cb-06",
    board: { homepage_url: "https://cbsix.org/" },
    participation,
    as_of: "2026-08-27T00:00:00.000Z",
  });
  const speak = paths.find((path) => path.kind === "speak_or_comment");
  assert.equal(speak.verb, "Speak or comment at a public session");
  assert.match(speak.evidence.locator, /Article VII/);
  assert.equal(paths.some((path) => path.cta && path.verb === APPLY_NOW_LABEL), false);
});

test("one board's application evidence cannot mint another board's Apply now path", () => {
  const manhattan = projectCommunityBoardParticipation({
    board_id: "manhattan-cb-02",
    bylaws,
    application_sources: sources.sources,
    as_of: "2026-08-27T00:00:00.000Z",
  });
  const queens = projectCommunityBoardParticipation({
    board_id: "queens-cb-06",
    bylaws,
    application_sources: sources.sources,
    as_of: "2026-08-27T00:00:00.000Z",
  });
  const manhattanApply = communityBoardParticipationPaths({
    board_id: "manhattan-cb-02",
    participation: manhattan,
    board: { homepage_url: "https://cbmanhattan.cityofnewyork.us/cb2/" },
  }).find((path) => path.kind === "apply_full_board_membership");
  const queensPaths = communityBoardParticipationPaths({
    board_id: "queens-cb-06",
    participation: queens,
    board: { homepage_url: "https://www.nyc.gov/site/queenscb6/index.page" },
  });
  assert.equal(manhattanApply.evidence.source_id, "participation-source:manhattan-bp:2026");
  const queensApply = queensPaths.find((path) => path.kind === "apply_full_board_membership");
  assert.equal(queensApply.evidence.source_id, "participation-source:queens-bp:2026");
  assert.notEqual(queensApply.evidence.source_id, manhattanApply.evidence.source_id);
  assert.equal(queensApply.cta, false);
  assert.equal(queensPaths.some((path) => path.verb === APPLY_NOW_LABEL), false);
  assert.equal(queensPaths.some((path) => path.evidence?.source_id === "participation-source:manhattan-bp:2026"), false);
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
