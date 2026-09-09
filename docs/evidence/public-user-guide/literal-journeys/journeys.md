# Following the guide from the product

These observations cover the candidate based on `05d86cedbd23cb43bb448e1eee4d97fd098b0c60`.
The [capture manifest](capture-manifest.json) records the candidate source hashes,
rendered article words, actions, observed task states, language, guide return
position and capture hashes. Screenshots remain uncommitted. This is a local
browser rehearsal using production renderers and retained public responses;
it is not evidence of a deployed release or delivered messages.

Each journey starts on Home with the selected language, follows Guide to the
article, and opens the article's first task link in a new tab. Later task links
also come from the article. Returning closes the task tab and checks the article
language and its most recently used link position. No finished investigation,
watch, filter or trail is supplied. Account writes are intercepted and shared
investigations are held only in disposable memory.

| Article and journey | English | Spanish | Simplified Chinese | Arabic | Observed result |
| --- | --- | --- | --- | --- | --- |
| [Follow a community board](../../../../site/guide/_articles/follow-a-community-board.md) | Both widths | Both widths | Both widths | Both widths | Manhattan Board 7 criteria, weekly frequency and mocked save confirmation; no real watch or email. |
| [Put dates in your calendar](../../../../site/guide/_articles/put-dates-in-your-calendar.md) | Both widths | Both widths | Both widths | Both widths | Meeting ICS title and dated event checked; filtered subscription URL copied and compared. |
| [Check connection evidence](../../../../site/guide/_articles/check-the-evidence-behind-a-connection.md) | Both widths | — | — | — | Named rule connection, basis and official source inspected; copied address reopened the same panel. |
| [Look at records as of a day](../../../../site/guide/_articles/look-at-records-as-of-a-day.md) | Both widths | Both widths | Both widths | Both widths | Entered cutoff, inspected later records, reopened the date, then cleared it while keeping language. |
| [Collect and export records](../../../../site/guide/_articles/collect-records-and-export-them.md) | Both widths | Both widths | Both widths | Both widths | Two pins, persisted note, CSV and JSON exports, and a mocked read-only shared copy. |
| [Explore housing](../../../../site/guide/_articles/explore-housing-across-city-records.md) | Both widths | — | — | — | Typed search, agency and rule groups, official copy, reopened query and a second search. |
| [Trace a notice to a duty](../../../../site/guide/_articles/trace-a-notice-to-the-duty-behind-it.md) | Both widths | — | — | — | Notice-to-duty and source-law inspection; another notice followed the documented absent-connection fallback. |
| [Trace an award](../../../../site/guide/_articles/trace-an-award-and-keep-the-trail.md) | Both widths | — | — | — | Homeless Services → Lantern Community Services → award 20260729015, created by clicks and reopened with both hops. |

“Both widths” means 390 × 844 and 1440 × 900. The representative localized subset
covers form controls, temporal filtering, download handoff, saved state and shared
navigation. It does not claim all eight journeys in every shipping language.
The award's independent Volunteers of America chain remains supported by the
[merged two-chain receipt](../award-trail/capture-manifest.json); the present
award run follows the named example rather than introducing a directory search.

## Findings and corrections

1. Home's Guide navigation dropped the selected language. The existing language
   runtime now updates all product Guide links while preserving their static
   fallback. The localized journeys exercise the repaired entry at both widths.
2. As-of Apply rebuilt the URL without language. The existing date-share helper
   now retains supported language values for Apply and Clear without forwarding
   unrelated parameters. The matrix covers Spanish, Simplified Chinese and
   Arabic at both widths; extra browser checks cover the no-language default.
3. The investigation footer's bare fragment resolved against the document's
   root base and lost language. The language runtime now updates investigation
   links; pin confirmation and both shared-investigation actions use the
   existing language helper. The collection runs cover the footer and share.
4. The evidence article now says to copy the full browser address after choosing
   the connection-link control, which navigates to the shareable state.
5. The calendar article now explicitly opens a meeting page through Meetings,
   closes More filters when the panel covers the toolbar, and quotes the actual
   English `Add to calendar` label shown by meeting pages.
6. The housing and duty articles now name the actual `View in City Record`
   fallback link. All article corrections were carried into every shipping
   translation through the existing catalog and document builder.

## Separate navigation observations

The [dedicated Agencies search check](directory-observation.json) typed “Parks”
into `agency-directory-query`: 161 visible bodies narrowed to one, and the Parks
link was visible. The [People + organizations check](people-observation.json)
also exposed Parks from its published snapshot, while reporting the remote
search service unavailable. Earlier combined-navigation attempts left that list
unfiltered; that failure was not reproduced in the isolated check. It is a
follow-up investigation candidate, not a confirmed directory defect or a reason
to reject the named award journey.

A bounded static inventory found independent URL builders that merit a separate
language-preservation review. These are code observations, not browser-proven
failures:

| File | Link or URL operation |
| --- | --- |
| `site/index.html` | Home, Now, Near you, Following and Browse navigation uses static destinations without language parameters. |
| `site/civic_document_chrome.mjs` | Document mast destinations preserve place context but not language; the brand and About footer destinations also use static URLs. |
| `site/app/boot.mjs` | Matter Copy link constructs origin, pathname and fragment. |
| `site/app/workspace.mjs` | Matter copy and CSV permalink construction omit the current query. |
| `site/agency_directory_runtime.mjs` | Search and group changes replace the query with directory state. |
| `site/agency_connections.mjs` | Browse facet links are constructed from the scope hash. |
| `site/vendor_footprint.mjs` | Browse facet links are constructed from the scope hash. |
| `site/following_view.mjs` | Browse links are constructed from the watch scope. |
| `site/app/routing.mjs` | Document-route normalization removes language before canonicalization; review replacement-history paths. |

## Evidence boundaries

Calendar import and subscription refresh in an external calendar application are
outside the CityScroll handoff check. Watch email delivery and management links
are not exercised. Translation disclosure still identifies machine-drafted copy
awaiting native review; some product controls remain English and are quoted
exactly. These are bounded limitations, not claims that those external actions
or native review occurred.

Public response hashes and available data vintages are retained in the manifest.
The browser request client received 403 responses for the second search; the same
public endpoints returned successful responses through the command-line client.
Those responses were retained and replayed as read inputs. No civic records or
successful task state were fabricated. Rolling examples can change; this capture
is a manual observation, not a required gate pinned to publisher record IDs.

The Arabic phone calendar capture (`calendar-ar-390-3` in the manifest) also
shows the subscription panel extending past the viewport. The Copy subscription
URL action succeeded and the clipboard matched; some panel text was clipped.
`site/brand.css` owns the dialog layout. This is a separate presentation defect
for follow-up, not a claim that the panel passed a product reflow audit.

## Reproduction

Use the repository's normal generated public documents and installed Playwright
browser. Their owning builders are `tools/build_primary_documents.mjs`,
`tools/build_agency_constellation_documents.mjs` and
`tools/build_community_board_constellation_documents.mjs`. Prepare the preview with `node tools/prepare_guide_preview.mjs`.
Retain read-only public inputs before capturing; those inputs are responses,
not preassembled user state:

```sh
mkdir -p .artifacts/guide-illustrations .artifacts/guide-journeys
python3 tools/capture_award_trail.py --acquire
curl --fail --silent --show-error 'https://api.cityscroll.org/search?q=housing' -o .artifacts/guide-illustrations/keyword.json
curl --fail --silent --show-error 'https://api.cityscroll.org/search/candidates?q=housing' -o .artifacts/guide-illustrations/candidates.json
curl --fail --silent --show-error 'https://api.cityscroll.org/search?q=parks' -o .artifacts/guide-journeys/parks-keyword.json
curl --fail --silent --show-error 'https://api.cityscroll.org/search/candidates?q=parks' -o .artifacts/guide-journeys/parks-candidates.json
python3 tools/capture_guide_journeys.py
```

A later acquisition may contain different records. The committed hashes identify
this observation; failure to find the named example on a later run is a review
finding, not permission to substitute a finished trail.
