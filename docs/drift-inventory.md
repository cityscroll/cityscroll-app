# Site/worker drift inventory

crol-list is a static client (`index.html` and root-level `*.js`) plus a Cloudflare Worker
(`worker/src/`). The two can't share an import across that boundary, so a number of rules —
parsing, honesty filters, matching heuristics, schemas — are implemented independently on both
sides "by hand." That's a recurring bug class: a change lands on one side and the other is
never updated. Commit `3ff6825` is a recent example (`worker/src/lib/digest.mjs`'s
`matchEvidence()` sliced raw, un-stripped City Record HTML that `index.html`'s copy had already
learned to clean).

This document is the **contract surface**: every place the two sides implement the same rule.
Each entry says whether it's covered by an automated cross-check today. New dual-implemented
logic should get an entry here (and, where testable, a test under `test/contract/`) in the same
change that introduces it.

**Legend** — Status: `tested` (an automated test compares both sides directly), `untested`
(nothing cross-checks them yet), `one-way` (only one side implements this; not true
duplication). Testability: `deterministic` (same input always yields the same output — a
fixture test can pin it) or `judgment` (requires human/LLM judgment — not a fixture-test
candidate; this is what the LLM drift-synthesis CI job is for).

## Confirmed drift found and fixed by this pass

| # | Rule | Site | Worker | What was wrong |
|---|------|------|--------|----------------|
| 1 | Money-lens "honesty cap": Award notices ≥ $10B are excluded as data-entry errors (EDA: 3 rows ≥ $10B are errors, max legit ≈ $6.68B) | `index.html` (10 query-building call sites) | `worker/src/lib/compile.mjs:65`, `worker/src/alerts.mjs:394`, `worker/src/ingest.mjs:15` (`AMOUNT_CAP = 1e10`) | 9 of `index.html`'s 10 call sites still had the **old** $5,000,000,000 cap (lines 997, 1475, 3054, 3334, 3381, 3418, 3643, 3766, 3781) — only the newest call site (line 3070, added alongside the worker's own $10B move) had been updated. Real, legitimate contracts between $5B and $10B were silently excluded from Money-lens search, agency/vendor profiles, and stats aggregates. Fixed in this change; `test/contract/money_honesty_cap.test.mjs` now pins the constant everywhere it appears. |

## Tested (an automated cross-check already exists)

| # | Rule | Site | Worker | Test |
|---|------|------|--------|------|
| 2 | City Record HTML must be stripped before match-evidence snipping | `index.html:3120` `matchEvidence()` (expects pre-cleaned input — every real call site runs `cleanText()`/`matchText()` first) | `worker/src/lib/digest.mjs:103` `matchEvidence()` (self-strips raw HTML defensively) | `test/contract/match_evidence_html.test.mjs` (new) — one shared fixture set run through both, asserting no tags leak into either side's snippet. Two more independent, hand-duplicated single-side fixture tests also cover pieces of this: `test/match_evidence.test.mjs`, `worker/test/digest_match_evidence_render.test.mjs`. |
| 5 | `vendorStem()` — vendor-name identity (case/punctuation/legal-suffix normalization) so a watch on "Sinergia Inc" also matches "Sinergia Incorporated" | `index.html:3566` | `worker/src/lib/compile.mjs:35` | `test/contract/vendor_stem.test.mjs` (new) |
| 6 | Prior-cycle strict matcher — same-agency, prior-dated, ≥180-day gap, ≥0.5 title-word overlap, one row per PIN, max 3 | `index.html:1266` `rankPriorCycleCandidates()` (+ `priorCycleTitleWords()`, `daysBetween()`) | `worker/src/lib/prior_cycle.mjs:47` (explicitly hand-synced, per its own header: "the client's index.html functions stay the SOURCE OF TRUTH; this port must not diverge") | `test/contract/prior_cycle.test.mjs` (new) |
| 7 | Near-match looser tier — 0.34–0.5 title overlap + PIN-prefix or amount corroboration | `index.html:1405` `rankNearMatchCandidates()` (+ `pinPrefixShared()`, `nearMatchReasons()`) | `worker/src/lib/prior_cycle.mjs:125` | `test/contract/prior_cycle.test.mjs` (new) |
| 8 | PIN-chain honesty: `usablePin()` (junk-PIN detection), `pinBase()` (renewal-suffix stripping), `isBlanketChain()` (>5 same-cycle Award rows reads as a blanket code, not a rebid history) | `index.html:849`, `index.html:1214`, `index.html:1749` | `worker/src/lib/lineage.mjs:18,30,39` | `test/contract/pin_lineage.test.mjs` (new) |
| 9 | External-award-source registry (which authorities' awards come from which ABO/Checkbook dataset) | `external_awards.js:19-127` (standalone ES module) | `worker/src/lib/external_award.mjs:10-127` | `test/external_awards_registry.test.mjs` (pre-existing) |
| 11 | Lens → filter-field schema (`LENSES`/`clampField`/`sanitize`) — which fields each of the 7 lenses accepts, and how each is clamped/validated | `index.html:4178` `DEEPLINK_LENSES`/`deeplinkClampField`/`sanitizeDeepLinkFilter` (explicitly commented as a hand-synced port) | `worker/src/lib/filter.mjs:19-99` `LENSES`/`clampField`/`sanitize` | `test/deeplink_watch.test.mjs` (pre-existing) |
| 12 | Suggestion-chip static fallback set (which pre-vetted example queries show per lens when the worker's daily-validated `/suggestions` is unreachable) | `index.html:2189` `NL_SUGGESTIONS_FALLBACK` | `worker/src/lib/suggestions.mjs:61` `FALLBACK_INDICES` (+ `SUGGESTION_POOL`) | `test/contract/suggestion_fallback.test.mjs` (new — the inventory pass flagged this as the one schema-parity pair with no existing cross-check, unlike #9/#11). `people` is a documented one-way exception: the worker has no people candidate pool at all. |
| 17 | `?w=` deep-link param length ceiling (2000 chars) | `index.html:4225` | `worker/src/lib/stats.mjs:50-52` | Not yet a dedicated contract test — both values read identically today; flagged for a fast-follow if this constant ever needs to change. |

## Untested — one-way gap, flagged for a product decision (not fixed by this pass)

| # | Rule | Site | Worker | Gap |
|---|------|------|--------|-----|
| 3 | Year-2090 rolling-deadline exclusion: a due date ≥ year 2090 is a rolling placeholder, not a real deadline, and must be labeled honestly rather than treated as a countdown | `index.html` has **no equivalent at all** — `deadlineTag()`/`daysLeft()` (lines 884, 881) do raw date arithmetic with no year check | `worker/src/alerts.mjs:377-383` `dueLabel()`, `worker/src/ingest.mjs:14` (`ROLLING_YEAR = 2090`), `worker/src/lib/notices.mjs`, `worker/src/mcp.mjs:42` | A live Solicitation with a 2090 placeholder due date renders on the public site as something like "23,000+ days left" instead of the worker's honest "no fixed deadline (rolling)" label. Not fixed here: unlike the $10B cap (a pure internal constant), this needs new user-facing copy and i18n keys across every shipped language — a product/UX call on exact wording, not a mechanical parity fix. Left as a flagged, documented gap for a follow-up decision. |

## Not true duplication (one implementation only, or intentionally divergent)

| # | Rule | Note |
|---|------|------|
| — | Forecast/expiration calculation (Checkbook award-duration → projected expiration) | Worker-only (`worker/src/lib/forecast_score.mjs`, `worker/src/checkbook.mjs`); the client only renders the worker's fetched JSON. |
| — | NL (plain-English) parsing | `nl_parse.js` (client, regex/dictionary heuristic) and `worker/src/nl.mjs` (server, Claude Haiku tool-call) are **intentionally different algorithms** converging on one shared output schema (`LENSES`, already covered by #11) — not hand-copied logic. |
| — | i18n | `i18n.js` (UI strings) and `worker/src/lib/i18n.mjs` (email strings) are separate glossaries by design; only the narrow `digest_match_snippet`/`digest_match_unknown` key pair overlaps in meaning. |
| — | Feed generation | `worker/src/lib/feed.mjs` reuses the worker's own `sanitize()`/`compileSub()` rather than reimplementing `index.html` logic. Row-summary formatting (`feedItems()` vs. `landRowHTML()`/`feedCardHTML()`) is a loose, unconfirmed parallel — flagged below as needing a deeper look. |
| — | `search_health.mjs` | Pure server-side digest-cadence bookkeeping (`QUIET_THRESHOLD_DAYS`, `nextSearchHealth()`); nothing for the client to mirror. |

## Needs deeper look (flagged by the inventory pass, not yet fully verified)

These are candidates for a future pass, not confirmed bugs — listed here so they aren't lost:

1. **Currency-formatting proliferation.** The worker has 4 separate non-abbreviating `usd()`
   closures (`worker/src/alerts.mjs:307`, `alerts.mjs:585`, `worker/src/lib/feed.mjs:10`,
   `worker/src/lib/confirm_email.mjs:15`), each with a slightly different null/zero guard, none
   tested against each other or against the site's abbreviating `money()` (`index.html:871`,
   which is a deliberately different, abbreviating format for on-page density — not meant to
   match byte-for-byte). Worth confirming the 4 worker closures haven't silently diverged from
   *each other*.
2. **`worker/src/lib/feed.mjs`'s `feedItems()`** vs. `index.html`'s `landRowHTML()`/
   `feedCardHTML()` — bodies not fully diffed; there may be a tighter field-inclusion rule
   worth its own contract test.
3. **`worker/src/mcp.mjs`'s `previewText()`/`fmtRecord()`** currency formatting — likely a 5th
   `usd()`-style variant, not compared against the other 4.
4. **Vendor/agency permalink slug construction.** `index.html`'s `agencyHref()`/`vendorHref()`
   (`index.html:3561-3562`) run `cleanText()` before encoding; `worker/src/batch.mjs:66` encodes
   the raw name with no cleaning step. Currently benign — resolution re-derives via
   `vendorStem()` rather than string-comparing the raw slug — but fragile if a future call site
   starts comparing slugs directly.

## The floor vs. the remainder

- **Deterministic pairs** (this document's "Tested" table) are the floor: `test/contract/`
  fixture tests, wired into the existing required "Unit tests (site + worker)" CI job
  (`.github/workflows/ci.yml`) — a drifting change fails the build on every PR, same as any
  other unit test failure.
- **Judgment-shaped pairs** (anything needing product/UX judgment, like #3's rolling-deadline
  label, or the "needs deeper look" items above) are covered by an informational LLM
  drift-synthesis check (`.github/workflows/drift-synthesis.yml`) that reads this document and
  flags likely cross-implementation drift on PRs touching either side. It posts one comment; it
  does not block merge.

## Promotion path (documented, not enacted)

`drift-synthesis.yml` runs informational-only today — it is not in `main`'s required-status-check
ruleset, so it cannot block a PR. Whether and when to promote it to a required check is a
deliberate, separate decision, not something this change makes on its own. The path, if that
decision is made later:

1. **Let it run on real PRs first.** Informational-only for some number of real PRs (author,
   not a fixed count — the point is real signal, not a calendar date) to establish a
   false-positive rate before anyone treats its output as gating.
2. **Promote once the false-positive rate is proven low**, the same "required status check"
   mechanism already used for the 4 existing required jobs
   (`gh-axi api repos/cityscroll/crol-list/rulesets/18899568`) — add its check name to that
   ruleset. No new mechanism needed, just adding an entry to what already exists.
3. **Widening beyond same-repo PRs** (today's workflow skips forks — see its header) is its own
   later decision if drift review should also run for external contributors, weighed against the
   action's own documented `allowed_non_write_users` risk trade-offs.

Both the promotion threshold and the fork-widening question are captain/maintainer calls, not
scout or automation judgment — intentionally left open here rather than guessed at.

## Setup still needed

`drift-synthesis.yml` needs two things this repo doesn't have yet, confirmed by running it on this
PR (informational-only, so neither blocks a merge in the meantime):

1. An `ANTHROPIC_API_KEY` repository secret (Settings → Secrets and variables → Actions) — only
   `CLOUDFLARE_API_TOKEN` exists today.
2. The Claude Code GitHub App installed on this repository (https://github.com/apps/claude) —
   the action's own error confirms it needs this in addition to the API key.

Until both are in place, the workflow runs and fails cleanly on every same-repo PR touching
site/worker code.
