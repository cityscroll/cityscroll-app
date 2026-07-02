// GET /r/<kind>/<request_id> — the count-only digest click-through (round three, R·B tier 3;
// approved by the team 2026-07-02).
//
// Digest emails link notices through here instead of straight to the permalink, so we learn
// "N digest links were followed today, by watch kind" — and nothing else. Deliberately NOT
// tracked: who clicked, which subscriber, which email, IP, user agent. The counter is a plain
// per-day integer. The disclosure line in every digest footer points at this file's behavior.
//
// Not an open redirect: the target is always constructed by us from the validated request id
// (crol-list.org/#notice/<id>); the path never carries a URL. Bad paths fall through to the
// homepage uncounted.

import { parseRedirect, noticeUrl, bumpStat } from "./lib/stats.mjs";

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
  return Response.redirect(noticeUrl(parsed.id), 302);
}
