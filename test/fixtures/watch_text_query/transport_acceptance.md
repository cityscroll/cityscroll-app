# Precise-watch transports — acceptance receipt

Textual proof that a saved precise watch keeps its alternatives, phrases, and
exclusions when it is copied as a feed, reopened from a notice link, or handed
to an existing subscription, preview, or machine entry point. Grounded at
repository revision `9e3e112cd5d0652db5e33c1f1cb4217ed15658aa`. Fixture counts
describe the retained snapshot, not a live production census.

Evaluated field contract: notice-backed and snapshot-backed procurement rows
share one admitted field projection and one v1 predicate. Feeds describe
current matching content; email applies unseen, paused, and cadence rules;
calendars require a civic event date. Those channel rules are compared after
membership, never instead of it.

Verify:

```
node --test test/watch_text_query_transport.test.mjs worker/test/watch_text_query_feed.test.mjs worker/test/feed.test.mjs
```

| Item | Delivered path | Evidence |
| --- | --- | --- |
| A1 round-trip E3 and a two-required-group phrase | `subscriptionParamsFromWatch`, `encodeWatchFilter`, Following reload, prefs `applyWatchPatch`, route hash | Canonical expression and agency/amount/category/geography/time facets survive. SearchIntent carries the structured expression and does not collapse it into `text`. |
| A2 Atom/JSON membership on the frozen award-title projection | `evaluateMoneyTextQueryWatch` then `atomFeed`/`jsonFeed` and `handleFeed` | E3 identities: `20260709018`, `20260713010`, `20260713024`, `20260713036`. Titles escaped. Item URLs are `/notices/{request_id}`. Legacy `q=` URLs still parse as keyword watches. |
| A3 reject before widening | `prepareWatchFilter` in `handleFeed`; `calendarFeedUrlForScope` | Malformed JSON, unsupported version, over-limit atoms, and unsupported lenses return 400. ICS is omitted rather than generated as a broader calendar. |
| A4 NL and MCP entry points | `/nl` structured `filter` body; existing `preview_watch` / `create_watch` | Accepted exclusions and alternatives survive normalization without a model call. Unsupported rich input returns a correction path. No new tool or access grant. |
| A5 membership vs delivery | feed serializers vs `digestDecision` vs `icsFeed` | A previously delivered matching record remains in the feed. Email unseen/paused/cadence and calendar-event eligibility are separate assertions. |
| A6 handlers, Unicode, unknown keys, no publisher fetch | named verify targets | Resident feed reads use owned materialization only. |

