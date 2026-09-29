/**
 * Scheduled acquisition, materialization and publication cycle for the
 * connected-history family.
 *
 * One run acquires the fixed-dossier documents from their publishers,
 * rematerializes every history artifact in memory, decides whether the served
 * bytes may change, verifies what it published, and always leaves a receipt
 * naming the run. A byte-identical run still emits a receipt, so an idempotent
 * cycle is distinguishable from no cycle. A stage failure emits a receipt that
 * names the failed stage and what had been acquired, and leaves the committed
 * materializations in place.
 *
 * Only `runConnectedHistoryCycle` writes a receipt. Rebuilding the artifacts
 * from committed inputs (what a deploy or a builder does) never produces one.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { contentHashOf } from "../../warehouse/lib/document_processing.mjs";
import {
  CONNECTED_HISTORY_DOCUMENTS_SCHEMA,
  acquireConnectedHistoryDocuments,
  assertRetainedObservationsHaveFetchReceipts,
} from "./connected_history_documents.mjs";
import { materializeConnectedHistoryRelations } from "./connected_history_relations.mjs";
import { materializeConnectedHistoryRoles } from "./connected_history_roles.mjs";
import {
  materializeConnectedHistoryTime,
  verifyConnectedHistoryTimeArtifact,
} from "./connected_history_time.mjs";
import {
  buildConnectedHistoryCoverage,
  buildConnectedHistoryCoverageReceipt,
  verifyConnectedHistoryCoverage,
} from "../connected_history_coverage.mjs";

export const CONNECTED_HISTORY_CYCLE_RECEIPT_SCHEMA = "cityscroll.connected_history_cycle_receipt.v1";
export const CONNECTED_HISTORY_CONTENT_FINGERPRINT_RULE = "connected_history_content_fingerprint.v1";

/** The scheduled job, as declared by its workflow. Tests hold the two equal. */
export const CONNECTED_HISTORY_CYCLE = Object.freeze({
  id: "connected-history-cycle",
  workflow: ".github/workflows/connected-history-cycle.yml",
  workflow_file: "connected-history-cycle.yml",
  schedule: "13 7 * * *",
  cadence_hours: 24,
  command: "node tools/connected_history_cycle.mjs --run",
  receipt_path: "site/data/connected_history_cycle.json",
  served_path: "/data/connected_history_cycle.json",
  origin: "https://cityscroll.org",
  publication: Object.freeze({
    kind: "pull_request",
    branch: "automation/connected-history-cycle",
    merge: "auto",
  }),
  held_dir: ".artifacts/connected-history-cycle/held",
  ledger_limit: 30,
});

const RECEIPTS_DIR = "site/data/connected_history_sources/verification_receipts";

/**
 * Every served history materialization, in build order. `mode` says what moves
 * it: a live acquisition, the fixed-dossier judgments in code, the other
 * materializations, or nothing (the frozen evaluation baseline).
 */
export const CONNECTED_HISTORY_MATERIALIZATIONS = Object.freeze([
  Object.freeze({
    id: "cohort",
    path: "site/data/connected_history_evaluation_cohort.json",
    receipt: `${RECEIPTS_DIR}/connected_history_evaluation_cohort_latest.json`,
    builder: "tools/build_connected_history_cohort.mjs",
    mode: "frozen_baseline",
    stamp_source: "frozen evaluation seed",
  }),
  Object.freeze({
    id: "documents",
    path: "site/data/connected_history_documents.json",
    receipt: `${RECEIPTS_DIR}/connected_history_documents_latest.json`,
    builder: "tools/build_connected_history_documents.mjs",
    mode: "acquired",
    stamp_source: "acquisition instant of the published observation set",
  }),
  Object.freeze({
    id: "relations",
    path: "site/data/connected_history_relations.json",
    receipt: `${RECEIPTS_DIR}/connected_history_relations_latest.json`,
    builder: "tools/build_connected_history_relations.mjs",
    mode: "fixed_dossier",
    stamp_source: "fixed-dossier judgment version in code",
  }),
  Object.freeze({
    id: "roles",
    path: "site/data/connected_history_roles.json",
    receipt: `${RECEIPTS_DIR}/connected_history_roles_latest.json`,
    builder: "tools/build_connected_history_roles.mjs",
    mode: "fixed_dossier",
    stamp_source: "fixed-dossier judgment version in code",
  }),
  Object.freeze({
    id: "time",
    path: "site/data/connected_history_time.json",
    receipt: `${RECEIPTS_DIR}/connected_history_time_latest.json`,
    builder: "tools/build_connected_history_time.mjs",
    mode: "fixed_dossier",
    stamp_source: "fixed-dossier judgment version in code",
  }),
  Object.freeze({
    id: "coverage",
    path: "site/data/connected_history_coverage.json",
    receipt: `${RECEIPTS_DIR}/connected_history_coverage_latest.json`,
    builder: "tools/build_connected_history_coverage.mjs",
    mode: "derived",
    stamp_source: "input stamps of the other materializations",
  }),
]);

/** Paths the cycle may change, and therefore the only paths its publication carries. */
export function connectedHistoryCyclePublishedPaths() {
  return [
    CONNECTED_HISTORY_CYCLE.receipt_path,
    ...CONNECTED_HISTORY_MATERIALIZATIONS.flatMap((entry) => [entry.path, entry.receipt]),
  ];
}

function withoutYamlComments(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, ""))
    .join("\n");
}

/**
 * The `on:` triggers a workflow actually declares. Comments are removed first,
 * so a schedule that is only described in a comment does not count.
 */
export function parseWorkflowTriggers(text) {
  const lines = withoutYamlComments(text).split("\n");
  const start = lines.findIndex((line) => /^on:\s*$/.test(line));
  const result = { schedules: [], workflow_dispatch: false };
  if (start < 0) return result;
  let scheduleIndent = null;
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue;
    if (/^\S/.test(line)) break;
    const indent = line.length - line.trimStart().length;
    if (/^\s+workflow_dispatch:/.test(line)) result.workflow_dispatch = true;
    if (/^\s+schedule:\s*$/.test(line)) {
      scheduleIndent = indent;
      continue;
    }
    if (scheduleIndent != null && indent <= scheduleIndent) scheduleIndent = null;
    const cron = scheduleIndent != null && line.match(/^\s+-\s*cron:\s*["']([^"']+)["']\s*$/);
    if (cron) result.schedules.push(cron[1]);
  }
  return result;
}

function cronFieldMatches(field, value, min, max) {
  return field.split(",").some((part) => {
    const [range, stepText] = part.split("/");
    const step = stepText ? Number(stepText) : 1;
    let [low, high] = range === "*" ? [min, max] : range.split("-").map(Number);
    if (high == null) high = stepText ? max : low;
    return value >= low && value <= high && (value - low) % step === 0;
  });
}

/** Longest gap, in hours, between consecutive firings of a five-field UTC cron. */
export function cronMaximumGapHours(cron) {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = String(cron).trim().split(/\s+/);
  if (!dayOfWeek) throw new Error(`not a five-field cron: ${cron}`);
  const fires = [];
  const origin = Date.UTC(2026, 0, 5);
  for (let offset = 0; offset < 28 * 24 * 60; offset += 1) {
    const instant = new Date(origin + offset * 60_000);
    if (cronFieldMatches(minute, instant.getUTCMinutes(), 0, 59)
      && cronFieldMatches(hour, instant.getUTCHours(), 0, 23)
      && cronFieldMatches(dayOfMonth, instant.getUTCDate(), 1, 31)
      && cronFieldMatches(month, instant.getUTCMonth() + 1, 1, 12)
      && cronFieldMatches(dayOfWeek, instant.getUTCDay(), 0, 7)) {
      fires.push(offset);
    }
  }
  if (!fires.length) return Infinity;
  let gap = fires[0] + 28 * 24 * 60 - fires.at(-1);
  for (let index = 1; index < fires.length; index += 1) gap = Math.max(gap, fires[index] - fires[index - 1]);
  return gap / 60;
}

/**
 * Check that the workflow text declares the cycle: its schedule, a manual
 * trigger for a first run, the cycle command in a step, and a cadence no
 * longer than the declared one.
 */
export function checkConnectedHistoryCycleDeclaration(text, declaration = CONNECTED_HISTORY_CYCLE) {
  const errors = [];
  const triggers = parseWorkflowTriggers(text);
  if (!triggers.schedules.length) errors.push("the workflow declares no schedule");
  else if (!triggers.schedules.includes(declaration.schedule)) {
    errors.push(`the workflow schedule (${triggers.schedules.join(", ")}) does not include ${declaration.schedule}`);
  }
  if (!triggers.workflow_dispatch) errors.push("the workflow cannot be started by hand for a first run");
  const steps = withoutYamlComments(text);
  if (!steps.split("\n").some((line) => /^\s+(?:-\s+)?run:\s/.test(line) && line.includes(declaration.command))
    && !new RegExp(`^\\s+${declaration.command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`, "m").test(steps)) {
    errors.push(`no workflow step runs ${declaration.command}`);
  }
  for (const cron of triggers.schedules) {
    if (cronMaximumGapHours(cron) > declaration.cadence_hours) {
      errors.push(`${cron} can leave more than ${declaration.cadence_hours} hours between cycles`);
    }
  }
  return { valid: errors.length === 0, errors, triggers };
}

/** Stages in run order. A receipt's stage list is a prefix of this. */
export const CONNECTED_HISTORY_CYCLE_STAGES = Object.freeze([
  "acquisition",
  "materialization",
  "publication",
  "verification",
]);

/** Document reasons that describe the transport, not the document. */
const TRANSPORT_FAILURE_REASONS = new Set(["retrieval_failure", "parent_page_retrieval_failure"]);

const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;

function clean(value, limit = 300) {
  return String(value ?? "")
    .replace(/\/(?:Users|private|var|tmp|home)\/\S+/g, "<local>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function readText(root, path) {
  const absolute = join(root, path);
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
}

function digestOf(text) {
  return text == null ? null : contentHashOf(text);
}

function headerValue(headers, key) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(key) ?? null;
  return headers[key] ?? null;
}

function looksLikeHtml(text, contentType) {
  if (/html/i.test(String(contentType || ""))) return true;
  return /^\s*(?:<!doctype html|<html[\s>])/i.test(text.slice(0, 512));
}

/**
 * Content fingerprint of a fetched body. HTML loses the markup that differs on
 * every response without changing the document (inline scripts, hidden form
 * state, hidden frames, comments, nonces); anything else is fingerprinted as
 * sent. `normalized` is true only when that removal changed the bytes.
 */
export function documentContentFingerprint(bytes, contentType = null) {
  const buffer = Buffer.from(bytes);
  const raw = contentHashOf(buffer);
  const text = buffer.toString("utf8");
  if (!looksLikeHtml(text, contentType)) return { fingerprint: raw, normalized: false };
  const stable = text
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<input\b[^>]*\btype\s*=\s*["']?hidden["']?[^>]*>/gi, "")
    .replace(/<iframe\b[^>]*display\s*:\s*none[^>]*>[\s\S]*?<\/iframe\s*>/gi, "")
    .replace(/\snonce\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  const fingerprint = contentHashOf(stable);
  return { fingerprint, normalized: fingerprint !== contentHashOf(text) };
}

/**
 * Wrap an httpGet so every request, and the fingerprint of every body, is
 * recorded before the acquisition library sees the response.
 */
export function recordingHttpGet(httpGet) {
  const requests = [];
  const fingerprints = new Map();
  const wrapped = async (url, options) => {
    const entry = { order: requests.length + 1, url: String(url) };
    requests.push(entry);
    try {
      const result = await httpGet(url, options);
      const bytes = result?.bytes ? Buffer.from(result.bytes) : null;
      const contentType = headerValue(result?.headers, "content-type");
      entry.http_status = Number.isInteger(result?.status) ? result.status : null;
      entry.content_type = contentType;
      entry.byte_count = bytes ? bytes.length : null;
      if (bytes) {
        const fingerprint = documentContentFingerprint(bytes, contentType);
        entry.content_hash = contentHashOf(bytes);
        entry.content_fingerprint = fingerprint.fingerprint;
        entry.per_response_markup_removed = fingerprint.normalized;
        fingerprints.set(entry.content_hash, fingerprint);
      }
      entry.outcome = "response";
      return result;
    } catch (error) {
      entry.outcome = "error";
      entry.error = clean(error?.message, 160);
      throw error;
    }
  };
  return { httpGet: wrapped, requests, fingerprints };
}

function withoutObservationClocks(value) {
  if (Array.isArray(value)) return value.map(withoutObservationClocks);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "observation_time") continue;
    result[key] = withoutObservationClocks(entry);
  }
  return result;
}

/**
 * What an observation asserts about its document, without the fetch receipt:
 * no clocks, no body digest or size, and no match offset (it moves with
 * per-response markup ahead of the span).
 */
export function documentObservationFacts(row) {
  if (!row) return null;
  const {
    content_hash: _hash,
    byte_count: _bytes,
    fetched_at: _fetched,
    request_receipt: _receipt,
    ...rest
  } = row;
  const facts = withoutObservationClocks(rest);
  if (facts.source_span) {
    const { match_offset: _offset, ...span } = facts.source_span;
    facts.source_span = span;
  }
  return JSON.stringify(facts);
}

function isTransportFailure(row) {
  return Boolean(row) && row.retained !== true && TRANSPORT_FAILURE_REASONS.has(row.reason);
}

/**
 * Compare each acquired observation with the committed one.
 *
 * - `unchanged`: same facts and the same content (identical fetch digest, or a
 *   fingerprint equal to the baseline recorded for the committed observation).
 * - `reconfirmed`: same facts; the body carries per-response markup and no
 *   fingerprint baseline exists yet, so this run records one.
 * - `reobservation_failed`: the transport failed where the committed record
 *   holds; the committed record is kept.
 * - `changed`: anything else.
 */
export function compareDocumentObservations({ committed, acquired, fingerprints = new Map(), baseline = new Map() }) {
  const committedRows = new Map((committed?.observations || []).map((row) => [row.source_id, row]));
  const acquiredRows = new Map((acquired?.observations || []).map((row) => [row.source_id, row]));
  const ids = [...new Set([...committedRows.keys(), ...acquiredRows.keys()])].sort();
  return ids.map((sourceId) => {
    const before = committedRows.get(sourceId) || null;
    const after = acquiredRows.get(sourceId) || null;
    const fingerprint = after?.content_hash ? fingerprints.get(after.content_hash) || null : null;
    const prior = baseline.get(sourceId);
    const baselineFingerprint = prior && before?.content_hash && prior.committed_content_hash === before.content_hash
      ? prior.committed_content_fingerprint
      : null;
    let comparison;
    let basis;
    if (!before || !after) {
      comparison = "changed";
      basis = before ? "source left the dossier" : "source joined the dossier";
    } else if (documentObservationFacts(before) !== documentObservationFacts(after)) {
      if (isTransportFailure(after) && !isTransportFailure(before)) {
        comparison = "reobservation_failed";
        basis = before.retained
          ? `re-fetch failed (${after.reason}); the committed observation is kept`
          : `re-fetch failed (${after.reason}); the committed outcome (${before.reason}) is kept`;
      } else {
        comparison = "changed";
        basis = "the observation's facts differ from the committed record";
      }
    } else if (before.content_hash === after.content_hash) {
      comparison = "unchanged";
      basis = before.content_hash ? "identical fetch digest" : "same recorded outcome";
    } else if (baselineFingerprint) {
      comparison = fingerprint?.fingerprint === baselineFingerprint ? "unchanged" : "changed";
      basis = comparison === "unchanged"
        ? "content fingerprint equals the baseline recorded for the committed observation"
        : "content fingerprint differs from the baseline recorded for the committed observation";
    } else if (fingerprint?.normalized) {
      comparison = "reconfirmed";
      basis = "facts re-confirmed; per-response markup changed the digest and no fingerprint baseline existed, so this run records one";
    } else {
      comparison = "changed";
      basis = "the document body changed";
    }
    let committedFingerprint = null;
    if (["unchanged", "reconfirmed"].includes(comparison) && before?.content_hash) {
      committedFingerprint = fingerprint?.fingerprint || baselineFingerprint || null;
    } else if (comparison === "reobservation_failed") {
      committedFingerprint = baselineFingerprint;
    }
    return {
      source_id: sourceId,
      publisher: (after || before).publisher || null,
      requested_url: (after || before).requested_url || null,
      resolved_url: after?.resolved_url ?? null,
      http_status: after?.request_receipt?.http_status ?? null,
      status: after?.status ?? null,
      reason: after?.reason ?? null,
      fetched_content_hash: after?.content_hash ?? null,
      byte_count: after?.byte_count ?? null,
      content_fingerprint: fingerprint?.fingerprint ?? null,
      committed: before
        ? { status: before.status, reason: before.reason ?? null, content_hash: before.content_hash ?? null }
        : null,
      comparison,
      basis,
      committed_content_hash: before?.content_hash ?? null,
      committed_content_fingerprint: committedFingerprint,
    };
  });
}

/** Fingerprints the previous receipt recorded for committed observations. */
export function fingerprintBaseline(previousReceipt) {
  const rows = previousReceipt?.acquisition?.documents?.sources || [];
  return new Map(rows
    .filter((row) => row.committed_content_hash && row.committed_content_fingerprint)
    .map((row) => [row.source_id, {
      committed_content_hash: row.committed_content_hash,
      committed_content_fingerprint: row.committed_content_fingerprint,
    }]));
}

function walkJson(root, directory, found = []) {
  const absolute = join(root, directory);
  if (!existsSync(absolute)) return found;
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) walkJson(root, path, found);
    else if (entry.isFile() && entry.name.endsWith(".json")) found.push(path);
  }
  return found;
}

/**
 * Retained measurements under docs/evidence that pin a path's bytes. Changing
 * a pinned path makes that measurement stop describing the served tree.
 */
export function retainedEvidencePins(root, evidenceRoot = "docs/evidence") {
  const pins = [];
  for (const path of walkJson(root, evidenceRoot).sort()) {
    const text = readText(root, path);
    if (!text || !text.includes("\"measurement_provenance\"")) continue;
    let provenance;
    try {
      provenance = JSON.parse(text).measurement_provenance;
    } catch {
      continue;
    }
    const inputs = (provenance?.inputs || []).map((input) => input?.path).filter(Boolean);
    if (inputs.length) pins.push({ path, measured_revision: provenance.revision || null, inputs });
  }
  return pins;
}

export function evidenceInvalidatedBy(pins, changedPaths) {
  const changed = new Set(changedPaths);
  return pins
    .map((pin) => ({ ...pin, inputs_changed: pin.inputs.filter((input) => changed.has(input)) }))
    .filter((pin) => pin.inputs_changed.length)
    .map(({ path, measured_revision, inputs_changed }) => ({ path, measured_revision, inputs_changed }));
}

/**
 * The publication decision, derived from what the cycle measured. It is the
 * only place a decision is made, and the receipt verifier re-derives it.
 */
export function derivePublicationDecision({ changedPaths = [], invalidatedEvidence = [], reobservationFailures = [] }) {
  if (changedPaths.length === 0) {
    return {
      decision: "unchanged",
      reason: "Every served history materialization is byte-identical to what this cycle materialized, so the served bytes did not change.",
    };
  }
  if (reobservationFailures.length) {
    return {
      decision: "held",
      reason: `A committed observation could not be re-fetched (${reobservationFailures.join(", ")}); publishing this run would drop last-known-good evidence, so the served bytes did not change.`,
    };
  }
  if (invalidatedEvidence.length) {
    return {
      decision: "held",
      reason: `Publishing would change bytes that retained production measurements pin (${invalidatedEvidence.map((entry) => entry.path).join(", ")}); the change is held for a reviewed publication that re-measures them, so the served bytes did not change.`,
    };
  }
  return {
    decision: "published",
    reason: "The materialized change touches no pinned evidence and every committed observation was re-fetched, so it is published.",
  };
}

function frozenCohortInputs(root, cohort) {
  const declared = [];
  for (const [key, entry] of Object.entries(cohort?.source_versions || {})) {
    for (const artifact of [entry?.artifact, entry?.manifest, ...(entry?.shards || [])]) {
      if (artifact?.path && artifact?.sha256) declared.push({ source: key, ...artifact });
    }
  }
  return declared.map((artifact) => {
    const absolute = join(root, artifact.path);
    const current = existsSync(absolute) ? contentHashOf(readFileSync(absolute)).slice("sha256:".length) : null;
    return {
      path: artifact.path,
      role: `frozen cohort input (${artifact.source})`,
      frozen_sha256: artifact.sha256,
      current_sha256: current,
      drifted: current !== artifact.sha256,
    };
  });
}

function readCommittedState(root) {
  const committed = {};
  for (const entry of CONNECTED_HISTORY_MATERIALIZATIONS) {
    const text = readText(root, entry.path);
    const receiptText = readText(root, entry.receipt);
    if (text == null) throw new Error(`committed materialization is missing: ${entry.path}`);
    committed[entry.id] = {
      text,
      receiptText,
      value: JSON.parse(text),
      receipt: receiptText == null ? null : JSON.parse(receiptText),
    };
  }
  const previousText = readText(root, CONNECTED_HISTORY_CYCLE.receipt_path);
  let previous = null;
  if (previousText != null) {
    try {
      previous = JSON.parse(previousText);
    } catch {
      previous = null;
    }
  }
  return {
    committed,
    previous: previous?.schema === CONNECTED_HISTORY_CYCLE_RECEIPT_SCHEMA ? previous : null,
    previousDigest: digestOf(previousText),
  };
}

/** In-memory materialization of every non-frozen history artifact from the given documents. */
export function materializeConnectedHistories({ cohort, documents, documentsReceipt }) {
  const relations = materializeConnectedHistoryRelations();
  const roles = materializeConnectedHistoryRoles();
  const time = materializeConnectedHistoryTime();
  const inputs = { cohort, documents, relations: relations.artifact, time: time.artifact, roles: roles.artifact };
  const coverage = buildConnectedHistoryCoverage(inputs);
  const coverageReceipt = buildConnectedHistoryCoverageReceipt(coverage, inputs);
  return {
    documents: { artifact: documents, receipt: documentsReceipt },
    relations,
    roles,
    time,
    coverage: { artifact: coverage, receipt: coverageReceipt, inputs },
  };
}

function verifyMaterialized(materialized) {
  if (materialized.documents.artifact?.schema !== CONNECTED_HISTORY_DOCUMENTS_SCHEMA) {
    throw new Error("documents materialization has an unexpected schema");
  }
  assertRetainedObservationsHaveFetchReceipts(materialized.documents.artifact.observations || []);
  const time = verifyConnectedHistoryTimeArtifact(materialized.time.artifact);
  if (!time.valid) throw new Error(`time materialization failed verification: ${time.errors.join(", ")}`);
  const coverage = verifyConnectedHistoryCoverage(materialized.coverage.artifact, materialized.coverage.inputs);
  if (!coverage.valid) throw new Error(`coverage materialization failed verification: ${coverage.findings.join(", ")}`);
}

function stampOf(value) {
  if (!value || typeof value !== "object") return null;
  return value.generated_at || value.input_vintages?.documents_generated_at || null;
}

function materializationRecords(committed, materialized) {
  return CONNECTED_HISTORY_MATERIALIZATIONS.map((entry) => {
    const before = committed[entry.id];
    const frozen = entry.mode === "frozen_baseline";
    const after = frozen ? null : materialized[entry.id];
    const text = frozen ? before.text : serialize(after.artifact);
    const receiptText = frozen ? before.receiptText : serialize(after.receipt);
    return {
      id: entry.id,
      path: entry.path,
      mode: entry.mode,
      action: frozen ? "carried_frozen" : "rematerialized",
      committed_sha256: digestOf(before.text),
      materialized_sha256: digestOf(text),
      byte_identical: text === before.text && receiptText === before.receiptText,
      generated_at: { committed: stampOf(before.value), materialized: stampOf(frozen ? before.value : after.artifact) },
      stamp_source: entry.stamp_source,
      verification_receipt: {
        path: entry.receipt,
        committed_sha256: digestOf(before.receiptText),
        materialized_sha256: digestOf(receiptText),
      },
      text,
      receiptText,
    };
  });
}

function changedPathsOf(records) {
  return records.flatMap((record) => [
    ...(record.materialized_sha256 !== record.committed_sha256 ? [record.path] : []),
    ...(record.verification_receipt?.materialized_sha256 !== record.verification_receipt?.committed_sha256
      ? [record.verification_receipt?.path]
      : []),
  ]);
}

class CycleStageFailure extends Error {
  constructor(stage, cause) {
    super(clean(cause?.message || cause));
    this.stage = stage;
  }
}

/**
 * Run one cycle. Every dependency that touches the network, the clock, or the
 * filesystem outside `root` is injected so a test can drive each stage.
 *
 * Returns `{ receipt, exitCode }`. The receipt is written to `receiptOut`
 * (default: the served receipt path under `root`) whatever happened.
 */
export async function runConnectedHistoryCycle({
  root,
  httpGet,
  acquireDocuments = ({ httpGet: get, observedAt }) => acquireConnectedHistoryDocuments({ httpGet: get, observedAt, runMode: "live" }),
  observeServed = async () => ({ status: "not_observed", reason: "no served origin was configured for this run" }),
  verifyPublished = async () => [],
  // determinism-lint: allow clock a cycle receipt records the instants of its own run
  now = () => new Date().toISOString(),
  run = {},
  dryRun = false,
  receiptOut = null,
  heldDir = null,
} = {}) {
  if (!root) throw new Error("runConnectedHistoryCycle requires a repository root");
  const startedAt = now();
  const stages = [];
  const recorder = recordingHttpGet(httpGet || (async () => { throw new Error("no httpGet was provided"); }));
  const state = { acquisition: null, materialization: null, publication: null, written: [] };
  let committedState = null;
  let failure = null;

  async function stage(name, body) {
    const record = { stage: name, started_at: now(), status: "running" };
    stages.push(record);
    try {
      const result = await body();
      record.status = "succeeded";
      record.finished_at = now();
      return result;
    } catch (error) {
      record.status = "failed";
      record.finished_at = now();
      record.error = clean(error?.message || error);
      throw new CycleStageFailure(name, error);
    }
  }

  async function observe(phase) {
    try {
      return await observeServed(phase);
    } catch (error) {
      return { status: "unavailable", reason: clean(error?.message || error, 160) };
    }
  }

  const served = await observe("start");
  try {
    state.acquisition = await stage("acquisition", async () => {
      committedState = readCommittedState(root);
      const acquired = await acquireDocuments({ httpGet: recorder.httpGet, observedAt: startedAt });
      if (acquired?.artifact?.schema !== CONNECTED_HISTORY_DOCUMENTS_SCHEMA) {
        throw new Error("document acquisition returned no documents artifact");
      }
      const sources = compareDocumentObservations({
        committed: committedState.committed.documents.value,
        acquired: acquired.artifact,
        fingerprints: recorder.fingerprints,
        baseline: fingerprintBaseline(committedState.previous),
      });
      return { acquired, sources };
    });

    const { committed } = committedState;
    state.materialization = await stage("materialization", async () => {
      const { acquired, sources } = state.acquisition;
      const documentsChanged = sources.some((row) => row.comparison === "changed");
      const materialized = materializeConnectedHistories({
        cohort: committed.cohort.value,
        documents: documentsChanged ? acquired.artifact : committed.documents.value,
        documentsReceipt: documentsChanged ? acquired.receipt : committed.documents.receipt,
      });
      verifyMaterialized(materialized);
      return materializationRecords(committed, materialized);
    });

    state.publication = await stage("publication", async () => {
      const records = state.materialization;
      const changedPaths = changedPathsOf(records);
      const invalidatedEvidence = changedPaths.length
        ? evidenceInvalidatedBy(retainedEvidencePins(root), changedPaths)
        : [];
      const reobservationFailures = state.acquisition.sources
        .filter((row) => row.comparison === "reobservation_failed")
        .map((row) => row.source_id);
      const decided = derivePublicationDecision({ changedPaths, invalidatedEvidence, reobservationFailures });
      const writes = records
        .filter((record) => record.mode !== "frozen_baseline")
        .flatMap((record) => [
          [record.path, record.text, committed[record.id].text],
          [record.verification_receipt.path, record.receiptText, committed[record.id].receiptText],
        ])
        .filter(([path]) => changedPaths.includes(path));
      if (decided.decision === "published" && !dryRun) {
        for (const [path, text, previousText] of writes) {
          // determinism-lint: allow write only the cycle's run mode publishes a decided change
          writeFileSync(join(root, path), text);
          state.written.push({ path, previousText });
        }
      } else if (decided.decision === "held" && heldDir) {
        for (const [path, text] of writes) {
          const target = join(heldDir, path);
          mkdirSync(dirname(target), { recursive: true });
          // determinism-lint: allow write held materializations go to ignored scratch kept with the run
          writeFileSync(target, text);
        }
      }
      return {
        ...decided,
        changed_paths: changedPaths,
        invalidated_evidence: invalidatedEvidence,
        reobservation_failures: reobservationFailures,
        written_paths: state.written.map((entry) => entry.path),
        dry_run: dryRun,
      };
    });

    await stage("verification", async () => {
      const findings = await verifyPublished({ root, publication: state.publication });
      if (findings.length) throw new Error(`published materializations failed their builders' checks: ${findings.join("; ")}`);
    });
  } catch (error) {
    failure = error instanceof CycleStageFailure ? error : new CycleStageFailure(stages.at(-1)?.stage || "acquisition", error);
  }

  if (failure && state.written.length) {
    for (const { path, previousText } of [...state.written].reverse()) {
      // determinism-lint: allow write a failed cycle restores the committed bytes it replaced
      writeFileSync(join(root, path), previousText);
    }
    state.written = [];
  }

  const finishedAt = now();
  const servedAfter = await observe("finish");
  const receipt = buildConnectedHistoryCycleReceipt({
    run,
    startedAt,
    finishedAt,
    stages,
    failure,
    served,
    servedAfter,
    requests: recorder.requests,
    acquisition: state.acquisition,
    materialization: state.materialization,
    publication: state.publication,
    committedState,
    root,
  });
  const verification = verifyConnectedHistoryCycleReceipt(receipt);
  if (!verification.valid) throw new Error(`cycle receipt failed its own verification: ${verification.errors.join(", ")}`);
  const out = receiptOut || join(root, CONNECTED_HISTORY_CYCLE.receipt_path);
  mkdirSync(dirname(out), { recursive: true });
  // determinism-lint: allow write the cycle receipt is the run's own record, written whatever happened
  writeFileSync(out, serialize(receipt));
  return { receipt, exitCode: failure ? 1 : 0 };
}

function ledgerEntry(receipt, digest) {
  return {
    run_id: receipt.run?.run_id ?? null,
    trigger: receipt.run?.trigger ?? null,
    started_at: receipt.run?.started_at ?? null,
    finished_at: receipt.run?.finished_at ?? null,
    outcome: receipt.run?.outcome ?? null,
    served_revision: receipt.run?.served?.revision ?? null,
    receipt_sha256: digest,
  };
}

export function buildConnectedHistoryCycleReceipt({
  run = {},
  startedAt,
  finishedAt,
  stages,
  failure,
  served,
  servedAfter,
  requests = [],
  acquisition,
  materialization,
  publication,
  committedState,
  root,
}) {
  const previous = committedState?.previous || null;
  const priorRuns = previous
    ? [ledgerEntry(previous, committedState.previousDigest), ...(previous.prior_runs || [])]
      .slice(0, CONNECTED_HISTORY_CYCLE.ledger_limit)
    : [];
  const cohort = committedState?.committed?.cohort?.value;
  const acquired = acquisition?.acquired || null;
  const failedStage = failure ? failure.stage : null;
  const channel = { ...CONNECTED_HISTORY_CYCLE.publication };
  return {
    schema: CONNECTED_HISTORY_CYCLE_RECEIPT_SCHEMA,
    cycle: {
      id: CONNECTED_HISTORY_CYCLE.id,
      workflow: CONNECTED_HISTORY_CYCLE.workflow,
      schedule: CONNECTED_HISTORY_CYCLE.schedule,
      cadence_hours: CONNECTED_HISTORY_CYCLE.cadence_hours,
      served_path: CONNECTED_HISTORY_CYCLE.served_path,
    },
    run: {
      run_id: run.run_id || `local:${startedAt}`,
      github_run_id: run.github_run_id ?? null,
      run_url: run.run_url ?? null,
      trigger: run.trigger || "local",
      code_revision: run.code_revision ?? null,
      started_at: startedAt,
      finished_at: finishedAt,
      status: failure ? "failed" : "succeeded",
      outcome: failure ? "failed" : publication.decision,
      failed_stage: failedStage,
      error: failure ? failure.message : null,
      served: { ...served, after: servedAfter },
    },
    stages,
    acquisition: {
      documents: {
        attempted: stages.some((entry) => entry.stage === "acquisition"),
        source_policy: acquired?.artifact?.source_policy ?? null,
        parser_version: acquired?.artifact?.parser_version ?? null,
        observed_at: startedAt,
        request_count: requests.length,
        requests,
        acquired_selection_hash: acquired?.receipt?.selection_hash ?? null,
        committed_selection_hash: committedState?.committed?.documents?.receipt?.selection_hash ?? null,
        content_fingerprint_rule: CONNECTED_HISTORY_CONTENT_FINGERPRINT_RULE,
        sources: acquisition?.sources || [],
      },
      retained_inputs: cohort && root ? frozenCohortInputs(root, cohort) : [],
    },
    materialization: (materialization || []).map(({ text: _text, receiptText: _receipt, ...record }) => ({
      ...record,
      confirmed_current_at: record.byte_identical && !failure ? finishedAt : null,
    })),
    publication: publication
      ? {
          decision: failure ? "not_published" : publication.decision,
          reason: failure
            ? `The ${failedStage} stage failed after the publication decision (${publication.decision}); any change it wrote was restored to the committed bytes.`
            : publication.reason,
          derived_decision: publication.decision,
          changed_paths: publication.changed_paths,
          invalidated_evidence: publication.invalidated_evidence,
          reobservation_failures: publication.reobservation_failures,
          written_paths: failure ? [] : publication.written_paths,
          dry_run: publication.dry_run,
          channel,
        }
      : {
          decision: "not_published",
          reason: `The ${failedStage} stage failed before a publication decision; the committed materializations were left in place.`,
          changed_paths: [],
          invalidated_evidence: [],
          reobservation_failures: [],
          written_paths: [],
          dry_run: false,
          channel,
        },
    prior_runs: priorRuns,
  };
}

/**
 * Re-derive a receipt's status, outcome and decision from its own facts. A
 * receipt that no attempted acquisition produced, or whose stated outcome its
 * facts do not support, is rejected.
 */
export function verifyConnectedHistoryCycleReceipt(receipt) {
  const errors = [];
  if (receipt?.schema !== CONNECTED_HISTORY_CYCLE_RECEIPT_SCHEMA) errors.push("schema");
  const run = receipt?.run || {};
  if (!run.run_id) errors.push("run_id");
  if (!Date.parse(run.started_at) || !Date.parse(run.finished_at) || run.finished_at < run.started_at) errors.push("run_instants");
  if (!run.served || typeof run.served.status !== "string") errors.push("served_revision_observation");
  const stages = receipt?.stages || [];
  const names = stages.map((entry) => entry.stage);
  if (!names.length || names.join(",") !== CONNECTED_HISTORY_CYCLE_STAGES.slice(0, names.length).join(",")) {
    errors.push("stage_order");
  }
  if (receipt?.acquisition?.documents?.attempted !== true) errors.push("acquisition_not_attempted");
  const failed = stages.find((entry) => entry.status === "failed") || null;
  if (run.status !== (failed ? "failed" : "succeeded")) errors.push("status");
  if (failed) {
    if (run.failed_stage !== failed.stage || run.outcome !== "failed") errors.push("failed_stage");
    if (stages.indexOf(failed) !== stages.length - 1) errors.push("stages_after_failure");
    if ((receipt.publication?.written_paths || []).length || receipt.publication?.decision !== "not_published") {
      errors.push("failed_run_published");
    }
    return { valid: errors.length === 0, errors };
  }
  if (stages.length !== CONNECTED_HISTORY_CYCLE_STAGES.length || stages.some((entry) => entry.status !== "succeeded")) {
    errors.push("incomplete_stages");
  }
  const records = receipt.materialization || [];
  if (records.map((record) => record.id).join(",") !== CONNECTED_HISTORY_MATERIALIZATIONS.map((entry) => entry.id).join(",")) {
    errors.push("materialization_coverage");
  }
  const changedPaths = changedPathsOf(records);
  const changed = new Set(changedPaths);
  if (records.some((record) => record.byte_identical !== (!changed.has(record.path) && !changed.has(record.verification_receipt?.path)))) {
    errors.push("byte_identity");
  }
  const derived = derivePublicationDecision({
    changedPaths,
    invalidatedEvidence: receipt.publication?.invalidated_evidence || [],
    reobservationFailures: (receipt.acquisition.documents.sources || [])
      .filter((row) => row.comparison === "reobservation_failed")
      .map((row) => row.source_id),
  });
  if (receipt.publication?.decision !== derived.decision || run.outcome !== derived.decision) errors.push("decision");
  if (JSON.stringify(receipt.publication?.changed_paths || []) !== JSON.stringify(changedPaths)) errors.push("changed_paths");
  if (derived.decision !== "published" && (receipt.publication?.written_paths || []).length) errors.push("unpublished_writes");
  return { valid: errors.length === 0, errors };
}
