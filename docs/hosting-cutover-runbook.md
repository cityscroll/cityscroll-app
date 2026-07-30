# Static hosting cutover runbook

Move the public static site from the current GitHub Pages origin (mirrored for
`cityscroll.org`) onto the Cloudflare Pages project `cityscroll`, without
changing the API Worker.

**Phase 1 (already in the repository):** the site builds and deploys to
`https://cityscroll.pages.dev` in parallel with GitHub Pages. DNS is untouched.
**Phase 2 (this runbook):** an operator with Cloudflare dashboard access points
the public hostnames at Pages after parity passes.
**Phase 3 (follow-up change):** remove the mirror Worker paths, the GitHub Pages
`CNAME` file, and mirror-only tests once the cutover has been verified.

Do not run Phase 2 until Phase 1 has merged, `cityscroll.pages.dev` is green on
the live-URL smoke tool, and the committed route-parity report is PASS.

## Preconditions

- [ ] Phase 1 merged to the default branch.
- [ ] `https://cityscroll.pages.dev/` and `https://cityscroll.pages.dev/about.html`
      return HTTP 200 with real CityScroll page content.
- [ ] Route inventory parity report is PASS
      (`docs/evidence/cloudflare-pages-route-parity.md` or a fresh run of
      `node tools/pages_route_parity.mjs`).
- [ ] Operator has Cloudflare dashboard access for the zone that serves
      `cityscroll.org` and for the Pages project `cityscroll`.
- [ ] GitHub Pages continues to serve `crol-list.org` (fallback origin during
      transition). Do not disable GitHub Pages in this phase.
- [ ] API routes (`api.cityscroll.org`, `api.crol-list.org`) stay on the Worker.
      Do not remove those Worker routes.

## Current production shape (rollback reference)

Record these before changing anything. Values below are the intended
pre-cutover targets; re-check the dashboard if the live zone differs.

| Hostname | Pre-cutover role | Pre-cutover target (rollback) |
| --- | --- | --- |
| `cityscroll.org` | Public apex; Worker custom domain that mirrors GitHub Pages | Cloudflare Worker custom domain / route on the API Worker (`crol-worker`), pattern `cityscroll.org` |
| `www.cityscroll.org` | Public www; same mirror path | Cloudflare Worker custom domain / route on the API Worker, pattern `www.cityscroll.org` |
| `crol-list.org` | GitHub Pages origin (and old-domain redirect for direct visitors) | GitHub Pages (`CNAME` file = `crol-list.org`); leave in place during cutover |
| `api.cityscroll.org` | API Worker | Unchanged |
| `api.crol-list.org` | API compatibility alias | Unchanged |
| `cityscroll.pages.dev` | Parallel Pages host (Phase 1) | Cloudflare Pages project `cityscroll`, production branch `main` |

### Verbatim rollback actions

If anything fails after DNS or route changes, reverse in this order:

1. **Pages custom domains:** In **Workers & Pages → cityscroll → Custom domains**,
   remove `cityscroll.org` and `www.cityscroll.org` if they were added.
2. **Worker routes:** In the Worker `crol-worker` routes (or `wrangler.toml` +
   deploy), restore:

   ```toml
   { pattern = "cityscroll.org", custom_domain = true },
   { pattern = "www.cityscroll.org", custom_domain = true },
   ```

   Redeploy the Worker if the dashboard edit is not enough to restore the mirror.
3. **DNS records:** Restore apex and www to the pre-cutover records (Worker /
   proxied targets as shown in the zone history). Do not leave apex dangling.
4. **Smoke:**

   ```bash
   node tools/live_url_smoke.mjs --timeout-ms 60000 --interval-ms 5000
   ```

   Expect HTTP 200 with CityScroll content on `https://cityscroll.org/` and
   `https://cityscroll.org/about.html`.

GitHub Pages was never turned off; `crol-list.org` remains the fallback origin
for the mirror path until Phase 3 cleanup.

## Phase 2 — cutover steps

### 1. Lower DNS TTL (ahead of the switch)

In the Cloudflare DNS UI for `cityscroll.org`:

1. Open each apex and `www` record that will change.
2. Set **TTL** to **60 seconds** (or the lowest available Auto/minimum).
3. Wait at least one prior TTL interval so resolvers pick up the short TTL
   (if the previous TTL was 300s, wait ≥5 minutes).

Do not change targets yet.

### 2. Confirm parallel host health (cache-busted)

From a clean checkout of the default branch:

```bash
node tools/live_url_smoke.mjs \
  --base-url https://cityscroll.pages.dev \
  --timeout-ms 60000 \
  --interval-ms 5000

node tools/pages_route_parity.mjs \
  --reference https://cityscroll.org \
  --candidate https://cityscroll.pages.dev
```

Both must pass. If either fails, **stop** — do not touch DNS.

### 3. Attach custom domains on the Pages project

In **Workers & Pages → cityscroll → Custom domains**:

1. Add `cityscroll.org`.
2. Add `www.cityscroll.org`.
3. Follow the dashboard prompts. Because the zone is already on Cloudflare,
   DNS records are usually created automatically as proxied (orange cloud).

If the UI reports a conflict with an existing Worker route, complete step 4
before retrying domain activation (Cloudflare will not serve the same hostname
from two products at once).

### 4. Move apex/www off the Worker mirror onto Pages

The public apex is currently a **Worker custom domain** that reverse-proxies
GitHub Pages. Pages cannot own the hostname while the Worker still claims it.

1. Open **Workers & Pages → crol-worker → Settings → Domains & Routes** (wording
   may vary slightly).
2. Remove the custom domain / route entries for:
   - `cityscroll.org`
   - `www.cityscroll.org`
3. Leave `api.cityscroll.org` and `api.crol-list.org` in place.
4. If routes are managed from source, remove the matching `cityscroll.org` and
   `www.cityscroll.org` entries from `worker/wrangler.toml` in a **separate**
   follow-up change after this cutover is proven — during the live cutover,
   prefer the dashboard removal so rollback does not depend on a redeploy race.
5. Return to the Pages custom domains panel and confirm both hostnames show
   **Active**.

### 5. Immediate smoke validation (cache-busted)

Run as soon as the domains show Active:

```bash
# Public apex + deep route (default targets still include both public hosts)
node tools/live_url_smoke.mjs --timeout-ms 120000 --interval-ms 10000

# Explicit cache-busted curls for header-level confirmation
curl -sS -D- -o /dev/null "https://cityscroll.org/?_cutover=$(date +%s)"
curl -sS -D- -o /dev/null "https://cityscroll.org/about.html?_cutover=$(date +%s)"
curl -sS -D- -o /dev/null "https://www.cityscroll.org/?_cutover=$(date +%s)"
```

Expect:

- HTTP 200 (not a redirect loop).
- Body/content checks from the smoke tool pass (CityScroll marker).
- Response headers consistent with Cloudflare Pages (no GitHub Pages
  `x-github-request-id` on the apex once cutover has propagated).

If the smoke tool fails, execute **Verbatim rollback actions** above immediately.

### 6. Hold and observe

- Keep GitHub Pages enabled and publishing for at least 24 hours.
- Keep the short DNS TTL for at least 24 hours, then restore a normal TTL
  (Auto or 300–3600s) after confidence.
- Re-run smoke after the next natural site deploy to confirm the Pages deploy
  workflow still updates the public apex.

### 7. Hand off to Phase 3 (separate change)

After cutover is verified, open a follow-up change that:

1. Deletes mirror Worker code paths (`worker/src/mirror.mjs` and host routing).
2. Removes the GitHub Pages `CNAME` file and retires the GitHub Pages deploy
   only if the site owner no longer wants that fallback.
3. Retargets default live-URL smoke assumptions at the consolidated architecture.
4. Updates project docs that still describe the mirror as production.

Do not combine Phase 3 cleanup with the DNS cutover window.

## Operator checklist (printable)

| Step | Action | Done |
| --- | --- | --- |
| 0 | Phase 1 merged; pages.dev smoke + parity PASS | ☐ |
| 1 | Lower apex/www DNS TTL | ☐ |
| 2 | Reconfirm pages.dev smoke + parity | ☐ |
| 3 | Add Pages custom domains `cityscroll.org`, `www.cityscroll.org` | ☐ |
| 4 | Remove Worker custom domains/routes for apex/www only | ☐ |
| 5 | Confirm Pages domains Active | ☐ |
| 6 | Cache-busted live smoke on public apex | ☐ |
| 7 | Observe ≥24h; restore TTL; schedule Phase 3 cleanup | ☐ |

## Related commands

```bash
# Parallel host only
node tools/live_url_smoke.mjs --base-url https://cityscroll.pages.dev

# Full public smoke (post-cutover)
node tools/live_url_smoke.mjs

# Full inventory parity
node tools/pages_route_parity.mjs \
  --reference https://cityscroll.org \
  --candidate https://cityscroll.pages.dev \
  --out docs/evidence/cloudflare-pages-route-parity.md
```
