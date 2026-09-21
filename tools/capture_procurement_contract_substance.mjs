#!/usr/bin/env node

/**
 * Capture and validate the named contract-substance release matrix.
 *
 * Fixture mode serves the real edge worker from the checked-in materialized
 * read model. It records textual render evidence only; it never creates an
 * image capture and it never upgrades fixture evidence to production proof.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { resolveRepositoryRevision } from "./repository_revision.mjs";

import {
  ACCESS_STATES,
  DOCUMENT_ROLES,
  FIXED_CONTRACT_IDS,
  REQUIRED_DOCUMENT_ROLES,
  validateFixedContractAccessCoverage,
} from "../site/procurement_contract_substance_access.mjs";
import { testClockISOString, withPinnedClock } from "../test/helpers/test_clock.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const EVIDENCE_DIR_RELATIVE = "docs/evidence/procurement-contract-substance-release";
export const FIXTURE_NAME = "fixture.json";
export const FIXTURE_PATH = join(ROOT, EVIDENCE_DIR_RELATIVE, FIXTURE_NAME);
export const PRODUCTION_NAME = "production.json";
export const PRODUCTION_PATH = join(ROOT, EVIDENCE_DIR_RELATIVE, PRODUCTION_NAME);
export const PROMOTION_NAME = "real-example-promotion.json";
export const PROMOTION_PATH = join(ROOT, EVIDENCE_DIR_RELATIVE, PROMOTION_NAME);
export const RELEASE_SCHEMA = "cityscroll.procurement_contract_substance_release.v1";
export const PRODUCTION_SCHEMA = "cityscroll.procurement_contract_substance_production.v1";
export const PROMOTION_SCHEMA = "cityscroll.procurement_contract_substance_promotion.v1";
export const TOOL = "tools/capture_procurement_contract_substance.mjs";
export const PRODUCTION_CAPTURE_TOOL = "tools/capture_procurement_contract_substance_production.py";
export const CAPTURE_CLOCK = "2026-09-20T00:00:00Z";
export const PUBLIC_SITE = "https://cityscroll.org";
export const VIEWPORTS = Object.freeze([
  { name: "desktop", header: "1440x900" },
  { name: "mobile", header: "390x844" },
]);

export const CLAIMS = Object.freeze([
  "amount",
  "scope",
  "pricing",
  "promises",
  "service_geography",
  "performance",
]);

export const PROMOTION_CLAIM_FAMILIES = Object.freeze([
  "access",
  "pricing_role",
  "obligation_role",
  "performance",
  "neighborhood",
  "vendor_promise",
]);

export const PROMOTION_EXAMPLE_IDS = Object.freeze([
  "bhrags-CT107120258801626",
  "s-p-CT110220271400991",
  "aha-CT105720278802113",
  "quizizz-CT104020273009333",
  "docgo-CT180620248801671",
  "dcas-bid-tab-2000090",
  "mocs-november-2024-fcrc",
]);

export const EXAMPLES = Object.freeze({
  CT107120258801626: Object.freeze({
    label: "BHRAGS",
    amount: 10869881,
    vendor: "BHRAGS HOME CARE CORP",
    notice_id: "20240829105",
    address: "3218 Emmons Avenue, Brooklyn",
    units: 60,
    neighborhood: "Sheepshead Bay-Manhattan Beach-Gerritsen Beach",
  }),
  CT110220271400991: Object.freeze({
    label: "S&P",
    amount: 62500,
    vendor: "S &amp; P GLOBAL MARKET INTELLIGENCE LLC",
  }),
  CT105720278802113: Object.freeze({
    label: "AHA/EMS",
    amount: 46673.32,
    vendor: "AMERICAN HEART ASSOCIATION INC",
  }),
  CT104020273009333: Object.freeze({
    label: "Quizizz",
    amount: 25000,
    vendor: "QUIZIZZ INC",
  }),
});

const SUBSTANCE_CLAIMS = new Set(["scope", "pricing", "promises"]);
const PUBLIC_SUBSTANCE_ROLES = Object.freeze({
  scope: new Set(["executed_contract", "statement_of_work", "executed_scope"]),
  pricing: new Set(["pricing_schedule", "amendment"]),
  promises: new Set(["executed_contract", "statement_of_work", "executed_obligation", "executed_scope"]),
});
const PLACE_ROLES = new Set([
  "facility_site",
  "work_site",
  "delivery_site",
  "service_area",
  "beneficiary_area",
]);
const LOGIN_URL_RE = /(?:\/login|\/signin)(?:[/?#]|$)|[?&](?:returnurl|return_url)=|(^|\.)passport\.cityofnewyork\.us$/i;
const HASH_RE = /^[a-f0-9]{64}$/i;

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(ROOT, relativePath), "utf8"));
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function gitRevision() {
  return resolveRepositoryRevision(ROOT);
}

function isSha256(value) {
  return /^sha256:[a-f0-9]{64}$/i.test(String(value || ""));
}

function manifestRevision(value) {
  return String(value || "").replace(/^grounded origin\/main\s+/, "").trim();
}

function roleCapture(manifest, route) {
  const capture = (manifest.captures || []).find((entry) => entry.route === route);
  if (!capture) throw new Error(`missing role-corpus capture ${route}`);
  const desktop = (capture.viewports || []).find((entry) => entry.name === "desktop");
  if (!desktop?.render_sha256) throw new Error(`missing desktop render hash ${route}`);
  return { capture, desktop };
}

function productionRender(readback, contractId) {
  const route = procurementRoute(contractId);
  const entry = (readback.render_entries || []).find((candidate) => (
    candidate.route === route && candidate.viewport === "desktop" && candidate.http_status === 200
  ));
  if (!entry?.sha256) throw new Error(`missing production render ${contractId}`);
  return {
    route,
    revision: readback.served_build.pages_deploy_commit,
    data_vintage: readback.served_build.shared_procurement_read_model_generated_at,
    render_hash: entry.sha256,
    viewport: entry.viewport,
  };
}

function corpusDocument(corpus, documentId) {
  const row = (corpus.rows || []).find((entry) => entry.document_id === documentId);
  if (!row) throw new Error(`missing real corpus document ${documentId}`);
  return row;
}

function rolePassage(roleCorpus, documentId, predicate) {
  const row = (roleCorpus.rows || []).find((entry) => (
    entry.corpus_document_id === documentId && (!predicate || predicate(entry))
  ));
  if (!row) throw new Error(`missing role corpus passage ${documentId}`);
  return row;
}

function promotionEvidence({
  route,
  servedBuildRevision,
  dataVintage,
  sourceUrl,
  sourceHash,
  documentRole,
  locator,
  assertion,
  identityBasis,
  renderHash,
  viewport = "desktop",
  evidenceType = "source_document",
  provenanceClass = "real_source",
  component = null,
  placeRole = null,
}) {
  return {
    evidence_type: evidenceType,
    provenance_class: provenanceClass,
    route,
    component,
    served_build_revision: servedBuildRevision,
    data_vintage: dataVintage,
    source_url: sourceUrl,
    source_hash: sourceHash,
    source_hash_basis: evidenceType === "source_document" ? "retrieved official document bytes" : "recorded served DOM capture bytes",
    document_role: documentRole,
    locator,
    assertion,
    identity_basis: identityBasis,
    viewport,
    place_role: placeRole,
    render_hash: renderHash,
    content_hash: evidenceType === "source_document" ? sourceHash : null,
    initialization: evidenceType === "browser_dom" ? "settled" : null,
  };
}

function promotionCell(claimFamily, evidence, assertion = evidence?.assertion) {
  return {
    claim_family: claimFamily,
    status: "ready",
    reason: null,
    assertion,
    evidence,
  };
}

function promotionNotReady(claimFamily, reason, details = {}) {
  return {
    claim_family: claimFamily,
    status: "not_ready",
    reason,
    assertion: details.assertion || `${claimFamily} remains not ready because ${reason}.`,
    details,
    evidence: null,
  };
}

export function procurementRoute(contractId) {
  return `/procurements/${encodeURIComponent(`procurement:contract:${contractId}`)}/`;
}

function procurementUrl(contractId) {
  return `${PUBLIC_SITE}${procurementRoute(contractId)}`;
}

function assetEnvironment(readModel) {
  return {
    ASSETS: {
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/data/shared_procurement_read_model.json") {
          return new Response(JSON.stringify(readModel));
        }
        if (path.startsWith("/data/shared_procurement_read_model/")) {
          return new Response(readFileSync(join(ROOT, "site/data", path.slice("/data/".length))));
        }
        return new Response(
          "<!doctype html><html><head><title>CityScroll</title></head><body><main id=\"noticeview\"></main></body></html>",
        );
      },
    },
  };
}

async function servedContract(contractId, readModel, headers = {}) {
  const { default: edgeWorker } = await import("../site/pages_edge.mjs");
  const response = await edgeWorker.fetch(
    new Request(procurementUrl(contractId), { headers }),
    assetEnvironment(readModel),
  );
  return { status: response.status, body: await response.text() };
}

function moneyNeedles(amount) {
  return [
    `$${amount.toLocaleString("en-US", { maximumFractionDigits: 2 })}`,
    `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
  ];
}

function hasAny(body, needles) {
  return needles.some((needle) => String(body).includes(needle));
}

function accessRows(access) {
  const byContract = new Map();
  for (const row of access.rows || []) {
    if (!byContract.has(row.contract_id)) byContract.set(row.contract_id, new Map());
    const roles = byContract.get(row.contract_id);
    if (roles.has(row.document_role)) throw new Error(`duplicate access role ${row.contract_id}/${row.document_role}`);
    roles.set(row.document_role, row);
  }
  return byContract;
}

function sourcePassage({ url, role, locator, excerpt, contentHash = null, identityBasis }) {
  return {
    url,
    document_role: role,
    locator,
    excerpt,
    content_hash: contentHash,
    identity_basis: identityBasis,
  };
}

function renderedEvidence({ contractId, claim, route, revision, dataVintage, renderHash, assertion, source, placeRole = null }) {
  return {
    evidence_type: "browser_dom",
    route,
    revision,
    data_vintage: dataVintage,
    render_hash: renderHash,
    rendered: true,
    initialization: "settled",
    assertion,
    source: source || null,
    served_passage: source?.excerpt || null,
    place_role: placeRole,
    claim,
    contract_id: contractId,
  };
}

function notReady(reason, details = {}) {
  return { status: "not_ready", reason, details };
}

function ready(evidence) {
  return { status: "ready", reason: null, evidence };
}

function claimSetFor(contractId, { route, revision, dataVintage, renderHash, body, accessByRole }) {
  const expected = EXAMPLES[contractId];
  const claims = {};
  const amountReady = hasAny(body, moneyNeedles(expected.amount));
  claims.amount = amountReady
    ? ready(renderedEvidence({
      contractId,
      claim: "amount",
      route,
      revision,
      dataVintage,
      renderHash,
      assertion: `${expected.label} canonical page shows the retained below-$100,000 amount`,
      source: sourcePassage({
        url: procurementUrl(contractId),
        role: "passport_public_metadata",
        locator: "contract amount definition",
        excerpt: `The served page shows ${moneyNeedles(expected.amount)[0]} for ${contractId}.`,
        identityBasis: `exact contract id ${contractId}`,
      }),
    }))
    : notReady("served_amount_missing");

  if (contractId === "CT107120258801626") {
    const checks = {
      identity: body.includes(contractId) && body.includes(expected.notice_id),
      authorized_total: body.includes('data-substance-authorized-total>$10,869,881'),
      paid_total: body.includes('data-substance-paid-total>$7,385,672.19'),
      payment_count: body.includes("Showing 12 of 31 payments on this contract"),
      facility: body.includes('data-substance-place-role="facility_site"')
        && body.includes(expected.address)
        && body.includes(`${expected.units} units`),
      neighborhood: body.includes(expected.neighborhood),
    };
    const routeEvidence = (claim, assertion, source, placeRole = null) => renderedEvidence({
      contractId,
      claim,
      route,
      revision,
      dataVintage,
      renderHash,
      assertion,
      source,
      placeRole,
    });
    claims.amount = Object.values(checks).every(Boolean)
      ? ready(routeEvidence(
        "amount",
        "BHRAGS page keeps exact contract identity, authorized total, paid total, and 31-payment coverage together",
        sourcePassage({
          url: procurementUrl(contractId),
          role: "checkbook_contract_and_payment_materialization",
          locator: "contract facts and payment summary",
          excerpt: "$10,869,881 authorized; $7,385,672.19 paid; 31 payments.",
          identityBasis: `exact contract id ${contractId}`,
        }),
      ))
      : notReady("bhrags_joined_payment_story_incomplete", checks);
    claims.scope = notReady("account_gated", { access_state: accessByRole.get(DOCUMENT_ROLES.EXECUTED_CONTRACT)?.access_state });
    claims.pricing = notReady("account_gated", { access_state: accessByRole.get(DOCUMENT_ROLES.PRICING_SCHEDULE)?.access_state });
    claims.promises = notReady("account_gated", { access_state: accessByRole.get(DOCUMENT_ROLES.STATEMENT_OF_WORK)?.access_state });
    claims.service_geography = checks.facility && checks.neighborhood
      ? ready(routeEvidence(
        "service_geography",
        "BHRAGS facility site at 3218 Emmons Avenue is resolved to Sheepshead Bay-Manhattan Beach-Gerritsen Beach",
        sourcePassage({
          url: "https://a856-cityrecord.nyc.gov/RequestDetail/20240829105",
          role: "city_record_notice",
          locator: "notice 20240829105 facility description",
          excerpt: "3218 Emmons Avenue, Brooklyn; 60 units.",
          identityBasis: `notice ${expected.notice_id} joined to exact contract id ${contractId}`,
        }),
        "facility_site",
      ))
      : notReady("facility_or_neighborhood_missing", checks);
    claims.performance = notReady("not_located", {
      access_state: accessByRole.get(DOCUMENT_ROLES.PERFORMANCE_EVALUATION)?.access_state,
    });
    return claims;
  }

  claims.scope = notReady("account_gated", { access_state: accessByRole.get(DOCUMENT_ROLES.STATEMENT_OF_WORK)?.access_state });
  claims.pricing = notReady("account_gated", { access_state: accessByRole.get(DOCUMENT_ROLES.PRICING_SCHEDULE)?.access_state });
  claims.promises = notReady("account_gated", { access_state: accessByRole.get(DOCUMENT_ROLES.EXECUTED_CONTRACT)?.access_state });
  claims.service_geography = notReady("account_gated", { access_state: accessByRole.get(DOCUMENT_ROLES.SITE_SCHEDULE)?.access_state });
  claims.performance = notReady("not_located", {
    access_state: accessByRole.get(DOCUMENT_ROLES.PERFORMANCE_EVALUATION)?.access_state,
  });
  return claims;
}

function accessSummary(contractId, accessByContract) {
  const roles = accessByContract.get(contractId);
  if (!roles) throw new Error(`missing access rows for ${contractId}`);
  return Object.fromEntries(REQUIRED_DOCUMENT_ROLES.map((role) => {
    const row = roles.get(role);
    if (!row) throw new Error(`missing access row ${contractId}/${role}`);
    return [role, {
      access_state: row.access_state,
      observed_at: row.observed_at,
      checked_source_ids: row.checked_source_ids,
      source_class: row.source_class,
    }];
  }));
}

function readinessFor(examples) {
  const perExample = {};
  for (const example of examples) {
    const values = Object.values(example.claims);
    const readyCount = values.filter((claim) => claim.status === "ready").length;
    perExample[example.contract_id] = {
      ready: readyCount === values.length,
      ready_claims: readyCount,
      claim_count: values.length,
    };
  }
  const perClaim = Object.fromEntries(CLAIMS.map((claimId) => {
    const rows = examples.map((example) => example.claims[claimId]);
    return [claimId, {
      ready: rows.every((claim) => claim.status === "ready"),
      ready_examples: rows.filter((claim) => claim.status === "ready").length,
      example_count: rows.length,
    }];
  }));
  return {
    per_example: perExample,
    per_claim: perClaim,
    whole_set_ready: Object.values(perExample).every((row) => row.ready),
  };
}

function boundaryEvidence({ revision, dataVintage }) {
  const pages = [
    ["CT185720228800365", "Firematic", ["Original contract amount", "Current contract total", "Action amount"]],
    ["CT185020228802305", "TAMEER", ["Original contract amount", "Current contract total", "Action amount"]],
  ];
  return pages.map(([contractId, label, fields]) => ({
    contract_id: contractId,
    label,
    status: "bounded",
    route: procurementRoute(contractId),
    revision,
    data_vintage: dataVintage,
    allowed_claims: ["amendment_total"],
    disallowed_claims: ["executed_scope", "contractual_unit_pricing", "vendor_promises"],
    assertion: `${label} remains an amendment-total example; its page exposes field roles ${fields.join(", ")}.`,
  })).concat({
    example: "museum-project-context",
    route: "/notices/20260810048/",
    revision,
    data_vintage: dataVintage,
    status: "context_only",
    allowed_claims: ["project_context"],
    disallowed_claims: ["executed_contract_scope"],
    assertion: "Museum scope remains project context, not executed-contract scope.",
  });
}

function vendorPromiseNotReady() {
  return promotionNotReady("vendor_promise", "no_public_executed_agreement_or_sow", {
    admission_rule: "A served exact passage from a publicly accessible or redistribution-authorized executed agreement or SOW is required.",
    rejected_standins: [
      "synthetic_fixture",
      "draft",
      "bid",
      "audit_quotation",
      "authenticated_screen",
      "nonofficial_repost",
      "narrative",
    ],
  });
}

function promotionAccessCell({
  contractId,
  label,
  readback,
  roleManifest,
  sourceUrl,
  sourceHash,
  documentRole,
  locator,
  identityBasis,
  assertion,
  roleRoute = null,
}) {
  const rendered = roleRoute
    ? roleCapture(roleManifest, roleRoute)
    : productionRender(readback, contractId);
  const browser = roleRoute
    ? promotionEvidence({
      route: rendered.capture.route,
      component: rendered.capture.route === "real-corpus-harness" ? "real-corpus-harness" : null,
      servedBuildRevision: manifestRevision(roleManifest.source_revision),
      dataVintage: roleManifest.data_vintages.role_corpus_generated_at,
      sourceUrl,
      sourceHash,
      documentRole,
      locator,
      assertion,
      identityBasis,
      renderHash: rendered.desktop.render_sha256,
      viewport: rendered.desktop.name,
      evidenceType: "browser_dom",
      provenanceClass: "real_source_browser_dom",
    })
    : promotionEvidence({
      route: rendered.route,
      servedBuildRevision: rendered.revision,
      dataVintage: rendered.data_vintage,
      sourceUrl,
      sourceHash: `sha256:${rendered.render_hash}`,
      documentRole: "cityscroll_served_contract_page",
      locator,
      assertion,
      identityBasis,
      renderHash: rendered.render_hash,
      viewport: rendered.viewport,
      evidenceType: "browser_dom",
      provenanceClass: "production_browser_dom",
    });
  return promotionCell("access", browser, `${label} ${assertion}`);
}

export function buildRealExamplePromotionReceipt({ groundedOriginMain = gitRevision() } = {}) {
  const corpus = readJson("site/data/procurement_contract_substance_real_corpus.json");
  const roleCorpus = readJson("site/data/procurement_contract_substance_role_corpus.json");
  const roleManifest = readJson("docs/evidence/contract-substance-role-corpus/capture-manifest.json");
  const readback = readJson("docs/evidence/procurement-disclosure-production-proof/production-readback.json");
  const notice = corpusDocument(corpus, "city-record-notice-20240829105");
  const dcasDocument = corpusDocument(corpus, "dcas-bid-tab-2000090");
  const mocsDocument = corpusDocument(corpus, "mocs-fcrc-packet-202411-proposed-agreement");
  const dcasCapture = roleCapture(roleManifest, "real-corpus-harness");
  const docgoCapture = roleCapture(roleManifest, "/procurements/procurement%3Acontract%3ACT180620248801671");
  const bhragsCapture = roleCapture(roleManifest, "/procurements/procurement%3Acontract%3ACT107120258801626");
  const captureRevision = manifestRevision(roleManifest.source_revision);
  if (captureRevision !== groundedOriginMain) {
    throw new Error(`role-corpus capture is not grounded at origin/main ${groundedOriginMain}`);
  }

  const roleEvidence = (claimFamily, row, capture, identityBasis, assertion) => promotionCell(
    claimFamily,
    promotionEvidence({
      route: capture.capture.route,
      component: capture.capture.route === "real-corpus-harness" ? "real-corpus-harness" : null,
      servedBuildRevision: captureRevision,
      dataVintage: roleManifest.data_vintages.role_corpus_generated_at,
      sourceUrl: row.public_url,
      sourceHash: row.content_hash,
      documentRole: row.document_role,
      locator: row.locator,
      assertion,
      identityBasis,
      renderHash: capture.desktop.render_sha256,
      viewport: capture.desktop.name,
    }),
  );

  const smallContract = (contractId, label, amount) => ({
    example_id: `${label.toLowerCase().replace(/[^a-z]+/g, "-")}-${contractId}`,
    label,
    identity: contractId,
    canonical_identity_basis: `exact contract id ${contractId} in the retained public contract materialization`,
    route: procurementRoute(contractId),
    stories: [`${label} proves below-$100,000 discovery ($${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}) while its contract-document access state remains separately classified.`],
    cells: [
      promotionAccessCell({
        contractId,
        label,
        readback,
        sourceUrl: `${PUBLIC_SITE}${procurementRoute(contractId)}`,
        documentRole: "cityscroll_served_contract_page",
        locator: "served contract amount and disclosure/access state",
        identityBasis: `exact contract id ${contractId}`,
        assertion: `the served page retains the ${label} amount and role-specific access state`,
      }),
      promotionNotReady("pricing_role", "account_gated_pricing_source", { access_state: "account_gated" }),
      promotionNotReady("obligation_role", "account_gated_executed_source", { access_state: "account_gated" }),
      promotionNotReady("performance", "not_located_public_evaluation", { access_state: "not_located" }),
      promotionNotReady("neighborhood", "no_admitted_service_place_evidence"),
      vendorPromiseNotReady(),
    ],
  });

  const bhragsRoute = procurementRoute("CT107120258801626");
  const bhragsSource = promotionEvidence({
    route: bhragsRoute,
    servedBuildRevision: captureRevision,
    dataVintage: roleManifest.data_vintages.service_geography_generated_at,
    sourceUrl: notice.final_url,
    sourceHash: notice.content_hash,
    documentRole: notice.document_role,
    locator: notice.locator,
    assertion: "BHRAGS joins the exact contract and notice to the facility address, unit count, and resolved neighborhood.",
    identityBasis: "exact contract id CT107120258801626 joined to notice 20240829105",
    renderHash: bhragsCapture.desktop.render_sha256,
    placeRole: "facility_site",
  });
  const bhrags = {
    example_id: "bhrags-CT107120258801626",
    label: "BHRAGS",
    identity: "CT107120258801626",
    canonical_identity_basis: "exact contract id CT107120258801626 joined to notice 20240829105",
    route: bhragsRoute,
    stories: ["BHRAGS proves the joined authorized amount, payment total, facility address, unit count, notice identity, and neighborhood story without turning facility context into a contractual promise."],
    cells: [
      promotionCell("access", bhragsSource, "BHRAGS preserves the joined amount, payment, facility, and exact identity story."),
      promotionNotReady("pricing_role", "account_gated_pricing_source", { access_state: "account_gated" }),
      promotionNotReady("obligation_role", "account_gated_executed_source", { access_state: "account_gated" }),
      promotionNotReady("performance", "not_located_public_evaluation", { access_state: "not_located" }),
      promotionCell("neighborhood", bhragsSource, "BHRAGS notice-attributed facility site resolves to the named neighborhood."),
      vendorPromiseNotReady(),
    ],
  };

  const docgoRow = rolePassage(roleCorpus, "comptroller-docgo-audit-20248801671", (row) => /food cost caps/i.test(row.locator));
  const docgoAccess = roleEvidence(
    "access",
    docgoRow,
    docgoCapture,
    "exact CityScroll contract id CT180620248801671 joined to publisher number 20248801671",
    "canonical contract identity is joined to the official Comptroller audit without treating the audit as the executed agreement",
  );
  const docgo = {
    example_id: "docgo-CT180620248801671",
    label: "DocGo",
    identity: "CT180620248801671 / 20248801671",
    canonical_identity_basis: "exact contract id CT180620248801671 joined to publisher contract number 20248801671",
    route: procurementRoute("CT180620248801671"),
    stories: ["DocGo proves a canonical contract identity joined to official oversight evidence; the audit's reported rates remain audit-reported, not vendor promises."],
    cells: [
      docgoAccess,
      roleEvidence("pricing_role", docgoRow, docgoCapture, "exact contract id CT180620248801671 joined to publisher number 20248801671", "the Comptroller audit reports contract rates with its audit role preserved"),
      promotionNotReady("obligation_role", "audit_is_not_executed_agreement", { document_role: "performance_evaluation" }),
      roleEvidence("performance", docgoRow, docgoCapture, "exact contract id CT180620248801671 joined to publisher number 20248801671", "the official audit supplies a performance-evaluation passage tied to DocGo"),
      promotionNotReady("neighborhood", "no_admitted_service_place_evidence"),
      vendorPromiseNotReady(),
    ],
  };

  const dcasRow = rolePassage(roleCorpus, "dcas-bid-tab-2000090", (row) => /class awards/i.test(row.locator));
  const dcas = {
    example_id: "dcas-bid-tab-2000090",
    label: "DCAS bid tab 2000090",
    identity: "BID2000090",
    canonical_identity_basis: "exact public bid number 2000090 in the DCAS bid-tab PDF",
    route: "real-corpus-harness",
    stories: ["DCAS proves offered unit prices and class-award totals with the bid-tab role intact; an offer is not an executed vendor promise."],
    cells: [
      roleEvidence("access", dcasRow, dcasCapture, "exact bid number 2000090 (BID2000090)", "the official DCAS bid tab is publicly retrievable and rendered through the role-corpus harness"),
      roleEvidence("pricing_role", dcasRow, dcasCapture, "exact bid number 2000090 (BID2000090)", "DCAS offered unit prices and class awards remain bid-offer facts"),
      promotionNotReady("obligation_role", "bid_is_not_executed_agreement", { document_role: "bid_tab" }),
      promotionNotReady("performance", "no_admitted_performance_evaluation"),
      promotionNotReady("neighborhood", "bid_tab_has_no_service_place"),
      vendorPromiseNotReady(),
    ],
  };

  const mocsObligation = rolePassage(roleCorpus, "mocs-fcrc-packet-202411-proposed-agreement", (row) => /pages 41-43/i.test(row.locator));
  const mocsPricing = rolePassage(roleCorpus, "mocs-fcrc-packet-202411-proposed-agreement", (row) => row.document_role === "template_pricing");
  const mocsSchedule = rolePassage(roleCorpus, "mocs-fcrc-packet-202411-proposed-agreement", (row) => /page 72/i.test(row.locator));
  const mocs = {
    example_id: "mocs-november-2024-fcrc",
    label: "MOCS November 2024 FCRC packet",
    identity: "MOCS-FCRC-202411",
    canonical_identity_basis: "exact MOCS-FCRC-202411 packet source document and named proposed-agreement/template identities",
    route: "real-corpus-harness",
    stories: ["MOCS proves proposed duties, site schedules, and template fees with their proposed/template roles intact; the packet's blank execution state blocks a vendor-promise claim."],
    cells: [
      roleEvidence("access", mocsSchedule, dcasCapture, "exact MOCS-FCRC-202411 packet URL", "the official FCRC packet is publicly retrievable and rendered in the role-corpus harness"),
      roleEvidence("pricing_role", mocsPricing, dcasCapture, "exact MOCS-FCRC-202411-CWTP template identity", "MOCS template pricing remains labeled as template pricing"),
      roleEvidence("obligation_role", mocsObligation, dcasCapture, "exact MOCS-FCRC-202411-GROWNYC proposed identity", "MOCS proposed operational duties remain proposed agreement terms"),
      promotionNotReady("performance", "no_admitted_performance_evaluation"),
      promotionNotReady("neighborhood", "site_schedule_is_not_resolved_neighborhood", { document_role: "site_schedule" }),
      vendorPromiseNotReady(),
    ],
  };

  const examples = [
    bhrags,
    smallContract("CT110220271400991", "S&P", 62500),
    smallContract("CT105720278802113", "AHA", 46673.32),
    smallContract("CT104020273009333", "Quizizz", 25000),
    docgo,
    dcas,
    mocs,
  ];
  const cells = examples.flatMap((example) => example.cells);
  const readyCells = cells.filter((cell) => cell.status === "ready");
  const provenanceCounts = readyCells.reduce((counts, cell) => {
    const provenance = cell.evidence?.provenance_class || "unknown";
    if (provenance === "synthetic_fixture") counts.synthetic_fixture_cells += 1;
    else if (provenance === "mutation") counts.mutation_cells += 1;
    else counts.real_source_cells += 1;
    return counts;
  }, { real_source_cells: 0, synthetic_fixture_cells: 0, mutation_cells: 0 });
  return {
    schema: PROMOTION_SCHEMA,
    mode: "receipt-matrix",
    grounded_origin_main: groundedOriginMain,
    capture_manifest: {
      path: "docs/evidence/contract-substance-role-corpus/capture-manifest.json",
      revision: captureRevision,
      assertion: "All role-corpus viewport hashes are from the headless capture recorded at the grounded origin/main revision.",
    },
    assertions: [
      { id: "A1", assertion: "The matrix names BHRAGS, S&P, AHA, Quizizz, DocGo, DCAS bid tab 2000090, and the MOCS November 2024 FCRC packet with identity, route or component, role, and readiness state.", artifact: "examples[].example_id, examples[].canonical_identity_basis, examples[].route, examples[].cells[]" },
      { id: "A2", assertion: "Each named example records the bounded resident story it proves, including joined payments and place, below-$100,000 discovery, oversight, offered pricing, and proposed roles.", artifact: "examples[].stories" },
      { id: "A3", assertion: "The vendor-promise family remains not ready until a served exact passage from an admitted executed agreement or SOW exists, and listed stand-ins are rejected.", artifact: "boundary, examples[].cells[claim_family=vendor_promise]" },
      { id: "A4", assertion: "The receipt completes without a publisher event while retaining the missing executed-document claim as red.", artifact: "completion" },
      { id: "A5", assertion: "Every ready cell carries route, served revision, data vintage, source URL and hash, role, locator, assertion, viewport, and render or content hash; synthetic and mutation counts remain separate.", artifact: "examples[].cells[].evidence, provenance_counts, synthetic_fixture_policy" },
      { id: "A6", assertion: "The validator rejects API-for-DOM substitution, stale identity, unrelated joins, role changes, blank execution evidence, login-only sources, failed initialization, wrong place roles, and omitted examples.", artifact: "validatePromotionReceipt and its mutation tests" },
      { id: "A7", assertion: "The editor packet separates safe-now statements from statements blocked by contract-document disclosure and keeps engineering, deployment, and editorial status distinct.", artifact: "editor_packet, engineering_status, deployment_status, editorial_readiness" },
    ],
    examples,
    claim_families: PROMOTION_CLAIM_FAMILIES,
    provenance_counts: provenanceCounts,
    synthetic_fixture_policy: {
      synthetic_fixture_cells: provenanceCounts.synthetic_fixture_cells,
      mutation_cells: provenanceCounts.mutation_cells,
      rule: "Synthetic fixtures and mutations are counted and labeled, but neither can satisfy a ready cell.",
    },
    boundary: {
      claim_family: "vendor_promise",
      status: "not_ready",
      required_evidence: "a publicly accessible or redistribution-authorized executed agreement or SOW with a served exact passage",
      rejected_standins: ["fixture", "draft", "bid", "audit quotation", "authenticated screen", "nonofficial repost", "narrative"],
      assertion: "The vendor-promise family remains red until an admitted executed document is served; no publisher event is required to complete this bounded receipt.",
    },
    completion: {
      status: "complete",
      publisher_event_required: false,
      missing_claims_remain_red: true,
      assertion: "The matrix and bounded editor packet are complete without waiting for a future executed-document publication.",
    },
    engineering_status: {
      state: "complete",
      assertion: "The receipt builder, validator, and mutation tests cover all seven named examples and the rejection boundary.",
    },
    deployment_status: {
      state: "observed",
      served_build_revision: readback.served_build.pages_deploy_commit,
      data_vintage: readback.served_build.shared_procurement_read_model_generated_at,
      assertion: "Production route observations remain separate from implementation completion.",
    },
    editorial_readiness: {
      state: "bounded",
      ready_claim_families: ["access", "pricing_role", "obligation_role", "performance", "neighborhood"],
      blocked_claim_families: ["vendor_promise"],
      assertion: "Only role-correct, source-grounded statements are safe to send; the vendor-promise statement remains blocked.",
    },
    editor_packet: {
      safe_to_send_now: [
        { id: "bhrags-joined-story", claim_family: "access", statement: "BHRAGS demonstrates a joined contract, payment, facility, and neighborhood story." },
        { id: "small-contract-discovery", claim_family: "access", statement: "S&P, AHA, and Quizizz demonstrate below-$100,000 discovery with role-specific access states." },
        { id: "docgo-oversight-join", claim_family: "performance", statement: "DocGo demonstrates a canonical contract joined to official oversight evidence." },
        { id: "dcas-offered-pricing", claim_family: "pricing_role", statement: "DCAS demonstrates offered pricing and class awards labeled as bid-tab facts." },
        { id: "mocs-proposed-roles", claim_family: "obligation_role", statement: "MOCS demonstrates proposed duties, site schedules, and template fees without role inflation." },
      ],
      blocked_by_contract_document_disclosure: [
        { id: "vendor-promise", claim_family: "vendor_promise", statement: "The statement that a vendor promised a term remains blocked until an admitted executed agreement or SOW supplies a served exact passage." },
      ],
    },
  };
}

export async function buildFixturePacket({ revision = gitRevision(), captureClock = CAPTURE_CLOCK } = {}) {
  const readModel = readJson("site/data/shared_procurement_read_model.json");
  const access = readJson("site/data/procurement_contract_substance_access.json");
  const geography = readJson("site/data/procurement_contract_service_geography.json");
  const accessCoverage = validateFixedContractAccessCoverage(access);
  if (!accessCoverage.ok) throw new Error(`access materialization is incomplete: ${accessCoverage.errors.join(", ")}`);
  const byContract = accessRows(access);
  const dataVintage = readModel.generated_at;
  const examples = [];
  const renderEntries = [];

  await withPinnedClock(captureClock, async () => {
    for (const [contractId, expected] of Object.entries(EXAMPLES)) {
      const route = procurementRoute(contractId);
      const renders = {};
      for (const viewport of VIEWPORTS) {
        const response = await servedContract(contractId, readModel, { "X-Test-Viewport": viewport.header });
        if (response.status !== 200) throw new Error(`${contractId}/${viewport.name} returned HTTP ${response.status}`);
        const renderHash = sha256(response.body);
        renders[viewport.name] = { status: response.status, body: response.body, render_hash: renderHash };
        renderEntries.push({
          route,
          viewport: viewport.name,
          revision,
          data_vintage: dataVintage,
          assertion: `${expected.label} canonical page renders the named contract at ${viewport.header} after initialization`,
          render_hash: renderHash,
        });
      }
      const claims = claimSetFor(
        contractId,
        {
          route,
          revision,
          dataVintage,
          renderHash: renders.desktop.render_hash,
          body: renders.desktop.body,
          accessByRole: byContract.get(contractId),
        },
      );
      examples.push({
        contract_id: contractId,
        label: expected.label,
        route,
        amount: expected.amount,
        vendor: expected.vendor,
        facts: contractId === "CT107120258801626"
          ? {
            authorized_total: 10869881,
            paid_total: 7385672.19,
            payment_count: 31,
            notice_id: expected.notice_id,
            address: expected.address,
            units: expected.units,
            place_role: "facility_site",
            neighborhood: expected.neighborhood,
          }
          : { amount: expected.amount },
        access: accessSummary(contractId, byContract),
        claims,
      });
    }
  });

  const packet = {
    schema: RELEASE_SCHEMA,
    mode: "fixture",
    evidence_class: "offline-fixture-render",
    captured_at: captureClock,
    tool: TOOL,
    served_build: {
      revision,
      data_vintage: dataVintage,
      source: "site/data/shared_procurement_read_model.json",
    },
    source_vintages: {
      contract_substance_access: access.observation_vintage,
      service_geography: geography.generated_at,
    },
    examples,
    render_entries: renderEntries,
    obligations: examples.flatMap((example) => CLAIMS.map((claimId) => ({
      id: `${example.contract_id}:${claimId}`,
      contract_id: example.contract_id,
      claim: claimId,
      state: example.claims[claimId].status,
    }))),
    boundaries: boundaryEvidence({ revision, dataVintage }),
    admitted_public_executed_examples: [],
    readiness: readinessFor(examples),
    production_readiness: {
      ready: false,
      reason: "fixture evidence is not a production observation",
    },
  };
  assertReleasePacket(packet);
  return packet;
}

function productionUrl(site, contractId) {
  return `${site.replace(/\/$/, "")}${procurementRoute(contractId)}`;
}

function productionCapture({ site = PUBLIC_SITE } = {}) {
  const result = spawnSync(
    "python3",
    [join(ROOT, PRODUCTION_CAPTURE_TOOL), "--site", site, "--json-stdout"],
    { cwd: ROOT, encoding: "utf8", timeout: 180_000 },
  );
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || `production browser capture exited ${result.status}`).trim());
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`production browser capture returned invalid JSON: ${error.message}`);
  }
}

function productionReadJson(url, fetchImpl) {
  return fetchImpl(url).then(async (response) => {
    const body = await response.text();
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
    try {
      return JSON.parse(body);
    } catch (error) {
      throw new Error(`${url} returned invalid JSON: ${error.message}`);
    }
  });
}

function productionEvidence({ observation, route, revision, dataVintage, claim, assertion, source, placeRole = null }) {
  return {
    evidence_type: "browser_dom",
    route,
    revision,
    data_vintage: dataVintage,
    render_hash: observation.render_hash,
    rendered: observation.rendered,
    initialization: observation.initialization,
    viewport: observation.viewport,
    assertion,
    source,
    served_passage: source.excerpt,
    place_role: placeRole,
    claim,
    contract_id: "CT107120258801626",
  };
}

export async function buildProductionPacket({
  site = PUBLIC_SITE,
  fetchImpl = fetch,
  now = testClockISOString(),
  groundedOriginMain = null,
  observations = null,
} = {}) {
  const [artifactManifest, readModel] = await Promise.all([
    productionReadJson(`${site.replace(/\/$/, "")}/artifact-manifest.json`, fetchImpl),
    productionReadJson(`${site.replace(/\/$/, "")}/data/shared_procurement_read_model.json`, fetchImpl),
  ]);
  const captured = observations || productionCapture({ site });
  const expectedRoute = procurementRoute("CT107120258801626");
  const viewportObservations = captured.observations || [];
  const desktop = viewportObservations.find((row) => row.viewport === "desktop");
  const mobile = viewportObservations.find((row) => row.viewport === "mobile");
  const requiredFacts = {
    contract_id: "CT107120258801626",
    vendor: "BHRAGS HOME CARE CORP",
    authorized_total: 10869881,
    paid_total: 7385672.19,
    payment_count: 31,
    notice_id: "20240829105",
    address: "3218 Emmons Avenue, Brooklyn",
    units: 60,
    place_role: "facility_site",
    neighborhood: "Sheepshead Bay-Manhattan Beach-Gerritsen Beach",
  };
  const source = {
    url: productionUrl(site, "CT107120258801626"),
    document_role: "cityscroll_served_contract_page",
    locator: "contract facts, payment summary, and facility-site row",
    excerpt: "$10,869,881 authorized; $7,385,672.19 paid; 31 payments; notice 20240829105; 3218 Emmons Avenue, Brooklyn; 60 units; Facility site; Sheepshead Bay-Manhattan Beach-Gerritsen Beach.",
    content_hash: null,
    identity_basis: "exact contract id CT107120258801626 joined to notice 20240829105",
  };
  const geographySource = {
    url: "https://a856-cityrecord.nyc.gov/RequestDetail/20240829105",
    document_role: "city_record_notice",
    locator: "notice 20240829105 facility description",
    excerpt: "3218 Emmons Avenue, Brooklyn; 60 units.",
    content_hash: null,
    identity_basis: "notice 20240829105 joined to exact contract id CT107120258801626",
  };
  const observationReady = (row) => Boolean(
    row
      && row.http_status === 200
      && row.rendered === true
      && row.initialization === "settled"
      && /^[a-f0-9]{64}$/i.test(String(row.render_hash || ""))
      && Object.entries(requiredFacts).every(([key, value]) => row.facts?.[key] === value),
  );
  const ready = observationReady(desktop) && observationReady(mobile);
  const example = {
    contract_id: requiredFacts.contract_id,
    label: "BHRAGS",
    route: expectedRoute,
    amount: requiredFacts.authorized_total,
    vendor: requiredFacts.vendor,
    facts: {
      authorized_total: requiredFacts.authorized_total,
      paid_total: requiredFacts.paid_total,
      payment_count: requiredFacts.payment_count,
      notice_id: requiredFacts.notice_id,
      address: requiredFacts.address,
      units: requiredFacts.units,
      place_role: requiredFacts.place_role,
      neighborhood: requiredFacts.neighborhood,
    },
    claims: {
      amount: {
        status: ready ? "ready" : "not_ready",
        reason: ready ? null : "live_browser_observation_incomplete",
        evidence: desktop ? productionEvidence({
          observation: desktop,
          route: expectedRoute,
          revision: artifactManifest.source_commit_sha,
          dataVintage: readModel.generated_at,
          claim: "amount",
          assertion: "BHRAGS live DOM keeps exact contract identity, authorized total, paid total, and 31-payment coverage together",
          source,
        }) : null,
      },
      service_geography: {
        status: ready ? "ready" : "not_ready",
        reason: ready ? null : "live_browser_observation_incomplete",
        evidence: desktop ? productionEvidence({
          observation: desktop,
          route: expectedRoute,
          revision: artifactManifest.source_commit_sha,
          dataVintage: readModel.generated_at,
          claim: "service_geography",
          assertion: "BHRAGS live DOM identifies 3218 Emmons Avenue as a resolved facility site in Sheepshead Bay-Manhattan Beach-Gerritsen Beach",
          source: geographySource,
          placeRole: "facility_site",
        }) : null,
      },
    },
    viewport_observations: viewportObservations,
  };
  return {
    schema: PRODUCTION_SCHEMA,
    mode: "production",
    evidence_class: "production-browser-dom",
    captured_at: now,
    tool: TOOL,
    browser_capture_tool: PRODUCTION_CAPTURE_TOOL,
    grounded_origin_main: groundedOriginMain,
    served_build: {
      live_base: site,
      revision: artifactManifest.source_commit_sha,
      artifact_hash: artifactManifest.artifact_hash,
      data_vintage: readModel.generated_at,
      artifact_manifest_generated_at: artifactManifest.generated_at,
    },
    assertions: [{
      id: "A1",
      assertion: "BHRAGS live proof covers $10,869,881 authorized, $7,385,672.19 paid, 31 payments, 3218 Emmons Avenue, 60 units, exact contract/notice identity, and resolved neighborhood with facility_site semantics.",
      artifact: "examples[0].facts, examples[0].claims.amount.evidence, examples[0].claims.service_geography.evidence, and examples[0].viewport_observations",
    }],
    examples: [example],
    admitted_public_executed_examples: [],
    production_readiness: {
      ready,
      reason: ready ? null : "live browser observation did not cover every named BHRAGS fact at both viewports",
    },
  };
}

export function assertProductionPacket(packet) {
  const errors = [];
  if (!packet || packet.schema !== PRODUCTION_SCHEMA) errors.push(`schema must be ${PRODUCTION_SCHEMA}`);
  if (packet?.mode !== "production") errors.push("production packet mode is required");
  if (packet?.evidence_class !== "production-browser-dom") errors.push("production evidence class is required");
  if (!packet?.served_build?.revision) errors.push("served production revision is required");
  if (!packet?.served_build?.data_vintage) errors.push("served production data vintage is required");
  if (packet?.production_readiness?.ready !== true) errors.push("production packet is not ready");
  const assertion = packet?.assertions?.find((row) => row.id === "A1");
  if (!assertion || !assertion.artifact.includes("examples[0]")) errors.push("A1 assertion is not tied to the production artifact");
  const example = packet?.examples?.[0];
  if (!example || example.contract_id !== "CT107120258801626") errors.push("BHRAGS production example is missing");
  const facts = example?.facts || {};
  for (const [key, value] of Object.entries({
    authorized_total: 10869881,
    paid_total: 7385672.19,
    payment_count: 31,
    notice_id: "20240829105",
    address: "3218 Emmons Avenue, Brooklyn",
    units: 60,
    place_role: "facility_site",
    neighborhood: "Sheepshead Bay-Manhattan Beach-Gerritsen Beach",
  })) if (facts[key] !== value) errors.push(`BHRAGS production fact mismatch ${key}`);
  const observations = example?.viewport_observations || [];
  for (const viewport of ["desktop", "mobile"]) {
    const row = observations.find((entry) => entry.viewport === viewport);
    if (!row || row.http_status !== 200 || row.rendered !== true || row.initialization !== "settled") {
      errors.push(`missing settled live browser observation ${viewport}`);
    }
    if (!/^[a-f0-9]{64}$/i.test(String(row?.render_hash || ""))) errors.push(`missing live render hash ${viewport}`);
  }
  for (const claimId of ["amount", "service_geography"]) {
    const evidence = example?.claims?.[claimId]?.evidence;
    if (!evidence || evidence.evidence_type !== "browser_dom") errors.push(`missing browser DOM evidence ${claimId}`);
    if (evidence?.revision !== packet?.served_build?.revision) errors.push(`stale served identity ${claimId}`);
    if (evidence?.data_vintage !== packet?.served_build?.data_vintage) errors.push(`date-basis mismatch ${claimId}`);
    if (claimId === "service_geography" && evidence?.place_role !== "facility_site") errors.push("wrong place role service_geography");
  }
  if (!Array.isArray(packet?.admitted_public_executed_examples) || packet.admitted_public_executed_examples.length !== 0) {
    errors.push("production packet must not admit an unproven public executed example");
  }
  if (errors.length) throw new Error(`contract-substance production packet invalid:\n${errors.join("\n")}`);
  return packet;
}

function error(errors, message) {
  errors.push(message);
}

export function validatePromotionReceipt(receipt) {
  const errors = [];
  if (!receipt || receipt.schema !== PROMOTION_SCHEMA) error(errors, `schema must be ${PROMOTION_SCHEMA}`);
  if (receipt?.mode !== "receipt-matrix") error(errors, "promotion receipt mode is required");
  if (!/^[a-f0-9]{40}$/i.test(String(receipt?.grounded_origin_main || ""))) error(errors, "grounded origin/main revision is required");
  if (receipt?.capture_manifest?.revision !== receipt?.grounded_origin_main) error(errors, "capture manifest is not grounded at origin/main");
  const assertionIds = Array.isArray(receipt?.assertions) ? receipt.assertions.map((row) => row.id) : [];
  if (JSON.stringify(assertionIds) !== JSON.stringify(["A1", "A2", "A3", "A4", "A5", "A6", "A7"])) error(errors, "promotion assertions A1-A7 are incomplete or reordered");
  for (const assertion of receipt?.assertions || []) if (!assertion.assertion || !assertion.artifact) error(errors, `named assertion ${assertion.id} is incomplete`);
  if (!Array.isArray(receipt?.claim_families) || JSON.stringify(receipt.claim_families) !== JSON.stringify(PROMOTION_CLAIM_FAMILIES)) {
    error(errors, "promotion claim families are incomplete or reordered");
  }
  const examples = Array.isArray(receipt?.examples) ? receipt.examples : [];
  const exampleIds = examples.map((example) => example.example_id);
  if (JSON.stringify(exampleIds) !== JSON.stringify(PROMOTION_EXAMPLE_IDS)) error(errors, "matrix omits a named example or changes example order");
  if (new Set(exampleIds).size !== exampleIds.length) error(errors, "duplicate named promotion example");

  const roleAllowlist = {
    access: new Set(["cityscroll_served_contract_page", "award_notice", "bid_tab", "proposed_agreement", "template_pricing", "site_schedule", "performance_evaluation"]),
    pricing_role: new Set(["bid_tab", "template_pricing", "proposed_agreement", "performance_evaluation"]),
    obligation_role: new Set(["proposed_agreement", "site_schedule", "executed_agreement", "executed_sow", "executed_obligation"]),
    performance: new Set(["performance_evaluation"]),
    neighborhood: new Set(["award_notice", "site_schedule"]),
    vendor_promise: new Set(["executed_agreement", "executed_sow", "executed_obligation"]),
  };
  const readyCells = [];
  for (const example of examples) {
    const cells = Array.isArray(example.cells) ? example.cells : [];
    const seen = new Set();
    for (const cell of cells) {
      if (!PROMOTION_CLAIM_FAMILIES.includes(cell.claim_family)) error(errors, `unknown claim family ${example.example_id}/${cell.claim_family}`);
      if (seen.has(cell.claim_family)) error(errors, `duplicate claim family ${example.example_id}/${cell.claim_family}`);
      seen.add(cell.claim_family);
      if (!cell.assertion) error(errors, `missing named assertion ${example.example_id}/${cell.claim_family}`);
      if (cell.status === "not_ready") {
        if (!cell.reason) error(errors, `not-ready cell needs reason ${example.example_id}/${cell.claim_family}`);
        continue;
      }
      if (cell.status !== "ready") {
        error(errors, `invalid promotion cell state ${example.example_id}/${cell.claim_family}`);
        continue;
      }
      readyCells.push(cell);
      const evidence = cell.evidence;
      if (!evidence) {
        error(errors, `ready promotion cell lacks evidence ${example.example_id}/${cell.claim_family}`);
        continue;
      }
      if (!["source_document", "browser_dom"].includes(evidence.evidence_type)) error(errors, `API-for-DOM substitution ${example.example_id}/${cell.claim_family}`);
      if (!["real_source", "real_source_browser_dom", "production_browser_dom"].includes(evidence.provenance_class)) error(errors, `synthetic fixture cannot satisfy ready cell ${example.example_id}/${cell.claim_family}`);
      if (!evidence.route && !evidence.component) error(errors, `missing route or component ${example.example_id}/${cell.claim_family}`);
      if (!evidence.served_build_revision || !evidence.data_vintage) error(errors, `missing served revision or data vintage ${example.example_id}/${cell.claim_family}`);
      if (![receipt.capture_manifest?.revision, receipt.deployment_status?.served_build_revision].includes(evidence.served_build_revision)) error(errors, `stale served identity ${example.example_id}/${cell.claim_family}`);
      if (!evidence.source_url || !/^https:\/\//i.test(evidence.source_url) || LOGIN_URL_RE.test(evidence.source_url)) error(errors, `login-only or missing source URL ${example.example_id}/${cell.claim_family}`);
      if (!isSha256(evidence.source_hash)) error(errors, `missing source hash ${example.example_id}/${cell.claim_family}`);
      if (!evidence.document_role || !roleAllowlist[cell.claim_family]?.has(evidence.document_role)) error(errors, `source-role change or wrong role ${example.example_id}/${cell.claim_family}`);
      if (!evidence.locator || !evidence.assertion || !evidence.identity_basis) error(errors, `incomplete source locator/assertion/identity ${example.example_id}/${cell.claim_family}`);
      const identityTokens = String(example.identity || "").split(/\s+\/\s+/).filter(Boolean);
      if (identityTokens.length > 0 && !identityTokens.some((token) => evidence.identity_basis.includes(token))) error(errors, `unrelated join ${example.example_id}/${cell.claim_family}`);
      if (!evidence.viewport) error(errors, `missing viewport ${example.example_id}/${cell.claim_family}`);
      if (evidence.evidence_type === "browser_dom") {
        if (!HASH_RE.test(String(evidence.render_hash || ""))) error(errors, `missing render hash ${example.example_id}/${cell.claim_family}`);
        if (evidence.initialization !== "settled") error(errors, `failed asynchronous initialization ${example.example_id}/${cell.claim_family}`);
      } else if (!isSha256(evidence.content_hash)) {
        error(errors, `missing content hash ${example.example_id}/${cell.claim_family}`);
      }
      if (cell.claim_family === "neighborhood" && evidence.place_role && evidence.place_role !== "facility_site" && evidence.place_role !== "service_area" && evidence.place_role !== "beneficiary_area") {
        error(errors, `wrong place role ${example.example_id}/${cell.claim_family}`);
      }
      if (cell.claim_family === "vendor_promise") {
        if (!evidence.execution_evidence || evidence.execution_evidence.signature_present !== true || evidence.execution_evidence.effective_status_admitted !== true) {
          error(errors, `blank signature or missing effective status ${example.example_id}/${cell.claim_family}`);
        }
      }
    }
    for (const claimFamily of PROMOTION_CLAIM_FAMILIES) if (!seen.has(claimFamily)) error(errors, `matrix omits claim family ${example.example_id}/${claimFamily}`);
  }

  const counts = readyCells.reduce((result, cell) => {
    const provenance = cell.evidence?.provenance_class;
    if (provenance === "synthetic_fixture") result.synthetic_fixture_cells += 1;
    else if (provenance === "mutation") result.mutation_cells += 1;
    else result.real_source_cells += 1;
    return result;
  }, { real_source_cells: 0, synthetic_fixture_cells: 0, mutation_cells: 0 });
  if (JSON.stringify(receipt.provenance_counts) !== JSON.stringify(counts)) error(errors, "provenance counts are stale");
  if (receipt?.boundary?.claim_family !== "vendor_promise" || receipt.boundary.status !== "not_ready") error(errors, "vendor-promise boundary is missing");
  if (receipt.boundary.required_evidence?.includes("executed agreement") !== true) error(errors, "vendor-promise boundary lacks executed-document rule");
  if (receipt.boundary.rejected_standins?.includes("fixture") !== true || receipt.boundary.rejected_standins?.includes("audit quotation") !== true) error(errors, "vendor-promise stand-in rejection list is incomplete");
  if (receipt.completion?.status !== "complete" || receipt.completion.publisher_event_required !== false || receipt.completion.missing_claims_remain_red !== true) error(errors, "completion falsely waits for or clears the missing document");
  if (!receipt.engineering_status || !receipt.deployment_status || !receipt.editorial_readiness) error(errors, "engineering, deployment, and editorial statuses must remain separate");
  if (receipt.editorial_readiness?.blocked_claim_families?.includes("vendor_promise") !== true) error(errors, "editorial packet does not block vendor promise");
  if (!Array.isArray(receipt.editor_packet?.safe_to_send_now) || receipt.editor_packet.safe_to_send_now.length < 1) error(errors, "editor packet safe list is missing");
  if (!Array.isArray(receipt.editor_packet?.blocked_by_contract_document_disclosure) || receipt.editor_packet.blocked_by_contract_document_disclosure.length < 1) error(errors, "editor packet blocked list is missing");
  return { ok: errors.length === 0, errors };
}

export function assertPromotionReceipt(receipt) {
  const result = validatePromotionReceipt(receipt);
  if (!result.ok) throw new Error(`contract-substance promotion receipt invalid:\n${result.errors.join("\n")}`);
  return receipt;
}

export function validateReleasePacket(packet) {
  const errors = [];
  if (!packet || packet.schema !== RELEASE_SCHEMA) error(errors, `schema must be ${RELEASE_SCHEMA}`);
  if (packet?.mode !== "fixture") error(errors, "fixture packet mode is required");
  if (packet?.evidence_class !== "offline-fixture-render") error(errors, "fixture evidence class is required");
  if (!packet?.served_build?.revision) error(errors, "served build revision is required");
  if (!packet?.served_build?.data_vintage) error(errors, "served build data vintage is required");
  if (packet?.production_readiness?.ready === true) error(errors, "fixture evidence cannot mark production ready");

  const examples = Array.isArray(packet?.examples) ? packet.examples : [];
  const expectedIds = Object.keys(EXAMPLES);
  const actualIds = examples.map((example) => example.contract_id);
  if (new Set(actualIds).size !== actualIds.length) error(errors, "duplicate named example");
  for (const id of expectedIds) if (!actualIds.includes(id)) error(errors, `missing named example ${id}`);
  for (const id of actualIds) if (!expectedIds.includes(id)) error(errors, `unexpected named example ${id}`);

  const renderKeys = new Set();
  for (const render of Array.isArray(packet?.render_entries) ? packet.render_entries : []) {
    const key = `${render.route}|${render.viewport}`;
    if (renderKeys.has(key)) error(errors, `duplicate render entry ${key}`);
    renderKeys.add(key);
    if (!render.revision || render.revision !== packet?.served_build?.revision) error(errors, `stale served identity ${key}`);
    if (!render.data_vintage || render.data_vintage !== packet?.served_build?.data_vintage) error(errors, `render data vintage mismatch ${key}`);
    if (!HASH_RE.test(String(render.render_hash || ""))) error(errors, `invalid render hash ${key}`);
    if (!render.route || !render.viewport || !render.assertion) error(errors, `incomplete render evidence ${key}`);
  }
  for (const id of expectedIds) {
    const route = procurementRoute(id);
    for (const viewport of VIEWPORTS) {
      if (!renderKeys.has(`${route}|${viewport.name}`)) error(errors, `missing render entry ${route}|${viewport.name}`);
    }
  }

  for (const example of examples) {
    const expected = EXAMPLES[example.contract_id];
    if (!expected) continue;
    if (!example.route || example.route !== procurementRoute(example.contract_id)) error(errors, `wrong route ${example.contract_id}`);
    if (example.amount !== expected.amount) error(errors, `amount mismatch ${example.contract_id}`);
    if (example.contract_id === "CT107120258801626") {
      const facts = example.facts || {};
      for (const [key, value] of Object.entries({
        authorized_total: 10869881,
        paid_total: 7385672.19,
        payment_count: 31,
        notice_id: "20240829105",
        address: "3218 Emmons Avenue, Brooklyn",
        units: 60,
        place_role: "facility_site",
        neighborhood: "Sheepshead Bay-Manhattan Beach-Gerritsen Beach",
      })) if (facts[key] !== value) error(errors, `BHRAGS fact mismatch ${key}`);
    } else if (example.facts?.amount !== expected.amount) {
      error(errors, `small-contract fact mismatch ${example.contract_id}`);
    }
    const roles = example.access || {};
    for (const role of REQUIRED_DOCUMENT_ROLES) {
      const row = roles[role];
      if (!row) {
        error(errors, `missing access state ${example.contract_id}/${role}`);
      } else if (!Object.values(ACCESS_STATES).includes(row.access_state)) {
        error(errors, `invalid access state ${example.contract_id}/${role}`);
      }
    }
    const claims = example.claims || {};
    for (const claimId of CLAIMS) {
      const claim = claims[claimId];
      if (!claim) {
        error(errors, `missing claim ${example.contract_id}/${claimId}`);
        continue;
      }
      if (claim.status !== "ready" && claim.status !== "not_ready") error(errors, `invalid claim state ${example.contract_id}/${claimId}`);
      if (claim.status === "not_ready" && !claim.reason) error(errors, `not-ready claim needs reason ${example.contract_id}/${claimId}`);
      if (claim.status !== "ready") continue;
      const evidence = claim.evidence;
      if (!evidence) {
        error(errors, `ready claim lacks evidence ${example.contract_id}/${claimId}`);
        continue;
      }
      if (evidence.evidence_type !== "browser_dom") error(errors, `API-for-DOM substitution ${example.contract_id}/${claimId}`);
      if (evidence.route !== example.route) error(errors, `claim route mismatch ${example.contract_id}/${claimId}`);
      if (evidence.revision !== packet.served_build.revision) error(errors, `claim stale served identity ${example.contract_id}/${claimId}`);
      if (evidence.data_vintage !== packet.served_build.data_vintage) error(errors, `claim date-basis mismatch ${example.contract_id}/${claimId}`);
      if (!HASH_RE.test(String(evidence.render_hash || ""))) error(errors, `claim render hash missing ${example.contract_id}/${claimId}`);
      if (evidence.rendered !== true || evidence.initialization !== "settled") error(errors, `failed asynchronous initialization ${example.contract_id}/${claimId}`);
      if (!evidence.assertion) error(errors, `claim assertion missing ${example.contract_id}/${claimId}`);
      if (claimId === "service_geography" && !PLACE_ROLES.has(evidence.place_role)) error(errors, `wrong place role ${example.contract_id}/${claimId}`);
      if (evidence.place_role && !PLACE_ROLES.has(evidence.place_role)) error(errors, `wrong place role ${example.contract_id}/${claimId}`);
      if (evidence.source?.url && (!/^https:\/\//i.test(evidence.source.url) || LOGIN_URL_RE.test(evidence.source.url))) {
        error(errors, `login-only or missing public URL ${example.contract_id}/${claimId}`);
      }
      if (SUBSTANCE_CLAIMS.has(claimId)) {
        const source = evidence.source;
        if (!source?.url) error(errors, `login-only or missing public URL ${example.contract_id}/${claimId}`);
        if (!source?.excerpt || !source?.locator || !source?.document_role || !source?.identity_basis) error(errors, `missing exact served passage ${example.contract_id}/${claimId}`);
        if (!HASH_RE.test(String(source?.content_hash || ""))) error(errors, `missing source hash ${example.contract_id}/${claimId}`);
        if (source?.document_role && !PUBLIC_SUBSTANCE_ROLES[claimId].has(source.document_role)) error(errors, `wrong source role ${example.contract_id}/${claimId}`);
        if (evidence.served_passage !== source?.excerpt) error(errors, `served passage mismatch ${example.contract_id}/${claimId}`);
      }
    }
  }

  const obligationIds = Array.isArray(packet?.obligations) ? packet.obligations.map((row) => row.id) : [];
  if (new Set(obligationIds).size !== obligationIds.length) error(errors, "duplicate obligations");
  for (const id of expectedIds) for (const claimId of CLAIMS) {
    const obligation = packet.obligations?.find((row) => row.id === `${id}:${claimId}`);
    if (!obligation) error(errors, `missing obligation ${id}:${claimId}`);
    else if (obligation.state !== packet.examples.find((example) => example.contract_id === id)?.claims?.[claimId]?.status) {
      error(errors, `obligation state mismatch ${id}:${claimId}`);
    }
  }

  const readiness = readinessFor(examples);
  if (JSON.stringify(packet.readiness) !== JSON.stringify(readiness)) error(errors, "readiness matrix is stale or incomplete");
  if (packet.readiness?.whole_set_ready === true && examples.some((example) => Object.values(example.claims).some((claim) => claim.status !== "ready"))) {
    error(errors, "passing subset cannot mark whole example set ready");
  }
  for (const boundary of packet.boundaries || []) {
    if (boundary.disallowed_claims?.includes("vendor_address")) error(errors, "vendor address cannot be a contract place role");
    if (boundary.status === "bounded" && boundary.allowed_claims?.includes("executed_scope")) error(errors, "amendment example cannot prove executed scope");
  }
  return { ok: errors.length === 0, errors };
}

export function assertReleasePacket(packet) {
  const result = validateReleasePacket(packet);
  if (!result.ok) throw new Error(`contract-substance release packet invalid:\n${result.errors.join("\n")}`);
  return packet;
}

async function main() {
  const arg = process.argv[2];
  if (arg === "--fixture") {
    const packet = await buildFixturePacket();
    mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
    writeFileSync(FIXTURE_PATH, `${JSON.stringify(packet, null, 2)}\n`);
    writeFileSync(PROMOTION_PATH, `${JSON.stringify(buildRealExamplePromotionReceipt({ groundedOriginMain: packet.served_build.revision }), null, 2)}\n`);
    process.stdout.write(`wrote ${EVIDENCE_DIR_RELATIVE}/${FIXTURE_NAME} (${packet.readiness.whole_set_ready ? "ready" : "not ready"})\n`);
    return;
  }
  if (arg === "--real-corpus") {
    const receipt = assertPromotionReceipt(buildRealExamplePromotionReceipt({ groundedOriginMain: gitRevision() }));
    mkdirSync(dirname(PROMOTION_PATH), { recursive: true });
    writeFileSync(PROMOTION_PATH, `${JSON.stringify(receipt, null, 2)}\n`);
    process.stdout.write(`wrote ${EVIDENCE_DIR_RELATIVE}/${PROMOTION_NAME} (bounded)\n`);
    return;
  }
  if (arg === "--production") {
    const packet = assertProductionPacket(await buildProductionPacket({ groundedOriginMain: gitRevision() }));
    mkdirSync(dirname(PRODUCTION_PATH), { recursive: true });
    writeFileSync(PRODUCTION_PATH, `${JSON.stringify(packet, null, 2)}\n`);
    process.stdout.write(`wrote ${EVIDENCE_DIR_RELATIVE}/${PRODUCTION_NAME} (ready)\n`);
    return;
  }
  if (arg === "--check") {
    assertReleasePacket(readJson(`${EVIDENCE_DIR_RELATIVE}/${FIXTURE_NAME}`));
    assertProductionPacket(readJson(`${EVIDENCE_DIR_RELATIVE}/${PRODUCTION_NAME}`));
    assertPromotionReceipt(readJson(`${EVIDENCE_DIR_RELATIVE}/${PROMOTION_NAME}`));
    process.stdout.write("contract-substance release fixture: valid\n");
    return;
  }
  throw new Error("usage: node tools/capture_procurement_contract_substance.mjs --fixture|--check");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
