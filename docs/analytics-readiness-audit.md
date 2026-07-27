# Analytics readiness audit

Date: 2026-07-27
Trigger: user feedback that the public statistics surface showed missing or empty information.

## Production reproduction

The live page and endpoint were checked before implementation:

- `https://crol-list.org/stats.html`
- `https://api.crol-list.org/stats`

At 21:36 UTC the JSON endpoint returned HTTP 200 with a generated timestamp and non-zero values.
The healthy endpoint populated the page after its asynchronous request completed. A controlled
failure of both endpoint aliases using the production HTML reproduced the reported empty surface:
all three data grids retained `hidden`, leaving headings and an error message but no panels or
values. The screenshot below is the production page code running with the endpoint made
unavailable.

- Before, [390 px annotated capture](evidence/analytics-readiness-before-390-annotated.png)
- Before, [1440 px annotated capture](evidence/analytics-readiness-before-1440-annotated.png)

The matching post-fix fixtures keep the same panels visible, fill their values, and show
per-panel provenance:

- After, [390 px annotated capture](evidence/analytics-readiness-after-390-annotated.png)
- After, [1440 px annotated capture](evidence/analytics-readiness-after-1440-annotated.png)

## Findings and causes

| Surface | Observation | Classification | Cause | Resolution |
|---|---|---|---|---|
| All number-card groups | Panels disappeared when both endpoint aliases failed. | Render bug | The groups began with `hidden` and were revealed only on the success path. | Cards now remain visible, retain explicit unavailable states, and carry per-panel as-of labels. |
| Searches by section | A section with zero searches, including Meetings in the production response, had no row. | Schema drift | The endpoint discovered only category keys that had already been written. A missing key and a real zero were rendered differently. | The endpoint now returns the complete fixed lens roster with explicit zeroes. |
| Day-by-day history | Early searches and active-watch cells said “Not recorded.” | Collection gap | Those metrics were not collected on those dates. No trustworthy backfill source exists. | Preserved as “Not recorded”; no values were invented. The measured-since boundary remains visible. |
| All current cards and tables | Only one page-level generated timestamp was shown. | Provenance gap | Individual panels did not expose their own as-of state. | Every card and table now receives the endpoint’s generated timestamp; new metrics also expose measured-since. |
| Page views and browser interactions | The public endpoint had no first-party event dataset for page views, lens interest, exports, or deep links. | Collection gap | Cloudflare Web Analytics was separate from the public stats pipeline, and browser actions that do not call the Worker were not counted there. | A bounded first-party event endpoint writes versioned aggregate events to Workers Analytics Engine. |
| Legacy KV event totals | Concurrent increments could undercount. | Storage limitation | KV read-modify-write is eventually consistent and is not an atomic counter. | Existing totals remain for continuity; new interaction analytics use Analytics Engine event points and sampling-aware SQL totals. |

## Published-copy review

User feedback identified two exhaustive promises that the expanded first-party collection would
make false. The published copy now removes only those promises: the privacy introduction is a
non-exhaustive statement of the controls that remain true, searches are described as using NYC
Open Data without claiming the server never sees them, and the Ask-box entry no longer promises
that only a daily count is kept. No new analytics enumeration or replacement promise was added.
The same deletions are applied across every shipped translation. The precise technical inventory
remains in [the versioned event taxonomy](analytics-event-taxonomy.md).
