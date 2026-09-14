#!/usr/bin/env node
/**
 * Read-only production field capture for the snappiness evidence readers.
 *
 * The deployed Worker's authenticated GET /admin/performance route returns only bounded
 * Analytics Engine aggregates. This producer records those aggregates at the existing
 * reader paths and adds provenance; it never posts to the Worker or writes production data.
 * The admin credential is accepted only through CITYSCROLL_ADMIN_KEY_FILE, read in-process.
 */

import { readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildFieldPerformanceProvenance,
  validateFieldPerformanceEvidence,
} from "../site/field_performance_evidence.mjs";
import { buildNoticeContextReadinessEvidence } from "../site/notice_context_readiness.mjs";
import { buildNoticePrimaryReadinessEvidence } from "../site/notice_primary_readiness.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATASET = "crol_rum_observations_v1";
const DEFAULT_BASE_URL = "https://api.cityscroll.org";
const SAMPLE_FLOOR = 30;
const OUTPUTS = Object.freeze({
  browse: join(ROOT, "docs/evidence/browse-contracts-first-page-read-back/read-back.json"),
  context: join(ROOT, "docs/evidence/notice-context-readiness/read-back.json"),
  primary: join(ROOT, "docs/evidence/notice-primary-readiness/read-back.json"),
});

const SPECS = Object.freeze({
  browse: { route: "/browse/contracts/", metric: "content_ready_ms", surface: "browse-contracts", component: "none" },
  context: { route: "/notice/", metric: "component_ready_ms", surface: "notice", component: "notice-context" },
  primary: { route: "/notice/", metric: "content_ready_ms", surface: "notice", component: "none" },
});

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function adminKey() {
  const path = process.env.CITYSCROLL_ADMIN_KEY_FILE;
  if (!path) throw new Error("CITYSCROLL_ADMIN_KEY_FILE is required");
  const stats = statSync(path);
  if (!stats.isFile() || (stats.mode & 0o777) !== 0o600) {
    throw new Error("CITYSCROLL_ADMIN_KEY_FILE must be a mode-0600 regular file");
  }
  const key = readFileSync(path, "utf8").trim();
  if (!key) throw new Error("CITYSCROLL_ADMIN_KEY_FILE is empty");
  return key;
}

async function getJson(fetchImpl, url, key) {
  const response = await fetchImpl(url, { headers: { authorization: `Bearer ${key}` } });
  let body = null;
  try { body = await response.json(); } catch { /* handled below */ }
  if (!response.ok || !body || typeof body !== "object") {
    throw new Error(`production field read failed (${response.status})`);
  }
  return body;
}

function aggregateFromSeries(series, retention, field) {
  const current = series?.[field] || {};
  return {
    sampledCount: Number.isSafeInteger(current.sampled_count) ? current.sampled_count : 0,
    estimatedCount: Number.isFinite(current.estimated_count) ? current.estimated_count : null,
    windowComplete: retention?.status === "complete",
    p50Ms: current.percentiles?.p50 ?? null,
    p75Ms: current.percentiles?.p75 ?? null,
    p95Ms: current.percentiles?.p95 ?? null,
  };
}

function windowFor(retention) {
  return {
    start: retention?.requested_start || null,
    end: retention?.requested_end || null,
    status: retention?.status || "unavailable",
    fraction: retention?.window_fraction ?? null,
  };
}

function vintageFor(series, dataset) {
  return {
    dataset,
    first_observation_at: series?.first_observation_at || null,
    latest_observation_at: series?.latest_observation_at || null,
  };
}

function provenanceFor(spec, body, revision) {
  const series = body.series?.[0];
  const currentWindow = windowFor(body.retention?.current);
  return buildFieldPerformanceProvenance({
    route: spec.route,
    codeRevision: revision.slice(0, 12),
    dataVintage: vintageFor(series, DATASET),
    observationWindow: {
      start: currentWindow.start,
      end: currentWindow.end,
    },
    sampleCount: series?.current?.sampled_count ?? 0,
    queriedAt: body.generated_at,
    dataset: DATASET,
  });
}

function browseEvidence(body, provenance) {
  const existing = readJson(OUTPUTS.browse);
  const series = body.series?.[0] || {};
  const current = series.current || {};
  const window = windowFor(body.retention?.current);
  const sufficient = current.status === "available" && current.sampled_count >= SAMPLE_FLOOR;
  const p75 = sufficient ? current.percentiles?.p75 ?? null : null;
  const p95 = sufficient ? current.percentiles?.p95 ?? null : null;
  const sloState = !sufficient ? "insufficient_sample" : p75 <= 2500 && p95 <= 5000 ? "pass" : "needs-work";
  const evidence = {
    ...existing,
    queried_at: body.generated_at,
    measurement_class: "field",
    provenance,
    primary: {
      ...existing.primary,
      label: "seven-day-production",
      window: { label: "7d", timezone: "UTC", start: window.start, end: window.end, status: window.status, fraction: window.fraction },
      first_observation_at: series.first_observation_at || null,
      latest_observation_at: series.latest_observation_at || null,
      sampled_count: current.sampled_count || 0,
      estimated_count: current.estimated_count ?? null,
      window_complete: window.status === "complete",
      p50_ms: sufficient ? current.percentiles?.p50 ?? null : null,
      p75_ms: p75,
      p95_ms: p95,
      slo_state: sloState,
      acceptance_A3: {
        sample_floor_met: (current.sampled_count || 0) >= SAMPLE_FLOOR,
        p75_within_budget: p75 != null && p75 <= 2500,
        p95_within_budget: p95 != null && p95 <= 5000,
        pass: sloState === "pass",
        note: sloState === "insufficient_sample"
          ? `Only ${current.sampled_count || 0} retained observations are available in the complete window; percentiles are withheld below the ${SAMPLE_FLOOR}-row floor.`
          : "Production field percentiles are evaluated against the p75 <= 2500 ms / p95 <= 5000 ms budgets.",
      },
    },
  };
  const validation = validateFieldPerformanceEvidence(evidence);
  if (!validation.ok) throw new Error(validation.errors.join("; "));
  return evidence;
}

function contextEvidence(body, provenance) {
  const existing = readJson(OUTPUTS.context);
  const series = body.series?.[0] || {};
  const evidence = buildNoticeContextReadinessEvidence({
    primaryAggregate: aggregateFromSeries(series, body.retention?.current, "current"),
    windowComplete: body.retention?.current?.status === "complete",
    sampleFloor: body.sample_floor || SAMPLE_FLOOR,
    baseline: existing.baseline,
    branchObservations: [],
    provenance,
  });
  const validation = validateFieldPerformanceEvidence(evidence);
  if (!validation.ok) throw new Error(validation.errors.join("; "));
  return evidence;
}

function primaryEvidence(body, provenance) {
  const existing = readJson(OUTPUTS.primary);
  const series = body.series?.[0] || {};
  const currentWindow = body.retention?.current;
  const previousWindow = body.retention?.previous;
  const current = aggregateFromSeries(series, currentWindow, "current");
  const previous = aggregateFromSeries(series, previousWindow, "previous");
  const evidence = buildNoticePrimaryReadinessEvidence({
    beforeAggregate: previous,
    afterAggregate: current,
    beforeWindow: previousWindow ? `${previousWindow.requested_start}/${previousWindow.requested_end}` : null,
    afterWindow: currentWindow ? `${currentWindow.requested_start}/${currentWindow.requested_end}` : null,
    beforeWindowComplete: previousWindow?.status === "complete",
    afterWindowComplete: currentWindow?.status === "complete",
    sampleFloor: body.sample_floor || SAMPLE_FLOOR,
    fieldBaseline: existing.field_baseline,
    ownerCallTiming: existing.owner_call_timing,
    provenance,
  });
  const validation = validateFieldPerformanceEvidence(evidence);
  if (!validation.ok) throw new Error(validation.errors.join("; "));
  return evidence;
}

export async function captureFieldRumEvidence({
  baseUrl = process.env.CITYSCROLL_PERFORMANCE_URL || DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is required");
  const admin = adminKey();
  const health = await getJson(fetchImpl, `${baseUrl.replace(/\/$/, "")}/health`, admin);
  if (!/^[a-f0-9]{40}$/.test(health.commit || "")) throw new Error("production health did not return a code revision");
  const bodies = {};
  for (const [name, spec] of Object.entries(SPECS)) {
    const query = new URLSearchParams({ window: "7d", metric: spec.metric, surface: spec.surface, component: spec.component });
    bodies[name] = await getJson(
      fetchImpl,
      `${baseUrl.replace(/\/$/, "")}/admin/performance?${query}`,
      admin,
    );
  }
  const evidence = {
    browse: browseEvidence(bodies.browse, provenanceFor(SPECS.browse, bodies.browse, health.commit)),
    context: contextEvidence(bodies.context, provenanceFor(SPECS.context, bodies.context, health.commit)),
    primary: primaryEvidence(bodies.primary, provenanceFor(SPECS.primary, bodies.primary, health.commit)),
  };
  writeJson(OUTPUTS.browse, evidence.browse);
  writeJson(OUTPUTS.context, evidence.context);
  writeJson(OUTPUTS.primary, evidence.primary);
  return { revision: health.commit, evidence };
}

async function main() {
  const result = await captureFieldRumEvidence();
  console.log(JSON.stringify({
    source: "production field",
    code_revision: result.revision,
    browse: result.evidence.browse.primary.sampled_count,
    notice_context: result.evidence.context.primary.sampled_count,
    notice_primary: result.evidence.primary.after.sampled_count,
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`production field capture unavailable: ${error.message}`);
    process.exitCode = 1;
  });
}
