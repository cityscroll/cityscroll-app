# 002 — CalVer + a public changelog with incidents

**Status:** accepted · 2026-07-02

## Decision

The project keeps a public, plain-language changelog (`changelog.html`) as a first-class page.
Versions are dates (CalVer, `2026.07.02`), not SemVer. Incidents — real bugs and outages — get
entries alongside features. Every shipped change lands its changelog entry in the same session
(working-agreement rule 3).

## Why

- A tool that watches the city's public record should keep a public record of itself: inspectable
  change history is the same accountability standard we ask of government systems.
- The site ships continuously with no API-compatibility contract for the UI, so SemVer would be
  theater; a date says exactly what a reader wants to know ("is this maintained?").
- Publishing incidents builds more trust than hiding them, and we've never had an incident that
  wasn't more flattering as a caught-it story than as a secret.

## Consequences

- The changelog doubles as outreach material (team posts, newsletter submissions) and as the
  "this is real, maintained software" evidence for institutional conversations.
- Skipping an entry is a process violation, findable in review.
