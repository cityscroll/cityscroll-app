# Unblocked plans audit — August 2026

**Cutoff:** `4940f783` on 2026-08-04. This audit evaluates plans against the
repository state at that commit. Open pull request
[#496](https://github.com/cityscroll/crol-list/pull/496) is recorded as active
work, not as a change present at the cutoff.

This is a queue audit, not an implementation plan. It covers ranked and
follow-up sections under `docs/`, the three August flywheel re-evaluations,
explicit code and operations markers, and deferrals in merged pull requests
from August 1–4. A plan is **now unblocked** only when the repository contains
the input, contract, or measurement that its earlier wording required. A plan
is **still blocked** when a named public source, measured join, product decision,
or safe operating condition is absent. **Obsolete** means shipped, measured to
a stop, or superseded by a more specific implementation.

Evidence labels keep the same boundary as the
[data-frontier ranking](data-frontiers-2026-08.md): **measured** has a dated
numerator/denominator or current artifact; **derived** follows directly from a
checked contract; **unmeasured assessment** names a plausible path without a
representative yield claim. Reader value is scored 1–5. Effort is a planning
class (`S`, `M`, `L`), not an elapsed-time promise.

## Ranked now-unblocked queue

| Rank | Item and earlier source | What changed | Evidence boundary | Reader value | Effort | Current disposition |
|---:|---|---|---|---:|---|---|
| 1 | Recover the land upcoming-hearings path (`H-01/H-04`, `cs-ops-upcoming-hearings-empty`) in the [persona](../data/flywheel-reeval-persona/report.md) and [operations](../data/flywheel-reeval-ops/report.md) re-evaluations | [#427](https://github.com/cityscroll/crol-list/pull/427) established the bounded materializer and [#418](https://github.com/cityscroll/crol-list/pull/418) established hearing-logistics parsing. The current materialization exposes the residual instead of lacking a collection seam. | **Measured:** 88 hearings extracted and 0 upcoming in the dated re-evaluation; a future hearing-shaped ZAP milestone was also recorded there. The yield of widening the accepted milestone classes is **unmeasured**. | 5 | M | **Now unblocked.** Extend and remeasure the existing materializer; do not add synthetic rows. |
| 2 | Digest shadow automatic hold, deferred in [#476](https://github.com/cityscroll/crol-list/pull/476) | #476 added persisted previews, `affected_digest_ids`, structured redlines, and `READY` / `NEEDS_ATTENTION`; [#478](https://github.com/cityscroll/crol-list/pull/478) added an operator-triggered build and wait path. | **Derived from contracts:** the inputs needed for a scoped, expiring hold and a post-repair release now exist. No production hold behavior has been measured. | 5 | M | **Now unblocked.** The earlier “automatic holding” dependency has landed; implementation still needs fail-open/fail-closed and expiry rules. |
| 3 | Resolve the remaining 24 Meetings `no_place_signal` rows in [data-frontiers rank 10](data-frontiers-2026-08.md) and the [missing-data re-evaluation](../data/flywheel-reeval-missing-data/report.md) | [#481](https://github.com/cityscroll/crol-list/pull/481) supplied a verified non-Council source registry and bounded document collector; [#484](https://github.com/cityscroll/crol-list/pull/484) supplied a deterministic neighborhood-to-civic-geography resolver. | **Measured:** 95/119 Meetings rows were located and 24/119 were `no_place_signal`. The incremental yield from registry documents and neighborhood aliases is **unmeasured**. | 4 | M | **Now unblocked for a bounded residual pass.** This does not assert that all 24 can be located. |
| 4 | Wire the voluntary post-action outcome loop (`cs-ops-01-outcome-wire`) from the [operations re-evaluation](../data/flywheel-reeval-ops/report.md) | [#494](https://github.com/cityscroll/crol-list/pull/494) added source-receipted Property actions, while [#485](https://github.com/cityscroll/crol-list/pull/485) and [#492](https://github.com/cityscroll/crol-list/pull/492) established receipt-gated outcome surfaces. The existing `OUTCOME_ENUM` and `outcome_recorded` event no longer lack stable action and result contexts. | **Measured:** 195/243 Property notices now expose source-grounded actions. UI use of `outcome_recorded` remains zero at the cutoff. | 4 | M | **Now unblocked.** Keep the response voluntary, post-action, and privacy-minimal. |
| 5 | Put a primary action on Money list rows (`cs-ops-money-list-next-action`) in the [operations re-evaluation](../data/flywheel-reeval-ops/report.md) | The action registry already provides procurement response and award handoffs; #494 adds a measured pattern for source-span-gated actions and expired-action handling. | **Measured gap:** the re-evaluation found no kinetic action on Money list rows. Density and accessibility impact are **unmeasured**. | 4 | M | **Now unblocked.** Reuse existing handoffs; do not create a second action interpretation layer. |
| 6 | Stamp hearing logistics on individual land projects (`H-03`) in the [persona re-evaluation](../data/flywheel-reeval-persona/report.md) | #418 and #427 provide the parser, accepted logistics shape, daily build, and action-rail integration seam. | **Measured gap:** the recorded field case had no venue/livestream row when `hearing_logistics` was null. Incremental coverage is **unmeasured**. | 4 | M | **Now unblocked.** Reuse disposition evidence on `/zap-outcomes`; preserve null when no hearing evidence exists. |
| 7 | Make map counts open the same district bag for Meetings and Property (`cs-ops-map-place-filters`) in the [operations re-evaluation](../data/flywheel-reeval-ops/report.md) | #484 centralized deterministic neighborhood/community-district routing, and [#464](https://github.com/cityscroll/crol-list/pull/464) established district watch payloads. The remaining work is list grammar and item filtering, not place interpretation. | **Measured gap:** the re-evaluation found council-level links that honestly fell back to citywide lists. Filter accuracy after implementation is **unmeasured**. | 4 | L | **Now unblocked.** Counts and list membership must be checked from the same stamped corpus. |
| 8 | Split the home cold path and ratchet below 445,000 bytes from the [performance audit](perf-budget-audit-2026-08.md) and [#444](https://github.com/cityscroll/crol-list/pull/444) | [#473](https://github.com/cityscroll/crol-list/pull/473) added per-file byte attribution and inventory stability; [#487](https://github.com/cityscroll/crol-list/pull/487) removed generated source-graph outputs from authored diffs. The next split can be measured without confusing artifact churn with runtime bytes. | **Measured:** #490 reported 453,889 cold-home bytes; the audit names `app/alerts.mjs`, `action_registry.js`, and lens modules as candidates but does not promise their removable bytes. | 3 | M | **Now unblocked.** The under-435,000 follow-on remains conditional on first clearing 445,000. |
| 9 | Reconcile the executable gap taxonomy and add the three census-derived gaps from the [frontier maintenance section](data-frontiers-2026-08.md) | The four frontier collectors, their reader contracts, and #487's derived source graph now provide one cutoff for current source/edge status. | **Measured:** the frontier document names the three additions and the stale landed rows; #480–#495 supply the final stop/ship receipts. | 2 | S | **Now unblocked.** This is a truth-maintenance change, not new collection. |
| 10 | Add `#staffing` as an alias for `#people` (`J-03`) in the [persona re-evaluation](../data/flywheel-reeval-persona/report.md) | [#479](https://github.com/cityscroll/crol-list/pull/479) centralized language-preserving shared URLs, so an alias can normalize through the current route serializer without dropping `lang`. | **Measured gap:** the re-evaluation records that an invented `#staffing` route falls into Money. Reader demand is **unmeasured**. | 2 | S | **Now unblocked.** Canonical output should remain `#people` while accepting the alias on input. |
| 11 | Refresh rules adoption materialization through the unified lifecycle control, deferred in [#436](https://github.com/cityscroll/crol-list/pull/436) | [#490](https://github.com/cityscroll/crol-list/pull/490) now supplies one counted lifecycle stepper and deterministic fallback stage classification. The last committed prediction payload predates that integration. | **Derived:** the current stage contract is stable enough to rebuild and characterize the artifact. Any new predictive cohort remains **unmeasured** and is not included. | 3 | M | **Now unblocked for refresh and parity measurement.** This is not permission to widen forecast claims. |
| 12 | Run WH-04 against a bounded live OCP slice, deferred in [#315](https://github.com/cityscroll/crol-list/pull/315) | WH-02's OCP bulk pack and the capped WH-04 runner are present; the current WH-04 proof receipt still says `mode: fixture`. | **Measured substrate:** 53,216 OCP warehouse rows were recorded by the later missing-data audit. Live-slice ER quality is **unmeasured**. | 3 | M | **Now unblocked.** Keep the existing cap and do not infer full-bulk safety from a 200-row pass. |
| 13 | Characterize the 11 land `completion_order_violation` rows deferred in [#421](https://github.com/cityscroll/crol-list/pull/421) | #421 fixed the false current-stage pointer and left an explicit, measured residual class in the committed census. | **Measured:** 11 residual violations, described as publisher-order candidates rather than confirmed product defects. | 2 | S | **Now unblocked.** Label benign publisher history separately from ordering defects before changing the spine. |
| 14 | Consolidate deterministic drift checks for worker currency/feed/permalink variants from [the drift inventory](drift-inventory.md) | The site module split and #487's build-derived artifact pattern make ownership boundaries explicit enough to add focused contract tests without another repository-wide generated file. | **Unmeasured assessment:** four worker `usd()` closures, one MCP formatter, feed/card field inclusion, and slug cleaning are candidates, not confirmed divergences. | 2 | M | **Now unblocked as characterization.** The card must be allowed to conclude “no defect.” |
| 15 | Add dated warehouse delta exports, deferred in [the warehouse guide](../warehouse/README.md) | The City Record bulk cursor and the four checkpointed August collectors establish the stable ordering, receipt, conditional-fetch, and resume patterns needed for a delta design. | **Unmeasured assessment:** operational savings and source-specific cursor behavior have not been measured. | 2 | M | **Now unblocked for one-source proof.** Do not generalize one cursor contract across every source. |

## Ready-to-card bodies

### 1. Recover upcoming land hearings from published ZAP milestones

Extend the existing land-upcoming-hearings materializer to evaluate future ZAP milestones whose published titles are hearing-shaped, in addition to the current disposition-logistics path. Start with the recorded zero-result corpus, label each newly accepted milestone class, preserve the synthetic-row ban, and publish before/after counts plus a reviewed false-positive sample. A successful card proves that a source-published future event reaches the list with its project, date, venue or remote mode when present, and official handoff; a valid zero-result receipt is preferable to padding the list.

### 2. Add a scoped, expiring digest-shadow hold

Add a versioned hold state keyed only to `affected_digest_ids` when the 06:00 ET shadow run is `NEEDS_ATTENTION` and repair has not restored `READY` by a documented cutoff. The hold must expire automatically, distinguish missing-run from redline states, expose an operator override, leave unrelated digests eligible, and release after an authenticated successful rerun. Tests should cover stale holds, partial repair, endpoint failure, and the 09:00 ET delivery boundary; the first production observation should be reported separately from fixture behavior.

### 3. Reclassify and remeasure the Meetings location residual

Take the fixed 24-row `no_place_signal` residual and code each miss by cause before changing extractors: body place omitted, neighborhood alias missed, venue usable only as a weak pin, virtual-only, or external board page needed. Apply the committed neighborhood resolver and verified non-Council registry only where evidence supports the matter or venue geography, then publish joined/total by method and an honesty review. Do not use an agency headquarters as matter geography or present partial board coverage as citywide completeness.

### 4. Close the voluntary action-outcome loop

After a source-grounded action has passed or the reader returns from its official handoff, offer a small optional response using the existing `OUTCOME_ENUM`, with no free-text collection and no implication that a self-report is an official outcome. Emit `outcome_recorded` only after an explicit choice, state the retention and aggregation boundary, and keep official receipt-backed outcomes visually and analytically separate. Characterize completion rate and abandonment without making the prompt a prerequisite for using the action rail.

### 5. Put one existing action on each eligible Money list row

Derive at most one list-row action from the existing procurement action registry: respond while a solicitation is open, review award guidance for an award, or omit the control when neither is source-supported. Reuse the same deadline and destination classification as detail pages, gate expired opportunities, and measure mobile density, keyboard order, and accessible names. The list must not introduce new fuzzy matches, new destination recipes, or a second interpretation of the notice.

### 6. Carry published hearing logistics into land detail

Reuse the existing ZAP hearing-logistics extractor when building cold `/zap-outcomes` records so an in-review project can show a dated venue, livestream, or calendar action even when the aggregate upcoming-hearings list is empty. Stamp the exact source field and project ID, reject review sessions that do not meet the accepted hearing-title contract, and leave the action rail unchanged when evidence is absent. Report the fixed-project sample coverage instead of extrapolating a citywide rate.

### 7. Make map drill links preserve exact list scope

Add community- and council-district grammar to Meetings and Property lists using the same stamped observations that produce `district_activity` counts. For each map link, assert that the destination list IDs equal the IDs in the selected density bag, carry the scope into share and watch URLs, and keep a plainly labeled citywide fallback only when a lens genuinely lacks item-level district membership. Test borough, community district, council district, empty bag, and returning-history behavior.

### 8. Split non-home code from the cold module graph

Use the performance inventory to move route-only Alerts, action-registry, and lens code behind route activation while preserving ordered boot behavior and deep-link first paint. Measure the exact current main commit with the existing 20-sample harness, require an unchanged rendered-DOM and accessibility result, and ratchet `home.cold` below 445,000 bytes only from observed output. Treat under 435,000 as a later target and do not count ignored or generated artifact bytes as savings.

### 9. Reconcile the gap taxonomy at the August 4 cutoff

Add `money-location-residual`, `meetings-location-residual`, and `property-parcel-key-residual` to the executable inventory, then stamp or retire rows whose collectors and surfaces have landed. Re-derive the document and source graph from declared inputs, preserve every historical measurement, and distinguish `landed`, `measured_stop`, `timing`, and `publication_blocked` rather than deleting old gaps. The verification gate should fail when the ranked ingest list again presents a shipped collector as future acquisition work.

### 10. Normalize `#staffing` to the canonical People route

Accept `#staffing` and its query string as an input alias, normalize it to `#people`, and preserve language, filters, selection, history-sidecar state, and cold-entry fallback. Keep generated links canonical so the alias does not create two permalink namespaces. Add route tests for direct entry, Back navigation, shared non-English URLs, and an unknown hash that must still follow the existing fallback.

### 11. Refresh rules adoption evidence against the unified stepper

Rebuild the committed rules prediction artifact from the current source and stage classifier, then compare stage counts, cohort eligibility, open assertion expiry, and reader copy against the single lifecycle control. Publish any changes as measured deltas and retain the existing `n_events` and calibration gates. Do not add Meetings or franchise timing forecasts in this card; those remain blocked on separate cohort evidence.

### 12. Prove WH-04 on one bounded live warehouse slice

Run the existing capped WH-04 path over at most 200 live OCP rows with the current single-writer lock, headroom gate, and receipt contract. Record candidate pairs, accepted links, ambiguity, false positives, and runtime beside the fixture proof, and stop without widening the batch when precision or resource behavior is unclear. This card proves the live seam only; it does not authorize full-corpus ER.

### 13. Separate land publisher-order history from real lifecycle defects

Review the 11 committed `completion_order_violation` cases against their source milestones and classify each as publisher re-filing/history, equal-date ambiguity, or a true stage-order defect. Preserve every source date and identifier, add one fixture per accepted class, and change UI or ordering logic only for a demonstrated defect. The result may legitimately be a detector refinement with no reader-facing change.

### 14. Characterize deterministic formatting and permalink drift

Build a focused fixture matrix for the worker's currency closures, MCP record formatter, feed/card field inclusion, and vendor/agency slug cleaning. First establish whether outputs that should match actually diverge; encode only intended equivalence and document intentional density differences such as abbreviated on-page money. Avoid a generated repository-wide report and permit a measured “no divergence” conclusion.

### 15. Prove one dated warehouse delta path

Choose one source with a stable ordered timestamp/key contract, fetch a bounded delta after an immutable snapshot, and materialize a receipt that records the cursor, source row count, dedupe result, resume checkpoint, and final snapshot equivalence. Test an interrupted resume and a same-cursor rerun for idempotence. Keep other sources on their existing snapshot or collector behavior until each source's cursor semantics are verified independently.

## Still blocked

| Item found | Current evidence and blocker |
|---|---|
| MOCS/Capital planning phase (`data-frontiers` rank 1 and the separate reader surface in #483) | **Measured blocked:** #495 materialized 11,566 MOCS rows and 50,000 Capital rows, but all six independent 100-row bridge samples joined 0/100. The payload has zero edges, so no notice-level planning phase or budget card is justified. |
| Money-location capital enrichment (`data-frontiers` rank 5; map-money and OCP-map draft cards) | **Measured blocked:** 212/340 Money rows remained `no_place_signal`, and #495's Capital→City Record bridge was 0/100. Capital rows may support a separate planning map, but they do not currently locate an award. A general “place served” source is still absent. |
| Non-Council decision coverage (`data-frontiers` rank 3) | **Measured blocked:** #481's strict body/date/matter bridge joined 0/10 and left the lookup empty. #492 shipped the receipt-gated surface, but it is intentionally inert until an accepted edge exists. |
| Contract-level M/WBE goal percentage (`data-frontiers` rank 11) | **Publication-blocked:** no verified PIN- or contract-keyed public goal-percent feed exists. MOCS plan materialization did not produce accepted notice edges. |
| Agencies without a batch award source (`data-frontiers` rank 12) | **Publication-blocked:** current ABO and Checkbook coverage does not establish a source for absent agencies. |
| Procurement notices without PIN/EPIN (`data-frontiers` rank 13) | **Precision-blocked:** no representative residual sample supports fuzzy agency/title/vendor/date joins, and #495 added no planning bridge candidates. |
| Solicitation package documents (`data-frontiers` rank 14) | **Measured publication stop:** RFx document URLs were 0/50 and 0/1,470 modern notices; modern OCP/City Record `document_links` also measured zero. Keep the official GetFile/PASSPort handoff. |
| Rules dates omitted by the publisher (`data-frontiers` rank 16) | **Publication-blocked:** the unified rules stepper classifies existing events but cannot recover a date absent from the official joined item. |
| Individual civil-service results (`data-frontiers` rank 17) | **Privacy and publication blocked:** no appropriate public source is verified. |
| Final Property BBL residual (`data-frontiers` rank 18) | **Source-evidence blocked:** 138/139 observations already had BBLs; the last row needs an address/tax-lot signal review before another geocoder call can be claimed useful. Neighborhood resolution does not manufacture a parcel key. |
| Remaining OASys deep-apply coverage (`J-01`, deep-rate draft) | **Publication-path blocked:** the measured re-evaluation found 9 deep links among 147 open-window exams and 138 lobby handoffs. No additional stable per-exam URL population is verified. |
| Property price/deal densification (`B-04`) | **Yield blocked:** the measured sample found price on 1/40 modern notices. A larger source-pattern sample is needed before promising useful coverage. |
| Migration “catch breaks faster” verdict | **Irrecoverable comparison gap:** the post-cutover diagnostics are measured, but the pre-cutover redirect-loop manual-discovery timestamp was never recorded. Digest shadow data is a different failure class and cannot replace that baseline. |
| Migration “roll back instantly” verdict | **Drill blocked:** the receipt still lacks a disposable custom domain, complete fallback artifact, and authorized timed detach/reattach plus visitor smoke. Today's data landings do not change that. |
| Attachment-table Parquet/DuckDB migration | **Threshold blocked:** #442 intentionally defers migration until 500+ documents with tables, 2,000+ tables, 5 MB+ payload, or a cross-document SQL need. No threshold is documented as met. |
| Per-exam list-establishment prediction (`J-02`) and new Meetings/franchise timing forecasts | **Calibration blocked:** current copy remains cohort-only; no new per-item calibration scorecard or qualified cohort landed. |
| Revocable-consent grant/deny outcomes and citywide-rule→consent links in [civic scope](civic-scope-schema.md) | **Source blocked:** no joined outcome feed or topic record enumerating open consent hearings is present. The source graph describes declared relationships; it does not create these edges. |
| Remote-hearing accessibility default in civic scope | **Product/source decision blocked:** most notices do not state accommodations, and no approved default language is recorded. |
| Civic-scope borough-mismatch retry | **Evidence blocked:** boundary source-of-truth is settled, but no bounded mismatch sample establishes whether borough-biased geocode or PAD filtering is safe. |
| Native-reviewed threshold interpolation in every locale (`drift-inventory`) | **Review blocked:** the current fixed $10 billion copy is contracted; changing translated sentence structure still requires native review. |
| Automatic drift-synthesis trigger and promotion policy | **Governance blocked:** the local script exists, but no invocation owner or decision on informational versus required status is recorded. |
| `tools/intelligence_receipt.mjs` live mode | **Contract blocked:** the code explicitly supports fixtures only and names no live acquisition source, authorization, or receipt boundary. |
| Broad migration of remaining live SODA, GeoSearch, DOB, and MapPLUTO calls | **Value/freshness blocked:** default BATCHABLE paths already moved in #424, while neighborhood resolution and committed boundaries supersede part of the earlier rationale. The remaining user-driven calls need route-specific latency/failure measurements before an edge cache is justified. |
| `cs-ops-02` / `cs-ops-03` interpretation rules and contest guides | **Definition blocked:** the re-evaluation carries titles but no current field cases, acceptance criteria, or measured regression. |
| Under-435,000 cold-home follow-on | **Sequence blocked:** the performance audit makes this conditional on the under-445,000 split above. |

## Obsolete or superseded

| Earlier plan | What superseded it |
|---|---|
| RC-2 `subsidy-project-unmatched` and `data-frontiers` ranks 6–9 | [#482](https://github.com/cityscroll/crol-list/pull/482) landed the collector and measured joins; [#485](https://github.com/cityscroll/crol-list/pull/485) now renders project identity, company, address, benefit/cost, board outcome, lifecycle dates, and official documents. These four dependent rows are shipped, not merely unblocked. |
| RC-4 ABO residual implementation | [#480](https://github.com/cityscroll/crol-list/pull/480) measured 1/50 coverage and 50% fuzzy precision and stopped below both gates; [#486](https://github.com/cityscroll/crol-list/pull/486) supplied the inert-unless-accepted surface. A broader fuzzy edge is obsolete under the measured stop. |
| RC-1 collector infrastructure | #483 and #495 shipped the collector, warehouse payload, and receipt. Only the reader edge remains blocked by the 0/100 bridge results. |
| RC-3 registry and reader-shell implementation | #481 and #492 shipped both. Coverage remains blocked by the 0/10 join, so duplicating either implementation is obsolete. |
| Property accessibility ships 2 and 3 | [#493](https://github.com/cityscroll/crol-list/pull/493) shipped 350 typed events with zero known cross-type false positives; #494 shipped source-backed actions on 195/243 notices. |
| Property accessibility ship 4 as a new card | Active pull request [#496](https://github.com/cityscroll/crol-list/pull/496) supersedes queueing another implementation. It reports 234/243 templated notices and all authored summaries at grade 7 or below, but it is not counted as present at this audit's cutoff. |
| PASSPort RFx and Checkbook detail deferrals in [#302](https://github.com/cityscroll/crol-list/pull/302) | [#320](https://github.com/cityscroll/crol-list/pull/320) added numeric RFx deep links and Checkbook `agid` detail links while preserving search fallbacks. |
| Rules stitched-chain UI deferred in [#345](https://github.com/cityscroll/crol-list/pull/345) | [#356](https://github.com/cityscroll/crol-list/pull/356) surfaced multi-notice rulemaking; #490 replaced duplicate controls with the unified lifecycle stepper and card facts. |
| District-scoped watch (`D-01`) | #464 shipped district weekly watches and the unified subscription flow; #484 made neighborhood queries resolve into the same civic geography. |
| ZAP BBL fixture→bulk draft | [#331](https://github.com/cityscroll/crol-list/pull/331) shipped WH-06 bulk materialization and parcel links. |
| Attachment T0/T1 expansion and T2/T3 draft tiers | [#411](https://github.com/cityscroll/crol-list/pull/411), [#428](https://github.com/cityscroll/crol-list/pull/428), [#442](https://github.com/cityscroll/crol-list/pull/442), and [#440](https://github.com/cityscroll/crol-list/pull/440) shipped metadata, text, structured tables, and precomputed related-notice edges. |
| Person roll-call window expansion draft | [#368](https://github.com/cityscroll/crol-list/pull/368) densified the people domain from all retained multi-notice roll-call records; the committed artifact contains 194 vote rows. |
| Generic `structured_facts` public detail panel | #489, #490, #493, and #494 supersede a raw generic panel with pattern-specific lifecycle events, card facts, typed dates, and actions. This keeps provenance while avoiding another undifferentiated fact stack. |
| Durable EDC feed follow-up in `AGENTS.md` | #482 landed the host-side checkpointed feed that the bot-blocked edge path required. |
| Blanket precompute of default first paints | #424 and earlier wave-2 work shipped the batchable defaults. Remaining direct calls are parameterized/user-driven and are parked above pending route-specific evidence. |
| `data-frontiers` ranks 19–30 as new collectors | OCP, attachment, Checkbook/PASSPort, Legistar, Rules, exam aggregate/NOE, and ZAP outcome infrastructure already landed. Their remaining work is coverage monitoring or the taxonomy reconciliation ranked above, not duplicate acquisition. |
| `?w=` ceiling fast-follow in the drift inventory | The note was conditional on the constant changing; no change occurred. It is a guard trigger, not current work. |
| Property edge-commercial rebuild as a code card (`B-03`) | The extraction and rendering path shipped in [#416](https://github.com/cityscroll/crol-list/pull/416). A stale deployed KV is an operational refresh/verification issue, not a second implementation. |

## Sweep notes

- No actionable `TODO` or `FIXME` exists in the operations contract. Its digest
  shadow section accurately describes monitoring and rerun behavior but does not
  describe a hold; the hold comes only from the explicit #476 follow-up.
- The only literal “not implemented” production-tool marker found outside tests
  is the fixture-only live mode in `tools/intelligence_receipt.mjs`, parked above
  because it lacks a live-source contract.
- The gap taxonomy's ranked ingest list is historical in several rows. It is
  retained as evidence, but should not be treated as the current queue until the
  ranked reconciliation card lands.
- Today's MOCS/Capital materialization does **not** unlock award-location joins:
  the relevant Capital→City Record sample is measured at 0/100. The audit does
  not substitute source availability for join feasibility.
- The two migration “cannot measure yet” claims remain blocked for the exact
  reasons in their receipts. New digest, source, accessibility, or routing data
  cannot reconstruct a missing historical timestamp or replace a timed rollback
  exercise.
