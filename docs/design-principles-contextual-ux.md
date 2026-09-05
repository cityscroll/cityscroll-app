# Contextual UX design principles

Status: design-guidance draft; specific interface applications remain hypotheses until evaluated with real tasks. This document collects principles carried forward from contextual-inquiry and lean-validation practice, applied to CityScroll surfaces one card at a time. See also [`docs/design-principles-lens.md`](design-principles-lens.md) for the lens filter template.

## Preserve the full sequence

Trace the task from the initial question through finding, inspecting, acting, and returning. A change that shortens one step — for example, a jump control that moves focus straight to a relevant result group — must account for every other step already in the sequence: it must not issue a new search, change the query, alter the ranking or result set, change any coverage or record-identity state, or rewrite a destination handoff link. The step gets shorter; nothing else in the sequence moves.

Applied first in [`site/search_family_nav.mjs`](../site/search_family_nav.mjs): the result-family jump list above Search's first result group reads each family's already-rendered heading, status, and state and only moves keyboard focus there. It never fetches, never mutates the query, and it labels an empty, loading, unavailable, or error family with that family's own true state rather than inventing a count.

Source: Holtzblatt, Wendell and Wood, *Rapid Contextual Design*, chapter 6, pp.126–129, and chapter 12, p.241.

## Design for the artifact's purpose

Ask what a collection, export, or brief enables, and who uses it next, before asking which controls should surround it. An empty collection should be guided toward its first useful input rather than surrounded by the same output actions a populated collection earns once there is something for them to act on. Do not assume every reader wants a brief, an export, or a dashboard as that first artifact — that is an interface hypothesis, not a settled preference, until it is checked against a reader's own task.

Applied first in [`site/app/workspace.mjs`](../site/app/workspace.mjs)'s My investigation workspace: an empty collection previously showed share, freeze-research-package, export-.csv, export-.json, print, and clear-all controls with nothing yet for them to act on. It now explains the find -> open -> pin sequence and links directly to search, replacing those six controls until at least one item is pinned. Every populated-collection control, note, item type, and privacy behavior is unchanged, and deleting the last pinned item restores the same guidance. Whether a reader actually wants a brief-oriented first artifact, rather than another kind of collection, remains unvalidated; see the disconfirmation condition on `cityscroll-contextual-ux/cx-02-empty-investigation-first-artifact`.

Source: Rob Fitzpatrick, *The Mom Test*, chapter 2, the Excel example; *Rapid Contextual Design*, chapter 6, p.134.

## Ask about actual attempts, not hypothetical wants

Favor a concrete work episode over a feature poll: what the reader actually tried, where it broke down, and what they did instead, rather than what they say they would want. Offer this as optional, collapsed guidance beside an existing feedback field — never as a mandatory step, a new required field, or a separate submission path. The reader keeps one editable message field and one explicit send action; guidance only helps them write, it never writes or submits for them.

A self-report stays a self-report. Structuring the prompt this way does not turn a written account into observed behavior, and it does not establish that a breakdown is common, only that this one reader experienced it. Treat the resulting messages as evidence to review for specific, actionable episodes — not as a count of how many people share the same problem, and not as proof the mechanism worked until reviewed against real submissions.

Applied first in [`site/about.html`](../site/about.html)'s feedback form: a collapsed `<details>` beside the message box asks about the last attempted task, where it broke down, and the workaround used, backed by [`site/contextual_ux_feedback_prompt.mjs`](../site/contextual_ux_feedback_prompt.mjs), which keeps the existing validation rules, the existing 2,000-character limit, and the existing `{category, message, email}` payload shape unchanged.

Source: Rob Fitzpatrick, *The Mom Test*, chapter 1 and chapter 8; *Rapid Contextual Design*, chapter 4, p.90.
