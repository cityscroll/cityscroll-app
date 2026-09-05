// cityscroll-worker — single Cloudflare Worker.
//   fetch:     routes  POST /nl  and  POST /checkbook
//   scheduled: runs the daily alerts digest (cron in wrangler.toml)
//
// Deployed with `wrangler deploy` (free — no per-deploy charge, unlike Netlify).
// Secrets via `wrangler secret put` (ANTHROPIC_API_KEY, RESEND_API_KEY); see README.

import "./lib/install_procurement_digest_snapshot.mjs";
import { handleNl } from "./nl.mjs";
import { handleCheckbook, handleForecast, handleForecastAccuracy } from "./checkbook.mjs";
import { handleUsage } from "./usage.mjs";
import { handleSubscribe } from "./subscribe.mjs";
import { handleConfirm } from "./confirm.mjs";
import { handleUnsubscribe } from "./unsubscribe.mjs";
import { handlePrefs } from "./prefs.mjs";
import { handleSession } from "./session.mjs";
import { handlePins } from "./pins.mjs";
import { handleFeedback } from "./feedback.mjs";
import {
  handleAdminSubs,
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
  handleAdminNextDigestPreview,
  handleAdminDigestBackfill,
  handleAdminDigestRollup,
  handleAdminDigestShadow,
  handleAdminDigestSendTest,
  handleAdminDigestCatchUp,
  handleAdminPassportIngest,
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
import { handleSourceHealth } from "./source_health.mjs";
import { handleEvent } from "./events.mjs";
import { handleSearchActivity } from "./search_activity.mjs";
import { handleSearchHistory } from "./search_history.mjs";
import { handlePerformanceEvents } from "./performance_events.mjs";
import { handleWorkerHealth } from "./lib/worker_health.mjs";
import { snapshotHistDay, ensureHistEra } from "./lib/stats.mjs";
import { handleRedirect } from "./redirect.mjs";
import { runAlerts, consumeDigestJob } from "./alerts.mjs";
import { recordDigestDeliveryReceipt, recordDigestQueueFailure, recordDigestShadowReceipt, recordInboundEmailReceipt } from "./reliability_watchdogs.mjs";
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
import { handleInboundEmail } from "./inbound.mjs";
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
import { handleSourceVault } from "./source_vault.mjs";
import { handleContractLifecycle, prewarmContractLifecycle } from "./checkbook_lifecycle.mjs";
import { handleSubsidyLifecycle, prewarmSubsidyLifecycle } from "./subsidy_lifecycle.mjs";
import { ingestPassportPublic } from "./passport.mjs";
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
import { runDigestShadow } from "./digest_shadow.mjs";
import { handleNearYou } from "./near_you.mjs";
import { handleFollowing } from "./following.mjs";
import { handleSearch } from "./search.mjs";
import { handleSemanticCandidates } from "./semantic_candidates.mjs";
import { handleCitedPassages } from "./cited_retrieval.mjs";
import { handleContract, handleContractsAnalysis, handleContractsBrowse } from "./contracts.mjs";
import { handleLandProject, handleLandProjectsBrowse } from "./land_projects.mjs";
import { recordSourceAcquisitionReceipt } from "./lib/source_acquisition_receipt.mjs";

const MIRROR_HOSTS = new Set(["cityscroll.org", "www.cityscroll.org"]);

async function withWorkerAcquisitionReceipt(env, sourceContractId, runId, work) {
  try {
    const result = await work();
    const status = result?.status === "failed" || result?.status === "error" || result?.ok === false
      ? "failed"
      : "succeeded";
    await recordSourceAcquisitionReceipt(env, {
      source_contract_id: sourceContractId,
      observed_at: new Date().toISOString(),
      status,
      run_id: runId,
      publisher_clock_basis: status === "succeeded" && result?.publisher_updated_at ? "publisher_response" : null,
      publisher_updated_at: status === "succeeded" ? result?.publisher_updated_at || null : null,
      adapter: "worker-scheduled-refresh",
    });
    return result;
  } catch (error) {
    try {
      await recordSourceAcquisitionReceipt(env, {
        source_contract_id: sourceContractId,
        observed_at: new Date().toISOString(),
        status: "failed",
        run_id: runId,
        publisher_clock_basis: null,
        publisher_updated_at: null,
        adapter: "worker-scheduled-refresh",
        exact_error: String(error?.message || error),
      });
    } catch { /* receipt failure must not mask the source failure */ }
    throw error;
  }
}

export default {
  async fetch(request, env, ctx) {
    const { pathname, hostname } = new URL(request.url);
    if (MIRROR_HOSTS.has(hostname)) {
      if (pathname === "/near-you" || pathname === "/near-you/" || pathname === "/near-you/deferred.json") return handleNearYou(request, env, ctx);
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
    if (pathname === "/land-projects") return handleLandProjectsBrowse(request, env);
    if (pathname === "/people-organizations") return handlePeopleOrganizations(request, env);
    if (pathname === "/search") return handleSearch(request, env);
    if (pathname === "/notice") return handleNotice(request, env);
    if (pathname === "/checkbook") return handleCheckbook(request, env);
    if (pathname === "/forecast") return handleForecast(request, env);
    if (pathname === "/forecast/accuracy") return handleForecastAccuracy(request, env);
    if (pathname === "/usage") return handleUsage(request, env);
    if (pathname === "/subscribe") return handleSubscribe(request, env);
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
    if (pathname === "/near-you" || pathname === "/near-you/" || pathname === "/near-you/deferred.json") return handleNearYou(request, env, ctx);
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
    if (pathname === "/admin/attachment-metadata") return handleAdminAttachmentMetadata(request, env);
    if (pathname === "/" || pathname === "/health") {
      return handleWorkerHealth(env);
    }
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  },

  async scheduled(event, env, ctx) {
    const runId = `worker:${event.cron}:${new Date().toISOString()}`;
    // Morning live-derived caches: sell-facing ZAP lookup, upcoming hearings, and
    // staffing exams. Public SODA / OASys only — keep these off the 13:00 digest chain.
    if (event.cron === "0 8 * * *") {
      try {
        const r = await withWorkerAcquisitionReceipt(env, "zap-projects", runId, () => refreshZapProjectsLookup(env));
        console.log("land zap lookup:", JSON.stringify(r));
      } catch (error) {
        console.error("land zap lookup refresh failed:", String(error?.message || error));
      }
      try {
        const r = await withWorkerAcquisitionReceipt(env, "city-record", runId, () => refreshLandUpcomingHearings(env));
        console.log("land upcoming hearings:", JSON.stringify(r));
      } catch (error) {
        console.error("land upcoming hearings refresh failed:", String(error?.message || error));
      }
      try {
        const r = await withWorkerAcquisitionReceipt(env, "dcas-exam-notices", runId, () => refreshStaffingExams(env));
        console.log("staffing exams:", JSON.stringify(r));
      } catch (error) {
        console.error("staffing exams refresh failed:", String(error?.message || error));
      }
      return;
    }
    // 06:00 ET rehearsal: the real digest builders run inline against live data, but delivery,
    // watermarks, send counters, and the 09:00 queue path remain untouched.
    if (event.cron === "0 10 * * *") {
      try {
        // Match the send cron's source freshness: refresh the notices mirror first, then let
        // runAlerts use the same D1/SODA selection logic it will use at 09:00.
        try {
          const result = await withWorkerAcquisitionReceipt(env, "city-record", runId, () => ingestNotices(env));
          console.log("digest shadow ingest:", JSON.stringify(result));
          const prewarm = await prewarmNotices(env, result?.noticeRequestIds);
          console.log("digest shadow notice prewarm:", JSON.stringify(prewarm));
        } catch (error) {
          console.error("digest shadow ingest failed (rehearsal continues):", String(error?.message || error));
        }
        const summary = await runDigestShadow(env);
        await recordDigestShadowReceipt(env, summary);
        console.log("digest shadow:", JSON.stringify(summary, (key, value) => {
          if (typeof value !== "string") return value;
          if (key === "recipient") return redactEmail(value);
          if (key === "recipient_redacted" && value.includes("@") && !value.includes("***")) return redactEmail(value);
          return value;
        }));
      } catch (error) {
        console.error("digest shadow failed:", String(error?.message || error));
      }
      return;
    }
    // Delivery is the scheduled run's critical path. Keep it ahead of advisory read-model
    // refreshes so a slow or failing upstream cannot prevent queue fan-out and its receipt.
    console.log("digest delivery: starting");
    try {
      const summary = await runAlerts(env);
      await recordDigestDeliveryReceipt(env, summary?.receipt || summary);
    } catch (error) {
      await recordDigestDeliveryReceipt(env, null, new Date(), error);
      throw error;
    }
    console.log("digest delivery: complete");

    // Idempotent recovery of the four vetted stranded signups. Fail-soft so a store error
    // cannot undo a completed send. Does not send mail; next scheduled digest enrolls them.
    try {
      const recovery = await recoverDeprecatedDoubleOptIn(env);
      console.log("deprecated-opt-in recovery:", JSON.stringify({
        recovered: recovery.recovered,
        already_recovered: recovery.already_recovered,
        already_enrolled: recovery.already_enrolled,
        developer_test: recovery.developer_test,
      }));
    } catch (error) {
      console.error("deprecated-opt-in recovery failed (digest continues):", String(error?.message || error));
    }

    // Refresh the D1 notices mirror first (fail-soft: an ingest failure must never
    // block the digest run — alerts fall back to querying Socrata live anyway).
    let ingestResult = null;
    try {
      ingestResult = await withWorkerAcquisitionReceipt(env, "city-record", runId, () => ingestNotices(env));
      console.log("ingest:", JSON.stringify(ingestResult));
    } catch (e) {
      console.error("ingest failed (alerts continue):", String(e?.message || e));
    }
    // Notice documents are ordinary reads, so the daily D1 snapshot is pushed to the edge
    // immediately after ingestion. A failed prewarm cannot erase the last-known-good D1 row.
    try {
      const r = await prewarmNotices(env, ingestResult?.noticeRequestIds);
      console.log("notice read-model prewarm:", JSON.stringify(r));
    } catch (e) {
      console.error("notice read-model prewarm failed (digest continues):", String(e?.message || e));
    }
    // Pre-warm prior-cycle / near-match sets for freshly-ingested Award notices (bounded, NOT a
    // full-corpus backfill). Its own try/catch, fail-soft like the other cron jobs — a pre-warm
    // failure must never block the digest. Any un-warmed notice still fills lazily on first
    // request via getOrCompute (GET /priorcycle/<id>).
    try {
      const awardIds = ingestResult?.awardRequestIds || [];
      if (awardIds.length) {
        const r = await prewarmPriorCycle(env, awardIds);
        console.log("prior-cycle prewarm:", JSON.stringify(r));
      }
    } catch (e) {
      console.error("prior-cycle prewarm failed (digest continues):", String(e?.message || e));
    }
    // Awards published elsewhere: refresh the ABO per-source award cache (weekly-gated inside
    // refreshAboAwards — the sources update ~annually) and pre-warm freshly-ingested NYCHA
    // solicitations' exact-PIN matches. Own try/catch, fail-soft like the other cron jobs —
    // any un-warmed notice still fills lazily on first request via GET /externalaward.
    try {
      const r = await refreshAboAwards(env);
      console.log("external-award abo refresh:", JSON.stringify(r));
    } catch (e) {
      console.error("abo award refresh failed (digest continues):", String(e?.message || e));
    }
    try {
      const nychaIds = ingestResult?.nychaRequestIds || [];
      if (nychaIds.length) {
        const r = await prewarmNycha(env, nychaIds);
        console.log("nycha award prewarm:", JSON.stringify(r));
      }
    } catch (e) {
      console.error("nycha award prewarm failed (digest continues):", String(e?.message || e));
    }
    // PASSPort Public contracts + RFx: rebuild the edge materialization from the portal's
    // dataJs dumps before lifecycle prewarm so PIN↔EPIN joins see today's rows. Fail-soft.
    try {
      const r = await withWorkerAcquisitionReceipt(env, "passport-public-contracts", runId, () => ingestPassportPublic(env));
      console.log("passport public ingest:", JSON.stringify(r));
    } catch (e) {
      console.error("passport public ingest failed (digest continues):", String(e?.message || e));
    }
    // Contract lifecycle (PROC-001): pre-warm the procurement timeline for freshly-ingested
    // Award notices. Joins each notice's PIN to Checkbook NYC pending, registered, and spending
    // domains, then enriches unmatched pending/registered stages from PASSPort when EPIN joins.
    // Bounded (≤40/run); missing resident reads stay unavailable until the next acquisition.
    try {
      const awardIds = ingestResult?.awardRequestIds || [];
      if (awardIds.length) {
        const r = await prewarmContractLifecycle(env, awardIds);
        console.log("contract lifecycle prewarm:", JSON.stringify(r));
      }
    } catch (e) {
      console.error("contract lifecycle prewarm failed (digest continues):", String(e?.message || e));
    }
    // NYCIDA/Build NYC subsidy lifecycle (SUB-001): pre-warm the per-notice materialized join
    // for freshly-ingested Award notices. One bounded request per candidate notice; misses or
    // source hiccups are fail-soft and recomputed lazily on first read.
    try {
      const awardIds = ingestResult?.awardRequestIds || [];
      if (awardIds.length) {
        const r = await prewarmSubsidyLifecycle(env, awardIds);
        console.log("subsidy lifecycle prewarm:", JSON.stringify(r));
      }
    } catch (e) {
      console.error("subsidy lifecycle prewarm failed (digest continues):", String(e?.message || e));
    }
    // FY payroll title mart: SODA group-by into ALERT_STATE so People/Staffing
    // suggestion counts are not a request-time 6.8M employee fetch. Fail-soft —
    // a bad write leaves yesterday's KV (or the committed twin) in place.
    try {
      const r = await withWorkerAcquisitionReceipt(env, "citywide-payroll", runId, () => refreshPayrollTitleMart(env));
      console.log("payroll title mart:", JSON.stringify(r));
    } catch (e) {
      console.error("payroll title mart refresh failed (digest continues):", String(e?.message || e));
    }
    // Suggestion-chip validation (w12-08): a candidate's failure is already caught inside
    // runSuggestionValidation itself; this outer catch is only for something the pipeline
    // didn't anticipate (e.g. a KV outage) — either way, a failed run must never block the
    // digest below, and it leaves the previously-validated set in KV untouched.
    try {
      const r = await runSuggestionValidation(env);
      console.log("suggestions:", JSON.stringify(r));
    } catch (e) {
      console.error("suggestion validation failed (digest continues):", String(e?.message || e));
    }
    // Hearings use a small read-optimized materialized view over both City Record sections that carry
    // public events. A daily refresh keeps location extraction and GeoSearch work off the
    // browser path; a stale view remains usable if either upstream is briefly unavailable.
    try {
      const r = await withWorkerAcquisitionReceipt(env, "city-record", runId, () => refreshHearings(env, undefined, undefined, { includeCommunityBoard: true }));
      console.log("hearings:", JSON.stringify(r));
    } catch (e) {
      console.error("hearing refresh failed (digest continues):", String(e?.message || e));
    }
    try {
      const r = await withWorkerAcquisitionReceipt(env, "nyc-property-address-directory", runId, () => refreshProperties(env));
      console.log("properties:", JSON.stringify(r));
    } catch (e) {
      console.error("Property refresh failed (digest continues):", String(e?.message || e));
    }
    try {
      const r = await withWorkerAcquisitionReceipt(env, "nyc-council-legistar", runId, () => refreshMeetingOutcomes(env));
      console.log("meeting outcomes:", JSON.stringify(r));
    } catch (e) {
      console.error("meeting outcomes refresh failed (digest continues):", String(e?.message || e));
    }
    // Land ZAP outcomes: write-ahead prewarm for sell-facing project_ids (In Public Review,
    // Noticed, Active, Filed — capped). Cold GET /zap-outcomes fans out to ZAP API + SODA and
    // takes ~12s; warm KV hits are sub-second. Fail-soft; un-warmed ids still compute-on-miss.
    try {
      const r = await withWorkerAcquisitionReceipt(env, "zap-api-outcomes", runId, () => refreshZapOutcomes(env));
      console.log("zap outcomes prewarm:", JSON.stringify(r));
    } catch (e) {
      console.error("zap outcomes prewarm failed (digest continues):", String(e?.message || e));
    }
    // NYC Rules: daily materialized join of City Record Agency Rules notices to NYC Rules
    // RSS lifecycle records. RSS enrichment is fail-soft — a stale or unreachable feed
    // leaves the view with City Record notices only, and the join gap is explicit.
    try {
      const r = await withWorkerAcquisitionReceipt(env, "nyc-rules-rss", runId, () => refreshRules(env));
      console.log("rules:", JSON.stringify(r));
    } catch (e) {
      console.error("rules refresh failed (digest continues):", String(e?.message || e));
    }
    // Vendor identity headers are a read-optimized daily projection of the full City Record
    // Award history. Publish versioned KV buckets before the manifest so readers never depend
    // on a partially-built generation; any failure leaves the live Socrata resolver available.
    try {
      const r = await withWorkerAcquisitionReceipt(env, "doing-business-entities", runId, () => refreshVendorProfiles(env));
      console.log("vendor profiles:", JSON.stringify(r));
    } catch (e) {
      console.error("vendor profile refresh failed (digest continues):", String(e?.message || e));
    }
    // w12-16: "active watches" is a live gauge (a KV list count), not something with a
    // discrete moment to bump on — so charting it over time means snapshotting today's
    // reading once a day, here, rather than incrementing on an event. No backfill is
    // possible (there's no historical record of this count anywhere); ensureHistEra marks
    // today as the honest start of this series the first time it ever runs.
    try {
      const now = new Date();
      const active = await countActiveSubs(env);
      await snapshotHistDay(env.ALERT_STATE, "watches_active", now, active);
      await ensureHistEra(env.ALERT_STATE, "watches_active", now);
    } catch (e) {
      console.error("watches_active snapshot failed (digest already ran):", String(e?.message || e));
    }
    // Public /stats: refresh and edge-cache the official corpus aggregate. Fail-soft.
    try {
      const r = await prewarmStats(env);
      console.log("stats prewarm:", JSON.stringify(r));
    } catch (e) {
      console.error("stats prewarm failed (digest already ran):", String(e?.message || e));
    }
  },

  // Inbound subscribe-by-email (Cloudflare Email Routing route → this Worker).
  async email(message, env, ctx) {
    ctx.waitUntil((async () => {
      try { await recordInboundEmailReceipt(env, message); }
      catch (error) { console.error("inbound receipt failed:", String(error?.message || error)); }
      await handleInboundEmail(message, env);
    })());
  },

  // Digest queue consumer: one account job per message (single watch or rollup; see alerts.mjs).
  async queue(batch, env) {
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
