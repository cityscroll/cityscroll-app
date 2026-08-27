# Notice context critical path

Production performance analysis identified Notice `notice-context` as the sharpest
readiness tail in the current sample: p75 **12,601.6 ms** and p95 **21,722.2 ms**
over seven days (49 retained observations). Notice page readiness was p75
3,798.1 ms, while FCP was p75 2,348.0 ms. The gap points to client settlement
after the first paint rather than the initial document alone.

## Diagnosis

The pre-change route started `ensureMoneyHistory()` and `ensureRules()`, then
waited for both before rendering the client Notice body. It also waited for the
Notice row and attachment metadata in series. The resident money snapshot is
226,459 bytes on disk. Notice context now consumes the source-vintaged
`notice_context_lookup.json` projection instead of fetching and scanning that
full snapshot on the route. The lookup is 109,816 bytes in the current
materialization and contains only the aggregates needed by the existing cards.

The browser Performance marks (`cityscroll.notice-context.*` and
`cityscroll.app-import.*`) isolate route start, Notice read, attachment metadata,
lookup/branch timing, first context readiness, route-module completion, and final
settlement without recording identifiers or expanding the RUM payload. A 30-sample
deterministic microbenchmark measured the context input p75 at 0.695 ms before the
projection and 0.370 ms after it; this is an implementation benchmark, not a field
RUM savings forecast.

## Change

- Render the Notice body and start `fillContext` as soon as the Notice row is
  available; route modules no longer gate Notice-context readiness.
- Start attachment metadata after the primary row is available and hydrate its
  source card, extracted content, related notices, and tables progressively.
- Materialize agency/vendor context aggregates in
  `tools/build_notice_context_lookup.mjs` after the resident money snapshot and
  load that bounded artifact from the Notice owner.
- Start the Notice-context module immediately after core boot on Notice routes
  and retain bounded branch/import marks for the next field investigation.
- Keep the final `data-notice-context-settled` boundary open until late attachment
  hydration has settled, preserving content and terminal-state coverage.

The paired six-surface captures are committed under `before/` and `after/`.
The site owner should confirm the production effect with the field drift monitor,
because local fixture timings do not model the observed real-device tail.
