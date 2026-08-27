# API parity B1: People and organizations directory

This is the first Milestone B dogfood slice. The migrated surface is the
static-first People and organizations directory at `/browse/people/`.

## Before and after

Before, the generated page embedded `data/people_organizations_read_model.json`
and the directory controller filtered that model with a private substring
matcher. The worker's public `organizations.browse@1` capability independently
implemented bounded token matching, typed-kind admission, cursor paging, and
coverage/freshness envelopes over the same model.

After, `organizationsBrowseFromModel` is the transport-neutral provider for
both the worker's HTTP/MCP adapters and the directory's build/browser adapter.
The directory requests only its visible bounded page and uses the capability's
`total_matches` and cursor semantics for its result count and “Show more”
behavior. The static model remains embedded, so first paint and offline
degradation remain static-first. The public presentation-only `search_text`
field is still available to the renderer as a local data attribute; it is not
part of the capability's civic row meaning.

Direct browser HTTP was intentionally not used. This route already delivers a
complete published snapshot and making each keystroke depend on the public API
would add availability and latency dependencies without increasing semantic
parity. Both delivery adapters call the same provider and the public API keeps
its existing cache policy (`max-age=60`, `s-maxage=300`, stale-while-revalidate
for one hour). Filtering and “Show more” issue no network requests, and the
resident-snapshot regression continues to pass with first-party APIs and
publisher endpoints unavailable.

## Equivalence and delivery measurements

The following measurements were taken against the committed 1,362-row
snapshot on 390×844 headless Chromium. The before site was built from the
parent revision and the after site from this change; each row contains three
navigations after the same one-navigation warm-up.

| Measure | Before | After | Result |
| --- | ---: | ---: | --- |
| First Contentful Paint median | 3,412 ms | 2,500 ms | improved |
| Largest Contentful Paint median | 3,412 ms | 2,500 ms | improved |
| TTFB median | 0.3 ms | 0.9 ms | static delivery preserved |
| first-paint rows | 16 | 16 | equivalent |

The local projection benchmark (1,000 calls over the same snapshot) measured
about 0.30–0.34 ms per visible-page capability projection after the bounded
page optimization. The old substring matcher measured 0.009–0.021 ms per
call. This small computation cost stays below the 100 ms interaction budget;
the network request count on filtering remains zero.

For a 205-row parity fixture with `q=parks&type=agency`, the capability reports
102 matches, returns the first 100 with a cursor, and the UI returns the same
102 canonical IDs across its visible-page requests. Existing route/query
wires, labels, source provenance, relation states, and freshness text remain
unchanged.

## Validation

- Capability, HTTP, MCP, UI parity, paging, and existing People rendering tests
  pass.
- Resident-snapshot degradation passes with no publisher or first-party API
  egress.
- The 360px mobile layout and touch-target gate passes.
- Local axe WCAG 2.2 AA is GREEN (zero violations) on the filtered directory
  state; the known top-level complementary-landmark best-practice finding is
  outside the WCAG 2.2 AA tag set and is unchanged from the parent revision.
