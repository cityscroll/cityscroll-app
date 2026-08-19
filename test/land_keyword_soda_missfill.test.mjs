/**
 * Hybrid land keyword miss-fill — exact SODA canary fill + timestamped hybrid as-of.
 *
 *   node --test test/land_keyword_soda_missfill.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

import { LAND_ZAP_FRESHNESS_CANARIES } from "../warehouse/lib/zap_freshness.mjs";
import { resolveKeywordQuery } from "../site/keyword_matcher.mjs";
import {
  LAND_KEYWORD_HYBRID_STATE,
  LAND_KEYWORD_PUBLISHED_STATE,
  LAND_KEYWORD_SODA_MISSFILL,
  fetchExactLandCanaryRows,
  fillLandKeywordCanaryMisses,
  landKeywordAsOfReceipt,
  landKeywordDocumentFromSodaRow,
  landKeywordHybridAsOf,
  missingLandKeywordCanaries,
  searchLandKeywordFamily,
  sodaExactLandProjectUrl,
} from "../site/land_keyword_soda_missfill.mjs";

const PUBLISHED_AS_OF = "2026-08-01T08:00:00.000Z";
const SODA_AS_OF = "2026-08-19T15:30:00.000Z";
const GREENPOINT = {
  project_id: "2025Q0331",
  project_name: "44-17 Greenpoint Avenue Rezoning",
  public_status: "In Public Review",
  project_status: "Active",
  borough: "Queens",
  community_district: "Q02",
  current_milestone: "Community Board Referral",
  primary_applicant: "Greenpoint Applicant",
};
const BEDFORD = {
  project_id: "2026K0123",
  project_name: "1550 Bedford Avenue Rezoning",
  public_status: "Noticed",
  project_status: "Active",
  borough: "Brooklyn",
  community_district: "K09",
  current_milestone: "Notice of Public Hearing",
};

function publishedFamily({ documents = [], asOf = PUBLISHED_AS_OF } = {}) {
  return {
    source: "NYC Open Data Zoning Application Portal projects",
    as_of: asOf,
    source_row_count: documents.length,
    indexed_count: documents.length,
    documents,
  };
}

function publishedCanaryDocument(row) {
  return landKeywordDocumentFromSodaRow(row, {
    fetchedAt: PUBLISHED_AS_OF,
    liveMissfill: false,
  });
}

test("miss-fill canaries stay aligned with the land freshness canary register", () => {
  assert.deepEqual(
    LAND_ZAP_FRESHNESS_CANARIES.map((canary) => canary.project_id),
    ["2025Q0331", "2026K0123"],
  );
});

test("exact SODA canary URL matches project_id equality, not a keyword scan", () => {
  const url = sodaExactLandProjectUrl("2025Q0331");
  const decoded = decodeURIComponent(url);
  assert.match(url, /hgx4-8ukb\.json/);
  assert.match(decoded, /project_id='2025Q0331'/);
  assert.doesNotMatch(decoded, /\$q=/);
  assert.doesNotMatch(decoded, /LIKE/i);
  assert.equal(sodaExactLandProjectUrl("../etc/passwd"), null);
});

test("published family without canaries reports both holes", () => {
  const missing = missingLandKeywordCanaries([
    { object_ref: "land_use_project:2022M0258" },
  ]);
  assert.deepEqual(missing.map((canary) => canary.project_id), ["2025Q0331", "2026K0123"]);
});

test("A1: SODA exact rows fill canary holes in the keyword family", () => {
  const family = publishedFamily({
    documents: [{
      object_ref: "land_use_project:2022M0258",
      title: "Gowanus Neighborhood Rezoning",
      search_text: "Gowanus Neighborhood Rezoning 2022M0258",
    }],
  });
  const filled = fillLandKeywordCanaryMisses({
    family,
    sodaRows: [GREENPOINT, BEDFORD],
    sodaFetchedAt: SODA_AS_OF,
  });
  assert.deepEqual([...filled.filled_project_ids], ["2025Q0331", "2026K0123"]);
  const greenpoint = filled.documents.find((doc) => doc.object_ref === "land_use_project:2025Q0331");
  assert.ok(greenpoint);
  assert.equal(greenpoint.provenance.missfill, LAND_KEYWORD_SODA_MISSFILL);
  assert.equal(greenpoint.provenance.source_freshness.generated_at, SODA_AS_OF);
  assert.match(greenpoint.search_text, /2025Q0331/);
});

test("A2: hybrid as-of is timestamped and is not the published warehouse clock", () => {
  const freshness = landKeywordHybridAsOf({
    warehouseAsOf: PUBLISHED_AS_OF,
    sodaFetchedAt: SODA_AS_OF,
    filledProjectIds: ["2025Q0331"],
  });
  assert.equal(freshness.state, LAND_KEYWORD_HYBRID_STATE);
  assert.equal(freshness.warehouse_as_of, PUBLISHED_AS_OF);
  assert.equal(freshness.soda_as_of, SODA_AS_OF);
  assert.equal(freshness.as_of, SODA_AS_OF);
  assert.notEqual(freshness.as_of, freshness.warehouse_as_of);
  assert.equal(
    landKeywordAsOfReceipt(freshness),
    `as of ${SODA_AS_OF} · published snapshot plus live records`,
  );
  const published = landKeywordHybridAsOf({ warehouseAsOf: PUBLISHED_AS_OF });
  assert.equal(published.state, LAND_KEYWORD_PUBLISHED_STATE);
  assert.equal(published.as_of, PUBLISHED_AS_OF);
  assert.equal(landKeywordAsOfReceipt(published), `as of ${PUBLISHED_AS_OF}`);
});

test("search recovers an exact canary id from SODA when the publish loop left a hole", async () => {
  const family = publishedFamily({
    documents: [publishedCanaryDocument(BEDFORD)],
  });
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    assert.match(decodeURIComponent(String(url)), /project_id='2025Q0331'/);
    return {
      ok: true,
      async json() { return [GREENPOINT]; },
    };
  };
  const result = await searchLandKeywordFamily(
    family,
    resolveKeywordQuery("2025Q0331"),
    { fetchImpl, now: new Date(SODA_AS_OF) },
  );
  assert.equal(calls.length, 1);
  assert.equal(result.matches[0].object_ref, "land_use_project:2025Q0331");
  assert.equal(result.freshness.state, LAND_KEYWORD_HYBRID_STATE);
  assert.equal(result.freshness.as_of, SODA_AS_OF);
  assert.equal(result.freshness.warehouse_as_of, PUBLISHED_AS_OF);
  assert.match(result.source, /published snapshot plus live records/);
});

test("title queries recover a missing canary after exact SODA miss-fill", async () => {
  const family = publishedFamily({ documents: [] });
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes("2025Q0331")) {
      return { ok: true, async json() { return [GREENPOINT]; } };
    }
    if (href.includes("2026K0123")) {
      return { ok: true, async json() { return [BEDFORD]; } };
    }
    throw new Error(`unexpected SODA url ${href}`);
  };
  const result = await searchLandKeywordFamily(
    family,
    resolveKeywordQuery("Greenpoint"),
    { fetchImpl, now: new Date(SODA_AS_OF) },
  );
  assert.equal(result.matches[0].object_ref, "land_use_project:2025Q0331");
  assert.equal(result.freshness.state, LAND_KEYWORD_HYBRID_STATE);
});

test("complete published family never fetches SODA and stays warehouse-fresh", async () => {
  const family = publishedFamily({
    documents: [
      publishedCanaryDocument(GREENPOINT),
      publishedCanaryDocument(BEDFORD),
    ],
  });
  let calls = 0;
  const result = await searchLandKeywordFamily(
    family,
    resolveKeywordQuery("2025Q0331"),
    {
      fetchImpl: async () => {
        calls += 1;
        throw new Error("SODA must not run when canaries are published");
      },
      now: new Date(SODA_AS_OF),
    },
  );
  assert.equal(calls, 0);
  assert.equal(result.matches[0].object_ref, "land_use_project:2025Q0331");
  assert.equal(result.freshness.state, LAND_KEYWORD_PUBLISHED_STATE);
  assert.equal(result.freshness.as_of, PUBLISHED_AS_OF);
  assert.doesNotMatch(result.source, /live records/);
});

test("unrelated queries do not present unused miss-fills as hybrid", async () => {
  const family = publishedFamily({ documents: [] });
  const result = await searchLandKeywordFamily(
    family,
    resolveKeywordQuery("mosquito"),
    {
      fetchImpl: async () => ({ ok: true, async json() { return [GREENPOINT]; } }),
      now: new Date(SODA_AS_OF),
    },
  );
  assert.equal(result.matches.length, 0);
  assert.equal(result.freshness.state, LAND_KEYWORD_PUBLISHED_STATE);
  assert.equal(result.freshness.as_of, PUBLISHED_AS_OF);
});

test("SODA miss fails closed to the published miss, not a silent empty warehouse snapshot", async () => {
  const family = publishedFamily({ documents: [] });
  const result = await searchLandKeywordFamily(
    family,
    resolveKeywordQuery("2025Q0331"),
    {
      fetchImpl: async () => ({ ok: false, status: 503, async json() { return []; } }),
      now: new Date(SODA_AS_OF),
    },
  );
  assert.equal(result.matches.length, 0);
  assert.equal(result.freshness.state, LAND_KEYWORD_PUBLISHED_STATE);
  assert.equal(result.soda_errors[0].project_id, "2025Q0331");
});

test("exact fetch only keeps the requested canary id", async () => {
  const fetched = await fetchExactLandCanaryRows(["2025Q0331"], {
    now: new Date(SODA_AS_OF),
    fetchImpl: async () => ({
      ok: true,
      async json() { return [GREENPOINT, BEDFORD]; },
    }),
  });
  assert.deepEqual(fetched.rows.map((row) => row.project_id), ["2025Q0331"]);
  assert.equal(fetched.fetched_at, SODA_AS_OF);
});
