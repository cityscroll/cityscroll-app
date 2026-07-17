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
import { handleFeedback } from "./feedback.mjs";
import { handleAdminSubs, handleAdminFeedback } from "./admin.mjs";
import { handleFeed } from "./feed.mjs";
import { handleBatch } from "./batch.mjs";
import { handleInv } from "./inv.mjs";
import { handleStats, countActiveSubs } from "./stats.mjs";
import { snapshotHistDay, ensureHistEra } from "./lib/stats.mjs";
import { handleRedirect } from "./redirect.mjs";
import { runAlerts, consumeDigestJob } from "./alerts.mjs";
import { ingestNotices } from "./ingest.mjs";
import { handlePriorCycle, prewarm as prewarmPriorCycle } from "./prior_cycle.mjs";
import { handleExternalAward, refreshAboAwards, prewarmNycha } from "./external_award.mjs";
import { runSuggestionValidation, handleSuggestions, handleAdminSuggestRefresh } from "./suggest.mjs";
import { handleMcp } from "./mcp.mjs";
import { handleBoardHook } from "board-notify";
import { handleInboundEmail } from "./inbound.mjs";

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
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
    if (pathname === "/feedback") return handleFeedback(request, env);
    if (pathname === "/feed.xml" || pathname === "/feed.json" || pathname === "/feed.ics") return handleFeed(request, env, ctx);
    if (pathname === "/batch") return handleBatch(request, env);
    if (pathname === "/inv" || pathname.startsWith("/inv/")) return handleInv(request, env, pathname);
    if (pathname.startsWith("/priorcycle/")) return handlePriorCycle(request, env, pathname);
    if (pathname === "/externalaward") return handleExternalAward(request, env);
    if (pathname === "/suggestions") return handleSuggestions(request, env);
    if (pathname === "/stats") return handleStats(request, env, ctx);
    if (pathname.startsWith("/r/")) return handleRedirect(request, env, ctx, pathname);
    if (pathname === "/api") return Response.redirect("https://crol-list.org/api.html", 302);
    if (pathname === "/admin/subs") return handleAdminSubs(request, env);
    if (pathname === "/admin/feedback") return handleAdminFeedback(request, env);
    if (pathname === "/admin/suggest-refresh") return handleAdminSuggestRefresh(request, env);
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
    // Await directly (not ctx.waitUntil) so the runtime keeps the worker alive until the whole
    // digest run — config watches + every KV subscription — completes.
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
