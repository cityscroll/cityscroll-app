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
candidate; see "The floor vs. the remainder" below for how judgment-shaped drift is covered).

## Confirmed drift found and fixed by this pass

| # | Rule | Site | Worker | What was wrong |
|---|------|------|--------|----------------|
| 1 | Money-lens "honesty cap": Award notices ≥ $10B are excluded as data-entry errors (EDA: 3 rows ≥ $10B are errors, max legit ≈ $6.68B, the NYPA electricity contract about.html cites by name) | `index.html`'s `MONEY_HONESTY_CAP` constant, referenced by every query-building call site | `worker/src/lib/compile.mjs:65`, `worker/src/alerts.mjs:394`, `worker/src/ingest.mjs:15` (`AMOUNT_CAP = 1e10`) | 9 of `index.html`'s query-building call sites still had the **old** $5,000,000,000 cap — only the newest call site (added alongside the worker's own $10B move) had been updated. Real, legitimate contracts between $5B and $10B were silently excluded from Money-lens search, agency/vendor profiles, and stats aggregates. **A second copy of the same stale threshold, in a different lexical form (`X >= 5e9`, a plain numeric guard in `awardContext()`), was missed by the first pass entirely** — a regex matching only the SODA query-string form never caught a bare scientific-notation comparison; found by running the layer-2 drift check (below) against this PR's own diff. Both are fixed; the 10+ literal copies are now one named `MONEY_HONESTY_CAP` constant, and `test/contract/money_honesty_cap.test.mjs` pins it everywhere it appears (including no stale literal in any form) so this class of drift can't recur silently. |
| 3 | Year-2090 rolling-deadline exclusion: a due date ≥ year 2090 is a rolling placeholder (pre-qualified-list entries), not a real deadline, and must be labeled honestly rather than treated as a countdown | `index.html`'s `isRollingDeadline()` (mirrors every due-date rendering site: `deadlineTag()`, the notice-detail "how to respond" panel, the calendar-reminder button, CSV export, the vendor/agency profile timeline, mailto letter-of-intent body) | `worker/src/alerts.mjs:377-383` `dueLabel()`, `worker/src/ingest.mjs:14` (`ROLLING_YEAR = 2090`), `worker/src/lib/notices.mjs`, `worker/src/mcp.mjs:42` | `index.html` had **no equivalent at all** — a live Solicitation with a 2090 placeholder due date rendered on the public site as something like "23,000+ days left" instead of the worker's honest "no fixed deadline (rolling)" label (the exact phrase about.html's own "data, to be honest" section already promised readers they'd see). Fixed: every due-date rendering site now checks `isRollingDeadline()` first and shows the same honest label — including suppressing the "add to calendar" button and the raw fake date in CSV export, since there's no real date to schedule or export. `test/contract/rolling_deadline.test.mjs` cross-checks the site's boundary logic against the worker's `dueLabel()`, and pins the exact wording byte-identical across both. |
| 19 | Copy-vs-code: about.html's "The data, to be honest" section explains the $10B honesty cap in prose, citing a real example (the ~$6.68B NYPA electricity contract) — that explanation must state the same number the code actually enforces, not just agree with itself | `about.html`'s static fallback text + `i18n.js`'s `about_li_honest_html` (English runtime string) | N/A — this is a site-internal copy-vs-code pair, not a site/worker pair | A third drift surface, distinct from site-vs-worker: published prose explaining a rule can drift from the rule itself. Already consistent today (both state "$10 billion", matching `MONEY_HONESTY_CAP`) — the live example itself proves which value is correct: a legitimate $6.68B contract only clears a $10B bar, not a $5B one, independently confirming the same value the git-history trace of the original threshold's provenance found. `test/contract/money_honesty_cap.test.mjs` now also asserts the rendered sentence states the current constant's value and doesn't regress to the old $5B wording. True per-language numeral interpolation (so a future threshold change updates all 10 translated sentences automatically, not just English) is a larger follow-up, not done here — the machine-drafted translations would need a native reviewer's eyes on any inserted placeholder, a bigger and different job than pinning the current, unlikely-to-change value. |

## Tested (an automated cross-check already exists)

| # | Rule | Site | Worker | Test |
|---|------|------|--------|------|
| 2 | City Record HTML must be stripped before match-evidence snipping | `index.html:3120` `matchEvidence()` (expects pre-cleaned input — every real call site runs `cleanText()`/`matchText()` first) | `worker/src/lib/digest.mjs:103` `matchEvidence()` (self-strips raw HTML defensively) | `test/contract/match_evidence_html.test.mjs` (new) — one shared fixture set run through both, asserting no tags leak into either side's snippet. Two more independent, hand-duplicated single-side fixture tests also cover pieces of this: `test/match_evidence.test.mjs`, `worker/test/digest_match_evidence_render.test.mjs`. |
| 5 | `vendorStem()` — vendor-name identity (case/punctuation/legal-suffix normalization) so a watch on "Sinergia Inc" also matches "Sinergia Incorporated" | `index.html`'s `vendorStem()` (profile routing and live fallback) | `worker/src/lib/normalize.mjs`'s `vendorStem()` (re-exported from `compile.mjs` for watch replay and the daily vendor-profile projection) | `test/contract/vendor_stem.test.mjs`, `worker/test/vendor_stem.test.mjs`, `worker/test/normalize_fixtures.test.mjs` |
| 6 | Prior-cycle strict matcher — same-agency, prior-dated, ≥180-day gap, ≥0.5 title-word overlap, one row per PIN, max 3 | `index.html:1266` `rankPriorCycleCandidates()` (+ `priorCycleTitleWords()`, `daysBetween()`) | `worker/src/lib/prior_cycle.mjs:47` (explicitly hand-synced, per its own header: "the client's index.html functions stay the SOURCE OF TRUTH; this port must not diverge") | `test/contract/prior_cycle.test.mjs` (new) |
| 7 | Near-match looser tier — 0.34–0.5 title overlap + PIN-prefix or amount corroboration | `index.html:1405` `rankNearMatchCandidates()` (+ `pinPrefixShared()`, `nearMatchReasons()`) | `worker/src/lib/prior_cycle.mjs:125` | `test/contract/prior_cycle.test.mjs` (new) |
| 8 | PIN-chain honesty: `usablePin()` (junk-PIN detection), `pinBase()` (renewal-suffix stripping), `isBlanketChain()` (>5 same-cycle Award rows reads as a blanket code, not a rebid history) | `index.html:849`, `index.html:1214`, `index.html:1749` | `worker/src/lib/lineage.mjs:18,30,39` | `test/contract/pin_lineage.test.mjs` (new) |
| 9 | External-award-source registry (which authorities' awards come from which ABO/Checkbook dataset) | `external_awards.js:19-127` (standalone ES module) | `worker/src/lib/external_award.mjs:10-127` | `test/external_awards_registry.test.mjs` (pre-existing) |
| 11 | Lens → filter-field schema (`LENSES`/`clampField`/`sanitize`) — which fields each of the 7 lenses accepts, and how each is clamped/validated | `index.html:4178` `DEEPLINK_LENSES`/`deeplinkClampField`/`sanitizeDeepLinkFilter` (explicitly commented as a hand-synced port) | `worker/src/lib/filter.mjs:19-99` `LENSES`/`clampField`/`sanitize` | `test/deeplink_watch.test.mjs` (pre-existing) |
| 12 | Suggestion-chip static fallback set (which live-validated example queries show per lens when the worker's daily `/suggestions` result is unreachable) | `index.html` `NL_SUGGESTIONS_FALLBACK` | `worker/src/lib/suggestions.mjs` `FALLBACK_INDICES` (+ `SUGGESTION_POOL`) | `tools/validate_presets.mjs` generates both copies from `data/preset-validation.json`; `test/contract/suggestion_fallback.test.mjs` checks their exact parity. |
| 17 | `?w=` deep-link param length ceiling (2000 chars) | `index.html:4225` | `worker/src/lib/stats.mjs:50-52` | Not yet a dedicated contract test — both values read identically today; flagged for a fast-follow if this constant ever needs to change. |
| 20 | Hearing normalization: affected geography, venue mode/address, participation details, audience clues, and citywide/unlocated classification | `hearing_location.js` (static-site fallback) | `worker/src/lib/hearings.mjs` (daily materialized view and alert matching) | `test/contract/hearing_location.test.mjs` runs shared City Record fixtures through both copies and separately proves that a Manhattan venue does not turn a Queens matter into a Manhattan match. |
| 21 | Full-dollar currency variants, feed field inclusion, and current permalink forms (including `?lang=` before the hash) | `site/app/core.mjs` `money()` intentionally abbreviates; entity routes clean source text; shared URL owners add the language query | Worker digest/feed/confirmation closures, MCP output, feed serializers, and batch vendor links | `test/contract/deterministic_variants.test.mjs` runs the named fixture matrix in `test/fixtures/deterministic-drift/contracts.json`. Valid positive amounts agree across five current worker closures and MCP; on-page abbreviation and feed/card density remain intentional differences. |

## Not true duplication (one implementation only, or intentionally divergent)

| # | Rule | Note |
|---|------|------|
| — | Forecast/expiration calculation (Checkbook award-duration → projected expiration) | Worker-only (`worker/src/lib/forecast_score.mjs`, `worker/src/checkbook.mjs`); the client only renders the worker's fetched JSON. |
| — | NL (plain-English) parsing | `nl_parse.js` (client, regex/dictionary heuristic) and `worker/src/nl.mjs` (server, Claude Haiku tool-call) are **intentionally different algorithms** converging on one shared output schema (`LENSES`, already covered by #11) — not hand-copied logic. |
| — | i18n | `i18n.js` (UI strings) and `worker/src/lib/i18n.mjs` (email strings) are separate glossaries by design; only the narrow `digest_match_snippet`/`digest_match_unknown` key pair overlaps in meaning. |
| — | Feed generation | `worker/src/lib/feed.mjs` reuses the worker's own `sanitize()`/`compileSub()` rather than reimplementing `index.html` logic. Row-summary formatting (`feedItems()` vs. `landRowHTML()`/`feedCardHTML()`) is a loose, unconfirmed parallel — flagged below as needing a deeper look. |
| — | `search_health.mjs` | Pure server-side digest-cadence bookkeeping (`QUIET_THRESHOLD_DAYS`, `nextSearchHealth()`); nothing for the client to mirror. |

## Characterized deterministic variants

The focused fixture pass found one permalink defect and no currency or feed/card defect:

1. **Currency.** Five worker `usd()` closures currently produce identical full-dollar output for
   valid positive contract amounts, and MCP preview/record output agrees. Null/zero guards remain
   surface-owned because upstream validity and conditional-field rules differ. The site's
   `money()` remains deliberately abbreviated for on-page density; the fixture records both forms.
2. **Feed/card fields.** `feedItems()` intentionally carries a portable text summary (agency,
   full dollars, vendor, due/event dates, and a usable address). `landRowHTML()` and
   `feedCardHTML()` instead carry lens-specific interactive context. Existing card tests retain
   ownership of those richer shapes; the deterministic fixture pins the neutral item and Atom,
   JSON Feed, and calendar outputs without inventing byte parity.
3. **Permalinks.** Batch vendor links did diverge for tagged or entity-encoded names because the
   worker encoded raw input. Batch now uses the same plain-text cleaning contract as site vendor
   and agency routes. The fixture pins notice/vendor/agency hashes and their `?lang=es` absolute
   forms. Existing language/share tests remain the owners for picker precedence and copy/QR wiring.

## The floor vs. the remainder

- **Deterministic pairs** (this document's "Tested" table) are the floor: `test/contract/`
  fixture tests, wired into the existing required "Unit tests (site + worker)" CI job
  (`.github/workflows/ci.yml`) — a drifting change fails the build on every PR, same as any
  other unit test failure.
- **Judgment-shaped pairs** (anything needing product/UX judgment — see the "needs deeper look"
  items below) are covered by a second, informational layer — see "Layer 2: local drift-synthesis
  runner" below.

## Layer 2: local drift-synthesis runner (pending design, not automatically invoked)

`tools/drift_synthesis.mjs` reads this document and a PR's diff, asks Claude Code to review the
diff for cross-implementation drift the fixture tests above can't catch, and posts one comment on
the PR. Usage:

```
node tools/drift_synthesis.mjs --pr <number> [--repo owner/name] [--dry-run]
```

This intentionally does **not** run as a GitHub Actions workflow: it needs no repository secret
and no GitHub App installed on this repo. It runs wherever an operator already has `gh` and the
Claude Code CLI (`claude`) authenticated — the same trust boundary as running `gh pr comment` by
hand — and is meant to be invoked once per PR that touches site/worker code, by whatever an
operator already uses to notice new PRs. Proven against a real PR while building it: running it
against this PR's own diff caught the `awardContext()` gap in row #1 above that the first
fixture-test pass had missed.

**What's pending:** wiring an actual per-PR trigger for this script. The script itself and its
prompt are complete and working; deciding what invokes it automatically (and whether its output
should ever be promoted toward a required, blocking check, the same way a deterministic
`test/contract/` failure already is) is a separate, later decision — not something this change
makes on its own.
