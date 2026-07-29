# Zero-results recovery for preset shortcuts

Preset shortcuts are promises made by the interface, so they should be held to a stronger
standard than arbitrary user-entered searches. The chosen design uses progressive query
relaxation: preserve the subject and location, widen only the time range, explain the change,
and let the visitor return to the exact query.

The supporting guidance is consistent:

- Baymard's search usability studies found that generic zero-results pages become dead ends.
  When there is one relevant alternate query, Baymard recommends applying it automatically and
  explaining that the original query had no results:
  [Search UX: 5 Proven Strategies for Improving “No Results” Pages](https://baymard.com/blog/no-results-page).
- Baymard also recommends preserving the original query so it remains easy to revise:
  [Always Persist Users’ Search Queries](https://baymard.com/blog/persist-search-queries).
- Nielsen Norman Group's accessibility guidance similarly warns against returning unexplained
  results for a different query; the interface must state what happened:
  [Beyond ALT Text: Making the Web Easy to Use for Users with Disabilities](https://media.nngroup.com/media/reports/free/Usability_Guidelines_for_Accessible_Web_Design.pdf).
- GOV.UK's design guidance says not to disable a destination merely because it has no content;
  remove it or explain the absence. It also emphasizes clear labels for destinations:
  [Tabs](https://design-system.service.gov.uk/components/tabs/).

Applied here:

1. Scenario shortcuts are checked against live source data before deployment. The narrowest
   non-empty time scope is written into the page, with an honest label. A shortcut with no
   useful fallback fails validation.
2. Rotating suggestions are chosen only from candidates whose resolved query currently has
   results. The resolved filters are stored in the validation receipt so later checks replay the
   same query without reinterpretation.
3. Runtime drift uses the ladder “this week → next 30 days → all upcoming → recent past.”
   A one-line status states the original and displayed scopes. Past rows carry a visible “Past”
   tag, and a control restores the exact query.
