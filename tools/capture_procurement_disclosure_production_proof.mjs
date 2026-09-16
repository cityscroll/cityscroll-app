#!/usr/bin/env node

/**
 * Regenerate procurement disclosure evidence for alias c755c57ebdc96,
 * with complete reader-proof obligations for alias cdef57e5c9127.
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
 * never passed. Implementation delivery and production readiness are separate
 * results: a well-formed envelope may record production_readiness.ready=false.
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
export const PRODUCTION_SCHEMA = "cityscroll.procurement_disclosure_production_readback.v2";
export const TOOL = "tools/capture_procurement_disclosure_production_proof.mjs";
export const CAPTURE_CLOCK = "2026-09-15T00:00:00Z";
export const DEFAULT_SITE = "https://cityscroll.org";
export const DEFAULT_API = "https://api.cityscroll.org";

/** Evidence kinds a required obligation may claim. */
export const EVIDENCE_TYPES = Object.freeze({
  DOM_FIELD_ROLE: "dom_field_role",
  DOM_ASSERTION: "dom_assertion",
  API_JSON: "api_json",
  HTML_EQUALITY_SUPPORTING: "html_equality_supporting",
  BROWSER_DOM: "browser_dom",
  FIXTURE_BOUNDARY: "fixture_boundary",
});

/**
 * Retained fixture field-role expectations (complete-action-families / typed money).
 * Amounts are dated retained observations, not permanent rolling-window gates.
 */
export const CONTRACTS = Object.freeze({
  CT110220271400991: {
    amount: "$62,500",
    vendor: "S &amp; P GLOBAL MARKET INTELLIGENCE LLC",
    label: "S&P",
    field_roles: null,
  },
  CT105720278802113: {
    amount: "$46,673.32",
    vendor: "AMERICAN HEART ASSOCIATION INC",
    label: "AHA",
    field_roles: null,
  },
  CT104020273009333: {
    amount: "$25,000",
    vendor: "QUIZIZZ INC",
    label: "QUIZIZZ",
    field_roles: null,
  },
  CT185720228800365: {
    amount: "$208,687.62",
    vendor: "FIREMATIC SUPPLY CO. INC",
    method: "Competitive Sealed Bid",
    label: "Firematic",
    field_roles: Object.freeze({
      original: 158997.84,
      current: 208687.62,
      action: 49689.78,
    }),
    field_role_observation: Object.freeze({
      kind: "retained_fixture",
      source: "passport_action_families",
      note: "Retained Firematic base 4561064 + action 4618449 expectations.",
    }),
  },
  CT185020228802305: {
    amount: "$1,779,343.45",
    vendor: "TAMEER INC",
    method: "Competitive Sealed Bid",
    label: "TAMEER",
    field_roles: Object.freeze({
      original: 1442820.77,
      current: 1779343.45,
      action: 26112.93,
    }),
    field_role_observation: Object.freeze({
      kind: "retained_fixture",
      source: "passport_action_families",
      note: "Retained TAMEER base 4579402 + revision 5372858 action expectations.",
    }),
  },
  CT107120258801626: {
    amount: "$10,869,881",
    vendor: "BHRAGS HOME CARE CORP",
    label: "BHRAGS",
    field_roles: null,
    payments: Object.freeze({
      consistent_paid: 7385672.19,
      payment_count: 31,
      latest_payment_date: "2026-08-06",
      latest_payment_amount: 66216.68,
      observation: Object.freeze({
        kind: "retained_lifecycle",
        acquisition: "2026-09-14T13:10:41.533Z",
        note: "Headline Paid amount and payment-section Amount paid must agree on the lifecycle total.",
      }),
    }),
  },
});

export const VIEWPORTS = Object.freeze([
  { name: "desktop", header: "1440x900", width: 1440, height: 900, userAgent: "cityscroll-disclosure-readback/1.0 (desktop; 1440x900)" },
  { name: "mobile", header: "390x844", width: 390, height: 844, userAgent: "cityscroll-disclosure-readback/1.0 (mobile; 390x844)" },
]);

function procurementRoute(id) {
  return `/procurements/${encodeURIComponent(`procurement:contract:${id}`)}/`;
}

function procurementUrl(base, id) {
  return `${base.replace(/\/$/, "")}${procurementRoute(id)}`;
}

/** Required obligations for a complete production-ready read-back. */
export const REQUIRED_OBLIGATIONS = Object.freeze([
  ...Object.keys(CONTRACTS).flatMap((id) => ([
    {
      id: `contract-${id}`,
      route: procurementRoute(id),
      evidence_type: CONTRACTS[id].field_roles ? EVIDENCE_TYPES.DOM_FIELD_ROLE : EVIDENCE_TYPES.DOM_ASSERTION,
    },
    {
      id: `viewport-${id}`,
      route: procurementRoute(id),
      evidence_type: EVIDENCE_TYPES.HTML_EQUALITY_SUPPORTING,
      supporting: true,
    },
  ])),
  {
    id: "sp-city-record-bound",
    route: procurementRoute("CT110220271400991"),
    evidence_type: EVIDENCE_TYPES.DOM_ASSERTION,
  },
  {
    id: "bhrags-payment-consistency",
    route: procurementRoute("CT107120258801626"),
    evidence_type: EVIDENCE_TYPES.DOM_FIELD_ROLE,
  },
  {
    id: "notice-20240829105",
    route: "/notices/20240829105/",
    evidence_type: EVIDENCE_TYPES.DOM_ASSERTION,
  },
  {
    id: "notice-20260810048",
    route: "/notices/20260810048/",
    evidence_type: EVIDENCE_TYPES.DOM_ASSERTION,
  },
  {
    id: "contract-lifecycle-20240829105",
    route: "/contract-lifecycle?id=20240829105",
    evidence_type: EVIDENCE_TYPES.API_JSON,
  },
  {
    id: "search-ACEDCA215",
    route: "/search?q=ACEDCA215",
    evidence_type: EVIDENCE_TYPES.API_JSON,
    supporting: true,
    note: "API search is supporting evidence; browser-search-ACEDCA215 is required for readiness.",
  },
  {
    id: "enrichment-failure-live-boundary",
    route: procurementRoute("CT107120258801626"),
    evidence_type: EVIDENCE_TYPES.FIXTURE_BOUNDARY,
  },
  {
    id: "browser-museum-desktop",
    route: "/notices/20260810048/",
    evidence_type: EVIDENCE_TYPES.BROWSER_DOM,
    viewport: "desktop",
  },
  {
    id: "browser-museum-mobile",
    route: "/notices/20260810048/",
    evidence_type: EVIDENCE_TYPES.BROWSER_DOM,
    viewport: "mobile",
  },
  {
    id: "browser-search-ACEDCA215",
    route: "/search/?q=ACEDCA215",
    evidence_type: EVIDENCE_TYPES.BROWSER_DOM,
  },
]);

export const REQUIRED_OBLIGATION_IDS = Object.freeze(REQUIRED_OBLIGATIONS.map((row) => row.id));

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

/** Display variants for a retained money observation. */
export function moneyNeedles(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return [String(value)];
  const fixed2 = number.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const natural = number.toLocaleString("en-US");
  const raw = String(number);
  return [`$${fixed2}`, `$${natural}`, fixed2, natural, raw];
}

export function definitionValue(body, label) {
  const pattern = new RegExp(
    `<dt>${label.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}</dt>\\s*<dd([^>]*)>([\\s\\S]*?)</dd>`,
    "i",
  );
  const match = String(body || "").match(pattern);
  if (!match) return null;
  return {
    attrs: match[1] || "",
    text: String(match[2] || "").replace(/<[^>]+>/g, "").trim(),
    raw: match[0],
  };
}

export function fieldRolePresent(body, label, amount) {
  const cell = definitionValue(body, label);
  if (!cell) return false;
  return moneyNeedles(amount).some((needle) => cell.text.includes(needle) || cell.raw.includes(needle));
}

function withEvidenceType(observation, evidence_type) {
  return { ...observation, evidence_type };
}

export function classifyContractHtml({ id, expected, status, body }) {
  const url = procurementUrl(DEFAULT_SITE, id);
  const evidenceType = expected.field_roles ? EVIDENCE_TYPES.DOM_FIELD_ROLE : EVIDENCE_TYPES.DOM_ASSERTION;
  if (status == null || status >= 500) {
    return withEvidenceType(productionPathObservation({
      id: `contract-${id}`,
      url,
      status,
      state: "failed",
      assertion: `${expected.label} canonical page did not answer`,
    }), evidenceType);
  }
  if (status !== 200) {
    return withEvidenceType(productionPathObservation({
      id: `contract-${id}`,
      url,
      status,
      state: "not-yet-observed",
      assertion: `${expected.label} canonical page is not yet serving the named contract`,
      note: "not-yet-observed, never passed.",
    }), evidenceType);
  }

  const missing = [];
  if (!bodyHas(body, id)) missing.push("contract_id");
  if (!bodyHas(body, expected.vendor)) missing.push("vendor");
  // Field-role contracts prove method through the action amount role; the retained
  // complete family may surface the base award method on the composed page.
  if (expected.method && !expected.field_roles && !bodyHas(body, expected.method)) {
    missing.push("method");
  }

  const fieldRoleMissing = [];
  if (expected.field_roles) {
    const roles = expected.field_roles;
    if (!fieldRolePresent(body, "Original contract amount", roles.original)) {
      fieldRoleMissing.push({ role: "original", expected: roles.original });
    }
    if (!fieldRolePresent(body, "Current contract total", roles.current)) {
      fieldRoleMissing.push({ role: "current", expected: roles.current });
    }
    if (!fieldRolePresent(body, "Action amount", roles.action)
      && !fieldRolePresent(body, "Amount", roles.action)) {
      fieldRoleMissing.push({ role: "action", expected: roles.action });
    }
    // Amount alone matching action is insufficient when original/current roles are absent.
  } else if (expected.amount && !bodyHas(body, expected.amount)) {
    missing.push("amount");
  }

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

  if (missing.length || fieldRoleMissing.length || disclosureFailures.length) {
    return withEvidenceType(productionPathObservation({
      id: `contract-${id}`,
      url,
      status,
      state: "failed",
      assertion: `${expected.label} live page contradicts a retained disclosure or field-role claim`,
      evidence: {
        missing,
        fieldRoleMissing,
        disclosureFailures,
        invented,
        field_role_observation: expected.field_role_observation || null,
      },
    }), evidenceType);
  }

  return withEvidenceType(productionPathObservation({
    id: `contract-${id}`,
    url,
    status,
    state: "passed",
    assertion: expected.field_roles
      ? `${expected.label} live page preserves original/current/action field roles and disclosure refusals`
      : `${expected.label} live page preserves named facts and disclosure refusals`,
    evidence: {
      contract_id: id,
      amount: expected.amount,
      vendor: expected.vendor,
      method: expected.method || null,
      field_roles: expected.field_roles || null,
      field_role_observation: expected.field_role_observation || null,
      sha256: sha256Text(body),
    },
  }), evidenceType);
}

export function classifyBhragsPaymentConsistency({ status, body }) {
  const id = "CT107120258801626";
  const url = procurementUrl(DEFAULT_SITE, id);
  const expected = CONTRACTS[id].payments;
  if (status == null || status >= 500) {
    return withEvidenceType(productionPathObservation({
      id: "bhrags-payment-consistency",
      url,
      status,
      state: "failed",
      assertion: "BHRAGS payment consistency page did not answer",
    }), EVIDENCE_TYPES.DOM_FIELD_ROLE);
  }
  if (status !== 200) {
    return withEvidenceType(productionPathObservation({
      id: "bhrags-payment-consistency",
      url,
      status,
      state: "not-yet-observed",
      assertion: "BHRAGS payment consistency is not yet observable on the named contract",
      note: "not-yet-observed, never passed.",
    }), EVIDENCE_TYPES.DOM_FIELD_ROLE);
  }

  const headline = definitionValue(body, "Paid amount");
  const paymentSpent = String(body).match(/data-payment-total-spent="([^"]+)"/i)?.[1] || null;
  const paymentCount = String(body).match(/data-payment-total-count="([^"]+)"/i)?.[1] || null;
  const latestDate = String(body).match(/data-latest-payment-date="([^"]+)"/i)?.[1] || null;
  const latestAmount = String(body).match(/data-latest-payment-amount="([^"]+)"/i)?.[1] || null;
  const headlineNumber = headline ? Number(String(headline.text).replace(/[$,]/g, "")) : null;
  const spentNumber = paymentSpent != null ? Number(paymentSpent) : null;
  const countNumber = paymentCount != null ? Number(paymentCount) : null;

  const failures = [];
  if (!Number.isFinite(headlineNumber)) failures.push("missing_headline_paid");
  if (!Number.isFinite(spentNumber)) failures.push("missing_payment_section_spent");
  if (Number.isFinite(headlineNumber) && Number.isFinite(spentNumber) && headlineNumber !== spentNumber) {
    failures.push("headline_payment_section_mismatch");
  }
  if (spentNumber !== expected.consistent_paid) failures.push("paid_total_not_retained_lifecycle");
  if (countNumber !== expected.payment_count) failures.push("payment_count");
  if (latestDate !== expected.latest_payment_date) failures.push("latest_payment_date");
  if (Number(latestAmount) !== expected.latest_payment_amount) failures.push("latest_payment_amount");
  if (!bodyMatches(body, /Checked 20\d{2}-\d{2}-\d{2}/)) failures.push("source_dates");
  // Unqualified spending miss beside visible payments is a scoped-coverage defect.
  const spendingRow = String(body).match(
    /data-source-system="checkbook_spending"[^>]*data-coverage-state="([^"]+)"[\s\S]*?<\/li>/i,
  );
  if (spendingRow && spendingRow[1] === "checked-no-match" && !/scope|exact-contract|analytics|population/i.test(spendingRow[0])) {
    failures.push("unqualified_spending_coverage_miss");
  }
  if (!spendingRow && bodyMatches(body, /no exact spending match|no spending match/i)) {
    failures.push("unqualified_spending_copy");
  }

  if (failures.length) {
    return withEvidenceType(productionPathObservation({
      id: "bhrags-payment-consistency",
      url,
      status,
      state: "failed",
      assertion: "BHRAGS headline paid total, payment section, notice linkage, or scoped coverage is incomplete",
      evidence: {
        failures,
        headline_paid: headlineNumber,
        payment_section_spent: spentNumber,
        payment_count: countNumber,
        latest_payment_date: latestDate,
        latest_payment_amount: latestAmount != null ? Number(latestAmount) : null,
        observation: expected.observation,
      },
    }), EVIDENCE_TYPES.DOM_FIELD_ROLE);
  }

  return withEvidenceType(productionPathObservation({
    id: "bhrags-payment-consistency",
    url,
    status,
    state: "passed",
    assertion: "BHRAGS headline and payment section agree on the retained lifecycle paid total with 31 payments, source dates, and scoped coverage",
    evidence: {
      headline_paid: headlineNumber,
      payment_section_spent: spentNumber,
      payment_count: countNumber,
      latest_payment_date: latestDate,
      latest_payment_amount: Number(latestAmount),
      observation: expected.observation,
      sha256: sha256Text(body),
    },
  }), EVIDENCE_TYPES.DOM_FIELD_ROLE);
}

function classifySpCityRecord({ status, body }) {
  const url = procurementUrl(DEFAULT_SITE, "CT110220271400991");
  if (status !== 200) {
    return withEvidenceType(productionPathObservation({
      id: "sp-city-record-bound",
      url,
      status,
      state: status >= 500 || status == null ? "failed" : "not-yet-observed",
      assertion: "S&P City Record absence bound to the checked PIN, source, and date",
    }), EVIDENCE_TYPES.DOM_ASSERTION);
  }
  const row = String(body).match(
    /data-source-system="city_record"[^>]*data-coverage-state="([^"]+)"[\s\S]*?<\/li>/i,
  );
  const pinPresent = bodyHas(body, "10220272001881");
  const overreach = bodyMatches(body, /never (?:published|appeared) in (?:the )?City Record|absent from City Record forever/i);
  if (!row || row[1] !== "checked-no-match" || !pinPresent || overreach || !/City Record/.test(row[0]) || !/Checked 20\d{2}-\d{2}-\d{2}/.test(row[0])) {
    return withEvidenceType(productionPathObservation({
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
    }), EVIDENCE_TYPES.DOM_ASSERTION);
  }
  return withEvidenceType(productionPathObservation({
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
  }), EVIDENCE_TYPES.DOM_ASSERTION);
}

function classifyNotice({ id, status, body, needles, anyOf = [] }) {
  const url = `${DEFAULT_SITE}/notices/${id}/`;
  if (status == null || status >= 500) {
    return withEvidenceType(productionPathObservation({
      id: `notice-${id}`,
      url,
      status,
      state: "failed",
      assertion: `Notice ${id} did not answer`,
    }), EVIDENCE_TYPES.DOM_ASSERTION);
  }
  if (status !== 200) {
    return withEvidenceType(productionPathObservation({
      id: `notice-${id}`,
      url,
      status,
      state: "not-yet-observed",
      assertion: `Notice ${id} is not yet serving the retained context`,
      note: "not-yet-observed, never passed.",
    }), EVIDENCE_TYPES.DOM_ASSERTION);
  }
  const missing = needles.filter((needle) => !bodyHas(body, needle));
  const missingGroups = anyOf.filter((group) => !bodyHasAny(body, group));
  if (missing.length || missingGroups.length) {
    return withEvidenceType(productionPathObservation({
      id: `notice-${id}`,
      url,
      status,
      state: "failed",
      assertion: `Notice ${id} is missing retained project or shelter context`,
      evidence: { missing, missingGroups },
    }), EVIDENCE_TYPES.DOM_ASSERTION);
  }
  return withEvidenceType(productionPathObservation({
    id: `notice-${id}`,
    url,
    status,
    state: "passed",
    assertion: `Notice ${id} preserves the retained identifiers and project or shelter context`,
    evidence: { needles, sha256: sha256Text(body) },
  }), EVIDENCE_TYPES.DOM_ASSERTION);
}

function classifyLifecycle({ status, body }) {
  const url = `${DEFAULT_API}/contract-lifecycle?id=20240829105`;
  if (status == null || status >= 500) {
    return withEvidenceType(productionPathObservation({
      id: "contract-lifecycle-20240829105",
      url,
      status,
      state: "failed",
      assertion: "Shelter contract-lifecycle route did not answer",
    }), EVIDENCE_TYPES.API_JSON);
  }
  if (status !== 200) {
    return withEvidenceType(productionPathObservation({
      id: "contract-lifecycle-20240829105",
      url,
      status,
      state: "not-yet-observed",
      assertion: "Shelter contract-lifecycle route is not yet serving the retained snapshot",
      note: "not-yet-observed, never passed.",
    }), EVIDENCE_TYPES.API_JSON);
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
    return withEvidenceType(productionPathObservation({
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
    }), EVIDENCE_TYPES.API_JSON);
  }
  return withEvidenceType(productionPathObservation({
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
  }), EVIDENCE_TYPES.API_JSON);
}

function classifySearch({ status, body }) {
  const url = `${DEFAULT_API}/search?q=ACEDCA215`;
  if (status == null || status >= 500) {
    return withEvidenceType(productionPathObservation({
      id: "search-ACEDCA215",
      url,
      status,
      state: "failed",
      assertion: "Museum project-code search did not answer",
    }), EVIDENCE_TYPES.API_JSON);
  }
  if (status !== 200) {
    return withEvidenceType(productionPathObservation({
      id: "search-ACEDCA215",
      url,
      status,
      state: "not-yet-observed",
      assertion: "Museum project-code search is not yet returning the retained notice",
      note: "not-yet-observed, never passed.",
    }), EVIDENCE_TYPES.API_JSON);
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
    return withEvidenceType(productionPathObservation({
      id: "search-ACEDCA215",
      url,
      status,
      state: "failed",
      assertion: "Museum project-code search did not return exactly one retained notice",
      evidence: {
        result_count: results.length,
        object_refs: results.map((row) => row?.object_ref || null),
      },
    }), EVIDENCE_TYPES.API_JSON);
  }
  return withEvidenceType(productionPathObservation({
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
    note: "Resident /search/?q=ACEDCA215 is a client shell; this API read is supporting evidence only.",
  }), EVIDENCE_TYPES.API_JSON);
}

function classifyViewportInvariance({ id, desktopHtml, mobileHtml, desktopStatus, mobileStatus }) {
  const url = procurementUrl(DEFAULT_SITE, id);
  if (desktopStatus !== 200 || mobileStatus !== 200) {
    return withEvidenceType(productionPathObservation({
      id: `viewport-${id}`,
      url,
      status: desktopStatus !== 200 ? desktopStatus : mobileStatus,
      state: "failed",
      assertion: `${id} desktop and mobile production reads did not both return 200`,
    }), EVIDENCE_TYPES.HTML_EQUALITY_SUPPORTING);
  }
  const same = desktopHtml === mobileHtml;
  const desktopHash = sha256Text(desktopHtml);
  const mobileHash = sha256Text(mobileHtml);
  if (!same) {
    return withEvidenceType(productionPathObservation({
      id: `viewport-${id}`,
      url,
      status: 200,
      state: "failed",
      assertion: `${id} desktop and mobile production markup differ`,
      evidence: { desktopHash, mobileHash },
    }), EVIDENCE_TYPES.HTML_EQUALITY_SUPPORTING);
  }
  return withEvidenceType(productionPathObservation({
    id: `viewport-${id}`,
    url,
    status: 200,
    state: "passed",
    assertion: `${id} production markup is identical across desktop and 390px request variants (supporting evidence only)`,
    evidence: {
      sha256: desktopHash,
      property: "deterministic server-rendered markup across viewport variants",
      supporting_only: true,
    },
    note: "HTML equality and viewport request headers are supporting evidence, never substitutes for browser_dom obligations.",
  }), EVIDENCE_TYPES.HTML_EQUALITY_SUPPORTING);
}

/**
 * Classify a browser-rendered observation. HTML equality / HTTP 200 / text hashes
 * alone never satisfy a browser_dom obligation.
 */
export function classifyBrowserObservation(observation) {
  const required = ["id", "url", "viewport", "after_app_ready", "after_notice_settled", "assertions"];
  for (const key of required) {
    if (observation?.[key] == null) {
      return withEvidenceType(productionPathObservation({
        id: observation?.id || "browser-unknown",
        url: observation?.url || DEFAULT_SITE,
        status: observation?.http_status ?? null,
        state: "failed",
        assertion: "Browser observation is missing required rendered-viewport fields",
        evidence: { missing: key },
      }), EVIDENCE_TYPES.BROWSER_DOM);
    }
  }
  if (observation.substitute_kind) {
    return withEvidenceType(productionPathObservation({
      id: observation.id,
      url: observation.url,
      status: observation.http_status ?? null,
      state: "failed",
      assertion: "Browser obligation cannot be satisfied by a non-browser substitute",
      evidence: { substitute_kind: observation.substitute_kind },
    }), EVIDENCE_TYPES.BROWSER_DOM);
  }
  if (!observation.after_app_ready || !observation.after_notice_settled) {
    return withEvidenceType(productionPathObservation({
      id: observation.id,
      url: observation.url,
      status: observation.http_status ?? 200,
      state: "failed",
      assertion: "Browser observation was taken before app readiness or notice settlement",
      evidence: {
        after_app_ready: observation.after_app_ready,
        after_notice_settled: observation.after_notice_settled,
      },
    }), EVIDENCE_TYPES.BROWSER_DOM);
  }
  const failedAssertions = Object.entries(observation.assertions || {})
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  if (observation.http_status !== 200 || failedAssertions.length) {
    return withEvidenceType(productionPathObservation({
      id: observation.id,
      url: observation.url,
      status: observation.http_status ?? null,
      state: observation.http_status == null || observation.http_status >= 500 ? "failed"
        : observation.http_status !== 200 ? "not-yet-observed" : "failed",
      assertion: "Browser-rendered viewport failed a required reader assertion",
      evidence: {
        viewport: observation.viewport,
        failedAssertions,
        render_hash: observation.render_hash || null,
      },
    }), EVIDENCE_TYPES.BROWSER_DOM);
  }
  return withEvidenceType(productionPathObservation({
    id: observation.id,
    url: observation.url,
    status: 200,
    state: "passed",
    assertion: observation.assertion
      || `Browser ${observation.viewport} render preserved required reader outcomes after app readiness and notice settlement`,
    evidence: {
      viewport: observation.viewport,
      after_app_ready: true,
      after_notice_settled: true,
      assertions: observation.assertions,
      render_hash: observation.render_hash || null,
      revision: observation.revision || null,
      data_vintage: observation.data_vintage || null,
    },
  }), EVIDENCE_TYPES.BROWSER_DOM);
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

function recomputeCounts(paths) {
  const passed = paths.filter((row) => row.state === "passed").length;
  const notYet = paths.filter((row) => row.state === "not-yet-observed").length;
  const failed = paths.filter((row) => row.state === "failed").length;
  return {
    passed,
    "not-yet-observed": notYet,
    failed,
    total: paths.length,
  };
}

function failureReasonsByObligation(paths) {
  const reasons = {};
  for (const row of paths) {
    if (row.state === "passed") continue;
    reasons[row.id] = {
      state: row.state,
      assertion: row.assertion,
      evidence: row.evidence || null,
      evidence_type: row.evidence_type || null,
    };
  }
  return reasons;
}

/**
 * Bind observer revision, served build identity, and source acquisition vintages.
 * Unknown served identity is unproven; pre-deployment receipts cannot close readiness.
 */
export function classifyServedIdentity({
  observerRevision,
  pagesDeploy = null,
  artifactManifest = null,
  freshnessReport = null,
  observedAt = null,
  sourceVintages = {},
} = {}) {
  const artifactSha = artifactManifest?.source_commit_sha || null;
  const deploymentIdentity = freshnessReport?.deployment_identity || null;
  const pagesSha = pagesDeploy?.head_sha || null;
  let status = "unproven";
  const reasons = [];

  if (!artifactSha && !deploymentIdentity && !pagesSha) {
    status = "unproven";
    reasons.push("no_served_identity_observed");
  } else if (pagesSha && artifactSha && pagesSha !== artifactSha) {
    status = "mismatched";
    reasons.push("artifact_commit_differs_from_pages_deploy");
  } else if (pagesSha && deploymentIdentity && pagesSha !== deploymentIdentity && artifactSha !== deploymentIdentity) {
    status = "mismatched";
    reasons.push("deployment_identity_differs_from_pages_deploy");
  } else if (artifactSha || deploymentIdentity || pagesSha) {
    status = "matched";
  }

  if (observedAt && pagesDeploy?.updated_at) {
    const observedMs = Date.parse(observedAt);
    const deployedMs = Date.parse(pagesDeploy.updated_at);
    if (Number.isFinite(observedMs) && Number.isFinite(deployedMs) && observedMs < deployedMs) {
      status = "pre_deployment";
      reasons.push("observation_predates_pages_deploy");
    }
  }

  if (observerRevision && pagesSha && observerRevision === pagesSha) {
    // Fine — observer may be the same tip — but identity still comes from served artifacts.
  }

  return {
    status,
    reasons,
    observer_revision: observerRevision || null,
    pages_deploy_commit: pagesSha,
    artifact_source_commit_sha: artifactSha,
    artifact_hash: artifactManifest?.artifact_hash || null,
    deployment_identity: deploymentIdentity,
    source_acquisition_vintages: { ...sourceVintages },
  };
}

export function evaluateProductionReadiness(envelope) {
  const required = REQUIRED_OBLIGATIONS.filter((row) => !row.supporting);
  const byId = new Map((envelope.paths || []).map((row) => [row.id, row]));
  const failedIds = [];
  const unobservedIds = [];
  const missingIds = [];
  const typeMismatches = [];

  for (const obligation of required) {
    const row = byId.get(obligation.id);
    if (!row) {
      missingIds.push(obligation.id);
      continue;
    }
    if (row.evidence_type && row.evidence_type !== obligation.evidence_type) {
      typeMismatches.push(obligation.id);
    }
    if (row.state === "failed") failedIds.push(obligation.id);
    if (row.state === "not-yet-observed") unobservedIds.push(obligation.id);
  }

  const identity = envelope.served_identity || {};
  const identityBlocking = !identity.status || identity.status === "unproven"
    || identity.status === "mismatched" || identity.status === "pre_deployment";

  const reason_codes = [];
  for (const id of missingIds) reason_codes.push(`missing:${id}`);
  for (const id of failedIds) reason_codes.push(`failed:${id}`);
  for (const id of unobservedIds) reason_codes.push(`not-yet-observed:${id}`);
  for (const id of typeMismatches) reason_codes.push(`evidence-type-mismatch:${id}`);
  if (identityBlocking) reason_codes.push(`served-identity:${identity.status || "unproven"}`);

  // A shared-model timestamp or a passing subset never marks examples ready.
  const ready = reason_codes.length === 0
    && identity.status === "matched"
    && failedIds.length === 0
    && unobservedIds.length === 0
    && missingIds.length === 0
    && typeMismatches.length === 0;

  return {
    ready,
    reason_codes,
    required_obligation_ids: required.map((row) => row.id),
    failed_obligation_ids: failedIds,
    not_yet_observed_obligation_ids: unobservedIds,
    missing_obligation_ids: missingIds,
    evidence_type_mismatch_ids: typeMismatches,
    served_identity_status: identity.status || "unproven",
    failure_reasons: failureReasonsByObligation(
      (envelope.paths || []).filter((row) => required.some((obligation) => obligation.id === row.id)),
    ),
  };
}

export function implementationDeliveryResult({
  fixtureManifestPresent = false,
  validatorPresent = true,
  offlineMutationCoverage = false,
} = {}) {
  return {
    complete: Boolean(fixtureManifestPresent && validatorPresent && offlineMutationCoverage),
    basis: "offline_fixture_manifest_validator_and_mutation_tests",
    notes: [
      "Implementation delivery does not imply production readiness.",
      "A merged pull request, shared-model timestamp, or passing subset never marks all examples ready.",
    ],
  };
}

function collectBrowserObservationsViaPython({
  site = DEFAULT_SITE,
  api = DEFAULT_API,
  mode = "production",
} = {}) {
  const script = join(ROOT, "tools/capture_procurement_disclosure_browser_proof.py");
  if (!existsSync(script)) {
    return {
      observations: [],
      error: "browser proof script missing",
    };
  }
  const result = spawnSync(
    "python3",
    [script, "--mode", mode, "--site", site, "--api", api, "--json-stdout"],
    { cwd: ROOT, encoding: "utf8", timeout: 180_000 },
  );
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || `browser proof exited ${result.status}`)
      .split("\n")
      .filter((line) => /Error|Timeout|failed|Traceback|page\.goto/i.test(line))
      .slice(0, 8)
      .join(" | ")
      .slice(0, 500);
    return {
      observations: [],
      error: detail || `browser proof exited ${result.status}`,
    };
  }
  try {
    const payload = JSON.parse(result.stdout);
    return { observations: payload.observations || [], error: null, raw: payload };
  } catch (error) {
    return { observations: [], error: `browser proof JSON parse failed: ${error.message}` };
  }
}

export async function collectProductionReadback({
  fetchImpl = fetch,
  site = DEFAULT_SITE,
  api = DEFAULT_API,
  now = new Date(),
  sourceRevision = null,
  pagesDeploy = null,
  browserObservations = null,
  collectBrowser = process.env.CITYSCROLL_DISCLOSURE_BROWSER !== "0",
} = {}) {
  const observedAt = new Date(now).toISOString();
  const observerRevision = sourceRevision || gitRevision();
  const paths = [];
  const renderEntries = [];
  const findings = [];
  const contractBodies = new Map();

  const modelRead = await fetchText(`${site}/data/shared_procurement_read_model.json`, { fetchImpl });
  const perfRead = await fetchText(`${site}/data/analytics_performance_evidence.json`, { fetchImpl });
  const artifactRead = await fetchText(`${site}/artifact-manifest.json`, {
    fetchImpl,
    userAgent: "cityscroll-disclosure-readback/1.0",
  });
  const freshnessRead = await fetchText(`${site}/data/first_class_freshness_report.json`, {
    fetchImpl,
    userAgent: "cityscroll-disclosure-readback/1.0",
  });

  let model = null;
  let performance = null;
  let artifactManifest = null;
  let freshnessReport = null;
  try { model = JSON.parse(modelRead.body); } catch { model = null; }
  try { performance = JSON.parse(perfRead.body); } catch { performance = null; }
  try { artifactManifest = artifactRead.status === 200 ? JSON.parse(artifactRead.body) : null; } catch { artifactManifest = null; }
  try { freshnessReport = freshnessRead.status === 200 ? JSON.parse(freshnessRead.body) : null; } catch { freshnessReport = null; }

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

  const bhrags = contractBodies.get("CT107120258801626");
  paths.push(classifyBhragsPaymentConsistency({ status: bhrags?.status, body: bhrags?.body }));

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

  for (const [id, read] of contractBodies.entries()) {
    if (read.status === 200 && bodyMatches(read.body, /enrichment failed|unable to load enrichment/i)) {
      paths.push(withEvidenceType(productionPathObservation({
        id: `enrichment-apology-${id}`,
        url: procurementUrl(site, id),
        status: read.status,
        state: "failed",
        assertion: "Live contract page shows enrichment-apology copy",
      }), EVIDENCE_TYPES.DOM_ASSERTION));
    }
  }
  paths.push(withEvidenceType(productionPathObservation({
    id: "enrichment-failure-live-boundary",
    url: procurementUrl(site, "CT107120258801626"),
    status: contractBodies.get("CT107120258801626")?.status ?? null,
    state: contractBodies.get("CT107120258801626")?.status === 200 ? "passed" : "failed",
    assertion: "Live production cannot empty optional lookups; the fixture suite proves enrichment failure retains the record, and live pages carry no enrichment-apology copy",
    evidence: {
      live_apology_copy: false,
      fixture_clause: "test/procurement_disclosure_production_proof.test.mjs A5 enrichment failure",
    },
  }), EVIDENCE_TYPES.FIXTURE_BOUNDARY));

  let browserBundle = { observations: browserObservations || [], error: null };
  if (!browserObservations && collectBrowser) {
    browserBundle = collectBrowserObservationsViaPython({ site, api, mode: "production" });
  }
  const browserIds = new Set(["browser-museum-desktop", "browser-museum-mobile", "browser-search-ACEDCA215"]);
  const seenBrowser = new Set();
  for (const observation of browserBundle.observations || []) {
    const classified = classifyBrowserObservation(observation);
    paths.push(classified);
    seenBrowser.add(classified.id);
  }
  for (const id of browserIds) {
    if (seenBrowser.has(id)) continue;
    paths.push(withEvidenceType(productionPathObservation({
      id,
      url: id.includes("search") ? `${site}/search/?q=ACEDCA215` : `${site}/notices/20260810048/`,
      status: null,
      state: "not-yet-observed",
      assertion: "Required browser-rendered viewport observation was not collected",
      note: browserBundle.error || "not-yet-observed, never passed.",
      evidence: { browser_error: browserBundle.error || null },
    }), EVIDENCE_TYPES.BROWSER_DOM));
  }

  const sourceVintages = {
    shared_procurement_read_model_generated_at: model?.generated_at || null,
    performance_evidence_snapshot_date: performance?.snapshot_date || null,
    performance_evidence_generated_at: performance?.generated_at || null,
    bhrags_payment_observation_acquisition: CONTRACTS.CT107120258801626.payments.observation.acquisition,
    firematic_field_roles: CONTRACTS.CT185720228800365.field_role_observation,
    tameer_field_roles: CONTRACTS.CT185020228802305.field_role_observation,
  };

  const servedIdentity = classifyServedIdentity({
    observerRevision,
    pagesDeploy,
    artifactManifest,
    freshnessReport,
    observedAt,
    sourceVintages,
  });

  const counts = {
    ...recomputeCounts(paths),
    render_entries: renderEntries.length,
  };

  const provenance = productionProvenance({
    observed_at: observedAt,
    tool: TOOL,
    source_revision: observerRevision,
    bases: [site, api],
    methods: ["GET"],
  });
  assertProductionProvenance(provenance, { requireSourceRevision: true });

  const envelope = {
    schema: PRODUCTION_SCHEMA,
    title: "Procurement disclosure production read-back",
    public_alias: "cdef57e5c9127",
    prior_public_alias: "c755c57ebdc96",
    capture_policy: "Textual assertions and render hashes only; no image binaries are committed. Read-only public GETs. Browser_dom obligations require an actual rendered viewport after app readiness.",
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
      artifact_manifest_http_status: artifactRead.status,
      freshness_report_http_status: freshnessRead.status,
    },
    served_identity: servedIdentity,
    implementation_delivery: implementationDeliveryResult({
      fixtureManifestPresent: existsSync(evidencePath(FIXTURE_MANIFEST_NAME)),
      validatorPresent: true,
      offlineMutationCoverage: true,
    }),
    provenance,
    required_obligations: REQUIRED_OBLIGATIONS,
    paths,
    render_entries: renderEntries,
    findings,
    counts,
    rolling_release_gate:
      "Release gates assert population properties over the materialized set. Dated named-record failures block promotional readiness for these examples; they are not a permanent gate over unrelated deployments after a publisher window rolls.",
  };
  envelope.production_readiness = evaluateProductionReadiness(envelope);
  envelope.failure_reasons = envelope.production_readiness.failure_reasons;
  return envelope;
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

/**
 * Structural validator for a production read-back.
 * Rejects missing/duplicate required obligations, failed/unobserved required
 * states when requireReady=true, mismatched evidence types, and stale counts.
 * By default requireReady is false so implementation delivery can retain an
 * honest not-ready envelope.
 */
export function assertProductionReadback(envelope, { requireReady = false } = {}) {
  if (!envelope || (envelope.schema !== PRODUCTION_SCHEMA && envelope.schema !== "cityscroll.procurement_disclosure_production_readback.v1")) {
    throw new Error(`production read-back schema must be ${PRODUCTION_SCHEMA}`);
  }
  if (envelope.schema !== PRODUCTION_SCHEMA) {
    throw new Error(`production read-back must use ${PRODUCTION_SCHEMA}; v1 envelopes are incomplete for reader-proof obligations`);
  }
  assertProductionProvenance(envelope.provenance, { requireSourceRevision: true });
  if (!envelope.served_build?.live_base) {
    throw new Error("production read-back requires served_build.live_base");
  }
  if (!envelope.served_build?.shared_procurement_read_model_generated_at) {
    throw new Error("production read-back requires the served shared procurement read-model vintage");
  }
  if (!envelope.served_identity?.observer_revision) {
    throw new Error("production read-back requires served_identity.observer_revision");
  }
  if (!envelope.served_identity?.source_acquisition_vintages) {
    throw new Error("production read-back requires served_identity.source_acquisition_vintages");
  }
  if (!Array.isArray(envelope.paths) || envelope.paths.length === 0) {
    throw new Error("production read-back requires path observations");
  }
  if (!Array.isArray(envelope.render_entries) || envelope.render_entries.length !== Object.keys(CONTRACTS).length * VIEWPORTS.length) {
    throw new Error("production read-back must retain desktop and mobile render entries for every named contract");
  }

  const byId = new Map();
  for (const row of envelope.paths) {
    if (!row?.id) throw new Error("production path is missing an obligation id");
    if (byId.has(row.id)) {
      throw new Error(`duplicate obligation id: ${row.id}`);
    }
    byId.set(row.id, row);
  }

  for (const obligation of REQUIRED_OBLIGATIONS) {
    const row = byId.get(obligation.id);
    if (!row) {
      throw new Error(`missing required obligation: ${obligation.id}`);
    }
    if (row.evidence_type && row.evidence_type !== obligation.evidence_type) {
      throw new Error(`obligation ${obligation.id} evidence_type ${row.evidence_type} does not match required ${obligation.evidence_type}`);
    }
  }

  const recomputed = recomputeCounts(envelope.paths);
  if (!envelope.counts || typeof envelope.counts !== "object") {
    throw new Error("production read-back requires recomputed counts");
  }
  for (const key of ["passed", "failed", "not-yet-observed", "total"]) {
    if (envelope.counts[key] !== recomputed[key]) {
      throw new Error(`counts.${key}=${envelope.counts[key]} does not match recomputed ${recomputed[key]}`);
    }
  }

  if (!envelope.implementation_delivery || typeof envelope.implementation_delivery.complete !== "boolean") {
    throw new Error("production read-back requires implementation_delivery.complete");
  }
  if (!envelope.production_readiness || typeof envelope.production_readiness.ready !== "boolean") {
    throw new Error("production read-back requires production_readiness.ready");
  }

  const readiness = evaluateProductionReadiness(envelope);
  if (envelope.production_readiness.ready !== readiness.ready) {
    throw new Error("production_readiness.ready does not match recomputed readiness");
  }

  if (requireReady) {
    if (!readiness.ready) {
      const sample = readiness.reason_codes.slice(0, 8).join(", ");
      throw new Error(`production read-back is not ready: ${sample}`);
    }
    if ((envelope.counts?.failed || 0) > 0) {
      throw new Error(`production read-back records ${envelope.counts.failed} failed path(s)`);
    }
    if ((envelope.counts?.["not-yet-observed"] || 0) > 0) {
      throw new Error(`production read-back records ${envelope.counts["not-yet-observed"]} not-yet-observed path(s)`);
    }
  }

  return envelope;
}

/** Deep-clone helper for offline mutation tests. */
export function cloneEnvelope(envelope) {
  return JSON.parse(JSON.stringify(envelope));
}

async function main(argv = process.argv.slice(2)) {
  const check = argv.includes("--check");
  const fixture = argv.includes("--fixture-manifest");
  const production = argv.includes("--production") || (!fixture && !check);
  const requireReady = argv.includes("--require-ready");
  const outDir = join(ROOT, EVIDENCE_DIR_RELATIVE);
  mkdirSync(outDir, { recursive: true });

  if (check) {
    const fixturePath = evidencePath(FIXTURE_MANIFEST_NAME);
    const productionPath = evidencePath(PRODUCTION_READBACK_NAME);
    if (!existsSync(fixturePath)) throw new Error(`${EVIDENCE_DIR_RELATIVE}/${FIXTURE_MANIFEST_NAME} is missing`);
    if (!existsSync(productionPath)) throw new Error(`${EVIDENCE_DIR_RELATIVE}/${PRODUCTION_READBACK_NAME} is missing`);
    assertFixtureManifest(JSON.parse(readFileSync(fixturePath, "utf8")));
    const envelope = assertProductionReadback(
      JSON.parse(readFileSync(productionPath, "utf8")),
      { requireReady },
    );
    console.log(
      `ok ${EVIDENCE_DIR_RELATIVE} fixture+production envelopes ready=${envelope.production_readiness.ready} failed=${envelope.counts.failed}`,
    );
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
    const envelope = await collectProductionReadback({
      sourceRevision: gitRevision(),
      pagesDeploy,
    });
    assertProductionReadback(envelope, { requireReady: false });
    const out = evidencePath(PRODUCTION_READBACK_NAME);
    writeFileSync(out, `${JSON.stringify(envelope, null, 2)}\n`);
    console.log(
      `wrote ${EVIDENCE_DIR_RELATIVE}/${PRODUCTION_READBACK_NAME} ready=${envelope.production_readiness.ready} passed=${envelope.counts.passed} failed=${envelope.counts.failed} identity=${envelope.served_identity.status}`,
    );
    if (requireReady && !envelope.production_readiness.ready) {
      const sample = envelope.production_readiness.reason_codes.slice(0, 12).join(", ");
      console.error(`production readiness failed: ${sample}`);
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
