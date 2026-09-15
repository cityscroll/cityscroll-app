import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLocalIssueRequestResponseTrail,
  renderLocalIssueRequestResponseTrail,
  REQUEST_RESPONSE_TRAIL_STATUSES,
} from "../site/local_issue_request_response_trail.mjs";

const request = (extra = {}) => ({
  board_id: "brooklyn-cb-15",
  board_label: "Brooklyn Community Board 15",
  fiscal_year: 2027,
  tracking_code: "214202702C",
  title: "Expand the Cortelyou Road library",
  source_url: "https://example.test/board-budget",
  answers: [
    { publication: "initial", publication_date: "2026-01-15", response: "Under review", changed: false },
    { publication: "revision", publication_date: "2026-05-20", response: "Contact elected officials", changed: true, status: "acknowledged" },
  ],
  ...extra,
});

test("A1/A5: exact request identity and every retained response version remain chronological", () => {
  const trail = buildLocalIssueRequestResponseTrail(request());
  assert.deepEqual(trail.request, {
    board_id: "brooklyn-cb-15",
    board_label: "Brooklyn Community Board 15",
    fiscal_year: 2027,
    tracking_code: "214202702C",
    wording: "Expand the Cortelyou Road library",
    request_class: null,
    source_url: "https://example.test/board-budget",
  });
  assert.deepEqual(trail.events.map((event) => [event.kind, event.date, event.text]), [
    ["request", null, "Expand the Cortelyou Road library"],
    ["response", "2026-01-15", "Under review"],
    ["response", "2026-05-20", "Contact elected officials"],
  ]);
  assert.equal(trail.events[2].changed, true);
});

test("A2/A3: only supplied explicit project links cross to a separate canonical record", () => {
  const trail = buildLocalIssueRequestResponseTrail(request({ project_links: [{
    project_code: "C-123",
    project_name: "Cortelyou Road library expansion",
    project_href: "/projects/C-123/",
    owner: "Libraries",
    scope: "Library expansion as published",
    source_url: "https://example.test/project",
  }] }));
  assert.equal(trail.projects.length, 1);
  assert.equal(trail.projects[0].project_href, "/projects/C-123/");
  assert.match(trail.projects[0].relationship, /not evidence of fulfillment/);
  assert.equal(buildLocalIssueRequestResponseTrail(request({ project_links: [] })).projects.length, 0);
});

test("A4/A6: unsupported stage values do not advance a request and resident output states the boundary", () => {
  const trail = buildLocalIssueRequestResponseTrail(request({
    status: "completed",
    answers: [{ publication_date: "2026-05-20", response: "No status published", status: "invented" }],
  }));
  assert.deepEqual(REQUEST_RESPONSE_TRAIL_STATUSES, ["submitted", "acknowledged", "supported", "funded", "scheduled", "active", "completed"]);
  assert.equal(trail.events[0].status, "completed");
  assert.equal(trail.events[1].status, null);
  const html = renderLocalIssueRequestResponseTrail(trail);
  assert.match(html, /Request and agency response trail/);
  assert.match(html, /Neither proves funding, delivery, or completion/);
  assert.doesNotMatch(html, /fulfillment score|caused|completed the request/i);
});

test("unlinked, resurfaced, and cross-year requests retain their own identities", () => {
  const first = buildLocalIssueRequestResponseTrail(request({ fiscal_year: 2026, tracking_code: "214202702E" }));
  const resurfaced = buildLocalIssueRequestResponseTrail(request({ fiscal_year: 2027, tracking_code: "214202702C", answers: [{ publication_date: "2027-02-01", response: "Resurfaced" }] }));
  assert.notEqual(first.request.tracking_code, resurfaced.request.tracking_code);
  assert.notEqual(first.request.fiscal_year, resurfaced.request.fiscal_year);
  assert.equal(resurfaced.events.at(-1).text, "Resurfaced");
});
