# Precise-watch matching contract — acceptance receipt

Textual proof that the versioned `text_query` (schema `cityscroll.watch_text_query.v1`) preserves exclusions, alternatives, and phrases without changing legacy watches. Grounded at repository revision `036b9fd59cb8ab9a883aff6179d339686ee2dcc4`. Fixture counts describe the retained snapshot, not a live production census.

Evaluated field contract: `site/watch_text_query.mjs` is field-agnostic. Callers supply the per-family projection. These predicate tests use the title-only projection (`short_title`) plus one retained public-hearing title; structured facets such as agency or identifiers are never concatenated into that projection.

Verify:

```
node --test test/watch_text_query.test.mjs worker/test/watch_text_query_validation.test.mjs worker/test/subscriptions.test.mjs
```

| Item | Delivered path | Evidence |
| --- | --- | --- |
| A1 schema and predicate; title-projection ID sets | `site/watch_text_query.mjs` `matchesTextQuery`; `test/watch_text_query.test.mjs` E1–E6 | Award titles containing software: `20260709018`, `20260713010`, `20260713036`, `20260723004`. Excluding maintenance removes `20260723004`. Software or consulting excluding maintenance: `20260709018`, `20260713010`, `20260713024`, `20260713036`. Software and consulting: empty. Phrase construction management: `20260710009`, `20260714009`, `20260715010`, `20260727024`, `20260728022`. Whole-token `rat` over procurement titles: empty. |
| A2 whole-token, phrase, no expansion | `test/watch_text_query.test.mjs` A2 cases | `rat` rejects Strategy and Integrated titles and accepts meeting `20260803009`. Phrases survive HTML and punctuation, never span fields. Literal exclusions do not expand synonyms or plurals. |
| A3 reject invalid input | `validateTextQuery`; `prepareWatchFilter`; `worker/test/watch_text_query_validation.test.mjs` | Unknown version/keys, malformed atoms, empty groups, over-limit input, and required/excluded contradictions are rejected. Negative-only input needs a structured scope such as a selected agency. No silent truncation. |
| A4 persist without loss; reject keyword mix | `prepareWatchFilter`, `encodeWatchFilter`, `applyWatchPatch` | Canonical `text_query` round-trips through JSON. Nonempty legacy keywords plus `text_query` is rejected until conversion emits empty keywords. |
| A5 legacy identity and dispatch | `worker/test/subscriptions.test.mjs`; compiler/feed admission | Absent `text_query` keeps the legacy canonical string. Equivalent v1 expressions share one identity; an intentional change differs. Modern Atom/JSON feeds replay an admitted money expression; ICS still refuses it rather than widening. Money compilers evaluate through the procurement adapter rather than running unfiltered; other lenses still refuse. |
| A6 executable tests and field contract | this receipt; `test/fixtures/watch_text_query/README.md`; module header of `site/watch_text_query.mjs` | Frozen public City Record IDs and titles only. Existing subscription identity regressions in `worker/test/subscriptions.test.mjs` remain. |
