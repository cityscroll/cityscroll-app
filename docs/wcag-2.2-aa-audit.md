# WCAG 2.2 Level AA delta audit

Audit date: 2026-07-27

Scope: the seven public pages, every home-page tab, and the tested dynamic states at
390 × 844 and 1440 × 900 CSS pixels. This is a focused review of the Level A and AA
success criteria added between WCAG 2.1 and WCAG 2.2, not a certification.

Normative reference: [Web Content Accessibility Guidelines (WCAG) 2.2](https://www.w3.org/TR/WCAG22/).
W3C lists six new Level A/AA criteria: 2.4.11, 2.5.7, 2.5.8, 3.2.6, 3.3.7, and
3.3.8. The other three new criteria are Level AAA.

| Success criterion | Status | Evidence |
| --- | --- | --- |
| 2.4.11 Focus Not Obscured (Minimum) | Applicable — passing | Keyboard focus was walked at both review widths. The site has no author-created fixed or sticky layer, and focused controls remained exposed. The focus walk remains part of CI. |
| 2.5.7 Dragging Movements | Applicable — fixed | Leaflet's drag-to-pan map had no single-pointer alternative. Four 32 × 32 pixel directional buttons now call the same pan operation without dragging. Leaflet's click zoom controls remain available. |
| 2.5.8 Target Size (Minimum) | Applicable — passing | The WCAG 2.2 `target-size` rule passes at both review widths across public pages and activated home-page states. Small inline text links use the criterion's inline exception; compact standalone controls meet the 24 CSS pixel floor or its spacing exception. |
| 3.2.6 Consistent Help | Applicable — passing | The repeated direct link to the About page, which contains the human feedback mechanism, stays in the footer navigation in the same relative order. No chat or automated-contact mechanism is repeated across pages. |
| 3.3.7 Redundant Entry | Applicable — passing | The alert quiz and advanced builder are two views of one draft. They share the same watch, filter, frequency, and single `#adest` email field, so subscription does not ask for entered information again. |
| 3.3.8 Accessible Authentication (Minimum) | Not applicable | Searching, previewing, and subscribing require no account, sign-in, password, or authentication process. Email confirmation is a link activation and does not require a cognitive-function test. |

## Automated coverage

The vendored axe-core 4.10.2 release maps `target-size` to the `wcag22aa` tag. The
accessibility gate treats every rule carrying that tag as a ratcheted failure and runs the
page/state matrix at both review widths. The remaining criteria depend on interaction or
process context and retain the targeted checks described above.
