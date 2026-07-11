// crol-worker — single Cloudflare Worker.
//   fetch:     routes  POST /nl  and  POST /checkbook
//   scheduled: runs the daily alerts digest (cron in wrangler.toml)
//
// Deployed with `wrangler deploy` (free — no per-deploy charge, unlike Netlify).
// Secrets via `wrangler secret put` (ANTHROPIC_API_KEY, RESEND_API_KEY); see README.

import { handleNl } from "./nl.mjs";
import { handleCheckbook, handleForecast } from "./checkbook.mjs";
import { handleUsage } from "./usage.mjs";
import { handleSubscribe } from "./subscribe.mjs";
import { handleConfirm } from "./confirm.mjs";
import { handleUnsubscribe } from "./unsubscribe.mjs";
import { handleFeedback } from "./feedback.mjs";
import { handleAdminSubs, handleAdminFeedback } from "./admin.mjs";
import { handleFeed } from "./feed.mjs";
import { handleBatch } from "./batch.mjs";
import { handleInv } from "./inv.mjs";
import { handleStats } from "./stats.mjs";
import { handleRedirect } from "./redirect.mjs";
import { runAlerts, consumeDigestJob } from "./alerts.mjs";
import { ingestNotices } from "./ingest.mjs";
import { handleMcp } from "./mcp.mjs";
import { handleInboundEmail } from "./inbound.mjs";

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === "/nl") return handleNl(request, env);
    if (pathname === "/mcp") return handleMcp(request, env);
    if (pathname === "/checkbook") return handleCheckbook(request, env);
    if (pathname === "/forecast") return handleForecast(request, env);
    if (pathname === "/usage") return handleUsage(request, env);
    if (pathname === "/subscribe") return handleSubscribe(request, env);
    if (pathname === "/confirm") return handleConfirm(request, env);
    if (pathname === "/unsubscribe") return handleUnsubscribe(request, env);
    if (pathname === "/feedback") return handleFeedback(request, env);
    if (pathname === "/feed.xml" || pathname === "/feed.json" || pathname === "/feed.ics") return handleFeed(request, env, ctx);
    if (pathname === "/batch") return handleBatch(request, env);
    if (pathname === "/inv" || pathname.startsWith("/inv/")) return handleInv(request, env, pathname);
    if (pathname === "/stats") return handleStats(request, env, ctx);
    if (pathname.startsWith("/r/")) return handleRedirect(request, env, ctx, pathname);
    if (pathname === "/api") return Response.redirect("https://crol-list.org/api.html", 302);
    if (pathname === "/admin/subs") return handleAdminSubs(request, env);
    if (pathname === "/admin/feedback") return handleAdminFeedback(request, env);
    if (pathname === "/" || pathname === "/health") {
      return new Response("crol-worker ok", { status: 200, headers: { "Content-Type": "text/plain" } });
    }
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  },

  async scheduled(event, env, ctx) {
    // Refresh the D1 notices mirror first (fail-soft: an ingest failure must never
    // block the digest run — alerts fall back to querying Socrata live anyway).
    try {
      const r = await ingestNotices(env);
      console.log("ingest:", JSON.stringify(r));
    } catch (e) {
      console.error("ingest failed (alerts continue):", String(e?.message || e));
    }
    // Await directly (not ctx.waitUntil) so the runtime keeps the worker alive until the whole
    // digest run — config watches + every KV subscription — completes.
    await runAlerts(env);
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
