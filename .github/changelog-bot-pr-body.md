Automated changelog regeneration — see `.github/workflows/update-changelog.yml` and
`tools/gen_changelog.mjs`. Entries are extracted verbatim from merged PR bodies; nothing here
is hand-written.

This PR intentionally carries no `## What this means for you` section. When it merges, this
same workflow runs again against its own body, finds no marker, regenerates nothing, and exits
before opening another PR — that's the loop's convergence point, not a gap.
