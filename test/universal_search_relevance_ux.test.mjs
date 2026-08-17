import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { projectAgencySearchDocument } from "../site/agency_search_producer.mjs";
import {
  buildUniversalSearchResultView,
  highlightLiteralHtml,
  renderUniversalSearchResultHtml,
} from "../site/universal_search_relevance_ux.mjs";

const AGENCIES = JSON.parse(readFileSync(
  new URL("../site/data/agency_constellation_lookup.json", import.meta.url),
));

function agencyResult(overrides = {}) {
  const document = projectAgencySearchDocument(
    "parks-and-recreation",
    AGENCIES.by_id["parks-and-recreation"],
    { lookup: AGENCIES },
  ).document;
  return {
    ...document,
    result_schema: "cityscroll.universal_search_result.v1",
    outcome: "indexed",
    entity_type: "agency",
    lens: "agencies",
    source_route: document.canonical_href,
    match_fields: [{
      field: "alias",
      matched_term: "dpr",
      source_observation_ref: document.source_observation_refs[0],
    }],
    ranking: { lifecycle_state: "active" },
    edge_provenance: {
      document_producer: document.provenance.producer,
      source_observation_refs: document.source_observation_refs,
    },
    ...overrides,
  };
}

test("real typed agency data renders the matched alias, reason, type, lens, and route", () => {
  const result = agencyResult();
  const view = buildUniversalSearchResultView(result);
  const html = renderUniversalSearchResultHtml(result);

  assert.equal(view.entity_type, "agency");
  assert.equal(view.entity_type_label, "Agency");
  assert.equal(view.lens_label, "Agencies");
  assert.equal(view.evidence.field, "alias");
  assert.equal(view.evidence.reason, "Alias match");
  assert.match(view.evidence.value, /DPR/i);
  assert.equal(view.href, "/agencies/parks-and-recreation/");
  assert.match(html, /data-match-field="alias"/);
  assert.match(html, /Alias match/);
  assert.match(html, /<mark>DPR<\/mark>/i);
  assert.match(html, />Agency<\/span>/);
  assert.match(html, />Agencies<\/span>/);
  assert.match(html, /href="\/agencies\/parks-and-recreation\/"/);
  assert.equal(view.edge_provenance.source_observation_ref, "agency_constellation:parks-and-recreation");
  assert.equal(view.edge_provenance.document_producer, "agency_search_document.v1");
});

test("name, address, code, and notice-text evidence use the declared machine field", () => {
  const cases = [
    ["name", "Parks", "Department of Parks and Recreation", "Name match"],
    ["address", "Centre Street", "One Centre Street, New York, NY", "Address match"],
    ["code", "0258", "ULURP code 2022M0258", "Official code match"],
    ["notice_text", "public hearing", "A public hearing will be held next week.", "Notice text match"],
  ];
  for (const [field, term, value, reason] of cases) {
    const result = agencyResult({
      title: field === "name" ? value : "A typed civic object",
      summary: ["address", "notice_text"].includes(field) ? value : "Published record summary.",
      search_text: `${value} Published record summary.`,
      match_fields: [{
        field,
        matched_term: term,
        source_observation_ref: "agency_constellation:parks-and-recreation",
      }],
    });
    const view = buildUniversalSearchResultView(result);
    const html = renderUniversalSearchResultHtml(result);
    assert.equal(view.evidence.field, field);
    assert.equal(view.evidence.reason, reason);
    assert.match(view.evidence.value.toLocaleLowerCase("en-US"), new RegExp(term.toLocaleLowerCase("en-US")));
    assert.match(html, new RegExp(`data-match-field="${field}"`));
    assert.match(html, /<mark>/);
  }
});

test("active and archived source states remain visible and archived evidence stays linked", () => {
  const active = renderUniversalSearchResultHtml(agencyResult());
  const archived = renderUniversalSearchResultHtml(agencyResult({
    ranking: { lifecycle_state: "archived" },
  }));

  assert.match(active, /data-lifecycle-state="active"/);
  assert.match(active, />Active<\/span>/);
  assert.match(archived, /data-lifecycle-state="archived"/);
  assert.match(archived, />Archived<\/span>/);
  assert.match(archived, /class="topic-search-result is-archive"/);
  assert.match(archived, /href="\/agencies\/parks-and-recreation\/"/);
});

test("unknown source state omits the no-value status chip", () => {
  const html = renderUniversalSearchResultHtml(agencyResult({
    ranking: {},
    provenance: {},
  }));

  assert.match(html, /data-lifecycle-state="unknown"/);
  assert.doesNotMatch(html, /topic-search-result-status|Status not available/);
});

test("highlighting escapes query and source text before adding fixed mark elements", () => {
  const hostile = '<img src=x onerror="alert(1)">';
  const highlighted = highlightLiteralHtml(`Before ${hostile} after`, hostile);
  const html = renderUniversalSearchResultHtml(agencyResult({
    title: `Office ${hostile}`,
    match_fields: [{
      field: "title",
      matched_term: hostile,
      source_observation_ref: "agency_constellation:parks-and-recreation",
    }],
  }));

  assert.equal(highlighted, `Before <mark>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</mark> after`);
  assert.doesNotMatch(html, /<img|onerror="/);
  assert.match(html, /<mark>&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;<\/mark>/);
});

test("keyword cards mark only the exact source-backed offsets", () => {
  const html = renderUniversalSearchResultHtml(agencyResult({
    title: "Tidal planning record",
    match_fields: [{ field: "title", matched_term: "ida" }],
    match_evidence: {
      field: "summary",
      matched_normalized_term: "industrial development agency",
      source_identifier: "agency_constellation:parks-and-recreation",
      snippet: {
        text: "Reviewed Industrial Development Agency record",
        mark_start: 9,
        mark_end: 38,
      },
    },
  }));

  assert.doesNotMatch(html, /T<mark>ida<\/mark>l/i);
  assert.match(html, /Reviewed <mark>Industrial Development Agency<\/mark> record/);
});

test("ranked rows without a literal span say evidence is unavailable", () => {
  const html = renderUniversalSearchResultHtml(agencyResult({
    keyword_evidence: {
      status: "unavailable",
      message: "Keyword evidence unavailable for this source",
    },
  }));

  assert.match(html, /Keyword evidence unavailable/);
  assert.doesNotMatch(html, /<mark>/);
});

test("the compact card keeps one keyboard route plus visible type, reason, and status", () => {
  const html = renderUniversalSearchResultHtml(agencyResult());
  assert.equal((html.match(/<a /g) || []).length, 1);
  assert.match(html, /topic-search-result-meta/);
  assert.match(html, /topic-search-result-evidence/);
  assert.match(html, /topic-search-result-status/);
  assert.doesNotMatch(html, /tabindex="-1"|aria-hidden="true"/);
});
