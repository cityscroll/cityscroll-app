# Contextual UX design principles

Status: design-guidance draft; specific interface applications remain hypotheses until evaluated with real tasks. This document collects principles carried forward from contextual-inquiry and lean-validation practice, applied to CityScroll surfaces one card at a time. See also [`docs/design-principles-lens.md`](design-principles-lens.md) for the lens filter template.

## Preserve the full sequence

Trace the task from the initial question through finding, inspecting, acting, and returning. A change that shortens one step — for example, a jump control that moves focus straight to a relevant result group — must account for every other step already in the sequence: it must not issue a new search, change the query, alter the ranking or result set, change any coverage or record-identity state, or rewrite a destination handoff link. The step gets shorter; nothing else in the sequence moves.

Applied first in [`site/search_family_nav.mjs`](../site/search_family_nav.mjs): the result-family jump list above Search's first result group reads each family's already-rendered heading, status, and state and only moves keyboard focus there. It never fetches, never mutates the query, and it labels an empty, loading, unavailable, or error family with that family's own true state rather than inventing a count.

Source: Holtzblatt, Wendell and Wood, *Rapid Contextual Design*, chapter 6, pp.126–129, and chapter 12, p.241.
