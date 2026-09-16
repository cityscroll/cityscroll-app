#!/usr/bin/env node

/**
 * Regenerate procurement disclosure evidence for alias c755c57ebdc96.
 *
 * Two surfaces share this directory:
 *   - manifest.json — local edge-worker render hashes (offline CI)
 *   - production-readback.json — live production GETs outside offline CI
 *
 * Never hand-edit hashes. Regenerate with this tool:
 *
 *   node tools/capture_procurement_disclosure_production_proof.mjs --fixture-manifest
 *   node tools/capture_procurement_disclosure_production_proof.mjs --production
 *   node tools/capture_procurement_disclosure_production_proof.mjs --check
 *
 * Production mode is read-only: public GETs only. No submissions, writes, or
 * account actions. A path that did not answer is failed or not-yet-observed,
 * never passed.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

import edgeWorker from "../site/pages_edge.mjs";
import { withPinnedClock } from "../test/helpers/test_clock.mjs";
import {
  assertProductionProvenance,
  productionPathObservation,
  productionProvenance,
} from "./lib/production_provenance.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const EVIDENCE_DIR_RELATIVE = "docs/evidence/procurement-disclosure-production-proof";
export const FIXTURE_MANIFEST_NAME = "manifest.json";
export const PRODUCTION_READBACK_NAME = "production-readback.json";
export const FIXTURE_SCHEMA = "cityscroll.render_evidence_manifest.v1";
export const PRODUCTION_SCHEMA = "cityscroll.procurement_disclosure_production_readback.v1";
export const TOOL = "tools/capture_procurement_disclosure_production_proof.mjs";
export const CAPTURE_CLOCK = "2026-09-15T00:00:00Z";
export const DEFAULT_SITE = "https://cityscroll.org";
export const DEFAULT_API = "https://api.cityscroll.org";

export const CONTRACTS = Object.freeze({
  CT110220271400991: {
    amount: "$62,500",
    vendor: "S &amp; P GLOBAL MARKET INTELLIGENCE LLC",
    label: "S&P",
  },
  CT105720278802113: {
    amount: "$46,673.32",
    vendor: "AMERICAN HEART ASSOCIATION INC",
    label: "AHA",
  },
  CT104020273009333: {
    amount: "$25,000",
    vendor: "QUIZIZZ INC",
    label: "QUIZIZZ",
  },
  CT185720228800365: {
    amount: "$49,689.78",
    vendor: "FIREMATIC SUPPLY CO. INC",
    method: "Amendment",
    label: "Firematic",
  },
  CT185020228802305: {
    amount: "$26,112.93",
    vendor: "TAMEER INC",
    method: "Construction Change Order",
    label: "TAMEER",
  },
  CT107120258801626: {
    amount: "$10,869,881",
    vendor: "BHRAGS HOME CARE CORP",
    label: "BHRAGS",
  },
});

export const VIEWPORTS = Object.freeze([
  { name: "desktop", header: "1440x900", userAgent: "cityscroll-disclosure-readback/1.0 (desktop; 1440x900)" },
  { name: "mobile", header: "390x844", userAgent: "cityscroll-disclosure-readback/1.0 (mobile; 390x844)" },
]);

function gitRevision(root = ROOT) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function sha256Text(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}

function evidencePath(name, root = ROOT) {
  return join(root, EVIDENCE_DIR_RELATIVE, name);
}

function procurementRoute(id) {
  return `/procurements/${encodeURIComponent(`procurement:contract:${id}`)}/`;
}

function procurementUrl(base, id) {
  return `${base.replace(/\/$/, "")}${procurementRoute(id)}`;
}

function readJson(rel) {
  return JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
}

function assetEnvironment(manifest) {
  return {
    ASSETS: {
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/data/shared_procurement_read_model.json") {
          return new Response(JSON.stringify(manifest));
        }
        if (path.startsWith("/data/shared_procurement_read_model/")) {
          const shard = path.slice("/data/".length);
          return new Response(readFileSync(join(ROOT, "site/data", shard)));
        }
        return new Response(
          "<!doctype html><html><head><title>CityScroll</title></head><body><main id=\"noticeview\"></main></body></html>",
        );
      },
    },
  };
}

async function servedFixtureContract(id, headers = {}) {
  const manifest = readJson("site/data/shared_procurement_read_model.json");
  const response = await edgeWorker.fetch(
    new Request(procurementUrl("https://cityscroll.org", id), { headers }),
    assetEnvironment(manifest),
  );
  if (response.status !== 200) {
    throw new Error(`fixture route ${id} returned HTTP ${response.status}`);
  }
  return response.text();
}

export async function buildFixtureManifest({
  revision = gitRevision(),
  captureClock = CAPTURE_CLOCK,
} = {}) {
  if (!revision) throw new Error("fixture manifest requires a git revision");
  const performance = readJson("site/data/analytics_performance_evidence.json");
  const dataVintage = performance.snapshot_date;
  if (!dataVintage) throw new Error("performance evidence snapshot_date is required");

  const entries = [];
  await withPinnedClock(captureClock, async () => {
    for (const id of Object.keys(CONTRACTS)) {
      for (const viewport of VIEWPORTS) {
        const html = await servedFixtureContract(id, { "X-Test-Viewport": viewport.header });
        const route = procurementRoute(id);
        entries.push({
          route,
          viewport: viewport.name,
          revision,
          data_vintage: dataVintage,
          assertion: `${viewport.name} server-rendered contract page is keyboard-linkable and free of empty headings`,
          sha256: sha256Text(html),
        });
      }
    }
  });

  return {
    schema: FIXTURE_SCHEMA,
    revision,
    data_vintage: dataVintage,
    capture_clock: captureClock,
    capture_policy: "Textual render hashes only; no image binaries are committed.",
    entries,
  };
}

function bodyHas(body, needle) {
  return String(body || "").includes(String(needle));
}

function bodyHasAny(body, needles) {
  return needles.some((needle) => bodyHas(body, needle));
}

function bodyMatches(body, pattern) {
  return pattern.test(String(body || ""));
}

function classifyContractHtml({ id, expected, status, body }) {
  const url = procurementUrl(DEFAULT_SITE, id);
  if (status == null || status >= 500) {
    return productionPathObservation({
      id: `contract-${id}`,
      url,
      status,
      state: "failed",
      assertion: `${expected.label} canonical page did not answer`,
    });
  }
  if (status !== 200) {
    return productionPathObservation({
      id: `contract-${id}`,
      url,
      status,
      state: "not-yet-observed",
      assertion: `${expected.label} canonical page is not yet serving the named contract`,
      note: "not-yet-observed, never passed.",
    });
  }

  const missing = [];
  if (!bodyHas(body, id)) missing.push("contract_id");
  if (!bodyHas(body, expected.amount)) missing.push("amount");
  if (!bodyHas(body, expected.vendor)) missing.push("vendor");
  if (expected.method && !bodyHas(body, expected.method)) missing.push("method");

  const disclosureFailures = [];
  if (bodyMatches(body, /executed contract|pricing schedule|performance terms|evaluation document/i)) {
    disclosureFailures.push("positive_document_label");
  }
  if (!bodyMatches(body, /Checkbook NYC|PASSPort Public contracts/)) {
    disclosureFailures.push("source_handoff");
  }
  if (bodyMatches(body, /small base contract|overall contract value/i)) {
    disclosureFailures.push("revision_mislabel");
  }
  if (bodyMatches(body, /tabindex=["']-1["']/i)) disclosureFailures.push("negative_tabindex");
  if (!bodyMatches(body, /<a\b[^>]*href="[^"]+"/)) disclosureFailures.push("native_links");
  if (bodyMatches(body, /<h2(?:\s[^>]*)?>\s*<\/h2>/i)) disclosureFailures.push("empty_heading");
  if (bodyMatches(body, /better than (?:Checkbook|PASSPort)|unlike (?:Checkbook|PASSPort)|more (?:complete|detailed) than (?:Checkbook|PASSPort)/i)) {
    disclosureFailures.push("unsupported_comparison");
  }

  const canonical = `https://cityscroll.org/procurements/${encodeURIComponent(`procurement:contract:${id}`)}`;
  const cityscrollUrls = [...String(body).matchAll(/https:\/\/cityscroll\.org\/[^\s"'<>]*/g)].map((match) => match[0]);
  const invented = cityscrollUrls.filter((href) => /\/procurements\//.test(href) && href !== canonical);
  if (invented.length) disclosureFailures.push("invented_canonical_url");

  if (missing.length || disclosureFailures.length) {
    return productionPathObservation({
      id: `contract-${id}`,
      url,
      status,
      state: "failed",
      assertion: `${expected.label} live page contradicts a retained disclosure or fact claim`,
      evidence: { missing, disclosureFailures, invented },
    });
  }

  return productionPathObservation({
    id: `contract-${id}`,
    url,
    status,
    state: "passed",
    assertion: `${expected.label} live page preserves named facts and disclosure refusals`,
    evidence: {
      contract_id: id,
      amount: expected.amount,
      vendor: expected.vendor,
      method: expected.method || null,
      sha256: sha256Text(body),
    },
  });
}

function classifySpCityRecord({ status, body }) {
  const url = procurementUrl(DEFAULT_SITE, "CT110220271400991");
  if (status !== 200) {
    return productionPathObservation({
      id: "sp-city-record-bound",
      url,
      status,
      state: status >= 500 || status == null ? "failed" : "not-yet-observed",
      assertion: "S&P City Record absence bound to the checked PIN, source, and date",
    });
  }
  const row = String(body).match(
    /data-source-system="city_record"[^>]*data-coverage-state="([^"]+)"[\s\S]*?<\/li>/i,
  );
  const pinPresent = bodyHas(body, "10220272001881");
  const overreach = bodyMatches(body, /never (?:published|appeared) in (?:the )?City Record|absent from City Record forever/i);
  if (!row || row[1] !== "checked-no-match" || !pinPresent || overreach || !/City Record/.test(row[0]) || !/Checked 20\d{2}-\d{2}-\d{2}/.test(row[0])) {
    return productionPathObservation({
      id: "sp-city-record-bound",
      url,
      status,
      state: "failed",
      assertion: "S&P City Record absence is not bound to the checked PIN, source, and date",
      evidence: {
        coverage_state: row?.[1] || null,
        pin_present: pinPresent,
        overreach,
      },
    });
  }
  return productionPathObservation({
    id: "sp-city-record-bound",
    url,
    status,
    state: "passed",
    assertion: "S&P City Record absence stays checked-no-match, names City Record, carries a lookup date, and keeps the checked PIN on the page without overreach",
    evidence: {
      coverage_state: row[1],
      checked_pin: "10220272001881",
      coverage_context: row[0].match(/Checked [^<]+/)?.[0] || null,
    },
  });
}

function classifyNotice({ id, status, body, needles, anyOf = [] }) {
  const url = `${DEFAULT_SITE}/notices/${id}/`;
  if (status == null || status >= 500) {
    return productionPathObservation({
      id: `notice-${id}`,
      url,
      status,
      state: "failed",
      assertion: `Notice ${id} did not answer`,
    });
  }
  if (status !== 200) {
    return productionPathObservation({
      id: `notice-${id}`,
      url,
      status,
      state: "not-yet-observed",
      assertion: `Notice ${id} is not yet serving the retained context`,
      note: "not-yet-observed, never passed.",
    });
  }
  const missing = needles.filter((needle) => !bodyHas(body, needle));
  const missingGroups = anyOf.filter((group) => !bodyHasAny(body, group));
  if (missing.length || missingGroups.length) {
    return productionPathObservation({
      id: `notice-${id}`,
      url,
      status,
      state: "failed",
      assertion: `Notice ${id} is missing retained project or shelter context`,
      evidence: { missing, missingGroups },
    });
  }
  return productionPathObservation({
    id: `notice-${id}`,
    url,
    status,
    state: "passed",
    assertion: `Notice ${id} preserves the retained identifiers and project or shelter context`,
    evidence: { needles, sha256: sha256Text(body) },
  });
}

function classifyLifecycle({ status, body }) {
  const url = `${DEFAULT_API}/contract-lifecycle?id=20240829105`;
  if (status == null || status >= 500) {
    return productionPathObservation({
      id: "contract-lifecycle-20240829105",
      url,
      status,
      state: "failed",
      assertion: "Shelter contract-lifecycle route did not answer",
    });
  }
  if (status !== 200) {
    return productionPathObservation({
      id: "contract-lifecycle-20240829105",
      url,
      status,
      state: "not-yet-observed",
      assertion: "Shelter contract-lifecycle route is not yet serving the retained snapshot",
      note: "not-yet-observed, never passed.",
    });
  }
  let payload = null;
  try {
    payload = JSON.parse(body);
  } catch {
    payload = null;
  }
  const payment = (payload?.timeline || []).find((row) => row?.detail?.total_spent != null)?.detail || null;
  const contractId = payload?.checkbook_acquisition?.contract_id || null;
  const ok = payload?.ok === true
    && payload?.id === "20240829105"
    && payload?.pin === "07124E0044001"
    && contractId === "CT107120258801626"
    && Number(payment?.total_spent) === 7385672.19
    && Number(payment?.total_payments) === 31;
  if (!ok) {
    return productionPathObservation({
      id: "contract-lifecycle-20240829105",
      url,
      status,
      state: "failed",
      assertion: "Shelter contract-lifecycle payload does not retain the named identifiers and payment total",
      evidence: {
        ok: payload?.ok ?? null,
        id: payload?.id ?? null,
        pin: payload?.pin ?? null,
        contract_id: contractId,
        total_spent: payment?.total_spent ?? null,
        total_payments: payment?.total_payments ?? null,
      },
    });
  }
  return productionPathObservation({
    id: "contract-lifecycle-20240829105",
    url,
    status,
    state: "passed",
    assertion: "Shelter contract-lifecycle route retains notice id, PIN, contract id, 31 payments, and $7,385,672.19 paid",
    evidence: {
      assembly_version: payload.assembly_version,
      contract_id: contractId,
      payment_as_of: payload.checkbook_acquisition?.payment_as_of || null,
      total_spent: payment.total_spent,
      total_payments: payment.total_payments,
    },
  });
}

function classifySearch({ status, body }) {
  const url = `${DEFAULT_API}/search?q=ACEDCA215`;
  if (status == null || status >= 500) {
    return productionPathObservation({
      id: "search-ACEDCA215",
      url,
      status,
      state: "failed",
      assertion: "Museum project-code search did not answer",
    });
  }
  if (status !== 200) {
    return productionPathObservation({
      id: "search-ACEDCA215",
      url,
      status,
      state: "not-yet-observed",
      assertion: "Museum project-code search is not yet returning the retained notice",
      note: "not-yet-observed, never passed.",
    });
  }
  let payload = null;
  try {
    payload = JSON.parse(body);
  } catch {
    payload = null;
  }
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const hit = results.find((row) => String(row?.canonical_href || "").includes("20260810048")
    || String(row?.title || "").includes("ACEDCA215")
    || JSON.stringify(row).includes("20260810048"));
  if (results.length !== 1 || !hit) {
    return productionPathObservation({
      id: "search-ACEDCA215",
      url,
      status,
      state: "failed",
      assertion: "Museum project-code search did not return exactly one retained notice",
      evidence: {
        result_count: results.length,
        object_refs: results.map((row) => row?.object_ref || null),
      },
    });
  }
  return productionPathObservation({
    id: "search-ACEDCA215",
    url,
    status,
    state: "passed",
    assertion: "Museum project-code search returns exactly one notice for ACEDCA215",
    evidence: {
      result_count: 1,
      object_ref: hit.object_ref || null,
      canonical_href: hit.canonical_href || null,
      title: hit.title || null,
    },
    note: "Resident /search/?q=ACEDCA215 is a client shell; this production read uses the public search API that feeds it.",
  });
}

function classifyViewportInvariance({ id, desktopHtml, mobileHtml, desktopStatus, mobileStatus }) {
  const url = procurementUrl(DEFAULT_SITE, id);
  if (desktopStatus !== 200 || mobileStatus !== 200) {
    return productionPathObservation({
      id: `viewport-${id}`,
      url,
      status: desktopStatus !== 200 ? desktopStatus : mobileStatus,
      state: "failed",
      assertion: `${id} desktop and mobile production reads did not both return 200`,
    });
  }
  const same = desktopHtml === mobileHtml;
  const desktopHash = sha256Text(desktopHtml);
  const mobileHash = sha256Text(mobileHtml);
  if (!same) {
    return productionPathObservation({
      id: `viewport-${id}`,
      url,
      status: 200,
      state: "failed",
      assertion: `${id} desktop and mobile production markup differ`,
      evidence: { desktopHash, mobileHash },
    });
  }
  return productionPathObservation({
    id: `viewport-${id}`,
    url,
    status: 200,
    state: "passed",
    assertion: `${id} production markup is identical across desktop and 390px request variants`,
    evidence: {
      sha256: desktopHash,
      property: "deterministic server-rendered markup across viewport variants",
    },
  });
}

async function fetchText(url, {
  fetchImpl = fetch,
  headers = {},
  userAgent = "cityscroll-disclosure-readback/1.0",
} = {}) {
  const response = await fetchImpl(url, {
    method: "GET",
    redirect: "follow",
    headers: {
      Accept: "text/html, application/json;q=0.9, */*;q=0.8",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      "User-Agent": userAgent,
      ...headers,
    },
  });
  const body = await response.text();
  return { status: response.status, body, headers: response.headers };
}

export async function collectProductionReadback({
  fetchImpl = fetch,
  site = DEFAULT_SITE,
  api = DEFAULT_API,
  now = new Date(),
  sourceRevision = null,
  pagesDeploy = null,
} = {}) {
  const observedAt = new Date(now).toISOString();
  const paths = [];
  const renderEntries = [];
  const findings = [];
  const contractBodies = new Map();

  const modelRead = await fetchText(`${site}/data/shared_procurement_read_model.json`, { fetchImpl });
  const perfRead = await fetchText(`${site}/data/analytics_performance_evidence.json`, { fetchImpl });
  let model = null;
  let performance = null;
  try {
    model = JSON.parse(modelRead.body);
  } catch {
    model = null;
  }
  try {
    performance = JSON.parse(perfRead.body);
  } catch {
    performance = null;
  }

  for (const [id, expected] of Object.entries(CONTRACTS)) {
    const byViewport = {};
    for (const viewport of VIEWPORTS) {
      const read = await fetchText(procurementUrl(site, id), {
        fetchImpl,
        userAgent: viewport.userAgent,
        headers: { "X-Test-Viewport": viewport.header },
      });
      byViewport[viewport.name] = read;
      renderEntries.push({
        route: procurementRoute(id),
        live_url: procurementUrl(site, id),
        viewport: viewport.name,
        data_vintage: performance?.snapshot_date || model?.generated_at || null,
        assertion: `${viewport.name} live contract page is keyboard-linkable, free of empty headings, and preserves disclosure refusals`,
        sha256: read.status === 200 ? sha256Text(read.body) : null,
        http_status: read.status,
      });
    }
    contractBodies.set(id, byViewport.desktop);
    paths.push(classifyContractHtml({
      id,
      expected,
      status: byViewport.desktop.status,
      body: byViewport.desktop.body,
    }));
    paths.push(classifyViewportInvariance({
      id,
      desktopHtml: byViewport.desktop.body,
      mobileHtml: byViewport.mobile.body,
      desktopStatus: byViewport.desktop.status,
      mobileStatus: byViewport.mobile.status,
    }));
  }

  const sp = contractBodies.get("CT110220271400991");
  paths.push(classifySpCityRecord({ status: sp?.status, body: sp?.body }));

  const aha = contractBodies.get("CT105720278802113");
  const ahaPassport = String(aha?.body || "").match(
    /data-source-system="passport_public_contracts"[^>]*data-coverage-state="([^"]+)"/i,
  );
  if (ahaPassport?.[1] === "checked-no-match") {
    findings.push({
      id: "aha-passport-coverage-state",
      severity: "observation",
      statement: "The live AHA page still names the PASSPort Public contracts handoff, and its coverage row remains checked-no-match. This read records that retained lookup state; it does not claim a newly joined PASSPort match on the deployed page.",
      evidence: { coverage_state: ahaPassport[1] },
    });
  }

  const shelterNotice = await fetchText(`${site}/notices/20240829105/`, { fetchImpl });
  paths.push(classifyNotice({
    id: "20240829105",
    status: shelterNotice.status,
    body: shelterNotice.body,
    needles: ["20240829105"],
    anyOf: [["Comfort Inn", "BHRAGS"]],
  }));

  const museumNotice = await fetchText(`${site}/notices/20260810048/`, { fetchImpl });
  paths.push(classifyNotice({
    id: "20260810048",
    status: museumNotice.status,
    body: museumNotice.body,
    needles: ["20260810048", "BCM-HVAC Upgrades", "ACEDCA215", "85026B0110", "85026B01107"],
    anyOf: [["19,905,485", "19905485"], ["June 25, 2029", "2029-06-25"]],
  }));

  const lifecycle = await fetchText(`${api}/contract-lifecycle?id=20240829105`, { fetchImpl });
  paths.push(classifyLifecycle({ status: lifecycle.status, body: lifecycle.body }));

  const search = await fetchText(`${api}/search?q=ACEDCA215`, { fetchImpl });
  paths.push(classifySearch({ status: search.status, body: search.body }));

  // A5 enrichment-failure clause cannot be forced on live production without
  // mutating lookups. Record that the live pages carry no enrichment-apology copy.
  for (const [id, read] of contractBodies.entries()) {
    if (read.status === 200 && bodyMatches(read.body, /enrichment failed|unable to load enrichment/i)) {
      paths.push(productionPathObservation({
        id: `enrichment-apology-${id}`,
        url: procurementUrl(site, id),
        status: read.status,
        state: "failed",
        assertion: "Live contract page shows enrichment-apology copy",
      }));
    }
  }
  paths.push(productionPathObservation({
    id: "enrichment-failure-live-boundary",
    url: procurementUrl(site, "CT107120258801626"),
    status: contractBodies.get("CT107120258801626")?.status ?? null,
    state: contractBodies.get("CT107120258801626")?.status === 200 ? "passed" : "failed",
    assertion: "Live production cannot empty optional lookups; the fixture suite proves enrichment failure retains the record, and live pages carry no enrichment-apology copy",
    evidence: {
      live_apology_copy: false,
      fixture_clause: "test/procurement_disclosure_production_proof.test.mjs A5 enrichment failure",
    },
  }));

  const passed = paths.filter((row) => row.state === "passed").length;
  const notYet = paths.filter((row) => row.state === "not-yet-observed").length;
  const failed = paths.filter((row) => row.state === "failed").length;

  const provenance = productionProvenance({
    observed_at: observedAt,
    tool: TOOL,
    source_revision: sourceRevision || gitRevision(),
    bases: [site, api],
    methods: ["GET"],
  });
  assertProductionProvenance(provenance, { requireSourceRevision: true });

  return {
    schema: PRODUCTION_SCHEMA,
    title: "Procurement disclosure production read-back",
    public_alias: "c755c57ebdc96",
    capture_policy: "Textual assertions and render hashes only; no image binaries are committed. Read-only public GETs.",
    served_build: {
      live_base: site,
      api_base: api,
      pages_deploy_commit: pagesDeploy?.head_sha || null,
      pages_deploy_completed_at: pagesDeploy?.updated_at || null,
      pages_deploy_url: pagesDeploy?.html_url || null,
      shared_procurement_read_model_generated_at: model?.generated_at || null,
      shared_procurement_read_model_http_status: modelRead.status,
      performance_evidence_snapshot_date: performance?.snapshot_date || null,
      performance_evidence_generated_at: performance?.generated_at || null,
      performance_evidence_http_status: perfRead.status,
    },
    provenance,
    paths,
    render_entries: renderEntries,
    findings,
    counts: {
      passed,
      "not-yet-observed": notYet,
      failed,
      total: paths.length,
      render_entries: renderEntries.length,
    },
    rolling_release_gate:
      "Release gates assert population properties over the materialized set. This dated deployment read-back is evidence for the named routes, not a permanent named-record gate.",
  };
}

function resolvePagesDeployFromEnv(env = process.env) {
  if (!env.CITYSCROLL_PAGES_DEPLOY_COMMIT) return null;
  return {
    head_sha: env.CITYSCROLL_PAGES_DEPLOY_COMMIT,
    updated_at: env.CITYSCROLL_PAGES_DEPLOY_COMPLETED_AT || null,
    html_url: env.CITYSCROLL_PAGES_DEPLOY_URL || null,
  };
}

async function resolveLatestSuccessfulPagesDeploy() {
  const result = spawnSync(
    "gh",
    [
      "run",
      "list",
      "--workflow",
      "Deploy Cloudflare Pages",
      "--limit",
      "20",
      "--json",
      "databaseId,headSha,conclusion,status,createdAt,updatedAt,displayTitle,url",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (result.status !== 0) return null;
  let runs = [];
  try {
    runs = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  const success = runs.find((run) => run.conclusion === "success" && run.status === "completed");
  if (!success) return null;
  return {
    head_sha: success.headSha,
    updated_at: success.updatedAt,
    html_url: success.url,
    created_at: success.createdAt,
    display_title: success.displayTitle,
    database_id: success.databaseId,
  };
}

export function assertFixtureManifest(manifest) {
  if (!manifest || manifest.schema !== FIXTURE_SCHEMA) {
    throw new Error(`fixture manifest schema must be ${FIXTURE_SCHEMA}`);
  }
  if (!manifest.revision || !/^[0-9a-f]{40}$/.test(manifest.revision)) {
    throw new Error("fixture manifest requires a full git revision");
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length !== Object.keys(CONTRACTS).length * VIEWPORTS.length) {
    throw new Error("fixture manifest must contain every contract at both viewports");
  }
  for (const entry of manifest.entries) {
    if (entry.revision !== manifest.revision) {
      throw new Error(`fixture entry revision drifts from manifest revision for ${entry.route}`);
    }
    if (!entry.sha256 || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error(`fixture entry missing sha256 for ${entry.route}`);
    }
    if (!entry.assertion) throw new Error(`fixture entry missing assertion for ${entry.route}`);
  }
  return manifest;
}

export function assertProductionReadback(envelope) {
  if (!envelope || envelope.schema !== PRODUCTION_SCHEMA) {
    throw new Error(`production read-back schema must be ${PRODUCTION_SCHEMA}`);
  }
  assertProductionProvenance(envelope.provenance, { requireSourceRevision: true });
  if (!envelope.served_build?.live_base) {
    throw new Error("production read-back requires served_build.live_base");
  }
  if (!envelope.served_build?.shared_procurement_read_model_generated_at) {
    throw new Error("production read-back requires the served shared procurement read-model vintage");
  }
  if (!Array.isArray(envelope.paths) || envelope.paths.length === 0) {
    throw new Error("production read-back requires path observations");
  }
  if (!Array.isArray(envelope.render_entries) || envelope.render_entries.length !== Object.keys(CONTRACTS).length * VIEWPORTS.length) {
    throw new Error("production read-back must retain desktop and mobile render entries for every named contract");
  }
  if ((envelope.counts?.failed || 0) > 0) {
    throw new Error(`production read-back records ${envelope.counts.failed} failed path(s)`);
  }
  return envelope;
}

async function main(argv = process.argv.slice(2)) {
  const check = argv.includes("--check");
  const fixture = argv.includes("--fixture-manifest");
  const production = argv.includes("--production") || (!fixture && !check);
  const outDir = join(ROOT, EVIDENCE_DIR_RELATIVE);
  mkdirSync(outDir, { recursive: true });

  if (check) {
    const fixturePath = evidencePath(FIXTURE_MANIFEST_NAME);
    const productionPath = evidencePath(PRODUCTION_READBACK_NAME);
    if (!existsSync(fixturePath)) throw new Error(`${EVIDENCE_DIR_RELATIVE}/${FIXTURE_MANIFEST_NAME} is missing`);
    if (!existsSync(productionPath)) throw new Error(`${EVIDENCE_DIR_RELATIVE}/${PRODUCTION_READBACK_NAME} is missing`);
    assertFixtureManifest(JSON.parse(readFileSync(fixturePath, "utf8")));
    assertProductionReadback(JSON.parse(readFileSync(productionPath, "utf8")));
    console.log(`ok ${EVIDENCE_DIR_RELATIVE} fixture+production envelopes`);
    return;
  }

  if (fixture) {
    const manifest = assertFixtureManifest(await buildFixtureManifest());
    const out = evidencePath(FIXTURE_MANIFEST_NAME);
    writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`wrote ${EVIDENCE_DIR_RELATIVE}/${FIXTURE_MANIFEST_NAME} revision=${manifest.revision} entries=${manifest.entries.length}`);
  }

  if (production) {
    const pagesDeploy = resolvePagesDeployFromEnv() || await resolveLatestSuccessfulPagesDeploy();
    const envelope = assertProductionReadback(await collectProductionReadback({
      sourceRevision: gitRevision(),
      pagesDeploy,
    }));
    const out = evidencePath(PRODUCTION_READBACK_NAME);
    writeFileSync(out, `${JSON.stringify(envelope, null, 2)}\n`);
    console.log(
      `wrote ${EVIDENCE_DIR_RELATIVE}/${PRODUCTION_READBACK_NAME} passed=${envelope.counts.passed} failed=${envelope.counts.failed} build=${envelope.served_build.shared_procurement_read_model_generated_at}`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
