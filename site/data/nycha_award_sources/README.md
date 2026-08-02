# Checkbook NYC NYCHA contracts — join recon

Source contract: `checkbook-nycha-contracts` (`Contracts_NYCHA` on Checkbook NYC).

## Verdict (2026-08-01)

**Disabled for product materialization of confident exact solicitation→award matches.**

Strict temporal exact-PIN join usefulness is below the ~30% threshold on the modern product
universe. Checkbook remains reachable; the empty product surface is a join/key-space result, not
an ingest outage.

## Strategy

| Strategy | Ship? | Notes |
|---|---|---|
| `exact_pin_temporal` | yes (ranker only) | Agreement.pin = notice.pin and contract date after solicitation |
| PIN reuse without temporal | no | Same PIN, older award (e.g. 2011 dinner under PIN later reused for a renovation RFQ) |
| Purpose/title fuzzy | no | Checkbook purpose IDs and City Record RFQ numbers often do not share a key |

## Artifacts

- Verification receipt: `verification_receipts/nycha_awards_2026-08-01.json`
- Pure helpers: `worker/src/lib/nycha_awards_join.mjs`
- Characterization: `node --test test/nycha_awards_join.test.mjs worker/test/external_award.test.mjs`
