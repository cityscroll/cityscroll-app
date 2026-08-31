import assert from "node:assert/strict";
import test from "node:test";

import { renderMeetingDocument } from "../site/meeting_document.mjs";
import { renderEdgeNotice } from "../site/pages_edge.mjs";
import {
  buildCanonicalDocumentReportTarget,
  buildCanonicalDocumentRelationshipReportTarget,
  renderReportIssueAffordance,
} from "../site/report_issue.mjs";
import { detectNodePageCruft } from "../site/civic_document_chrome.mjs";

function decodeAttr(value) {
  return String(value || "")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function reportTargetsFromHtml(html) {
  return [...String(html || "").matchAll(/data-report-target="([^"]+)"/g)]
    .map((match) => JSON.parse(decodeAttr(match[1])));
}

const meetingRecord = {
  meeting_id: "meeting:city_record:20260820001",
  source_system: "city_record",
  source_record_id: "20260820001",
  source_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20260820001",
  title: "Public hearing on facade safety",
  agency_name: "Buildings",
  event_date: "2026-08-20T14:00:00Z",
  compatibility: {
    publisher_href: "https://a856-cityrecord.nyc.gov/RequestDetail/20260820001",
    legacy_notice_href: "/notices/20260820001",
  },
};

const boardMeeting = {
  meeting_id: "meeting:community_board:event-1",
  source_system: "community_board",
  source_record_id: "event-1",
  source_url: "https://board.example/minutes-1.pdf",
  title: "Community Board 6 meeting",
  event_date: "2026-08-12",
  board_id: "manhattan-cb-06",
  board_name: "Manhattan Community Board 6",
};

const noticeRow = {
  request_id: "20240515016",
  short_title: "Forest management",
  agency_name: "Parks & Recreation",
  vendor_name: "Acme Works",
  project_id: "2022M0258",
  project_name: "Avenue project",
  type_of_notice_description: "Award",
  pin: "84124P0003001",
};

test("canonical meeting documents expose document and displayed relationship report actions", () => {
  const html = renderMeetingDocument(meetingRecord);
  const targets = reportTargetsFromHtml(html);
  assert.match(html, /<script type="module" src="\/report_issue\.mjs"><\/script>/);
  assert.match(html, />Report an issue<\/button>/);
  assert.match(html, /href="\/notices\/20260820001"/);
  assert.match(html, /Official source/);
  assert.doesNotMatch(html, /data-report-fallback/);
  assert.ok(targets.some((target) => (
    target.object_id === meetingRecord.meeting_id
    && target.canonical_url === `/meetings/${encodeURIComponent(meetingRecord.meeting_id)}/`
    && !target.claim_anchor
  )));
  const agency = targets.find((target) => target.claim_anchor?.field_or_semantic_key === "agency");
  assert.equal(agency.claim_anchor.claim_type, "relationship");
  assert.equal(agency.claim_anchor.relation_type, "organized_by_agency");
  assert.equal(agency.claim_anchor.object_id, "agency:id:buildings");
  assert.equal(agency.claim_anchor.anchor, `${meetingRecord.meeting_id}#agency`);
  assert.deepEqual(agency.provenance.source_record_ids, ["20260820001"]);
  assert.ok(agency.provenance.source_urls.includes(meetingRecord.source_url));
  assert.equal(agency.canonical_url, `/meetings/${encodeURIComponent(meetingRecord.meeting_id)}/`);
  assert.ok(!targets.some((target) => target.claim_anchor?.claim_type === "identity"));
});

test("canonical meeting board relationship reports only when the board join is displayed", () => {
  const html = renderMeetingDocument(boardMeeting);
  const targets = reportTargetsFromHtml(html);
  const board = targets.find((target) => target.claim_anchor?.field_or_semantic_key === "community-board");
  assert.equal(board.claim_anchor.relation_type, "hosted_by_community_board");
  assert.equal(board.claim_anchor.object_id, "community-board:manhattan-cb-06");
  assert.equal(board.object_id, boardMeeting.meeting_id);
  assert.match(html, /Manhattan Community Board 6/);
  assert.doesNotMatch(html, /#identity/);
});

test("canonical notice documents expose document and selected displayed relationship actions", () => {
  const html = renderEdgeNotice(noticeRow, noticeRow.request_id);
  const targets = reportTargetsFromHtml(html);
  assert.match(html, /class="ui-official-source-link"[^>]*>Official record/);
  assert.match(html, /class="ui-constellation-link notice-agency-link"/);
  assert.doesNotMatch(html, /data-report-fallback/);
  const document = targets.find((target) => !target.claim_anchor);
  assert.equal(document.object_type, "notice");
  assert.equal(document.object_id, "notice:20240515016");
  assert.equal(document.canonical_url, "/notices/20240515016");
  assert.deepEqual(document.provenance.source_record_ids, ["20240515016"]);
  const agency = targets.find((target) => target.claim_anchor?.field_or_semantic_key === "agency");
  assert.equal(agency.claim_anchor.relation_type, "published_by_agency");
  assert.equal(agency.claim_anchor.object_id, "agency:id:parks-and-recreation");
  assert.equal(agency.claim_anchor.anchor, "notice:20240515016#agency");
  const vendor = targets.find((target) => target.claim_anchor?.field_or_semantic_key === "vendor");
  assert.equal(vendor.claim_anchor.claim_type, "relationship");
  assert.equal(vendor.claim_anchor.relation_type, "named_vendor");
  assert.match(vendor.claim_anchor.object_id, /^vendor:stem:/);
  const project = targets.find((target) => target.claim_anchor?.field_or_semantic_key === "project");
  assert.equal(project.claim_anchor.relation_type, "related_land_use_project");
  assert.equal(project.claim_anchor.object_id, "project:2022M0258");
  assert.ok(!targets.some((target) => target.claim_anchor?.claim_type === "identity"));
});

test("notice-to-meeting canonical object joins keep a distinct relationship target", () => {
  const html = renderEdgeNotice({
    request_id: "20260820001",
    short_title: "Public hearing",
    agency_name: "Buildings",
    meeting_id: "meeting:city_record:20260820001",
    type_of_notice_description: "Public Hearings",
  }, "20260820001");
  const related = reportTargetsFromHtml(html)
    .find((target) => target.claim_anchor?.field_or_semantic_key === "related_object");
  assert.equal(related.claim_anchor.relation_type, "identified_canonical_object");
  assert.equal(related.claim_anchor.object_id, "meeting:city_record:20260820001");
  assert.equal(related.object_id, "notice:20260820001");
  assert.equal(related.canonical_url, "/notices/20260820001");
});

test("incomplete documents and unmatched relationships fail closed without unanchored reports", () => {
  assert.equal(renderMeetingDocument({ title: "Missing identity" }), null);
  const missingNotice = renderEdgeNotice(null, "20991231999");
  assert.match(missingNotice, /data-edge-rendered="notice-unavailable"/);
  assert.doesNotMatch(missingNotice, /data-report-target=/);
  assert.doesNotMatch(missingNotice, />Report an issue</);
  assert.doesNotMatch(missingNotice, /data-report-fallback/);
  assert.deepEqual(detectNodePageCruft(missingNotice), []);

  const unresolved = renderEdgeNotice({
    request_id: "20260626003",
    short_title: "Unresolved notice",
    agency_name: "Agency Without A Profile",
    type_of_notice_description: "Solicitation",
  }, "20260626003");
  const unresolvedTargets = reportTargetsFromHtml(unresolved);
  assert.ok(unresolvedTargets.some((target) => target.object_id === "notice:20260626003" && !target.claim_anchor));
  assert.ok(!unresolvedTargets.some((target) => target.claim_anchor?.field_or_semantic_key === "agency"));
  assert.doesNotMatch(unresolved, /href="\/agencies\/agency-without-a-profile\//);

  const noProject = renderEdgeNotice({
    request_id: "20240515016",
    short_title: "Forest management",
    agency_name: "Parks & Recreation",
    project_id: "??",
    type_of_notice_description: "Notice",
  }, "20240515016");
  assert.ok(!reportTargetsFromHtml(noProject).some((target) => (
    target.claim_anchor?.field_or_semantic_key === "project"
    || target.claim_anchor?.field_or_semantic_key === "related_object"
  )));
});

test("canonical document target construction is fail-closed and keeps provenance on success", () => {
  const document = buildCanonicalDocumentReportTarget({
    object_type: "notice",
    object_id: "notice:20240515016",
    canonical_url: "/notices/20240515016",
    object_label: "Forest management",
    source: {
      source_system: "city_record",
      source_record_id: "20240515016",
      source_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20240515016",
    },
  });
  assert.equal(document.canonical_url, "/notices/20240515016");
  assert.deepEqual(document.provenance.source_urls, [
    "https://a856-cityrecord.nyc.gov/RequestDetail/20240515016",
  ]);

  assert.equal(buildCanonicalDocumentReportTarget({
    object_type: "notice",
    object_id: "notice:20240515016",
    canonical_url: "/agencies/parks-and-recreation/",
    object_label: "Misleading profile",
  }), null);
  assert.equal(buildCanonicalDocumentReportTarget({
    object_type: "meeting",
    object_id: "not-a-meeting",
    canonical_url: "/meetings/not-a-meeting/",
  }), null);
  assert.equal(buildCanonicalDocumentRelationshipReportTarget({
    object_type: "notice",
    object_id: "notice:20240515016",
    canonical_url: "/notices/20240515016",
    semantic_key: "committee",
    relation_type: "has_committee",
    related_object_id: "committee:34",
    related_object_label: "Land Use",
  }), null);
  assert.equal(renderReportIssueAffordance(null), "");
  assert.equal(renderReportIssueAffordance({ object_id: "notice:1" }), "");
});
