# Precise-watch reader controls — acceptance receipt

Textual proof that procurement readers can refine, inspect, and save a precise
watch from Following. Grounded at repository revision
`d4dba5307c4e0d6c5f48411691ced218ddd0f4d4`. Fixture counts describe the retained
award-title snapshot and DDC notice fixture, not a live production census.

Verify:

```
node --test test/watch_text_query_ui.test.mjs worker/test/watch_text_query_preview.test.mjs
```

| Item | Delivered path | Evidence |
| --- | --- | --- |
| A1 E2 then E3 from labelled controls | `textQueryFromControls`, Following GET `tq_*` fields, Worker preview | Software excluding maintenance yields `20260713036`, `20260713010`, `20260709018`. Adding consulting recovers `20260713024`. No JSON copy in the form. |
| A2 simple keyword and unsupported lenses | `watchFilterFromTextQueryControls`, `textQueryControlsHtml` | Keyword-only stays `keywords`. Meetings hide precise controls. Preview GET and cancel save nothing. |
| A3 Greenway exclusion passage | `collectExcludedNoticeRecords` on DDC fixture `20250305016` | Broad `maintenance` names Parks maintenance vehicles. Phrase `maintenance services` restores the record. It is not described as a maintenance-services contract. |
| A4 stale and unavailable preview | `previewGenerationMatches`, Following `previewStatus` | A newer `preview_seq` wins. Unavailable and incomplete states keep entered terms and offer retry/continue. They never render a successful exhaustive zero. |
| A5 same groups in summary, email, feed, return | `composeWatchRuleSentence`, `describeFilter`, feed URLs, prefs patch | Confirmation, Following sentence, and prefs query line name software, consulting, and the maintenance exclusion. Positive excerpts use source fields and original titles. |
| A6 journey, keyboard, languages, capture | named verify targets plus `docs/evidence/watch-text-query-reader-controls/capture-manifest.json` | Create–preview–save–edit–feed–return is asserted in HTML. Strings exist in every shipping UI language. Capture is hashed HTML, not an image binary. |
