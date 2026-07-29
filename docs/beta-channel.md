# Beta release channel

The public beta is a **promotion pointer**: `beta.crol-list.org` identifies one
exact reviewed commit. There is no long-lived `beta` branch and no second
integration history.

## Pull request previews

A same-repository draft pull request labeled `preview:beta` deploys to
`https://pr-<number>.crol-list-beta.pages.dev`. That alias stays stable as the
pull request changes, so it is suitable for sharing in a non-technical group
chat. The workflow check summary also records the immutable deployment URL and
the exact source commit.

Only the verified `_site` directory is uploaded. Stable, preview, and beta use
the same Jekyll build, deploy-time i18n stamp derivation, built-stamp check, and
public-artifact gate. Review artifacts add an experimental banner, a link back
to `crol-list.org`, commit metadata, and `X-Robots-Tag: noindex`. They retain
the stable site's canonical links.

## Review decision

Keep a `preview:beta` pull request in draft while its stable preview link is
shared. The suggested chat prompt is:

> React ✅ if you would be comfortable shipping this. Otherwise reply with the
> screen, concern, and preferred change by the stated review deadline.

The site owner records the deadline, outcome, summary, and disposition of each
objection in the pull request template. Silence is recorded as no response,
not approval. A `Revise` or `Withdraw` outcome stays draft; only an explicit
`Promote` outcome may be marked ready. The existing required unit check
validates that record on the `ready_for_review` event, and GitHub does not
allow a draft pull request into the merge queue.

## Promote or restore one commit

The site owner runs **Promote exact commit to beta** from GitHub Actions with:

1. the full 40-character reviewed commit SHA; and
2. `PROMOTE` as the confirmation.

The preview and promotion workflows idempotently create the `crol-list-beta`
Direct Upload project with `beta` as its production branch.
Promotion is one owner-triggered workflow run: it deploys the selected commit
and attaches `beta.crol-list.org`. Both workflows use the existing
`CLOUDFLARE_API_TOKEN` repository secret. The token needs Cloudflare Pages
Write access for the account. If Cloudflare rejects the token, update its
permissions at the provider and replace the repository secret; do not put a
token in a commit or command argument.

The provisioning helper discovers the account when the token can access
exactly one. If the token spans more than one account, the site owner sets the
non-secret `CLOUDFLARE_ACCOUNT_ID` repository Actions variable once and reruns
the workflow.

The workflow verifies the checked-out SHA before building, verifies the public
domain's `release-channel.json` after deployment, and fails unless the domain
reports the selected commit and a no-index header.

Rollback is the same operation: rerun the workflow with the prior known-good
SHA. This re-points beta without changing `crol-list.org`, rewriting history,
or reverting source. The immutable URL in each successful workflow summary is
the audit trail for what was reviewed and what was restored.

## Isolated beta Worker

Review pages are static by default. If a change needs Worker behavior, the site
owner can run **Deploy exact commit to beta Worker** with a full commit SHA and
the `DEPLOY` confirmation. That manual workflow deploys the selected source to
`api-beta.crol-list.org`; there is no automatic beta Worker deployment.

The beta environment inherits no production bindings or secrets. It has no
cron, queues, email route, D1, KV, R2, or Analytics Engine destination. Paid,
stateful, delivery, administrative, and write routes therefore degrade or fail
closed. Its browser-origin allowlist accepts the beta Pages hostnames, while
the production Worker continues to reject those origins.

Preview and promoted beta artifacts select the beta API at deploy time before
page scripts run. They never fall back to the production Worker. If the beta
Worker is unavailable, Worker-backed enhancements degrade and the public-data
parts of the static site keep working.

## Small public experiments

For a small UI trial that is safe to include in the stable bundle, use the
registered, default-off flags documented in `docs/beta-flags.md`. This is
separate from the preview and promotion lanes: `?beta=<slug>` opts one browser
in locally, `?beta=0` returns it to the standard view, and the visible banner
keeps the experimental state clear. CI enforces each flag's owner, surfaces,
on/off tests, and removal date.
