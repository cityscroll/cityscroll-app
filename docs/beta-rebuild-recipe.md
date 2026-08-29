# Rebuild the retired public review lane

The unused public review lane was removed from this repository because it was
never used in production. Cloudflare Pages and DNS resources stay in place until
a later hosting change. This note is the restore path.

## What was removed

Restore these files from
[pull request #1414](https://github.com/cityscroll/cityscroll-app/pull/1414)
(the same change that deletes them):

- `.github/workflows/deploy-beta-preview.yml`
- `.github/workflows/promote-beta.yml`
- `.github/workflows/deploy-worker-beta.yml`
- `tools/ensure_beta_pages.mjs`
- `tools/check_beta_review_contract.mjs`
- `tools/prepare_review_artifact.py`
- `docs/beta-channel.md`

That pull request also cuts review-only branches from `ci.yml`, the shared
Pages build action, Wrangler, Worker CORS, and the architecture notes. Restore
those branches from the same diff. Do not copy production deploy workflows.

## Wrangler environment

Recreate an isolated Worker environment at the end of `worker/wrangler.toml`.
Environment bindings are non-inheritable, so it must list no production KV, D1,
R2, Analytics Engine, Queue, cron, or secret configuration:

```toml
[env.beta]
routes = [
  { pattern = "api-beta.cityscroll.org", custom_domain = true },
]
workers_dev = true

[env.beta.vars]
DEPLOYMENT_CHANNEL = "beta"
ALERTS_LIVE = "false"
ANALYTICS_ENVIRONMENT = "preview"
CONFIRM_BASE = "https://api-beta.cityscroll.org"
```

Keep dual-write, queue, vault, and ingest flags `"false"` as they were in the
removed stanza. Production `[vars]` stay unchanged.

Worker CORS must accept review origins only when `DEPLOYMENT_CHANNEL` is
`beta`. Production must keep rejecting those origins.

## Pages project and DNS

These names already exist on the Cloudflare account and are not created by
this repository change:

| Resource | Name |
| --- | --- |
| Pages project | `crol-list-beta` |
| Pages production branch | `beta` |
| Public pointer | `beta.cityscroll.org` |
| Preview alias | `https://pr-<number>.crol-list-beta.pages.dev` |
| Isolated Worker host | `api-beta.cityscroll.org` |

Provisioning helpers used `CLOUDFLARE_API_TOKEN` and, when more than one
account is visible, the `CLOUDFLARE_ACCOUNT_ID` Actions variable.

## After restore

1. Put the `preview:beta` ready-state alias contract back on the Unit static
   standards family and local preflight.
2. Review artifacts must set `window.CROL_API_ORIGIN` to
   `https://api-beta.cityscroll.org` before page scripts run, add
   `X-Robots-Tag: noindex`, and keep canonical links on `cityscroll.org`.
3. Do not attach production secrets, storage, queues, or cron to the review
   Worker.

Public `?beta=<slug>` flags in `docs/beta-flags.md` are a separate, in-bundle
experiment mechanism. They are not this review lane.
