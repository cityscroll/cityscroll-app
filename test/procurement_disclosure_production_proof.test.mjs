import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import edgeWorker from "../site/pages_edge.mjs";
import {
  normalizePerformanceEvidenceItem,
} from "../site/analytical_performance_evidence.mjs";
import { withPinnedClock } from "./helpers/test_clock.mjs";

const manifest = JSON.parse(readFileSync(new URL("../site/data/shared_procurement_read_model.json", import.meta.url)));
const performance = JSON.parse(readFileSync(new URL("../site/data/analytics_performance_evidence.json", import.meta.url)));
const projectContext = JSON.parse(readFileSync(new URL("../site/data/procurement_project_context.json", import.meta.url)));
const renderManifest = JSON.parse(readFileSync(new URL("../docs/evidence/procurement-disclosure-production-proof/manifest.json", import.meta.url)));

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
  const qualifying = normalizePerformanceEvidenceItem({
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

test("A4: real canonical routes credit source handoffs and refuse misleading revision/base claims", async () => {
  const sp = await servedContract("CT110220271400991");
  assert.match(sp, /checkbooknyc\.com\/smart_search\/citywide\?search_term=CT110220271400991/);
  assert.doesNotMatch(sp, /City Record notice/);
  const aha = await servedContract("CT105720278802113");
  assert.match(aha, /PASSPort Public contracts/);
  const bhrags = await servedContract("CT107120258801626");
  assert.match(bhrags, /checkbooknyc\.com|Checkbook NYC/);
  assert.match(bhrags, /\$10,869,881/);
  assert.match(bhrags, /20240829105/);
  const firematic = await servedContract("CT185720228800365");
  assert.match(firematic, /Amendment/);
  assert.doesNotMatch(firematic, /small base contract|overall contract value/i);
  const tameer = await servedContract("CT185020228802305");
  assert.match(tameer, /Construction Change Order/);
  assert.doesNotMatch(tameer, /small base contract|overall contract value/i);
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

test("A5: committed manifest records each route, viewport, vintage, assertion, and render hash", async () => {
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
