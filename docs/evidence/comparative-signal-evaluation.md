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
| Yield | 3 / 9058 | 0.03% | This is an output-per-eligible-input rate, not a signal count. Award rank is 1/1 within its committed allowlist; amount change is 2/9057 positive amount pairs. |
| Diversity | 2 families, 2 sources, 2 object types, 3 agencies | dominant family 66.67% | The sample is not all large contracts, but it remains procurement-only and tiny. |
| Redundancy | 0 / 3 duplicates | 0.00% | No civic event produces cosmetic duplicate outputs in the frozen cases. |
| Stability | 2 / 2 pilots | 100.00% | Reversing committed source-row order does not change semantic outputs or their canonical order. |
| MNAR safety | 1 / 1 tempting negative claims withheld | 100.00% | The successor-absence control remains `held_mnar`; no claim or held reason reaches the public projection. |
| Investigation handoff | 0 / 0 shown opportunities | unknown | No exposure denominator is committed yet, so usefulness is unknown—not zero. |

## Bounded admission

- `within_contract_registered_amount_change`: 117 detected, 2 shown, 115 admitted but not shown. A detected change is shown only where the frozen receipt carries an inspection verdict for it. Widening the shown set means extending the frozen inspection sample, which is a human decision this evaluation records rather than takes.

## Pilot-specific findings

- **Award rank:** the shipped private signal reproduces its $53.0M amount, fourth-place rank, 264-row HPD peer set, source, and historical window. Its yield denominator is intentionally the one-subject pilot allowlist; the 8750 eligible peer rows are context, not that many shown candidates.
- **Registered-amount change:** the existing lifecycle detector finds 117 exact-contract changes among 9057 committed Checkbook observations with positive original and current amounts. This pilot now sits behind a bounded admission: only the 2 subjects the frozen receipt inspected are shown, and every frozen inspection reproduces the source values and arithmetic. The remaining 115 are admitted and counted, awaiting an extended inspection sample. Carrying the family through the comparative receipt/story-signal boundary as well remains the main revision before broader evaluation.
- **MNAR negative control:** “No successor solicitation exists” remains unpublished because the observation contract is not closed-world. The harness fails if it publishes, if `held_mnar` changes, or if backstage reasons leak.
- **Usefulness:** CityScroll already emits aggregate, non-identifying `investigation_share:add_signal` when an admitted signal is added to Investigation. This card adds one event, `comparative_signal_shown:visible`, as its aggregate opportunity denominator. With 0/0 committed opportunities, the usefulness rate remains unknown.

## Expansion recommendation

Keep the two current families bounded. Before considering another family:

1. Put registered-amount change behind the same frozen comparative receipt and admission boundary as award rank.
2. Accumulate a larger, frozen inspection sample across both families and more than one observation window.
3. Accumulate a production observation window for the new aggregate shown-opportunity denominator and the existing `investigation_share:add_signal` count.
4. Re-run this harness. Any expansion still needs a captain-recorded decision and its own bounded card.

The current recommendation is **revise**, not expand or stop. The pilots are correct, non-redundant, stable, and MNAR-safe in the frozen cases; evidence of breadth and product usefulness is still insufficient.
