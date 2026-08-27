import assert from "node:assert/strict";
import test from "node:test";

import {
  projectCommunityBoardProceedingHost,
  projectCommunityBoardProceedingHosts,
} from "../site/community_board_proceeding_hosts.mjs";

const committeeEdge = {
  relation: "hosts_meeting",
  status: "promoted",
  promoted: true,
  from: "community-board-committee:manhattan-cb-06:transportation",
  to: "meeting:community_board:cb6-transport",
  target_kind: "meeting",
  target_name: "Transportation Committee Meeting",
  committee_name: "Transportation Committee",
  parent_board_ref: "community-board:manhattan-cb-06",
  institution_refs: {
    board_ref: "community-board:manhattan-cb-06",
    committee_ref: "community-board-committee:manhattan-cb-06:transportation",
  },
  provenance: {
    source_url: "https://cbsix.org/meetings-calendar/",
    observed_receipt: { status: "ok", observed_at: "2026-08-25T12:00:00Z" },
  },
};

test("committee host projection keeps the parent board and proceeding form orthogonal", () => {
  const host = projectCommunityBoardProceedingHost(committeeEdge, {
    meeting_id: committeeEdge.to,
    meeting_family: "public_hearing",
  });
  assert.equal(host.status, "accepted");
  assert.equal(host.meeting_id, committeeEdge.to);
  assert.equal(host.host_ref, committeeEdge.from);
  assert.equal(host.host_kind, "community-board-committee");
  assert.equal(host.parent_board_ref, "community-board:manhattan-cb-06");
  assert.equal(host.proceeding_form, "public_hearing");
  assert.equal(host.provenance.source_url, committeeEdge.provenance.source_url);
});

test("parent-board host is the fallback when committee resolution is absent", () => {
  const host = projectCommunityBoardProceedingHost({
    relation: "hosts_meeting",
    status: "promoted",
    promoted: true,
    from: "community-board:brooklyn-cb-01",
    to: "meeting:community_board:cb1-full",
    target_name: "Full Board Meeting",
    institution_refs: { board_ref: "community-board:brooklyn-cb-01" },
  }, { meeting_family: "meeting" });
  assert.equal(host.host_kind, "community-board");
  assert.equal(host.parent_board_ref, "community-board:brooklyn-cb-01");
  assert.equal(host.proceeding_form, "meeting");
  assert.deepEqual(projectCommunityBoardProceedingHosts([
    committeeEdge,
    { ...committeeEdge, status: "held", promoted: false },
  ], {}), [projectCommunityBoardProceedingHost(committeeEdge, {})]);
});

