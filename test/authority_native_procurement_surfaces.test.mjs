import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { agencyRouteAliasTarget } from "../site/agency_identity.mjs";
import { buildAgencyConstellationView } from "../site/agency_constellation_model.mjs";
import { watchFromFollowingParams } from "../site/following_view.mjs";
import { renderProcurementDocument, procurementContractWatchHref } from "../site/procurement_document.mjs";
import { buildProcurementSearchDocuments } from "../site/procurement_search_producer.mjs";
import { buildSharedProcurementReadModelShardArtifacts } from "../site/procurement_read_model_shards.mjs";
import { readKeywordSearchIndexFromShards } from "../site/keyword_search_index_shards.mjs";
import { observationFromMtaCdAwardRow } from "../entity_resolution/cross_domain/object_links.mjs";
import { buildIntelligenceCorpus } from "../entity_resolution/cross_domain/index.mjs";
import { buildProcurementArtifacts } from "../tools/build_shared_procurement_read_model.mjs";
import { matchProcurementDigestRows } from "../site/procurement_digest_compile.mjs";
import { sanitize } from "../worker/src/lib/filter.mjs";
import {
  executeContractGet,
  executeContractsBrowse,
} from "../capabilities/contracts.mjs";
import {
  handleContract,
  handleContractsBrowse,
  workerProcurementContracts,
} from "../worker/src/contracts.mjs";
import edgeWorker from "../site/pages_edge.mjs";

const nativeFixtures = JSON.parse(readFileSync(
  new URL("../warehouse/fixtures/authority-native-procurement/mta-opportunities.v1.json", import.meta.url),
  "utf8",
));
const mtaSources = JSON.parse(readFileSync(
  new URL("../site/data/mta_procurement_sources.json", import.meta.url),
  "utf8",
));
const spineNycha = JSON.parse(readFileSync(
  new URL("../site/data/procurement_spine_sources.json", import.meta.url),
  "utf8",
)).rows.checkbook_nycha_contracts;

const FIXTURES = Object.freeze([
  {
    id: "procurement:contract:BA2335819",
    tokens: ["BA2335819"],
    agency: "housing-authority",
    vendor: "VITAL PLUMBING INC",
    stage: "contract",
  },
  {
    id: "procurement:contract:A37703",
    tokens: ["A37703"],
    agency: "mta-construction-and-development",
    parent: "metropolitan-transportation-authority",
    vendor: "Gramercy Group, Inc.",
    stage: "award",
  },
  {
    id: "procurement:solicitation:S48020",
    tokens: ["S48020", "0000541781"],
    agency: "mta-construction-and-development",
    parent: "metropolitan-transportation-authority",
    stage: "solicitation",
  },
  {
    id: "procurement:contract_reporter_number:2138505",
    tokens: ["2138505"],
    agency: "n-y-c-transit-authority",
    parent: "metropolitan-transportation-authority",
    stage: "solicitation",
  },
  {
    id: "procurement:solicitation:AW9Y",
    tokens: ["AW-9Y", "AW9Y"],
    agency: "mta-construction-and-development",
    parent: "metropolitan-transportation-authority",
    stage: "bid_opening_result",
  },
]);

function buildNativeArtifacts() {
  return buildProcurementArtifacts({
    generated_at: "2026-08-28T16:00:00.000Z",
    rows: {
      passport_contracts: [],
      checkbook_contracts: [],
      checkbook_nycha_contracts: spineNycha,
    },
  }, { rows: [] }, { nativeFixtures, mtaSources });
}

function constellationSources(browse) {
  const notices = browse.rows.filter((row) => (row.source_systems || []).some((system) => (
    /^mta_/.test(String(system || "")) || system === "nys_contract_reporter"
  )));
  return {
    authority_procurement: {
      ...browse,
      open_as_of: browse.generated_at,
      notices,
    },
    native_procurements: browse,
    procurement_browse: browse,
    publisher_agency_rows: [],
  };
}

function categoryItems(view, categoryId) {
  return view.categories.find((category) => category.id === categoryId)?.items || [];
}

const { model, browse, digest } = buildNativeArtifacts();
const corpus = buildProcurementSearchDocuments(model);
const sources = constellationSources(browse);

test("source-native institution aliases resolve to ordinary agency routes", () => {
  assert.equal(agencyRouteAliasTarget("mta-nyct"), "n-y-c-transit-authority");
  assert.equal(agencyRouteAliasTarget("mta-construction-development"), "mta-construction-and-development");
});

test("A1/A2 every admitted NYCHA and MTA fixture has search and Browse results", () => {
  for (const fixture of FIXTURES) {
    const document = corpus.documents.find((entry) => entry.object_ref === fixture.id);
    const row = browse.rows.find((entry) => entry.procurement_id === fixture.id);
    assert.ok(document, `missing search document ${fixture.id}`);
    assert.ok(row, `missing Browse row ${fixture.id}`);
    for (const token of fixture.tokens) assert.match(document.search_text, new RegExp(token.replace(/-/g, "\\-?")));
    assert.equal(row.primary_stage, fixture.stage);
    assert.equal(row.canonical_href, `/procurements/${encodeURIComponent(fixture.id)}`);
    assert.equal(row.agency_id, fixture.agency);
    assert.ok(row.entity_refs_all.includes(`agency:id:${fixture.agency}`));
    if (fixture.parent) assert.ok(row.entity_refs_all.includes(`agency:id:${fixture.parent}`));
    assert.doesNotMatch(JSON.stringify(row.entity_refs_all), /agency:id:agency:id:/);
  }
});

test("A3 canonical detail routes return 200 with inspectable source receipts", async () => {
  const artifacts = buildSharedProcurementReadModelShardArtifacts(model);
  const env = {
    ASSETS: {
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/data/shared_procurement_read_model.json") return Response.json(artifacts.manifest);
        const shardIndex = artifacts.manifest.shards.findIndex((descriptor) => `/data/${descriptor.path}` === path);
        if (shardIndex >= 0) return Response.json(artifacts.shards[shardIndex]);
        return new Response("asset", { status: 200 });
      },
    },
  };
  for (const fixture of FIXTURES) {
    const response = await edgeWorker.fetch(new Request(
      `https://cityscroll.org/procurements/${encodeURIComponent(fixture.id)}`,
    ), env);
    assert.equal(response.status, 200, fixture.id);
    const html = await response.text();
    for (const token of fixture.tokens) assert.match(html, new RegExp(token.replace(/-/g, "\\-?")));
    const object = model.rows.find((row) => row.procurement_id === fixture.id);
    const rendered = renderProcurementDocument(object, model.observations);
    assert.match(rendered, /Official records|official/i);
    assert.doesNotMatch(rendered, /authority-native|coverage matrix|warning banner|public authorities/i);
    if (fixture.stage === "bid_opening_result") {
      assert.match(rendered, /bid opening result/);
      assert.doesNotMatch(rendered, /<strong>award<\/strong>/);
    }
  }
});

test("A4 agency constellation keeps operating entities and the MTA parent distinct", () => {
  const nycha = buildAgencyConstellationView("housing-authority", sources);
  const cd = buildAgencyConstellationView("mta-construction-and-development", sources);
  const parent = buildAgencyConstellationView("metropolitan-transportation-authority", sources);
  const nyct = buildAgencyConstellationView("n-y-c-transit-authority", sources);
  const tbta = buildAgencyConstellationView("triborough-bridge-and-tunnel-authority", sources);
  const refs = (view) => categoryItems(view, "contracts").map((item) => item.subject_ref);

  assert.ok(refs(nycha).includes("procurement:contract:BA2335819"));
  assert.ok(refs(cd).includes("procurement:contract:A37703"));
  assert.ok(refs(cd).includes("procurement:solicitation:S48020"));
  assert.ok(refs(cd).includes("procurement:solicitation:AW9Y"));
  assert.ok(refs(parent).includes("procurement:contract:A37703"));
  assert.ok(refs(parent).includes("procurement:solicitation:S48020"));
  assert.ok(refs(nyct).includes("procurement:contract_reporter_number:2138505"));
  assert.equal(refs(tbta).includes("procurement:contract:A37703"), false);
  assert.equal(tbta.categories.find((category) => category.id === "contracts").status, "empty");
  const bid = categoryItems(cd, "contracts").find((item) => item.subject_ref === "procurement:solicitation:AW9Y");
  assert.equal(bid.object_kind, "bid_opening_result");
  const award = categoryItems(cd, "contracts").find((item) => item.subject_ref === "procurement:contract:A37703");
  assert.equal(award.object_kind, "award");
  assert.equal(award.operating_entity_name, "MTA Construction & Development");
});

test("A5 admitted award vendors remain on ordinary vendor relationships", () => {
  const award = mtaSources.cd_awards[0].normalized_snapshot;
  const observation = observationFromMtaCdAwardRow(award);
  const corpus = buildIntelligenceCorpus([observation], { max_entities: 8, prefer_multi_domain: false });
  const gramercy = Object.values(corpus.by_ref).find((entity) => entity.root?.kind === "vendor");
  assert.match(gramercy.root.display_name, /Gramercy Group/);
  assert.match(JSON.stringify(gramercy), /A37703/);
  const bidObservation = observationFromMtaCdAwardRow({
    observation_type: "bid_opening_result",
    vendor_name: "TDP ASSOCIATES INC",
    contract_id: "AW-9Y",
  });
  assert.equal(bidObservation, null);
});

test("A6/A7 Follow and digest compile the canonical procurement identity", () => {
  for (const fixture of FIXTURES) {
    const href = procurementContractWatchHref(fixture.id);
    const watch = watchFromFollowingParams(new URL(href, "https://cityscroll.org").searchParams);
    assert.equal(watch.lens, "money");
    assert.equal(watch.filter.procurement_id, fixture.id);
    const sanitized = sanitize("money", watch.filter);
    const rows = matchProcurementDigestRows(digest, sanitized, { lens: "money" });
    assert.equal(rows.length, 1, fixture.id);
    assert.equal(rows[0].procurement_id, fixture.id);
  }
});

test("A8/A9 HTTP API and MCP match website identity, receipt, and population", async () => {
  const env = { PROCUREMENT_READ_MODEL: model };
  const provider = workerProcurementContracts(env);
  const ids = FIXTURES.map((fixture) => fixture.id).sort();
  const present = (values) => values.filter((id) => ids.includes(id)).sort();
  assert.deepEqual(present(corpus.documents.map((document) => document.object_ref)), ids);
  assert.deepEqual(present(browse.rows.map((row) => row.procurement_id)), ids);
  assert.deepEqual(present(model.rows.map((row) => row.procurement_id)), ids);

  for (const fixture of FIXTURES) {
    const row = browse.rows.find((entry) => entry.procurement_id === fixture.id);
    const direct = await executeContractGet(provider.get, { procurementId: fixture.id });
    const http = await handleContract(new Request(
      `https://api.cityscroll.org/contract?id=${encodeURIComponent(fixture.id)}`,
    ), env);
    assert.equal(http.status, 200, fixture.id);
    assert.deepEqual(await http.json(), direct);
    assert.equal(direct.contract.procurement_id, fixture.id);
    assert.deepEqual(direct.contract.source_observation_refs, row.source_observation_refs);
    assert.equal(direct.contract.fields.official_url, row.official_url);
    assert.ok(direct.contract.fields.official_url);
    assert.equal(direct.contract.fields.primary_stage, fixture.stage);
  }

  const browseApi = await executeContractsBrowse(provider.browse, { limit: 100 });
  const browseHttp = await handleContractsBrowse(new Request("https://api.cityscroll.org/contracts?limit=100"), env);
  assert.equal(browseHttp.status, 200);
  assert.deepEqual(await browseHttp.json(), browseApi);
  assert.deepEqual(present(browseApi.results.map((entry) => entry.procurement_id)), ids);

  const mcpSource = readFileSync(new URL("../worker/src/mcp.mjs", import.meta.url), "utf8");
  assert.match(mcpSource, /executeContractGet/);
  assert.match(mcpSource, /executeContractsBrowse/);
  assert.doesNotMatch(mcpSource, /identity_keys|prime_contract_ids|source_observation_refs/);
});

test("A10/A11 empty unrelated agency sections stay empty and no authority explainer is added", () => {
  const tbta = buildAgencyConstellationView("triborough-bridge-and-tunnel-authority", sources);
  const contracts = tbta.categories.find((category) => category.id === "contracts");
  assert.equal(contracts.status, "empty");
  assert.equal(contracts.count, 0);
  const source = [
    readFileSync(new URL("../site/procurement_search_producer.mjs", import.meta.url), "utf8"),
    readFileSync(new URL("../site/agency_constellation_model.mjs", import.meta.url), "utf8"),
    readFileSync(new URL("../site/procurement_document.mjs", import.meta.url), "utf8"),
  ].join("\n");
  assert.doesNotMatch(source, /coverage matrix|authority explainer|public-authorities tutorial|not in City Record because/i);
});

test("committed keyword index still contains every admitted fixture token", () => {
  const indexed = readKeywordSearchIndexFromShards(new URL(
    "../worker/src/data/keyword_search_index_shards/manifest.json",
    import.meta.url,
  ));
  const blob = JSON.stringify(indexed.families.procurements.documents);
  for (const fixture of FIXTURES) {
    assert.match(blob, new RegExp(fixture.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    for (const token of fixture.tokens) assert.match(blob, new RegExp(token.replace(/-/g, "\\-?")));
  }
});
