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
| Mirror failover | `https://raw.githubusercontent.com/cityscroll/crol-list/main/` | Public static-source seam used only when the preferred origin redirects back to CityScroll |
| Calendar UID namespace | `@crol-list` | Deliberately unchanged to prevent duplicate imported events |
| Atom entry namespace | `tag:crol-list.org,2026:` | Deliberately unchanged to prevent duplicate feed-reader entries |
| Email sending and routing | `@crol-list.org` | Deferred to a separate sender-domain decision |

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

```bash
curl -I "https://crol-list.org/about.html?source=cutover"
curl -I "https://cityscroll.org/about.html?source=cutover"
curl -I "https://api.cityscroll.org/api"
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

The email sending and routing domain is explicitly outside this cutover. A
change from `alerts@crol-list.org`, `subscribe@crol-list.org`, or the other
operational addresses requires a separate deliverability and ownership
decision.
