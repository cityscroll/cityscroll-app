# Warehouse-backed first-class refresh

Most first-class resident datasets are refreshed daily by the
`First-class dataset refresh` workflow, which runs the acquisition and owning
builder that `site/data/source_contracts.json#first_class_artifacts` declares
for each one. Whatever that workflow regenerates is published onto a dated
branch by `tools/open_first_class_refresh_pr.sh`, which can run more than once on
the same day: it reads the branch as the remote currently holds it before pushing
under a stated lease, and it opens a new pull request when the previous one on
that branch was closed. `test/first_class_refresh_pr_step.test.mjs` exercises that
script against a local remote.

## Why the refresh pull request needs its own token

GitHub deliberately does not start workflows for pushes or pull requests made
with a job's own `GITHUB_TOKEN`. When the scheduled refresh used that token, the
pull request it opened sat with no check runs at all: the required checks never
reported, so the merge queue could not admit it and someone had to close and
reopen the pull request by hand to make the checks start.

Both the branch push and the `gh pr create` call therefore use the repository's
`REFRESH_PR_TOKEN` secret — the same automation token the geocoder address-index
and Doing Business lookup refreshes already use. Events made with that token do
start the required checks, so a pull request opened by the schedule arrives with
its checks running and needs no manual nudge. `open_first_class_refresh_pr.sh`
exits non-zero when the token is empty rather than pushing unauthenticated, so a
missing or expired secret fails the run visibly instead of producing another
checkless pull request.

Confirming the behaviour: the next scheduled run (or a manual
`workflow_dispatch` of `First-class dataset refresh` from the default branch)
should open a pull request whose author is the automation account rather than
`github-actions[bot]`, with the required checks queued against its head commit
within a minute. A pull request that still shows zero checks means the secret is
missing, expired, or lacks permission to push a branch and open a pull request
in this repository.

A hosted runner cannot refresh every dataset. `site/data/ocp_awards_warehouse_lookup.json`
and its dependants are materialised from the retained analytical warehouse — a
DuckDB catalog plus the ingest receipts that record each source snapshot's
checksum and row count. The catalog is deliberately not in the repository, and
the builder refuses to fall back to fixture or seed rows, so on a runner without
a catalog the acquisition fails and the last verified artifact is kept. The
scheduled workflow records that failure in its run summary rather than hiding it.

These datasets refresh on the machine that holds the warehouse:

| dataset | owning builder |
| --- | --- |
| `site/data/ocp_awards_warehouse_lookup.json` | `tools/build_ocp_warehouse_lookup.mjs` |
| `site/data/money_resident_snapshot.json` | `tools/build_ocp_warehouse_lookup.mjs` |
| `site/data/procurement_browse_rows.json` | `tools/build_ocp_warehouse_lookup.mjs` |
| `site/data/procurement_browse_query.json` | `tools/build_ocp_warehouse_lookup.mjs` |
| `site/data/analytics_registered_contracts.json` | `tools/build_analytical_registered_contracts.mjs` |
| `site/data/analytics_payments.json` | `tools/build_analytical_payments.mjs` |
| `site/data/analytics_performance_evidence.json` | `tools/build_analytical_performance_evidence.mjs` |
| `site/data/zap_projects_warehouse_lookup.json` | `tools/build_zap_warehouse_lookup.mjs` |

## Installing the scheduled job

`com.cityscroll.first-class-refresh.plist` and `run-warehouse-refresh.sh` are a
job definition, not an installed job. Nothing in this repository installs them.

On the machine that holds the warehouse:

1. Confirm the catalog is present. `warehouse/lib/catalog.mjs` resolves it from
   `CITYSCROLL_WAREHOUSE_ROOT`, falling back to the repository's `warehouse/`
   directory, and expects `duckdb/cityscroll.duckdb` plus a `receipts/`
   directory under that root.
2. Copy `run-warehouse-refresh.sh` and `preflight.sh` (which it sources from
   the same directory) somewhere stable and make `run-warehouse-refresh.sh`
   executable. An installed copy predating `preflight.sh` needs both files
   re-copied together, or the script will fail to find it.
3. Edit the plist: set `CITYSCROLL_REPO` to the checkout, `CITYSCROLL_WAREHOUSE_ROOT`
   to the warehouse root, and `GH_TOKEN` to a token that can open a pull request.
   As above, this must not be a workflow's own `GITHUB_TOKEN`, or the resulting
   pull request will never run its checks.
4. Copy the plist into the per-user `Library/LaunchAgents` directory of the
   account that will run it, then load it with
   `launchctl bootstrap gui/$(id -u) "$AGENT_DIR/com.cityscroll.first-class-refresh.plist"`,
   where `AGENT_DIR` is that directory.
5. Rehearse once by hand before relying on the schedule:
   `CITYSCROLL_REPO=… CITYSCROLL_WAREHOUSE_ROOT=… ./run-warehouse-refresh.sh --dry-run`.
   The rehearsal is read-only: it confirms the catalog is present, prints the
   datasets a run would consider due (`node tools/first_class_refresh.mjs
   --list-due`), and stops. It creates no branch, contacts no publisher, and
   rewrites no artifact.

The script refreshes only the datasets that are due, rebuilds every dependent
artifact through the derived-JSON build boundary, writes the freshness report,
and opens a pull request when something changed. It never pushes to the default
branch and never merges.

`--run-due` stops after each owning builder, so the boundary rebuild is what
keeps the served read models and the keyword search index coherent with the
refreshed data.

## Invariant: every run starts from the default branch's tip

Before touching anything, the script (via `preflight.sh`) fetches `origin`
and resets the checkout to the current tip of the default branch, then opens
that day's `data/warehouse-refresh-YYYYMMDD` branch from there. This holds on
every run, scheduled or by hand, regardless of what branch the checkout was
left on by a previous run:

- A dirty tree on a `data/warehouse-refresh-*` branch is treated as this
  job's own leftovers from an interrupted run and is discarded — that
  branch's committed history, if any, already lives on `origin`.
- A dirty tree on any other branch (including the default branch itself) is
  an operator's in-progress work. The script refuses to run and exits
  non-zero rather than guess what to do with it.
- When the run finishes, successfully or not, the checkout is left back on
  the default branch. It never idles on a data branch between runs.

The only force-push the job ever makes is to its own dated data branch when
regenerating it; it never force-pushes anything else.

### Recovering a checkout the job refused to touch

If a scheduled run reports the refusal above, an operator left uncommitted
changes on a branch the job won't guess about. On the machine that runs the
job:

1. `cd` into the checkout named by `CITYSCROLL_REPO` and run `git status` to
   see what's pending.
2. Commit, stash, or discard those changes as appropriate, then rerun the
   job by hand (or wait for the next scheduled run).

### Testing the preflight logic

`test-preflight.sh` drives `preflight.sh` against a scratch git repository
(clean checkout, stale data branch, dirty default branch, and the
post-run state) and needs no warehouse catalog or network access:

```bash
ops/first-class-refresh/test-preflight.sh
```

## Refreshing the warehouse snapshot itself

The scheduled job first runs a bounded acquisition for warehouse-dependent
priority sources (`node tools/priority_source_warehouse_acquire.mjs --bounded`),
then rematerialises public artifacts. It never runs an undocumented bulk ingest
(`--bulk --ack-large`). Rebuilding an unchanged old catalog is not freshness
proof: acquisition input vintage stays distinct from the later serve clock. `site/data/ocp_awards_warehouse_lookup.json`
takes its vintage from `source_snapshot.snapshot_date`, which is the ingest
date, so the artifact cannot become fresher than the catalog behind it. Pull a
new snapshot on the warehouse machine when that vintage approaches its hard
maximum age:

```bash
export CITYSCROLL_WAREHOUSE_ROOT=…
warehouse/.venv/bin/python warehouse/scripts/ingest.py \
  --dataset ocp-recent-contract-awards --bulk --ack-large
warehouse/.venv/bin/python warehouse/scripts/write_load_manifest.py \
  --headroom-line "$(python3 "$HEADROOM_BIN" 2>&1 | tail -1)"
```

A new ingest rewrites `warehouse/receipts/proof/ocp-recent-contract-awards_bulk_latest.json`
and `warehouse/manifests/wh02_load_manifest.json`, so the pinned checksums in
`warehouse/derived_json_build_manifest.json#source_snapshot` must be restamped
in the same change or the derived-JSON build boundary rejects the tree.
