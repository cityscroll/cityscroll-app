# Labeling-function accounting er_labeling_functions_v1

Feature set: **pair_features_v2** · pairs: **56** · gold stratum: **56**

Coverage is emitted labels divided by all pairs. Overlap is the share of a function's covered rows with another vote. Conflict is the share of its covered rows with an opposite vote. Accuracy is measured only where a gold label is supplied; empty denominators remain —.

| Labeling function | Label | Coverage | Overlap | Conflict | Gold accuracy |
| --- | --- | ---: | ---: | ---: | ---: |
| scoped_authority_key_equal_v1 | same | 6 (0.10714285714285714) | 2 (0.3333333333333333) | 0 (0) | 6/6 (1) |
| contract_id_equal_v0 | same | 0 (0) | 0 (—) | 0 (—) | 0/0 (—) |
| hard_id_conflict_v0 | different | 1 (0.017857142857142856) | 0 (0) | 0 (0) | 1/1 (1) |
| agency_place_conflict_v0 | different | 1 (0.017857142857142856) | 0 (0) | 0 (0) | 1/1 (1) |
| vendor_legal_form_conflict_v0 | different | 3 (0.05357142857142857) | 2 (0.6666666666666666) | 2 (0.6666666666666666) | 1/3 (0.3333333333333333) |
| vendor_stem_equal_v0 | same | 16 (0.2857142857142857) | 15 (0.9375) | 2 (0.125) | 16/16 (1) |
| agency_stem_equal_v0 | same | 9 (0.16071428571428573) | 4 (0.4444444444444444) | 0 (0) | 9/9 (1) |
| token_similarity_v0 | same | 19 (0.3392857142857143) | 18 (0.9473684210526315) | 0 (0) | 19/19 (1) |
| vendor_typo_proximity_v1 | same | 3 (0.05357142857142857) | 0 (0) | 0 (0) | 3/3 (1) |
| vendor_truncation_v1 | same | 3 (0.05357142857142857) | 1 (0.3333333333333333) | 0 (0) | 3/3 (1) |
| vendor_abbreviation_v1 | same | 3 (0.05357142857142857) | 0 (0) | 0 (0) | 3/3 (1) |

Overall: **42** pairs covered (0.75); **2** pairs have conflicting votes (0.03571428571428571).
