# Past-task feedback guidance — implementation receipt

Card: `cityscroll-engineering/past-task-feedback`

## Orientation

The About page's feedback form invites bugs, feature ideas, and general
thoughts through one 2,000-character message field, with a prompt that mixes
what happened and what the reader would want. It offers no structure that
distinguishes an actual task, its breakdown, and the reader's workaround from
a hypothetical feature request.

## Summary

A collapsed, optional guidance panel now sits beside the existing message
box on the About page's feedback form:

- `site/about.html`: a `<details id="fbpasttask">` — closed by default —
  asks about the last attempted task, where it broke down, and what the
  reader did instead, with an "Optional" label beside it. The reader still
  writes in the single existing `#fbmessage` textarea and submits only via
  the existing Send button; no new field, endpoint, or automatic submission
  was added. The page's inline script is now an ES module that imports
  validation and payload construction from the new shared module below,
  rather than duplicating that logic.
- `site/contextual_ux_feedback_prompt.mjs` (new): the feedback form's
  validation rule (short/long message, malformed email), its exact
  `{category, message, email}` payload shape, and the fixed three-prompt
  guidance content model (task, breakdown, workaround) — all pure, unit
  tested, and structurally identical to the form's prior behavior.
- `site/i18n.js` + `site/i18n/lang/*.js`: the five new guidance strings
  (summary, three prompts, closing note) and the "Optional" badge, in
  English and all ten shipping languages.
- `docs/design-principles-contextual-ux.md`: the "Ask about actual attempts,
  not hypothetical wants" principle this guidance follows.

No new data source, analytics field, browsing-history attachment, or
network call was introduced. Object-level correction reporting and the
general feedback categories (bug/feature/general) are untouched.

## Verification

Unit test (validation, payload shape, the guidance content model, and
structural checks against the real `about.html` — one message field, the
guidance collapsed by default, no wiring on the disclosure itself, and
exactly one network call site inside `sendFeedback()`):

- Command: `node --test test/contextual_ux_feedback_prompt.test.mjs` — 16 pass, 0 fail.

Accessibility + capture evidence (headless Chromium via Playwright, the
repository's established offline capture pattern):

- Command: `python3 tools/capture_past_task_feedback.py`
- Captures (390px and 1440px, `/about.html`, for `collapsed`, `expanded`,
  `edited`, `validation`, and `pre-send`):
  [`docs/evidence/past-task-feedback/capture-manifest.json`](past-task-feedback/capture-manifest.json).
  Screenshots are not committed; the manifest records each capture's route,
  viewport, revision, the state's assertion, a content hash, and the form's
  own read-back state (guidance open/closed, message field count and value,
  validation text, Send disabled).
- Every state ran the vendored axe-core gate (same engine and
  critical/serious classification as `test/functional/11_accessibility.py`):
  10/10 green, no critical or serious violations, no `wcag22aa` findings.
- Every capture asserted `document.documentElement.scrollWidth` does not
  exceed the viewport width: no horizontal overflow at either width in any
  state.
- Every remote host was blocked for the entire run, including the
  `validation` and `pre-send` states — the `/feedback` endpoint is reached
  only by an explicit Send click, which none of these five states perform.

Acceptance mapping: A1 (the guidance can be expanded or skipped, the reader
edits the one message field, and Send stays explicit — asserted in both the
unit test's structural checks and the `expanded`/`edited` captures), A2 (no
new field, endpoint, analytics, or automatic submission — asserted by the
payload-shape test and the zero-network-before-Send captures), A3 (the named
test proves guidance disclosure, the single message field, unchanged
validation/payload/2,000-character limit, and the sole network call site),
A5 (principle documented in `docs/design-principles-contextual-ux.md`). A4
(reviewing actual consenting submissions) is explicitly a post-ship,
participant-evaluation follow-up per the card, not a delivery gate.

## Methodology

Focused checks run on this tree:

```sh
node --test test/contextual_ux_feedback_prompt.test.mjs                     # 16 pass
node --test test/contextual_ux_result_groups.test.mjs                       # unchanged (9 pass, cx-01)
(cd worker && node --test test/feedback.test.mjs test/feedback_desk.test.mjs) # unchanged (33 pass)
python3 test/standards/js_syntax.py                                         # OK
python3 test/standards/i18n_keys.py                                         # OK, full coverage across all 10 shipping languages
python3 test/standards/i18n_refs.py                                         # OK
python3 test/standards/i18n_fallback_sync.py                                # OK
python3 test/standards/i18n_glossary.py                                     # OK
python3 test/standards/stray_english.py                                     # OK
python3 test/standards/es_diacritics.py                                     # OK
python3 test/standards/control_labels.py                                    # OK (summary kept to a concise action phrase; "Optional" moved beside the control)
python3 test/standards/link_text.py                                         # OK
python3 test/standards/outline_guard.py                                     # OK
python3 test/standards/form_border_contrast.py                              # OK
python3 test/standards/page_metadata.py                                     # OK
python3 test/standards/heading_punctuation.py                               # OK
python3 test/standards/genai_disclosure.py                                  # OK
python3 test/standards/public_surface_vocab.py --gate                      # OK
python3 test/standards/no_disclaimer_slop.py                                # OK
python3 test/standards/claim_first_prediction.py                            # OK
node tools/check_public_payload_integrity.mjs                               # OK
node tools/determinism_lint.mjs --check                                     # OK (site inventory regenerated for the new module)
node tools/architecture_evidence_shards.mjs --check                        # OK
node tools/verify_card_profile.mjs --check                                  # OK
python3 tools/capture_past_task_feedback.py                                 # axe 10/10 green, no overflow
```
