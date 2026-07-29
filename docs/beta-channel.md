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

## Promote or restore one commit

The site owner runs **Promote exact commit to beta** from GitHub Actions with:

1. the full 40-character reviewed commit SHA; and
2. `PROMOTE` as the confirmation.

The first run idempotently creates the `crol-list-beta` Direct Upload project
with `beta` as its production branch, deploys that exact commit, and attaches
`beta.crol-list.org`. This is one owner-triggered workflow run; it uses the
existing `CLOUDFLARE_API_TOKEN` repository secret. The token needs Cloudflare
Pages Write access for the account. If Cloudflare rejects the token, update its
permissions at the provider and replace the repository secret; do not put a
token in a commit or command argument.

The workflow verifies the checked-out SHA before building, verifies the public
domain's `release-channel.json` after deployment, and fails unless the domain
reports the selected commit and a no-index header.

Rollback is the same operation: rerun the workflow with the prior known-good
SHA. This re-points beta without changing `crol-list.org`, rewriting history,
or reverting source. The immutable URL in each successful workflow summary is
the audit trail for what was reviewed and what was restored.
