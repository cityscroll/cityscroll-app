# Making the reduced card-work profile safe for functional tests

Measured at revision `9ae3afd8e4f1b403beda6dfec9ce005983a08ebd`, in a provisioned
reduced card-work checkout and in the full-checkout control on the same machine.
Every figure below comes from a receipt in [`raw/`](raw/).

## The failure this replaces

`tools/prepare_functional_site.sh` materialises the static-first document routes
the functional browser family is served from. It runs a read-model builder and
then copies the site tree. The reduced profile deferred twenty of the read models
the builder opens, and the result was unreadable in two different ways depending
on how far a run got.

**The builder died on a bare `ENOENT`** naming one file, with nothing about
profiles, nothing about which builder wanted it, and nothing about what to run
([`raw/before-builder-enoent.txt`](raw/before-builder-enoent.txt), exit 1):

```
Error: ENOENT: no such file or directory, open '<repo>/site/data/money_default_open.json'
    at readFileSync (node:fs:441:20)
    at json (<repo>/tools/build_primary_documents.mjs:31:21)
```

**And the copy step after it cannot fail at all.** `tools/build_public_site.mjs`
walks the working tree and copies what it finds, so a checkout holding only part
of the corpus builds a smaller site and reports success. The browser check then
waits for a row that was never going to render, and times out:

```
playwright._impl._errors.TimeoutError: Locator.wait_for: Timeout 45000ms exceeded.
  - waiting for locator("#list .row").first to be visible
```

That is the same symptom `test/fixtures/mobile_contracts_list_no_rows.json`
records as `Contracts mobile surface waits for #list .row`. A provisioning gap
arrived looking like an empty Browse result, which is the specific confusion this
card exists to remove.

## What changed

The corpus is now **declared, derived, and materialised**, and it is **asserted
before the preparation step runs**.

| | |
| --- | --- |
| Declaration | `functional_corpus` in `tools/card-profile/closure.v1.json`, derived by `tools/derive_card_profile.mjs` from the `functional-site` gate-class observation and a scan of the declared functional harness sources. Not hand-written. |
| Materialisation | The corpus is unioned into the profile set before the deferred/static split, so it can never be routed into the deferred hydration set. A fresh reduced checkout holds it. |
| Assertion | `tools/verify_functional_corpus.mjs --check` runs as the first statement of `tools/prepare_functional_site.sh`, under `set -euo pipefail`. |

The gate reports on **inputs only** and runs **before** the functional command.
It never wraps a test, so it has no way to convert a functional failure into a
dependency skip.

## Before and after, same checkout, same revision

| | CI-10 profile (before) | CI-11 profile (after) | Full-checkout control |
| --- | --- | --- | --- |
| Active profile | `card-work` | `card-work` | `full-checkout` |
| Corpus declared / materialised | 30 / **10** | 30 / **30** | 30 / **30** |
| Corpus fingerprint | `0bb40d3e9f60…` | `0bb40d3e9f60…` | `0bb40d3e9f60…` |
| Readiness outcome | **blocked** (exit 6) | ready (exit 0) | ready (exit 0) |
| Source vintage | not readable — the anchor itself was deferred | `2026-08-15` | `2026-08-15` |
| `prepare_functional_site.sh` | exit 1, bare `ENOENT` | exit 0, 2,606 ms | exit 0, 3,795 ms |
| `23_mobile_viewport.py` | not run | **OK**, 5,610 ms | **OK**, 12,649 ms |
| Served `_site` | — | 140.3 MiB | 583.0 MiB |

The corpus fingerprint is identical in all three columns because it is taken from
index blob identity rather than the working tree. That is what makes it the same
number in a reduced and a full checkout, and what lets a receipt from one be
compared against a receipt from the other.

Receipts: [`before-readiness-blocked.json`](raw/before-readiness-blocked.json),
[`after-readiness-ready.json`](raw/after-readiness-ready.json),
[`control-full-readiness.json`](raw/control-full-readiness.json).

## What a blocked run says

Structured, and explicit that no coverage was obtained
([`raw/before-readiness-blocked.txt`](raw/before-readiness-blocked.txt), exit 6):

```
functional corpus BLOCKED - the functional suite was not run and no coverage was obtained.
  missing-corpus: 20 declared functional corpus path(s) are not materialised in the active card-work profile.
    site/data/agency_constellation_lookup.json
    ... and 10 more
  builder that needs them: tools/build_primary_documents.mjs
  remediation: tools/provision_card_profile.sh hydrate site/data/...
  or take the full-checkout control: tools/provision_card_profile.sh hydrate --full
```

The receipt carries `outcome: "blocked"`, `functional_coverage: "none"`, and a
`coverage_statement` that says in words that this is a provisioning result and
says nothing about whether the application behaves correctly. There is no exit
path on which a missing corpus produces a zero exit status, and no branch that
reports a skip.

## Footprint

Both columns measured on the full-checkout control, so every path contributes its
real size in both.

| | CI-10 baseline | CI-11 | Delta |
| --- | ---: | ---: | ---: |
| Reduced profile paths | 3,900 / 142.89 MiB | 3,920 / 186.02 MiB | **+20 / +43.13 MiB** |
| Deferred hydration set | 311 / 230.25 MiB | 296 / 211.24 MiB | −15 / −19.01 MiB |
| Excluded from the profile | 2,010 / 641.28 MiB | 1,990 / 598.13 MiB | −20 / −43.14 MiB |
| Sparse patterns | 778 | 795 | +17 |
| Tracked total | 5,910 / 822.2 MB | 5,910 / 822.2 MB | unchanged |

**The reduced profile goes from 149.8 MB to 195.1 MB of logical tracked bytes**,
which stays inside the 205 MB-class budget the profile is declared against. The
twenty paths move from the excluded set into the profile; nothing is
double-counted, because the three categories partition the tracked total in both
columns.

The declared corpus is 30 paths totalling 73.78 MiB. Ten of them were already in
the profile, so the twenty newly materialised paths are the whole cost of this
card. No object-store or cache saving is claimed anywhere here.

## Bounds on what this covers

- **The reduced profile still serves a smaller site.** `_site` is 140.3 MiB in the
  reduced profile against 583.0 MiB in the control. The corpus makes the measured
  functional tests correct, not the whole site complete. Only
  `test/functional/23_mobile_viewport.py` was run end to end in a provisioned
  reduced checkout, and only it is claimed as measured coverage; the closure
  records that in `functional_corpus.measured_functional_tests`.
- **The full checkout, CI, deployment, architecture, evidence and release
  surfaces are untouched.** They keep routing to the full control, and the full
  control produced the same test result through the same preparation script.
- **The harness scan is a scan, not a proof.** `tools/derive_card_profile.mjs`
  reads the tracked read models the declared Python harness sources reference,
  because the Node sentinel cannot see a Python read. A harness that starts
  reading another read model is caught by regenerating the profile, and by the
  test in `test/functional_corpus_readiness.test.mjs` that re-runs the scan and
  fails if the corpus omits anything it finds.

## Reproducing this

From a full checkout, so the derive and the observation both see every path:

```bash
node tools/verify_card_profile.mjs --record functional-site -- node tools/build_primary_documents.mjs
node tools/derive_card_profile.mjs
```

Then, in a provisioned reduced checkout:

```bash
node tools/verify_functional_corpus.mjs --check --receipt-out <receipt.json>
tools/prepare_functional_site.sh
python3 tools/local_site_server.py --directory _site --port 0 --ready-file <ready>
CROL_BASE=<base> python3 test/functional/23_mobile_viewport.py
```

The profile derived in the reduced checkout and the profile derived in the full
control agreed exactly at this revision — 795 patterns over 3,920 paths, the same
30-path corpus — with `sources_skipped_not_materialised: 0` in both. The
committed manifest is the full-checkout one.
