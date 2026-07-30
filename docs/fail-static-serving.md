# Fail-static serving and health-gated auto-rollback

The CityScroll edge Worker (`cityscroll.org` / `www.cityscroll.org`) reverse-proxies
the GitHub Pages origin at `crol-list.org`. On top of that proxy, the Worker keeps a
**last-known-good (LKG)** pin and a serving mode so a bad Pages deploy cannot take the
public site down.

This is blue-green promotion at the edge: the new origin is the candidate; the pin is
the still-serving green. The pin advances only after the candidate passes a health
check. Until then, visitors keep receiving the pinned snapshot.

## What visitors see

| Mode | `X-CityScroll-Serve` header | Behavior |
|---|---|---|
| Normal | `origin` | Response comes from the live GitHub Pages origin (or a recovered origin after flip-back). |
| Fail-static | `fail-static` | Response comes from the pinned LKG snapshot in Worker KV, or from the public repository source seam when no snapshot exists yet. |

Operators and monitors can read the header without parsing HTML. Worker logs also emit
`mirror-serve:` JSON lines for flips, promotions, and serve decisions.

## Health classes

The origin is unhealthy when a canary probe (`/` or `/index.html`) shows any of:

| Class | Meaning | Field example |
|---|---|---|
| `redirect_loop` | 3xx back to CityScroll / `crol-list.org`, or another same-host bounce | **2026-07-30:** GitHub Pages CNAME 301 loop — deploy reported green while browsers hit `ERR_TOO_MANY_REDIRECTS` |
| `non_200` | Canary status outside 200/304 (for example 500/502) | Origin error page or gateway failure |
| `empty_body` | HTTP 200 with an empty body | Empty Pages artifact |
| `error_page` | HTTP 200 whose body looks like a Pages/error shell | "There isn't a GitHub Pages site here" |
| `network` | Fetch throws | Transient connect errors |

A missing asset **404** on a non-canary path is **not** a site outage; the mirror relays it.

## Bounded retries (blip vs outage)

Before flipping mode, the Worker retries the canary up to **three** attempts
(`HEALTH_MAX_ATTEMPTS`). A single network blip that succeeds on retry does **not** flip
to fail-static. A stable failure (for example the CNAME redirect loop) exhausts retries
and flips.

## Promotion rules (blue-green)

1. Origin canary passes health.
2. The Worker computes a content-addressed `versionId` from the canary body.
3. If `versionId` differs from the stored pin (or no pin exists yet), the pin advances
   and the canary HTML is stored under `mirror:lkg:body:…` in `ALERT_STATE` KV.
4. Unhealthy probes **never** advance the pin.

Flip-back is the inverse: after a fail-static period, a healthy canary restores
`origin` mode, promotes the new pin, and resumes normal proxying.

## KV keys

Stored in the existing `ALERT_STATE` namespace (no new binding):

| Key | Contents |
|---|---|
| `mirror:lkg:v1` | Mode, pin metadata (`versionId`, `promotedAt`, `canaryPath`), last health, last flip |
| `mirror:lkg:body:<path>` | JSON `{ body, contentType, storedAt }` for fail-static HTML |

## Precompute-first constraint

Fail-static serves **already-captured static snapshots** (or the public repository
source seam used by the existing redirect-loop failover). It does not introduce live
upstream app-data fetches. Origin proxying of the static site remains the normal path
when health is good.

## Operator runbook

### Confirm the serving mode

```bash
curl -sI "https://cityscroll.org/" | grep -i x-cityscroll-serve
curl -sI "https://cityscroll.org/index.html" | grep -i x-cityscroll-serve
```

- `origin` — edge trusts the Pages origin.
- `fail-static` — edge is protecting visitors; diagnose the origin (do not "fix" by
  forcing a pin advance).

### When the site is in fail-static

1. **Leave the Worker alone** if visitors are receiving 200s with `fail-static`. The pin
   is doing its job.
2. Inspect the Pages origin independently of the edge:

   ```bash
   curl -sI "https://crol-list.org/" --max-redirs 0
   curl -sI "https://crol-list.org/index.html" --max-redirs 0
   ```

3. Common origin failures:
   - **CNAME / custom-domain redirect loop** (2026-07-30 class): fix the GitHub Pages
     custom-domain / DNS / CNAME configuration so `crol-list.org` returns 200 HTML for
     the canary instead of 3xx to itself or to CityScroll.
   - **Empty or error body with 200**: check the latest Pages deploy artifact.
   - **5xx from Pages**: wait for GitHub recovery or re-run the Pages workflow.
4. After the origin canary returns healthy HTML, the **next** CityScroll request that
   completes the probe will flip back automatically and promote the pin. No manual KV
   edit is required for the happy path.
5. Optional verification after recovery:

   ```bash
   curl -sI "https://cityscroll.org/" | grep -i x-cityscroll-serve   # expect origin
   ```

### Manual pin inspection (advanced)

Requires Cloudflare access to the `ALERT_STATE` KV namespace for this Worker:

```bash
npx wrangler kv key get mirror:lkg:v1 --namespace-id <ALERT_STATE_id> --remote
```

Do **not** hand-edit the pin to a version that has not passed a canary check. That
bypasses the promotion gate and can re-expose a broken deploy.

### Composition with deploy smoke gates

CI-side smoke checks (for example a post-deploy HTTP smoke gate) are independent. This
Worker path is self-contained: even if a smoke gate is absent or green by mistake, the
edge still refuses to promote an unhealthy origin.

## Tests

```bash
cd worker && node --test test/fail_static.test.mjs test/mirror.test.mjs
```

Fixtures live in `worker/test/fixtures/fail_static_health.json` (field case + class
variants) and `worker/test/fixtures/mirror_redirect_regressions.json` (redirect seam).

## Code map

| File | Role |
|---|---|
| `worker/src/lib/fail_static.mjs` | Health assessor, pin state machine, probe with retries |
| `worker/src/mirror.mjs` | Site reverse-proxy + fail-static serve path |
| `worker/src/worker.mjs` | Routes `cityscroll.org` / `www.cityscroll.org` to `handleMirror` |
