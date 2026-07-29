# CityScroll brand system

CityScroll makes the city's public record legible. Its identity should therefore feel like public
infrastructure: recognizable, calm, evidence-led, and useful before it is expressive.

## Mark

The chosen **Civic Folio** combines a folded public record with a final line that becomes a city
skyline. It remains recognizable in one color and at favicon size, while the adjacent live-text
wordmark preserves crisp, selectable type in the interface.

| Candidate | Concept | Decision |
| --- | --- | --- |
| ![Civic Folio](../assets/brand/candidates/civic-folio.svg) | A public record becomes the city it describes. | **Chosen:** direct, compact, and legible at small sizes. |
| ![Open Ledger](../assets/brand/candidates/open-ledger.svg) | An open ledger creates a street-like center line. | Strong public-record signal, but reads as publishing or education first. |
| ![Record Route](../assets/brand/candidates/record-route.svg) | A continuous scroll moves through city blocks. | Strong motion, but less authoritative and less legible at favicon size. |

The source SVGs use a `viewBox`, a small set of authored paths, and `currentColor`. Standalone marks
include a short `<title>` and useful `<desc>`; decorative instances beside the live wordmark are
hidden from assistive technology to avoid duplicate names. Light-on-dark variants are included for
fixed media. The favicon changes with the browser color scheme, and the touch, 192 px, 512 px, and
social-card PNGs are generated from the same vector source.

## Theme

The theme uses role-based CSS custom properties, with a civic navy for identity and wayfinding, a
brick red reserved for actions, and warm record paper as the reading surface. Typography keeps the
existing editorial link to *The City Record*: Playfair Display for the identity and display
headings, Spectral for reading, and the system sans stack for controls. Shared spacing tokens keep
the identity consistent without turning the site into a promotional landing page.

## Research basis

- [W3C image accessibility guidance](https://www.w3.org/WAI/tutorials/images/tips/) recommends
  text alternatives for meaningful inline SVG and connecting a title to the graphic's accessible
  name. [MDN's SVG title reference](https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Element/title)
  also recommends visible text as the accessible name when it already exists.
- [MDN documents `currentColor` in SVG](https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Attribute/color),
  which makes a single monochrome source adaptable across themes.
- [Apple's web clip guidance](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/ConfiguringWebApplications/ConfiguringWebApplications.html)
  calls for a dedicated PNG touch icon; the web manifest adds browser install icons from the same
  source.
- [USWDS design-token guidance](https://designsystem.digital.gov/design-tokens/) treats color,
  spacing, typography, and measure as a limited, reusable system instead of one-off values.
- The [NYC Digital Design System brand principles](https://designsystem.nyc.gov/brand/index.html)
  prioritize experiences that are easy, trustworthy, and recognizably civic. Its
  [brand-architecture guidance](https://designsystem.nyc.gov/brand/brand-architecture.html) also
  frames consistent identity as digital wayfinding.
- [GOV.UK's brand guidance](https://brand.design-system.service.gov.uk/introduction/) places the web
  at the informative end of its expression range. CityScroll follows that restrained register:
  the record and the task remain visually primary.

These references are principles, not claims of government affiliation. CityScroll remains an
unofficial, independent interface to public data.
