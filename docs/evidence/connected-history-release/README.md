# Connected-history release read-back

`release-readback.json` retains dated read-backs of the delivered
connected-history capabilities, measured against the deployed production origin
for the fixed six-case dossier (Coyle, Franklin Avenue, Kingsbridge Armory,
Sixth Avenue, 31st Avenue, Lighthouse Point). The dossier is closed: a missing
case, stratum, route or scheduled cycle is recorded as an open outcome, and no
replacement example is sought.

Each read-back records, per capability: the plain-language capability, the
earlier limitation, the exact route, the steps, the expected native
identifiers, the relation and negative assertions, the observed result, the
public destination, the code, data and deployed revisions, the data vintage,
the evidence class, unresolved limits and the realized outcome. It also retains
the rendered Search journeys (desktop keyboard, narrow touch and no-JavaScript
Chromium), the audit for admitted false-positive joins, and the state of the
first scheduled publication cycle after the release deployment.

Statuses are derived, never declared. The evidence class follows from the
origin that was read. Acceptance is re-derived from each read-back's facts by
`deriveAcceptance` in
[`tools/lib/connected_history_release.mjs`](../../../tools/lib/connected_history_release.mjs).
Read-backs are appended, not rewritten, so earlier failures stay visible.
Screenshot binaries are not committed. Rendered markup hashes are retained
instead.

Reproduce:

```sh
node tools/check_connected_history_release.mjs            # read-only production read, prints the read-back
node tools/check_connected_history_release.mjs --write    # appends it to the retained record
node --test test/connected_history_release.test.mjs
```

The runner refuses when the served Pages revision does not contain the release
delivery commit (checked with `git merge-base --is-ancestor`), and when the
served revision changes during the read.

## Scheduled cycle

The connected-history materializations have no scheduled acquisition of their
own. The release is proven to survive publication by observing the first
scheduled publication workflow run (`geocoder-address-index.yml` or
`first-class-refresh.yml`) that starts after the release deployment, is merged
through its pull request, and is then served. After that cycle, a journey
outside Brooklyn Community Board 15 must pass again and the served history
materializations must be byte-identical to the first read-back. Until all of
that is observed, the cycle stays open. The read-back then records the next
scheduled check and the seven-day deadline.

## Limits that stay visible

- Coverage describes retained acquisition and discovery stages. It does not
  measure or equalize civic activity between boards, and it does not claim
  citywide completeness.
- Fixed-dossier document acquisition failures, missing role strata, families
  without a dated comparison and the incomplete parcel population receipt are
  carried as unresolved limits on the capability that owns them.
