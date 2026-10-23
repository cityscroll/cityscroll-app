# Legislative matter window-pin fixtures

Frozen lookup slices for acceptance suites that previously pinned exact
appearance IDs / next-event chains against live `site/data/legislative_matter_lookup.json`.

Scheduled first-class refresh rewrites that live lookup when the publisher
join window rolls. These fixtures keep assertion strength unchanged instead of
retargeting named records after every refresh.

- `civic_law_matter_78605_lookup.json` — LU 0056-2026 single retained appearance
  with named roll-call rows (civic-law matter document render).
- `a6_matter_79201_lookup.json` — LU 0115-2026 two-appearance chain for PHC-04
  next-event projection (layover then approval).
