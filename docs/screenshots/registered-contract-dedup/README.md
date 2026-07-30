# Registered-contract identity (distinct contract id)

Field case: `#notice/20231222103` (DHS award, $24.44M).

**Before:** Checkbook Contracts returns seven rows for `CT107120248803393` (one Prime Vendor + six Sub Vendor slices). The lifecycle treated each row as a separate contract and showed “Multiple contracts found”.

**After:** Rows are aggregated by distinct `prime_contract_id` before disambiguation. One id → confident registered contract with the max/current amount; the “Follow the dollars” panel shows the same contract without the false multi-match warning.

True multi-id PINs still warn as ambiguous.
