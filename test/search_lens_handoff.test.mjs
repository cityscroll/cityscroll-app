import assert from "node:assert/strict";
import test from "node:test";

import {
  SEARCH_LENS_HANDOFF_SCHEMA,
  buildSearchLensHandoffHref,
  parseSearchLensHandoff,
  retainSearchHandoffForQuery,
  removeSearchTopicHref,
  renderSearchLensHandoffHtml,
  searchFamilyForResult,
  searchReturnHref,
} from "../site/search_lens_handoff.mjs";

const meeting = {
  object_ref: "meeting:city_record:20260816001",
  object_type: "meeting",
  domain: "meetings",
  source_observation_refs: ["city-record:20260816001"],
  match_evidence: {
    field: "description",
    matched_normalized_term: "mosquito",
    source_identifier: "city-record:20260816001",
    snippet: {
      text: "A hearing about mosquito control in Brooklyn.",
      mark_start: 16,
      mark_end: 24,
    },
  },
};

const response = {
  query: "mosquitos",
  resolved_term: {
    canonical_tokens: ["mosquito"],
    structured_filters: {},
    alias_receipt: null,
  },
};

const proposedContract = {
  object_ref: "procurement:05626S0013001",
  object_type: "procurement",
  domain: "contracts",
  process_role: "award",
  source_observation_refs: ["notice:20260730029"],
  match_evidence: {
    field: "title",
    matched_normalized_term: "software",
    source_identifier: "notice:20260730029",
    snippet: {
      text: "Maintenance, support services, software assurance",
      mark_start: 30,
      mark_end: 38,
    },
  },
};

test("six search families map typed civic objects to their established destination", () => {
  const cases = [
    [{ domain: "contracts", object_type: "procurement" }, "contracts", "/browse/contracts/"],
    [{ domain: "people", object_type: "official" }, "people-organizations", "/browse/people/"],
    [{ domain: "zoning", object_type: "land_use_project" }, "land", "/browse/zoning/"],
    [{ domain: "property", object_type: "parcel" }, "land", "/browse/property/"],
    [{ domain: "rules", object_type: "rulemaking" }, "rules", "/browse/rules/"],
    [{ domain: "meetings", object_type: "meeting" }, "meetings", "/browse/meetings/"],
    [{ domain: "staffing", object_type: "civil_service_exam" }, "exams", "/browse/exams/"],
  ];

  for (const [record, family, pathname] of cases) {
    assert.equal(searchFamilyForResult(record), family);
    const href = new URL(buildSearchLensHandoffHref(record, response, "?q=mosquitos"), "https://cityscroll.org");
    assert.equal(href.pathname, pathname);
    if (record.object_type === "civil_service_exam") {
      assert.equal(JSON.parse(href.searchParams.get("facet")).search_handoff.destination.surface, "exams");
      assert.equal(href.searchParams.has("view"), false);
    }
  }
});

test("typed handoff preserves raw and normalized topic, C1 place, C2 time, and exact evidence", () => {
  const href = buildSearchLensHandoffHref(
    meeting,
    response,
    "?q=mosquitos&boro=Brooklyn&cd=K06&when=month",
  );
  const url = new URL(href, "https://cityscroll.org");
  assert.equal(url.pathname, "/browse/meetings/");
  assert.equal(url.searchParams.get("q"), "mosquitos");
  assert.equal(url.searchParams.get("boro"), "Brooklyn");
  assert.equal(url.searchParams.get("cd"), "K06");
  assert.equal(url.searchParams.get("when"), "month");

  const facet = JSON.parse(url.searchParams.get("facet"));
  assert.equal(facet.search_handoff.schema, SEARCH_LENS_HANDOFF_SCHEMA);
  assert.deepEqual(facet.search_handoff.normalized_terms, ["mosquito"]);
  assert.equal(facet.search_handoff.record_ref, meeting.object_ref);
  assert.equal(facet.search_handoff.evidence.source_identifier, "city-record:20260816001");
  assert.ok(url.searchParams.get("facet").length < 2_000, "scope facet remains within the router bound");

  const parsed = parseSearchLensHandoff(url.search);
  assert.equal(parsed.raw_query, "mosquitos");
  assert.equal(parsed.destination.surface, "meetings");
  assert.deepEqual(parsed.normalized_terms, ["mosquito"]);
  assert.deepEqual(parsed.evidence.snippet, meeting.match_evidence.snippet);
});

test("a contract handoff selects the clicked object by identity in the mixed archive", () => {
  const href = buildSearchLensHandoffHref(
    proposedContract,
    { ...response, query: "software", resolved_term: { ...response.resolved_term, canonical_tokens: ["software"] } },
    "?q=software",
  );
  const url = new URL(href, "https://cityscroll.org");
  const facet = JSON.parse(url.searchParams.get("facet"));

  assert.equal(url.pathname, "/browse/contracts/");
  assert.equal(url.searchParams.get("mode"), "archive");
  assert.equal(url.searchParams.get("q"), "software");
  assert.deepEqual(facet.contract_identity, {
    object_ref: "procurement:05626S0013001",
    source_observation_ref: "notice:20260730029",
  });
  assert.equal(facet.search_handoff.record_ref, "procurement:05626S0013001");
});

test("a reviewed agency resolution becomes a typed entity constraint", () => {
  const href = buildSearchLensHandoffHref(meeting, {
    ...response,
    query: "IDA",
    resolved_term: {
      canonical_tokens: ["industrial", "development", "agency"],
      structured_filters: {
        agency: "Industrial Development Agency",
        agency_id: "industrial-development-agency",
      },
    },
  }, "?q=IDA");
  const url = new URL(href, "https://cityscroll.org");
  const facet = JSON.parse(url.searchParams.get("facet"));

  assert.equal(url.searchParams.has("agency"), false);
  assert.deepEqual(facet.entity_refs_all, ["agency:id:industrial-development-agency"]);
  assert.equal(facet.search_handoff.raw_query, "IDA");
});

test("evidence offsets retain publisher whitespace exactly", () => {
  const spaced = {
    ...meeting,
    match_evidence: {
      ...meeting.match_evidence,
      snippet: { text: "Hearing  about\nmosquito control.", mark_start: 15, mark_end: 23 },
    },
  };
  const href = buildSearchLensHandoffHref(spaced, response, "?q=mosquitos");
  const parsed = parseSearchLensHandoff(new URL(href, "https://cityscroll.org").search);
  const html = renderSearchLensHandoffHtml(parsed);

  assert.equal(parsed.evidence.snippet.text, "Hearing  about mosquito control.");
  assert.match(html, /Hearing  about <mark>mosquito<\/mark> control\./);
});

test("destination renders only carried offsets and keeps return/removal state inspectable", () => {
  const href = buildSearchLensHandoffHref(
    meeting,
    response,
    "?q=mosquitos&boro=Brooklyn&when=month",
  );
  const parsed = parseSearchLensHandoff(new URL(href, "https://cityscroll.org").search);
  const html = renderSearchLensHandoffHtml(parsed);

  assert.match(html, /Opened Meetings/);
  assert.match(html, /data-search-topic-chip/);
  assert.match(html, /A hearing about <mark>mosquito<\/mark> control in Brooklyn\./);
  assert.match(html, /data-source-observation-ref="city-record:20260816001"/);
  assert.match(html, /Back to topic results/);

  const back = new URL(searchReturnHref(parsed), "https://cityscroll.org");
  assert.equal(back.pathname, "/search/");
  assert.equal(back.searchParams.get("q"), "mosquitos");
  assert.equal(back.searchParams.get("boro"), "Brooklyn");
  assert.equal(back.searchParams.get("when"), "month");
  assert.equal(back.hash, "#search-lane-meetings");

  const removed = new URL(removeSearchTopicHref(parsed), "https://cityscroll.org");
  assert.equal(removed.pathname, "/browse/meetings/");
  assert.equal(removed.searchParams.has("q"), false);
  assert.equal(removed.searchParams.get("boro"), "Brooklyn");
  assert.equal(removed.searchParams.get("when"), "month");
  assert.equal(JSON.parse(removed.searchParams.get("facet") || "{}").search_handoff, undefined);
});

test("missing source evidence is explicit and never guessed from the raw query", () => {
  const href = buildSearchLensHandoffHref(
    { ...meeting, match_evidence: null, keyword_evidence: { status: "unavailable" } },
    response,
    "?q=mosquitos",
  );
  const parsed = parseSearchLensHandoff(new URL(href, "https://cityscroll.org").search);
  const html = renderSearchLensHandoffHtml(parsed);
  assert.match(html, /Keyword evidence is unavailable for this source\./);
  assert.doesNotMatch(html, /<mark>/);
});

test("editing the destination topic drops stale handoff evidence from canonical scope state", () => {
  const href = buildSearchLensHandoffHref(proposedContract, {
    ...response,
    query: "software",
    resolved_term: { ...response.resolved_term, canonical_tokens: ["software"] },
  }, "?q=software");
  const facet = JSON.parse(new URL(href, "https://cityscroll.org").searchParams.get("facet"));
  assert.ok(retainSearchHandoffForQuery(facet, "software").contract_identity);
  assert.equal(retainSearchHandoffForQuery(facet, "rats").search_handoff, undefined);
  assert.equal(retainSearchHandoffForQuery(facet, "rats").contract_identity, undefined);
});
