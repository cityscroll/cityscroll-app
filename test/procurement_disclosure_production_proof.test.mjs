import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import edgeWorker from "../site/pages_edge.mjs";
import {
  normalizePerformanceEvidenceItem,
} from "../site/analytical_performance_evidence.mjs";
import { renderProcurementDocument } from "../site/procurement_document.mjs";
import { buildProcurementSearchDocuments } from "../site/procurement_search_producer.mjs";
import { resolveKeywordQuery, searchKeywordDocuments } from "../site/keyword_matcher.mjs";
import {
  EMMONS_CHECKBOOK_ANCHOR,
  handleContractLifecycle,
} from "../worker/src/checkbook_lifecycle.mjs";
import {
  CONTRACTS as DISCLOSURE_CONTRACTS,
  FIXTURE_SCHEMA,
  PRODUCTION_SCHEMA,
  TOOL as DISCLOSURE_CAPTURE_TOOL,
  assertFixtureManifest,
  assertProductionReadback,
} from "../tools/capture_procurement_disclosure_production_proof.mjs";
import { solicitationFixture } from "./fixtures/procurement_project_context_fixtures.mjs";
import { withPinnedClock } from "./helpers/test_clock.mjs";

const manifest = JSON.parse(readFileSync(new URL("../site/data/shared_procurement_read_model.json", import.meta.url)));
const performance = JSON.parse(readFileSync(new URL("../site/data/analytics_performance_evidence.json", import.meta.url)));
const projectContext = JSON.parse(readFileSync(new URL("../site/data/procurement_project_context.json", import.meta.url)));
const renderManifest = JSON.parse(readFileSync(new URL("../docs/evidence/procurement-disclosure-production-proof/manifest.json", import.meta.url)));
const productionReadback = JSON.parse(readFileSync(new URL("../docs/evidence/procurement-disclosure-production-proof/production-readback.json", import.meta.url)));
const bhragsDetail = JSON.parse(readFileSync(new URL("./fixtures/procurement-detail-parity/ct107120258801626.json", import.meta.url)));

const CONTRACTS = {
  "CT110220271400991": { amount: "$62,500", vendor: "S &amp; P GLOBAL MARKET INTELLIGENCE LLC" },
  "CT105720278802113": { amount: "$46,673.32", vendor: "AMERICAN HEART ASSOCIATION INC" },
  "CT104020273009333": { amount: "$25,000", vendor: "QUIZIZZ INC" },
  "CT185720228800365": { amount: "$49,689.78", vendor: "FIREMATIC SUPPLY CO. INC", method: "Amendment" },
  "CT185020228802305": { amount: "$26,112.93", vendor: "TAMEER INC", method: "Construction Change Order" },
  "CT107120258801626": { amount: "$10,869,881", vendor: "BHRAGS HOME CARE CORP" },
};

function shardFor(id) {
  const path = manifest.procurement_shard_by_id[`procurement:contract:${id}`];
  assert.ok(path, `materialized shard for ${id}`);
  return JSON.parse(readFileSync(new URL(`../site/data/${path}`, import.meta.url)));
}

function assetEnvironment() {
  return {
    ASSETS: {
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/data/shared_procurement_read_model.json") return new Response(JSON.stringify(manifest));
        if (path.startsWith("/data/shared_procurement_read_model/")) {
          const shard = path.slice("/data/".length);
          return new Response(readFileSync(new URL(`../site/data/${shard}`, import.meta.url)));
        }
        return new Response("<!doctype html><html><head><title>CityScroll</title></head><body><main id=\"noticeview\"></main></body></html>");
      },
    },
  };
}

async function servedContract(id, headers = {}) {
  const response = await edgeWorker.fetch(new Request(
    `https://cityscroll.org/procurements/${encodeURIComponent(`procurement:contract:${id}`)}/`,
    { headers },
  ), assetEnvironment());
  assert.equal(response.status, 200, id);
  return response.text();
}

function noticeRow(id) {
  for (const shardName of new Set(Object.values(manifest.procurement_shard_by_id))) {
    const shard = JSON.parse(readFileSync(new URL(`../site/data/${shardName}`, import.meta.url)));
    const observation = shard.observations?.find((row) => row.source_system === "city_record" && row.source_system_id === id);
    if (observation) return observation.snapshot;
  }
  const relation = projectContext.relations.find((entry) => entry.solicitation.request_id === id)?.solicitation;
  if (relation) {
    return {
      request_id: id,
      short_title: relation.title,
      agency_name: relation.managing_agency,
      type_of_notice_description: relation.notice_type,
      pin: relation.structured_pin,
      additional_description_1: relation.notice_body_pin,
    };
  }
  throw new Error(`no materialized notice row for ${id}`);
}

class TestHTMLRewriter {
  constructor(response) { this.response = response; this.handlers = []; }
  on(selector, handlers) { this.handlers.push({ selector, handlers }); return this; }
  async transform(response = this.response) {
    let html = await response.text();
    for (const { selector, handlers } of this.handlers) {
      if (selector === "#noticeview") {
        html = html.replace(/<main id="noticeview"><\/main>/, () => {
          const element = { setInnerContent: (value) => { element.content = value; } };
          handlers.element(element);
          return `<main id="noticeview">${element.content || ""}</main>`;
        });
      }
    }
    return new Response(html, { status: response.status, headers: response.headers });
  }
}

test("A1: real canonical routes never label metadata or summaries as public contract documents", async () => {
  for (const id of Object.keys(CONTRACTS)) {
    const html = await servedContract(id);
    assert.doesNotMatch(html, /executed contract|pricing schedule|performance terms|evaluation document/i, id);
    assert.match(html, /Checkbook NYC|PASSPort Public contracts/, id);
    assert.doesNotMatch(html, /href="https?:\/\/(?!cityscroll\.org)[^\"]*(?:contract|document)[^\"]*CT/i, id);
  }
});

test("A1: a positive document label is accepted only with URL, exact identity, and dated passage evidence", () => {
  const qualifyingInput = {
    kind: "performance_terms",
    label: "Public performance terms",
    source_passage: {
      source_id: "city-record-awards",
      document_id: "award-notice-2026-001",
      url: "https://www.nyc.gov/assets/example/award-notice-2026-001.pdf",
      locator: "Page 4, Performance Requirements",
      excerpt: "The contractor shall meet the published response-time standard.",
      publication_date: "2026-08-01",
      identity_basis: "exact contract identifier CT-FIXTURE-001",
    },
  };
  const qualifying = normalizePerformanceEvidenceItem(qualifyingInput);
  assert.deepEqual(qualifying, {
    kind: "performance_terms",
    label: "Public performance terms",
    source_passage: {
      source_id: "city-record-awards",
      document_id: "award-notice-2026-001",
      url: "https://www.nyc.gov/assets/example/award-notice-2026-001.pdf",
      locator: "Page 4, Performance Requirements",
      excerpt: "The contractor shall meet the published response-time standard.",
      publication_date: "2026-08-01",
      identity_basis: "exact contract identifier CT-FIXTURE-001",
    },
  });
  assert.equal(normalizePerformanceEvidenceItem({
    kind: "performance_terms",
    source_passage: { ...qualifying.source_passage, url: "https://a0333-passportpublic.nyc.gov/login" },
  }), null, "a login destination cannot qualify as document evidence");
  assert.equal(normalizePerformanceEvidenceItem({
    ...qualifyingInput,
    document_role: "metadata",
  }), null, "source metadata cannot satisfy a positive document label");
  assert.equal(normalizePerformanceEvidenceItem({
    ...qualifyingInput,
    document_role: "project_summary",
  }), null, "a project summary cannot satisfy a positive document label");
  assert.equal(normalizePerformanceEvidenceItem({
    kind: "performance_terms",
    source_passage: { ...qualifying.source_passage, identity_basis: "" },
  }), null, "an identity basis is required, not merely surviving when present");
  assert.equal(normalizePerformanceEvidenceItem({
    kind: "performance_terms",
    source_passage: { ...qualifying.source_passage, publication_date: "" },
  }), null, "a dated passage is required, not merely surviving when present");
});

test("A2: zero accepted performance rows remain an explicit bounded absence on the served routes", async () => {
  assert.ok(performance.rows.length > 0, "registered-contract population is present");
  assert.ok(performance.rows.every((row) => row.evidence_state === "no-located-evidence" && row.unresolved === true));
  assert.match(performance.absence_scope, /does not establish that evidence does not exist/i);
  assert.match(performance.absence_scope, /vendor failed/i);
  const html = await servedContract("CT110220271400991");
  assert.doesNotMatch(html, /no obligations|vendor failed|services failed|document does not exist/i);
  assert.doesNotMatch(html, /<h2>Performance evidence<\/h2>/i);
});

test("A3: real canonical routes preserve the named facts and museum notice route preserves whole-project context", async () => {
  for (const [id, expected] of Object.entries(CONTRACTS)) {
    const html = await servedContract(id);
    assert.match(html, new RegExp(id), id);
    assert.match(html, new RegExp(expected.amount.replace(/[.$]/g, "\\$&")), id);
    assert.match(html, new RegExp(expected.vendor.replace(/[.]/g, "\\.")), id);
    if (expected.method) assert.match(html, new RegExp(expected.method), id);
  }

  const prior = globalThis.fetch;
  const priorRewriter = globalThis.HTMLRewriter;
  globalThis.HTMLRewriter = TestHTMLRewriter;
  globalThis.fetch = async (request) => {
    const url = new URL(request.url || request);
    if (url.hostname === "api.cityscroll.org" && url.pathname === "/notice") {
      return new Response(JSON.stringify({ row: noticeRow(url.searchParams.get("id")), civic_time: null }));
    }
    throw new Error(`unexpected notice source request: ${url}`);
  };
  try {
    const env = assetEnvironment();
    for (const id of ["20240829105", "20260810048"]) {
      const response = await edgeWorker.fetch(new Request(`https://cityscroll.org/notices/${id}/`), env);
      assert.equal(response.status, 200, id);
      const html = await response.text();
      assert.match(html, new RegExp(id), id);
      if (id === "20240829105") assert.match(html, /Comfort Inn|BHRAGS/i);
      if (id === "20260810048") {
        assert.match(html, /BCM-HVAC Upgrades/);
        assert.match(html, /ACEDCA215/);
        assert.match(html, /19,905,485|19905485/);
        assert.match(html, /June 25, 2029|2029-06-25/);
        assert.match(html, /85026B0110/);
        assert.match(html, /85026B01107/);
      }
    }
    assert.ok(projectContext.relations.some((entry) => entry.solicitation.request_id === "20260810048"));
  } finally {
    globalThis.fetch = prior;
    globalThis.HTMLRewriter = priorRewriter;
  }
});

test("A3: shelter contract-lifecycle route and museum project-code search resolve locally", async () => {
  const priorFetch = globalThis.fetch;
  let publisherAttempts = 0;
  globalThis.fetch = async () => {
    publisherAttempts += 1;
    throw new Error("publisher egress blocked");
  };
  try {
    const lifecycle = {
      ok: true,
      assembly_version: 5,
      request_id: EMMONS_CHECKBOOK_ANCHOR.request_id,
      contract_id: EMMONS_CHECKBOOK_ANCHOR.contract_id,
      pin: EMMONS_CHECKBOOK_ANCHOR.pin,
      timeline: [{ stage: "registered", status: "matched" }],
      payment_as_of: "2026-08-06",
      payment_total: 7385672.19,
      payment_count: 31,
      ocp_award: { status: "matched" },
      civic_events: [],
      award_prime_goal: { status: "unavailable" },
    };
    const db = {
      prepare() {
        return {
          bind() { return this; },
          async first() { return { lifecycle: JSON.stringify(lifecycle) }; },
        };
      },
    };
    const response = await handleContractLifecycle(
      new Request(`https://api.cityscroll.org/contract-lifecycle?id=${EMMONS_CHECKBOOK_ANCHOR.request_id}`),
      { DB: db },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.id, "20240829105");
    assert.equal(body.ok, true);
    assert.equal(body.contract_id, "CT107120258801626");
    assert.equal(body.pin, "07124E0044001");
    assert.equal(body.payment_total, 7385672.19);
    assert.equal(publisherAttempts, 0, "lifecycle read stays on the cached snapshot");
  } finally {
    globalThis.fetch = priorFetch;
  }

  const fixture = solicitationFixture("20260810048");
  const documents = buildProcurementSearchDocuments({
    schema: "cityscroll.shared_procurement_read_model.v1",
    rows: [{ ...fixture.object, object_type: "procurement" }],
    observations: fixture.observations,
    sources: {},
  }).documents;
  const matches = searchKeywordDocuments(documents, resolveKeywordQuery("ACEDCA215"), { limit: 100 });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].object_ref, fixture.object.procurement_id);
  assert.equal(matches[0].provenance.notice_evidence[0].request_id, "20260810048");
  assert.equal(matches[0].provenance.notice_evidence[0].href, "/notices/20260810048");
});

test("A4: real canonical routes credit source handoffs and refuse misleading revision/base claims", async () => {
  const sp = await servedContract("CT110220271400991");
  assert.match(sp, /checkbooknyc\.com\/smart_search\/citywide\?search_term=CT110220271400991/);
  assert.doesNotMatch(sp, /City Record notice/);
  const cityRecord = sp.match(/data-source-system="city_record"[^>]*data-coverage-state="([^"]+)"[\s\S]*?<\/li>/i);
  assert.ok(cityRecord, "S&P retains a City Record coverage row");
  assert.equal(cityRecord[1], "checked-no-match");
  assert.match(cityRecord[0], /City Record/);
  assert.match(cityRecord[0], /Checked 2026-09-09/);
  assert.match(cityRecord[0], /data-coverage-state="checked-no-match"/);
  assert.doesNotMatch(cityRecord[0], /lookup as of|exact_pin|Importer coverage:/);
  assert.match(sp, /10220272001881/, "City Record absence stays bound to the PIN that was checked");
  assert.match(sp, /data-coverage-reader-projection="1"/);
  assert.doesNotMatch(sp, /never (?:published|appeared) in (?:the )?City Record|absent from City Record forever/i);
  assert.doesNotMatch(sp, /Importer coverage:/);
  const aha = await servedContract("CT105720278802113");
  assert.match(aha, /PASSPort Public contracts/);
  const bhrags = await servedContract("CT107120258801626");
  assert.match(bhrags, /checkbooknyc\.com|Checkbook NYC/);
  assert.match(bhrags, /\$10,869,881/);
  assert.match(bhrags, /20240829105/);
  assert.match(bhrags, /Paid amount<\/dt><dd>\$7,385,672\.19/);
  assert.match(bhrags, /data-payment-total-spent="7385672\.19"/);
  assert.match(bhrags, /Encumbered amount<\/dt><dd>\$7,319,455\.52/);
  assert.match(bhrags, /data-retained-paid-amount="7319455\.51"/);
  assert.match(bhrags, /Showing 12 of 31 payments on this contract/);
  assert.match(bhrags, /20270016167-1-DSB-EFT/);
  assert.match(bhrags, /\$66,591\.17/);
  assert.match(bhrags, /\$54,214\.14/);
  const bhragsSpending = bhrags.match(/data-source-system="checkbook_spending"[\s\S]*?<\/li>/)?.[0] || "";
  assert.match(bhragsSpending, /No exact match in analytics spending lookup/);
  assert.match(bhragsSpending, /Checked 2026-08-26/);
  assert.doesNotMatch(bhrags, /had no exact payment match in this snapshot/);
  const firematic = await servedContract("CT185720228800365");
  assert.match(firematic, /Amendment/);
  assert.doesNotMatch(firematic, /small base contract|overall contract value/i);
  const tameer = await servedContract("CT185020228802305");
  assert.match(tameer, /Construction Change Order/);
  assert.doesNotMatch(tameer, /small base contract|overall contract value/i);
  for (const id of Object.keys(CONTRACTS)) {
    const html = await servedContract(id);
    const canonical = `https://cityscroll.org/procurements/${encodeURIComponent(`procurement:contract:${id}`)}`;
    const cityscrollUrls = [...html.matchAll(/https:\/\/cityscroll\.org\/[^\s"'<>]*/g)].map((match) => match[0]);
    assert.ok(cityscrollUrls.every((url) => url === canonical || !/\/procurements\//.test(url)), `${id} invents no other procurement canonical URL`);
    assert.doesNotMatch(html, /better than (?:Checkbook|PASSPort)|unlike (?:Checkbook|PASSPort)|more (?:complete|detailed) than (?:Checkbook|PASSPort)/i, `${id} makes no unsupported comparison claim`);
  }
});

test("A5: real canonical routes remain keyboard-linkable and server-rendered at desktop and mobile request variants", async () => {
  for (const id of Object.keys(CONTRACTS)) {
    const desktop = await servedContract(id, { "X-Test-Viewport": "1440x900" });
    const mobile = await servedContract(id, { "X-Test-Viewport": "390x844" });
    for (const [html, viewport] of [[desktop, "desktop"], [mobile, "mobile"]]) {
      const links = [...html.matchAll(/<a\b[^>]*href="[^"]+"/g)];
      assert.ok(links.length > 0, `${id} ${viewport} has native links`);
      assert.doesNotMatch(html, /tabindex=["']-1["']/i, `${id} ${viewport} has no negative tabindex`);
      assert.doesNotMatch(html, /<h2(?:\s[^>]*)?>\s*<\/h2>/i, `${id} ${viewport} has no empty heading`);
    }
    assert.equal(desktop, mobile, `${id} has deterministic server-rendered markup across viewport variants`);
  }
});

test("A5: optional enrichment failure retains the record, facts, and a working source link", async () => {
  await withPinnedClock("2026-09-09T06:33:01.880Z", () => {
    const html = renderProcurementDocument(bhragsDetail.object, bhragsDetail.observations, { lookups: {} });
    assert.match(html, /CT107120258801626/);
    assert.match(html, /BHRAGS HOME CARE CORP/);
    assert.match(html, /\$10,869,881|10869881/);
    assert.match(html, /href="https:\/\/a856-cityrecord\.nyc\.gov\/RequestDetail\/20240829105"/, "working official source link survives enrichment failure");
    assert.match(html, /data-source-system="checkbook_contracts"[^>]*data-coverage-state="not-checked"/);
    assert.doesNotMatch(html, /<h2(?:\s[^>]*)?>\s*<\/h2>/i);
    assert.doesNotMatch(html, /enrichment failed|unable to load enrichment/i);
  });
});

test("A5: committed manifest records each route, viewport, vintage, assertion, and render hash", async () => {
  assertFixtureManifest(renderManifest);
  assert.equal(renderManifest.schema, FIXTURE_SCHEMA);
  await withPinnedClock(renderManifest.capture_clock, async () => {
    const entries = new Map(renderManifest.entries.map((entry) => [`${entry.route}|${entry.viewport}`, entry]));
    assert.equal(entries.size, Object.keys(CONTRACTS).length * 2);
    for (const id of Object.keys(CONTRACTS)) {
      for (const [viewport, header] of [["desktop", "1440x900"], ["mobile", "390x844"]]) {
        const html = await servedContract(id, { "X-Test-Viewport": header });
        const route = `/procurements/procurement%3Acontract%3A${id}/`;
        const entry = entries.get(`${route}|${viewport}`);
        assert.ok(entry, `${route} ${viewport} manifest entry`);
        assert.equal(entry.revision, renderManifest.revision);
        assert.equal(entry.data_vintage, performance.snapshot_date);
        assert.ok(entry.assertion);
        const hash = createHash("sha256").update(html).digest("hex");
        assert.equal(entry.sha256, hash);
      }
    }
  });
});

test("A3/A5: committed production read-back retains live URLs, served build vintage, assertions, and results", () => {
  assertProductionReadback(productionReadback);
  assert.equal(productionReadback.schema, PRODUCTION_SCHEMA);
  assert.equal(productionReadback.public_alias, "c755c57ebdc96");
  assert.equal(productionReadback.provenance.observer.tool, DISCLOSURE_CAPTURE_TOOL);
  assert.equal(productionReadback.served_build.live_base, "https://cityscroll.org");
  assert.equal(productionReadback.served_build.api_base, "https://api.cityscroll.org");
  assert.ok(productionReadback.served_build.shared_procurement_read_model_generated_at);
  assert.ok(productionReadback.served_build.performance_evidence_snapshot_date);
  assert.ok(productionReadback.served_build.pages_deploy_commit);
  assert.equal(productionReadback.counts.failed, 0);
  assert.equal(productionReadback.counts["not-yet-observed"], 0);
  assert.ok(productionReadback.counts.passed >= 18);
  assert.equal(productionReadback.render_entries.length, Object.keys(DISCLOSURE_CONTRACTS).length * 2);

  const byId = new Map(productionReadback.paths.map((row) => [row.id, row]));
  for (const id of Object.keys(DISCLOSURE_CONTRACTS)) {
    const contract = byId.get(`contract-${id}`);
    const viewport = byId.get(`viewport-${id}`);
    assert.equal(contract?.state, "passed", id);
    assert.equal(viewport?.state, "passed", id);
    assert.match(contract.url, new RegExp(id));
    assert.equal(contract.method, "GET");
  }
  assert.equal(byId.get("sp-city-record-bound")?.state, "passed");
  assert.equal(byId.get("notice-20240829105")?.state, "passed");
  assert.equal(byId.get("notice-20260810048")?.state, "passed");
  assert.equal(byId.get("contract-lifecycle-20240829105")?.state, "passed");
  assert.equal(byId.get("search-ACEDCA215")?.state, "passed");
  assert.equal(byId.get("enrichment-failure-live-boundary")?.state, "passed");

  for (const entry of productionReadback.render_entries) {
    assert.ok(entry.live_url.startsWith("https://cityscroll.org/procurements/"));
    assert.ok(["desktop", "mobile"].includes(entry.viewport));
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    assert.ok(entry.assertion);
    assert.equal(entry.http_status, 200);
  }
});
