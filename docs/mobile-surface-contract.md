# Mobile surface contract

CityScroll uses one responsive interface. New R2 Increment 1 “Now” surfaces and changes to
existing lenses must meet these acceptance bars from their first pull request:

- At a 360px viewport, `document.documentElement.scrollWidth` may exceed `clientWidth` by at
  most one rounding pixel. Wide data tables must scroll inside a labeled container rather
  than widening the document.
- Buttons, form controls, disclosure summaries, phase controls, and action links use at least
  a 44×44px rendered target on phone layouts. Inline prose links are outside this rule.
- Reader actions—subscribe, comment, attend, respond, bid, and calendar handoffs—remain visible,
  named, and operable with touch and keyboard input.
- Information available on hover also has a focus/tap path. Abbreviated phase labels expose
  their full label when focused; provenance remains a real disclosure rather than a hover-only
  tooltip.
- Phase chains become vertical at narrow widths so an arrow cannot be stranded at the end of a
  wrapped row. Chip rails wrap unless horizontal scrolling is itself the content interaction.
- Form text is at least 16px on phone layouts to avoid focus zoom in mobile Safari.
- Evidence capture covers both 360px phone and 1280px desktop widths. The phone run is a gate,
  not only a screenshot.

Run the focused contract with:

```bash
python3 test/functional/23_mobile_viewport.py
```

The required accessibility job runs the same check before the broader 390px and 1440px axe
matrix. This contract is additive to keyboard, language, reading-level, and payload budgets.
