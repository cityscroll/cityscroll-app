# 005 — Design ground rules: restraint + immediacy

**Status:** accepted · 2026-07-02

## Decision

The interface follows two named references and one text; deviations from them are design bugs,
not taste differences:

- **Exemplars:** [citymeetings.nyc](https://citymeetings.nyc/) (one accent, whitespace over
  boxes, near-zero chrome) and **craigslist** (text dominance, no ornament, nothing loads that
  isn't the content). CROL-List is named after craigslist; it should feel like it.
- **Principles:** Tufte, *The Visual Display of Quantitative Information* — maximize data-ink,
  erase non-data-ink, forgo chartjunk. Applied to UI: **color is a signal, not a decoration.**

The standing rules:

1. One accent (oxblood). Other colors appear only as live signals: deadline urgency, warnings,
   red flags. Facts (amounts, types) render as quiet ink.
2. No decorative pictographs; functional glyphs only (→ ↗ ← ✓ ⚑ ☰). No legends where direct
   labels do the work. No shadows; hairline borders carry the structure.
3. Perceived speed is engineered: nothing parse-blocking that most visits don't use (heavy
   libraries lazy-load), repeat queries render from a read-side cache, list placeholders are
   content-shaped skeletons (spinners only for short actions), refetches update in place rather
   than blanking, and interactions paint what's already in memory before the network answers.

## Trade-offs accepted

- The Land map arrives ~300ms later on the very first use — paid by the few instead of a
  parse-blocking library paid by everyone.
- Cached lens results can be up to 5 minutes stale; the record updates daily, so this is
  invisible in practice.
- Search-as-you-type sends more queries than a Filter button; debounce + cache + request
  coalescing bound it.
