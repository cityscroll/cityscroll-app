# CityScroll repository instructions

This file is the repository's compact instruction router. It contains only rules that apply across
the tree and points to the files that own detailed architecture, source, domain, and verification
contracts. Do not turn it into a delivery log, roadmap, module inventory, or card-status ledger.

## Sources of truth

- [`README.md`](README.md) owns the product overview and public entry points.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) is the short human architecture narrative;
  [`docs/architecture.md`](docs/architecture.md) owns detailed architecture invariants and system
  boundaries. Accepted decisions live in [`docs/adr/`](docs/adr/).
- [`site/data/source_contracts.json`](site/data/source_contracts.json) is the source-contract
  registry. [`docs/data-sources.md`](docs/data-sources.md) is its generated human-readable view.
- [`docs/module-map.md`](docs/module-map.md) routes browser modules and page ownership. Use imports,
  schemas, builders, and generated architecture facts for current implementation detail instead of
  copying a module catalog here.
- [`architecture/evidence.d/README.md`](architecture/evidence.d/README.md) owns the card-scoped
  architecture-evidence shard contract. The aggregate files under `architecture-evidence/` are
  derived at check/build time and must not be committed.
- [`docs/repository-control-plane/classification.v1.json`](docs/repository-control-plane/classification.v1.json)
  and [`docs/repository-control-plane/semantic-owner-mapping.v1.json`](docs/repository-control-plane/semantic-owner-mapping.v1.json)
  classify repository guidance and route temporal intent to its canonical owner. The public
  repository is the implementation and reproducible-evidence plane, not a planning register.
- [`docs/repository-control-plane/evidence-placement.d/README.md`](docs/repository-control-plane/evidence-placement.d/README.md)
  owns the reviewed evidence-placement inputs, one file per semantic key and one key per document
  tree. `docs/repository-control-plane/evidence-placement.v1.json` is derived from them at check
  time and must not be committed.
- [`docs/repository-control-plane/cutover.d/README.md`](docs/repository-control-plane/cutover.d/README.md)
  owns the reviewed cutover inputs proving the control-plane migrations moved content without
  losing product behavior or evidence. `docs/repository-control-plane/cutover.v1.json` is derived
  from them at check time and must not be committed.

## Repository-wide invariants

- Public sources remain authoritative. Preserve provenance and distinguish measured, derived,
  estimated, unavailable, not published, and not yet joined states. Never infer a missing fact,
  identity, lifecycle stage, date, or zero from absence.
- Resident and required-CI reads are materialization-only. Browser routes, Pages handlers, Worker
  read endpoints, production builds, and required gates must not fetch publisher civic data on
  demand. The complete rule and narrow transaction/acquisition exceptions are in
  [`docs/architecture.md#resident-read-invariant`](docs/architecture.md#resident-read-invariant),
  enforced by [`architecture/resident-read-policy.json`](architecture/resident-read-policy.json).
- Identity joins are links, not destructive merges. Publish a cross-source relation only through
  its named exact-key, evidence, confidence, and review policy; unresolved candidates remain
  separate and non-linking.
- Location-match evidence quality is one canonical tier (`strong` / `derived` / `weak`), classified
  once in [`site/location_evidence_tier.mjs`](site/location_evidence_tier.mjs). A caller needing a
  strong/derived/weak read from a placement method and confidence imports that classifier instead
  of re-deriving a threshold or method allowlist locally.
- Keep public serializers and evidence artifacts free of private review fields, credentials,
  authenticated evidence, internal research bookkeeping, and local-only references. Public
  Markdown must use stable repository or public URLs; private evidence belongs in the private
  evidence plane.
- Never commit secrets, raw/private source payloads, gitignored warehouse products, generated
  Pages documents, or generated architecture-evidence aggregates. Follow the owning builder,
  schema, source contract, and `.gitignore` boundary.
- Integration evidence is classified mechanically, never by self-declaration.
  [`capabilities/evidence_classification.mjs`](capabilities/evidence_classification.mjs) owns the
  five evidence classes and re-derives the highest class a receipt's own facts can prove;
  [`capabilities/os_deployment_receipt.mjs`](capabilities/os_deployment_receipt.mjs) adds the
  deployment contract on top of that floor. A local rehearsal never becomes deployment or live
  evidence, and `tools/build_capability_spine_state.mjs` reports readiness as separate states
  rather than one collapsed flag. The Cloudflare OS deployment itself lives in a separate private
  repository; this repository holds the public schemas, contract tests, and the upstream reference
  in [`integrations/cloudflare-os-starter/`](integrations/cloudflare-os-starter/).
- A gate over build-time refreshed source data asserts population properties, not named upstream
  records: publisher windows roll, so a record id in a release gate becomes a deploy outage the day
  that record leaves the window. Use counts, shares, or floors over the materialized set, and keep
  any record-level expectation as a logged signal.
- Preserve graceful degradation: the static/browser surface remains useful when Worker-backed,
  metered, delivery, or optional enrichment features are unavailable.
- A required check that needs a pull request's changed-file list must not depend solely on
  GitHub's ability to render the diff — GitHub returns a `not_available` error once a diff is too
  large (e.g. a large generated-data refresh), and a check that only reads `pulls/N/files` fails on
  an unrelated API error instead of the change it's actually gating. Route pull-request path
  detection through [`tools/list_pr_changed_paths.sh`](tools/list_pr_changed_paths.sh) (API first,
  git-diff fallback against the base sha) or, for `dorny/paths-filter`, set `token: ""` to force its
  built-in git-mode fallback; see `.github/workflows/ci.yml`. Either way the check must still fail
  closed if neither method can determine the paths.
- Keep resident copy plain-language and source-honest. Implementation field names, debug states,
  and reconciliation prose belong behind explicit evidence/details affordances, not in default
  resident content.

## Editing and verification

- Before editing, inspect `git status`, the owning architecture/source contract, nearby tests, and
  the relevant builder or read model. For bugs, reproduce with a focused failing test or concrete
  observation when practical; fix the root cause and keep the change scoped.
- Generated artifacts are changed through their owning builder. Run its `--check` mode when one
  exists and commit only artifacts that the owning contract marks as tracked.
- A committed generated artifact must not carry a figure that moves when an unrelated tracked file
  changes: a repository-wide count, a byte total, a revision, a digest of another growing file.
  Every change then rewrites the same lines and conflicts with every other open one. Derive those
  on demand; keep policy in a manifest and derived lists in sorted one-path-per-line files marked
  `merge=union`, read as sets. See `architecture/evidence.d/`, `tools/card-profile/closure.d/`.
- A new shipped `site/` module must be added to the `architecture/site-production-determinism.json`
  inventory (`node tools/determinism_lint.mjs --write-site-inventory`), or the merge queue's
  combined tree fails even when the branch is green on its own head. The merge queue validates a
  branch against current `main`, not its base, so a branch cut before a required gate landed can be
  green-but-doomed and eject the batch it joins; `node tools/aggregate_inventory_preflight.mjs`
  simulates that combined tree ahead of the queue.
- Add or update focused tests and fixtures beside the owning contract. Use
  [`test/`](test/) for site/tool contracts and [`worker/test/`](worker/test/) for Worker contracts.
  A test that deliberately crosses the network to a deployed endpoint (e.g. an external live-endpoint
  canary) must be excluded from the `test/*.test.mjs` sweep and run from its own deploy workflow step
  instead — see [`test/live_mcp_canary.test.mjs`](test/live_mcp_canary.test.mjs)'s exclusion in
  `ci.yml`, `preflight-required-checks.sh`, and `measure_card_profile_routing_evidence.sh`.
- Run focused tests first. Before opening or handing off a pull request, run `make prepush` (the
  equivalent entry point is `./tools/preflight-required-checks.sh`). Use `make a11y` after
  `make setup-a11y` when the change requires the full browser/accessibility gate.
- For architecture-affecting work, edit only the change-owned shard under
  [`architecture/evidence.d/`](architecture/evidence.d/), then run
  `node tools/architecture_evidence_shards.mjs --check` and
  `node tools/reconcile_architecture.mjs --check --no-write`. Never edit the derived aggregate
  paths.
- For root or local instruction changes, run `node tools/agents_router_guard.mjs --check` and
  `node --test test/agents_router_guard.test.mjs`. The content classifier is primary; the byte
  ceiling is a downward-only backstop.
- For changes to repository content classification, placement, or the cutover proof, run
  `node tools/inverse_control_plane_guard.mjs --check --all` and
  `node tools/rcp05_cutover_receipt.mjs --check`. Both reuse the architecture-evidence card
  inventory and need no register credentials.
- Treat deployment and source refresh as separate from code verification. Release boundaries and
  required production evidence are documented in [`docs/release/cloudflare-native-builds.md`](docs/release/cloudflare-native-builds.md).

## Directory guidance

- `site/` is predominantly **tracked source**, not build output. Most of the working copy's bytes
  live in tracked `site/data`. Only the paths named in `.gitignore` (`_site/`, `site/browse/`,
  `site/now/`, the bounded procurement query artifacts, and the per-agency and per-community-board
  `index.html` documents) are generated. Do not assume a path under `site/` is regenerable.
- `worker/` is not package-isolated from `site/`: Worker sources import modules and data files
  across that boundary, so the Worker unit family needs more than `worker/` present to run.
- `warehouse/lib/document_processing.mjs` is the publisher-neutral document-processing interface
  (hashing, extraction-quality measurement, extraction receipts, document-type/supersession
  classification). A document pipeline for a new source consumes it rather than reimplementing any
  of its primitives; `warehouse/lib/seqra_*` shows the binding pattern one publisher uses.
- Measured working-copy sizes, provisioning phase timings, and the cost of the Pages build are in
  [`docs/evidence/ci-08-working-copy-footprint/`](docs/evidence/ci-08-working-copy-footprint/);
  regenerate its tables with `python3 tools/summarize_working_copy_evidence.py`.
- [`docs/card-work-profile.md`](docs/card-work-profile.md) owns the two provisioning profiles and
  the routing contract between them. `focused-reduced` is the supported default for focused card
  work; CI, deployment, release, architecture, control-plane, evidence and complete-history work
  takes the `full` control. Provision by naming the work, not the profile:
  `tools/provision_card_profile.sh provision --dest <dir> [--surface <work-surface>]`, and ask
  without provisioning with `tools/provision_card_profile.sh decide --surface <id>`. Run a gate in a
  reduced checkout through `node tools/verify_card_profile.mjs --gate <class> -- <command>`, never
  bare.

There are currently no tracked directory-local `AGENTS.md` or `CLAUDE.md` files. Add local guidance
only when a documented material subtree rule changes how files there must be edited or verified;
keep it current-contract-only and register it in the instruction audit policy.

## Maintaining this file

Keep this router useful to almost every repository session. Prefer a pointer to an authoritative
file, schema, test, or command over prose recoverable from code or generated architecture facts.
Accepted ADR references, current maintainer instructions, tests, fixtures, and legitimate
code-coupled evidence are allowed. Card bodies, rollout histories, mutable status, future-work
queues, and duplicated implementation catalogs are not.
