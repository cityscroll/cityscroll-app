# Comparative intelligence pilot evaluation

Evaluation: `comparative-pilots-2026-08-19`
Method: `frozen_comparative_pilot_evaluation_v1`
Inputs: committed CityScroll materializations and a frozen inspection ledger; no LLM is used.

## Decision

**Recommendation: revise; do not expand the metric set yet.** Continue the two bounded pilots, put registered-amount change behind the same frozen receipt and admission boundary, and repeat this evaluation after a larger inspection sample and denominator-bearing handoff window exist.

This is a recommendation for the captain, not an admission decision. No additional metric family is enabled by this evaluation. Expansion still requires a recorded human decision and a new bounded card.

## Results

| Dimension | Numerator / denominator | Result | Reading |
| --- | ---: | ---: | --- |
| Precision | 3 / 3 | 100.00% | Every frozen inspection supports the exact output, but three cases are too few to justify expansion. |
| Yield | 3 / 1705 | 0.18% | This is an output-per-eligible-input rate, not a signal count. Award rank is 1/1 within its committed allowlist; amount change is 2/1,704 positive amount pairs. |
| Diversity | 2 families, 2 sources, 2 object types, 3 agencies | dominant family 66.67% | The sample is not all large contracts, but it remains procurement-only and tiny. |
| Redundancy | 0 / 3 duplicates | 0.00% | No civic event produces cosmetic duplicate outputs in the frozen cases. |
| Stability | 2 / 2 pilots | 100.00% | Reversing committed source-row order does not change semantic outputs or their canonical order. |
| MNAR safety | 1 / 1 tempting negative claims withheld | 100.00% | The successor-absence control remains `held_mnar`; no claim or held reason reaches the public projection. |
| Investigation handoff | 0 / 0 shown opportunities | unknown | No exposure denominator is committed yet, so usefulness is unknown—not zero. |

## Pilot-specific findings

- **Award rank:** the shipped private signal reproduces its $53.0M amount, fourth-place rank, 264-row HPD peer set, source, and historical window. Its yield denominator is intentionally the one-subject pilot allowlist; the 8,395 eligible peer rows are context, not 8,395 shown candidates.
- **Registered-amount change:** the existing lifecycle detector finds two exact-contract changes among 1,704 committed Checkbook observations with positive original and current amounts. Both frozen inspections reproduce the source values and arithmetic. This pilot is not yet carried through the comparative receipt/admission/story-signal boundary, which is the main revision before broader evaluation.
- **MNAR negative control:** “No successor solicitation exists” remains unpublished because the observation contract is not closed-world. The harness fails if it publishes, if `held_mnar` changes, or if backstage reasons leak.
- **Usefulness:** CityScroll already emits aggregate, non-identifying `investigation_share:add_signal` when an admitted signal is added to Investigation. This card adds one event, `comparative_signal_shown:visible`, as its aggregate opportunity denominator. With 0/0 committed opportunities, the usefulness rate remains unknown.

## Expansion recommendation

Keep the two current families bounded. Before considering another family:

1. Put registered-amount change behind the same frozen comparative receipt and admission boundary as award rank.
2. Accumulate a larger, frozen inspection sample across both families and more than one observation window.
3. Accumulate a production observation window for the new aggregate shown-opportunity denominator and the existing `investigation_share:add_signal` count.
4. Re-run this harness. Any expansion still needs a captain-recorded decision and its own bounded card.

The current recommendation is **revise**, not expand or stop. The pilots are correct, non-redundant, stable, and MNAR-safe in the frozen cases; evidence of breadth and product usefulness is still insufficient.
