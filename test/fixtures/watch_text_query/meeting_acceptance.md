# Precise-watch meeting matching — acceptance receipt

Textual proof that general meeting watches reuse the versioned `text_query`
(`cityscroll.watch_text_query.v1`) already shipped for procurement, with title
and retained body as separate fields. Grounded at repository revision
`f1482be8dd8620ca796449a60bae30d7ce3aa8fb`. Fixture counts describe the retained
meeting-notice materialization (`generated_at` 2026-09-09T06:52:08.255Z), not a
live production census.

Evaluated field contract: published title (`short_title` / `title`) and retained
body (`additional_description_1`). `search_text`, generated summaries, and
matter-subject tokens are never concatenated. Board, geography, agency, and the
upcoming-event window remain the watch boundaries; new terms only narrow them.

Verify:

```
node --test worker/test/watch_text_query_meetings.test.mjs test/watch_text_query_meeting_ui.test.mjs worker/test/exact_council_matter_watch_boundaries.test.mjs
```

| Item | Delivered path | Evidence |
| --- | --- | --- |
| A1 whole-token `rat` on the frozen meeting projection | `evaluateMeetingTextQueryWatch` over `site/data/meeting_notice_materialization.json` | Admits `20260803009` ("New Rules Relating to Rat Inspections"). The procurement Strategy title from the award snapshot is a lexical negative, not a meeting row. |
| A2 grouped alternatives, phrases, exclusions on preview, save, email, feed | Following GET, `applyWatchPatch`, `processOneSub`, Atom feed | `rat` or `correction` admits `20260803009` and `20260106034`. Excluding the CART phrase leaves `20260803009`. Phrase `rat inspections` admits only `20260803009`. Predicates run before the page limit; scan-budget exhaustion is `incomplete`. |
| A3 body-only `translation` | field evidence on `20260106034` | Title is "Board of Correction Public Meeting". Preview names the Communication Access Realtime Translation passage. Adding that phrase as an exclusion removes the record without calling it a translation-policy meeting. |
| A4 missing vs failed body; identity | `meetingBodyStatus`, `evaluateMeetingRecords` | Optional missing body is title-only and complete. Failed acquisition is `incomplete` with `body_acquisition_failed`. Event time, location, source URL, and meeting id are preserved. Phrases do not span title and body or use generated summaries. |
| A5 scope and exact identities | compile/admission | Agency and date-window still bound the candidate set. Exact Council-matter plus `text_query` is refused. Legal-provision and award-arrival lenses stay closed. Unsupported families do not offer controls. |
| A6 named tests, journey, capture | this receipt; `docs/evidence/watch-text-query-meeting-controls/capture-manifest.json` | Create–preview–save–edit–feed, failed-load retry, keyboard-labelled controls, and shipping-language strings. Capture is hashed HTML, not an image binary. Query-revision fingerprints equivalent meeting expressions. |
