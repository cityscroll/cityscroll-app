# About and guide content ownership

About is an organizational introduction. Its English narrative is 227 words,
including the accessible new-tab notice but excluding navigation, form labels,
privacy notices and compatibility links. The
product tour, threshold list and historical-pattern cards are absent from its
ordinary reading flow. Optional feedback prompts remain collapsed. The reading
grade is 6.39 against the existing 6.69 baseline; the baseline is unchanged.

## Section destinations

All former fragments on `/about.html` remain compact, fragment-activated links.
Their destinations are sections of
[Flags and historical patterns](../../../site/guide/understand/flags-and-historical-patterns/index.html).
Each anchor is identical across all eleven language documents.

| Former About fragment | Guide section anchor |
| --- | --- |
| `context` | `what-each-note-counts` |
| `past-patterns` | `patterns-from-past-records` |
| `staffing-list-establishment-formula` | `eligible-list-timing` |
| `property-disposition-timing-formula` | `property-sale-timing` |
| `tax-lien-sale-predictions` | `tax-lien-progression` |
| `zoning-base-rates` | `zoning-case-history` |
| `applicant-conditioned-ulurp` | `applicant-history` |

## Definition and threshold disposition

| Removed content | Canonical destination and treatment |
| --- | --- |
| Statistical context, fair explanations, no allegations; procurement methodology sources | Already present in the explanation's opening and reading guidance. About retains one compact Open Contracting methodology link as a public commitment, with accessible new-tab treatment in every locale. |
| Short advertising window: at most 10 days and less than half the agency median; last 200 notices | Moved once to “What each note counts.” The implementation in `site/app/alerts.mjs` restricts the median inputs to solicitations with valid positive windows. |
| Noncompetitive selection methods and possible legitimate reasons | Moved once to the same section. |
| Repeat awards: at least three notices, same published vendor and agency, 90 days; blanket-contract caveat | Moved once to the same section. |
| Award percentile: agency population of at least 20, 12 months; vendor dollar share and exact names | Moved once to the same section. |
| Rules lag: unfinished cases, agency/city pools, minimum 20, estimate segments and digest changes | Already owned by [rules adoption lag](../../formulas/rules-adoption-lag.md); the explanation links that owner. |
| Awards as published versus registration and payment | Already present in the explanation. The stale live-fetch claim is replaced with saved source snapshots and source-date guidance. |
| Exam-number join, filing-to-list interval, no applicant names/scores/ranks, median-only fallback | Moved once to “Eligible-list timing.” |
| Thin property sample, weak hearing-to-auction lot joins, official-date precedence | Moved to “Property sale timing.” Corrected the measured interval to auction publication → scheduled event, following the existing [formula](../../formulas/property-disposition-timing.md). |
| Lien progression versus sale/foreclosure, ordinary removal reasons, weak-evidence fallback | Moved once to “Tax lien progression.” |
| Zoning action/borough cohorts, minimum 20, time-range exclusions, legal-date authority | Moved once to “Zoning case history.” |
| Applicant outcome population, minimum 20, name-match and evaluation limits | Moved to “Applicant history,” linking the existing [formula](../../formulas/applicant-conditioned-ulurp-outcomes.md). |

Internal product links, locale URL values, the zoning read-model producer, retained
exam documents and capture fixtures now use direct guide destinations. Retained
exam pages receive navigation updates through their builder without replacing
historical facts from a later rolling input window.

## Rendered and functional evidence

[Capture manifest](capture-manifest.json) records before/after phone and desktop
captures, 22 localized renderings, 154 exact section journeys with browser Back,
locale switching and 22 intercepted feedback submissions. Images remain outside
tracked source. No real message was sent. Each receipt carries its viewport,
source digest, revision, data vintage, assertions and screenshot digest.

The existing `/about.html` document, its canonical URL, and the Standards document's
forwarding to `/about.html#accessibility` are preserved and checked locally. No route
configuration changed and no `/about/` route was added. Production probes for
`/about.html`, `/about`, `/about/` and `/standards.html` returned HTTP 403; those
responses do not establish production alias support.

Translations retain the existing machine-drafted disclosure and editorial review
state. Structural and rendered checks do not claim native-language review. About's
accessibility text states a WCAG 2.2 AA target and a feedback path, without claiming
that automated checks cover every public page.

README already routes walkthroughs to the guide and preserves the product overview
and repository entry points. It needs no change for this migration.
