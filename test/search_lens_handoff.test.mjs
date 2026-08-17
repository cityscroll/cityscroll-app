import assert from "node:assert/strict";
import test from "node:test";

import {
  SEARCH_LENS_HANDOFF_SCHEMA,
  buildSearchLensHandoff,
  parseSearchLensHandoff,
  renderSearchHandoffArrivalHtml,
} from "../site/search_lens_handoff.mjs";

const payload = Object.freeze({
  schema: "cityscroll.keyword_search_response.v1",
  query: "Mosquitos",
  resolved_term: {
    canonical_tokens: ["mosquito"],
    structured_filters: {},
    alias_receipt: null,
  },
  lanes: [
    {
      id: "meetings",
      status: "matched",
      count: 1,
      source: "Community-board meeting snapshot",
      as_of: "2026-08-15T12:00:00Z",
      cards: [{
        object_ref: "meeting:board-calendar:mn03-2026-08-20",
        match_evidence: {
          field: "summary",
          token_offsets: [4, 5],
          character_offsets: [22, 31],
          matched_normalized_term: "mosquito",
          source_identifier: "board-calendar:mn03-2026-08-20",
          snippet: {
            text: "Parks will discuss mosquito control and standing water.",
            mark_start: 19,
            mark_end: 27,
          },
        },
      }],
    },
  ],
});

test("all six family actions use an existing typed document route and keep a non-empty topic", () => {
  const expected = {
    contracts: "/browse/contracts/",
    "people-organizations": "/browse/staffing/",
    land: "/browse/zoning/",
    rules: "/browse/rules/",
    meetings: "/browse/meetings/",
    exams: "/browse/exams/",
  };
  for (const [family, pathname] of Object.entries(expected)) {
    const handoff = buildSearchLensHandoff(family, payload, new URL("https://cityscroll.org/search/?q=Mosquitos"));
    const url = new URL(handoff.href, "https://cityscroll.org");
    assert.equal(url.pathname, pathname, family);
    assert.equal(url.searchParams.get("q"), "Mosquitos", family);
    assert.equal(parseSearchLensHandoff(url.searchParams)?.schema, SEARCH_LENS_HANDOFF_SCHEMA, family);
  }
});

test("Meetings handoff composes raw topic, normalized terms, place, and time in scope v0", () => {
  const source = new URL("https://cityscroll.org/search/?q=Mosquitos&boro=Manhattan&cd=M03&when=month");
  const handoff = buildSearchLensHandoff("meetings", payload, source);
  const url = new URL(handoff.href, source);
  assert.equal(url.pathname, "/browse/meetings/");
  assert.equal(url.searchParams.get("q"), "Mosquitos");
  assert.equal(url.searchParams.get("boro"), "Manhattan");
  assert.equal(url.searchParams.get("cd"), "M03");
  assert.equal(url.searchParams.get("when"), "month");

  const carried = parseSearchLensHandoff(url.searchParams, { surface: "meetings" });
  assert.equal(carried.raw_query, "Mosquitos");
  assert.deepEqual(carried.normalized_terms, ["mosquito"]);
  assert.deepEqual(carried.place, { borough: "Manhattan", community_district: "M03" });
  assert.deepEqual(carried.time, { when: "month" });
  assert.equal(carried.back_href, "/search/?q=Mosquitos&boro=Manhattan&cd=M03&when=month&lane=meetings");
});

test("arrival evidence renders only the carried source offsets, with provenance on the handoff", () => {
  const handoff = buildSearchLensHandoff(
    "meetings",
    payload,
    new URL("https://cityscroll.org/search/?q=standing+water&boro=Manhattan"),
  );
  const html = renderSearchHandoffArrivalHtml(handoff);
  assert.match(html, /Opened Meetings from topic search/);
  assert.match(html, /Topic <b[^>]*>standing water<\/b>/);
  assert.match(html, /Parks will discuss <mark>mosquito<\/mark> control/);
  assert.match(html, /data-source-observation-ref="board-calendar:mn03-2026-08-20"/);
  assert.match(html, /Back to all search results/);
  assert.match(html, /Remove topic standing water/);
  assert.doesNotMatch(html, /<mark>standing water<\/mark>/);
});

test("missing or malformed source evidence stays explicit instead of re-highlighting the query", () => {
  const handoff = buildSearchLensHandoff("rules", {
    ...payload,
    lanes: [{
      id: "rules",
      status: "matched",
      count: 1,
      source: "City Record daily mirror",
      as_of: "2026-08-15",
      cards: [{ object_ref: "notice:123", match_evidence: null }],
    }],
  }, new URL("https://cityscroll.org/search/?q=sidewalk"));
  const html = renderSearchHandoffArrivalHtml(handoff);
  assert.match(html, /Keyword evidence is unavailable for this source/);
  assert.doesNotMatch(html, /<mark>/);
});

test("handoff parsing fails closed for a different typed surface", () => {
  const handoff = buildSearchLensHandoff("meetings", payload, new URL("https://cityscroll.org/search/?q=Mosquitos"));
  const url = new URL(handoff.href, "https://cityscroll.org");
  assert.equal(parseSearchLensHandoff(url.searchParams, { surface: "rules" }), null);
});
