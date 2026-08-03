# CityScroll hosting cutover evidence — 2026-08-03

On August 3, 2026, `cityscroll.org` and `www.cityscroll.org` moved from the
API Worker mirror path to the `cityscroll` Cloudflare Pages project. The public
hostnames now use proxied CNAME records targeting `cityscroll.pages.dev`, with
Cloudflare flattening the apex record. The API hostnames remain on the API Worker.

## Timeline

- During an earlier cutover attempt, removing the Worker domain claims also
  removed their managed proxy records, so the Pages claims could not activate
  and the public hostnames lost DNS answers. The first HTTP 530 was observed at
  03:09:01 UTC.
- The earlier attempt was rolled back to the Worker-owned configuration. Fresh
  pinned-edge verification was green at 03:25 UTC. The observed interruption
  lasted 16 minutes from the first HTTP 530 response to the restored HTTP 200.
- A second, owner-authorized attempt began at 11:14 UTC with the ability to
  create replacement zone records immediately. Each Worker domain was replaced
  by its proxied Pages CNAME before the next hostname was moved.
- Both Pages custom domains reported Active at 11:16 UTC. The final hosting and
  DNS invariants were confirmed at 11:16:40 UTC before public verification.

## Verification

- Before the change, the nine-route public inventory passed path-for-path parity
  between `cityscroll.org` and `cityscroll.pages.dev`. The direct Pages hostname
  also passed its live URL smoke check.
- Cloudflare reported both Pages custom domains Active at 11:16 UTC.
- Fresh authoritative DNS queries returned Cloudflare IPv4 and IPv6 proxy
  addresses for both public hostnames.
- The full public smoke matrix passed on its first attempt: the apex, `www`, the
  compatibility hostname, and the About route all reached HTTP 200 with genuine
  CityScroll content.
- Cache-busted checks pinned to a current Cloudflare edge address returned HTTP
  200 for the apex, the About page, and `www`. The About request used one normal
  pretty-URL redirect; no redirect cycle was present.
- Apex and `www` responses carried the Cloudflare Pages header profile and did
  not carry `x-github-request-id`.
- A post-cutover response comparison confirmed that the apex body matched the
  current Pages deployment.
- The complete nine-route inventory passed against the public apex after the
  move, including the API, changelog, data, standards, and statistics pages,
  plus `robots.txt` and `sitemap.xml`.
- `api.cityscroll.org/health` continued to return HTTP 200 with the API Worker
  health marker.
- `crol-list.org` continued to reach the public site with one redirect and a
  final HTTP 200 response.

## Fallback origin

GitHub Pages was not disabled or modified. Its direct project URL continued to
return HTTP 200 with GitHub Pages origin headers after the cutover, confirming
that the fallback origin remains intact.

## Ongoing monitoring

A scheduled production monitor now checks the Pages header profile on the apex
and `www`, bounded redirect following, every route in the public inventory, API
Worker health, the compatibility hostname, and the direct GitHub Pages fallback.
It runs three times daily and can also be started manually. It is deliberately
excluded from pull-request and merge-queue required checks because it tests live
production infrastructure.
