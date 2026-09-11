#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  assertProductionProvenance,
  productionProvenance,
} from "./lib/production_provenance.mjs";

export const DIGEST_SHADOW_MONITOR_OBSERVATION_SCHEMA = "cityscroll.digest_shadow_monitor_observation.v1";
export const DIGEST_SHADOW_MONITOR_EVIDENCE_RELPATH = "docs/evidence/digest-shadow-monitor/quiet-watermark-cycles-2026-09-14.json";
export const DIGEST_SHADOW_MONITOR_TOOL = "tools/digest_shadow_monitor.mjs";
export const DIGEST_SHADOW_MONITOR_API_BASE = "https://api.cityscroll.org";
export const UNCHANGED_OBSERVATION = "unchanged-observation";

function emptyDocument(now) {
  return {
    schema: DIGEST_SHADOW_MONITOR_OBSERVATION_SCHEMA,
    updated_at: new Date(now).toISOString(),
    observations: [],
  };
}

export function digestShadowMonitorProvenance({ observed_at, source_revision } = {}) {
  return productionProvenance({
    observed_at,
    tool: DIGEST_SHADOW_MONITOR_TOOL,
    source_revision,
    bases: [DIGEST_SHADOW_MONITOR_API_BASE],
    methods: ["GET"],
  });
}

export function assertDigestShadowMonitorDocument(document, { requireProvenance = true } = {}) {
  if (!document || document.schema !== DIGEST_SHADOW_MONITOR_OBSERVATION_SCHEMA) {
    throw new Error(`document is missing ${DIGEST_SHADOW_MONITOR_OBSERVATION_SCHEMA}`);
  }
  if (!Array.isArray(document.observations) || document.observations.length === 0) {
    throw new Error("digest-shadow monitor evidence has no observations");
  }
  for (const row of document.observations) {
    if (!row?.run_key) throw new Error("observation is missing run_key");
    if (!row?.observed_at) throw new Error(`observation ${row.run_key} is missing observed_at`);
    if (!row?.finding_severity) throw new Error(`observation ${row.run_key} is missing finding_severity`);
    if (typeof row.comment_written !== "boolean") {
      throw new Error(`observation ${row.run_key} is missing comment_written`);
    }
  }
  if (requireProvenance) {
    assertProductionProvenance(document.provenance, { requireSourceRevision: true });
  }
  return document;
}

export function digestShadowObservationFingerprint(summary = {}, extras = {}) {
  const funnel = summary?.selection_funnel || {};
  const codes = [...new Set((summary?.redlines || []).map((row) => row?.code).filter(Boolean))].sort();
  return [
    summary?.run_day || "",
    summary?.ran_at || "",
    summary?.status || "",
    summary?.collapse_stage || "",
    String(funnel.source_candidates ?? ""),
    codes.join(","),
    extras.degraded_reason || "",
  ].join("\n");
}

export function observationMarker(fingerprint) {
  const digest = createHash("sha256").update(String(fingerprint || "")).digest("hex").slice(0, 32);
  return `<!-- cityscroll-digest-shadow-observation:${digest} -->`;
}

export function findingSeverity({ healthy = false, summary = {}, opening = false } = {}) {
  const observations = Array.isArray(summary?.observations) ? summary.observations : [];
  if (observations.some((row) => row?.code === "quiet_watermark")) return "info";
  if (healthy && !opening) return "ok";
  return "attention";
}

export function observationFromCycle({
  runKey,
  result = {},
  commentWritten = false,
  commentSuppressed = null,
} = {}) {
  const summary = result.summary || {};
  const funnel = summary.selection_funnel || {};
  const sourceCandidates = funnel.source_candidates;
  return {
    run_key: runKey,
    observed_at: result.observed_at || null,
    run_day: summary.run_day || null,
    collapse_stage: summary.collapse_stage || null,
    source_candidates: Number.isFinite(Number(sourceCandidates)) ? Number(sourceCandidates) : null,
    finding_severity: result.finding_severity
      || findingSeverity({
        healthy: result.status === "healthy",
        summary,
        opening: result.status === "degraded",
      }),
    comment_written: commentWritten === true,
    comment_suppressed: commentSuppressed || null,
  };
}

async function readDocument(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/** Append or replace one scheduled-cycle observation. Same run_key is replaced. */
export async function appendDigestShadowMonitorObservation(path, observation, {
  now = new Date(),
  provenance = null,
} = {}) {
  const existing = await readDocument(path);
  const document = existing?.schema === DIGEST_SHADOW_MONITOR_OBSERVATION_SCHEMA
    ? existing
    : emptyDocument(now);
  const observations = Array.isArray(document.observations) ? document.observations : [];
  const next = observation;
  const filtered = observations.filter((row) => row?.run_key !== next.run_key);
  filtered.push(next);
  filtered.sort((a, b) => String(a.run_key || "").localeCompare(String(b.run_key || "")));
  const nextProvenance = provenance || document.provenance || null;
  const written = {
    schema: DIGEST_SHADOW_MONITOR_OBSERVATION_SCHEMA,
    updated_at: new Date(now).toISOString(),
    observations: filtered,
  };
  if (nextProvenance) written.provenance = nextProvenance;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(written, null, 2)}\n`, "utf8");
  return written;
}

export function lastObservationPath(stateDir, jobId) {
  return join(stateDir, "jobs", jobId, "last-observation.json");
}

export function stateObservationPath(stateDir, jobId) {
  return join(stateDir, "jobs", jobId, "quiet-watermark-cycles-2026-09-14.json");
}
