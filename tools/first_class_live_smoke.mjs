#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BROWSE_FACETS } from "../site/browse_view.mjs";
import { BROWSE_SURFACES } from "../site/browse_surface_contracts.mjs";
import { FIRST_CLASS_REPORT_SCHEMA } from "./first_class_refresh.mjs";

export const FIRST_CLASS_SMOKE_SCHEMA = "cityscroll.first_class_live_smoke.v1";

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
  return {
    schema: FIRST_CLASS_SMOKE_SCHEMA,
    base_url: base,
    deployment_identity: report?.deployment_identity || null,
    status: findings.length ? "failed" : "passed",
    routes,
    artifact_count: report?.surface_count || 0,
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
