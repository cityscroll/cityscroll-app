// crol-worker — single Cloudflare Worker.
//   fetch:     routes  POST /nl  and  POST /checkbook
//   scheduled: runs the daily alerts digest (cron in wrangler.toml)
//
// Deployed with `wrangler deploy` (free — no per-deploy charge, unlike Netlify).
// Secrets via `wrangler secret put` (ANTHROPIC_API_KEY, RESEND_API_KEY); see README.

import { handleNl } from "./nl.mjs";
import { handleCheckbook, handleForecast, handleForecastAccuracy } from "./checkbook.mjs";
import { handleUsage } from "./usage.mjs";
import { handleSubscribe } from "./subscribe.mjs";
import { handleConfirm } from "./confirm.mjs";
import { handleUnsubscribe } from "./unsubscribe.mjs";
import { handleSession } from "./session.mjs";
import { handlePins } from "./pins.mjs";
import { handleFeedback } from "./feedback.mjs";
import { handleAdminSubs, handleAdminFeedback, handleAdminDigestCatchUp } from "./admin.mjs";
import { handleFeed } from "./feed.mjs";
import { handleBatch } from "./batch.mjs";
import { handleAgencies } from "./agencies.mjs";
import { handleInv } from "./inv.mjs";
import { handleStats, countActiveSubs } from "./stats.mjs";
import { handleEvent } from "./events.mjs";
import { snapshotHistDay, ensureHistEra } from "./lib/stats.mjs";
import { handleRedirect } from "./redirect.mjs";
import { runAlerts, consumeDigestJob, runCatchUpDigests } from "./alerts.mjs";
import { ingestNotices } from "./ingest.mjs";
import { handlePriorCycle, prewarm as prewarmPriorCycle } from "./prior_cycle.mjs";
import { handleExternalAward, refreshAboAwards, prewarmNycha } from "./external_award.mjs";
import { handleAgency } from "./agency.mjs";
import { runSuggestionValidation, handleSuggestions, handleAdminSuggestRefresh } from "./suggest.mjs";
import { handleMcp } from "./mcp.mjs";
import { handleBoardHook } from "board-notify";
import { handleInboundEmail } from "./inbound.mjs";
import { handleVendorProfile, refreshVendorProfiles } from "./vendor_profile.mjs";
import { handleMirror } from "./mirror.mjs";
import { handleHearings, refreshHearings } from "./hearings.mjs";
import { handleProperties, refreshProperties } from "./property.mjs";
import { handleRules, refreshRules } from "./rules.mjs";
import { handleMeetingOutcomes, refreshMeetingOutcomes } from "./meeting_outcomes.mjs";
import { handleSourceVault } from "./source_vault.mjs";
import { handleContractLifecycle, prewarmContractLifecycle } from "./checkbook_lifecycle.mjs";
import { handleSubsidyLifecycle, prewarmSubsidyLifecycle } from "./subsidy_lifecycle.mjs";
import { ingestPassportPublic } from "./passport.mjs";
import { handleZapOutcomes } from "./zap_outcomes.mjs";
import { handleTranslate } from "./translate.mjs";

const MIRROR_HOSTS = new Set(["cityscroll.org", "www.cityscroll.org"]);

export default {
  async fetch(request, env, ctx) {
    const { pathname, hostname } = new URL(request.url);
    if (MIRROR_HOSTS.has(hostname)) return handleMirror(request);
    if (pathname === "/nl") return handleNl(request, env);
    if (pathname === "/mcp") return handleMcp(request, env);
    if (pathname === "/board-hook") return handleBoardHook(request, env);
    if (pathname === "/checkbook") return handleCheckbook(request, env);
    if (pathname === "/forecast") return handleForecast(request, env);
    if (pathname === "/forecast/accuracy") return handleForecastAccuracy(request, env);
    if (pathname === "/usage") return handleUsage(request, env);
    if (pathname === "/subscribe") return handleSubscribe(request, env);
    if (pathname === "/confirm") return handleConfirm(request, env);
    if (pathname === "/unsubscribe") return handleUnsubscribe(request, env);
    if (pathname === "/session" || pathname === "/session/logout") return handleSession(request, env, pathname);
    if (pathname === "/pins") return handlePins(request, env);
    if (pathname === "/feedback") return handleFeedback(request, env);
    if (pathname === "/feed.xml" || pathname === "/feed.json" || pathname === "/feed.ics") return handleFeed(request, env, ctx);
    if (pathname === "/batch") return handleBatch(request, env);
    if (pathname === "/agencies") return handleAgencies(request, env, ctx);
    if (pathname === "/inv" || pathname.startsWith("/inv/")) return handleInv(request, env, pathname, ctx);
    if (pathname.startsWith("/priorcycle/")) return handlePriorCycle(request, env, pathname, ctx);
    if (pathname.startsWith("/translate/")) return handleTranslate(request, env, pathname, ctx);
    if (pathname === "/externalaward") return handleExternalAward(request, env, ctx);
    if (pathname === "/agency") return handleAgency(request, env, ctx);
    if (pathname === "/vendor-profile") return handleVendorProfile(request, env, ctx);
    if (pathname === "/contract-lifecycle") return handleContractLifecycle(request, env, ctx);
    if (pathname === "/subsidy-lifecycle") return handleSubsidyLifecycle(request, env, ctx);
    if (pathname === "/hearings") return handleHearings(request, env, ctx);
    if (pathname === "/property-locations") return handleProperties(request, env, ctx);
    if (pathname === "/meeting-outcomes") return handleMeetingOutcomes(request, env, ctx);
    if (pathname === "/zap-outcomes") return handleZapOutcomes(request, env, ctx);
    if (pathname === "/rules") return handleRules(request, env, ctx);
    if (pathname === "/source-vault/fetch" || pathname.startsWith("/source-vault/")) return handleSourceVault(request, env);
    if (pathname === "/suggestions") return handleSuggestions(request, env, ctx);
    if (pathname === "/stats") return handleStats(request, env, ctx);
    if (pathname === "/events") return handleEvent(request, env);
    if (pathname.startsWith("/r/")) return handleRedirect(request, env, ctx, pathname);
    if (pathname === "/api") return Response.redirect("https://cityscroll.org/api.html", 302);
    if (pathname === "/admin/subs") return handleAdminSubs(request, env);
    if (pathname === "/admin/feedback") return handleAdminFeedback(request, env);
    if (pathname === "/admin/suggest-refresh") return handleAdminSuggestRefresh(request, env);
    if (pathname === "/admin/digest-catchup") return handleAdminDigestCatchUp(request, env);
    if (pathname === "/" || pathname === "/health") {
      return new Response("crol-worker ok", { status: 200, headers: { "Content-Type": "text/plain" } });
    }
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  },

  async scheduled(event, env, ctx) {
    // Refresh the D1 notices mirror first (fail-soft: an ingest failure must never
    // block the digest run — alerts fall back to querying Socrata live anyway).
    let ingestResult = null;
    try {
      ingestResult = await ingestNotices(env);
      console.log("ingest:", JSON.stringify(ingestResult));
    } catch (e) {
      console.error("ingest failed (alerts continue):", String(e?.message || e));
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
      const r = await ingestPassportPublic(env);
      console.log("passport public ingest:", JSON.stringify(r));
    } catch (e) {
      console.error("passport public ingest failed (digest continues):", String(e?.message || e));
    }
    // Contract lifecycle (PROC-001): pre-warm the procurement timeline for freshly-ingested
    // Award notices. Joins each notice's PIN to Checkbook NYC pending, registered, and spending
    // domains, then enriches unmatched pending/registered stages from PASSPort when EPIN joins.
    // Bounded (≤40/run); compute-on-miss otherwise. Fail-soft like the other cron jobs.
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
      const r = await refreshHearings(env);
      console.log("hearings:", JSON.stringify(r));
    } catch (e) {
      console.error("hearing refresh failed (digest continues):", String(e?.message || e));
    }
    try {
      const r = await refreshProperties(env);
      console.log("properties:", JSON.stringify(r));
    } catch (e) {
      console.error("Property refresh failed (digest continues):", String(e?.message || e));
    }
    try {
      const r = await refreshMeetingOutcomes(env);
      console.log("meeting outcomes:", JSON.stringify(r));
    } catch (e) {
      console.error("meeting outcomes refresh failed (digest continues):", String(e?.message || e));
    }
    // NYC Rules: daily materialized join of City Record Agency Rules notices to NYC Rules
    // RSS lifecycle records. RSS enrichment is fail-soft — a stale or unreachable feed
    // leaves the view with City Record notices only, and the join gap is explicit.
    try {
      const r = await refreshRules(env);
      console.log("rules:", JSON.stringify(r));
    } catch (e) {
      console.error("rules refresh failed (digest continues):", String(e?.message || e));
    }
    // Vendor identity headers are a read-optimized daily projection of the full City Record
    // Award history. Publish versioned KV buckets before the manifest so readers never depend
    // on a partially-built generation; any failure leaves the live Socrata resolver available.
    try {
      const r = await refreshVendorProfiles(env);
      console.log("vendor profiles:", JSON.stringify(r));
    } catch (e) {
      console.error("vendor profile refresh failed (digest continues):", String(e?.message || e));
    }
    // Await directly (not ctx.waitUntil) so the runtime keeps the worker alive until the whole
    // digest run — config watches + every KV subscription — completes.

    // Watermark recovery: when DIGEST_CATCH_UP is set, send catch-up digests to any sub whose
    // lastsent lags >= 2 days before the normal run. One-shot env flag — unset after recovery.
    // Prefer the admin POST /admin/digest-catchup endpoint for operator control.
    if (env.DIGEST_CATCH_UP === "1" || env.DIGEST_CATCH_UP === "true") {
      try {
        const r = await runCatchUpDigests(env, { minLagDays: 2 });
        console.log("catch-up (env trigger):", JSON.stringify({ sent: r.sentThisRun, candidates: r.candidates }));
      } catch (e) {
        console.error("catch-up (env trigger) failed (normal digest continues):", String(e?.message || e));
      }
    }

    await runAlerts(env);

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
  },

  // Inbound subscribe-by-email (Cloudflare Email Routing route → this Worker).
  async email(message, env, ctx) {
    ctx.waitUntil(handleInboundEmail(message, env));
  },

  // Digest queue consumer: one subscription per message (see alerts.mjs).
  async queue(batch, env) {
    for (const msg of batch.messages) {
      try {
        await consumeDigestJob(env, msg.body.key);
        msg.ack();
      } catch (e) {
        console.error("digest job failed", String(e?.message || e));
        msg.retry();
      }
    }
  },
};
