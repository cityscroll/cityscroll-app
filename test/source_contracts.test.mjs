import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { AWARD_SOURCE_REGISTRY } from "../site/external_awards.js";
import { checkGeneratedSourceFiles } from "../tools/generate_source_docs.mjs";
import {
  awardCoverage,
  classifyMocsFieldCase,
  loadSourceContractFixtures,
  loadSourceContracts,
  resolveProbeEndpoint,
  validateSourceContractFixtures,
  validateSourceContracts,
  verifyCodeReferences,
} from "../tools/source_contracts.mjs";
import {
  formatFetchError,
  verifyCheckbook,
  verifyHtml,
  verifySocrata,
} from "../tools/verify_source_contracts.mjs";

test("source-contract registry is valid and its generated public docs are current", () => {
  const registry = loadSourceContracts();
  assert.deepEqual(validateSourceContracts(registry), []);
  assert.deepEqual(validateSourceContractFixtures(registry, loadSourceContractFixtures()), []);
  assert.deepEqual(verifyCodeReferences(registry), []);
  assert.deepEqual(checkGeneratedSourceFiles(), []);
});

test("OCP and ZAP contracts record their warehouse product snapshots", () => {
  const registry = loadSourceContracts();
  const expected = {
    "ocp-recent-contract-awards": {
      artifact: "site/data/ocp_awards_warehouse_lookup.json",
      row_count: 53245,
    },
    "zap-projects": {
      artifact: "site/data/zap_projects_warehouse_lookup.json",
      row_count: 231,
    },
    "zap-bbl": {
      artifact: "site/data/zap_bbl_warehouse_lookup.json",
      row_count: 50514,
    },
  };

  for (const [id, snapshot] of Object.entries(expected)) {
    const contract = registry.contracts.find((entry) => entry.id === id);
    assert.equal(contract.delivery_tier, "edge-materialized");
    assert.equal(contract.warehouse_snapshot.status, "materialized");
    assert.equal(contract.warehouse_snapshot.artifact, snapshot.artifact);
    assert.equal(contract.warehouse_snapshot.row_count, snapshot.row_count);
    assert.match(contract.warehouse_snapshot.materialized_at, /^2026-08-0[25]T/);
  }
});

test("LL48 contract records the exact-BBL graph-slice measurement", () => {
  const registry = loadSourceContracts();
  const contract = registry.contracts.find((entry) => entry.id === "suitability-city-owned-leased-property-ll48");
  assert.equal(contract.dataset_id, "4e2n-s75z");
  assert.deepEqual(contract.required_fields, ["bbl", "address", "parcel_name", "agency", "potential_urban_ag", "date_created"]);
  assert.equal(contract.join_measurement.eligible, 320);
  assert.equal(contract.join_measurement.linked, 23);
  assert.equal(contract.join_measurement.rate, 0.0719);
  assert.equal(contract.warehouse_snapshot.artifact, "site/data/property_ll48_lookup.json");
});

test("recorded fixtures reject missing fields and non-tabular source shapes", () => {
  const registry = loadSourceContracts();
  const missingField = structuredClone(loadSourceContractFixtures());
  missingField.sources.find((source) => source.id === "city-record").fields = [];
  assert.match(
    validateSourceContractFixtures(registry, missingField).join("\n"),
    /city-record: fixture is missing fields/,
  );

  const nonTabular = structuredClone(loadSourceContractFixtures());
  nonTabular.sources.find((source) => source.id === "city-record").asset_type = "href";
  assert.match(
    validateSourceContractFixtures(registry, nonTabular).join("\n"),
    /city-record: fixture is not tabular Socrata metadata/,
  );
});

test("pull-request CI requires fixtures while live drift runs on a daily alerting lane", () => {
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const live = readFileSync(
    new URL("../.github/workflows/source-contracts-live.yml", import.meta.url),
    "utf8",
  );
  assert.match(ci, /name: Recorded civic-data source contracts[\s\S]*node tools\/verify_source_contracts\.mjs/);
  assert.doesNotMatch(ci, /verify_source_contracts\.mjs --live/);
  assert.match(live, /schedule:[\s\S]*cron:/);
  assert.match(live, /node tools\/verify_source_contracts\.mjs --live/);
  assert.match(live, /issues: write/);
  assert.match(live, /Report upstream drift[\s\S]*issues\.create/);
});

test("ABO source contracts match the runtime registry and derive coverage prose", () => {
  const registry = loadSourceContracts();
  const coverage = awardCoverage(AWARD_SOURCE_REGISTRY);
  const contractDatasets = registry.contracts
    .filter((contract) => contract.id.startsWith("abo-"))
    .map((contract) => contract.dataset_id)
    .sort();
  assert.deepEqual(contractDatasets, coverage.datasets);
  assert.deepEqual(coverage, {
    aliases: 13,
    authorities: 12,
    sourcePairs: 12,
    nycha: 1,
    absent: 16,
    datasets: ["8w5p-k45m", "d84c-dk28", "ehig-g5x3"],
  });
});

test("MOCS field-case fixture classifies both retired IDs as unusable", () => {
  const fixture = JSON.parse(readFileSync(
    new URL("./fixtures/source_contracts/mocs-field-case.json", import.meta.url),
  ));
  assert.deepEqual(classifyMocsFieldCase(
    fixture.configured.metadata,
    fixture.configured.resource,
    fixture.documented.resource,
  ), {
    configuredNonTabular: true,
    documentedMissing: true,
  });
});

test("live Socrata verification rejects non-tabular and stale sources", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const contract = {
    id: "field-case",
    domain: "https://data.example.gov",
    dataset_id: "aaaa-bbbb",
    required_fields: ["record_id"],
    max_stale_days: 7,
  };

  globalThis.fetch = async () => new Response(JSON.stringify({
    assetType: "href",
    columns: [],
    rowsUpdatedAt: Math.floor(Date.now() / 1000),
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  await assert.rejects(verifySocrata(contract), /expected a tabular dataset/);

  globalThis.fetch = async () => new Response(JSON.stringify({
    assetType: "dataset",
    columns: [{ fieldName: "record_id" }],
    rowsUpdatedAt: 1,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  await assert.rejects(verifySocrata(contract), /source is stale/);
});

test("formatFetchError always names source id and URL class", () => {
  const err = new Error("fetch failed");
  err.cause = { code: "ENOTFOUND", hostname: "example.invalid", message: "getaddrinfo ENOTFOUND" };
  const message = formatFetchError("city-record", "metadata", err, "https://example.invalid/api");
  assert.match(message, /^city-record: metadata fetch failed/);
  assert.match(message, /ENOTFOUND/);
  assert.doesNotMatch(message, /^fetch failed$/);
});

test("checkbook-spending contract matches product contract_id spending shape", () => {
  const registry = loadSourceContracts();
  const spending = registry.contracts.find((c) => c.id === "checkbook-spending");
  assert.ok(spending);
  assert.equal(spending.data_type, "Spending");
  assert.deepEqual(spending.required_fields, [
    "contract_id",
    "payee_name",
    "check_amount",
    "issue_date",
  ]);
  assert.ok(spending.probe_contract_id);
  assert.match(spending.product_freshness, /contract_id/i);
  assert.doesNotMatch(spending.product_freshness, /Queried by PIN/i);
});

test("live Checkbook spending probe uses contract_id criteria and real field names", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const bodies = [];
  globalThis.fetch = async (url, options = {}) => {
    bodies.push(options.body || "");
    const xml = `<?xml version="1.0"?>
      <response><status><result>success</result></status>
      <result_records><spending_transactions>
      <transaction>
        <contract_id>CT107120248803393</contract_id>
        <payee_name>EXAMPLE VENDOR</payee_name>
        <check_amount>100.00</check_amount>
        <issue_date>2025-07-01</issue_date>
      </transaction>
      </spending_transactions></result_records></response>`;
    return new Response(xml, { status: 200, headers: { "Content-Type": "application/xml" } });
  };
  const detail = await verifyCheckbook({
    id: "checkbook-spending",
    endpoint: "https://www.checkbooknyc.com/api",
    data_type: "Spending",
    required_fields: ["contract_id", "payee_name", "check_amount", "issue_date"],
    probe_contract_id: "CT107120248803393",
  });
  assert.match(detail, /Spending/);
  assert.match(bodies[0], /<type_of_data>Spending<\/type_of_data>/);
  assert.match(bodies[0], /<name>contract_id<\/name>/);
  assert.match(bodies[0], /CT107120248803393/);
  assert.doesNotMatch(bodies[0], /<name>pin<\/name>/);
});

test("pointer-class Socrata sources skip the ingest freshness gate", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes("/api/views/")) {
      return new Response(JSON.stringify({
        assetType: "dataset",
        columns: [
          { fieldName: "pid" },
          { fieldName: "project_name" },
          { fieldName: "managing_agency" },
          { fieldName: "client_agency" },
          { fieldName: "budget_forecast" },
          { fieldName: "current_phase" },
        ],
        rowsUpdatedAt: 1, // ancient
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify([{ pid: "1" }]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const detail = await verifySocrata({
    id: "capital-projects",
    domain: "https://data.cityofnewyork.us",
    dataset_id: "n7gv-k5yt",
    required_fields: [
      "pid", "project_name", "managing_agency", "client_agency",
      "budget_forecast", "current_phase",
    ],
    max_stale_days: 120,
    contract_class: "pointer",
    stale_policy: "skip",
  });
  assert.match(detail, /pointer/i);
  assert.doesNotMatch(detail, /source is stale/);
});

test("capital-projects registry row is pointer-class with no ingest freshness gate", () => {
  const registry = loadSourceContracts();
  const capital = registry.contracts.find((c) => c.id === "capital-projects");
  assert.equal(capital.contract_class, "pointer");
  assert.equal(capital.stale_policy, "skip");
  assert.equal(capital.status, "disabled");
});

test("templated and auth machine endpoints resolve to probeable URLs", () => {
  const registry = loadSourceContracts();
  const zap = registry.contracts.find((c) => c.id === "zap-api-outcomes");
  const legistar = registry.contracts.find((c) => c.id === "nyc-council-legistar");
  assert.equal(
    resolveProbeEndpoint(zap),
    "https://zap-api-production.herokuapp.com/projects/2022M0258",
  );
  assert.equal(
    resolveProbeEndpoint(legistar),
    "https://webapi.legistar.com/v1/nyc/Bodies?$top=1",
  );
  assert.equal(legistar.auth_token_env, "LEGISTAR_API_TOKEN");
  assert.equal(zap.endpoint_format, "json-api");
});

test("bot-blocked HTML with healthy machine endpoint is not drift", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes("contractData.js")) {
      return new Response("var public_ctr_data = " + JSON.stringify([["EPIN1234567890"].concat(Array(20).fill("x"))]) + ";", {
        status: 200,
        headers: { "Content-Type": "application/javascript" },
      });
    }
    return new Response("blocked", { status: 403, headers: { "Content-Type": "text/html" } });
  };
  const detail = await verifyHtml({
    id: "passport-public-contracts",
    landing_page: "https://a0333-passportpublic.nyc.gov/contracts.html",
    endpoint: "https://a0333-passportpublic.nyc.gov/dataJs/contractData.js",
    endpoint_format: "js-dump",
    landing_probe: "bot_blocked",
    required_fields: ["epin"],
  });
  assert.match(detail, /machine dump reachable|HTML \+ machine dump/i);
  assert.match(detail, /bot-blocked/i);
});

test("known bot-blocked landing without machine endpoint is explicit, not a 403 failure", async () => {
  const detail = await verifyHtml({
    id: "nycida-build-nyc-projects",
    landing_page: "https://edc.nyc/about-nycedc/financial-public-documents-recordings",
    landing_probe: "bot_blocked",
  });
  assert.match(detail, /known bot-blocked/i);
});

test("live workflow wires optional LEGISTAR_API_TOKEN for the auth probe", () => {
  const live = readFileSync(
    new URL("../.github/workflows/source-contracts-live.yml", import.meta.url),
    "utf8",
  );
  assert.match(live, /LEGISTAR_API_TOKEN:\s*\$\{\{\s*secrets\.LEGISTAR_API_TOKEN\s*\}\}/);
  assert.match(live, /node tools\/build_boards_wall_receipt\.mjs --live/);
});

test("bot-blocked machine endpoint 403 on CI is not drift for egress_class sources", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response("blocked", {
    status: 403,
    headers: { "Content-Type": "text/html" },
  });
  const detail = await verifyHtml({
    id: "passport-public-contracts",
    landing_page: "https://a0333-passportpublic.nyc.gov/contracts.html",
    endpoint: "https://a0333-passportpublic.nyc.gov/dataJs/contractData.js",
    endpoint_format: "js-dump",
    landing_probe: "bot_blocked",
    egress_class: "bot_blocked",
    required_fields: ["epin"],
  });
  assert.match(detail, /bot-blocked machine endpoint/i);
  assert.match(detail, /product worker/i);
});

test("passport-public contracts declare bot-blocked CI egress", () => {
  const registry = loadSourceContracts();
  for (const id of ["passport-public-contracts", "passport-public-rfx"]) {
    const c = registry.contracts.find((row) => row.id === id);
    assert.equal(c.egress_class, "bot_blocked");
    assert.equal(c.landing_probe, "bot_blocked");
    assert.ok(c.endpoint.includes("dataJs"));
  }
});
