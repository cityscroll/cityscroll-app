import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildCommunityBoardCommitteesFromCaptures,
  pageEvidencesCommittee,
} from "../site/community_board_committees_refresh.mjs";

const prior = {
  schema: "cityscroll.community_board_committee_registry.v1",
  version: 1,
  observed_on: "2026-08-25",
  policy: {
    identity: "community-board-committee:{board_id}:{committee_id}",
    board_local: true,
    publisher_name_and_aliases_are_exact: true,
    topic_facets_are_for_discovery_only: true,
    no_citywide_committee_identity: true,
  },
  committees: [
    {
      board_id: "manhattan-cb-06",
      committee_id: "transportation",
      publisher_name: "Transportation Committee",
      aliases: ["Transportation Committee Meeting"],
      source_url: "https://cbsix.org/meetings-calendar/",
      observed_on: "2026-08-25",
      topic_facets: ["transportation"],
    },
    {
      board_id: "brooklyn-cb-01",
      committee_id: "transportation",
      publisher_name: "Transportation Committee",
      aliases: ["Transportation Committee Meeting"],
      source_url: "https://www.nyc.gov/site/brooklyncb1/calendar/calendar.page",
      observed_on: "2026-08-25",
      topic_facets: ["transportation"],
    },
  ],
};

test("committee evidence accepts the short directory title or reviewed alias", () => {
  assert.equal(
    pageEvidencesCommittee("<h2>Transportation</h2>", prior.committees[0]),
    true,
  );
  assert.equal(
    pageEvidencesCommittee("<p>Transportation Committee Meeting</p>", prior.committees[0]),
    true,
  );
  assert.equal(
    pageEvidencesCommittee("<p>Budget and Finance</p>", prior.committees[0]),
    false,
  );
  assert.equal(
    pageEvidencesCommittee(`${"x".repeat(5_000)}<h2>Transportation</h2>`, prior.committees[0]),
    true,
  );
});

test("committee refresh restamps reviewed rows when directory pages still evidence them", () => {
  const artifact = buildCommunityBoardCommitteesFromCaptures({
    priorRegistry: prior,
    capturesByBoard: {
      "manhattan-cb-06": "<h2>Transportation</h2>",
      "brooklyn-cb-01": "<p>Transportation (Street Reconstruction)</p>",
    },
    observedAt: "2026-10-09T12:00:00.000Z",
  });
  assert.equal(artifact.observed_on, "2026-10-09");
  assert.equal(artifact.committees.length, 2);
  assert.equal(artifact.committees[0].publisher_name, "Transportation Committee");
  assert.equal(artifact.committees[0].source_url, "https://cbsix.org/committees/");
  assert.equal(
    artifact.committees[1].source_url,
    "https://www.nyc.gov/site/brooklyncb1/committees/committees.page",
  );
  assert.ok(artifact.committees.every((row) => row.observed_on === "2026-10-09"));
});

test("committee refresh fails closed when a reviewed row loses page evidence", () => {
  assert.throws(
    () => buildCommunityBoardCommitteesFromCaptures({
      priorRegistry: prior,
      capturesByBoard: {
        "manhattan-cb-06": "<h2>Transportation</h2>",
        "brooklyn-cb-01": "<p>Parks and Recreation</p>",
      },
      observedAt: "2026-10-09T12:00:00.000Z",
    }),
    /brooklyn-cb-01:transportation/,
  );
});
