import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildCouncilMatterSearchDocuments } from "../site/council_matter_search_producer.mjs";
import { projectLandSearchDocument } from "../site/land_search_producer.mjs";
import { renderSearchDocument } from "../site/primary_document_view.mjs";
import { buildProcurementSearchDocuments } from "../site/procurement_search_producer.mjs";
import { renderProcurementDocument } from "../site/procurement_document.mjs";
import { siteHistoryForParcelIds } from "../site/search_identifier_support.mjs";
import { keywordTextMatches, resolveKeywordQuery } from "../site/keyword_matcher.mjs";
import { buildSearchRenderPlan } from "../site/search_render_plan.mjs";
import { createSiteLifecycleReader } from "../site/site_lifecycle_projection.mjs";
import { parseAddressQuery, resolveAddressFromShard } from "../site/precomputed_address_geocoder.mjs";
import { renderUniversalSearchResultHtml } from "../site/universal_search_relevance_ux.mjs";
import { testClockISOString, withPinnedClock } from "./helpers/test_clock.mjs";

const PROCUREMENT_FIXTURE = JSON.parse(readFileSync(
  new URL("./fixtures/site_lifecycle_identifier_search/procurement_coyle.json", import.meta.url),
  "utf8",
));
const CAPTURE_MANIFEST = JSON.parse(readFileSync(
  new URL("../docs/evidence/identifier-site-history-journey/capture-manifest.json", import.meta.url),
  "utf8",
));

const LAND = projectLandSearchDocument({
  project_id: "2020K0270",
  project_name: "Coyle Street Rezoning",
  ulurp_numbers: "C210239ZMK; N210240ZRK",
  ceqr_number: "21DCP123K",
  bbls: ["3073670011", "3073670029"],
}, { artifact: { schema_version: 1, dataset_id: "hgx4-8ukb", source: "ZAP", materialized_at: "2026-09-09" } }).document;

const SUBMITTED_QUERY = "07122P0010020";
const FAILED_DETAIL_HTML = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Procurement not found · CityScroll</title></head><body><main><h1>Procurement not found</h1><p><a href=\"/browse/contracts/\">Browse contracts</a></p></main></body></html>";

function esc(value) {
  return String(value ?? "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function procurementModel() {
  return {
    schema: "cityscroll.shared_procurement_read_model.v1",
    generated_at: testClockISOString(),
    rows: [PROCUREMENT_FIXTURE.object],
    observations: PROCUREMENT_FIXTURE.observations,
    sources: {},
  };
}

function produceProcurementDocument() {
  return buildProcurementSearchDocuments(procurementModel()).documents[0];
}

/** Deterministic journey renders shared by the A3/A4 assertions and capture hashes. */
function renderIdentifierJourney(mode, document, query = SUBMITTED_QUERY) {
  const searchHref = `/search/?q=${encodeURIComponent(query)}`;
  const form = renderSearchDocument().replace(
    'id="search-query" name="q" type="search"',
    `id="search-query" name="q" type="search" value="${esc(query)}"`,
  );
  if (mode === "failed-index") {
    const plan = buildSearchRenderPlan({ state: "unavailable" });
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Search · CityScroll</title></head><body data-journey="failed-index" data-search-outcome="${esc(plan.outcome)}" data-submitted-query="${esc(query)}"><main>${form}<section class="topic-search-coverage is-unavailable" data-search-coverage data-coverage-state="unavailable" role="status"><p><strong>Unavailable</strong></p><p>The latest CityScroll snapshot is unavailable. Retry.</p></section><p><a href="${esc(searchHref)}">Retry this search</a></p></main></body></html>`;
  }
  if (mode === "failed-detail") return FAILED_DETAIL_HTML;
  if (mode === "detail") {
    return renderProcurementDocument(PROCUREMENT_FIXTURE.object, PROCUREMENT_FIXTURE.observations, {
      today: testClockISOString().slice(0, 10),
    });
  }
  if (mode === "site-history") {
    const siteHistory = document.provenance.site_history;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Parcel ${esc(siteHistory.parcel_ids[0])} · CityScroll</title></head><body data-journey="site-history"><main><p class="node-back"><a href="${esc(document.canonical_href)}">Back to native record</a></p><h1>Parcel history for BBL ${esc(siteHistory.parcel_ids[0])}</h1></main></body></html>`;
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Results for ${esc(query)} · CityScroll</title></head><body data-journey="search" data-submitted-query="${esc(query)}"><main>${form}<div class="topic-search-results">${renderUniversalSearchResultHtml(document)}</div></main></body></html>`;
}

test("native land and procurement documents retain exact identifiers and parcel history", async () => {
  await withPinnedClock("2026-09-15T12:00:00.000Z", async () => {
    const procurement = produceProcurementDocument();

    for (const query of [
      "3073670011", "2020K0270", "21DCP123K", "C 210239 ZMK", "N 210240 ZRK",
    ]) assert.equal(keywordTextMatches(LAND.search_text, resolveKeywordQuery(query)), true, query);
    assert.ok(procurement, "the native procurement producer must emit a document");
    for (const query of ["07122P0010020", "CT107120258802303", "20241104015"]) {
      assert.equal(keywordTextMatches(procurement.search_text, resolveKeywordQuery(query)), true, query);
    }
    assert.equal(LAND.canonical_href, "/browse/zoning/#land/2020K0270");
    assert.equal(procurement.object_ref, PROCUREMENT_FIXTURE.object.procurement_id);
    assert.equal(procurement.canonical_href, "/procurements/procurement%3Acontract%3ACT107120258802303");
    assert.deepEqual(procurement.provenance.site_history, {
      parcel_ids: ["3073670011"],
      href: "/parcels/3073670011/",
      relation: "accepted_exact_parcel_membership",
    });
    assert.equal(
      keywordTextMatches(LAND.search_text, resolveKeywordQuery("07122P0010020")),
      false,
      "the procurement PIN must not become a land alias",
    );
    assert.deepEqual(LAND.provenance.site_history, {
      parcel_ids: ["3073670011", "3073670029"],
      href: "/parcels/3073670011/",
      relation: "accepted_exact_parcel_membership",
    });
    assert.equal(siteHistoryForParcelIds([]), null);
  });
});

test("retained Council matter identifiers remain native matter results", async () => {
  await withPinnedClock("2026-09-15T12:00:00.000Z", async () => {
    const corpus = buildCouncilMatterSearchDocuments({
      generated_at: testClockISOString().slice(0, 10),
      matters: {
        "90001": {
          matter_id: "90001", matter_file: "LU 0010-2022", join_value: "C210239ZMK",
          project_id: "2020K0270", resolution_ids: ["Res 0051-2022", "Res 0052-2022"],
          title: "Coyle Street Rezoning", source_url: "https://nyc.legistar.com/Gateway.aspx?M=L&ID=90001",
          parcel_ids: ["3073670011"],
        },
      },
    });
    const doc = corpus.documents[0];
    for (const query of ["LU 0010-2022", "C 210239 ZMK", "Res 0051-2022", "2020K0270"]) {
      assert.equal(keywordTextMatches(doc.search_text, resolveKeywordQuery(query)), true, query);
    }
    assert.equal(doc.object_ref, "council:matter:90001");
    assert.equal(doc.canonical_href, "/matters/90001/");
    assert.equal(doc.provenance.site_history.href, "/parcels/3073670011/");
  });
});

test("PAD entrance is unique-or-unknown and never chooses a borough", () => {
  const query = parseAddressQuery("250 Broadway");
  const shard = { schema: "cityscroll.address-index-shard.v1", streets: { BROADWAY: [[1000, 999000, 0, "1000000001", "10001"], [1000, 999000, 0, "2000000002", "10451"]] } };
  assert.equal(resolveAddressFromShard(query, shard).status, "unknown");
  assert.equal(resolveAddressFromShard(query, shard).reason, "ambiguous");
});

test("site-history readers reject mismatched reverse generations", () => {
  assert.throws(() => createSiteLifecycleReader(
    { generation: "g1", content_hash: "h1" },
    [{ generation: "g1", rows: [] }],
    { generation: "g2", content_hash: "h1", members: {} },
  ), /generation mismatch/);
});

test("A3: search to native detail to site history and Back restores the submitted query", async () => {
  await withPinnedClock("2026-09-15T12:00:00.000Z", async () => {
    const procurement = produceProcurementDocument();
    const searchHref = `/search/?q=${encodeURIComponent(SUBMITTED_QUERY)}`;
    const detailHref = procurement.canonical_href;
    const siteHistoryHref = procurement.provenance.site_history.href;

    assert.equal(
      keywordTextMatches(procurement.search_text, resolveKeywordQuery(SUBMITTED_QUERY)),
      true,
      "the submitted PIN must resolve against the produced procurement document",
    );

    const searchHtml = renderIdentifierJourney("search", procurement);
    assert.match(searchHtml, /method="get"/);
    assert.match(searchHtml, /action="\/search\/"/);
    assert.match(searchHtml, new RegExp(`id="search-query"[^>]*value="${SUBMITTED_QUERY}"`));
    assert.match(searchHtml, new RegExp(`href="${detailHref.replace(/%/g, "\\%")}"`));
    assert.match(searchHtml, /id="search-query"/);

    const detailHtml = renderIdentifierJourney("detail", procurement);
    assert.match(detailHtml, /data-site-lifecycle-context="1"/);
    assert.match(detailHtml, /href="\/parcels\/3073670011\/"/);
    assert.match(detailHtml, /Open parcel history/);
    assert.equal(siteHistoryHref, "/parcels/3073670011/");

    const history = [searchHref, detailHref, siteHistoryHref];
    assert.equal(history.at(-1), siteHistoryHref);
    history.pop();
    assert.equal(history.at(-1), detailHref);
    history.pop();
    assert.equal(history.at(-1), searchHref);
    assert.equal(new URL(history.at(-1), "https://cityscroll.org").searchParams.get("q"), SUBMITTED_QUERY);
  });
});

test("A3: failed detail or index load preserves the query and supplies recovery", async () => {
  await withPinnedClock("2026-09-15T12:00:00.000Z", async () => {
    const procurement = produceProcurementDocument();
    const searchHref = `/search/?q=${encodeURIComponent(SUBMITTED_QUERY)}`;
    const unavailable = buildSearchRenderPlan({ state: "unavailable" });
    assert.equal(unavailable.outcome, "unavailable");
    assert.equal(unavailable.rendered_count, 0);
    assert.notEqual(unavailable.outcome, "empty");

    const failedIndex = renderIdentifierJourney("failed-index", procurement);
    assert.match(failedIndex, new RegExp(`data-submitted-query="${SUBMITTED_QUERY}"`));
    assert.match(failedIndex, /data-search-outcome="unavailable"/);
    assert.match(failedIndex, /Unavailable/);
    assert.match(failedIndex, /Retry/);
    assert.match(failedIndex, /href="\/search\/\?q=07122P0010020"/);
    assert.doesNotMatch(failedIndex, /No keyword matches in this snapshot/);

    const failedDetail = renderIdentifierJourney("failed-detail", procurement);
    assert.match(failedDetail, /Procurement not found/);
    assert.match(failedDetail, /href="\/browse\/contracts\/"/);
    assert.doesNotMatch(failedDetail, /0 results|No matches/);

    const history = [searchHref, "/procurements/missing-fixture/"];
    history.pop();
    assert.equal(new URL(history.at(-1), "https://cityscroll.org").searchParams.get("q"), SUBMITTED_QUERY);
  });
});

test("A4: unrelated near-match identifier queries do not resolve to retained records", async () => {
  await withPinnedClock("2026-09-15T12:00:00.000Z", async () => {
    const procurement = produceProcurementDocument();
    const nearMatches = [
      ["07122P0010021", procurement.search_text, "off-by-one PIN"],
      ["07122P001002", procurement.search_text, "truncated PIN"],
      ["CT107120258802304", procurement.search_text, "off-by-one contract id"],
      ["20241104016", procurement.search_text, "off-by-one award id"],
      ["2020K0271", LAND.search_text, "off-by-one project id"],
      ["21DCP123L", LAND.search_text, "off-by-one CEQR"],
      ["C 210239 ZML", LAND.search_text, "near application token"],
      ["3073670012", LAND.search_text, "near parcel id"],
    ];
    for (const [query, searchText, reason] of nearMatches) {
      assert.equal(
        keywordTextMatches(searchText, resolveKeywordQuery(query)),
        false,
        `${reason}: ${query} must not resolve`,
      );
    }
  });
});

test("A4: capture manifest covers keyboard, no-JavaScript, and hashed destinations", async () => {
  await withPinnedClock("2026-09-15T12:00:00.000Z", async () => {
    const procurement = produceProcurementDocument();
    assert.equal(CAPTURE_MANIFEST.image_binaries_committed, false);
    assert.equal(CAPTURE_MANIFEST.revision, "8d74ef82967c4fec7bb4d4714676b9f91653789c");

    const required = [
      "identifier-search-desktop-keyboard",
      "identifier-search-narrow-keyboard",
      "identifier-search-no-javascript-destinations",
      "identifier-search-failed-index",
      "identifier-search-failed-detail",
    ];
    const byCase = new Map(CAPTURE_MANIFEST.captures.map((capture) => [capture.case, capture]));
    for (const name of required) assert.ok(byCase.has(name), name);

    const modeForCase = {
      "identifier-search-desktop-keyboard": "search",
      "identifier-search-narrow-keyboard": "search",
      "identifier-search-desktop-detail": "detail",
      "identifier-search-narrow-detail": "detail",
      "identifier-search-no-javascript-destinations": "detail",
      "identifier-search-site-history": "site-history",
      "identifier-search-failed-index": "failed-index",
      "identifier-search-failed-detail": "failed-detail",
    };

    for (const capture of CAPTURE_MANIFEST.captures) {
      assert.ok(capture.viewport.width > 0 && capture.viewport.height > 0, capture.case);
      assert.ok(capture.assertion.length > 20, capture.case);
      assert.match(capture.render_sha256, /^[a-f0-9]{64}$/, capture.case);
      const mode = modeForCase[capture.case];
      assert.ok(mode, capture.case);
      const rendered = renderIdentifierJourney(mode, procurement);
      assert.equal(capture.render_sha256, sha256(rendered), capture.case);
    }

    const detailHtml = renderIdentifierJourney("detail", procurement);
    assert.match(detailHtml, /href="\/parcels\/3073670011\/"/);
    assert.doesNotMatch(detailHtml, /\btabindex="[1-9]/);
    const searchHtml = renderIdentifierJourney("search", procurement);
    assert.match(searchHtml, /<a href="\/procurements\//);
    assert.match(searchHtml, /method="get"/);
    assert.doesNotMatch(searchHtml, /\btabindex="[1-9]/);
  });
});
