# Performance-budget audit: August 2026

## Decision

The red streak was payload growth, not p95 sampling noise. Seven consecutive main landings after the #447 baseline increased cold-home gzip bytes from 442,919 to 464,084 while the ceiling stayed at 445,000; the measured sequence and each landing's delta are below. The byte value was identical in all 20 samples of every audited run and in all seven same-SHA rerun pairs.

The later 475,000 ceiling is now too loose. Main is 451,792 bytes in both [run 30889913232](https://github.com/cityscroll/crol-list/actions/runs/30889913232) and its same-SHA [run 30889548508](https://github.com/cityscroll/crol-list/actions/runs/30889548508), so this change sets 455,000: 3,208 bytes or 0.71% headroom. The next ratchet target is **under 445,000** (reclaim 6,792 bytes or 1.50% from current main); under 435,000 remains the follow-on after a home-path load split (16,792 bytes or 3.72%). Those deltas use the 451,792-byte current measurements above.

The harness keeps 20 measured samples and one discarded warmup. More samples would repeat the same static byte census; it would not correct the historical ceiling drift. Instead, each cold-run artifact now records the gzip bytes of every loaded file and fails if the file inventory changes across its 20 measured samples. A future byte red therefore includes its contributors rather than only a total.

## What failed

In the latest 30 measured jobs, 26 passed and four failed. Three failures were deterministic byte overruns: 464,084 against 445,000 in [run 30879313155](https://github.com/cityscroll/crol-list/actions/runs/30879313155) and same-SHA [run 30879046417](https://github.com/cityscroll/crol-list/actions/runs/30879046417), plus 471,794 against 445,000 in [run 30879078830](https://github.com/cityscroll/crol-list/actions/runs/30879078830). The fourth was a real recurring desktop layout state in [run 30886747550](https://github.com/cityscroll/crol-list/actions/runs/30886747550): CLS was 0.137663 in 4/20 cold samples and 2/20 warm samples, above the 0.1 ceiling. It was not a one-sample spike that a larger sample count would erase.

Seven same-SHA pairs had zero byte spread and zero verdict flips. The largest paint-p95 difference was 20.2 ms on `43e027fd`; both [run 30879313155](https://github.com/cityscroll/crol-list/actions/runs/30879313155) and [run 30879046417](https://github.com/cityscroll/crol-list/actions/runs/30879046417) failed for the same byte overrun, not paint.

| SHA | Source runs | Cold bytes in both | Largest FCP/LCP p95 difference | Verdict |
|:---|:---|---:|---:|:---|
| `a1d09316` | [30889913232](https://github.com/cityscroll/crol-list/actions/runs/30889913232) / [30889548508](https://github.com/cityscroll/crol-list/actions/runs/30889548508) | 451,792 | 7.8 ms | pass / pass |
| `ef4fcc2f` | [30888307788](https://github.com/cityscroll/crol-list/actions/runs/30888307788) / [30887883603](https://github.com/cityscroll/crol-list/actions/runs/30887883603) | 456,467 | 15.8 ms | pass / pass |
| `2f3d90cb` | [30885553226](https://github.com/cityscroll/crol-list/actions/runs/30885553226) / [30885147872](https://github.com/cityscroll/crol-list/actions/runs/30885147872) | 456,215 | 12.2 ms | pass / pass |
| `d4e278bd` | [30881559646](https://github.com/cityscroll/crol-list/actions/runs/30881559646) / [30881270290](https://github.com/cityscroll/crol-list/actions/runs/30881270290) | 456,073 | 20.0 ms | pass / pass |
| `7ad804f9` | [30881544242](https://github.com/cityscroll/crol-list/actions/runs/30881544242) / [30881269564](https://github.com/cityscroll/crol-list/actions/runs/30881269564) | 455,361 | 11.4 ms | pass / pass |
| `572cdd75` | [30880272235](https://github.com/cityscroll/crol-list/actions/runs/30880272235) / [30880000323](https://github.com/cityscroll/crol-list/actions/runs/30880000323) | 472,611 | 8.0 ms | pass / pass |
| `43e027fd` | [30879313155](https://github.com/cityscroll/crol-list/actions/runs/30879313155) / [30879046417](https://github.com/cityscroll/crol-list/actions/runs/30879046417) | 464,084 | 20.2 ms | fail / fail |

Expected false-positive rate after this change is 0% for unchanged bytes: the metric is a gzip census of local files, the observed same-SHA byte spread was 0 bytes in 7/7 pairs above, and inventory instability is now an explicit failure. The operational expectation for the combined check is also 0% within the observed envelope because no same-SHA verdict flipped in 7/7 pairs. That repeat set is small: with zero flips in seven pairs, the one-sided 95% binomial upper bound is 34.8%, so 0% is an engineering forecast rather than a population claim.

## Per-landing attribution

Each delta below is the difference from the preceding listed main run. The seven 445,000-budget runs after #447 through #462 were all red; #455 raised the ceiling to 475,000 in the same change that reached 472,611 bytes.

| Landing | Main source run | Cold bytes | Delta |
|:---|:---|---:|---:|
| #447 Property lens + design tokens baseline | [30874441414](https://github.com/cityscroll/crol-list/actions/runs/30874441414) | 442,919 | baseline |
| #456 prime-win outreach | [30874491841](https://github.com/cityscroll/crol-list/actions/runs/30874491841) | 447,620 | +4,701 |
| #459 exam-interest alerts | [30875440482](https://github.com/cityscroll/crol-list/actions/runs/30875440482) | 449,184 | +1,564 |
| #457 registration dwell | [30875698503](https://github.com/cityscroll/crol-list/actions/runs/30875698503) | 450,296 | +1,112 |
| #460 hearing calendar and testimony pack | [30876672223](https://github.com/cityscroll/crol-list/actions/runs/30876672223) | 451,818 | +1,522 |
| #458 M/WBE outreach | [30876754745](https://github.com/cityscroll/crol-list/actions/runs/30876754745) | 461,637 | +9,819 |
| #448 unified Alerts | [30876999972](https://github.com/cityscroll/crol-list/actions/runs/30876999972) | 463,262 | +1,625 |
| #462 Property watches and exports | [30879313155](https://github.com/cityscroll/crol-list/actions/runs/30879313155) | 464,084 | +822 |
| #455 Rules monitor packs + 475,000 rebaseline | [30880272235](https://github.com/cityscroll/crol-list/actions/runs/30880272235) | 472,611 | +8,527 |
| #464 district digest + deferred home alert modules | [30881544242](https://github.com/cityscroll/crol-list/actions/runs/30881544242) | 455,361 | -17,250 |
| #442 attachment tables | [30881559646](https://github.com/cityscroll/crol-list/actions/runs/30881559646) | 456,073 | +712 |
| #468 Meetings lens template | [30885553226](https://github.com/cityscroll/crol-list/actions/runs/30885553226) | 456,215 | +142 |
| #465 Zoning lens template | [30888307788](https://github.com/cityscroll/crol-list/actions/runs/30888307788) | 456,467 | +252 |
| #461 Contracts lens template + source compaction | [30889913232](https://github.com/cityscroll/crol-list/actions/runs/30889913232) | 451,792 | -4,675 |

The net after #447 is +8,873 bytes: 451,792 in [run 30889913232](https://github.com/cityscroll/crol-list/actions/runs/30889913232) minus 442,919 in [run 30874441414](https://github.com/cityscroll/crol-list/actions/runs/30874441414). The 475,000 ceiling consequently leaves 23,208 bytes or 5.14% headroom on current main; 455,000 reduces that to 3,208 bytes or 0.71%, using the same current run.

An exact reproduction of current [run 30889913232](https://github.com/cityscroll/crol-list/actions/runs/30889913232) found 45 loaded files totaling the same 451,792 bytes. The five largest entries total 165,641 bytes or 36.66%; they are optimization candidates, not promised savings because only part of each file may be deferrable.

| Current cold-home file | Gzip bytes |
|:---|---:|
| `i18n.js` | 63,669 |
| `index.html` | 38,716 |
| `app/alerts.mjs` | 22,588 |
| `app/property.mjs` | 20,607 |
| `action_registry.js` | 20,061 |

The next 6,792-byte reduction should start with non-home code in `app/alerts.mjs`, `action_registry.js`, and lens modules currently loaded by the ordered home graph. Their measured current sizes are 22,588, 20,061, and 20,607 bytes respectively in the reproduction of [run 30889913232](https://github.com/cityscroll/crol-list/actions/runs/30889913232); the audit does not assume all of those bytes can be deferred.

## Latest 30 measured jobs

`m · d` means mobile then desktop. Cold bytes were equal in both viewports. FCP and LCP are p95 milliseconds.

| Run | SHA | Budget | Result | Cold bytes | Cold FCP/LCP m · d (ms) | Warm FCP/LCP m · d (ms) |
|---:|:---|---:|:---:|---:|:---|:---|
| [30889913232](https://github.com/cityscroll/crol-list/actions/runs/30889913232) | `a1d09316` | 475000 | PASS | 451792 | 96/96 · 92.2/92.2 | 88.2/88.2 · 96.2/96.2 |
| [30889548508](https://github.com/cityscroll/crol-list/actions/runs/30889548508) | `a1d09316` | 475000 | PASS | 451792 | 88.2/88.2 · 92.2/92.2 | 84.4/84.4 · 92/92 |
| [30888675900](https://github.com/cityscroll/crol-list/actions/runs/30888675900) | `e06bbd8d` | 475000 | PASS | 451792 | 104.2/104.2 · 104.6/104.6 | 88/88 · 96/96 |
| [30888307788](https://github.com/cityscroll/crol-list/actions/runs/30888307788) | `ef4fcc2f` | 475000 | PASS | 456467 | 88.6/88.6 · 96/96 | 85.2/85.2 · 96/96 |
| [30888006327](https://github.com/cityscroll/crol-list/actions/runs/30888006327) | `743ffee6` | 475000 | PASS | 451568 | 88.6/88.6 · 100/100 | 84.2/84.2 · 100/100 |
| [30887883603](https://github.com/cityscroll/crol-list/actions/runs/30887883603) | `ef4fcc2f` | 475000 | PASS | 456467 | 72.8/72.8 · 84.2/84.2 | 72.2/72.2 · 88.2/88.2 |
| [30886747550](https://github.com/cityscroll/crol-list/actions/runs/30886747550) | `3606d9e5` | 475000 | FAIL | 451504 | 88.2/88.2 · 92/92 | 80.8/80.8 · 92.6/92.6 |
| [30885922028](https://github.com/cityscroll/crol-list/actions/runs/30885922028) | `91ca9f33` | 475000 | PASS | 456467 | 88.4/88.4 · 100/100 | 92.4/92.4 · 108/108 |
| [30885553226](https://github.com/cityscroll/crol-list/actions/runs/30885553226) | `2f3d90cb` | 475000 | PASS | 456215 | 96.2/96.2 · 100.6/100.6 | 84/84 · 109.4/109.4 |
| [30885147872](https://github.com/cityscroll/crol-list/actions/runs/30885147872) | `2f3d90cb` | 475000 | PASS | 456215 | 100.2/100.2 · 104.4/104.4 | 92/92 · 97.2/97.2 |
| [30884402660](https://github.com/cityscroll/crol-list/actions/runs/30884402660) | `812cbd96` | 475000 | PASS | 456481 | 100.4/100.4 · 104/104 | 88.2/88.2 · 100.2/100.2 |
| [30884034362](https://github.com/cityscroll/crol-list/actions/runs/30884034362) | `a39d9c86` | 475000 | PASS | 456476 | 92/92 · 92/92 | 80.6/80.6 · 92.2/92.2 |
| [30884024322](https://github.com/cityscroll/crol-list/actions/runs/30884024322) | `c9e2d56a` | 475000 | PASS | 456215 | 84.4/84.4 · 100.4/100.4 | 80/80 · 92.2/92.2 |
| [30882690267](https://github.com/cityscroll/crol-list/actions/runs/30882690267) | `63721562` | 445000 | PASS | 443340 | 80.4/80.4 · 84/84 | 80.4/80.4 · 88.2/88.2 |
| [30882325235](https://github.com/cityscroll/crol-list/actions/runs/30882325235) | `103f7592` | 445000 | PASS | 443138 | 100.4/100.4 · 92/92 | 88.2/88.2 · 92/92 |
| [30881559646](https://github.com/cityscroll/crol-list/actions/runs/30881559646) | `d4e278bd` | 475000 | PASS | 456073 | 96/96 · 100.2/100.2 | 84.2/84.2 · 112/112 |
| [30881544242](https://github.com/cityscroll/crol-list/actions/runs/30881544242) | `7ad804f9` | 475000 | PASS | 455361 | 96.2/96.2 · 112.2/112.2 | 84.8/84.8 · 96/96 |
| [30881270290](https://github.com/cityscroll/crol-list/actions/runs/30881270290) | `d4e278bd` | 475000 | PASS | 456073 | 96.4/96.4 · 92.8/92.8 | 80/80 · 92/92 |
| [30881269564](https://github.com/cityscroll/crol-list/actions/runs/30881269564) | `7ad804f9` | 475000 | PASS | 455361 | 96.2/96.2 · 100.8/100.8 | 84/84 · 96.6/96.6 |
| [30881266304](https://github.com/cityscroll/crol-list/actions/runs/30881266304) | `ad4be0c2` | 445000 | PASS | 443332 | 96.4/96.4 · 96.6/96.6 | 84.8/84.8 · 93/93 |
| [30880697425](https://github.com/cityscroll/crol-list/actions/runs/30880697425) | `31d7bb42` | 475000 | PASS | 473328 | 88.4/88.4 · 92.8/92.8 | 80.6/80.6 · 92.6/92.6 |
| [30880656541](https://github.com/cityscroll/crol-list/actions/runs/30880656541) | `74aa7a7f` | 475000 | PASS | 455361 | 100.4/100.4 · 108.6/108.6 | 100.4/100.4 · 108.2/108.2 |
| [30880272235](https://github.com/cityscroll/crol-list/actions/runs/30880272235) | `572cdd75` | 475000 | PASS | 472611 | 92.6/92.6 · 104.4/104.4 | 88/88 · 104/104 |
| [30880248000](https://github.com/cityscroll/crol-list/actions/runs/30880248000) | `4d440d2d` | 445000 | PASS | 443181 | 96.2/96.2 · 100.4/100.4 | 92.2/92.2 · 104/104 |
| [30880004830](https://github.com/cityscroll/crol-list/actions/runs/30880004830) | `e96bd3be` | 445000 | PASS | 443411 | 96.4/96.4 · 96.6/96.6 | 84.2/84.2 · 96/96 |
| [30880000323](https://github.com/cityscroll/crol-list/actions/runs/30880000323) | `572cdd75` | 475000 | PASS | 472611 | 88.2/88.2 · 96.4/96.4 | 84.2/84.2 · 100.2/100.2 |
| [30879700496](https://github.com/cityscroll/crol-list/actions/runs/30879700496) | `57c5d03f` | 475000 | PASS | 472611 | 92.6/92.6 · 104.6/104.6 | 88.8/88.8 · 108/108 |
| [30879313155](https://github.com/cityscroll/crol-list/actions/runs/30879313155) | `43e027fd` | 445000 | FAIL | 464084 | 96.2/96.2 · 104.4/104.4 | 84/84 · 97/97 |
| [30879078830](https://github.com/cityscroll/crol-list/actions/runs/30879078830) | `01c18c62` | 445000 | FAIL | 471794 | 104.2/104.2 · 108/108 | 92/92 · 104/104 |
| [30879046417](https://github.com/cityscroll/crol-list/actions/runs/30879046417) | `43e027fd` | 445000 | FAIL | 464084 | 76/76 · 84.4/84.4 | 80.2/80.2 · 84.4/84.4 |

## Earlier wave anchors

The cited earlier failures have the same signature. #435 measured 436,826 against 430,000 in [run 30867718928](https://github.com/cityscroll/crol-list/actions/runs/30867718928); #436 measured 436,874 against 435,000 in [run 30867719484](https://github.com/cityscroll/crol-list/actions/runs/30867719484). #437 passed at 439,898 against the then-raised 440,000 ceiling in [run 30870602914](https://github.com/cityscroll/crol-list/actions/runs/30870602914). These are deterministic payload steps separated by budget edits, not same-commit sampling flips.
