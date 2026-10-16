// Edge read model for ZAP land outcomes (decision docs, action status, dispositions).
// Browser only hits GET /zap-outcomes?id= — never the ZAP API or DOB Socrata directly
// for this panel (precompute-first / edge-cache).

import {
  ZAP_API_BASE,
  ZAP_OUTCOMES_KV_PREFIX,
  ZAP_OUTCOMES_MAX_AGE_MS,
  ZAP_SODA_BBL,
  ZAP_SODA_PROJECTS,
  DOB_NOW_DATASET,
  joinOpenDataToZapOutcome,
  joinDobFilingsToBbls,
  joinCityRecordLandNotices,
  buildLandEventSpine,
  normProjectId,
  outcomeIsFilled,
} from "./lib/zap_outcomes.mjs";
import { extractUlurpKeys } from "./lib/ulurp_recommendations_join.mjs";
import { lookupZapFromWarehouseMaterialization, warehouseZapMaterializationMeta } from "./lib/zap_warehouse_lookup.mjs";
import { committedZapProjectsLookupFloor, loadZapProjectsLookup, shapeZapLookupRow } from "./lib/zap_projects_lookup_kv.mjs";
import { lookupZapBblsFromWarehouseMaterialization, warehouseZapBblMaterializationMeta } from "./lib/zap_bbl_warehouse_lookup.mjs";
import { attachUlurpStatutoryPredictions } from "./lib/ulurp_statutory_predictions.mjs";
import zoningStatistics from "./data/zoning_statistics.json" with { type: "json" };
import { attachZoningStatistics } from "./lib/zoning_statistics.mjs";
import { attachProjectConnectionsSection } from "./project_connections.mjs";
import { dualWriteZapProjectObservations } from "./lib/zap_project_source_records.mjs";
import { extractZapHearingLogistics } from "./lib/zap_hearing_logistics.mjs";
import { stampLandActionProcedureResolution } from "../../site/land_action_procedure_resolution.mjs";
import { buildLandPhaseView } from "../../site/land_phase_spine.mjs";
import { landStageEvidenceIsStale, landStageEvidenceObservedAt } from "../../site/land_outcome_runtime.mjs";
// Do not static-import admin.mjs here: it pulls alerts.mjs → @jimdc/sendcap, and
// test/land_event_spine.test.mjs imports buildZapOutcomeRecord from this module
// during site unit tests (before the worker dependency install). Auth is loaded only on the admin path.

export {
  parseZapApiProject,
  joinProjectId,
  joinOpenDataToZapOutcome,
  joinDobFilingsToBbls,
  documentProxyUrl,
  outcomeIsFilled,
  ZAP_API_BASE,
  ZAP_OUTCOMES_KV_PREFIX,
  ZAP_OUTCOMES_MAX_AGE_MS,
} from "./lib/zap_outcomes.mjs";

const SODA = "https://data.cityofnewyork.us/resource";
const CITY_RECORD_DATASET = "dg92-zbpx";
// Body + contact + venue fields so the land action rail can extract testimony /
// join / venue steps without a second City Record fetch.
const CITY_RECORD_SELECT = [
  "request_id", "start_date", "event_date", "section_name", "agency_name",
  "type_of_notice_description", "short_title",
  "building_name", "street_address_1", "street_address_2", "city", "state", "zip_code",
  "email", "contact_name", "contact_phone",
  "additional_description_1", "additional_description_2", "additional_description_3",
  "other_info_1", "other_info_2", "other_info_3",
  "printout_1", "printout_2", "printout_3",
].join(",");
const sourceAcquisitionState = new WeakMap();
const sourceObservationState = new WeakMap();

export function stampLandStageObservation(record) {
  const view = buildLandPhaseView(record?.spine, record || {});
  const key = view.current.evidence_source_id === "zap-project-api" ? "zap_api"
    : view.current.evidence_source_id === "nyc-open-data-zap" ? "open_data"
    : view.current.evidence_source_id === "city-record" ? "city_record" : null;
  const observation = view.current.evidence_observation || (key ? record?.source_observations?.[key] : null);
  return {
    ...record,
    stage_observation: {
      source_system: observation?.source_system || null,
      observed_at: observation?.observed_at || null,
    },
  };
}

function markSourceAcquisition(value, status, observedAt = null) {
  sourceAcquisitionState.set(value, status);
  sourceObservationState.set(value, { observed_at: observedAt });
  return value;
}

async function writeZapOutcomeAttempt(env, projectId, payload) {
  try {
    await env.ALERT_STATE.put(`${kvKey(projectId)}:attempt`, JSON.stringify(payload));
    return { status: "written" };
  } catch (error) {
    return { status: "failed", reason: String(error?.message || error) };
  }
}

function retainedObservation(prior, sourceSystem, acquisitionStatus, attemptedAt) {
  return {
    ...prior,
    source_system: prior?.source_system || sourceSystem,
    acquisition_status: acquisitionStatus,
    observation_status: "retained",
    observed_at: prior && Object.hasOwn(prior, "observed_at") ? prior.observed_at : null,
    attempted_at: attemptedAt,
  };
}

function retainedRow(row, sourceSystem, observedAt) {
  return {
    ...row,
    source_observation: {
      ...row?.source_observation,
      source_system: row?.source_observation?.source_system || sourceSystem,
      observation_status: "retained",
      observed_at: row?.source_observation && Object.hasOwn(row.source_observation, "observed_at")
        ? row.source_observation.observed_at
        : observedAt,
    },
  };
}

function mergeRetainedRows(current, prior, identity, sourceSystem, observedAt) {
  const rows = Array.isArray(current) ? current.slice() : [];
  const seen = new Set(rows.map(identity).filter(Boolean));
  for (const row of prior || []) {
    const key = identity(row);
    if (!key || seen.has(key)) continue;
    rows.push(retainedRow(row, sourceSystem, observedAt));
    seen.add(key);
  }
  return rows;
}

function retainZapSourceEvidence(record, cached) {
  if (!cached?.join?.matched || record?.join?.matched !== true) return record;
  const priorObservation = cached.source_observations?.zap_api;
  const priorAt = priorObservation && Object.hasOwn(priorObservation, "observed_at")
    ? priorObservation.observed_at
    : cached.stage_observation?.source_system === "zap_project_api"
      ? cached.stage_observation.observed_at || null : null;
  const actions = mergeRetainedRows(record.actions, cached.actions,
    (row) => row?.id || [row?.action, row?.ulurp_number].join("|"), "zap_project_api", priorAt);
  const milestones = mergeRetainedRows(record.milestones, cached.milestones,
    (row) => row?.id || [row?.title, row?.time?.value].join("|"), "zap_project_api", priorAt);
  const dispositions = mergeRetainedRows(record.dispositions, cached.dispositions,
    (row) => row?.id || (row?.source_ids || []).join("|") || [row?.name, row?.vote_date].join("|"),
    "zap_project_api", priorAt);
  const documents = mergeRetainedRows(record.documents, cached.documents,
    (row) => row?.id || row?.url || [row?.group_id, row?.name, row?.time_created].join("|"),
    "zap_project_api", priorAt);
  const approvedActions = mergeRetainedRows(record.approved_actions, cached.approved_actions,
    (row) => row?.id || [row?.action, row?.ulurp_number].join("|"), "zap_project_api", priorAt);
  const retained = actions.length > (record.actions?.length || 0)
    || milestones.length > (record.milestones?.length || 0)
    || dispositions.length > (record.dispositions?.length || 0)
    || documents.length > (record.documents?.length || 0)
    || approvedActions.length > (record.approved_actions?.length || 0);
  if (!retained) return record;
  const acquisition = sourceAcquisitionState.get(record) || {};
  const merged = {
    ...record,
    actions,
    milestones,
    dispositions,
    documents,
    approved_actions: approvedActions,
    n_documents: Math.max(Number(record.n_documents) || 0, Number(cached.n_documents) || 0, documents.length),
    n_dispositions: dispositions.length,
    n_approved_actions: approvedActions.length,
    useful: record.useful || cached.useful,
    source_observations: {
      ...record.source_observations,
      zap_api: {
        ...record.source_observations?.zap_api,
        observation_status: "observed_and_retained",
        retained_observed_at: priorAt,
      },
    },
  };
  const dispositionById = new Map(dispositions.flatMap((row) => [
    row?.id ? [row.id, row] : null,
    ...(row?.source_ids || []).map((id) => [id, row]),
  ].filter(Boolean)));
  const hearingLogistics = extractZapHearingLogistics(merged).map((row) => {
    const observation = dispositionById.get(row.disposition_id)?.source_observation;
    return observation ? { ...row, source_observation: { ...observation } } : row;
  });
  merged.hearing_logistics = hearingLogistics.length ? hearingLogistics : null;
  merged.filled = outcomeIsFilled(merged);
  merged.spine = buildLandEventSpine(merged, {
    cityRecordNotices: merged.city_record_notices,
    noticeLookupStatus: acquisition.city_record || "ok",
  });
  const stamped = stampLandStageObservation(merged);
  sourceAcquisitionState.set(stamped, acquisition);
  return stamped;
}

function retainDobSourceEvidence(record, cached) {
  const acquisition = sourceAcquisitionState.get(record) || {};
  if (!cached || (acquisition.bbl !== "unavailable" && acquisition.dob !== "unavailable")) return record;
  const next = { ...record, source_observations: { ...record.source_observations } };
  const observed = (observation) => ["observed", "retained", "observed_and_retained"]
    .includes(observation?.observation_status);
  const retainableBbl = Array.isArray(cached.bbls)
    && (cached.bbls.length > 0 || observed(cached.source_observations?.bbl));
  const retainableDob = cached.dob && (cached.dob.matched
    || cached.dob.filings?.length > 0 || observed(cached.source_observations?.dob));
  if (acquisition.bbl === "unavailable") {
    if (retainableBbl) {
      next.bbls = cached.bbls;
      next.source_observations.bbl = retainedObservation(
        cached.source_observations?.bbl, "zap_bbl_open_data", "unavailable", record.generated_at,
      );
    }
    if (retainableDob) {
      next.dob = cached.dob;
      next.source_observations.dob = retainedObservation(
        cached.source_observations?.dob, "dob_now", "skipped", record.generated_at,
      );
    }
  } else if (acquisition.dob === "unavailable"
    && retainableDob) {
    next.dob = cached.dob;
    next.source_observations.dob = retainedObservation(
      cached.source_observations?.dob, "dob_now", "unavailable", record.generated_at,
    );
  }
  sourceAcquisitionState.set(next, acquisition);
  return next;
}

function retainCityRecordEvidence(record, cached) {
  const acquisition = sourceAcquisitionState.get(record) || {};
  if (!Object.hasOwn(acquisition, "city_record") || acquisition.city_record === "ok") return record;
  const priorObservation = cached?.source_observations?.city_record;
  const priorGap = cached?.spine?.gaps?.find((gap) => gap.slot === "city_record_notices");
  const canRetain = !!cached && (["observed", "retained", "observed_and_retained"].includes(priorObservation?.observation_status)
    || (Object.hasOwn(cached, "city_record_notices") && priorGap?.class !== "source_unavailable"));
  const priorNotices = canRetain && Array.isArray(cached.city_record_notices)
    ? cached.city_record_notices : [];
  const freshNotices = acquisition.city_record === "partial" && Array.isArray(record.city_record_notices)
    ? record.city_record_notices : [];
  const freshIds = new Set(freshNotices.map((notice) => String(notice?.request_id || "").trim()).filter(Boolean));
  const retainedAt = priorObservation?.observed_at || cached?.generated_at || null;
  const merged = new Map();
  for (const notice of priorNotices) {
    const id = String(notice?.request_id || "").trim();
    if (!id) continue;
    merged.set(id, {
      ...notice,
      source_observation: {
        ...notice.source_observation,
        source_system: "city_record",
        observation_status: "retained",
        observed_at: notice.source_observation?.observed_at || retainedAt,
      },
    });
  }
  for (const notice of freshNotices) {
    const id = String(notice?.request_id || "").trim();
    if (id) merged.set(id, notice);
  }
  const notices = [...merged.values()].sort((left, right) =>
    String(left.start_date || "").localeCompare(String(right.start_date || ""))
      || String(left.request_id || "").localeCompare(String(right.request_id || "")));
  const freshCount = freshIds.size;
  const retainedCount = notices.filter((notice) => !freshIds.has(String(notice.request_id || "").trim())).length;
  const retained = retainedCount > 0;
  const spine = buildLandEventSpine(record, {
    cityRecordNotices: notices,
    noticeLookupStatus: "unavailable",
  });
  spine.gaps = [
    ...spine.gaps.filter((gap) => gap.slot !== "city_record_notices"),
    {
      slot: "city_record_notices",
      class: "source_unavailable",
      taxonomy: false,
      source: "City Record Online",
      retained,
      observed: freshCount > 0,
    },
  ];
  return {
    ...record,
    city_record_notices: notices,
    spine,
    source_observations: {
      ...record.source_observations,
      city_record: {
        source_system: "city_record",
        acquisition_status: acquisition.city_record || "unavailable",
        observation_status: freshCount ? (retained ? "observed_and_retained" : "observed")
          : retained ? "retained" : "unavailable",
        observed_at: freshCount ? record.generated_at : retainedAt,
        retained_observed_at: retained ? retainedAt : null,
        attempted_at: record.generated_at,
        observed_count: freshCount,
        retained_count: retainedCount,
      },
    },
  };
}

// Sell-facing land universe for daily write-ahead prewarm. Order is priority:
// public-review first (what the default Land list shows), then noticed/active/filed.
// The bounded resident corpus is prewarmed; missing rows remain unavailable until
// scheduled acquisition materializes them.
export const ZAP_PREWARM_STATUSES = Object.freeze([
  "In Public Review",
  "Noticed",
  "Active",
  "Filed",
]);
/** Always pin the demo-frame project so #land/2022M0258 never cold-misses. */
export const ZAP_PREWARM_DEMO_IDS = Object.freeze(["2022M0258"]);
/** Cap per cron/admin run. Sell-facing Open Data is ~235 ids; stay under the hard 500. */
export const ZAP_PREWARM_MAX = 300;
/** Concurrent builds per wave (ZAP API + SODA fan-out is the cost). */
export const ZAP_PREWARM_CONCURRENCY = 4;
/** Refresh before the public freshness objective while retaining older rows. */
export const ZAP_PREWARM_REFRESH_AGE_MS = Math.floor(ZAP_OUTCOMES_MAX_AGE_MS * 0.75);

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function response(body, status = 200, maxAge = 1800) {
  return new Response(body, {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": status === 200 ? `public, max-age=${maxAge}` : "no-store",
    },
  });
}

export function kvKey(projectId) {
  return `${ZAP_OUTCOMES_KV_PREFIX}${normProjectId(projectId)}`;
}

function cacheAgeMs(record, nowMs = Date.now()) {
  if (!record?.generated_at) return Number.POSITIVE_INFINITY;
  const t = new Date(record.generated_at).getTime();
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return Math.max(0, nowMs - t);
}

export function outcomeCacheIsFresh(record, nowMs = Date.now(), maxAgeMs = ZAP_OUTCOMES_MAX_AGE_MS) {
  return cacheAgeMs(record, nowMs) < maxAgeMs;
}

/** Fresh enough that daily prewarm may skip (leaves a buffer before public max-age). */
export function outcomeCacheIsPrewarmFresh(record, nowMs = Date.now()) {
  return cacheAgeMs(record, nowMs) < ZAP_PREWARM_REFRESH_AGE_MS;
}

export async function readZapOutcomeRecord(env, projectId) {
  if (!env?.ALERT_STATE) return null;
  try {
    const raw = await env.ALERT_STATE.get(kvKey(projectId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function kvGetRecord(env, projectId) {
  return readZapOutcomeRecord(env, projectId);
}

async function kvPutRecord(env, record) {
  if (!env?.ALERT_STATE || !record?.project_id) return;
  await env.ALERT_STATE.put(kvKey(record.project_id), JSON.stringify(record));
}

/**
 * List project_ids for the sell-facing land statuses (priority order, deduped, capped).
 * Pure SODA — no ZAP API. Fail-soft per status so one query outage still yields others.
 */
async function listPrewarmProjectRoster({
  fetchImpl = fetch,
  statuses = ZAP_PREWARM_STATUSES,
  max = ZAP_PREWARM_MAX,
  demoIds = ZAP_PREWARM_DEMO_IDS,
} = {}) {
  const cap = Math.max(1, Math.min(Number(max) || ZAP_PREWARM_MAX, 500));
  const ordered = [];
  const seen = new Set();
  const failures = [];
  let succeeded = 0;

  function pushId(raw) {
    const id = String(raw || "").trim();
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9_-]{2,24}$/.test(id)) return;
    const key = normProjectId(id);
    if (!key || seen.has(key)) return;
    seen.add(key);
    ordered.push(id);
  }

  for (const demo of demoIds || []) pushId(demo);

  const statusList = Array.isArray(statuses) ? statuses : ZAP_PREWARM_STATUSES;
  for (const status of statusList) {
    if (ordered.length >= cap) break;
    const remaining = cap - ordered.length;
    const where = `public_status='${String(status).replace(/'/g, "''")}'`;
    const url =
      `${SODA}/${ZAP_SODA_PROJECTS}.json?$select=project_id`
      + `&$where=${encodeURIComponent(where)}`
      + `&$order=current_milestone_date DESC`
      + `&$limit=${remaining}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12000);
    try {
      const res = await fetchImpl(url, {
        headers: { Accept: "application/json", "User-Agent": "cityscroll-zap-outcomes/1.0" },
        signal: ctl.signal,
      });
      if (!res.ok) {
        failures.push({ status, reason: `http-${res.status || "error"}` });
        continue;
      }
      const rows = await res.json();
      if (!Array.isArray(rows)) throw new Error("invalid-roster");
      succeeded++;
      for (const row of rows || []) {
        if (ordered.length >= cap) break;
        pushId(row?.project_id);
      }
    } catch (error) {
      failures.push({ status, reason: String(error?.message || error) });
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    projectIds: ordered.slice(0, cap),
    listing: { requested: statusList.length, succeeded, failed: failures.length, failures },
  };
}

export async function listPrewarmProjectIds(options = {}) {
  return (await listPrewarmProjectRoster(options)).projectIds;
}

/**
 * Materialize one project into KV when missing or aging out of the prewarm window.
 * Returns a small status token for cron/admin receipts.
 */
export async function prewarmOneZapOutcome(env, projectId, {
  build = buildZapOutcomeRecord,
  nowMs = Date.now(),
  force = false,
} = {}) {
  const id = String(projectId || "").trim();
  if (!id) return { status: "failed", reason: "bad-id" };
  if (!env?.ALERT_STATE) return { status: "failed", project_id: id, reason: "no-kv" };
  const cached = await kvGetRecord(env, id);
  if (!force && cached?.join?.matched === true && outcomeCacheIsPrewarmFresh(cached, nowMs)) {
    return { status: "skipped", project_id: id, generated_at: cached.generated_at };
  }
  let record;
  try {
    record = await build(id);
    // Acquisition validity is independent of outcome richness: a matched thin
    // project is valid, an error-shaped shell is not a new observation.
    if (!record || normProjectId(record.project_id) !== normProjectId(id)
      || record.join?.matched !== true || !Number.isFinite(Date.parse(record.generated_at))) {
      throw new Error(record?.join?.reason || "invalid-acquisition");
    }
    const unavailableSources = Object.entries(sourceAcquisitionState.get(record) || {})
      .filter(([source, status]) => source === "open_data" && status !== "ok")
      .map(([source]) => source);
    if (unavailableSources.length) {
      throw new Error(`source-unavailable:${unavailableSources.join(",")}`);
    }
    const cachedStageAt = Date.parse(landStageEvidenceObservedAt(cached) || "");
    const candidateStageAt = Date.parse(landStageEvidenceObservedAt(record) || "");
    if (Number.isFinite(cachedStageAt)
      && (!Number.isFinite(candidateStageAt) || candidateStageAt < cachedStageAt)) {
      throw new Error("stage-evidence-regressed");
    }
    record = retainZapSourceEvidence(record, cached);
    record = retainDobSourceEvidence(record, cached);
    record = retainCityRecordEvidence(record, cached);
    await kvPutRecord(env, record);
  } catch (error) {
    const attemptReceipt = await writeZapOutcomeAttempt(env, id, {
      status: "failed", observed_at: new Date(nowMs).toISOString(),
      reason: String(error?.message || error),
      retained_generated_at: cached?.generated_at || null,
    });
    return {
      status: "failed",
      project_id: id,
      reason: String(error?.message || error),
      attempt_receipt: attemptReceipt,
    };
  }
  const attemptReceipt = await writeZapOutcomeAttempt(env, id, {
    status: "succeeded", observed_at: new Date(nowMs).toISOString(),
    generated_at: record.generated_at,
  });
  let dualWrite;
  try {
    dualWrite = await dualWriteZapProjectObservations(
      env,
      record.open_data ? [record.open_data] : [],
      new Date(nowMs).toISOString(),
    );
  } catch (error) {
    dualWrite = { written: 0, failed: true, rejected: 0, reason: String(error?.message || error) };
  }
  return {
    status: "computed",
    project_id: id,
    generated_at: record.generated_at,
    filled: !!record.filled,
    matched: !!(record.join && record.join.matched),
    attempt_receipt: attemptReceipt,
    partial_sources: Object.entries(record.source_observations || {})
      .filter(([, observation]) => (observation?.acquisition_status
          && !["ok", "not_requested"].includes(observation.acquisition_status))
        || observation?.observation_status === "retained"
        || observation?.observation_status === "observed_and_retained")
      .map(([source]) => source),
    dual_write: dualWrite,
  };
}

/**
 * Bounded write-ahead prewarm for Land detail outcomes.
 * Idempotent: already-fresh KV rows are skipped. Fail-soft per id.
 */
export async function prewarmZapOutcomes(env, projectIds, {
  build = buildZapOutcomeRecord,
  concurrency = ZAP_PREWARM_CONCURRENCY,
  force = false,
  nowMs = Date.now(),
  max = ZAP_PREWARM_MAX,
} = {}) {
  const cap = Math.max(1, Math.min(Number(max) || ZAP_PREWARM_MAX, 500));
  const ids = Array.isArray(projectIds)
    ? [...new Set(projectIds.map((id) => String(id || "").trim()).filter(Boolean))].slice(0, cap)
    : [];
  let computed = 0;
  let skipped = 0;
  let failed = 0;
  let partial = 0;
  let attemptReceiptFailed = 0;
  const failureReasons = new Set();
  const dualWrite = { written: 0, failed: 0, rejected: 0 };
  const wave = Math.max(1, Math.min(Number(concurrency) || ZAP_PREWARM_CONCURRENCY, 8));

  for (let i = 0; i < ids.length; i += wave) {
    const chunk = ids.slice(i, i + wave);
    const results = await Promise.all(
      chunk.map((id) => prewarmOneZapOutcome(env, id, { build, nowMs, force })),
    );
    for (const r of results) {
      if (r.status === "computed") computed++;
      else if (r.status === "skipped") skipped++;
      else {
        failed++;
        if (r.reason) failureReasons.add(r.reason);
      }
      if (r.partial_sources?.length) partial++;
      if (r.attempt_receipt?.status === "failed") attemptReceiptFailed++;
      if (r.dual_write) {
        dualWrite.written += Number(r.dual_write.written) || 0;
        dualWrite.failed += r.dual_write.failed ? 1 : 0;
        dualWrite.rejected += Number(r.dual_write.rejected) || 0;
      }
    }
  }
  return {
    requested: ids.length,
    computed,
    skipped,
    failed,
    partial,
    failure_reasons: [...failureReasons].sort(),
    attempt_receipt_failed: attemptReceiptFailed,
    dual_write: dualWrite,
  };
}

/**
 * Daily / admin path: list sell-facing project_ids, then prewarm into KV.
 * Same shape as refreshMeetingOutcomes — skip cleanly when KV is unbound.
 */
export async function refreshZapOutcomes(env, opts = {}) {
  if (!env?.ALERT_STATE) {
    return { status: "failed", reason: "no-kv" };
  }
  const max = opts.max ?? ZAP_PREWARM_MAX;
  const force = opts.force === true;
  let projectIds = Array.isArray(opts.projectIds) ? opts.projectIds : null;
  let listed = 0;
  let listing = { requested: 0, succeeded: 0, failed: 0, failures: [] };
  if (!projectIds) {
    const roster = await listPrewarmProjectRoster({
      max,
      statuses: opts.statuses || ZAP_PREWARM_STATUSES,
      demoIds: opts.demoIds || ZAP_PREWARM_DEMO_IDS,
      fetchImpl: opts.fetchImpl || fetch,
    });
    projectIds = roster.projectIds;
    listing = roster.listing;
    listed = projectIds.length;
  } else {
    projectIds = projectIds.slice(0, max);
    listed = projectIds.length;
  }
  let build = opts.build;
  if (!build) {
    const lookupDoc = opts.lookupDoc || (await loadZapProjectsLookup(env)).record;
    build = (id) => buildZapOutcomeRecord(id, { lookupDoc });
  }
  const summary = await prewarmZapOutcomes(env, projectIds, {
    build,
    concurrency: opts.concurrency || ZAP_PREWARM_CONCURRENCY,
    force,
    nowMs: opts.nowMs || Date.now(),
    max,
  });
  const failed = summary.failed + listing.failed;
  const succeeded = summary.computed + summary.skipped;
  const reason = listing.failed && !listing.succeeded ? "roster-unavailable"
    : listing.failed ? "roster-partial"
      : summary.partial ? "source-partial"
        : summary.failure_reasons.includes("no-kv") ? "no-kv"
        : !summary.requested ? "empty-roster"
          : !summary.failed && !summary.computed ? "already-fresh" : null;
  return {
    status: failed ? (succeeded ? "partial" : "failed")
      : summary.partial ? "partial" : summary.computed ? "ok" : "skipped",
    ...(reason ? { reason } : {}),
    listed,
    listing,
    ...summary,
    generated_at: new Date(opts.nowMs || Date.now()).toISOString(),
  };
}

function adminJson(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// POST /admin/zap-outcomes-refresh?key=… — on-demand Land outcomes prewarm (same path as cron).
// Optional JSON body: { projectIds?: string[], max?: number, force?: boolean }
export async function handleAdminZapOutcomesRefresh(req, env) {
  const { checkAdminKey } = await import("./admin.mjs");
  const auth = checkAdminKey(req, env);
  if (!auth.ok) return auth.res;
  if (req.method !== "POST") return adminJson({ error: "method" }, 405);
  let body = {};
  try {
    const text = await req.text();
    if (text && text.trim()) body = JSON.parse(text);
  } catch {
    return adminJson({ error: "bad-json" }, 400);
  }
  try {
    const result = await refreshZapOutcomes(env, {
      projectIds: Array.isArray(body.projectIds) ? body.projectIds : undefined,
      max: body.max,
      force: body.force === true,
    });
    return adminJson({ ...result, triggeredAt: new Date().toISOString() }, 200);
  } catch (e) {
    return adminJson({ status: "error", error: String(e?.message || e) }, 500);
  }
}

async function fetchJson(url, timeoutMs = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { Accept: "application/json", "User-Agent": "cityscroll-zap-outcomes/1.0" },
    });
    if (!res.ok) {
      const err = new Error(`http-${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/**
 * ZAP Open Data project row: warehouse materialization first (WH-05), then live SODA.
 * Returns the SODA-shaped row (always includes project_id). Attaches lookup_path when known.
 */
export async function fetchOpenDataRow(projectId, { lookupDoc, observedAt = new Date().toISOString() } = {}) {
  const id = String(projectId || "").trim();
  // WH-05: instant hit from live KV lookup (or committed twin) before live SODA.
  const wh = lookupZapFromWarehouseMaterialization(id, lookupDoc);
  if (wh.hit && wh.row) {
    const observation = wh.row.source_observation;
    const materialization = warehouseZapMaterializationMeta(lookupDoc);
    const floorObservedAt = committedZapProjectsLookupFloor().materialized_at || null;
    const observedAt = observation && Object.hasOwn(observation, "observed_at")
      ? observation.observed_at
      : lookupDoc?.source === "soda" && materialization.materialized_at !== floorObservedAt
        ? null
        : materialization.materialized_at;
    return markSourceAcquisition({ ...wh.row, lookup_path: "warehouse" }, "ok", observedAt);
  }

  // Live SODA fallback when the materialization lacks this project_id.
  const where = `project_id='${id.replace(/'/g, "''")}'`;
  const url =
    `${SODA}/hgx4-8ukb.json?$select=project_id,project_name,public_status,project_status,`
    + `approval_date,completed_date,ulurp_numbers,primary_applicant,borough,community_district,actions,current_milestone,current_milestone_date,`
    + `ceqr_number,ceqr_type,ceqr_leadagency,eas_eis,current_envmilestone,current_envmilestone_date`
    + `&$where=${encodeURIComponent(where)}&$limit=1`;
  try {
    const rows = await fetchJson(url);
    if (!Array.isArray(rows)) throw new Error("invalid-open-data-response");
    if (Array.isArray(rows) && rows[0]) {
      const shaped = shapeZapLookupRow(rows[0]);
      return markSourceAcquisition({ ...(shaped || rows[0]), lookup_path: "soda" }, "ok", observedAt);
    }
  } catch {
    return markSourceAcquisition({ project_id: id, lookup_path: "soda" }, "unavailable");
  }
  return markSourceAcquisition({ project_id: id, lookup_path: "soda" }, "unavailable");
}

async function fetchCityRecordCandidates(openData, projectName) {
  const keys = [...extractUlurpKeys(openData?.ulurp_numbers)];
  const spacedKeys = keys.map((key) => {
    const match = key.match(/^([A-Z]?)(\d{6})([A-Z]+)$/);
    return match ? [match[1], match[2], match[3]].filter(Boolean).join(" ") : key;
  });
  // City Record prose commonly prints `C 240046 HAM`, while ZAP stores
  // `C240046HAM`; query both forms, then retain only strict parsed-token hits.
  const terms = [
    String(projectName || openData?.project_name || "").trim(),
    ...keys,
    ...spacedKeys,
  ].filter((term, index, all) => term.length >= 4 && all.indexOf(term) === index).slice(0, 12);
  if (!terms.length) return { rows: [], status: "ok" };

  let successful = 0;
  let failed = 0;
  const rows = [];
  const seen = new Set();
  await Promise.all(terms.map(async (term) => {
    const url = `${SODA}/${CITY_RECORD_DATASET}.json?$select=${CITY_RECORD_SELECT}`
      + `&$q=${encodeURIComponent(term)}&$order=start_date DESC&$limit=40`;
    try {
      const found = await fetchJson(url, 10000);
      if (!Array.isArray(found)) throw new Error("invalid-city-record-response");
      successful++;
      for (const row of found || []) {
        const id = String(row?.request_id || "");
        if (!id || seen.has(id)) continue;
        seen.add(id);
        rows.push(row);
      }
    } catch {
      failed++;
    }
  }));
  return { rows, status: failed ? (successful ? "partial" : "unavailable") : "ok" };
}

/**
 * ZAP BBL tax lots: warehouse materialization first (WH-06), then live SODA.
 * Returns BBL strings (max 25). Attaches lookup_path via array property when useful
 * for tests — callers that only need ids can ignore it.
 */
export async function fetchBbls(projectId, { observedAt = new Date().toISOString() } = {}) {
  const id = String(projectId || "").trim();
  // WH-06: instant hit from warehouse materialization index (no network).
  const wh = lookupZapBblsFromWarehouseMaterialization(id);
  if (wh.hit) {
    // Hit with empty list is still a warehouse answer (project known, no lots).
    const bbls = (wh.bbls || []).slice(0, 25);
    bbls.lookup_path = "warehouse";
    return markSourceAcquisition(bbls, "ok", warehouseZapBblMaterializationMeta().materialized_at);
  }

  // Live SODA fallback when the materialization lacks this project_id.
  const where = `project_id='${id.replace(/'/g, "''")}'`;
  const url =
    `${SODA}/${ZAP_SODA_BBL}.json?$select=bbl&$where=${encodeURIComponent(where)}&$limit=40`;
  try {
    const rows = await fetchJson(url, 8000);
    if (!Array.isArray(rows)) throw new Error("invalid-bbl-response");
    const bbls = [...new Set((rows || []).map((r) => {
      let s = String(r?.bbl ?? "").trim().replace(/\.0$/, "");
      if (s && /^\d+$/.test(s) && s.length < 10) s = s.padStart(10, "0");
      return /^\d{10}$/.test(s) ? s : null;
    }).filter(Boolean))].slice(0, 25);
    bbls.lookup_path = "soda";
    return markSourceAcquisition(bbls, "ok", observedAt);
  } catch {
    const empty = [];
    empty.lookup_path = "soda";
    return markSourceAcquisition(empty, "unavailable");
  }
}

async function fetchDobForBbls(bbls, { observedAt = new Date().toISOString() } = {}) {
  if (!bbls?.length) return markSourceAcquisition([], "not_requested");
  // Query up to 3 BBLs to stay inside URL limits; enough for the side-car.
  const sample = bbls.slice(0, 3);
  const clauses = sample.map((b) => `bbl='${String(b).replace(/'/g, "''")}'`).join(" OR ");
  const url =
    `${SODA}/${DOB_NOW_DATASET}.json?$select=job_filing_number,filing_status,job_type,filing_date,`
    + `house_no,street_name,bbl,bin`
    + `&$where=${encodeURIComponent(clauses)}&$order=filing_date DESC&$limit=20`;
  try {
    const rows = await fetchJson(url, 8000);
    if (!Array.isArray(rows)) throw new Error("invalid-dob-response");
    return markSourceAcquisition(rows, "ok", observedAt);
  } catch {
    return markSourceAcquisition([], "unavailable");
  }
}

/**
 * Build one outcome record for a project_id (Open Data + ZAP API + optional DOB).
 */
export async function buildZapOutcomeRecord(projectId, { fetchBbl = true, lookupDoc, now = () => new Date().toISOString() } = {}) {
  const id = String(projectId || "").trim();
  if (!id) {
    return {
      project_id: null,
      join: { matched: false, method: null, reason: "Missing project_id." },
      useful: false,
      filled: false,
    };
  }

  const acquisitionAt = now();
  const openData = await fetchOpenDataRow(id, { lookupDoc, observedAt: acquisitionAt });
  let apiPayload = null;
  try {
    apiPayload = await fetchJson(
      `${ZAP_API_BASE}/projects/${encodeURIComponent(id)}`,
      15000,
    );
  } catch (e) {
    return {
      project_id: id,
      open_data: openData,
      join: {
        matched: false,
        method: null,
        reason: e?.status === 404
          ? "No ZAP API project detail for this project_id."
          : "Could not reach the ZAP project API for decision documents.",
      },
      useful: false,
      filled: false,
      dob: { matched: false, filings: [], reason: "Skipped while ZAP API was unavailable." },
    };
  }

  // Stamp the per-action procedure resolution on the joined record itself so
  // the exact ZAP API action/identifier survives into every downstream
  // consumer of this outcome record (the browser response, the batch
  // authority materializer, the phase view) without re-deriving it from the
  // narrower Open Data snapshot alone.
  const record = stampLandActionProcedureResolution(joinOpenDataToZapOutcome(openData, apiPayload));

  if (record.join?.matched !== true) return record;

  let dob = {
    matched: false,
    method: null,
    filings: [],
    reason: "Tax-lot / DOB side-car not requested.",
  };
  let bbls = [];
  let bblStatus = "not_requested";
  let dobStatus = "not_requested";
  let dobObservedAt = null;
  if (fetchBbl) {
    bbls = await fetchBbls(id, { observedAt: acquisitionAt });
    bblStatus = sourceAcquisitionState.get(bbls) || "unavailable";
    if (!bbls.length) {
      dob = {
        matched: false,
        method: null,
        filings: [],
        reason: "No tax lots published for this project in ZAP BBL data.",
      };
    } else {
      const filings = await fetchDobForBbls(bbls, { observedAt: acquisitionAt });
      dobStatus = sourceAcquisitionState.get(filings) || "unavailable";
      dobObservedAt = sourceObservationState.get(filings)?.observed_at || null;
      dob = joinDobFilingsToBbls(filings, bbls);
      dob.bbls_checked = bbls.length;
    }
  }

  const withDob = {
    ...record,
    dob,
    bbls: Array.isArray(bbls) ? bbls : [],
    filled: outcomeIsFilled(record),
    generated_at: now(),
  };
  const candidateResult = await fetchCityRecordCandidates(openData, record.project_name);
  const cityRecordNotices = joinCityRecordLandNotices(
    candidateResult.rows,
    openData?.ulurp_numbers,
  );
  const assembled = {
    ...withDob,
    // Slim public notice rows for land-detail action rail (participation extraction).
    // Same SODA fields already used for the ULURP spine join — not a new publisher.
    city_record_notices: slimCityRecordNoticesForActionRail(cityRecordNotices).map((notice) => ({
      ...notice,
      source_observation: {
        source_system: "city_record",
        observation_status: "observed",
        observed_at: withDob.generated_at,
      },
    })),
    spine: buildLandEventSpine(withDob, {
      cityRecordNotices,
      noticeLookupStatus: candidateResult.status,
    }),
  };
  // Borough on logistics rows (Open Data is the product borough label for filters).
  if (Array.isArray(assembled.hearing_logistics) && assembled.hearing_logistics.length) {
    const boro = openData?.borough || null;
    assembled.hearing_logistics = assembled.hearing_logistics.map((h) => ({
      ...h,
      borough: h.borough || boro,
      project_name: assembled.project_name || openData?.project_name || null,
    }));
  }
  // Batch-side ULURP statutory clocks (cityscroll.prediction.v0) — precompute-first;
  // the browser only renders the stamped view (no per-request day math).
  const withStatutoryClock = attachUlurpStatutoryPredictions(assembled, {
    generatedAt: assembled.generated_at,
  });
  // Charter deadlines remain authoritative; this warehouse layer adds
  // historical context only after its out-of-time scorecard clears the bar.
  const finalRecord = attachZoningStatistics(withStatutoryClock, zoningStatistics, {
    generatedAt: assembled.generated_at,
  });
  const acquisition = {
    open_data: sourceAcquisitionState.get(openData) || "unavailable",
    city_record: candidateResult.status,
    bbl: bblStatus,
    dob: dobStatus,
  };
  const observedRecord = {
    ...finalRecord,
    source_observations: {
      zap_api: {
        source_system: "zap_project_api",
        acquisition_status: "ok",
        observation_status: "observed",
        observed_at: assembled.generated_at,
      },
      open_data: {
        source_system: "zap_projects_open_data",
        acquisition_status: acquisition.open_data,
        observation_status: acquisition.open_data === "ok" ? "observed" : "unavailable",
        observed_at: acquisition.open_data === "ok" ? sourceObservationState.get(openData)?.observed_at || null : null,
        attempted_at: assembled.generated_at,
      },
      city_record: {
        source_system: "city_record",
        acquisition_status: acquisition.city_record,
        observation_status: acquisition.city_record === "ok" ? "observed" : "unavailable",
        observed_at: acquisition.city_record === "ok" ? assembled.generated_at : null,
        attempted_at: assembled.generated_at,
      },
      bbl: {
        source_system: "zap_bbl_open_data",
        acquisition_status: acquisition.bbl,
        observation_status: acquisition.bbl === "ok" ? "observed" : acquisition.bbl === "not_requested" ? "not_requested" : "unavailable",
        observed_at: acquisition.bbl === "ok" ? sourceObservationState.get(bbls)?.observed_at || null : null,
        attempted_at: fetchBbl ? assembled.generated_at : null,
      },
      dob: {
        source_system: "dob_now",
        acquisition_status: acquisition.dob,
        observation_status: acquisition.dob === "ok" ? "observed" : acquisition.dob === "not_requested" ? "not_requested" : "unavailable",
        observed_at: acquisition.dob === "ok" ? dobObservedAt : null,
        attempted_at: acquisition.dob === "not_requested" ? null : assembled.generated_at,
      },
    },
  };
  const stampedRecord = stampLandStageObservation(observedRecord);
  sourceAcquisitionState.set(stampedRecord, acquisition);
  return stampedRecord;
}

/** Cap notice payload size while keeping body + venue fields for participation steps. */
export function slimCityRecordNoticesForActionRail(notices, limit = 12) {
  return (Array.isArray(notices) ? notices : []).slice(0, limit).map((row) => ({
    request_id: row.request_id || null,
    start_date: row.start_date || null,
    event_date: row.event_date || null,
    section_name: row.section_name || null,
    agency_name: row.agency_name || null,
    type_of_notice_description: row.type_of_notice_description || null,
    short_title: row.short_title || null,
    building_name: row.building_name || null,
    street_address_1: row.street_address_1 || null,
    street_address_2: row.street_address_2 || null,
    city: row.city || null,
    state: row.state || null,
    zip_code: row.zip_code || null,
    email: row.email || null,
    contact_name: row.contact_name || null,
    contact_phone: row.contact_phone || null,
    additional_description_1: row.additional_description_1 || null,
    additional_description_2: row.additional_description_2 || null,
    additional_description_3: row.additional_description_3 || null,
    other_info_1: row.other_info_1 || null,
    other_info_2: row.other_info_2 || null,
    other_info_3: row.other_info_3 || null,
    printout_1: row.printout_1 || null,
    printout_2: row.printout_2 || null,
    printout_3: row.printout_3 || null,
    join: row.join || null,
  }));
}

export async function handleZapOutcomes(request, env, _ctx) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (request.method !== "GET") {
    return response(JSON.stringify({ ok: false, reason: "method" }), 405);
  }

  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get("id") || searchParams.get("project_id");
  if (!projectId || !/^[A-Za-z0-9][A-Za-z0-9_-]{2,24}$/.test(projectId)) {
    return response(JSON.stringify({ ok: false, reason: "bad-id" }), 400);
  }

  const cached = await kvGetRecord(env, projectId);

  const successResponse = async (record, metadata = {}) => {
    const connections = await attachProjectConnectionsSection(record, { db: env?.DB });
    if (connections.section.status === "unavailable") {
      console.warn(JSON.stringify({
        event: "project-connections-unavailable",
        project_id: projectId,
        reason: connections.section.reason,
      }));
    }
    return response(JSON.stringify({
      ok: true,
      ...metadata,
      sections: { project_connections: connections.section },
      record: connections.record,
    }));
  };

  if (cached) {
    return await successResponse(cached, {
      cached: true,
      stale: landStageEvidenceIsStale(cached),
      generated_at: cached.generated_at,
    });
  }
  return response(JSON.stringify({ ok: false, reason: "not-materialized" }), 404);
}
