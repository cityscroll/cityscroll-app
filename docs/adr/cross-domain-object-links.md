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

1. **Pure layer** `entity_resolution/cross_domain/object_links.mjs` (v2)
   - Root entities: `agency:id:{canonical_id}` and `vendor:stem:{stem}` via existing
     `canonicalAgency` / `vendorStem` (no new matcher).
   - Domain observations shaped from OCP, Checkbook spending, ZAP (+ BBL), rules
     notices, meeting notices, and optional person-vote rows.
   - **Join-key edges** (in addition to identity): PIN → `shares_authority_key`,
     contract_id → `references_contract` / `contract_published_by_agency`, payee →
     `paid_to_vendor` + `payment_on_contract`, BBL → `sited_on_parcel`.
   - Every edge carries `provenance` (`source_system`, `source_record_id`,
     `source_fields`, `basis`, optional `input_value`).
   - Empty domains are explicit; **people** defaults to class-(a)
     `not_yet_ingested` when no `by_person` rows exist (production retention is 0).
   - Corpus build is single-pass (`indexObservationsByRoot` once →
     `buildEntityIntelligenceFromBucket` per root).

2. **Materialization** `tools/build_entity_intelligence.mjs` →
   `site/data/entity_intelligence_lookup.json` (+ Worker twin). Instant serve;
   no live SODA fan-out on the request path. Fixture/warehouse only (CPU-light).

3. **Warehouse edge index** `warehouse/lib/entity_intelligence_index.mjs` flattens
   the same graph into root + edge rows (proof under
   `warehouse/receipts/proof/wh_entity_intelligence_index_latest.json`). SQL shape:
   `warehouse/sql/examples/entity_intelligence_index.sql`.

4. **HTTP** `GET /entity-intelligence` — `kind`+`name`/`id`, `ref`, `list=1`, `demo=1`.

5. **UI** Agency profile panel renders the materialization when the worker responds
   (additive; i18n keys for all shipping locales). Data/join layer changes must not
   require `site/index.html` edits.

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
node --test test/cross_domain_object_links.test.mjs \
  test/warehouse_entity_intelligence_index.test.mjs \
  worker/test/entity_intelligence.test.mjs
node tools/build_entity_intelligence.mjs --check
node warehouse/lib/entity_intelligence_index.mjs --check
node entity_resolution/eval/run_metrics.mjs --gold entity_resolution/eval/gold_v0.jsonl --blocker token_v0
```

## Rollback

Remove the cross_domain package, materialization JSON, worker route, agency-profile
panel, and this ADR. Subject registry and ER remain intact.
