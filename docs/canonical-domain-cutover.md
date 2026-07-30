# Canonical domain cutover

CityScroll uses `cityscroll.org` as its public canonical domain. The repository
name remains `crol-list`, and `crol-list.org` remains the origin hostname for the
GitHub Pages deployment that the CityScroll Worker mirrors.

## Source-of-truth matrix

| Surface | Canonical value | Compatibility or stability rule |
|---|---|---|
| Public site | `https://cityscroll.org` | `crol-list.org` redirects direct visitors |
| Public API | `https://api.cityscroll.org` | `api.crol-list.org` remains an alias for existing clients and in-flight links |
| Beta pointer | `https://beta.cityscroll.org` | Draft preview aliases remain under `crol-list-beta.pages.dev` |
| Beta API | `https://api-beta.cityscroll.org` | `api-beta.crol-list.org` remains a compatibility alias |
| GitHub Pages origin | `https://crol-list.org` | Preferred origin; the mirror fetches it as a manual-redirect Worker subrequest |
| Mirror failover | `https://cityscroll.github.io/crol-list/` | Public static-source seam used only when the preferred origin redirects back to CityScroll |
| Calendar UID namespace | `@crol-list` | Deliberately unchanged to prevent duplicate imported events |
| Atom entry namespace | `tag:crol-list.org,2026:` | Deliberately unchanged to prevent duplicate feed-reader entries |
| Alert email sending | `alerts@cityscroll.org` | Site owner decided the switchover 2026-07-29; `crol-list.org` stays verified as a fallback sending domain |
| Other email routing | `@crol-list.org` | `subscribe@` and `feedback@` are unchanged by this decision |

## One owner activation action

After the canonical code deploys, activate the old-domain redirect in the
Cloudflare zone that serves `crol-list.org`:

1. Proxy the `crol-list.org` and `www.crol-list.org` DNS records through
   Cloudflare.
2. Add one **Single Redirect** with status `301`, preserve query string enabled,
   and this expression:

   ```text
   (http.host in {"crol-list.org" "www.crol-list.org"} and cf.worker.upstream_zone eq "")
   ```

3. Use this dynamic target:

   ```text
   concat("https://cityscroll.org", http.request.uri.path)
   ```

The `cf.worker.upstream_zone` condition applies the redirect to direct visitors
and crawlers but not to the CityScroll mirror's subrequest to its GitHub Pages
origin. The mirror also uses `redirect: "manual"` as a circuit breaker. If a
misconfigured rule still redirects that subrequest to `cityscroll.org`, the
Worker serves the same public static source from GitHub without following the
redirect. This keeps the canonical site available instead of recursively
invoking the Worker.

Paths and query strings are preserved. URL fragments are never sent to an HTTP
server; because the redirect target does not supply a replacement fragment,
conforming browsers retain the original fragment when following the redirect
(RFC 9110, section 10.2.2).

## Post-deploy checks

After every site or worker deploy on `main`, CI runs
`node tools/live_url_smoke.mjs` against `https://cityscroll.org/`,
`https://crol-list.org/`, and `https://cityscroll.org/about.html`. The gate
requires HTTP 200 with real CityScroll page content (not a redirect loop, empty
body, or error shell), cache-busts each probe, and polls for up to ~12 minutes
to absorb GitHub Pages / Fastly redirect-cache lag before failing the deploy
workflow. Failure output names the URL, status chain, and a body snippet.

Manual spot checks remain useful for header-level cutover confirmation:

```bash
curl -I "https://crol-list.org/about.html?source=cutover"
curl -I "https://cityscroll.org/about.html?source=cutover"
curl -I "https://api.cityscroll.org/api"
node tools/live_url_smoke.mjs --timeout-ms 60000 --interval-ms 5000
CROL_BASE=https://cityscroll.org/ python3 test/functional/20_demo_links.py
```

The first response should be a `301` to the matching path on
`cityscroll.org`, including the query string. The canonical response should be
successful and should publish only CityScroll canonical, Open Graph, robots,
and sitemap URLs.

The beta promotion workflow attaches `beta.cityscroll.org` to the reviewed
Pages deployment. Cloudflare normally creates same-zone DNS automatically. If
the domain remains pending, attach or activate `beta.cityscroll.org` in the
Pages project's Custom domains panel. Draft preview aliases are not changed.

After merge, set the GitHub repository's **Website** field to
`https://cityscroll.org`. The repository name stays `crol-list`.

Alert email sending moved separately from the rest of this cutover. The site
owner decided on 2026-07-29 to switch the alerts sender to
`alerts@cityscroll.org` once `cityscroll.org` was verified with the email
provider and a test send was confirmed received. `subscribe@crol-list.org`,
`feedback@crol-list.org`, and the other operational addresses are unchanged
by this decision.
