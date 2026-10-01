# Near You location frozen district-activity

Pinned `district_activity.json` for `test/functional/32_near_you_location.py`.

The functional browser shard uses a shallow checkout that does not carry historical
git blobs. Serving this committed file keeps citywide / virtual / unlocated bags
stable across daily first-class refresh without `git cat-file`.

- Source path: `site/data/district_activity.json`
- Source revision: `d886b385d647f4534df985f5922749a9414fab26`
- Git blob id: `5deaa202fe578e09b58380d43755419dbb85ec60` (also the discovery-recovery /
  default-local-home pin)
- Same bytes as `git cat-file blob 5deaa202fe578e09b58380d43755419dbb85ec60`
