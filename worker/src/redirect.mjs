// GET /r/<kind>/<request_id>[?w=<encoded watch filter>] — the count-only digest click-through
// (round three, R·B tier 3; approved by the team 2026-07-02).
//
// Digest emails link notices through here instead of straight to the permalink, so we learn
// "N digest links were followed today, by watch kind" — and nothing else. Deliberately NOT
// tracked: who clicked, which subscriber, which email, IP, user agent. The counter is a plain
// per-day integer. The disclosure line in every digest footer points at this file's behavior.
//
// Not an open redirect: the target is always constructed by us from the validated request id
// (crol-list.org/#notice/<id>); the path never carries a URL. Bad paths fall through to the
// homepage uncounted. The optional `w` query value (w12-12: the originating watch's own filter,
// built by encodeWatchFilter()/lib/filter.mjs) is passed through unread — the redirect only
// bounds its shape (validWatchParam) before re-embedding it in the target's hash fragment; the
// site's own client-side parseWatchParam() is what actually validates its JSON contents, and
// fails soft to the plain notice view on anything malformed or truncated.

import { parseRedirect, noticeUrl, validWatchParam, bumpStat } from "./lib/stats.mjs";

export function handleRedirect(req, env, ctx, pathname) {
  const parsed = parseRedirect(pathname);
  if (!parsed) {
    return Response.redirect("https://crol-list.org/", 302);
  }
  const bump = (async () => {
    const now = new Date();
    await bumpStat(env.ALERT_STATE, "click", now);
    await bumpStat(env.ALERT_STATE, `click.${parsed.kind}`, now);
  })();
  if (ctx && ctx.waitUntil) ctx.waitUntil(bump); // don't make the reader wait for a counter
  const w = validWatchParam(new URL(req.url).searchParams.get("w"));
  return Response.redirect(noticeUrl(parsed.id, w), 302);
}
