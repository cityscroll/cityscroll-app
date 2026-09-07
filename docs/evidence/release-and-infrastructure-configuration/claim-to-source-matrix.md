# Release and infrastructure: claim-to-source matrix

This is the audit behind the September 2026 reconciliation of CityScroll's release
runbook and its runtime-infrastructure summaries. It records, claim by claim, what the
documents said before, what they say now, and the exact configuration file each corrected
claim rests on.

The change is documentation, plus one deterministic checker and its tests. No workflow
trigger, cron schedule, binding, secret, production integration, or deployment mechanism
was modified.

## Revisions

| Role | Revision | Note |
|---|---|---|
| Baseline revision | `74d609df27f04f4fc7ef74c8a73dd4955586eb9c` | The revision at which the previous documentation reconciliation in this series landed, and against which the findings below were first read. |
| Implementation head | `6cd5661c197d92021838262a567c71d0653a43d1` | The revision this reconciliation was written and verified against. |

**Revalidation.** Every audited path was re-derived at the implementation head before
editing. Each configuration and reference file below has the identical blob at both
revisions, so no finding was closed, weakened, or superseded in between:

| Audited path | Blob at both revisions |
|---|---|
| `.github/workflows/deploy-worker.yml` | `f5cb8ea914a198ac8a047837bb3b3b99a428e5f7` |
| `.github/workflows/deploy-cloudflare-pages.yml` | `93eeaefa59ca72cf7fc19a17bb0d5bdd74044258` |
| `worker/wrangler.toml` | `b61a049a8b3a355b8341dfee5544d2635baa49a3` |
| `docs/release/cloudflare-native-builds.json` | `93eb7d7a2ef9614db2c4c2e6405191cb82f154ad` |
| `docs/release/cloudflare-native-builds.md` | `f779d50c28f1478f4c81fbe0653ae9e1cef4df32` |
| `ARCHITECTURE.md` | `abad04e35a1a367a9f3691cb615226675e6f64e0` |
| `worker/README.md` | `cf6f4d336c88c3a522d64bc344e91f051ebbf648` |
| `tools/audit_deploy_control_plane.mjs` | `d74618749186064b16ff68dd7976aa8f53d3dabb` |
| `tools/worker_trigger_coverage.mjs` | `4d56ac3b6a48b8e75191763f91075253cc063ba2` |

`docs/architecture.md` is the one audited document whose blob moved between the two
revisions (`63245507a` → `d3c693243`). The single intervening change is the MCP bullet in
§"Front doors"; every paragraph quoted in the "Before" column below is byte-identical at
both revisions.

## Two registers

The corrected documents separate what this repository configures from what only a
Cloudflare account can confirm.

| Register | Meaning | Evidence |
|---|---|---|
| Repository-configured | A trigger, schedule, or binding declared in a committed file | The file itself, re-derived by `node tools/release_infrastructure_facts.mjs` |
| Externally observed | A setting that exists only in a provider dashboard | Nothing in this repository can read one. It stays **unverified** until a read-only configuration read or a deployment receipt is committed. |

## Matrix

### R1 — How the Worker actually deploys

| | |
|---|---|
| **Before** | `docs/release/cloudflare-native-builds.md`: "Workers Builds remains the canonical release path for the Worker." `docs/release/cloudflare-native-builds.json` `worker.manual_fallback_workflow: ".github/workflows/deploy-worker.yml"`. `docs/architecture.md` §"Serving & deploy": "Changes under `worker/**` deploy from `main` through Cloudflare Workers Builds; `.github/workflows/deploy-worker.yml` remains a manual, non-required fallback." |
| **After** | `docs/release/cloudflare-native-builds.md` §"Release pipelines" classifies `deploy-worker` as `push` to `main` (path-filtered) plus `workflow_dispatch`, and says in prose that the workflow is not a recovery path. The JSON contract carries `worker.release_control_plane: "github_actions"`, `worker.automatic_deploy_workflow`, and `worker.automatic_deploy_events: ["push:main", "workflow_dispatch"]`; the `manual_fallback_workflow` key is gone. `docs/architecture.md` and `worker/README.md` state the automatic classification and route the detail to the release reference. |
| **Configuration owner** | `.github/workflows/deploy-worker.yml` `on:` — `push: { branches: [main], paths: [...] }` and `workflow_dispatch: { inputs: force_d1_publication, disable_incremental_publication }`. There is no `schedule:` and no `pull_request:`. |
| **Already-existing corroboration** | `tools/audit_deploy_control_plane.mjs` already asserted `Worker workflow must deploy every main push`, and `worker/test/worker_environment.test.mjs` already asserted the `push:`/`branches: [main]` block. The repository's checks and its prose disagreed; the prose was wrong. |
| **Why the old text misled** | An operator following the runbook after a merge would look for a Workers Builds deployment, find none attributable, and read a missing Worker refresh as an unremarkable "the manual fallback was not run" instead of a failed automatic pipeline. |

### R2 — The path filter that decides whether a merge deploys

| | |
|---|---|
| **Before** | `worker/README.md` §"Automatic deploys" narrowed the filter to "`worker/**` or the shared Following renderer". The JSON contract's `worker.path_includes` listed seven globs, a different set again. |
| **After** | `worker/README.md` names the full committed filter and points at the workflow and the release reference as the authority for the exact `paths:` list. The release reference states the filter is wide and names the checker that proves it still covers the Worker's dependency surface. |
| **Configuration owner** | `.github/workflows/deploy-worker.yml` `on.push.paths` — 21 patterns including `worker/**`, `capabilities/**`, `entity_resolution/**`, `ontology/**`, `site/**`, `tools/**`, `warehouse/**`, `site/following_view.mjs`, `site/data/watch_templates.json` and the workflow file itself. |
| **Not changed** | The filter itself, and `worker.path_includes`, which `tools/worker_trigger_coverage.mjs` reads as the declared native-build pattern set. |

### R3 — Whether Workers Builds is connected

| | |
|---|---|
| **Before** | Both release documents asserted the connection as an established fact ("Workers Builds remains the canonical release path"), and the JSON contract described its commands with no verification state. |
| **After** | `docs/release/cloudflare-native-builds.md` §"Externally observed settings" records the connection as **unverified**, and the JSON contract carries `worker.native_builds_connection: "unverified"`. The declared root directory and commands are retained and labelled as what should be set there, not what is set there. |
| **Configuration owner** | Nothing in this repository observes a Cloudflare dashboard. The strongest committed signal points the other way: `.github/workflows/deploy-worker.yml` writes its own `worker_release` stage as `status UNKNOWN` with the reason "Cloudflare Workers provider/build identity was not emitted by the deploy action". No Workers Builds deployment receipt is committed anywhere in the tree. |
| **How it can move** | Commit a read-only configuration read or a deployment receipt for the connection, then update the row. Documentation is explicitly not evidence for it. |

### R4 — How many cron triggers exist, and what each one does

| | |
|---|---|
| **Before** | `ARCHITECTURE.md` §"System context": "The routes, domains, and **two** daily cron triggers are declared in `worker/wrangler.toml`." §"Runtime scenarios" → "The daily jobs run" described only the `10:00 UTC` and `13:00 UTC` crons. `docs/architecture.md` §"System map": "Cron (daily 13:00 UTC)"; §"TL;DR": "**1 daily cron**". §"Serving & deploy" listed all three but appended a fixed "(~9am ET)" to `0 13 * * *`. |
| **After** | `docs/release/cloudflare-native-builds.md` §"Configured Worker cron triggers" is the one owned table: `0 8 * * *`, `0 10 * * *`, `0 13 * * *`, each with its distinct responsibility, and an explicit statement that UTC is authoritative and a fixed local-time rendering is an approximation of one part of the year. `ARCHITECTURE.md` corrects "two" to three, adds the 08:00 job to the runtime scenario, and links the owner; `docs/architecture.md` links the owner instead of restating the list; `worker/README.md` names all three when documenting the local `/__scheduled` trigger. |
| **Configuration owner** | `worker/wrangler.toml` `[triggers] crons = ["0 8 * * *", "0 10 * * *", "0 13 * * *"]` (lines 26–30, values on 27–29). |
| **Responsibilities** | `0 8 * * *` — sell-facing ZAP lookup, Land upcoming hearings and staffing exams into `ALERT_STATE` (`worker/README.md` route rows for `/land-upcoming-hearings`, `/zap-projects-lookup`, `/staffing-exams`). `0 10 * * *` — delivery-free digest shadow rehearsal. `0 13 * * *` — ingest, prior-cycle pre-warm, projection rebuilds and digest fan-out. |
| **Not changed** | The schedules, and the `worker/wrangler.toml` comment block above them. |

### R5 — Whether the R2 source vault is active custody

| | |
|---|---|
| **Before** | `docs/architecture.md` frontmatter `summary`: "The source vault retains approved public documents by content hash and preserves their official source links." §"System map": "R2: SOURCE_VAULT — content-addressed custody for approved public documents". §"Data stores & schemas": "**R2 `SOURCE_VAULT`** — content-addressed custody for approved public documents. Each object carries provenance, eligibility, and its official source URL." §"Seams" → Consumes: "the platform also consumes Cloudflare KV + R2 + Analytics Engine + Cron Triggers". §"TL;DR": "+ 1 R2 source vault". |
| **After** | Every one of those five statements now says the seam is designed but not bound, and names the two facts that make it inactive. `docs/release/cloudflare-native-builds.md` §"Configured Worker bindings" lists `SOURCE_VAULT` as the single inactive row and states that the existence of `worker/src/source_vault.mjs` is not evidence of custody. |
| **Configuration owner** | `worker/wrangler.toml`: the `[[r2_buckets]]` table and its `binding = "SOURCE_VAULT"` line are commented out (lines 110–111), and `[vars] SOURCE_VAULT_ENABLED = "false"` (line 98). `node tools/release_infrastructure_facts.mjs` reports the binding with `state: "commented_out"`, `gate: {key: "SOURCE_VAULT_ENABLED", value: "false"}`, `active: false`. |
| **Already agreeing** | `ARCHITECTURE.md` §"Building blocks" and §"Important decisions", `architecture/workspace.dsl`, and `docs/adr/source-vault.md` already recorded the disabled state. `ARCHITECTURE.md` gains only the "no source document is retained in object storage" clause and the pointer to the owned inventory. The generated architecture facts already observed no R2 binding: `bindings.environments.production.r2_buckets` is `null`, which `tools/reconcile_architecture.mjs --check` reports as a `source_nulls` entry. |
| **Not changed** | No binding was uncommented, no flag was flipped, and no bucket was provisioned. |

### R6 — Where a schedule or binding is allowed to be written down

| | |
|---|---|
| **Before** | The cron list appeared in `worker/wrangler.toml`, `ARCHITECTURE.md`, `docs/architecture.md` (twice, with different counts) and `worker/README.md`. The binding inventory appeared in `ARCHITECTURE.md`, `docs/architecture.md` (twice) and `worker/README.md`. Four independent places could drift, and three of them had. |
| **After** | `docs/release/cloudflare-native-builds.md` owns both inventories. The three summaries keep the one or two facts their own narrative needs and link the owner for the list. `tools/release_infrastructure_facts.mjs --check` fails if any of the three stops linking it, or if the owned tables stop matching the configuration. |

### R7 — Two compatibility hostnames moved to the files that own them

| | |
|---|---|
| **Before** | The false release classification in R1 and the "two daily cron triggers" count in R4 sat on the same source lines as two retired-domain hostnames, each pinned byte-for-byte by `.github/legacy-name-allowlist.txt`. That pin is content-addressed and its growth rule refuses an entry for content introduced by the same change, so those two lines could not be corrected in place while still spelling the retired hostnames. |
| **After** | `ARCHITECTURE.md` §"System context" ¶3 and the `docs/architecture.md` §"Serving & deploy" Worker bullet describe the same two custom domains and the retired-domain GitHub Pages CNAME, and point at the files that spell the hostnames: the `routes` table in `worker/wrangler.toml`, the `docs/architecture.md` system map, and `worker/README.md`. The two now-unused allowlist entries are removed; every other entry, including the four other retired-domain pins in `docs/architecture.md`, is untouched. |
| **What is preserved** | The dual-homing fact, the "not a pending rename" qualifier, the retained `workers.dev` alias, and the "GitHub Pages CNAME is not a Worker route" clarification all remain in both documents. The hostnames themselves remain spelled out in `worker/wrangler.toml`, the `docs/architecture.md` system map, the mirror and redirect bullets, and `worker/README.md`. |
| **Trade-off** | Two reviewed pins whose comments read "keep this exact line" are retired. They were kept so the compatibility alias stayed documented; it still is, in the same two documents and in the configuration that declares it. Retiring the pins is the only mechanical way to correct the release and schedule claims that shared those lines. |

## Active-binding inventory at the implementation head

Derived by `node tools/release_infrastructure_facts.mjs` from `worker/wrangler.toml`.

| Binding | Kind | Resource | State |
|---|---|---|---|
| `DB` | D1 database | `crol-notices` | active |
| `NL_METER` | KV namespace | — | active |
| `ALERT_STATE` | KV namespace | — | active |
| `SUBS` | KV namespace | — | active |
| `FEEDBACK` | KV namespace | — | active |
| `USAGE_ANALYTICS` | Analytics Engine dataset | `crol_usage_events_v1` | active |
| `RUM_ANALYTICS` | Analytics Engine dataset | `crol_rum_observations_v1` | active |
| `DIGEST_QUEUE` | Queue producer | `crol-digests` | active |
| `queues.consumers:crol-digests` | Queue consumer | `crol-digests` | active |
| `queues.consumers:crol-digests-dlq` | Queue consumer | `crol-digests-dlq` | active |
| `SOURCE_VAULT` | R2 bucket | — | **inactive**: declaration commented out, `SOURCE_VAULT_ENABLED = "false"` |

Ten active bindings, one inactive. A commented-out declaration and an `_ENABLED` variable
that is not `"true"` each independently make a binding inactive; the checker tests both.

## Read-back: four cases from the documents alone

**1. A merge touching `tools/build_keyword_search_index.mjs` lands on `main`.**
The Worker deploys automatically: that path is in the workflow's `paths:` filter and the
push is to `main`. Nobody needs to run anything by hand. If no deployment appears, the
`deploy-worker` run is the pipeline to inspect. — `docs/release/cloudflare-native-builds.md`
§"Release pipelines".

**2. An operator wants to re-run a deploy without a new commit.**
`workflow_dispatch` on the same workflow, which additionally accepts
`force_d1_publication` and `disable_incremental_publication`. This is a second trigger on
an automatic pipeline, not the pipeline's only entry point. — same section.

**3. A daily list looks stale and the digest is fine.**
Three separate crons, three separate responsibilities: `0 8 * * *` owns the ZAP lookup,
Land upcoming hearings and staffing exams; `0 10 * * *` owns the delivery-free rehearsal;
`0 13 * * *` owns ingest and delivery. A stale Land hearings list points at the 08:00 run,
not the digest chain. The schedules are UTC and do not move with New York's clock. —
§"Configured Worker cron triggers".

**4. A source document cannot be found in object storage.**
That is expected, not a fault. No R2 bucket is bound and `SOURCE_VAULT_ENABLED` is
`"false"`, so no document has ever been retained there; the code path exists and is
tested, which is not the same as custody. — §"Configured Worker bindings" and
`docs/adr/source-vault.md`.

## What this reconciliation did not do

No cron schedule was changed. No R2 binding was enabled and no bucket was provisioned. No
secret, repository variable, production integration, or provider setting was touched. No
pipeline was disabled and no workflow trigger was added or removed. The Workers Builds
commands declared in the JSON contract are retained verbatim; only their verification
state is now stated. `worker.path_includes` is unchanged, so `tools/worker_trigger_coverage.mjs`
keeps the same declared native pattern set.

One residual is recorded rather than fixed: `tools/release_surface_reconciliation.mjs`
defaults its Worker release `provider` label to `cloudflare-workers-builds`. That is a
receipt label on a code path whose status the deploy workflow already writes as `UNKNOWN`;
changing it would alter emitted receipts, which is outside a documentation reconciliation.

## Verification

| Check | Command |
|---|---|
| Release and infrastructure reconciliation | `node tools/release_infrastructure_facts.mjs --check` |
| Release and infrastructure tests | `node --test test/release_infrastructure_facts.test.mjs` |
| Deploy control plane | `node tools/audit_deploy_control_plane.mjs --check` |
| Worker trigger coverage | `node tools/worker_trigger_coverage.mjs --check` |
| Architecture reconciliation | `node --test test/reconcile_architecture.test.mjs` |
| Architecture reconciliation, live tree | `node tools/reconcile_architecture.mjs --check --no-write` |
| Evidence shards | `node tools/architecture_evidence_shards.mjs --check` |
| Semantic-owner receipt | `node tools/governance_semantic_owner_receipt.mjs --check` |
| Resident-read fitness function | `node tools/no_live_external_reads.mjs --check` |
| Repository pre-push gate | `make prepush` |
