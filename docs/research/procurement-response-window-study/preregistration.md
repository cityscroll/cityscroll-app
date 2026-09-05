# Pre-registration: observed response-window length and its neighbouring facts

Workstream: procurement pursuit decision surface. Card: PPD-07, lane
`outcome_study`.

This document is written **before any analysis is run**. Nothing in the study
described below has been executed. Its content hash is recorded in
`site/procurement_research_lanes.json` by
`node tools/procurement_research_lane_gates.mjs --register outcome_study`, so a
later edit to this file is detectable: the gate compares the registered hash
against the file on disk and fails when they differ.

The study may not begin until
`node tools/procurement_research_lane_gates.mjs --check` passes. That check
fails while any of cards PPD-01 through PPD-06 is missing its own evidence
shard or capture manifest. The ordering is the point. Each of those cards must
carry independent proof that it does what it says before a study of the same
records is allowed to run, because a study run first would be read afterwards
as the justification for whatever those cards shipped.

## Question

Does observed response-window length vary alongside procurement method, the
publishing agency, certification posture, and whether a matter reached a
completed award?

## Statements the study is permitted to make

Association only. Every reported relationship is a statement about what
co-occurs in a fixed extract of published records, at a stated vintage, with a
stated sample size, and with its unknowns stated beside it.

Permitted wording, and the only permitted wording:

- "Among the records in this extract, matters published with method X had a
  median observed response window of N calendar days; matters published with
  method Y had M."
- "This extract does not show a difference between A and B at this sample
  size."
- "This field was not observed for K of the N matters in this extract, and
  those matters are reported separately rather than folded into either group."

<!-- forbidden-claims-vocabulary:start -->
## Statements the study is forbidden to make

The study may not, anywhere in its text, tables, chart labels, summaries, or
titles, assert or imply any of the following:

- **Causation.** No claim that one fact causes, drives, produces, leads to,
  results in, or explains another; no counterfactual ("would have been"); no
  effect language.
- **Favoritism.** No claim that any agency, vendor, or matter was favored,
  steered, preferred, or advantaged, or that any window length is evidence of
  such treatment.
- **Irregularity.** No claim that any observed value is unusual in a way that
  suggests something is wrong, no "red flag", "anomaly", or "suspicious"
  framing of a published record.
- **Illegality.** No claim or implication that any observed practice violates a
  rule, a charter provision, a procurement policy, or any law.
- **Bidder-count effects.** No claim about how many parties responded to a
  matter, and no claim relating window length to that quantity. The repository
  has no usable source for it, and the study will not stand one up.

A finding that cannot be stated inside the permitted wording above is not
reported.
<!-- forbidden-claims-vocabulary:end -->

## Exact fields

The study reads only these fields, all of them already derived by shipped
modules, and derives no new one:

| Field | Where it comes from |
| --- | --- |
| Observed response window, in calendar days | `site/procurement_opportunity_window.mjs` |
| Window kind (exact release-to-due, or the weaker publication-to-due notice window) | `site/procurement_opportunity_window.mjs` |
| Notice-to-due process interval | `site/procurement_process_events.mjs` |
| Procurement method | `site/mwbe_goal_surface.mjs` (`resolveProcurementMethod`) |
| Publishing agency name | the committed procurement read model |
| Certification posture marker | `site/mwbe_goal_surface.mjs` (`buildSolicitationMwbeView`) |
| Award completion | the committed procurement read model's own stage vocabulary |

The two window kinds are never pooled. They measure different things, and the
shipped module keeps them apart for that reason; the study keeps them apart
too, and reports each separately or not at all.

## Data vintage

One frozen extract, named by the `generated_at` stamp of the committed
procurement read model the study reads, recorded in the study's own output
before any relationship is computed. The study does not re-pull, refresh, or
extend the extract once it has been read. No live retrieval of any kind is
part of this lane.

## Exclusion rules

Applied before any relationship is looked at, in this order:

1. Exclude a matter with no observed window of either kind. A missing window is
   reported as a count, never imputed and never treated as zero.
2. Exclude a matter whose window derivation failed closed in the shipped module
   (missing or invalid dates). The shipped module's own failure is the
   exclusion criterion; the study does not repair a date.
3. Exclude a matter whose due date precedes its release or publication date.
4. Report, rather than exclude, a matter whose method, agency, certification
   posture, or award completion is not observed. Those matters form their own
   "not observed" group in every table.
5. Report any group with fewer than 30 matters as a count only, with no
   central-tendency figure.

No exclusion rule may be added, removed, or reordered after the extract is
read. Doing so requires a new pre-registration, registered by its own hash.

## What the study cannot see

The same disclosure the shipped pursuit snapshot already carries applies here
in full: package eligibility requirements, experience requirements, staffing
requirements, Q&A content, amendment documents, the internal issuing team, an
existing relationship with the agency, and whether a given team could staff a
matter in time are all outside every source this repository observes. A window
length is a published interval and nothing more. Any reader of the study who
wants to know why an interval is what it is will not find the answer in it.
