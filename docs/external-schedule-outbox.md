# Independent correctness monitors

The scheduled monitors for action links, civic-data source contracts, and digest-shadow readiness are owned by the external scheduler described in `tools/external_schedule_jobs.json`. GitHub Actions retains only the explicitly manual official roll-call tranche and migration-marker workflows; it is not the scheduler or issue-loop owner for these monitors.

Each run writes a result under `CROL_EXTERNAL_SCHEDULE_STATE_DIR` and an issue intent under its `outbox/` directory. The event id is derived from the monitor id and scheduled slot. Replay adds a marker to every issue mutation, checks existing comments before creating one, and closes the managed issue after recovery. A GitHub API outage therefore leaves the result and pending intent locally for a later replay without duplicating comments.

The scheduler can be run by launchd or cron. For launchd, set `CROL_EXTERNAL_SCHEDULE_STATE_DIR` and run `tools/install_external_schedule_launchd.sh` on the independent host. The runner also accepts `--job <id>` for a manual rehearsal and `--state-dir <path>` for a disposable test state directory. Its GitHub token needs issue read/write access only; `LEGISTAR_API_TOKEN` and `CITYSCROLL_ADMIN_KEY` are read from the scheduler environment when the corresponding live probes require them.

Verification:

```bash
node --test test/external_schedule_outbox.test.mjs
node tools/audit_scheduler_ownership.mjs --check
```

The remaining daily data-freshness jobs (`attachment-metadata`, `land-upcoming-hearings`, `surface-load-live`, and `multi-flywheel`) remain listed as follow-ups in the job manifest.
