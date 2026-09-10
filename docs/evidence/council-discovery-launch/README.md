# Council discovery launch evidence

Read-only production GET evidence that a newly announced Council calendar
hearing is visible on Meetings, Search, Now, canonical detail, ICS, and watch
preview. The Events-feed publisher key is EventId 22691. The public InSite
calendar number 1439673 is a measured cross-reference for the same proceeding,
never an EventId.

`production-readback.json` is a dated live observation, not a rolling release
gate. After 2026-09-23 the pinned 2026-09-09 fixture in
`test/fixtures/legistar/upcoming_contracts_22691.json` continues to prove the
same path deterministically. A path that was not live when this read ran is
`not-yet-observed`, never `passed`.

```bash
node tools/council_discovery_launch_readback.mjs
node tools/council_discovery_launch_readback.mjs --check
```
