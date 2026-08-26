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
226,459 bytes on disk, but its fetch belongs to deferred Notice enrichment after
the first context milestone; it was not the first-render blocker in the local
resource trace.

The added browser Performance marks (`cityscroll.notice-context.*`) isolate route
start, Notice read, attachment metadata, first context readiness, route-module
completion, and final settlement without recording identifiers or expanding the
RUM payload. In a controlled trace with 1.5-second delays on the route-module and
attachment paths, the pre-change readiness boundary reached about 4,904 ms while
the new `first-ready` mark occurred at about 1,720 ms; attachment settlement
continued independently.

## Change

- Render the Notice body and start `fillContext` as soon as the Notice row is
  available; route modules no longer gate Notice-context readiness.
- Start attachment metadata after the primary row is available and hydrate its
  source card, extracted content, related notices, and tables progressively.
- Keep the final `data-notice-context-settled` boundary open until late attachment
  hydration has settled, preserving content and terminal-state coverage.

The paired six-surface captures are committed under `before/` and `after/`.
The site owner should confirm the production effect with the field drift monitor,
because local fixture timings do not model the observed real-device tail.
