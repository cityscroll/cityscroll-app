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
export const RELEASE_SCHEMA = "cityscroll.procurement_contract_substance_release.v1";
export const PRODUCTION_SCHEMA = "cityscroll.procurement_contract_substance_production.v1";
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
    process.stdout.write(`wrote ${EVIDENCE_DIR_RELATIVE}/${FIXTURE_NAME} (${packet.readiness.whole_set_ready ? "ready" : "not ready"})\n`);
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
