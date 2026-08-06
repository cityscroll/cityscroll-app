// GET /r/<kind>/<request_id>[?w=<encoded watch filter>] — the count-only digest click-through
// (round three, R·B tier 3; approved by the team 2026-07-02).
//
// Digest emails link notices through here instead of straight to the permalink, so we learn
// "N digest links were followed today, by watch kind" — and nothing else. Deliberately NOT
// tracked: who clicked, which subscriber, which email, IP, user agent. The counter is a plain
// per-day integer. The disclosure line in every digest footer points at this file's behavior.
//
// Not an open redirect: the target is always constructed by us from the validated request id
// (cityscroll.org/notices/<id>); the path never carries a URL. Bad paths fall through to the
// homepage uncounted. The optional `w` query value (w12-12: the originating watch's own filter,
// built by encodeWatchFilter()/lib/filter.mjs) is passed through unread — the redirect only
// bounds its shape (validWatchParam) before re-embedding it in the target's document query; the
// site's own client-side parseWatchParam() is what actually validates its JSON contents, and
// fails soft to the plain notice view on anything malformed or truncated.

import { parseRedirect, noticeUrl, validWatchParam, bumpStat } from "./lib/stats.mjs";
import { emitUsageEvent } from "./lib/analytics.mjs";
import { verifyToken, signToken } from "optin-token";
import {
  isPinsSessionPayload,
  sessionPayload,
  sessionCookieHeader,
  canIssueSharedSessionCookie,
  SESSION_COOKIE_TTL_SECONDS,
  MAX_SESSION_ATTEMPTS_PER_IP_DAY,
} from "./lib/session.mjs";
import { overActorLimit } from "./lib/meter.mjs";

export async function handleRedirect(req, env, ctx, pathname) {
  const parsed = parseRedirect(pathname);
  if (!parsed) {
    return Response.redirect("https://cityscroll.org/", 302);
  }
  const bump = (async () => {
    const now = new Date();
    await bumpStat(env.ALERT_STATE, "click", now);
    await bumpStat(env.ALERT_STATE, `click.${parsed.kind}`, now);
  })();
  emitUsageEvent(env, {
    event: "digest_link_open", lens: parsed.kind, detail: "notice", surface: "digest",
  });
  if (ctx && ctx.waitUntil) ctx.waitUntil(bump); // don't make the reader wait for a counter
  const url = new URL(req.url);
  const w = validWatchParam(url.searchParams.get("w"));
  const location = noticeUrl(parsed.id, w);
  // Optional pins-scoped magic-link token from digest emails. Invalid/expired →
  // silent anonymous redirect (no scary error). Never put the token on the final URL.
  const sessionTok = url.searchParams.get("s") || "";
  const cookie = sessionTok ? await exchangeSessionCookie(req, env, sessionTok) : null;
  if (cookie) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: location,
        "Set-Cookie": cookie,
        "Cache-Control": "no-store",
      },
    });
  }
  return Response.redirect(location, 302);
}

async function exchangeSessionCookie(req, env, token) {
  if (!env.TOKEN_SECRET || !token || !canIssueSharedSessionCookie(req.url)) return null;
  try {
    const ip = req.headers.get("CF-Connecting-IP") || "";
    if (ip && env.SUBS && await overActorLimit(env.SUBS, "session", ip, MAX_SESSION_ATTEMPTS_PER_IP_DAY)) {
      return null;
    }
    const res = await verifyToken(env.TOKEN_SECRET, token);
    if (!res.valid || !isPinsSessionPayload(res.payload)) return null;
    const cookieTok = await signToken(
      env.TOKEN_SECRET,
      sessionPayload(res.payload.e),
      { ttlSeconds: SESSION_COOKIE_TTL_SECONDS },
    );
    return sessionCookieHeader(cookieTok);
  } catch {
    return null;
  }
}
