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
- Keep public serializers and evidence artifacts free of private review fields, credentials,
  authenticated evidence, internal research bookkeeping, and local-only references. Public
  Markdown must use stable repository or public URLs; private evidence belongs in the private
  evidence plane.
- Never commit secrets, raw/private source payloads, gitignored warehouse products, generated
  Pages documents, or generated architecture-evidence aggregates. Follow the owning builder,
  schema, source contract, and `.gitignore` boundary.
- Preserve graceful degradation: the static/browser surface remains useful when Worker-backed,
  metered, delivery, or optional enrichment features are unavailable.
- Keep resident copy plain-language and source-honest. Implementation field names, debug states,
  and reconciliation prose belong behind explicit evidence/details affordances, not in default
  resident content.

## Editing and verification

- Before editing, inspect `git status`, the owning architecture/source contract, nearby tests, and
  the relevant builder or read model. For bugs, reproduce with a focused failing test or concrete
  observation when practical; fix the root cause and keep the change scoped.
- Generated artifacts are changed through their owning builder. Run its `--check` mode when one
  exists and commit only artifacts that the owning contract marks as tracked.
- Add or update focused tests and fixtures beside the owning contract. Use
  [`test/`](test/) for site/tool contracts and [`worker/test/`](worker/test/) for Worker contracts.
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
- Treat deployment and source refresh as separate from code verification. Release boundaries and
  required production evidence are documented in [`docs/release/cloudflare-native-builds.md`](docs/release/cloudflare-native-builds.md).

## Directory guidance

There are currently no tracked directory-local `AGENTS.md` or `CLAUDE.md` files. Add local guidance
only when a documented material subtree rule changes how files there must be edited or verified;
keep it current-contract-only and register it in the instruction audit policy.

## Maintaining this file

Keep this router useful to almost every repository session. Prefer a pointer to an authoritative
file, schema, test, or command over prose recoverable from code or generated architecture facts.
Accepted ADR references, current maintainer instructions, tests, fixtures, and legitimate
code-coupled evidence are allowed. Card bodies, rollout histories, mutable status, future-work
queues, and duplicated implementation catalogs are not.
