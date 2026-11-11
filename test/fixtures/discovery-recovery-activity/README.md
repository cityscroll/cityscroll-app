# Discovery-recovery frozen district-activity

Pinned `district_activity.json` bytes for the discovery-recovery local proof
(`tools/discovery_recovery_journey.py` `FROZEN_ACTIVITY.blob`).

The capture server still serves by blob id (`git cat-file`). This committed
file keeps those bytes in the tip tree so shallow checkouts can resolve the
pin without a historical object pack.

- Observed base: `site/data/district_activity.json` at revision
  `d886b385d647f4534df985f5922749a9414fab26`, blob
  `5deaa202fe578e09b58380d43755419dbb85ec60`
- Current pin: blob `559cb7204c3d3484df792cd42def54ec7af36b1e`
- Derivation: single citywide meeting swap
  `meeting:nyc_legistar_events:22568` → `meeting:nyc_legistar_events:22854`
  because `22568` left the shared meeting read model. Derived snapshot, not
  observed live. Clock, midwood, zero, unsupported, suggestions, and
  citywide total stay as in the `5deaa202` controls.

Independent of `test/fixtures/near-you-location-activity/` (functional Near You
location shard); editing one does not require editing the other.
