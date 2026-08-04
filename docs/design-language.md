# CityScroll design language

CityScroll makes the city's public record legible. Its interface should read like public
infrastructure: recognizable, calm, evidence-led, and useful before it is expressive. This document
is the distilled, self-contained rationale for the visual language — the *why* behind each value —
and `site/brand.css` is the single token sheet that expresses it. Every page consumes those tokens;
no page should hard-code a color, font, or spacing value that a token already names.

The guiding qualities, in priority order:

1. **Legible for everyone.** Type, contrast, and measure are tuned so a dense civic record stays
   readable regardless of age, ability, language, or device. Accessibility is the constraint that
   the rest of the language is designed around, not a layer added afterward.
2. **Trustworthy and plain.** The record and the task are visually primary. Chrome recedes. Nothing
   decorative competes with a dollar figure, a deadline, or a hearing date.
3. **Recognizably civic, unmistakably independent.** The language reads as serious public-interest
   software. It never borrows official marks, seals, or lockups, and the unofficial-source
   disclaimer stays prominent (see [Non-affiliation](#non-affiliation), which is a hard rule).

## Color

The palette is a cool neutral ground with a single confident action blue and a small, strictly
scoped set of status hues. It replaces the earlier warm-paper (beige) scheme, which read as
editorial and personal; a cool near-white ground reads as a public utility and lets data carry the
warmth.

Every foreground token below meets **WCAG 2.2 AA** (≥ 4.5:1 for text; ≥ 3:1 for non-text UI
boundaries) against the surface it is used on. The contrast column states the measured ratio against
white `#ffffff`.

### Neutrals

| Token role | Hex | Used for | Contrast on white |
| --- | --- | --- | --- |
| Surface | `#ffffff` | Cards, form fields, raised reading surfaces | — |
| Canvas | `#f5f6f8` | Page background | — |
| Canvas subtle | `#eceef2` | Chips, alternating rows, quiet fills | — |
| Hairline | `#dde1e7` | Decorative dividers and card outlines (non-control) | ~1.2:1 (decorative only) |
| Border strong | `#7a828f` | Form-control boundaries (the field's only visible extent) | **3.9:1** (meets 3:1 non-text) |
| Text muted | `#5b6470` | Secondary labels, captions, metadata | **6.0:1** |
| Text soft | `#37414d` | Body de-emphasis, supporting copy | ~9:1 |
| Ink | `#12181f` | Headings and primary body text | ~16:1 |

Form-control borders must use **Border strong**, never Hairline — the boundary is the only indicator
of a text field's extent, so it is held to the 3:1 non-text-contrast bar (WCAG 1.4.11). Hairlines are
reserved for dividers and card outlines that also carry visible text.

### Action and identity

| Token role | Hex | Used for | Contrast on white |
| --- | --- | --- | --- |
| Action | `#1a44e0` | Links and anywhere a user can act (primary buttons, control accents) | **7.1:1** |
| Action hover | `#10259e` | Hover / active state of action elements | ~11:1 |
| Action tint | `#eef2ff` | Quiet backgrounds behind action affordances | — |
| Action tint border | `#c9d5ff` | Outlines on action-tinted regions | — |
| Brand | `#1b3a8f` | Identity and wayfinding — masthead rule, brand lockup | **10.3:1** |

One action color, used consistently, teaches the reader that blue means "you can do something here."
Identity blue is a deeper, quieter navy so the masthead reads as a stable frame rather than a call to
action.

### Status

Status hues are text-safe first: the value below is dark enough to pass AA as text, with a paired
tint for backgrounds. They are used sparingly and only to mean their state — never as decoration.

| State | Text/icon | Tint | Border | Text contrast |
| --- | --- | --- | --- | --- |
| Success | `#1a6b34` | `#e7f4ec` | `#b6ddc3` | **6.5:1** |
| Caution | `#8a5a00` | `#fbf1d8` | `#e6c88a` | **6.0:1** |
| Danger / error | `#c01829` | `#fdeaec` | `#f2b8bd` | **6.2:1** |

Red is reserved for genuine errors and destructive states — it is never an action or accent color.
Bright "fill" variants of these hues (e.g. a saturated success green) are deliberately not used as
text; they fail AA and would undercut the legibility-first principle.

## Typography

Two open, freely available families, chosen for legibility and a modern-civic tone, and because both
ship every script the city's language-access obligations require (including CJK, Arabic, and
Devanagari via their sibling faces):

- **Display / headings — Space Grotesk.** A geometric grotesk with distinct proportions and a
  contemporary voice. It gives headings and the wordmark a confident, non-generic character without
  reading as promotional. Weights: 500 / 600 / 700.
- **Text / UI — Noto Sans.** A humanist sans engineered for uniform stroke weight and high legibility
  at small sizes across a very large glyph set. It carries body copy, controls, and data. Weights:
  400 / 500 / 600 / 700.

Both are self-justifying choices: open-licensed, servable from the font host the site already uses
(no new third-party dependency), and privacy-neutral. This replaces the earlier serif pairing, which
leaned editorial; a humanist sans body reads as an application for looking things up, which is what
the site is.

Small-caps / tracked labels (tab bar, field labels, kickers) are produced from Noto Sans with
`text-transform: uppercase` and letter-spacing rather than a dedicated small-caps face — one fewer
font to load, and it degrades cleanly in scripts that have no letter-casing (where the site already
neutralizes tracking and casing).

### Type scale

Sizes are a reference for new work; existing components keep their tuned sizes but adopt the new
families. Body line-height is generous (1.6) because the content is scanned and re-read.

| Style | Family | Weight | Desktop | Mobile | Line height |
| --- | --- | --- | --- | --- | --- |
| Display | Space Grotesk | 600 | clamp to ~4.8rem | ~2.5rem | 0.9–1.1 |
| H1 | Space Grotesk | 600 | 2.5rem | 2rem | 1.05–1.2 |
| H2 | Space Grotesk | 600 | 1.75rem | 1.5rem | 1.1 |
| H3 | Space Grotesk | 500 | 1.35rem | 1.25rem | 1.25 |
| Intro / lead | Noto Sans | 500 | 1.25rem | 1.15rem | 1.5 |
| Body | Noto Sans | 400 | 1.0625rem (17px) | 1rem (16px) | 1.6 |
| Label / caption | Noto Sans | 600 | 0.8125rem (13px) | 0.8125rem | 1.4 |

Minimum body size on mobile is 16px. Never set interface text below 13px.

## Measure, grid, and spacing

**Measure.** Long-form text is capped at a comfortable reading measure (`--measure`, ~72ch / ~750px)
regardless of container width — measure, not viewport, governs line length. The content container
(`--maxw`, 1120px) frames lists and detail views; text columns inside it stay narrower.

**Grid.** The site is content-first and fluid rather than snapped to a rigid column module, but it
honors the same intent: content lives in a small number of clear columns, gutters and margins grow
with the viewport, and layouts collapse to a single readable column on small screens (designed
small-screen-first). Reference breakpoints and rhythm:

| Breakpoint | Viewport | Columns (conceptual) | Gutter | Margin |
| --- | --- | --- | --- | --- |
| Small | 320–599px | 1 (was 4) | 16px | 16px |
| Medium | 600–999px | 2 | 24px | 24–40px |
| Large | 1000px+ | 3–4 within `--maxw` | 32–40px | scales; content stays ≤ 1120px |

**Spacing.** An 8-based scale drives proximity: space *within* a group is tight, space *between*
sections is large, so the eye can segment a dense page without rules or boxes.

| Token | Value | Intended use |
| --- | --- | --- |
| `--space-1` | 0.25rem (4px) | Hairline gaps, icon-to-label |
| `--space-2` | 0.5rem (8px) | Caption to its content; list-item internals |
| `--space-3` | 0.75rem (12px) | Tight component padding |
| `--space-4` | 1rem (16px) | Heading to following content; base padding |
| `--space-5` | 1.5rem (24px) | Between components in a list or grid |
| `--space-6` | 2rem (32px) | Between an H2 and its following subsections |
| `--space-7` | 3rem (48px) | Large intra-page separation |
| `--space-8` | 4rem (64px) | Between major page sections |

**Shape and elevation.** The language is flat: hairlines and spacing carry structure, nothing floats.
`--shadow` stays `none` by default; corner radii are modest (`--radius-sm` 6px for controls,
`--radius-md` 10px for cards, `--radius-pill` for chips).

## Imagery principles

The product is data, so imagery is rare — but when used it follows the same posture:

- **Real, not staged or synthetic.** Photography, if any, depicts genuine situations; no
  AI-generated or AI-edited imagery. (The site's copy-generation disclosure is separate and already
  stated on the About page.)
- **Recognizably the city, minimally branded.** Environments should read as New York without leaning
  on any commercial or official logo, sign, or lockup.
- **Iconography over illustration.** Prefer simple, single-color, `currentColor` SVG icons that adapt
  to the token palette and theme, matching the site's own mark.

## Non-affiliation

These are hard rules, enforced by `test/standards/no_official_marks.py`:

- **No official marks.** No city seal, agency logo, official government lockup, or any asset that
  could imply this is an official government website. The only brand marks in the repo are
  CityScroll's own (`site/assets/brand/cityscroll-*`).
- **No claim of affiliation.** No committed text claims or implies official government status for
  CityScroll, or endorsement by any government body.
- **Disclaimer stays.** The About page keeps its statement that CityScroll is an independent,
  unofficial interface to public data, and that the data comes unedited from NYC Open Data.

Naming and referencing the city, its agencies, its datasets, and its public records is not only
allowed but the entire point of the product — the line is between *describing* public data (fine) and
*impersonating* an official channel (never).

## Tokens

The authoritative list of custom properties lives in `site/brand.css` under `:root`. Token names are
role-based and CityScroll's own (e.g. `--color-canvas`, `--color-action`, `--ink`, `--rule-strong`,
`--space-4`); component CSS references those names, so a future palette or type change happens in one
file. Design-token methodology follows the general practice (documented by systems such as
[USWDS](https://designsystem.digital.gov/design-tokens/)) of treating color, spacing, typography, and
measure as a small reusable system rather than one-off values.
