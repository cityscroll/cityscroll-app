import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import edgeWorker from "../site/pages_edge.mjs";
import {
  normalizePerformanceEvidenceItem,
} from "../site/analytical_performance_evidence.mjs";
import { renderProcurementDocument } from "../site/procurement_document.mjs";
import { buildProcurementSearchDocuments } from "../site/procurement_search_producer.mjs";
import { resolveKeywordQuery, searchKeywordDocuments } from "../site/keyword_matcher.mjs";
import { buildSharedProcurementReadModel } from "../site/shared_procurement_read_model.mjs";
import { procurementSourceRecordsFromMaterializations } from "../tools/build_shared_procurement_read_model.mjs";
import { mapContractRow } from "../worker/src/lib/passport_parse.mjs";
import {
  EMMONS_CHECKBOOK_ANCHOR,
  handleContractLifecycle,
} from "../worker/src/checkbook_lifecycle.mjs";
import {
  CONTRACTS as DISCLOSURE_CONTRACTS,
  EVIDENCE_TYPES,
  FIXTURE_SCHEMA,
  PRODUCTION_SCHEMA,
  REQUIRED_OBLIGATIONS,
  TOOL as DISCLOSURE_CAPTURE_TOOL,
  assertFixtureManifest,
  assertProductionReadback,
  classifyBhragsPaymentConsistency,
  classifyBrowserObservation,
  classifyContractHtml,
  classifyServedIdentity,
  cloneEnvelope,
  evaluateProductionReadiness,
  implementationDeliveryResult,
  moneyNeedles,
} from "../tools/capture_procurement_disclosure_production_proof.mjs";
import { productionPathObservation, productionProvenance } from "../tools/lib/production_provenance.mjs";
import { solicitationFixture } from "./fixtures/procurement_project_context_fixtures.mjs";
import { testClockISOString, withPinnedClock } from "./helpers/test_clock.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(new URL("../site/data/shared_procurement_read_model.json", import.meta.url)));
const performance = JSON.parse(readFileSync(new URL("../site/data/analytics_performance_evidence.json", import.meta.url)));
const projectContext = JSON.parse(readFileSync(new URL("../site/data/procurement_project_context.json", import.meta.url)));
const renderManifest = JSON.parse(readFileSync(new URL("../docs/evidence/procurement-disclosure-production-proof/manifest.json", import.meta.url)));
const productionReadbackPath = new URL("../docs/evidence/procurement-disclosure-production-proof/production-readback.json", import.meta.url);
const productionReadback = JSON.parse(readFileSync(productionReadbackPath));
const bhragsDetail = JSON.parse(readFileSync(new URL("./fixtures/procurement-detail-parity/ct107120258801626.json", import.meta.url)));

const CONTRACTS = {
  CT110220271400991: { amount: "$62,500", vendor: "S &amp; P GLOBAL MARKET INTELLIGENCE LLC" },
  CT105720278802113: { amount: "$46,673.32", vendor: "AMERICAN HEART ASSOCIATION INC" },
  CT104020273009333: { amount: "$25,000", vendor: "QUIZIZZ INC" },
  CT185720228800365: { amount: "$49,689.78", vendor: "FIREMATIC SUPPLY CO. INC", method: "Amendment" },
  CT185020228802305: { amount: "$26,112.93", vendor: "TAMEER INC", method: "Construction Change Order" },
  CT107120258801626: { amount: "$10,869,881", vendor: "BHRAGS HOME CARE CORP" },
};

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

function passportCells({
  ctr, epin, contract, title, vendor, type, method, amount, registration,
  award = amount, current = amount, encumbered = amount, paid = amount,
  start = "09/01/2026", end = "08/31/2027",
}) {
  return [
    ctr, epin, contract, title, "TEST AGENCY", vendor, "TEST PROGRAM", method,
    type, "Registered", award, current, encumbered, paid, start, end,
    registration, "Goods", "", "", "", "",
  ];
}

function retainedFirematicHtml() {
  const base = mapContractRow(passportCells({
    ctr: "4561064", epin: "85721B0111001A000", contract: "CT185720228800365",
    title: "Bid 2100089 Nozzles", vendor: "FIREMATIC SUPPLY CO. INC",
    type: "Original", method: "Competitive Sealed Bid", amount: "$158,997.84", current: "$208,687.62",
    paid: "$158,997.84", encumbered: "$158,997.84", registration: "09/01/2021",
  }));
  const action = mapContractRow(passportCells({
    ctr: "4618449", epin: "85721B0111001A001", contract: "CT185720228800365",
    title: "Bid 2100089 Nozzles Amendment #1", vendor: "FIREMATIC SUPPLY CO. INC",
    type: "Amendment", method: "Amendment", amount: "$49,689.78",
    paid: "$158,997.84", encumbered: "$158,997.84", registration: "11/13/2021",
  }));
  const records = procurementSourceRecordsFromMaterializations({
    generated_at: testClockISOString(),
    rows: { passport_contracts: [base, action] },
  }, { rows: [] });
  const model = buildSharedProcurementReadModel({
    sourceRecords: records,
    lifecycleRows: [],
    generatedAt: testClockISOString(),
    now: testClockISOString(),
  });
  return renderProcurementDocument(model.rows[0], model.observations, { lookups: {} });
}

function retainedTameerHtml() {
  const ids = ["4579402", "4980664", "4982079", "4983925", "5224471", "5240965", "5243993", "5247650", "5340426", "5359354", "5371783", "5372858"];
  const amounts = [1442820.77, 26512.93, 27112.93, 27612.93, 28112.93, 28612.93, 29112.93, 29612.93, 30112.93, 30612.93, 31112.93, 26112.93];
  const currents = [1779343.45, ...amounts.slice(1)];
  const rows = ids.map((ctr, index) => mapContractRow(passportCells({
    ctr,
    epin: `85021B0087001C${String(index + 1).padStart(3, "0")}`,
    contract: "CT185020228802305",
    title: index === 0
      ? "LBC10CDHC"
      : `LBC10CDHC Change Order #${index === 9 ? 11 : index === 10 ? 8 : index}`,
    vendor: "TAMEER INC",
    type: index === 0 ? "Original" : "Revision",
    method: index === 0 ? "Competitive Sealed Bid" : "Construction Change Order",
    amount: `$${amounts[index].toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
    current: `$${currents[index].toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
    registration: "04/14/2025",
  })));
  const records = procurementSourceRecordsFromMaterializations({
    generated_at: testClockISOString(),
    rows: { passport_contracts: rows },
  }, { rows: [] });
  const model = buildSharedProcurementReadModel({
    sourceRecords: records,
    lifecycleRows: [],
    generatedAt: testClockISOString(),
    now: testClockISOString(),
  });
  return renderProcurementDocument(model.rows[0], model.observations, { lookups: {} });
}

function passedPath(id, evidence_type, extras = {}) {
  return {
    ...productionPathObservation({
      id,
      url: `https://cityscroll.org/${id}`,
      status: 200,
      state: "passed",
      assertion: `${id} passed`,
      evidence: extras.evidence || { ok: true },
    }),
    evidence_type,
  };
}

function buildCompleteEnvelope(overrides = {}) {
  const paths = REQUIRED_OBLIGATIONS.map((obligation) => passedPath(
    obligation.id,
    obligation.evidence_type,
  ));
  const render_entries = Object.keys(DISCLOSURE_CONTRACTS).flatMap((id) => (
    ["desktop", "mobile"].map((viewport) => ({
      route: `/procurements/${encodeURIComponent(`procurement:contract:${id}`)}/`,
      live_url: `https://cityscroll.org/procurements/${encodeURIComponent(`procurement:contract:${id}`)}/`,
      viewport,
      data_vintage: "2026-09-16",
      assertion: `${viewport} render`,
      sha256: createHash("sha256").update(`${id}:${viewport}`).digest("hex"),
      http_status: 200,
    }))
  ));
  const counts = {
    passed: paths.length,
    failed: 0,
    "not-yet-observed": 0,
    total: paths.length,
    render_entries: render_entries.length,
  };
  const observedAt = "2026-09-16T18:00:00.000Z";
  const envelope = {
    schema: PRODUCTION_SCHEMA,
    title: "Procurement disclosure production read-back",
    public_alias: "cdef57e5c9127",
    capture_policy: "textual",
    served_build: {
      live_base: "https://cityscroll.org",
      api_base: "https://api.cityscroll.org",
      pages_deploy_commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      pages_deploy_completed_at: "2026-09-16T17:00:00.000Z",
      shared_procurement_read_model_generated_at: "2026-09-16T16:00:00.000Z",
      performance_evidence_snapshot_date: "2026-09-16",
    },
    served_identity: classifyServedIdentity({
      observerRevision: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      pagesDeploy: {
        head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        updated_at: "2026-09-16T17:00:00.000Z",
      },
      artifactManifest: {
        source_commit_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        artifact_hash: "ccc",
      },
      freshnessReport: {
        deployment_identity: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      observedAt,
      sourceVintages: {
        shared_procurement_read_model_generated_at: "2026-09-16T16:00:00.000Z",
        performance_evidence_snapshot_date: "2026-09-16",
      },
    }),
    implementation_delivery: implementationDeliveryResult({
      fixtureManifestPresent: true,
      validatorPresent: true,
      offlineMutationCoverage: true,
    }),
    provenance: productionProvenance({
      observed_at: observedAt,
      tool: DISCLOSURE_CAPTURE_TOOL,
      source_revision: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      bases: ["https://cityscroll.org", "https://api.cityscroll.org"],
    }),
    required_obligations: REQUIRED_OBLIGATIONS,
    paths,
    render_entries,
    findings: [],
    counts,
  };
  envelope.production_readiness = evaluateProductionReadiness(envelope);
  return { ...envelope, ...overrides };
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
  assert.equal(qualifying.kind, "performance_terms");
  assert.equal(normalizePerformanceEvidenceItem({
    kind: "performance_terms",
    source_passage: { ...qualifying.source_passage, url: "https://a0333-passportpublic.nyc.gov/login" },
  }), null, "a login destination cannot qualify as document evidence");
});

test("A1: retained Firematic and TAMEER fixtures satisfy original/current/action field-role obligations", async () => {
  await withPinnedClock("2026-09-09T12:00:00Z", () => {
    const firematicHtml = retainedFirematicHtml();
    const firematic = classifyContractHtml({
      id: "CT185720228800365",
      expected: DISCLOSURE_CONTRACTS.CT185720228800365,
      status: 200,
      body: firematicHtml,
    });
    assert.equal(firematic.state, "passed");
    assert.equal(firematic.evidence_type, EVIDENCE_TYPES.DOM_FIELD_ROLE);
    assert.deepEqual(firematic.evidence.field_roles, {
      original: 158997.84,
      current: 208687.62,
      action: 49689.78,
    });

    const tameerHtml = retainedTameerHtml();
    // Retained complete-family materialization must carry original and current.
    assert.match(tameerHtml, /Original contract amount<\/dt><dd>\$1,442,820\.77/);
    assert.match(tameerHtml, /Current contract total<\/dt><dd>\$1,779,343\.45/);
    // Classifier positive path for the retained action amount on revision 5372858.
    const tameerLabeled = tameerHtml.replace(
      /<dt>Action amount<\/dt><dd>[^<]+<\/dd>/,
      "<dt>Action amount</dt><dd>$26,112.93</dd>",
    );
    const tameer = classifyContractHtml({
      id: "CT185020228802305",
      expected: DISCLOSURE_CONTRACTS.CT185020228802305,
      status: 200,
      body: tameerLabeled,
    });
    assert.equal(tameer.state, "passed", JSON.stringify(tameer.evidence));
    assert.deepEqual(tameer.evidence.field_roles, {
      original: 1442820.77,
      current: 1779343.45,
      action: 26112.93,
    });
  });
});

test("A1: current materialized Firematic/TAMEER pages reproduce the missing field-role defect", async () => {
  const firematicHtml = await servedContract("CT185720228800365");
  const firematic = classifyContractHtml({
    id: "CT185720228800365",
    expected: DISCLOSURE_CONTRACTS.CT185720228800365,
    status: 200,
    body: firematicHtml,
  });
  assert.equal(firematic.state, "failed");
  assert.ok(firematic.evidence.fieldRoleMissing.some((row) => row.role === "original" || row.role === "current"));

  const tameerHtml = await servedContract("CT185020228802305");
  const tameer = classifyContractHtml({
    id: "CT185020228802305",
    expected: DISCLOSURE_CONTRACTS.CT185020228802305,
    status: 200,
    body: tameerHtml,
  });
  assert.equal(tameer.state, "failed");
  assert.ok(tameer.evidence.fieldRoleMissing.length >= 1);
});

test("A1: BHRAGS payment consistency requires headline/section agreement, 31 payments, dates, and scoped coverage", async () => {
  const html = await servedContract("CT107120258801626");
  const observed = classifyBhragsPaymentConsistency({ status: 200, body: html });
  // Current materialization still carries the conflicting PASSPort headline beside the lifecycle payment section.
  assert.equal(observed.state, "failed");
  assert.ok(observed.evidence.failures.includes("headline_payment_section_mismatch")
    || observed.evidence.failures.includes("paid_total_not_retained_lifecycle"));

  const repaired = html
    .replace(/<dt>Paid amount<\/dt><dd>\$7,319,455\.51<\/dd>/, "<dt>Paid amount</dt><dd>$7,385,672.19</dd>");
  const ok = classifyBhragsPaymentConsistency({ status: 200, body: repaired });
  // May still fail scoped coverage; if headline matches and count/latest present, mismatch is gone.
  assert.ok(!ok.evidence?.failures?.includes("headline_payment_section_mismatch"));
  assert.ok(moneyNeedles(7385672.19).some((needle) => repaired.includes(needle)));
});

test("A2: zero accepted performance rows remain an explicit bounded absence on the served routes", async () => {
  assert.ok(performance.rows.length > 0, "registered-contract population is present");
  assert.ok(performance.rows.every((row) => row.evidence_state === "no-located-evidence" && row.unresolved === true));
  const html = await servedContract("CT110220271400991");
  assert.doesNotMatch(html, /no obligations|vendor failed|services failed|document does not exist/i);
  assert.doesNotMatch(html, /<h2>Performance evidence<\/h2>/i);
});

test("A2: assertProductionReadback enumerates required obligations and rejects incomplete envelopes", () => {
  const complete = buildCompleteEnvelope();
  assertProductionReadback(complete, { requireReady: true });
  assert.equal(complete.production_readiness.ready, true);

  const missingPath = cloneEnvelope(complete);
  missingPath.paths = missingPath.paths.filter((row) => row.id !== "browser-museum-desktop");
  missingPath.counts = {
    passed: missingPath.paths.filter((row) => row.state === "passed").length,
    failed: 0,
    "not-yet-observed": 0,
    total: missingPath.paths.length,
    render_entries: missingPath.render_entries.length,
  };
  missingPath.production_readiness = evaluateProductionReadiness(missingPath);
  assert.throws(() => assertProductionReadback(missingPath), /missing required obligation: browser-museum-desktop/);

  const duplicate = cloneEnvelope(complete);
  duplicate.paths.push(cloneEnvelope(duplicate.paths[0]));
  assert.throws(() => assertProductionReadback(duplicate), /duplicate obligation id/);

  const zeroCounts = cloneEnvelope(complete);
  zeroCounts.counts = { passed: 0, failed: 0, "not-yet-observed": 0, total: 0, render_entries: zeroCounts.render_entries.length };
  assert.throws(() => assertProductionReadback(zeroCounts), /does not match recomputed/);

  const apiForDom = cloneEnvelope(complete);
  const target = apiForDom.paths.find((row) => row.id === "browser-museum-desktop");
  target.evidence_type = EVIDENCE_TYPES.API_JSON;
  target.evidence = { results: [{ canonical_href: "/notices/20260810048" }] };
  assert.throws(() => assertProductionReadback(apiForDom), /evidence_type/);

  const oldHeadline = cloneEnvelope(complete);
  const payment = oldHeadline.paths.find((row) => row.id === "bhrags-payment-consistency");
  payment.state = "failed";
  payment.assertion = "old paid headline beside correct payment section";
  payment.evidence = {
    failures: ["headline_payment_section_mismatch"],
    headline_paid: 7319455.51,
    payment_section_spent: 7385672.19,
  };
  oldHeadline.counts = {
    passed: oldHeadline.paths.filter((row) => row.state === "passed").length,
    failed: oldHeadline.paths.filter((row) => row.state === "failed").length,
    "not-yet-observed": 0,
    total: oldHeadline.paths.length,
    render_entries: oldHeadline.render_entries.length,
  };
  oldHeadline.production_readiness = evaluateProductionReadiness(oldHeadline);
  assert.equal(oldHeadline.production_readiness.ready, false);
  assert.throws(() => assertProductionReadback(oldHeadline, { requireReady: true }), /not ready/);
  assertProductionReadback(oldHeadline, { requireReady: false });
});

test("A3: real canonical routes preserve named vendor facts and museum notice route preserves whole-project context in edge HTML", async () => {
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
  } finally {
    globalThis.fetch = prior;
    globalThis.HTMLRewriter = priorRewriter;
  }
});

function pythonPlaywrightChromiumAvailable() {
  const probe = spawnSync(
    "python3",
    [
      "-c",
      "from playwright.sync_api import sync_playwright\n"
      + "with sync_playwright() as p:\n"
      + "    browser = p.chromium.launch(headless=True)\n"
      + "    browser.close()\n",
    ],
    { encoding: "utf8", timeout: 60_000, env: process.env },
  );
  return probe.status === 0;
}

test("A3: HTML equality and API substitutes never satisfy browser_dom obligations", () => {
  const substitute = classifyBrowserObservation({
    id: "browser-museum-desktop",
    url: "https://cityscroll.org/notices/20260810048/",
    viewport: "desktop",
    http_status: 200,
    after_app_ready: true,
    after_notice_settled: true,
    assertions: { project_context_visible: true },
    substitute_kind: "html_equality",
  });
  assert.equal(substitute.state, "failed");
  const apiSubstitute = classifyBrowserObservation({
    id: "browser-search-ACEDCA215",
    url: "https://cityscroll.org/search/?q=ACEDCA215",
    viewport: "desktop",
    http_status: 200,
    after_app_ready: true,
    after_notice_settled: true,
    assertions: { result_link_present: true, result_link_opens_notice: true },
    substitute_kind: "api_json",
  });
  assert.equal(apiSubstitute.state, "failed");
});

test("A3: actual browser at desktop and mobile after app readiness keeps museum scope and search opens the notice", (t) => {
  if (!pythonPlaywrightChromiumAvailable()) {
    t.skip("Python playwright Chromium is not launchable in this lane");
    return;
  }
  const script = join(ROOT, "tools/capture_procurement_disclosure_browser_proof.py");
  assert.ok(existsSync(script));
  const result = spawnSync("python3", [script, "--mode", "offline", "--json-stdout"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 180_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  const byId = new Map(payload.observations.map((row) => [row.id, row]));
  for (const id of ["browser-museum-desktop", "browser-museum-mobile", "browser-search-ACEDCA215"]) {
    const observation = byId.get(id);
    assert.ok(observation, id);
    const classified = classifyBrowserObservation(observation);
    assert.equal(classified.state, "passed", `${id}: ${JSON.stringify(classified.evidence)}`);
    assert.equal(classified.evidence_type, EVIDENCE_TYPES.BROWSER_DOM);
  }
});

test("A3: offline wipe mutation reproduces loss of museum scope after notice settlement", (t) => {
  if (!pythonPlaywrightChromiumAvailable()) {
    t.skip("Python playwright Chromium is not launchable in this lane");
    return;
  }
  const result = spawnSync(
    "python3",
    ["tools/capture_procurement_disclosure_browser_proof.py", "--mode", "offline", "--wipe-project-context", "--json-stdout"],
    { cwd: ROOT, encoding: "utf8", timeout: 180_000 },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  const desktop = classifyBrowserObservation(payload.observations.find((row) => row.id === "browser-museum-desktop"));
  assert.equal(desktop.state, "failed");
  assert.ok(desktop.evidence.failedAssertions.includes("project_context_visible")
    || desktop.evidence.failedAssertions.includes("project_context_present"));
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
  assert.equal(matches[0].provenance.notice_evidence[0].request_id, "20260810048");
});

test("A4: served identity binds observer revision, artifact commit, and source vintages separately", () => {
  const matched = classifyServedIdentity({
    observerRevision: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    pagesDeploy: { head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", updated_at: "2026-09-16T17:00:00Z" },
    artifactManifest: { source_commit_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", artifact_hash: "h" },
    freshnessReport: { deployment_identity: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    observedAt: "2026-09-16T18:00:00Z",
    sourceVintages: { performance_evidence_snapshot_date: "2026-09-16" },
  });
  assert.equal(matched.status, "matched");
  assert.equal(matched.observer_revision, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  assert.equal(matched.source_acquisition_vintages.performance_evidence_snapshot_date, "2026-09-16");

  const unproven = classifyServedIdentity({
    observerRevision: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    observedAt: "2026-09-16T18:00:00Z",
  });
  assert.equal(unproven.status, "unproven");

  const pre = classifyServedIdentity({
    observerRevision: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    pagesDeploy: { head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", updated_at: "2026-09-16T19:00:00Z" },
    artifactManifest: { source_commit_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    observedAt: "2026-09-16T18:00:00Z",
  });
  assert.equal(pre.status, "pre_deployment");

  const unrelated = classifyServedIdentity({
    observerRevision: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    pagesDeploy: { head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", updated_at: "2026-09-16T17:00:00Z" },
    artifactManifest: { source_commit_sha: "dddddddddddddddddddddddddddddddddddddddd" },
    observedAt: "2026-09-16T18:00:00Z",
  });
  assert.equal(unrelated.status, "mismatched");
});

test("A4: later attributable source observation may update amounts without silently rewriting the pin", () => {
  const expected = {
    ...DISCLOSURE_CONTRACTS.CT185720228800365,
    field_roles: { original: 158997.84, current: 210000.00, action: 49689.78 },
    field_role_observation: {
      kind: "dated_newer_source",
      observed_at: "2026-09-16T12:00:00Z",
      note: "Newer PASSPort current total with attributable acquisition evidence.",
    },
  };
  const body = `
    CT185720228800365
    <dt>Original contract amount</dt><dd>$158,997.84</dd>
    <dt>Current contract total</dt><dd>$210,000.00</dd>
    <dt>Action amount</dt><dd>$49,689.78</dd>
    <dt>Vendor</dt><dd>FIREMATIC SUPPLY CO. INC</dd>
    Amendment Checkbook NYC
    <a href="https://example.test">source</a>
  `;
  const classified = classifyContractHtml({
    id: "CT185720228800365",
    expected,
    status: 200,
    body,
  });
  assert.equal(classified.state, "passed");
  assert.equal(classified.evidence.field_role_observation.kind, "dated_newer_source");
  assert.notEqual(classified.evidence.field_roles.current, 208687.62);
});

test("A5: optional enrichment failure retains the record, facts, and a working source link", async () => {
  await withPinnedClock("2026-09-09T06:33:01.880Z", () => {
    const html = renderProcurementDocument(bhragsDetail.object, bhragsDetail.observations, { lookups: {} });
    assert.match(html, /CT107120258801626/);
    assert.match(html, /BHRAGS HOME CARE CORP/);
    assert.match(html, /href="https:\/\/a856-cityrecord\.nyc\.gov\/RequestDetail\/20240829105"/);
  });
});

test("A5: committed fixture manifest records each route, viewport, vintage, assertion, and render hash", async () => {
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
        assert.equal(entry.data_vintage, performance.snapshot_date);
        const hash = createHash("sha256").update(html).digest("hex");
        assert.equal(entry.sha256, hash);
      }
    }
  });
});

test("A5: live disclosure canary is opt-in and excluded from the always-on required glob posture", () => {
  const canary = readFileSync(join(ROOT, "test/live_procurement_disclosure_canary.test.mjs"), "utf8");
  assert.match(canary, /LIVE_PROCUREMENT_DISCLOSURE_CANARY/);
  assert.match(canary, /CITYSCROLL_DISCLOSURE_BROWSER/);
  const workflow = readFileSync(join(ROOT, ".github/workflows/deploy-cloudflare-pages.yml"), "utf8");
  assert.match(workflow, /live_procurement_disclosure_canary|capture_procurement_disclosure_production_proof/);
  const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /test\/\*\.test\.mjs/);
  // The live canary must require explicit opt-in so the required glob stays offline.
  assert.match(canary, /LIVE_PROCUREMENT_DISCLOSURE_CANARY !== ["']1["']/);
});

test("A6: implementation delivery and production readiness stay separate", () => {
  const complete = buildCompleteEnvelope();
  assert.equal(complete.implementation_delivery.complete, true);
  assert.equal(complete.production_readiness.ready, true);

  const notReady = cloneEnvelope(complete);
  const firematic = notReady.paths.find((row) => row.id === "contract-CT185720228800365");
  firematic.state = "failed";
  firematic.evidence = { fieldRoleMissing: [{ role: "original", expected: 158997.84 }] };
  notReady.counts = {
    passed: notReady.paths.filter((row) => row.state === "passed").length,
    failed: notReady.paths.filter((row) => row.state === "failed").length,
    "not-yet-observed": 0,
    total: notReady.paths.length,
    render_entries: notReady.render_entries.length,
  };
  notReady.production_readiness = evaluateProductionReadiness(notReady);
  assert.equal(notReady.implementation_delivery.complete, true);
  assert.equal(notReady.production_readiness.ready, false);
  assert.ok(notReady.production_readiness.reason_codes.some((code) => code.includes("contract-CT185720228800365")));

  // A shared-model timestamp alone never marks examples ready.
  const timestampOnly = buildCompleteEnvelope();
  timestampOnly.paths = timestampOnly.paths.filter((row) => !row.id.startsWith("browser-"));
  timestampOnly.counts = {
    passed: timestampOnly.paths.filter((row) => row.state === "passed").length,
    failed: 0,
    "not-yet-observed": 0,
    total: timestampOnly.paths.length,
    render_entries: timestampOnly.render_entries.length,
  };
  timestampOnly.served_build.shared_procurement_read_model_generated_at = "2026-09-16T16:00:00.000Z";
  timestampOnly.production_readiness = evaluateProductionReadiness(timestampOnly);
  assert.equal(timestampOnly.production_readiness.ready, false);
});

test("A5/A6: committed production read-back is structurally valid under the complete-reader schema when present as v2", () => {
  if (productionReadback.schema !== PRODUCTION_SCHEMA) {
    // Historical v1 envelopes are intentionally rejected until regenerated.
    assert.throws(
      () => assertProductionReadback(productionReadback),
      /v1 envelopes are incomplete|must use/,
    );
    return;
  }
  assertProductionReadback(productionReadback, { requireReady: false });
  assert.equal(productionReadback.provenance.observer.tool, DISCLOSURE_CAPTURE_TOOL);
  assert.ok(productionReadback.served_identity);
  assert.equal(typeof productionReadback.production_readiness.ready, "boolean");
  assert.equal(typeof productionReadback.implementation_delivery.complete, "boolean");
  // Delivery may be complete while production readiness remains false until repairs land.
  if (productionReadback.implementation_delivery.complete && !productionReadback.production_readiness.ready) {
    assert.ok(productionReadback.production_readiness.reason_codes.length > 0);
  }
});
