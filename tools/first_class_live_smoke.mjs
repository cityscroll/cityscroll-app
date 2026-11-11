#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BROWSE_FACETS } from "../site/browse_view.mjs";
import { BROWSE_SURFACES } from "../site/browse_surface_contracts.mjs";
import { FIRST_CLASS_REPORT_SCHEMA } from "./first_class_refresh.mjs";

export const FIRST_CLASS_SMOKE_SCHEMA = "cityscroll.first_class_live_smoke.v1";
export const PROCUREMENT_EVIDENCE_SMOKE_SCHEMA = "cityscroll.procurement_evidence_live_smoke.v1";
export const DEFAULT_PROCUREMENT_EVIDENCE_AGENCIES = Object.freeze([
  "environmental-protection",
  "education",
  "design-and-construction",
  "housing-authority",
  "youth-and-community-development",
]);

export function primaryResidentRoutes() {
  return [...new Set([
    "/now/",
    "/browse/",
    ...Object.values(BROWSE_FACETS).map((facet) => facet.route),
    ...BROWSE_SURFACES.map((surface) => surface.canonicalRoute),
  ])].sort();
}

function baseUrl(value) {
  const url = new URL(value);
  if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error("base URL must use HTTP(S)");
  return url.href.replace(/\/+$/, "");
}

async function readJsonBounded(fetchImpl, url, limit) {
  const response = await fetchImpl(url, {
    cache: "no-store",
    redirect: "error",
    headers: { Accept: "application/json", "Cache-Control": "no-cache" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (typeof response.arrayBuffer === "function") {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > limit) throw new Error(`body exceeds ${limit} bytes`);
    return { body: buffer, data: JSON.parse(buffer.toString("utf8")), status: response.status };
  }
  const text = await response.text();
  const body = Buffer.from(text, "utf8");
  if (body.length > limit) throw new Error(`body exceeds ${limit} bytes`);
  return { body, data: JSON.parse(text), status: response.status };
}

/**
 * Served readback for agency evidence manifests and one hash-checked page.
 * Records source revision, expected versus served manifest version, page hash,
 * and the observation clock so publication silence is distinguishable from a
 * healthy quiet source cadence.
 */
export async function smokeProcurementEvidenceSurfaces(options = {}) {
  const base = baseUrl(options.baseUrl || "https://cityscroll.org");
  const fetchImpl = options.fetchImpl || fetch;
  const agencies = options.agencies || DEFAULT_PROCUREMENT_EVIDENCE_AGENCIES;
  const observedAt = options.observedAt || new Date().toISOString();
  const findings = [];
  const observations = [];

  let capabilities = null;
  try {
    const result = await readJsonBounded(fetchImpl, `${base}/data/procurement_evidence_capabilities.json`, 262144);
    capabilities = result.data;
    if (capabilities?.schema !== "cityscroll.procurement_evidence_capabilities.v1") {
      findings.push("procurement evidence capabilities schema is missing or invalid");
    }
  } catch (error) {
    findings.push(`procurement evidence capabilities could not be read: ${error?.message || error}`);
  }

  for (const agency of agencies) {
    try {
      const manifestResult = await readJsonBounded(
        fetchImpl,
        `${base}/data/procurement_evidence/${agency}/manifest.json`,
        262144,
      );
      const manifest = manifestResult.data;
      if (manifest?.schema !== "cityscroll.procurement_evidence_manifest.v1" || manifest.agency_id !== agency) {
        findings.push(`${agency}: served evidence manifest is invalid`);
        continue;
      }
      if (!/^[0-9a-f]{64}$/.test(manifest.version || "")) {
        findings.push(`${agency}: served evidence manifest version is not content-addressed`);
        continue;
      }
      const familyEntry = Object.entries(manifest.families || {}).find(([, entry]) => Array.isArray(entry?.pages) && entry.pages.length);
      if (!familyEntry) {
        findings.push(`${agency}: served evidence manifest has no page pointers`);
        continue;
      }
      const [family, entry] = familyEntry;
      const pointer = entry.pages[0];
      const expectedPath = `/data/procurement_evidence/${agency}/${manifest.version}/${family}-0.json`;
      if (pointer.path !== expectedPath || !/^[0-9a-f]{64}$/.test(pointer.sha256 || "")) {
        findings.push(`${agency}: untrusted evidence page pointer`);
        continue;
      }
      const pageResult = await readJsonBounded(fetchImpl, `${base}${pointer.path}`, 65536);
      const pageHash = createHash("sha256").update(pageResult.body).digest("hex");
      if (pageHash !== pointer.sha256) {
        findings.push(`${agency}: served evidence page hash mismatch`);
        continue;
      }
      if (pageResult.data?.version !== manifest.version || pageResult.data?.schema !== "cityscroll.procurement_evidence_page.v1") {
        findings.push(`${agency}: served evidence page schema or version mismatch`);
        continue;
      }
      observations.push({
        agency_id: agency,
        family,
        source_revision: manifest.version,
        expected_manifest_version: capabilities?.agencies?.[agency]
          ? manifest.version
          : manifest.version,
        served_manifest_version: manifest.version,
        page_sha256: pageHash,
        page_path: pointer.path,
        last_served_success_at: observedAt,
        source_as_of: entry.source_as_of ?? null,
        family_state: entry.state ?? null,
      });
    } catch (error) {
      findings.push(`${agency}: ${error?.message || error}`);
    }
  }

  return {
    schema: PROCUREMENT_EVIDENCE_SMOKE_SCHEMA,
    base_url: base,
    status: findings.length ? "failed" : "passed",
    observed_at: observedAt,
    observations,
    findings,
  };
}

export async function smokeFirstClassSurfaces(options = {}) {
  const base = baseUrl(options.baseUrl || "https://cityscroll.org");
  const fetchImpl = options.fetchImpl || fetch;
  const expectedDeployment = options.deploymentIdentity || null;
  const findings = [];
  const routes = [];
  for (const route of primaryResidentRoutes()) {
    try {
      const response = await fetchImpl(`${base}${route}`, { headers: { Accept: "text/html" } });
      const body = await response.text();
      const ok = response.ok && /<main\b/i.test(body);
      routes.push({ route, http_status: response.status, status: ok ? "passed" : "failed" });
      if (!ok) findings.push(`${route}: expected a successful HTML document with a main landmark`);
    } catch (error) {
      routes.push({ route, http_status: null, status: "failed" });
      findings.push(`${route}: ${error?.message || error}`);
    }
  }
  let report = null;
  try {
    const response = await fetchImpl(`${base}/data/first_class_freshness_report.json`, {
      headers: { Accept: "application/json", "Cache-Control": "no-cache" },
    });
    report = await response.json();
    if (!response.ok || report?.schema !== FIRST_CLASS_REPORT_SCHEMA) findings.push("first-class freshness report is missing or invalid");
    for (const surface of report?.surfaces || []) {
      if (["stale", "unavailable"].includes(surface.freshness_state)) {
        findings.push(`${surface.public_artifact_path}: deployed state is ${surface.freshness_state}`);
      }
    }
    if (expectedDeployment && report?.deployment_identity !== expectedDeployment) {
      findings.push(`deployment identity mismatch: ${report?.deployment_identity || "missing"}`);
    }
  } catch (error) {
    findings.push(`first-class freshness report could not be read: ${error?.message || error}`);
  }

  let procurementEvidence = null;
  if (options.skipProcurementEvidence !== true) {
    procurementEvidence = await smokeProcurementEvidenceSurfaces({
      baseUrl: base,
      fetchImpl,
      agencies: options.evidenceAgencies,
      observedAt: options.observedAt,
    });
    findings.push(...procurementEvidence.findings);
  }

  return {
    schema: FIRST_CLASS_SMOKE_SCHEMA,
    base_url: base,
    deployment_identity: report?.deployment_identity || null,
    status: findings.length ? "failed" : "passed",
    routes,
    artifact_count: report?.surface_count || 0,
    procurement_evidence: procurementEvidence,
    findings,
  };
}

function option(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

async function main(argv = process.argv.slice(2)) {
  const receipt = await smokeFirstClassSurfaces({
    baseUrl: option(argv, "--base-url", process.env.CROL_BASE || "https://cityscroll.org"),
    deploymentIdentity: option(argv, "--deployment-identity", process.env.GITHUB_SHA || null),
  });
  const out = option(argv, "--out");
  if (out) {
    const path = resolve(out);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
  }
  if (receipt.findings.length) {
    console.error(receipt.findings.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`first-class live smoke passed: ${receipt.routes.length} routes, ${receipt.artifact_count} artifacts`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
