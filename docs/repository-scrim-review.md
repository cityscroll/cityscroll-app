# Repository scrim review

This review records the deliberate repository scrim completed on 2026-08-04. The review covered the current repository tip, public commit history, and repository-local Git metadata because all three are evaluated before publication.

The complete inventory contained 1144 occurrences: 1143 were intentional public or non-published local material, 1 was removed from the tip, and none required credential rotation. Each row below records one occurrence, even when several occurrences share one narrowly scoped acceptance entry.

No item warranted rewriting repository history. Public meeting join details in source snapshots are expired access details published for public attendance, not private account credentials. Contact addresses are published product, agency, or fixture values. Hashes are public integrity and provenance digests.

## Findings

| ID | Location | Scope | Verdict | Rationale |
| --- | --- | --- | --- | --- |
| PB-0001 | `docs/screenshots/entity-double-escaping/raw-notice.json:1` | tip | benign-public | Public meeting access detail quoted from an expired civic notice; it is not a private account credential. |
| PB-0002 | `test/contract/fixtures/affected_area_golden.json:619` | tip | benign-public | Public meeting access detail quoted from an expired civic notice; it is not a private account credential. |
| PB-0003 | `test/contract/fixtures/affected_area_golden.json:654` | tip | benign-public | Public meeting access detail quoted from an expired civic notice; it is not a private account credential. |
| PB-0004 | `test/contract/fixtures/affected_area_golden.json:783` | tip | benign-public | Public meeting access detail quoted from an expired civic notice; it is not a private account credential. |
| PB-0005 | `test/contract/fixtures/affected_area_golden.json:1351` | tip | benign-public | Public organization name in a civic notice fixture; it is not an internal project codename. |
| PB-0006 | `test/contract/fixtures/affected_area_golden.json:1370` | tip | benign-public | Public organization name in a civic notice fixture; it is not an internal project codename. |
| PB-0007 | `test/contract/fixtures/affected_area_golden.json:2516` | tip | benign-public | Public organization name in a civic notice fixture; it is not an internal project codename. |
| PB-0008 | `test/contract/fixtures/affected_area_golden.json:2618` | tip | benign-public | Public meeting access detail quoted from an expired civic notice; it is not a private account credential. |
| PB-0009 | `test/contract/fixtures/affected_area_golden.json:3050` | tip | benign-public | Public meeting access detail quoted from an expired civic notice; it is not a private account credential. |
| PB-0010 | `commit:08a794b2` | history | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0011 | `docs/data-sources.md:13` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0012 | `docs/data-sources.md:15` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0013 | `docs/data-sources.md:19` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0014 | `docs/data-sources.md:20` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0015 | `docs/data-sources.md:21` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0016 | `docs/data-sources.md:62` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0017 | `docs/data-sources.md:63` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0018 | `docs/drift-inventory.md:28` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0019 | `docs/drift-inventory.md:35` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0020 | `docs/drift-inventory.md:49` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0021 | `docs/precompute-first-inventory-2026-07-29.md:23` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0022 | `docs/precompute-first-inventory-2026-07-29.md:24` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0023 | `docs/precompute-first-inventory-2026-07-29.md:41` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0024 | `docs/adr/entity-resolution-taxonomy.md:46` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0025 | `docs/adr/entity-resolution-taxonomy.md:189` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0026 | `docs/screenshots/entity-double-escaping/raw-notice.json:1` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0027 | `docs/evidence/hosting-migration-baseline.json:149` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0028 | `docs/evidence/hosting-migration-baseline.json:158` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0029 | `docs/evidence/hosting-migration-baseline.md:56` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0030 | `docs/evidence/hosting-migration-baseline.md:62` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0031 | `docs/evidence/hosting-migration-baseline.md:63` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0032 | `docs/formulas/property-disposition-timing.md:3` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0033 | `docs/formulas/property-disposition-timing.md:31` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0034 | `docs/formulas/rules-adoption-lag.md:9` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0035 | `docs/formulas/rules-adoption-lag.md:13` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0036 | `docs/formulas/rules-adoption-lag.md:47` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0037 | `docs/formulas/rules-adoption-lag.md:48` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0038 | `AGENTS.md:1266` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0039 | `docs/screenshots/entity-double-escaping/raw-notice.json:1` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0040 | `.gitignore:16` | tip | remove | Obsolete local-helper ignore entry does not belong in the public repository configuration. |
| PB-0041 | `tools/human_path_journey.py:36` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0042 | `tools/human_path_journey.py:44` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0043 | `tools/capture_rules_adoption_lag.py:2` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0044 | `tools/capture_rules_adoption_lag.py:5` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0045 | `tools/capture_rules_adoption_lag.py:164` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0046 | `tools/capture_rules_adoption_lag.py:165` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0047 | `tools/capture_rules_adoption_lag.py:168` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0048 | `tools/capture_rules_adoption_lag.py:171` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0049 | `tools/capture_rules_adoption_lag.py:196` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0050 | `tools/measure_hosting_baseline.mjs:151` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0051 | `tools/capture_rfx_documents_recon.py:132` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0052 | `tools/capture_exam_polish.py:46` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0053 | `tools/capture_exam_polish.py:47` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0054 | `tools/capture_exam_polish.py:123` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0055 | `tools/capture_cityscroll_rebrand.py:40` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0056 | `tools/capture_cityscroll_rebrand.py:41` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0057 | `tools/capture_property_lens_reground.py:33` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0058 | `tools/capture_property_lens_reground.py:116` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0059 | `tools/capture_deadline_exam_cards.py:40` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0060 | `tools/capture_deadline_exam_cards.py:41` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0061 | `tools/capture_bid_tabulations_recon.py:209` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0062 | `tools/capture_unofficial_translation.py:166` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0063 | `tools/capture_ulurp_recommendations_recon.py:212` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0064 | `tools/capture_scenario_routing.py:104` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0065 | `tools/capture_exam_outcomes.py:38` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0066 | `tools/capture_exam_outcomes.py:39` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0067 | `tools/capture_preset_widening.py:138` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0068 | `tools/capture_zap_outcomes.py:227` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0069 | `tools/capture_standards_self_conformance.py:68` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0070 | `tools/capture_data_viz_media.py:163` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0071 | `tools/capture_data_viz_media.py:206` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0072 | `tools/capture_analytics_readiness.py:196` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0073 | `tools/capture_legistar_depth_recon.py:216` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0074 | `tools/depot.mjs:225` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0075 | `tools/depot.mjs:229` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0076 | `tools/depot.mjs:237` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0077 | `tools/depot.mjs:241` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0078 | `tools/depot.mjs:245` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0079 | `tools/depot.mjs:249` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0080 | `tools/capture_changelog_media.py:227` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0081 | `tools/capture_changelog_media.py:231` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0082 | `tools/capture_changelog_media.py:233` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0083 | `tools/capture_changelog_media.py:235` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0084 | `tools/capture_changelog_media.py:237` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0085 | `tools/capture_changelog_media.py:239` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0086 | `tools/capture_changelog_media.py:275` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0087 | `tools/capture_changelog_media.py:360` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0088 | `tools/capture_changelog_media.py:377` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0089 | `tools/capture_changelog_media.py:442` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0090 | `tools/check_url_parity.py:61` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0091 | `tools/check_url_parity.py:136` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0092 | `tools/check_url_parity.py:137` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0093 | `tools/capture_land_methodology_note.py:238` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0094 | `tools/capture_attachment_text.py:29` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0095 | `tools/capture_task_first_entry.py:99` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0096 | `tools/capture_gap_taxonomy.py:120` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0097 | `tools/capture_property_disposition_timing.py:2` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0098 | `tools/capture_property_disposition_timing.py:5` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0099 | `tools/capture_property_disposition_timing.py:186` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0100 | `tools/capture_design_language_evidence.py:35` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0101 | `tools/capture_wave4_review.py:359` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0102 | `tools/capture_wcag22_map_controls.py:116` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0103 | `tools/capture_wcag22_map_controls.py:183` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0104 | `tools/source_contracts.mjs:250` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0105 | `tools/source_contracts.mjs:251` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0106 | `tools/capture_procurement_lifecycle_stitch.py:238` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0107 | `test/procurement_lifecycle_stitch.test.mjs:373` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0108 | `test/test_url_parity.py:13` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0109 | `test/forecast_render.test.mjs:72` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0110 | `test/forecast_render.test.mjs:102` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0111 | `test/forecast_render.test.mjs:109` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0112 | `test/gap_taxonomy.test.mjs:346` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0113 | `test/subsidy_lifecycle.test.mjs:57` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0114 | `test/subsidy_lifecycle.test.mjs:84` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0115 | `test/subsidy_lifecycle.test.mjs:100` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0116 | `test/subsidy_lifecycle.test.mjs:115` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0117 | `test/subsidy_lifecycle.test.mjs:131` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0118 | `test/subsidy_lifecycle.test.mjs:160` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0119 | `test/subsidy_lifecycle.test.mjs:169` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0120 | `test/subsidy_lifecycle.test.mjs:184` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0121 | `test/data_viz_intuitive.test.mjs:63` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0122 | `test/ida_notice_defects.test.mjs:253` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0123 | `test/ida_notice_defects.test.mjs:254` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0124 | `test/rules_adoption_lag.test.mjs:199` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0125 | `test/rules_adoption_lag.test.mjs:217` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0126 | `test/rules_adoption_lag.test.mjs:464` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0127 | `test/cadence_estimate.test.mjs:138` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0128 | `test/cadence_estimate.test.mjs:140` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0129 | `test/cadence_estimate.test.mjs:153` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0130 | `test/cadence_estimate.test.mjs:158` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0131 | `test/cadence_estimate.test.mjs:177` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0132 | `test/cadence_estimate.test.mjs:205` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0133 | `test/cadence_estimate.test.mjs:219` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0134 | `test/near_match_prior_cycles.test.mjs:245` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0135 | `test/near_match_prior_cycles.test.mjs:249` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0136 | `test/near_match_prior_cycles.test.mjs:257` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0137 | `test/near_match_prior_cycles.test.mjs:261` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0138 | `test/post_flip_checks.test.mjs:310` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0139 | `test/lineage_indicator.test.mjs:8` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0140 | `test/property_disposition_timing.test.mjs:148` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0141 | `test/property_disposition_timing.test.mjs:180` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0142 | `test/property_disposition_timing.test.mjs:206` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0143 | `test/land_copy_copytest.test.mjs:34` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0144 | `test/land_copy_copytest.test.mjs:43` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0145 | `test/subsidy_hearing_money.test.mjs:105` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0146 | `test/subsidy_hearing_money.test.mjs:106` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0147 | `test/subsidy_hearing_money.test.mjs:107` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0148 | `test/subsidy_hearing_money.test.mjs:108` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0149 | `test/subsidy_hearing_money.test.mjs:129` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0150 | `test/subsidy_hearing_money.test.mjs:130` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0151 | `test/subsidy_hearing_money.test.mjs:135` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0152 | `test/subsidy_hearing_money.test.mjs:136` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0153 | `test/subsidy_hearing_money.test.mjs:137` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0154 | `test/subsidy_hearing_money.test.mjs:144` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0155 | `test/subsidy_hearing_money.test.mjs:145` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0156 | `test/subsidy_hearing_money.test.mjs:198` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0157 | `test/subsidy_hearing_money.test.mjs:199` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0158 | `test/subsidy_hearing_money.test.mjs:239` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0159 | `test/subsidy_hearing_money.test.mjs:279` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0160 | `test/subsidy_hearing_money.test.mjs:293` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0161 | `test/contract/property_location.test.mjs:42` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0162 | `test/contract/fixtures/affected_area_golden.json:67` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0163 | `test/contract/fixtures/affected_area_golden.json:206` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0164 | `test/contract/fixtures/affected_area_golden.json:437` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0165 | `test/contract/fixtures/affected_area_golden.json:469` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0166 | `test/contract/fixtures/affected_area_golden.json:497` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0167 | `test/contract/fixtures/affected_area_golden.json:584` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0168 | `test/contract/fixtures/affected_area_golden.json:619` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0169 | `test/contract/fixtures/affected_area_golden.json:654` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0170 | `test/contract/fixtures/affected_area_golden.json:690` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0171 | `test/contract/fixtures/affected_area_golden.json:1321` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0172 | `test/contract/fixtures/affected_area_golden.json:1351` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0173 | `test/contract/fixtures/affected_area_golden.json:1370` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0174 | `test/contract/fixtures/affected_area_golden.json:2029` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0175 | `test/contract/fixtures/affected_area_golden.json:2174` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0176 | `test/contract/fixtures/affected_area_golden.json:2304` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0177 | `test/contract/fixtures/affected_area_golden.json:2368` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0178 | `test/contract/fixtures/affected_area_golden.json:2428` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0179 | `test/contract/fixtures/affected_area_golden.json:2618` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0180 | `test/contract/fixtures/affected_area_golden.json:2954` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0181 | `test/contract/fixtures/affected_area_golden.json:3018` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0182 | `test/contract/fixtures/affected_area_golden.json:3050` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0183 | `test/contract/fixtures/property_location_golden.json:60` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0184 | `test/contract/fixtures/property_location_golden.json:118` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0185 | `test/contract/fixtures/property_location_golden.json:174` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0186 | `test/contract/fixtures/property_location_golden.json:231` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0187 | `test/contract/fixtures/property_location_golden.json:259` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0188 | `test/contract/fixtures/property_location_golden.json:287` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0189 | `test/contract/fixtures/property_location_golden.json:315` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0190 | `test/contract/fixtures/property_location_golden.json:343` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0191 | `test/contract/fixtures/property_location_golden.json:371` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0192 | `test/contract/fixtures/property_location_golden.json:399` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0193 | `test/contract/fixtures/property_location_golden.json:427` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0194 | `test/contract/fixtures/property_location_golden.json:455` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0195 | `test/contract/fixtures/property_location_golden.json:484` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0196 | `test/contract/fixtures/property_location_golden.json:513` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0197 | `test/contract/fixtures/property_location_golden.json:542` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0198 | `test/contract/fixtures/property_location_golden.json:571` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0199 | `test/contract/fixtures/property_location_golden.json:599` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0200 | `test/contract/fixtures/property_location_golden.json:627` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0201 | `test/contract/fixtures/property_location_golden.json:656` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0202 | `test/contract/fixtures/property_location_golden.json:685` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0203 | `test/contract/fixtures/property_location_golden.json:714` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0204 | `test/contract/fixtures/property_location_golden.json:743` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0205 | `test/contract/fixtures/property_location_golden.json:772` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0206 | `test/contract/fixtures/property_location_golden.json:800` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0207 | `test/contract/fixtures/property_location_golden.json:858` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0208 | `test/contract/fixtures/property_location_golden.json:887` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0209 | `test/contract/fixtures/property_location_golden.json:916` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0210 | `test/contract/fixtures/property_location_golden.json:945` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0211 | `test/contract/fixtures/property_location_golden.json:1001` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0212 | `test/contract/fixtures/property_location_golden.json:1200` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0213 | `test/contract/fixtures/property_location_golden.json:1401` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0214 | `test/contract/fixtures/property_location_golden.json:1630` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0215 | `test/fixtures/zap_hearing_logistics/2024Q0292.json:939` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0216 | `test/fixtures/zap_outcomes/joined_timbale_terrace.json:28` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0217 | `test/fixtures/zap_outcomes/joined_timbale_terrace.json:477` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0218 | `test/fixtures/zap_outcomes/joined_timbale_terrace.json:561` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0219 | `test/fixtures/zap_outcomes/thin_or_legacy.json:28` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0220 | `test/fixtures/source_contracts/source-shapes.json:49` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0221 | `test/functional/capture_rules_status_chips.py:64` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0222 | `test/functional/capture_rules_status_chips.py:187` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0223 | `test/functional/capture_rules_status_chips.py:230` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0224 | `test/functional/06_flags_benchmarks.py:13` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0225 | `test/functional/06_flags_benchmarks.py:22` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0226 | `test/functional/capture_nlq_deeplink_legibility.py:179` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0227 | `test/functional/capture_nlq_deeplink_legibility.py:235` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0228 | `test/functional/11_accessibility.py:61` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0229 | `test/functional/11_accessibility.py:62` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0230 | `test/functional/11_accessibility.py:69` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0231 | `test/functional/11_accessibility.py:71` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0232 | `test/functional/11_accessibility.py:72` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0233 | `test/functional/11_accessibility.py:177` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0234 | `test/functional/11_accessibility.py:416` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0235 | `test/functional/13_stray_english.py:48` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0236 | `test/functional/13_stray_english.py:49` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0237 | `test/functional/13_stray_english.py:317` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0238 | `test/functional/13_stray_english.py:358` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0239 | `test/functional/capture_export_workflows.py:173` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0240 | `test/functional/15_rtl.py:36` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0241 | `test/functional/15_rtl.py:44` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0242 | `test/functional/18_draft_alert_sync.py:27` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0243 | `test/functional/18_draft_alert_sync.py:36` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0244 | `test/functional/08_follow_workspace_api.py:13` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0245 | `test/functional/08_follow_workspace_api.py:22` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0246 | `test/functional/02_glance_today_property_a11y.py:13` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0247 | `test/functional/02_glance_today_property_a11y.py:22` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0248 | `test/functional/03_watch_quiz_feeds.py:13` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0249 | `test/functional/03_watch_quiz_feeds.py:22` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0250 | `test/functional/12_language.py:152` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0251 | `test/functional/20_demo_links.py:110` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0252 | `test/functional/20_demo_links.py:353` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0253 | `test/functional/05_entity_pages_pivots.py:13` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0254 | `test/functional/05_entity_pages_pivots.py:22` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0255 | `test/functional/04_regression_quiz_parallel.py:12` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0256 | `test/functional/21_module_dom_equivalence.py:45` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0257 | `test/functional/21_module_dom_equivalence.py:84` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0258 | `test/functional/21_module_dom_equivalence.py:126` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0259 | `test/functional/21_module_dom_equivalence.py:129` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0260 | `test/functional/14_focus_visible.py:54` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0261 | `test/functional/capture_lifecycle_timeline.py:89` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0262 | `test/functional/capture_lifecycle_timeline.py:122` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0263 | `test/functional/16_forecast_discoverability.py:46` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0264 | `test/functional/16_forecast_discoverability.py:71` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0265 | `test/functional/16_forecast_discoverability.py:95` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0266 | `test/functional/16_external_links.py:44` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0267 | `test/functional/16_external_links.py:62` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0268 | `test/functional/01_permalinks_deadlines_people.py:13` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0269 | `test/functional/01_permalinks_deadlines_people.py:22` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0270 | `test/functional/17_default_examples.py:27` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0271 | `test/functional/17_default_examples.py:49` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0272 | `test/functional/17_default_examples.py:76` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0273 | `test/functional/09_regression_dns_fallback.py:8` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0274 | `test/functional/07_dollars_matter_timeline.py:16` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0275 | `test/functional/07_dollars_matter_timeline.py:25` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0276 | `test/functional/assets/i18n_fixtures.py:229` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0277 | `test/functional/assets/i18n_fixtures.py:235` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0278 | `test/functional/assets/i18n_fixtures.py:291` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0279 | `test/functional/assets/i18n_fixtures.py:371` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0280 | `test/functional/assets/i18n_fixtures.py:838` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0281 | `test/functional/assets/i18n_fixtures.py:840` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0282 | `test/functional/assets/i18n_fixtures.py:913` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0283 | `test/functional/assets/i18n_fixtures.py:928` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0284 | `test/functional/assets/axe.min.js:12` | tip | benign-public | Vendored accessibility code text; the matched words are not a project data claim. |
| PB-0285 | `test/functional/assets/axe.min.js:12` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0286 | `test/standards/canonical_domain.py:35` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0287 | `test/standards/canonical_domain.py:66` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0288 | `test/standards/i18n_refs.py:46` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0289 | `test/standards/stray_english.py:47` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0290 | `test/standards/stray_english.py:80` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0291 | `test/standards/stray_english.py:108` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0292 | `test/standards/stray_english.py:125` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0293 | `test/standards/stray_english.py:195` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0294 | `test/standards/stray_english.py:200` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0295 | `test/standards/stray_english.py:215` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0296 | `test/standards/stray_english.py:219` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0297 | `test/standards/stray_english.py:239` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0298 | `test/standards/outline_guard.py:16` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0299 | `test/standards/outline_guard.py:30` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0300 | `test/standards/outline_guard.py:32` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0301 | `test/standards/outline_guard.py:37` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0302 | `test/standards/outline_guard.py:45` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0303 | `test/standards/nl_input_clarity.py:50` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0304 | `test/standards/label_coverage.py:23` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0305 | `test/standards/label_coverage.py:24` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0306 | `test/standards/label_coverage.py:64` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0307 | `test/standards/i18n_glossary.py:59` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0308 | `test/standards/i18n_glossary.py:97` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0309 | `test/standards/i18n_glossary.py:110` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0310 | `test/standards/link_targets.py:57` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0311 | `test/standards/link_targets.py:65` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0312 | `test/standards/link_targets.py:243` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0313 | `test/standards/reading_level.py:30` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0314 | `test/standards/js_syntax.py:18` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0315 | `test/standards/brand_identity.py:24` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0316 | `test/standards/brand_identity.py:37` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0317 | `test/standards/attribution.py:14` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0318 | `test/standards/attribution.py:18` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0319 | `test/standards/i18n_fallback_sync.py:106` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0320 | `test/standards/form_border_contrast.py:16` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0321 | `test/standards/form_border_contrast.py:21` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0322 | `test/standards/heading_uniqueness.py:23` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0323 | `test/standards/heading_uniqueness.py:24` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0324 | `test/standards/heading_uniqueness.py:58` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0325 | `test/standards/es_diacritics.py:53` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0326 | `test/standards/no_official_marks.py:65` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0327 | `test/standards/english_words.py:43` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0328 | `civic-content-gates/pyproject.toml:2` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0329 | `civic-content-gates/pyproject.toml:11` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0330 | `civic-content-gates/pyproject.toml:12` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0331 | `civic-content-gates/pyproject.toml:16` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0332 | `civic-content-gates/pyproject.toml:22` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0333 | `civic-content-gates/pyproject.toml:25` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0334 | `civic-content-gates/civic_content_gates/suite.py:74` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0335 | `civic-content-gates/civic_content_gates/suite.py:76` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0336 | `civic-content-gates/civic_content_gates/suite.py:102` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0337 | `civic-content-gates/civic_content_gates/nyc_copy_lint.py:31` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0338 | `civic-content-gates/civic_content_gates/nyc_copy_lint.py:112` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0339 | `civic-content-gates/civic_content_gates/nyc_copy_lint.py:113` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0340 | `civic-content-gates/civic_content_gates/nyc_copy_lint.py:114` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0341 | `civic-content-gates/civic_content_gates/nyc_copy_lint.py:115` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0342 | `civic-content-gates/civic_content_gates/nyc_copy_lint.py:116` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0343 | `civic-content-gates/civic_content_gates/nyc_copy_lint.py:117` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0344 | `civic-content-gates/civic_content_gates/nyc_copy_lint.py:241` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0345 | `civic-content-gates/civic_content_gates/nyc_copy_lint.py:267` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0346 | `civic-content-gates/civic_content_gates/nyc_copy_lint.py:276` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0347 | `civic-content-gates/civic_content_gates/nyc_copy_lint.py:280` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0348 | `civic-content-gates/civic_content_gates/nyc_copy_lint.py:285` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0349 | `civic-content-gates/civic_content_gates/nyc_copy_lint.py:290` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0350 | `civic-content-gates/civic_content_gates/reading_level.py:48` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0351 | `civic-content-gates/civic_content_gates/reading_level.py:75` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0352 | `civic-content-gates/civic_content_gates/reading_level.py:162` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0353 | `civic-content-gates/civic_content_gates/genai_disclosure.py:15` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0354 | `civic-content-gates/civic_content_gates/cli.py:63` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0355 | `civic-content-gates/civic_content_gates/cli.py:75` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0356 | `civic-content-gates/civic_content_gates/cli.py:87` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0357 | `civic-content-gates/civic_content_gates/page_metadata.py:29` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0358 | `civic-content-gates/civic_content_gates/i18n_keys.py:88` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0359 | `civic-content-gates/civic_content_gates/i18n_keys.py:89` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0360 | `civic-content-gates/civic_content_gates/link_text.py:63` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0361 | `civic-content-gates/civic_content_gates/heading_punctuation.py:39` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0362 | `ontology/fixtures/dimensions/not_published_claim_samples.json:13` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0363 | `site/index.html:736` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0364 | `site/index.html:737` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0365 | `site/index.html:738` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0366 | `site/index.html:739` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0367 | `site/index.html:740` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0368 | `site/about.html:175` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0369 | `site/about.html:178` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0370 | `site/about.html:189` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0371 | `site/digest_item_awareness.mjs:486` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0372 | `site/rules_adoption_lag_view.mjs:2` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0373 | `site/rules_adoption_lag_view.mjs:90` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0374 | `site/rules_adoption_lag_view.mjs:104` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0375 | `site/rules_adoption_lag_view.mjs:105` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0376 | `site/rules_adoption_lag_view.mjs:147` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0377 | `site/rules_adoption_lag_view.mjs:162` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0378 | `site/rules_adoption_lag_view.mjs:163` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0379 | `site/nl_parse.js:171` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0380 | `site/property_disposition_timing.mjs:2` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0381 | `site/property_disposition_timing.mjs:56` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0382 | `site/property_disposition_timing.mjs:57` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0383 | `site/i18n.js:1332` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0384 | `site/i18n.js:1341` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0385 | `site/i18n.js:1342` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0386 | `site/i18n.js:1374` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0387 | `site/i18n.js:1375` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0388 | `site/i18n.js:1646` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0389 | `site/i18n.js:1908` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0390 | `site/i18n.js:1909` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0391 | `site/i18n.js:1920` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0392 | `site/i18n.js:2041` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0393 | `site/i18n.js:2056` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0394 | `site/i18n.js:2304` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0395 | `site/app/property.mjs:304` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0396 | `site/app/property.mjs:305` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0397 | `site/app/property.mjs:306` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0398 | `site/app/property.mjs:308` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0399 | `site/app/property.mjs:312` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0400 | `site/app/property.mjs:610` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0401 | `site/app/money-history.mjs:566` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0402 | `site/app/money-history.mjs:665` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0403 | `site/app/money-history.mjs:682` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0404 | `site/app/money-history.mjs:687` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0405 | `site/app/money-history.mjs:723` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0406 | `site/app/money-history.mjs:724` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0407 | `site/app/rules.mjs:511` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0408 | `site/app/rules.mjs:512` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0409 | `site/app/rules.mjs:515` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0410 | `site/app/rules.mjs:516` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0411 | `site/app/rules.mjs:518` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0412 | `site/app/rules.mjs:521` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0413 | `site/app/rules.mjs:522` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0414 | `site/app/rules.mjs:532` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0415 | `site/app/rules.mjs:549` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0416 | `site/app/rules.mjs:556` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0417 | `site/app/money-list.mjs:322` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0418 | `site/i18n/lang/pl.js:1459` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0419 | `site/i18n/lang/pl.js:1460` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0420 | `site/i18n/lang/pl.js:1479` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0421 | `site/i18n/lang/pl.js:1834` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0422 | `site/i18n/lang/ko.js:1441` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0423 | `site/i18n/lang/ko.js:1442` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0424 | `site/i18n/lang/ko.js:1461` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0425 | `site/i18n/lang/ko.js:1818` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0426 | `site/i18n/lang/ru.js:1451` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0427 | `site/i18n/lang/ru.js:1452` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0428 | `site/i18n/lang/ru.js:1471` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0429 | `site/i18n/lang/ru.js:1824` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0430 | `site/i18n/lang/fr.js:1000` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0431 | `site/i18n/lang/fr.js:1027` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0432 | `site/i18n/lang/fr.js:1523` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0433 | `site/i18n/lang/fr.js:1524` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0434 | `site/i18n/lang/fr.js:1543` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0435 | `site/i18n/lang/fr.js:1679` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0436 | `site/i18n/lang/fr.js:1694` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0437 | `site/i18n/lang/fr.js:1922` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0438 | `site/i18n/lang/ar.js:1448` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0439 | `site/i18n/lang/ar.js:1449` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0440 | `site/i18n/lang/ar.js:1468` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0441 | `site/i18n/lang/ar.js:1827` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0442 | `site/i18n/lang/ht.js:1440` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0443 | `site/i18n/lang/ht.js:1441` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0444 | `site/i18n/lang/ht.js:1460` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0445 | `site/i18n/lang/ht.js:1813` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0446 | `site/i18n/lang/es.js:1442` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0447 | `site/i18n/lang/es.js:1443` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0448 | `site/i18n/lang/es.js:1814` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0449 | `site/i18n/lang/bn.js:1441` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0450 | `site/i18n/lang/bn.js:1442` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0451 | `site/i18n/lang/bn.js:1461` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0452 | `site/i18n/lang/bn.js:1814` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0453 | `site/i18n/lang/ur.js:1448` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0454 | `site/i18n/lang/ur.js:1449` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0455 | `site/i18n/lang/ur.js:1468` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0456 | `site/i18n/lang/ur.js:1827` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0457 | `site/i18n/lang/zh-Hans.js:1441` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0458 | `site/i18n/lang/zh-Hans.js:1442` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0459 | `site/i18n/lang/zh-Hans.js:1461` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0460 | `site/i18n/lang/zh-Hans.js:1812` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0461 | `site/data/gap_taxonomy.json:104` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0462 | `site/data/gap_taxonomy.json:226` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0463 | `site/data/gap_taxonomy.json:367` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0464 | `site/data/gap_taxonomy.json:458` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0465 | `site/data/gap_taxonomy.json:562` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0466 | `site/data/gap_taxonomy.json:593` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0467 | `site/data/gap_taxonomy.json:634` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0468 | `site/data/gap_taxonomy.json:662` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0469 | `site/data/gap_taxonomy.json:2198` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0470 | `site/data/task_first_examples.json:225` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0471 | `site/data/task_first_examples.json:297` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0472 | `site/data/staffing_exams.json:5962` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0473 | `site/data/rules_adoption_predictions.json:55` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0474 | `site/data/rules_adoption_predictions.json:106` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0475 | `site/data/rules_adoption_predictions.json:157` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0476 | `site/data/rules_adoption_predictions.json:208` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0477 | `site/data/rules_adoption_predictions.json:259` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0478 | `site/data/rules_adoption_predictions.json:310` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0479 | `site/data/rules_adoption_predictions.json:361` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0480 | `site/data/rules_adoption_predictions.json:412` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0481 | `site/data/rules_adoption_predictions.json:463` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0482 | `site/data/rules_adoption_predictions.json:514` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0483 | `site/data/rules_adoption_predictions.json:565` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0484 | `site/data/rules_adoption_predictions.json:616` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0485 | `site/data/rules_adoption_predictions.json:667` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0486 | `site/data/rules_adoption_predictions.json:718` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0487 | `site/data/rules_adoption_predictions.json:769` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0488 | `site/data/rules_adoption_predictions.json:820` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0489 | `site/data/rules_adoption_predictions.json:871` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0490 | `site/data/rules_adoption_predictions.json:922` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0491 | `site/data/rules_adoption_predictions.json:973` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0492 | `site/data/rules_adoption_predictions.json:1024` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0493 | `site/data/rules_adoption_predictions.json:1075` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0494 | `site/data/rules_adoption_predictions.json:1126` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0495 | `site/data/rules_adoption_predictions.json:1177` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0496 | `site/data/rules_adoption_predictions.json:1228` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0497 | `site/data/rules_adoption_predictions.json:1279` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0498 | `site/data/rules_adoption_predictions.json:1330` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0499 | `site/data/rules_adoption_predictions.json:1381` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0500 | `site/data/rules_adoption_predictions.json:1432` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0501 | `site/data/rules_adoption_predictions.json:1483` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0502 | `site/data/rules_adoption_predictions.json:1534` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0503 | `site/data/rules_adoption_predictions.json:1585` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0504 | `site/data/rules_adoption_predictions.json:1636` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0505 | `site/data/rules_adoption_predictions.json:1687` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0506 | `site/data/rules_adoption_predictions.json:1738` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0507 | `site/data/rules_adoption_predictions.json:1789` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0508 | `site/data/rules_adoption_predictions.json:1840` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0509 | `site/data/rules_adoption_predictions.json:1891` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0510 | `site/data/rules_adoption_predictions.json:1942` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0511 | `site/data/rules_adoption_predictions.json:1993` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0512 | `site/data/rules_adoption_predictions.json:2044` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0513 | `site/data/rules_adoption_predictions.json:2095` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0514 | `site/data/rules_adoption_predictions.json:2146` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0515 | `site/data/rules_adoption_predictions.json:2197` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0516 | `site/data/rules_adoption_predictions.json:2248` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0517 | `site/data/rules_adoption_predictions.json:2299` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0518 | `site/data/rules_adoption_predictions.json:2350` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0519 | `site/data/rules_adoption_predictions.json:2401` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0520 | `site/data/rules_adoption_predictions.json:2452` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0521 | `site/data/rules_adoption_predictions.json:2503` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0522 | `site/data/rules_adoption_predictions.json:2554` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0523 | `site/data/rules_adoption_predictions.json:2605` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0524 | `site/data/rules_adoption_predictions.json:2656` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0525 | `site/data/rules_adoption_predictions.json:2707` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0526 | `site/data/rules_adoption_predictions.json:2758` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0527 | `site/data/rules_adoption_predictions.json:2809` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0528 | `site/data/rules_adoption_predictions.json:2860` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0529 | `site/data/rules_adoption_predictions.json:2911` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0530 | `site/data/rules_adoption_predictions.json:2962` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0531 | `site/data/rules_adoption_predictions.json:3013` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0532 | `site/data/rules_adoption_predictions.json:3064` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0533 | `site/data/rules_adoption_predictions.json:3115` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0534 | `site/data/rules_adoption_predictions.json:3166` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0535 | `site/data/rules_adoption_predictions.json:3217` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0536 | `site/data/rules_adoption_predictions.json:3268` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0537 | `site/data/rules_adoption_predictions.json:3319` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0538 | `site/data/rules_adoption_predictions.json:3370` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0539 | `site/data/rules_adoption_predictions.json:3421` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0540 | `site/data/rules_adoption_predictions.json:3472` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0541 | `site/data/rules_adoption_predictions.json:3523` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0542 | `site/data/rules_adoption_predictions.json:3574` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0543 | `site/data/rules_adoption_predictions.json:3625` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0544 | `site/data/rules_adoption_predictions.json:3676` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0545 | `site/data/rules_adoption_predictions.json:3727` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0546 | `site/data/rules_adoption_predictions.json:3778` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0547 | `site/data/rules_adoption_predictions.json:3829` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0548 | `site/data/rules_adoption_predictions.json:3880` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0549 | `site/data/rules_adoption_predictions.json:3931` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0550 | `site/data/rules_adoption_predictions.json:3982` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0551 | `site/data/rules_adoption_predictions.json:4033` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0552 | `site/data/rules_adoption_predictions.json:4084` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0553 | `site/data/rules_adoption_predictions.json:4135` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0554 | `site/data/rules_adoption_predictions.json:4186` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0555 | `site/data/rules_adoption_predictions.json:4237` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0556 | `site/data/rules_adoption_predictions.json:4288` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0557 | `site/data/rules_adoption_predictions.json:4339` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0558 | `site/data/rules_adoption_predictions.json:4390` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0559 | `site/data/rules_adoption_predictions.json:4441` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0560 | `site/data/rules_adoption_predictions.json:4492` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0561 | `site/data/rules_adoption_predictions.json:4543` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0562 | `site/data/rules_adoption_predictions.json:4594` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0563 | `site/data/rules_adoption_predictions.json:4645` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0564 | `site/data/rules_adoption_predictions.json:4696` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0565 | `site/data/rules_adoption_predictions.json:4747` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0566 | `site/data/rules_adoption_predictions.json:4798` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0567 | `site/data/rules_adoption_predictions.json:4849` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0568 | `site/data/rules_adoption_predictions.json:4900` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0569 | `site/data/rules_adoption_predictions.json:4951` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0570 | `site/data/rules_adoption_predictions.json:5002` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0571 | `site/data/rules_adoption_predictions.json:5053` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0572 | `site/data/rules_adoption_predictions.json:5104` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0573 | `site/data/rules_adoption_predictions.json:5155` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0574 | `site/data/rules_adoption_predictions.json:5206` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0575 | `site/data/rules_adoption_predictions.json:5257` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0576 | `site/data/rules_adoption_predictions.json:5308` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0577 | `site/data/rules_adoption_predictions.json:5359` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0578 | `site/data/rules_adoption_predictions.json:5410` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0579 | `site/data/rules_adoption_predictions.json:5461` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0580 | `site/data/rules_adoption_predictions.json:5512` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0581 | `site/data/rules_adoption_predictions.json:5563` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0582 | `site/data/rules_adoption_predictions.json:5614` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0583 | `site/data/rules_adoption_predictions.json:5665` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0584 | `site/data/rules_adoption_predictions.json:5716` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0585 | `site/data/rules_adoption_predictions.json:5767` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0586 | `site/data/rules_adoption_predictions.json:5818` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0587 | `site/data/rules_adoption_predictions.json:5869` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0588 | `site/data/rules_adoption_predictions.json:5920` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0589 | `site/data/rules_adoption_predictions.json:5971` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0590 | `site/data/rules_adoption_predictions.json:6022` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0591 | `site/data/rules_adoption_predictions.json:6073` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0592 | `site/data/rules_adoption_predictions.json:6124` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0593 | `site/data/source_contracts.json:83` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0594 | `site/data/source_contracts.json:113` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0595 | `site/data/source_contracts.json:149` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0596 | `site/data/source_contracts.json:309` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0597 | `site/data/source_contracts.json:338` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0598 | `site/data/source_contracts.json:367` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0599 | `site/data/property_sources/property_disposition_history.json:1` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0600 | `site/data/exam_sources/annual_schedule.json:160` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0601 | `worker/README.md:56` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0602 | `worker/wrangler.toml:19` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0603 | `worker/test/usage.test.mjs:37` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0604 | `worker/test/usage.test.mjs:53` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0605 | `worker/test/suggestions.test.mjs:238` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0606 | `worker/test/forecast_scoring.test.mjs:130` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0607 | `worker/test/translate_invariants.test.mjs:40` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0608 | `worker/test/fixtures/subsidy-hearing-money/20220525018.json:9` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0609 | `worker/e2e/usage.mjs:34` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0610 | `worker/src/property.mjs:1` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0611 | `worker/src/worker.mjs:260` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0612 | `worker/src/checkbook.mjs:252` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0613 | `worker/src/vendor_profile.mjs:7` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0614 | `worker/src/ingest.mjs:92` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0615 | `worker/src/suggest.mjs:35` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0616 | `worker/src/suggest.mjs:73` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0617 | `worker/src/alerts.mjs:320` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0618 | `worker/src/alerts.mjs:1566` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0619 | `worker/src/alerts.mjs:1852` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0620 | `worker/src/alerts.mjs:1857` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0621 | `worker/src/alerts.mjs:2014` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0622 | `worker/src/passport.mjs:38` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0623 | `worker/src/lib/tax_lien_sale_model.mjs:216` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0624 | `worker/src/lib/tax_lien_sale_model.mjs:227` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0625 | `worker/src/lib/stats.mjs:119` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0626 | `worker/src/lib/usage.mjs:6` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0627 | `worker/src/lib/usage.mjs:7` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0628 | `worker/src/lib/usage.mjs:20` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0629 | `worker/src/lib/usage.mjs:26` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0630 | `worker/src/lib/usage.mjs:30` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0631 | `worker/src/lib/usage.mjs:38` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0632 | `worker/src/lib/subsidy_lifecycle.mjs:100` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0633 | `worker/src/lib/subsidy_lifecycle.mjs:114` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0634 | `worker/src/lib/subsidy_lifecycle.mjs:140` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0635 | `worker/src/lib/subsidy_lifecycle.mjs:386` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0636 | `worker/src/lib/subsidy_lifecycle.mjs:606` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0637 | `worker/src/lib/subsidy_lifecycle.mjs:688` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0638 | `worker/src/lib/subsidy_lifecycle.mjs:746` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0639 | `worker/src/lib/suggestions.mjs:165` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0640 | `worker/src/lib/property_disposition_timing.mjs:476` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0641 | `worker/src/lib/property_disposition_timing.mjs:477` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0642 | `worker/src/lib/rules_adoption_lag.mjs:344` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0643 | `worker/src/lib/rules_adoption_lag.mjs:489` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0644 | `worker/src/lib/rules_adoption_lag.mjs:673` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0645 | `worker/src/lib/rules_adoption_lag.mjs:710` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0646 | `worker/src/lib/rules_adoption_lag.mjs:726` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0647 | `worker/src/lib/rules_adoption_lag.mjs:794` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0648 | `worker/src/lib/rules_adoption_lag.mjs:822` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0649 | `worker/src/lib/rules_adoption_lag.mjs:863` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0650 | `worker/src/lib/rules_adoption_lag.mjs:864` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0651 | `worker/src/lib/rules_adoption_lag.mjs:905` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0652 | `worker/src/lib/rules_adoption_lag.mjs:914` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-0653 | `worker/src/lib/notices.mjs:113` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0654 | `warehouse/lib/attachment_text_extract.py:46` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0655 | `warehouse/lib/attachment_text_extract.py:48` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0656 | `warehouse/lib/attachment_text_extract.py:66` | tip | benign-public | Program or test configuration syntax; the match is not an unsourced public data claim. |
| PB-0657 | `tools/capture_unofficial_translation.py:37` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0658 | `tools/capture_changelog_media.py:69` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0659 | `tools/capture_changelog_media.py:337` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0660 | `test/current_solicitations.test.mjs:179` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0661 | `test/current_solicitations.test.mjs:179` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0662 | `test/current_solicitations.test.mjs:182` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0663 | `test/current_solicitations.test.mjs:182` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0664 | `test/test_url_parity.py:37` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0665 | `test/test_url_parity.py:37` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0666 | `test/test_url_parity.py:39` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0667 | `test/test_url_parity.py:39` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0668 | `test/apply_pnote.test.mjs:79` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0669 | `test/apply_pnote.test.mjs:79` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0670 | `test/apply_pnote.test.mjs:97` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0671 | `test/apply_pnote.test.mjs:97` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0672 | `test/apply_pnote.test.mjs:104` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0673 | `test/apply_pnote.test.mjs:104` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0674 | `test/prepare_changelog_base.test.mjs:72` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0675 | `test/prepare_changelog_base.test.mjs:72` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0676 | `test/doing_business_join.test.mjs:48` | tip | benign-public | Public business contact or test phone value required by a source or fixture contract. |
| PB-0677 | `test/doing_business_join.test.mjs:49` | tip | benign-public | Public business contact or test phone value required by a source or fixture contract. |
| PB-0678 | `test/doing_business_join.test.mjs:98` | tip | benign-public | Public business contact or test phone value required by a source or fixture contract. |
| PB-0679 | `test/action-rail.test.mjs:166` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0680 | `test/action-rail.test.mjs:166` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0681 | `test/action-rail.test.mjs:168` | tip | benign-public | Public business contact or test phone value required by a source or fixture contract. |
| PB-0682 | `test/action-rail.test.mjs:177` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0683 | `test/action-rail.test.mjs:177` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0684 | `test/contract/property_location.test.mjs:16` | tip | benign-public | Public business contact or test phone value required by a source or fixture contract. |
| PB-0685 | `test/contract/fixtures/affected_area_golden.json:67` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0686 | `test/contract/fixtures/affected_area_golden.json:170` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0687 | `test/contract/fixtures/affected_area_golden.json:206` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0688 | `test/contract/fixtures/affected_area_golden.json:314` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0689 | `test/contract/fixtures/affected_area_golden.json:344` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0690 | `test/contract/fixtures/affected_area_golden.json:403` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0691 | `test/contract/fixtures/affected_area_golden.json:437` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0692 | `test/contract/fixtures/affected_area_golden.json:469` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0693 | `test/contract/fixtures/affected_area_golden.json:554` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0694 | `test/contract/fixtures/affected_area_golden.json:584` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0695 | `test/contract/fixtures/affected_area_golden.json:619` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0696 | `test/contract/fixtures/affected_area_golden.json:654` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0697 | `test/contract/fixtures/affected_area_golden.json:690` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0698 | `test/contract/fixtures/affected_area_golden.json:905` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0699 | `test/contract/fixtures/affected_area_golden.json:938` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0700 | `test/contract/fixtures/affected_area_golden.json:1040` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0701 | `test/contract/fixtures/affected_area_golden.json:1153` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0702 | `test/contract/fixtures/affected_area_golden.json:1183` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0703 | `test/contract/fixtures/affected_area_golden.json:1213` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0704 | `test/contract/fixtures/affected_area_golden.json:1486` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0705 | `test/contract/fixtures/affected_area_golden.json:1554` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0706 | `test/contract/fixtures/affected_area_golden.json:1601` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0707 | `test/contract/fixtures/affected_area_golden.json:1671` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0708 | `test/contract/fixtures/affected_area_golden.json:1784` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0709 | `test/contract/fixtures/affected_area_golden.json:1882` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0710 | `test/contract/fixtures/affected_area_golden.json:1980` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0711 | `test/contract/fixtures/affected_area_golden.json:2005` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0712 | `test/contract/fixtures/affected_area_golden.json:2125` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0713 | `test/contract/fixtures/affected_area_golden.json:2150` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0714 | `test/contract/fixtures/affected_area_golden.json:2244` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0715 | `test/contract/fixtures/affected_area_golden.json:2304` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0716 | `test/contract/fixtures/affected_area_golden.json:2368` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0717 | `test/contract/fixtures/affected_area_golden.json:2428` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0718 | `test/contract/fixtures/affected_area_golden.json:2583` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0719 | `test/contract/fixtures/affected_area_golden.json:2618` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0720 | `test/contract/fixtures/affected_area_golden.json:2778` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0721 | `test/contract/fixtures/affected_area_golden.json:2798` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0722 | `test/contract/fixtures/affected_area_golden.json:2823` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0723 | `test/contract/fixtures/affected_area_golden.json:2901` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0724 | `test/contract/fixtures/affected_area_golden.json:2954` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0725 | `test/contract/fixtures/affected_area_golden.json:3018` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0726 | `test/contract/fixtures/affected_area_golden.json:3050` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0727 | `test/contract/fixtures/affected_area_golden.json:3085` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0728 | `test/contract/fixtures/affected_area_golden.json:3109` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0729 | `test/contract/fixtures/property_location_golden.json:484` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0730 | `test/contract/fixtures/property_location_golden.json:1401` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0731 | `test/contract/fixtures/property_location_golden.json:1424` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0732 | `test/contract/fixtures/property_location_golden.json:1446` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0733 | `test/contract/fixtures/property_location_golden.json:1511` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0734 | `test/contract/fixtures/property_location_golden.json:1531` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0735 | `test/contract/fixtures/property_location_golden.json:1630` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0736 | `test/contract/fixtures/property_location_golden.json:1754` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0737 | `test/functional/assets/i18n_fixtures.py:49` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0738 | `test/functional/assets/i18n_fixtures.py:49` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0739 | `test/functional/assets/i18n_fixtures.py:193` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0740 | `test/functional/assets/i18n_fixtures.py:193` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0741 | `test/functional/assets/stray_english_allowlist.json:32` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0742 | `test/standards/canonical_domain.py:100` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0743 | `test/standards/canonical_domain.py:104` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0744 | `test/standards/canonical_domain.py:106` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0745 | `test/standards/canonical_domain.py:108` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0746 | `test/standards/canonical_domain.py:109` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0747 | `test/standards/canonical_domain.py:144` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0748 | `test/standards/stray_english_allowlist.txt:119` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0749 | `site/index.html:1363` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0750 | `site/index.html:2079` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0751 | `site/about.html:227` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0752 | `site/about.html:241` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0753 | `site/changelog-data.json:77` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0754 | `site/api.html:176` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0755 | `site/i18n.js:375` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0756 | `site/i18n.js:2310` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0757 | `site/i18n.js:2471` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0758 | `site/i18n.js:2487` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0759 | `site/i18n.js:2503` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0760 | `site/app/alerts.mjs:524` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0761 | `site/app/alerts.mjs:561` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0762 | `site/app/alerts.mjs:577` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0763 | `site/i18n/lang/pl.js:270` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0764 | `site/i18n/lang/pl.js:1838` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0765 | `site/i18n/lang/pl.js:1993` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0766 | `site/i18n/lang/pl.js:2007` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0767 | `site/i18n/lang/pl.js:2023` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0768 | `site/i18n/lang/ko.js:262` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0769 | `site/i18n/lang/ko.js:1822` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0770 | `site/i18n/lang/ko.js:1977` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0771 | `site/i18n/lang/ko.js:1991` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0772 | `site/i18n/lang/ko.js:2007` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0773 | `site/i18n/lang/ru.js:262` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0774 | `site/i18n/lang/ru.js:1828` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0775 | `site/i18n/lang/ru.js:1983` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0776 | `site/i18n/lang/ru.js:1997` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0777 | `site/i18n/lang/ru.js:2013` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0778 | `site/i18n/lang/fr.js:273` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0779 | `site/i18n/lang/fr.js:1926` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0780 | `site/i18n/lang/fr.js:2086` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0781 | `site/i18n/lang/fr.js:2102` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0782 | `site/i18n/lang/fr.js:2118` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0783 | `site/i18n/lang/ar.js:264` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0784 | `site/i18n/lang/ar.js:1831` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0785 | `site/i18n/lang/ar.js:1986` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0786 | `site/i18n/lang/ar.js:2000` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0787 | `site/i18n/lang/ar.js:2016` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0788 | `site/i18n/lang/ht.js:261` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0789 | `site/i18n/lang/ht.js:1817` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0790 | `site/i18n/lang/ht.js:1972` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0791 | `site/i18n/lang/ht.js:1986` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0792 | `site/i18n/lang/ht.js:2002` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0793 | `site/i18n/lang/es.js:262` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0794 | `site/i18n/lang/es.js:1818` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0795 | `site/i18n/lang/es.js:1973` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0796 | `site/i18n/lang/es.js:1987` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0797 | `site/i18n/lang/es.js:2003` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0798 | `site/i18n/lang/bn.js:262` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0799 | `site/i18n/lang/bn.js:1818` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0800 | `site/i18n/lang/bn.js:1973` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0801 | `site/i18n/lang/bn.js:1987` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0802 | `site/i18n/lang/bn.js:2003` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0803 | `site/i18n/lang/ur.js:264` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0804 | `site/i18n/lang/ur.js:1831` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0805 | `site/i18n/lang/ur.js:1986` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0806 | `site/i18n/lang/ur.js:2000` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0807 | `site/i18n/lang/ur.js:2016` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0808 | `site/i18n/lang/zh-Hans.js:262` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0809 | `site/i18n/lang/zh-Hans.js:1816` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0810 | `site/i18n/lang/zh-Hans.js:1971` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0811 | `site/i18n/lang/zh-Hans.js:1985` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0812 | `site/i18n/lang/zh-Hans.js:2001` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0813 | `site/data/task_first_examples.json:77` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0814 | `site/data/task_first_examples.json:79` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0815 | `site/data/task_first_examples.json:108` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0816 | `site/data/task_first_examples.json:139` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0817 | `site/data/task_first_examples.json:141` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0818 | `site/data/task_first_examples.json:170` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0819 | `site/data/exam_sources/fixtures/noe_text/examId_9619.txt:1` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0820 | `site/data/exam_sources/fixtures/noe_text/examId_9646.txt:1` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0821 | `site/data/exam_sources/fixtures/noe_text/examId_9628.txt:1` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0822 | `site/data/exam_sources/fixtures/noe_text/examId_9629.txt:1` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0823 | `worker/README.md:53` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0824 | `worker/README.md:97` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0825 | `worker/README.md:115` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0826 | `worker/README.md:116` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0827 | `worker/wrangler.toml:38` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0828 | `worker/wrangler.toml:41` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0829 | `worker/wrangler.toml:48` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0830 | `worker/wrangler.toml:50` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0831 | `worker/test/digest_reply_to.test.mjs:45` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0832 | `worker/test/digest_reply_to.test.mjs:45` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0833 | `worker/test/digest_reply_to.test.mjs:78` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0834 | `worker/test/digest_reply_to.test.mjs:78` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0835 | `worker/test/digest_reply_to.test.mjs:79` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0836 | `worker/test/digest_reply_to.test.mjs:79` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0837 | `worker/test/digest_reply_to.test.mjs:81` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0838 | `worker/test/digest_reply_to.test.mjs:81` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0839 | `worker/test/digest_reply_to.test.mjs:82` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0840 | `worker/test/digest_reply_to.test.mjs:82` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0841 | `worker/test/digest_reply_to.test.mjs:90` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0842 | `worker/test/digest_reply_to.test.mjs:90` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0843 | `worker/test/digest_reply_to.test.mjs:93` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0844 | `worker/test/digest_reply_to.test.mjs:93` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0845 | `worker/test/digest_reply_to.test.mjs:94` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0846 | `worker/test/digest_reply_to.test.mjs:94` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0847 | `worker/test/session_pins.test.mjs:58` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0848 | `worker/test/session_pins.test.mjs:58` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0849 | `worker/test/session_pins.test.mjs:70` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0850 | `worker/test/session_pins.test.mjs:70` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0851 | `worker/test/session_pins.test.mjs:81` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0852 | `worker/test/session_pins.test.mjs:81` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0853 | `worker/test/session_pins.test.mjs:232` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0854 | `worker/test/session_pins.test.mjs:232` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0855 | `worker/test/session_pins.test.mjs:256` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0856 | `worker/test/session_pins.test.mjs:256` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0857 | `worker/test/session_pins.test.mjs:268` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0858 | `worker/test/session_pins.test.mjs:268` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0859 | `worker/test/session_pins.test.mjs:281` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0860 | `worker/test/session_pins.test.mjs:281` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0861 | `worker/test/session_pins.test.mjs:304` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0862 | `worker/test/session_pins.test.mjs:304` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0863 | `worker/test/session_pins.test.mjs:306` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0864 | `worker/test/session_pins.test.mjs:306` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0865 | `worker/test/session_pins.test.mjs:448` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0866 | `worker/test/session_pins.test.mjs:448` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0867 | `worker/test/session_pins.test.mjs:452` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0868 | `worker/test/session_pins.test.mjs:452` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0869 | `worker/test/rollup.test.mjs:28` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0870 | `worker/test/rollup.test.mjs:28` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0871 | `worker/test/rollup.test.mjs:29` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0872 | `worker/test/rollup.test.mjs:29` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0873 | `worker/test/rollup.test.mjs:30` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0874 | `worker/test/rollup.test.mjs:30` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0875 | `worker/test/rollup.test.mjs:46` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0876 | `worker/test/rollup.test.mjs:46` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0877 | `worker/test/rollup.test.mjs:47` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0878 | `worker/test/rollup.test.mjs:47` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0879 | `worker/test/rollup.test.mjs:50` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0880 | `worker/test/rollup.test.mjs:50` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0881 | `worker/test/rollup.test.mjs:51` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0882 | `worker/test/rollup.test.mjs:51` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0883 | `worker/test/rollup.test.mjs:57` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0884 | `worker/test/rollup.test.mjs:57` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0885 | `worker/test/rollup.test.mjs:58` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0886 | `worker/test/rollup.test.mjs:58` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0887 | `worker/test/rollup.test.mjs:59` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0888 | `worker/test/rollup.test.mjs:59` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0889 | `worker/test/rollup.test.mjs:67` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0890 | `worker/test/rollup.test.mjs:67` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0891 | `worker/test/rollup.test.mjs:68` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0892 | `worker/test/rollup.test.mjs:68` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0893 | `worker/test/rollup.test.mjs:69` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0894 | `worker/test/rollup.test.mjs:69` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0895 | `worker/test/rollup.test.mjs:70` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0896 | `worker/test/rollup.test.mjs:70` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0897 | `worker/test/rollup.test.mjs:71` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0898 | `worker/test/rollup.test.mjs:71` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0899 | `worker/test/rollup.test.mjs:77` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0900 | `worker/test/rollup.test.mjs:77` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0901 | `worker/test/markseen_policy.test.mjs:53` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0902 | `worker/test/markseen_policy.test.mjs:53` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0903 | `worker/test/markseen_policy.test.mjs:81` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0904 | `worker/test/markseen_policy.test.mjs:81` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0905 | `worker/test/markseen_policy.test.mjs:102` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0906 | `worker/test/markseen_policy.test.mjs:102` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0907 | `worker/test/markseen_policy.test.mjs:126` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0908 | `worker/test/markseen_policy.test.mjs:126` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0909 | `worker/test/unsub.test.mjs:9` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0910 | `worker/test/unsub.test.mjs:9` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0911 | `worker/test/unsub.test.mjs:13` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0912 | `worker/test/unsub.test.mjs:13` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0913 | `worker/test/unsub.test.mjs:18` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0914 | `worker/test/unsub.test.mjs:18` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0915 | `worker/test/unsub.test.mjs:19` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0916 | `worker/test/unsub.test.mjs:19` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0917 | `worker/test/unsub.test.mjs:25` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0918 | `worker/test/unsub.test.mjs:25` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0919 | `worker/test/unsub.test.mjs:26` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0920 | `worker/test/unsub.test.mjs:26` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0921 | `worker/test/digest_catchup.test.mjs:237` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0922 | `worker/test/digest_catchup.test.mjs:237` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0923 | `worker/test/digest_catchup.test.mjs:294` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0924 | `worker/test/digest_catchup.test.mjs:294` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0925 | `worker/test/digest_silently_skipped_after_event_dual_write.test.mjs:186` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0926 | `worker/test/digest_silently_skipped_after_event_dual_write.test.mjs:186` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0927 | `worker/test/mcp.test.mjs:82` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0928 | `worker/test/mcp.test.mjs:82` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0929 | `worker/test/confirm_email.test.mjs:57` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0930 | `worker/test/confirm_email.test.mjs:57` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0931 | `worker/test/confirm_email.test.mjs:58` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0932 | `worker/test/confirm_email.test.mjs:58` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0933 | `worker/test/feedback.test.mjs:67` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0934 | `worker/test/feedback.test.mjs:67` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0935 | `worker/test/feedback.test.mjs:131` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0936 | `worker/test/feedback.test.mjs:131` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0937 | `worker/test/construction_award_digest_d1_recency.test.mjs:279` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0938 | `worker/test/construction_award_digest_d1_recency.test.mjs:279` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0939 | `worker/test/home_cta_subscribe.test.mjs:22` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0940 | `worker/test/home_cta_subscribe.test.mjs:22` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0941 | `worker/test/token.test.mjs:14` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0942 | `worker/test/token.test.mjs:14` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0943 | `worker/test/token.test.mjs:17` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0944 | `worker/test/token.test.mjs:17` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0945 | `worker/test/token.test.mjs:22` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0946 | `worker/test/token.test.mjs:22` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0947 | `worker/test/token.test.mjs:29` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0948 | `worker/test/token.test.mjs:29` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0949 | `worker/test/inbound_helpers.test.mjs:25` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0950 | `worker/test/inbound_helpers.test.mjs:25` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0951 | `worker/test/inbound_helpers.test.mjs:26` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0952 | `worker/test/inbound_helpers.test.mjs:26` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0953 | `worker/test/inbound_helpers.test.mjs:27` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0954 | `worker/test/inbound_helpers.test.mjs:27` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0955 | `worker/test/prefs_lib.test.mjs:19` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0956 | `worker/test/prefs_lib.test.mjs:19` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0957 | `worker/test/prefs_lib.test.mjs:25` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0958 | `worker/test/prefs_lib.test.mjs:25` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0959 | `worker/test/prefs_lib.test.mjs:40` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0960 | `worker/test/prefs_lib.test.mjs:40` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0961 | `worker/test/subscriptions.test.mjs:6` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0962 | `worker/test/subscriptions.test.mjs:6` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0963 | `worker/test/subscriptions.test.mjs:9` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0964 | `worker/test/subscriptions.test.mjs:9` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0965 | `worker/test/subscriptions.test.mjs:20` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0966 | `worker/test/subscriptions.test.mjs:20` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0967 | `worker/test/subscriptions.test.mjs:23` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0968 | `worker/test/subscriptions.test.mjs:23` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0969 | `worker/test/subscriptions.test.mjs:32` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0970 | `worker/test/subscriptions.test.mjs:32` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0971 | `worker/test/subscriptions.test.mjs:39` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0972 | `worker/test/subscriptions.test.mjs:39` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0973 | `worker/test/subscriptions.test.mjs:49` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0974 | `worker/test/subscriptions.test.mjs:49` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0975 | `worker/test/subscriptions.test.mjs:51` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0976 | `worker/test/subscriptions.test.mjs:51` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0977 | `worker/test/subscriptions.test.mjs:53` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0978 | `worker/test/subscriptions.test.mjs:53` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0979 | `worker/test/subscriptions.test.mjs:58` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0980 | `worker/test/subscriptions.test.mjs:58` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0981 | `worker/test/award_watch.test.mjs:119` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0982 | `worker/test/award_watch.test.mjs:119` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0983 | `worker/test/search_health.test.mjs:120` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0984 | `worker/test/search_health.test.mjs:120` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0985 | `worker/e2e/routes.mjs:115` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0986 | `worker/src/inbound.mjs:101` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0987 | `worker/src/feedback.mjs:11` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0988 | `worker/src/feedback.mjs:22` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0989 | `worker/src/feedback.mjs:75` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0990 | `worker/src/subscribe.mjs:74` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0991 | `worker/src/alerts.mjs:309` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0992 | `worker/src/alerts.mjs:1031` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0993 | `worker/src/alerts.mjs:1098` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0994 | `worker/src/alerts.mjs:1381` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0995 | `worker/src/alerts.mjs:1436` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0996 | `worker/src/alerts.mjs:1579` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0997 | `worker/src/alerts.mjs:1584` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0998 | `worker/src/alerts.mjs:1587` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-0999 | `worker/src/alerts.mjs:1741` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-1000 | `worker/src/alerts.mjs:1749` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-1001 | `warehouse/fixtures/city-record-agency-rules/sample.json:171` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-1002 | `warehouse/fixtures/city-record-agency-rules/sample.json:472` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-1003 | `.github/workflows/deploy-worker.yml:57` | tip | benign-public | Intentional operational tone in public deployment workflow text. |
| PB-1004 | `.github/workflows/deploy-worker.yml:62` | tip | benign-public | Intentional operational tone in public deployment workflow text. |
| PB-1005 | `.github/workflows/ci.yml:475` | tip | benign-public | Intentional operational tone in public deployment workflow text. |
| PB-1006 | `docs/evidence/hosting-dual-host-metrics.json:1106` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1007 | `docs/evidence/hosting-dual-host-metrics.json:1126` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1008 | `docs/evidence/hosting-dual-host-metrics.json:1146` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1009 | `docs/evidence/hosting-dual-host-metrics.json:1166` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1010 | `docs/evidence/hosting-dual-host-metrics.json:1186` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1011 | `docs/evidence/hosting-dual-host-metrics.json:1225` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1012 | `docs/evidence/hosting-dual-host-metrics.json:1256` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1013 | `docs/evidence/hosting-dual-host-metrics.json:1276` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1014 | `docs/evidence/hosting-dual-host-metrics.json:1296` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1015 | `docs/evidence/hosting-dual-host-metrics.json:1316` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1016 | `docs/evidence/hosting-dual-host-metrics.json:1336` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1017 | `docs/evidence/hosting-dual-host-metrics.json:1375` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1018 | `docs/evidence/hosting-dual-host-metrics.json:1406` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1019 | `docs/evidence/hosting-dual-host-metrics.json:1426` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1020 | `docs/evidence/hosting-dual-host-metrics.json:1446` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1021 | `docs/evidence/hosting-dual-host-metrics.json:1466` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1022 | `docs/evidence/hosting-dual-host-metrics.json:1486` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1023 | `docs/evidence/hosting-dual-host-metrics.json:1525` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1024 | `docs/evidence/hosting-dual-host-metrics.json:2635` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1025 | `docs/evidence/hosting-dual-host-metrics.json:2655` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1026 | `docs/evidence/hosting-dual-host-metrics.json:2675` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1027 | `docs/evidence/hosting-dual-host-metrics.json:2695` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1028 | `docs/evidence/hosting-dual-host-metrics.json:2715` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1029 | `docs/evidence/hosting-dual-host-metrics.json:2754` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1030 | `docs/evidence/hosting-dual-host-metrics.json:2785` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1031 | `docs/evidence/hosting-dual-host-metrics.json:2805` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1032 | `docs/evidence/hosting-dual-host-metrics.json:2825` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1033 | `docs/evidence/hosting-dual-host-metrics.json:2845` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1034 | `docs/evidence/hosting-dual-host-metrics.json:2865` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1035 | `docs/evidence/hosting-dual-host-metrics.json:2904` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1036 | `docs/evidence/hosting-dual-host-metrics.json:2935` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1037 | `docs/evidence/hosting-dual-host-metrics.json:2955` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1038 | `docs/evidence/hosting-dual-host-metrics.json:2975` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1039 | `docs/evidence/hosting-dual-host-metrics.json:2995` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1040 | `docs/evidence/hosting-dual-host-metrics.json:3015` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1041 | `docs/evidence/hosting-dual-host-metrics.json:3054` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1042 | `docs/evidence/hosting-dual-host-metrics.json:4164` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1043 | `docs/evidence/hosting-dual-host-metrics.json:4184` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1044 | `docs/evidence/hosting-dual-host-metrics.json:4204` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1045 | `docs/evidence/hosting-dual-host-metrics.json:4224` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1046 | `docs/evidence/hosting-dual-host-metrics.json:4244` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1047 | `docs/evidence/hosting-dual-host-metrics.json:4283` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1048 | `docs/evidence/hosting-dual-host-metrics.json:4314` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1049 | `docs/evidence/hosting-dual-host-metrics.json:4334` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1050 | `docs/evidence/hosting-dual-host-metrics.json:4354` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1051 | `docs/evidence/hosting-dual-host-metrics.json:4374` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1052 | `docs/evidence/hosting-dual-host-metrics.json:4394` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1053 | `docs/evidence/hosting-dual-host-metrics.json:4433` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1054 | `docs/evidence/hosting-dual-host-metrics.json:4464` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1055 | `docs/evidence/hosting-dual-host-metrics.json:4484` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1056 | `docs/evidence/hosting-dual-host-metrics.json:4504` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1057 | `docs/evidence/hosting-dual-host-metrics.json:4524` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1058 | `docs/evidence/hosting-dual-host-metrics.json:4544` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1059 | `docs/evidence/hosting-dual-host-metrics.json:4583` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1060 | `docs/evidence/index-module-split.json:4` | tip | benign-public | Integrity or package digest for a public artifact; it is not credential material. |
| PB-1061 | `git:log` | history | benign-public | Aggregate public commit metadata; it does not disclose a location or itinerary. |
| PB-1062 | `tools/preflight-required-checks.sh:152` | tip | benign-public | Loopback URL used only by local test and development code. |
| PB-1063 | `test/functional/06_flags_benchmarks.py:5` | tip | benign-public | Loopback URL used only by local test and development code. |
| PB-1064 | `test/functional/11_accessibility.py:55` | tip | benign-public | Loopback URL used only by local test and development code. |
| PB-1065 | `test/functional/18_draft_alert_sync.py:24` | tip | benign-public | Loopback URL used only by local test and development code. |
| PB-1066 | `test/functional/08_follow_workspace_api.py:5` | tip | benign-public | Loopback URL used only by local test and development code. |
| PB-1067 | `test/functional/02_glance_today_property_a11y.py:5` | tip | benign-public | Loopback URL used only by local test and development code. |
| PB-1068 | `test/functional/run.sh:7` | tip | benign-public | Loopback URL used only by local test and development code. |
| PB-1069 | `test/functional/03_watch_quiz_feeds.py:5` | tip | benign-public | Loopback URL used only by local test and development code. |
| PB-1070 | `test/functional/12_language.py:10` | tip | benign-public | Loopback URL used only by local test and development code. |
| PB-1071 | `test/functional/10_changelog_stats.py:5` | tip | benign-public | Loopback URL used only by local test and development code. |
| PB-1072 | `test/functional/05_entity_pages_pivots.py:5` | tip | benign-public | Loopback URL used only by local test and development code. |
| PB-1073 | `test/functional/04_regression_quiz_parallel.py:5` | tip | benign-public | Loopback URL used only by local test and development code. |
| PB-1074 | `test/functional/14_focus_visible.py:16` | tip | benign-public | Loopback URL used only by local test and development code. |
| PB-1075 | `test/functional/16_external_links.py:41` | tip | benign-public | Loopback URL used only by local test and development code. |
| PB-1076 | `test/functional/01_permalinks_deadlines_people.py:5` | tip | benign-public | Loopback URL used only by local test and development code. |
| PB-1077 | `test/functional/09_regression_dns_fallback.py:7` | tip | benign-public | Loopback URL used only by local test and development code. |
| PB-1078 | `test/functional/07_dollars_matter_timeline.py:2` | tip | benign-public | Loopback URL used only by local test and development code. |
| PB-1079 | `test/functional/07_dollars_matter_timeline.py:6` | tip | benign-public | Loopback URL used only by local test and development code. |
| PB-1080 | `test/standards/label_coverage.py:22` | tip | benign-public | Loopback URL used only by local test and development code. |
| PB-1081 | `test/standards/heading_uniqueness.py:22` | tip | benign-public | Loopback URL used only by local test and development code. |
| PB-1082 | `site/stats.html:458` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1083 | `site/index.html:2174` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1084 | `site/about.html:312` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1085 | `site/api.html:230` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1086 | `site/media/review/data-viz-intuitive/measurements.json:4` | tip | benign-public | Integrity or package digest for a public artifact; it is not credential material. |
| PB-1087 | `worker/README.md:198` | tip | benign-public | Loopback URL used only by local test and development code. |
| PB-1088 | `worker/package-lock.json:12` | tip | benign-public | Integrity or package digest for a public artifact; it is not credential material. |
| PB-1089 | `worker/package-lock.json:1185` | tip | benign-public | Integrity or package digest for a public artifact; it is not credential material. |
| PB-1090 | `worker/package.json:12` | tip | benign-public | Integrity or package digest for a public artifact; it is not credential material. |
| PB-1091 | `worker/wrangler.toml:68` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1092 | `worker/wrangler.toml:115` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1093 | `worker/wrangler.toml:121` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1094 | `worker/wrangler.toml:125` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1095 | `worker/wrangler.toml:132` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1096 | `worker/wrangler.toml:139` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1097 | `worker/test/feedback.test.mjs:148` | tip | benign-public | Loopback URL used only by local test and development code. |
| PB-1098 | `worker/test/feedback.test.mjs:152` | tip | benign-public | Loopback URL used only by local test and development code. |
| PB-1099 | `worker/test/multi_watch.test.mjs:19` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1100 | `worker/scripts/backfill-history.mjs:22` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1101 | `worker/scripts/backfill-history.mjs:23` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1102 | `worker/e2e/usage.mjs:3` | tip | benign-public | Loopback URL used only by local test and development code. |
| PB-1103 | `worker/e2e/suggestions.mjs:9` | tip | benign-public | Loopback URL used only by local test and development code. |
| PB-1104 | `worker/e2e/nl.mjs:3` | tip | benign-public | Loopback URL used only by local test and development code. |
| PB-1105 | `worker/src/checkbook_lifecycle.mjs:715` | tip | benign-public | Loopback URL used only by local test and development code. |
| PB-1106 | `worker/src/usage.mjs:22` | tip | benign-public | Loopback URL used only by local test and development code. |
| PB-1107 | `worker/src/usage.mjs:23` | tip | benign-public | Loopback URL used only by local test and development code. |
| PB-1108 | `worker/src/usage.mjs:24` | tip | benign-public | Loopback URL used only by local test and development code. |
| PB-1109 | `worker/src/inv.mjs:18` | tip | benign-public | Loopback URL used only by local test and development code. |
| PB-1110 | `worker/src/external_award.mjs:324` | tip | benign-public | Loopback URL used only by local test and development code. |
| PB-1111 | `worker/src/subsidy_lifecycle.mjs:243` | tip | benign-public | Loopback URL used only by local test and development code. |
| PB-1112 | `worker/src/subsidy_lifecycle.mjs:244` | tip | benign-public | Loopback URL used only by local test and development code. |
| PB-1113 | `worker/src/batch.mjs:25` | tip | benign-public | Loopback URL used only by local test and development code. |
| PB-1114 | `worker/src/suggest.mjs:139` | tip | benign-public | Loopback URL used only by local test and development code. |
| PB-1115 | `worker/src/prior_cycle.mjs:184` | tip | benign-public | Loopback URL used only by local test and development code. |
| PB-1116 | `worker/src/agency.mjs:21` | tip | benign-public | Loopback URL used only by local test and development code. |
| PB-1117 | `worker/src/lib/session.mjs:27` | tip | benign-public | Loopback URL used only by local test and development code. |
| PB-1118 | `worker/src/lib/session.mjs:28` | tip | benign-public | Loopback URL used only by local test and development code. |
| PB-1119 | `worker/src/lib/session.mjs:29` | tip | benign-public | Loopback URL used only by local test and development code. |
| PB-1120 | `warehouse/fixtures/city-record-agency-rules/sample.json:472` | tip | benign-public | Integrity or provenance digest for a public artifact; it is not credential material. |
| PB-1121 | `.git/config:user.name` | local | benign-public | Repository-local merge-test identity; it is not a personal identity or shipped file. |
| PB-1122 | `.git/config:user.email` | local | benign-public | Repository-local merge-test identity; it is not a personal identity or shipped file. |
| PB-1123 | `git:log` | history | benign-public | Aggregate public commit metadata; it does not disclose a private schedule. |
| PB-1124 | `AGENTS.md` | tip | benign-public | Public contributor instructions are intentionally committed as the repository's project contract. |
| PB-1125 | `AGENTS.md:833` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-1126 | `AGENTS.md:1780` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-1127 | `docs/architecture.md:7` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-1128 | `docs/architecture.md:101` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-1129 | `docs/architecture.md:122` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-1130 | `docs/architecture.md:128` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-1131 | `docs/architecture.md:154` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-1132 | `docs/architecture.md:174` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-1133 | `docs/architecture.md:217` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-1134 | `docs/architecture.md:218` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-1135 | `docs/architecture.md:240` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-1136 | `docs/architecture.md:242` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-1137 | `docs/architecture.md:247` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-1138 | `docs/architecture.md:248` | tip | benign-public | The text clearly marks or tests derived values; it does not hide derived data. |
| PB-1139 | `docs/architecture.md:140` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-1140 | `docs/architecture.md:142` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-1141 | `docs/architecture.md:143` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-1142 | `docs/architecture.md:195` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-1143 | `docs/architecture.md:222` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |
| PB-1144 | `docs/architecture.md:239` | tip | benign-public | Published site, agency, or fixture contact address required for product behavior or source fidelity. |

## Escalations

None. No history rewrite or credential rotation is indicated by the reviewed material.
