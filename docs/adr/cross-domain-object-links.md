# ADR: Cross-domain object-link layer

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-08-02 |
| Scope | Entity intelligence across money / land / rules / meetings / people |
| Supersedes | — |
| Builds on | Subject registry, entity_resolution normalizers, warehouse ER (WH-04) |

## Context

Subject-registry links connect notice↔contract↔pin within a procurement lifecycle.
Entity resolution links source records to vendor/agency canonicals. Warehouse ER
(WH-04) batch-resolves OCP rows. Public dossier/relationship graph remain gated on
published canonical entity ids (`not_yet_public` for name-shaped keys).

What was still shallow: **one real-world agency or vendor spanning domains** —
contracts (money), rezonings (land), rules, hearings, and person-level votes —
with **typed edges and provenance** on a single intelligence surface.

## Decision

1. **Pure layer** `entity_resolution/cross_domain/object_links.mjs`
   - Root entities: `agency:id:{canonical_id}` and `vendor:stem:{stem}` via existing
     `canonicalAgency` / `vendorStem` (no new matcher).
   - Domain observations shaped from OCP, ZAP, rules notices, meeting notices,
     and optional person-vote rows.
   - Every edge carries `provenance` (`source_system`, `source_record_id`,
     `source_fields`, `basis`, optional `input_value`).
   - Empty domains are explicit; **people** defaults to class-(a)
     `not_yet_ingested` when no `by_person` rows exist (production retention is 0).

2. **Materialization** `tools/build_entity_intelligence.mjs` →
   `site/data/entity_intelligence_lookup.json` (+ Worker twin). Instant serve;
   no live SODA fan-out on the request path. Fixture/warehouse only (CPU-light).

3. **HTTP** `GET /entity-intelligence` — `kind`+`name`/`id`, `ref`, `list=1`, `demo=1`.

4. **UI** Agency profile panel renders the materialization when the worker responds
   (additive; i18n keys for all shipping locales).

### Metric

`cross_domain_object_link_coverage` = domains_matched / 5 on a view.
Verified demo: **Parks and Recreation** (`agency:id:parks-and-recreation`) with
money + land + rules + meetings matched; people not_yet_ingested.

## Non-goals

- No silent merge of notice subjects into contracts
- No public dossier unlock for arbitrary name-shaped ids
- No live multi-source fan-out on the request path
- No fabricated person-level votes

## Verify

```bash
node --test test/cross_domain_object_links.test.mjs worker/test/entity_intelligence.test.mjs
node tools/build_entity_intelligence.mjs --check
node entity_resolution/eval/run_metrics.mjs --gold entity_resolution/eval/gold_v0.jsonl --blocker token_v0
```

## Rollback

Remove the cross_domain package, materialization JSON, worker route, agency-profile
panel, and this ADR. Subject registry and ER remain intact.
