// cityscroll-worker — single Cloudflare Worker.
//   fetch:     routes  POST /nl  and  POST /checkbook
//   scheduled: runs the daily alerts digest (cron in wrangler.toml)
//
// Deployed with `wrangler deploy` (free — no per-deploy charge, unlike Netlify).
// Secrets via `wrangler secret put` (ANTHROPIC_API_KEY, RESEND_API_KEY); see README.

import { handleNl } from "./nl.mjs";
import { handleCheckbook, handleForecast, handleForecastAccuracy } from "./checkbook.mjs";
import { handleUsage } from "./usage.mjs";
import { handleSubscribe } from "./subscribe.mjs";
import { handleMonitorPackSubscribe } from "./monitor_packs.mjs";
import { handleConfirm } from "./confirm.mjs";
import { handleUnsubscribe } from "./unsubscribe.mjs";
import { handlePrefs } from "./prefs.mjs";
import { handleSession } from "./session.mjs";
import { handlePins } from "./pins.mjs";
import { handleFeedback } from "./feedback.mjs";
import {
  handleAdminSubs,
  handleAdminWatchSeenMembership,
  handleAdminWatchLog,
  handleAdminWatchLogEnrich,
  handleAdminDeprecatedOptInRecovery,
  handleAdminFeedback,
  handleAdminSearchActivity,
  handleAdminReportAdjudication,
  handleAdminPossiblySame,
  handleAdminPinFamilyVerify,
  handleAdminOpsContract,
  handleAdminPerformance,
  handleAdminStats,
  handleAdminOwedBacklog,
  handleAdminOwedCancel,
  handleAdminNextDigestPreview,
  handleAdminDigestBackfill,
  handleAdminDigestRollup,
  handleAdminDigestShadow,
  handleAdminDigestSendTest,
  handleAdminDigestCatchUp,
  handleAdminPassportIngest,
  handleAdminPassportIngestMeta,
  handleAdminSourceHealthReceipts,
  handleAdminCouncilDiscoveryHealth,
  handleAdminBoardResolutionReview,
  handleAdminOpsAlert,
  handleAdminDigestWatchdog,
  handleAdminSchedulerHeartbeat,
  handleAdminOpsHealth,
  handleAdminMailWatchdog,
} from "./admin.mjs";
import { handleFeed } from "./feed.mjs";
import { handleBatch } from "./batch.mjs";
import { handleAgencies } from "./agencies.mjs";
import { handleInv } from "./inv.mjs";
import { handleStats, countActiveSubs, prewarmStats } from "./stats.mjs";
import { refreshPublicSearchUsageSnapshot } from "./lib/public_search_usage.mjs";
import { handleSourceHealth } from "./source_health.mjs";
import { ANALYTICS_DEV_HEADER, createDeveloperExclusionToken, handleEvent } from "./events.mjs";
import { handleSearchActivity } from "./search_activity.mjs";
import { handleSearchHistory } from "./search_history.mjs";
import { handlePerformanceEvents, normalizeRumBatch } from "./performance_events.mjs";
import { handleWorkerHealth } from "./lib/worker_health.mjs";
import { snapshotHistDay, ensureHistEra } from "./lib/stats.mjs";
import { handleRedirect } from "./redirect.mjs";
import { enqueueDigestJobs, runAlerts, consumeDigestJob } from "./alerts.mjs";
import { recordDigestDeliveryReceipt, recordDigestDeliveryStarted, recordDigestQueueFailure, recordDigestShadowReceipt, recordInboundEmailReceipt } from "./reliability_watchdogs.mjs";
import { redactEmail } from "./lib/subscriptions.mjs";
import { recoverDeprecatedDoubleOptIn } from "./recovered_signups.mjs";
import { ingestNotices } from "./ingest.mjs";
import { handleNotice, prewarmNotices } from "./notice.mjs";
import { handlePriorCycle, prewarm as prewarmPriorCycle } from "./prior_cycle.mjs";
import { handleExternalAward, refreshAboAwards, prewarmNycha } from "./external_award.mjs";
import { handleAgency } from "./agency.mjs";
import { handlePeopleOrganizations } from "./people_organizations.mjs";
import { runSuggestionValidation, handleSuggestions, handleAdminSuggestRefresh } from "./suggest.mjs";
import { handleMcp } from "./mcp.mjs";
import { handleVendorProfile, refreshVendorProfiles } from "./vendor_profile.mjs";
import { handleMirror } from "./mirror.mjs";
import { handleHearings, handleMeetingICS, refreshHearings } from "./hearings.mjs";
import { handleLandUpcomingHearings, refreshLandUpcomingHearings } from "./land_upcoming_hearings.mjs";
import { handleZapProjectsLookup, refreshZapProjectsLookup } from "./zap_projects_lookup.mjs";
import { handleStaffingExams, refreshStaffingExams } from "./staffing_exams.mjs";
import { refreshPayrollTitleMart } from "./lib/payroll_title_mart_kv.mjs";
import { handleProperties, refreshProperties } from "./property.mjs";
import { handleFranchiseConcessions, refreshFranchiseConcessions } from "./franchise_concession.mjs";
import { handleRules, refreshRules } from "./rules.mjs";
import { handleMeetingOutcomes, handleAdminMeetingOutcomesRefresh, refreshMeetingOutcomes } from "./meeting_outcomes.mjs";
import { refreshExactMatterRoster } from "./lib/matter_exact_refresh.mjs";
import { handleSourceVault } from "./source_vault.mjs";
import { EMMONS_CHECKBOOK_ANCHOR, handleContractLifecycle, prewarmContractLifecycle } from "./checkbook_lifecycle.mjs";
import { handleSubsidyLifecycle, prewarmSubsidyLifecycle } from "./subsidy_lifecycle.mjs";
import { ingestPassportPublic, readPassportIngestMeta } from "./passport.mjs";
import { recordPassportAcquisitionFromMeta } from "./lib/source_acquisition_receipt.mjs";
import {
  handleZapOutcomes,
  handleAdminZapOutcomesRefresh,
  refreshZapOutcomes,
} from "./zap_outcomes.mjs";
import { handleTranslate } from "./translate.mjs";
import { handleEntityDossier } from "./entity_dossier.mjs";
import { handlePublicRelationshipGraph } from "./public_relationship_graph.mjs";
import { handleEntityIntelligence } from "./entity_intelligence.mjs";
import { handleAdminAttachmentMetadata, handleAttachmentMetadata } from "./attachment_metadata.mjs";
import {
  markDigestShadowRebuildQueued,
  persistDigestShadowFailure,
  persistDigestShadowStarted,
  runBudgetedNoticeFreshness,
} from "./digest_shadow.mjs";
import {
  createDigestShadowRebuild,
  handleDigestShadowRebuildQueueMessage,
  handleDigestShadowRebuildDeadLetter,
  reconcileStaleDigestShadowRebuilds,
  recoverStalledDigestShadowRuns,
} from "./digest_shadow_rebuild.mjs";
import { handleNearYou } from "./near_you.mjs";
import { isNearYouDeferredPath, isNearYouDocumentPath } from "../../site/near_you_scope_runtime.mjs";
import { handleFollowing } from "./following.mjs";
import { handleSearch } from "./search.mjs";
import { handleSemanticCandidates } from "./semantic_candidates.mjs";
import { handleCitedPassages } from "./cited_retrieval.mjs";
import { handleContract, handleContractsAnalysis, handleContractsBrowse } from "./contracts.mjs";
import { handleLandDecisionPath, handleLandProject, handleLandProjectsBrowse } from "./land_projects.mjs";
import { startMorningZapOutcomes, withWorkerAcquisitionReceipt } from "./lib/worker_acquisition_runtime.mjs";
import {
  beginCostControlProbe,
  canonicalCostProbeWorkload,
  logCostControlProbe,
  runNativeCostControlProbe,
} from "./lib/cost_control_probe.mjs";
import { LAND_PROJECT_ID_PATTERN } from "../../capabilities/land_projects.mjs";
import { RUM_MARKED_TRAFFIC_CLASSES, isRumProductionOrigin } from "../../site/rum_production.mjs";

const MIRROR_HOSTS = new Set(["cityscroll.org", "www.cityscroll.org"]);

const SCHEDULED_STEP_DEADLINE_MS = 90_000;
// This deadline fences only queue fan-out. Preparation can legitimately do its
// own bounded reads; a stalled queue write must still leave time for the receipt.
const SCHEDULED_DIGEST_DEADLINE_MS = 120_000;
const SCHEDULED_RECEIPT_DEADLINE_MS = 5_000;
const MAX_CONFIGURED_SCHEDULED_STEP_DEADLINE_MS = 10 * 60_000;

function scheduledStepDeadlineMs(env, fallback = SCHEDULED_STEP_DEADLINE_MS) {
  const configured = Number(env?.SCHEDULED_STEP_DEADLINE_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.min(configured, MAX_CONFIGURED_SCHEDULED_STEP_DEADLINE_MS)
    : fallback;
}

function mergeAbortSignals(scheduledSignal, requestSignal) {
  if (!scheduledSignal) return requestSignal;
  if (!requestSignal || requestSignal === scheduledSignal) return scheduledSignal;
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function") {
    return AbortSignal.any([scheduledSignal, requestSignal]);
  }
  const controller = new AbortController();
  const abortFrom = (source) => controller.abort(source.reason);
  if (scheduledSignal.aborted) abortFrom(scheduledSignal);
  else scheduledSignal.addEventListener("abort", () => abortFrom(scheduledSignal), { once: true });
  if (requestSignal.aborted) abortFrom(requestSignal);
  else requestSignal.addEventListener("abort", () => abortFrom(requestSignal), { once: true });
  return controller.signal;
}

function fetchWithSignal(signal) {
  return (input, init = {}) => {
    const requestSignal = mergeAbortSignals(signal, init.signal);
    return fetch(input, { ...init, ...(requestSignal ? { signal: requestSignal } : {}) });
  };
}

/**
 * Bound one scheduled operation so a stalled upstream cannot consume the
 * invocation's remaining time. The signal lets cooperative work stop at its
 * next I/O boundary; the late promise is observed so a timed-out step cannot
 * become an unhandled rejection.
 */
async function runScheduledStep(label, work, { timeoutMs = SCHEDULED_STEP_DEADLINE_MS } = {}) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const signal = controller?.signal;
  let timedOut = false;
  let timer = null;
  let timeoutError = null;
  const task = Promise.resolve().then(() => work(signal));
  task.catch(() => {});
  const timeout = typeof setTimeout === "function"
    ? new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        timeoutError = new Error(`${label} exceeded ${timeoutMs}ms scheduled-step deadline`);
        timeoutError.code = "SCHEDULED_STEP_TIMEOUT";
        controller?.abort(timeoutError);
        reject(timeoutError);
      }, timeoutMs);
    })
    : null;
  try {
    const value = await (timeout ? Promise.race([task, timeout]) : task);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error, timed_out: timedOut, timeout_error: timeoutError };
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (controller && !controller.signal.aborted) controller.abort();
  }
}

async function runAcquisitionStep({ env, sourceContractId, runId, label, logLabel = label, work }) {
  const step = await runScheduledStep(label, (signal) => withWorkerAcquisitionReceipt(
    env,
    sourceContractId,
    runId,
    () => work(signal),
    { signal },
  ), { timeoutMs: scheduledStepDeadlineMs(env) });
  if (step.ok) console.log(`${logLabel}:`, JSON.stringify(step.value));
  else console.error(`${logLabel} refresh failed:`, String(step.error?.message || step.error));
  return step;
}

async function runAdvisoryStep(env, label, work) {
  const step = await runScheduledStep(label, work, {
    timeoutMs: scheduledStepDeadlineMs(env),
  });
  if (!step.ok) console.error(`${label} failed (digest continues):`, String(step.error?.message || step.error));
  return step;
}

async function recordDigestDeliveryReceiptLoudly(env, receipt, now = new Date(), error = null) {
  const step = await runScheduledStep("digest delivery terminal receipt", () => (
    recordDigestDeliveryReceipt(env, receipt, now, error)
  ), { timeoutMs: scheduledStepDeadlineMs(env, SCHEDULED_RECEIPT_DEADLINE_MS) });
  if (!step.ok) {
    console.error("digest delivery terminal receipt failed:", String(step.error?.message || step.error));
  }
  return step;
}

const COST_PROBE_HTTP_WORKLOADS = Object.freeze({
  health: { path: "/health", method: "GET" },
  "unknown-route": { path: "/__cost-probe-not-found", method: "GET" },
  events: {
    path: "/events",
    method: "POST",
    validate: (input) => (
      isRumProductionOrigin(input.origin)
      && input.body?.event === "page_view"
      && input.body?.surface === "home"
      && input.body?.traffic_class === "developer"
      && Object.keys(input.body || {}).sort().join(",") === "event,surface,traffic_class"
    ),
  },
  "rum-16": {
    path: "/performance-events",
    method: "POST",
    validate: (input, target) => {
      const normalized = normalizeRumBatch(input.body);
      return normalized.ok
        && normalized.observations.length === 16
        && isRumProductionOrigin(input.origin)
        && RUM_MARKED_TRAFFIC_CLASSES.includes(target.searchParams.get("traffic_class"));
    },
  },
  search: {
    path: "/search",
    method: "GET",
    validate: (_input, target) => String(target.searchParams.get("q") || "").trim().length > 0,
  },
  nearby: { path: "/near-you", method: "GET" },
  browse: { path: "/contracts", method: "GET" },
  "zap-bbl": {
    path: "/land-project",
    method: "GET",
    validate: (_input, target) => LAND_PROJECT_ID_PATTERN.test(String(
      target.searchParams.get("id") || target.searchParams.get("project_id") || "",
    ).trim()),
  },
  "zap-project": {
    path: "/land-project",
    method: "GET",
    validate: (_input, target) => LAND_PROJECT_ID_PATTERN.test(String(
      target.searchParams.get("id") || target.searchParams.get("project_id") || "",
    ).trim()),
  },
  "doing-business": {
    path: "/vendor-profile",
    method: "GET",
    validate: (_input, target) => String(target.searchParams.get("name") || "").trim().length >= 3,
  },
});
const COST_PROBE_HTTP_ORIGIN = "https://api.cityscroll.org";
const COST_PROBE_CRONS = new Map([
  ["0 8 * * *", "scheduled-08"],
  ["0 10 * * *", "scheduled-10"],
  ["0 13 * * *", "scheduled-13"],
]);
const COST_PROBE_MAX_BODY_BYTES = 16 * 1024;

function costProbeContext() {
  const pending = [];
  return {
    passThroughOnException() {},
    waitUntil(promise) { pending.push(Promise.resolve(promise)); },
    async settle() { await Promise.allSettled(pending); },
  };
}

async function sha256Text(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readCostProbeInput(request) {
  const contentLength = request.headers.get("content-length");
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > COST_PROBE_MAX_BODY_BYTES)) {
    throw new Error("invalid probe body length");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new Error("missing probe body");
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > COST_PROBE_MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error("probe body too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function collectCostProbeSemantics(value, pattern, path = "$", output = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectCostProbeSemantics(item, pattern, `${path}[${index}]`, output));
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (pattern.test(key)) output.push([childPath, child]);
      else collectCostProbeSemantics(child, pattern, childPath, output);
    }
  }
  return output;
}

function normalizeCostProbeResponse(value) {
  if (Array.isArray(value)) return value.map(normalizeCostProbeResponse);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/^(?:commit|revision|request_?id)$/i.test(key))
    .map(([key, child]) => [key, normalizeCostProbeResponse(child)]));
}

async function costProbeCorrectness(workloadHash, status, responseText) {
  let value;
  try { value = JSON.parse(responseText); }
  catch { value = responseText; }
  const responseDigest = await sha256Text(canonicalCostProbeWorkload(normalizeCostProbeResponse(value)));
  const digest = async (pattern, includeResponse = false) => sha256Text(canonicalCostProbeWorkload({
    status,
    fields: collectCostProbeSemantics(value, pattern),
    ...(includeResponse ? { response_digest: responseDigest } : {}),
  }));
  return {
    input_digest: workloadHash,
    joins_digest: await digest(/join|match|relation|link/i, true),
    provenance_digest: await digest(/source|provenance|citation|publisher/i),
    miss_digest: await digest(/miss|missing|not.?found|empty|status/i),
    freshness_digest: await digest(/fresh|stale|updated|observed|published|as.?of/i),
  };
}

async function handleCostControlProbe(request, env) {
  let input;
  try { input = await readCostProbeInput(request); }
  catch { return new Response("Not found", { status: 404 }); }
  const kind = input?.kind;
  const suppressWrites = kind === "scheduled" || kind === "queue" || kind === "collector-overhead" || input?.route === "events";
  const workloadHash = await sha256Text(canonicalCostProbeWorkload(input));
  const probe = beginCostControlProbe(request, env, { suppressWrites, workloadHash });
  if (!probe || probe.denied) return probe?.denied || new Response("Not found", { status: 404 });

  let childRequest = null;
  let expectedCohort = null;
  if (kind === "http") {
    try {
      const route = String(input.route || "");
      const workload = COST_PROBE_HTTP_WORKLOADS[route];
      const target = new URL(String(input.url || ""), request.url);
      if (
        !workload
        || target.origin !== COST_PROBE_HTTP_ORIGIN
        || target.pathname !== workload.path
        || input.method !== workload.method
        || (workload.validate && !workload.validate(input, target))
      ) {
        return new Response("Not found", { status: 404 });
      }
      const headers = new Headers({ "Accept": "application/json", "User-Agent": "CityScrollCostControl/1.0" });
      if (input.origin) headers.set("Origin", String(input.origin));
      if (input.method === "POST") headers.set("Content-Type", "application/json");
      if (route === "events") {
        const developerToken = await createDeveloperExclusionToken(env.ANALYTICS_DEV_KEY);
        if (!developerToken) return new Response("Not found", { status: 404 });
        headers.set(ANALYTICS_DEV_HEADER, developerToken);
      }
      childRequest = new Request(target, {
        method: input.method,
        headers,
        body: input.method === "POST" ? JSON.stringify(input.body ?? {}) : undefined,
      });
      expectedCohort = route;
    } catch {
      return new Response("Not found", { status: 404 });
    }
  } else if (kind === "scheduled") {
    expectedCohort = COST_PROBE_CRONS.get(input.cron) || null;
    if (!expectedCohort) return new Response("Not found", { status: 404 });
  } else if (kind === "queue" || kind === "collector-overhead") {
    expectedCohort = kind;
  } else {
    return new Response("Not found", { status: 404 });
  }
  if (probe.cohort !== expectedCohort) return new Response("Not found", { status: 404 });

  probe.accept();

  let result = { status: 204, body_sha256: await sha256Text("") };
  if (kind === "http") {
    const childContext = costProbeContext();
    const response = await worker.fetch(childRequest, probe.env, childContext);
    await childContext.settle();
    const responseText = await response.text();
    result = {
      status: response.status,
      body_sha256: await sha256Text(responseText),
      correctness: await costProbeCorrectness(workloadHash, response.status, responseText),
    };
  } else if (kind === "scheduled") {
    const childContext = costProbeContext();
    await worker.scheduled({ cron: input.cron, scheduledTime: Date.now(), type: "scheduled", costProbe: true }, probe.env, childContext);
    await childContext.settle();
  } else if (kind === "queue") {
    const message = {
      body: { type: "single", key: "cost-probe-nonexistent" },
      ack() {},
      retry() {},
    };
    await worker.queue({ queue: "crol-digests", messages: [message] }, probe.env);
  }
  const snapshot = probe.snapshot({ result });
  logCostControlProbe(probe, { result });
  return Response.json(snapshot, { headers: { "Cache-Control": "no-store" } });
}

const worker = {
  async fetch(request, env, ctx) {
    const { pathname, hostname } = new URL(request.url);
    if (pathname === "/admin/cost-control-probe" && request.method === "POST") {
      return handleCostControlProbe(request, env);
    }
    if (MIRROR_HOSTS.has(hostname)) {
      // Site root `/` and `/near-you` share the local discovery shell; deferred
      // JSON remains under `/near-you/deferred.json`.
      if (isNearYouDocumentPath(pathname) || isNearYouDeferredPath(pathname)) {
        return handleNearYou(request, env, ctx);
      }
      if (pathname === "/following" || pathname === "/following/" || pathname === "/following/personal") return handleFollowing(request, env, ctx);
      if (pathname === "/prefs") return handlePrefs(request, env);
      return handleMirror(request);
    }
    if (pathname === "/nl") return handleNl(request, env);
    if (pathname === "/mcp") return handleMcp(request, env);
    if (pathname === "/search/candidates") return handleSemanticCandidates(request, env);
    if (pathname === "/cited-passages") return handleCitedPassages(request, env);
    if (pathname === "/contract") return handleContract(request, env);
    if (pathname === "/contracts") return handleContractsBrowse(request, env);
    if (pathname === "/contracts/analysis") return handleContractsAnalysis(request, env);
    if (pathname === "/land-project") return handleLandProject(request, env);
    if (pathname === "/land-decision-path") return handleLandDecisionPath(request, env);
    if (pathname === "/land-projects") return handleLandProjectsBrowse(request, env);
    if (pathname === "/people-organizations") return handlePeopleOrganizations(request, env);
    if (pathname === "/search") return handleSearch(request, env);
    if (pathname === "/notice") return handleNotice(request, env);
    if (pathname === "/checkbook") return handleCheckbook(request, env);
    if (pathname === "/forecast") return handleForecast(request, env);
    if (pathname === "/forecast/accuracy") return handleForecastAccuracy(request, env);
    if (pathname === "/usage") return handleUsage(request, env);
    if (pathname === "/subscribe") return handleSubscribe(request, env);
    if (pathname === "/subscribe-pack") return handleMonitorPackSubscribe(request, env);
    if (pathname === "/confirm") return handleConfirm(request, env);
    if (pathname === "/unsubscribe") return handleUnsubscribe(request, env);
    if (pathname === "/prefs") return handlePrefs(request, env);
    if (pathname === "/session" || pathname === "/session/logout") return handleSession(request, env, pathname);
    if (pathname === "/pins") return handlePins(request, env);
    if (pathname === "/feedback") return handleFeedback(request, env);
    if (pathname === "/feed.xml" || pathname === "/feed.json" || pathname === "/feed.ics") return handleFeed(request, env, ctx);
    if (pathname === "/batch") return handleBatch(request, env);
    if (pathname === "/agencies") return handleAgencies(request, env, ctx);
    if (pathname === "/inv" || pathname.startsWith("/inv/")) return handleInv(request, env, pathname, ctx);
    if (pathname.startsWith("/priorcycle/")) return handlePriorCycle(request, env, pathname, ctx);
    if (pathname.startsWith("/translate/")) return handleTranslate(request, env, pathname, ctx);
    if (pathname === "/entity-dossier") return handleEntityDossier(request, env);
    if (pathname === "/entity-relationships") return handlePublicRelationshipGraph(request, env);
    if (pathname === "/entity-intelligence") return handleEntityIntelligence(request, env, ctx);
    if (pathname === "/attachment-metadata" || pathname === "/attachment-metadata/receipt") return handleAttachmentMetadata(request, env);
    if (pathname === "/externalaward") return handleExternalAward(request, env, ctx);
    if (pathname === "/agency") return handleAgency(request, env, ctx);
    if (pathname === "/vendor-profile") return handleVendorProfile(request, env, ctx);
    if (pathname === "/contract-lifecycle") return handleContractLifecycle(request, env, ctx);
    if (pathname === "/subsidy-lifecycle") return handleSubsidyLifecycle(request, env, ctx);
    if (pathname === "/hearings") return handleHearings(request, env, ctx);
    if (pathname === "/land-upcoming-hearings") return handleLandUpcomingHearings(request, env);
    if (pathname === "/zap-projects-lookup") return handleZapProjectsLookup(request, env);
    if (pathname === "/staffing-exams") return handleStaffingExams(request, env);
    if (pathname === "/meeting.ics") return handleMeetingICS(request, env);
    if (pathname === "/property-locations") return handleProperties(request, env, ctx);
    if (pathname === "/franchise-concessions") return handleFranchiseConcessions(request, env, ctx);
    if (pathname === "/meeting-outcomes") return handleMeetingOutcomes(request, env, ctx);
    if (pathname === "/zap-outcomes") return handleZapOutcomes(request, env, ctx);
    if (pathname === "/rules") return handleRules(request, env, ctx);
    if (pathname === "/source-vault/fetch" || pathname.startsWith("/source-vault/")) return handleSourceVault(request, env);
    if (pathname === "/suggestions") return handleSuggestions(request, env, ctx);
    // API and workers.dev hosts keep `/near-you` (canonical redirect) but never
    // claim the host root as the resident shell — that default entry is only on
    // cityscroll.org via the site-host branch above.
    if (
      pathname === "/near-you"
      || pathname === "/near-you/"
      || isNearYouDeferredPath(pathname)
    ) return handleNearYou(request, env, ctx);
    if (pathname === "/following" || pathname === "/following/" || pathname === "/following/personal") return handleFollowing(request, env, ctx);
    if (pathname === "/stats") return handleStats(request, env, ctx);
    if (pathname === "/source-health") return handleSourceHealth(request);
    if (pathname === "/events") return handleEvent(request, env);
    if (pathname === "/search-activity") return handleSearchActivity(request, env);
    if (pathname === "/search-history") return handleSearchHistory(request, env);
    if (pathname === "/performance-events") return handlePerformanceEvents(request, env);
    if (pathname.startsWith("/r/")) return handleRedirect(request, env, ctx, pathname);
    if (pathname === "/api") return Response.redirect("https://cityscroll.org/api.html", 302);
    if (pathname === "/admin/subs") return handleAdminSubs(request, env);
    if (pathname === "/admin/watch-seen-membership") return handleAdminWatchSeenMembership(request, env);
    if (pathname === "/admin/watch-log") return handleAdminWatchLog(request, env);
    if (pathname === "/admin/watch-log/enrich") return handleAdminWatchLogEnrich(request, env);
    if (pathname === "/admin/recover-deprecated-opt-in") return handleAdminDeprecatedOptInRecovery(request, env);
    if (pathname === "/admin/feedback") return handleAdminFeedback(request, env);
    if (pathname === "/admin/search-activity") return handleAdminSearchActivity(request, env);
    if (pathname === "/admin/report-adjudication") return handleAdminReportAdjudication(request, env);
    if (pathname === "/admin/possibly-same") return handleAdminPossiblySame(request, env);
    if (pathname === "/admin/pin-family-verify") return handleAdminPinFamilyVerify(request, env);
    if (pathname === "/admin/ops-contract") return handleAdminOpsContract(request, env);
    if (pathname === "/admin/performance") return handleAdminPerformance(request, env);
    if (pathname === "/admin/stats") return handleAdminStats(request, env);
    if (pathname === "/admin/owed-backlog") return handleAdminOwedBacklog(request, env);
    if (pathname === "/admin/owed-cancel") return handleAdminOwedCancel(request, env);
    if (pathname === "/admin/next-digest-preview") return handleAdminNextDigestPreview(request, env);
    if (pathname === "/admin/digest-backfill") return handleAdminDigestBackfill(request, env);
    if (pathname === "/admin/digest-rollup") return handleAdminDigestRollup(request, env);
    if (pathname === "/admin/digest-shadow") return handleAdminDigestShadow(request, env);
    if (pathname === "/admin/ops-alert") return handleAdminOpsAlert(request, env);
    if (pathname === "/admin/reliability/digest") return handleAdminDigestWatchdog(request, env);
    if (pathname === "/admin/reliability/scheduler") return handleAdminSchedulerHeartbeat(request, env);
    if (pathname === "/admin/reliability/ops-health") return handleAdminOpsHealth(request, env);
    if (pathname === "/admin/reliability/mail") return handleAdminMailWatchdog(request, env);
    if (pathname === "/admin/digest-send-test") return handleAdminDigestSendTest(request, env);
    if (pathname === "/admin/suggest-refresh") return handleAdminSuggestRefresh(request, env);
    if (pathname === "/admin/meeting-outcomes-refresh") return handleAdminMeetingOutcomesRefresh(request, env);
    if (pathname === "/admin/zap-outcomes-refresh") return handleAdminZapOutcomesRefresh(request, env);
    if (pathname === "/admin/digest-catchup") return handleAdminDigestCatchUp(request, env);
    if (pathname === "/admin/passport-ingest") return handleAdminPassportIngest(request, env);
    if (pathname === "/admin/passport-ingest-meta") return handleAdminPassportIngestMeta(request, env);
    if (pathname === "/admin/source-health-receipts") return handleAdminSourceHealthReceipts(request, env);
    if (pathname === "/admin/council-discovery-health") return handleAdminCouncilDiscoveryHealth(request, env);
    if (pathname === "/admin/board-resolution-review") return handleAdminBoardResolutionReview(request, env);
    if (pathname === "/admin/attachment-metadata") return handleAdminAttachmentMetadata(request, env);
    if (pathname === "/" || pathname === "/health") {
      return handleWorkerHealth(env);
    }
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  },

  async scheduled(event, env, ctx) {
    return runNativeCostControlProbe(env, ctx, {
      kind: "scheduled",
      trigger: event.cron,
      scheduledTime: event.scheduledTime,
    }, (measuredEnv, measuredCtx) => worker.runScheduled(event, measuredEnv, measuredCtx));
  },

  async runScheduled(event, env, ctx) {
    const runId = `worker:${event.cron}:${new Date().toISOString()}`;
    // Each scheduled window starts the receipt-only public summary independently.
    // Early-return branches, delivery errors, and slow publisher refreshes must not
    // prevent a publication attempt. waitUntil retains this work without delaying
    // delivery; daily aggregates are idempotent across the three windows.
    const searchUsageRefresh = (async () => {
      try {
        const r = await refreshPublicSearchUsageSnapshot(env);
        console.log("public search usage snapshot:", JSON.stringify(r));
      } catch (error) {
        console.error("public search usage refresh failed:", String(error?.message || error));
      }
    })();
    const shadowReconciliation = reconcileStaleDigestShadowRebuilds(env).catch((error) => {
      console.error("digest shadow stale reconciliation failed", String(error?.message || error));
    });
    // Aged STARTED rehearsals (Monday-stall shape) enqueue the existing checkpointed
    // rebuild queue. Runs beside stale-rebuild reconciliation on every cron window.
    const shadowStartedRecovery = recoverStalledDigestShadowRuns(env).then((result) => {
      if (result?.disabled) return;
      const noteworthy = (result?.actions || []).filter((row) => row.action !== "skipped");
      if (noteworthy.length) {
        console.log("digest shadow started recovery:", JSON.stringify({
          ok: result.ok,
          actions: noteworthy,
        }));
      }
    }).catch((error) => {
      console.error("digest shadow started recovery failed", String(error?.message || error));
    });
    ctx.waitUntil(Promise.all([searchUsageRefresh, shadowReconciliation, shadowStartedRecovery]));
    // Morning live-derived caches. Council Events acquisition runs first so the
    // shared meeting view, route slices, Search, Now, and later alert replay
    // consume the same vintage instead of yesterday's snapshot.
    if (event.cron === "0 8 * * *") {
      // Start independently of delivery and the other advisory acquisitions.
      // A slow/failed digest must not strand resident land records indefinitely.
      startMorningZapOutcomes(ctx, env, runId, refreshZapOutcomes, console, async (lookupOptions) => {
        const { signal, ...options } = lookupOptions || {};
        const r = await withWorkerAcquisitionReceipt(env, "zap-projects", runId, () => refreshZapProjectsLookup(env, {
          ...options,
          fetchImpl: fetchWithSignal(signal),
        }), { signal });
        console.log("land zap lookup:", JSON.stringify(r));
      }, {
        stepRunner: (label, work) => runScheduledStep(label, work, {
          timeoutMs: scheduledStepDeadlineMs(env),
        }),
      });
      await runAcquisitionStep({
        env, sourceContractId: "nyc-council-legistar", runId,
        label: "meeting outcomes", logLabel: "meeting outcomes",
        work: (signal) => signal ? refreshMeetingOutcomes(env, fetchWithSignal(signal)) : refreshMeetingOutcomes(env),
      });
      await runAcquisitionStep({
        env, sourceContractId: "city-record", runId,
        label: "hearings", logLabel: "hearings",
        work: (signal) => signal
          ? refreshHearings(env, fetchWithSignal(signal), undefined, { includeCommunityBoard: true })
          : refreshHearings(env, undefined, undefined, { includeCommunityBoard: true }),
      });
      await runAcquisitionStep({
        env, sourceContractId: "city-record", runId,
        label: "land upcoming hearings", logLabel: "land upcoming hearings",
        work: (signal) => (
          signal
            ? refreshLandUpcomingHearings(env, { fetchImpl: fetchWithSignal(signal) })
            : refreshLandUpcomingHearings(env)
        ),
      });
      await runAcquisitionStep({
        env, sourceContractId: "dcas-exam-notices", runId,
        label: "staffing exams", logLabel: "staffing exams",
        work: (signal) => signal ? refreshStaffingExams(env, { fetchImpl: fetchWithSignal(signal) }) : refreshStaffingExams(env),
      });
      return;
    }
    // 06:00 ET rehearsal: delivery-free. Order: STARTED → budgeted advisory freshness →
    // enqueue the checkpointed DIGEST_SHADOW_QUEUE rebuild (one digest per invocation).
    // Mondays expand weekly subscriptions; forceInline account_builds in one isolate was the
    // STARTED_NOT_FINISHED stall. Queue handoff is the path that completed 2026-10-12.
    // A killed isolate after STARTED still reads as STARTED_NOT_FINISHED, never MISSING_RUN.
    if (event.cron === "0 10 * * *") {
      const shadowNow = new Date(event.scheduledTime ?? Date.now());
      const shadowDay = shadowNow.toISOString().slice(0, 10);
      const shadowInvocationId = `digest-shadow:${event.cron}:${shadowNow.toISOString()}`;
      // Claim overwrites STARTED summary_json. If this day already handed off to
      // DIGEST_SHADOW_QUEUE, leave that stamp alone and skip freshness/enqueue.
      try {
        const existing = await env.DB?.prepare?.(
          "SELECT status, summary_json FROM digest_shadow_runs WHERE run_day = ?",
        )?.bind(shadowDay)?.first?.();
        if (existing?.status === "STARTED" && existing?.summary_json) {
          const prior = JSON.parse(existing.summary_json);
          if (prior?.phase === "rebuild_queued" && prior?.rebuild_run_id) {
            if (event.costProbe !== true) {
              console.log("digest shadow rebuild already queued:", JSON.stringify({
                run_day: shadowDay,
                rebuild_run_id: prior.rebuild_run_id,
                phase: prior.phase,
              }));
            }
            return;
          }
        }
      } catch (error) {
        // Unreadable prior row must not block a fresh claim.
        console.error("digest shadow prior-row check failed:", String(error?.message || error));
      }
      try {
        const started = await persistDigestShadowStarted(env, {
          now: shadowNow,
          invocationId: shadowInvocationId,
        });
        if (started?.write_accepted === false) return;
        if (started?.status !== "STARTED") return;
      } catch (error) {
        console.error("digest shadow start receipt failed:", String(error?.message || error));
        return;
      }

      let freshness = { ok: true, degraded: false };
      try {
        freshness = await runBudgetedNoticeFreshness(env, {
          acquisitionFn: withWorkerAcquisitionReceipt,
          runId,
          ingestFn: ingestNotices,
          prewarmFn: (probeEnv, requestIds, options = {}) => prewarmNotices(probeEnv, requestIds, {
            ...options,
            skipEdgeCacheWrite: event.costProbe === true,
          }),
        });
        if (freshness.degraded) {
          console.error("digest shadow freshness degraded (rebuild continues):", JSON.stringify({
            reason: freshness.reason,
            code: freshness.code || null,
            elapsed_ms: freshness.elapsed_ms,
            subrequests: freshness.subrequests,
            budget_ms: freshness.budget_ms,
            subrequest_budget: freshness.subrequest_budget,
          }));
        } else {
          console.log("digest shadow ingest:", JSON.stringify(freshness.result));
          console.log("digest shadow notice prewarm:", JSON.stringify(freshness.prewarm));
        }
      } catch (error) {
        freshness = {
          ok: false,
          degraded: true,
          reason: String(error?.message || error),
        };
        console.error("digest shadow freshness failed (rebuild continues):", freshness.reason);
      }

      try {
        const queued = await createDigestShadowRebuild(env, {
          now: shadowNow,
          runDay: shadowDay,
        });
        const stamped = await markDigestShadowRebuildQueued(env, {
          day: shadowDay,
          rebuildRunId: queued.run_id,
          invocationId: shadowInvocationId,
          now: shadowNow,
          freshness,
        });
        if (stamped?.write_accepted === false) {
          console.error("digest shadow rebuild queue stamp rejected:", JSON.stringify({
            run_day: shadowDay,
            rebuild_run_id: queued.run_id,
            reason: stamped?.reason || null,
          }));
        }
        if (event.costProbe !== true) {
          console.log("digest shadow rebuild queued:", JSON.stringify({
            run_day: shadowDay,
            rebuild_run_id: queued.run_id,
            status: queued.status,
            freshness_degraded: Boolean(freshness.degraded),
          }));
        }
      } catch (error) {
        console.error("digest shadow rebuild enqueue failed:", String(error?.message || error));
        try {
          const failed = await persistDigestShadowFailure(env, error, {
            now: shadowNow,
            invocationId: shadowInvocationId,
          });
          if (failed?.write_accepted === false) return;
          console.error("digest shadow failure receipt:", JSON.stringify({
            run_day: failed?.run_day,
            status: failed?.status,
            receipt_status: failed?.receipt?.status,
            delivery_policy: failed?.hold?.delivery_policy,
            error: String(error?.message || error),
          }));
        } catch (persistError) {
          console.error("digest shadow failure receipt failed:", String(persistError?.message || persistError));
        }
      }
      return;
    }
    // Delivery starts before advisory read-model refreshes. The stall-prone queue fan-out
    // is fenced inside runAlerts; preparation is not mistaken for queue-write duration.
    // STARTED lands before runAlerts so a cut-short isolate leaves incomplete-execution
    // evidence rather than a missing ledger (which must not be read as proven non-delivery).
    // STARTED is telemetry only: a KV rate-limit or transient put must never skip delivery.
    console.log("digest delivery: starting");
    const startedReceipt = await runScheduledStep("digest delivery STARTED receipt", () => (
      recordDigestDeliveryStarted(env)
    ), { timeoutMs: scheduledStepDeadlineMs(env, SCHEDULED_RECEIPT_DEADLINE_MS) });
    if (!startedReceipt.ok) {
      console.error("digest delivery STARTED receipt failed (delivery continues):", String(startedReceipt.error?.message || startedReceipt.error));
    }
    // Keep the canonical scheduled call shape visible to source-contract checks.
    // await runAlerts(env);
    const fanoutProgress = { enqueued: 0 };
    const delivery = await (async () => {
      try {
        const value = await runAlerts(env, undefined, {
          ...(event.costProbe === true ? { suppressDryRunLogs: true } : {}),
          enqueueJobs: (jobs, { signal } = {}) => runScheduledStep(
            "digest queue fan-out",
            (fanoutSignal) => enqueueDigestJobs(env, jobs, {
              signal: fanoutSignal || signal,
              onBatch: ({ enqueued } = {}) => {
                fanoutProgress.enqueued = Math.max(fanoutProgress.enqueued, Number(enqueued) || 0);
              },
            }),
            { timeoutMs: scheduledStepDeadlineMs(env, SCHEDULED_DIGEST_DEADLINE_MS) },
          ).then((step) => {
            if (!step.ok) throw step.error;
            return step.value;
          }),
        });
        return { ok: true, value };
      } catch (error) {
        return { ok: false, error };
      }
    })();
    if (delivery.ok) {
      await recordDigestDeliveryReceiptLoudly(env, delivery.value?.receipt || delivery.value);
      console.log("digest delivery: complete");
    } else {
      console.error("digest delivery failed (advisories continue):", String(delivery.error?.message || delivery.error));
      const enqueued = Math.max(fanoutProgress.enqueued, Number(delivery.error?.enqueued) || 0);
      await recordDigestDeliveryReceiptLoudly(
        env,
        enqueued > 0 ? { enqueued } : null,
        new Date(),
        delivery.error,
      );
    }

    // Idempotent recovery of the four vetted stranded signups. Fail-soft so a store error
    // cannot undo a completed send. Does not send mail; next scheduled digest enrolls them.
    const recoveryStep = await runAdvisoryStep(env, "deprecated-opt-in recovery", () => recoverDeprecatedDoubleOptIn(env));
    if (recoveryStep.ok) {
      const recovery = recoveryStep.value;
      console.log("deprecated-opt-in recovery:", JSON.stringify({
        recovered: recovery.recovered,
        already_recovered: recovery.already_recovered,
        already_enrolled: recovery.already_enrolled,
        developer_test: recovery.developer_test,
      }));
    }

    // Refresh the D1 notices mirror first (fail-soft: an ingest failure must never
    // block the digest run — alerts fall back to querying Socrata live anyway).
    let ingestResult = null;
    const ingestStep = await runAcquisitionStep({
      env, sourceContractId: "city-record", runId,
      label: "notices ingest", logLabel: "ingest",
      work: () => ingestNotices(env),
    });
    if (ingestStep.ok) ingestResult = ingestStep.value;
    // Notice documents are ordinary reads, so the daily D1 snapshot is pushed to the edge
    // immediately after ingestion. A failed prewarm cannot erase the last-known-good D1 row.
    const noticePrewarm = await runAdvisoryStep(env, "notice read-model prewarm", () => prewarmNotices(env, ingestResult?.noticeRequestIds, {
        skipEdgeCacheWrite: event.costProbe === true,
      }));
    if (noticePrewarm.ok) console.log("notice read-model prewarm:", JSON.stringify(noticePrewarm.value));
    // Pre-warm prior-cycle / near-match sets for freshly-ingested Award notices (bounded, NOT a
    // full-corpus backfill). Its own try/catch, fail-soft like the other cron jobs — a pre-warm
    // failure must never block the digest. Any un-warmed notice still fills lazily on first
    // request via getOrCompute (GET /priorcycle/<id>).
    const priorCyclePrewarm = await runAdvisoryStep(env, "prior-cycle prewarm", async () => {
      const awardIds = ingestResult?.awardRequestIds || [];
      if (awardIds.length) {
        return prewarmPriorCycle(env, awardIds);
      }
      return { warmed: 0 };
    });
    if (priorCyclePrewarm.ok && (priorCyclePrewarm.value?.warmed || priorCyclePrewarm.value?.computed)) {
      console.log("prior-cycle prewarm:", JSON.stringify(priorCyclePrewarm.value));
    }
    // Awards published elsewhere: refresh the ABO per-source award cache (weekly-gated inside
    // refreshAboAwards — the sources update ~annually) and pre-warm freshly-ingested NYCHA
    // solicitations' exact-PIN matches. Own try/catch, fail-soft like the other cron jobs —
    // any un-warmed notice still fills lazily on first request via GET /externalaward.
    const aboRefresh = await runAdvisoryStep(env, "external-award abo refresh", () => refreshAboAwards(env));
    if (aboRefresh.ok) {
      const r = aboRefresh.value;
      console.log("external-award abo refresh:", JSON.stringify(r));
    }
    const nychaPrewarm = await runAdvisoryStep(env, "nycha award prewarm", async () => {
      const nychaIds = ingestResult?.nychaRequestIds || [];
      if (nychaIds.length) {
        return prewarmNycha(env, nychaIds);
      }
      return { warmed: 0 };
    });
    if (nychaPrewarm.ok && (nychaPrewarm.value?.warmed || nychaPrewarm.value?.computed)) {
      console.log("nycha award prewarm:", JSON.stringify(nychaPrewarm.value));
    }
    // PASSPort Public contracts + RFx: rebuild the edge materialization from the portal's
    // dataJs dumps before lifecycle prewarm so PIN↔EPIN joins see today's rows. Fail-soft.
    const passportIngest = await runAdvisoryStep(env, "passport public ingest", async () => {
      const priorMeta = await readPassportIngestMeta(env);
      const r = await ingestPassportPublic(env);
      const meta = await readPassportIngestMeta(env);
      await recordPassportAcquisitionFromMeta(env, meta.ok ? meta : {
        last_attempt_at: new Date().toISOString(),
        last_ok: r?.ok === true ? "true" : "false",
        ingested_at: r?.ingested_at || null,
        contract_rows: r?.contracts,
        rfx_rows: r?.rfx,
        last_modified: r?.last_modified || null,
      }, { run_id: runId, previous_ingested_at: priorMeta?.ingested_at || null });
      return r;
    });
    if (passportIngest.ok) console.log("passport public ingest:", JSON.stringify(passportIngest.value));
    // Contract lifecycle (PROC-001): pre-warm the procurement timeline for freshly-ingested
    // Award notices. Joins each notice's PIN to Checkbook NYC pending, registered, and spending
    // domains, then enriches unmatched pending/registered stages from PASSPort when EPIN joins.
    // Bounded (≤40/run); missing resident reads stay unavailable until the next acquisition.
    const contractPrewarm = await runAdvisoryStep(env, "contract lifecycle prewarm", () => {
      const awardIds = ingestResult?.awardRequestIds || [];
      return prewarmContractLifecycle(env, awardIds, [EMMONS_CHECKBOOK_ANCHOR]);
    });
    if (contractPrewarm.ok) {
      const r = contractPrewarm.value;
      console.log("contract lifecycle prewarm:", JSON.stringify(r));
    }
    // NYCIDA/Build NYC subsidy lifecycle (SUB-001): pre-warm the per-notice materialized join
    // for freshly-ingested Award notices. One bounded request per candidate notice; misses or
    // source hiccups are fail-soft and recomputed lazily on first read.
    const subsidyPrewarm = await runAdvisoryStep(env, "subsidy lifecycle prewarm", async () => {
      const awardIds = ingestResult?.awardRequestIds || [];
      if (awardIds.length) {
        return prewarmSubsidyLifecycle(env, awardIds);
      }
      return { warmed: 0 };
    });
    if (subsidyPrewarm.ok && (subsidyPrewarm.value?.warmed || subsidyPrewarm.value?.computed)) {
      console.log("subsidy lifecycle prewarm:", JSON.stringify(subsidyPrewarm.value));
    }
    // FY payroll title mart: SODA group-by into ALERT_STATE so People/Staffing
    // suggestion counts are not a request-time 6.8M employee fetch. Fail-soft —
    // a bad write leaves yesterday's KV (or the committed twin) in place.
    await runAcquisitionStep({
      env, sourceContractId: "citywide-payroll", runId,
      label: "payroll title mart", logLabel: "payroll title mart",
      work: async (signal) => {
        if (signal) return refreshPayrollTitleMart(env, fetchWithSignal(signal));
        return await refreshPayrollTitleMart(env);
      },
    });
    // Suggestion-chip validation (w12-08): a candidate's failure is already caught inside
    // runSuggestionValidation itself; this outer catch is only for something the pipeline
    // didn't anticipate (e.g. a KV outage) — either way, a failed run must never block the
    // digest below, and it leaves the previously-validated set in KV untouched.
    const suggestions = await runAdvisoryStep(
      env,
      "suggestion validation",
      async () => await runSuggestionValidation(env),
    );
    if (suggestions.ok) console.log("suggestions:", JSON.stringify(suggestions.value));
    // Council Events acquisition precedes every shared meeting consumer so a
    // newly observed eligible hearing is in the same cycle's hearings view.
    await runAcquisitionStep({
      env, sourceContractId: "nyc-council-legistar", runId,
      label: "meeting outcomes", logLabel: "meeting outcomes",
      work: (signal) => signal ? refreshMeetingOutcomes(env, fetchWithSignal(signal)) : refreshMeetingOutcomes(env),
    });
    // Hearings use a small read-optimized materialized view over both City Record sections that carry
    // public events. A daily refresh keeps location extraction and GeoSearch work off the
    // browser path; a stale view remains usable if either upstream is briefly unavailable.
    await runAcquisitionStep({
      env, sourceContractId: "city-record", runId,
      label: "hearings", logLabel: "hearings",
      work: (signal) => signal
        ? refreshHearings(env, fetchWithSignal(signal), undefined, { includeCommunityBoard: true })
        : refreshHearings(env, undefined, undefined, { includeCommunityBoard: true }),
    });
    await runAcquisitionStep({
      env, sourceContractId: "nyc-property-address-directory", runId,
      label: "properties", logLabel: "properties",
      work: (signal) => refreshProperties(env, fetchWithSignal(signal)),
    });
    await runAcquisitionStep({
      env, sourceContractId: "nyc-council-legistar", runId: `${runId}:exact-matter`,
      label: "exact matter refresh", logLabel: "exact matter refresh",
      work: (signal) => refreshExactMatterRoster(env, { fetchImpl: fetchWithSignal(signal) }),
    });
    // NYC Rules: daily materialized join of City Record Agency Rules notices to NYC Rules
    // RSS lifecycle records. RSS enrichment is fail-soft — a stale or unreachable feed
    // leaves the view with City Record notices only, and the join gap is explicit.
    await runAcquisitionStep({
      env, sourceContractId: "nyc-rules-rss", runId,
      label: "rules", logLabel: "rules",
      work: (signal) => refreshRules(env, fetchWithSignal(signal)),
    });
    // Vendor identity headers are a read-optimized daily projection of the full City Record
    // Award history. Publish versioned KV buckets before the manifest so readers never depend
    // on a partially-built generation; any failure leaves the live Socrata resolver available.
    await runAcquisitionStep({
      env, sourceContractId: "doing-business-entities", runId,
      label: "vendor profiles", logLabel: "vendor profiles",
      work: (signal) => refreshVendorProfiles(env, { fetchImpl: fetchWithSignal(signal) }),
    });
    // w12-16: "active watches" is a live gauge (a KV list count), not something with a
    // discrete moment to bump on — so charting it over time means snapshotting today's
    // reading once a day, here, rather than incrementing on an event. No backfill is
    // possible (there's no historical record of this count anywhere); ensureHistEra marks
    // today as the honest start of this series the first time it ever runs.
    const activeWatches = await runAdvisoryStep(env, "watches_active snapshot", async () => {
      const now = new Date();
      const active = await countActiveSubs(env);
      await snapshotHistDay(env.ALERT_STATE, "watches_active", now, active);
      await ensureHistEra(env.ALERT_STATE, "watches_active", now);
      return { active };
    });
    if (activeWatches.ok) console.log("watches_active snapshot:", JSON.stringify(activeWatches.value));
    // Public /stats: refresh and edge-cache the official corpus aggregate. Fail-soft.
    const stats = await runAdvisoryStep(env, "stats prewarm", () => prewarmStats(env, { skipCacheWrite: event.costProbe === true }));
    if (stats.ok) console.log("stats prewarm:", JSON.stringify(stats.value));
  },

  // Inbound subscribe-by-email retired 2026-09-08; retain residual-traffic receipts.
  async email(message, env, ctx) {
    ctx.waitUntil((async () => {
      try { await recordInboundEmailReceipt(env, message); }
      catch (error) { console.error("inbound receipt failed:", String(error?.message || error)); }
      console.log(JSON.stringify({ event: "inbound-email-retired", count: 1 }));
    })());
  },

  // Digest queue consumer: one account job per message (single watch or rollup; see alerts.mjs).
  async queue(batch, env, ctx) {
    return runNativeCostControlProbe(env, ctx, {
      kind: "queue",
      queue: batch.queue,
      batchSize: batch.messages.length,
      messages: batch.messages,
    }, (measuredEnv) => worker.runQueue(batch, measuredEnv));
  },

  async runQueue(batch, env) {
    if (["crol-digest-shadow-rebuild", "crol-digest-shadow-rebuild-dlq"].includes(batch.queue)) {
      for (const msg of batch.messages) {
        try {
          const handler = batch.queue === "crol-digest-shadow-rebuild-dlq"
            ? handleDigestShadowRebuildDeadLetter : handleDigestShadowRebuildQueueMessage;
          await handler(env, msg, { now: new Date() });
          msg.ack();
        } catch (error) {
          console.error("digest shadow rebuild job failed", String(error?.message || error));
          msg.retry(batch.queue === "crol-digest-shadow-rebuild-dlq" ? { delaySeconds: 600 } : undefined);
        }
      }
      return;
    }
    const deadLetterBatch = batch.queue === "crol-digests-dlq";
    for (const msg of batch.messages) {
      if (deadLetterBatch) {
        await recordDigestQueueFailure(env);
        msg.ack();
        continue;
      }
      try {
        // Body is { type, key?, email?, keys? } or legacy { key }.
        await consumeDigestJob(env, msg.body || {});
        msg.ack();
      } catch (e) {
        console.error("digest job failed", String(e?.message || e));
        msg.retry();
      }
    }
  },
};

export default worker;
