// Civic Graph capability ladder → multi-flywheel cards.
//
// Metric-driven enrichment for capability unlocks that landed edges make
// reachable (payment trail, official influence walk, mandate densify).
// Emits only while measured thresholds fail — same shape as notice-land and
// temporal scorecard cards inside ontology-enrichment.
//
// Does NOT re-card coverage dual-write gaps already owned by the coverage
// dimension (CFB / eLobbyist / Council Members). Those ids are listed under
// already_in_flywheel on the ladder fixture for dispatch routing.

import { makeDimensionCard } from "./shared.mjs";

export const DIMENSION_ID = "ontology-enrichment";
export const LADDER_SCHEMA = "cityscroll.civic_graph_capability_ladder.v1";

/**
 * @param {object} [input]
 * @param {object} [input.civic_graph_capability_ladder] — fixture inventory
 * @returns {object[]} multi-flywheel cards
 */
export function civicGraphCapabilityCards(input = {}) {
  const ladder = input.civic_graph_capability_ladder;
  if (!ladder || typeof ladder !== "object") return [];
  if (ladder.schema && ladder.schema !== LADDER_SCHEMA) return [];

  const m = ladder.metrics || {};
  const cards = [];
  const observedAt = ladder.observed_at || null;

  // ── v1: money-chain honesty ──────────────────────────────────────────
  const pay = m.payment || {};
  const paymentReady =
    pay.retention_materialize === true
    && Number(pay.retention_usefulness) >= 0.3
    && Number(pay.retention_precision) >= 0.95;
  const paidUnderOpen =
    pay.paid_under_status === "unregistered"
    || pay.paid_under_grounding === "gap"
    || pay.object_grounding === "gap"
    || pay.paid_under_reason_stale === true;

  if (paymentReady && paidUnderOpen) {
    cards.push(makeDimensionCard({
      dimension: DIMENSION_ID,
      slug: "cg-v1-paid-under-registry",
      title: "Register paid_under and promote payment grounding after retention",
      rank_score: 97,
      evidence: {
        kind: "civic-graph-capability",
        ladder_version: "v1",
        capability_id: "cg-v1-paid-under-registry",
        observed_at: observedAt,
        payment: {
          object_grounding: pay.object_grounding ?? null,
          object_status: pay.object_status ?? null,
          paid_under_status: pay.paid_under_status ?? null,
          paid_under_grounding: pay.paid_under_grounding ?? null,
          paid_under_reason_stale: pay.paid_under_reason_stale ?? null,
          retention_usefulness: pay.retention_usefulness ?? null,
          retention_precision: pay.retention_precision ?? null,
          dual_write_after: pay.dual_write_after ?? null,
          dual_write_row_count: pay.dual_write_row_count ?? null,
        },
        depends_on_card_ids: ["crol-list/checkbook-spending-payment-retention"],
        unlock: "award → contract → individual payments → payee",
      },
      verify:
        "node -e \"const r=require('./ontology/registry.v0.json'); const p=r.object_types.find(o=>o.id==='payment'); const l=r.link_types.find(x=>x.id==='paid_under'); if(!p||p.grounding==='gap') process.exit(1); if(!l||l.status!=='registered'||l.grounding==='gap') process.exit(1); if(/unregistered|not dual-written/i.test(l.reason||'')) process.exit(1);\"",
      demo_win:
        "Registry treats payment as a realized object and paid_under as a first-class contract→payment link, so Follow-the-Dollars can walk individual Checkbook payment rows.",
      context: [
        "ontology/registry.v0.json",
        "site/data/checkbook_spending_sources/verification_receipts/checkbook_spending_payment_retention_2026-08-11.json",
        "entity_resolution/source_coverage.json",
        "warehouse/scripts/checkbook_spending.mjs",
      ],
      lesson_class: "civic-graph-v1-payment-link",
    }));

    cards.push(makeDimensionCard({
      dimension: DIMENSION_ID,
      slug: "cg-v1-payment-row-surface",
      title: "Surface retained payment rows on lifecycle and vendor footprint",
      rank_score: 95,
      evidence: {
        kind: "civic-graph-capability",
        ladder_version: "v1",
        capability_id: "cg-v1-payment-row-surface",
        observed_at: observedAt,
        payment_dual_write_row_count: pay.dual_write_row_count ?? null,
        retention_materialize: pay.retention_materialize ?? null,
        depends_on_capability: "cg-v1-paid-under-registry",
        unlock: "reader sees check-level payment trail, not only spent-to-date",
      },
      verify:
        "node --test test/lifecycle_coherence_field_cases.test.mjs test/lifecycle_render.test.mjs worker/test/checkbook_lifecycle.test.mjs # retained payment rows on joined contract",
      demo_win:
        "On a joined award notice, Follow-the-Dollars lists retained Checkbook payment documents (date, amount, payee) for the contract, with honest unavailable when none retained.",
      context: [
        "site/index.html",
        "worker/src/lib/checkbook_lifecycle.mjs",
        "site/vendor_footprint.mjs",
        "warehouse/lib/checkbook_spending.mjs",
      ],
      lesson_class: "civic-graph-v1-payment-surface",
    }));
  }

  // ── v2: official influence walk ──────────────────────────────────────
  const infl = m.official_influence || {};
  const influencePromoted =
    infl.hub_promoted === true
    && Number(infl.lobby_edge_count) > 0
    && Number(infl.cfb_edge_count) > 0
    && Number(infl.lobby_precision) >= 0.95
    && Number(infl.cfb_precision) >= 0.95;
  const influenceUncataloged =
    infl.registry_has_lobby_link_type !== true
    || infl.registry_has_cfb_link_type !== true;

  if (influencePromoted && influenceUncataloged) {
    cards.push(makeDimensionCard({
      dimension: DIMENSION_ID,
      slug: "cg-v2-influence-link-types",
      title: "Catalog lobby and CFB influence edges in Civic Graph registry",
      rank_score: 94,
      evidence: {
        kind: "civic-graph-capability",
        ladder_version: "v2",
        capability_id: "cg-v2-influence-link-types",
        observed_at: observedAt,
        hub_person_count: infl.hub_person_count ?? null,
        lobby_edge_count: infl.lobby_edge_count ?? null,
        cfb_edge_count: infl.cfb_edge_count ?? null,
        registry_has_lobby_link_type: infl.registry_has_lobby_link_type ?? null,
        registry_has_cfb_link_type: infl.registry_has_cfb_link_type ?? null,
        related_coverage_cards: [
          "crol-list/mf-coverage-source-records-not-declared-cfb-campaign-contributions",
          "crol-list/mf-coverage-source-records-not-declared-city-clerk-elobbyist",
          "crol-list/mf-coverage-source-records-not-declared-nyc-council-members",
        ],
        unlock: "lobby/CFB → official → votes_on → matter as typed graph",
      },
      verify:
        "node -e \"const r=require('./ontology/registry.v0.json'); const ids=new Set(r.link_types.map(l=>l.id)); if(!ids.has('lobby_targets_official')&&!ids.has('lobby_client_targets_official')) process.exit(1); if(!ids.has('contribution_to_official')&&!ids.has('campaign_contribution_to_official')) process.exit(1);\" && node --test test/ontology_registry.test.mjs test/official_influence.test.mjs test/person_hub.test.mjs",
      demo_win:
        "Civic Graph names lobby and campaign-finance influence as first-class link types backed by the promoted person-hub lookups, so official pages walk org → official without ad-hoc lookup-only edges.",
      context: [
        "ontology/registry.v0.json",
        "site/data/person_hub_lookup.json",
        "site/data/official_lobby_influence_lookup.json",
        "site/data/official_cfb_influence_lookup.json",
        "site/official_influence.mjs",
      ],
      lesson_class: "civic-graph-v2-influence-catalog",
    }));
  }

  const votes = m.votes || {};
  const eventCount = Number(votes.eligible_event_count);
  const eventBar = Number(votes.constellation_event_bar) || 30;
  if (
    Number.isFinite(eventCount)
    && eventCount > 0
    && eventCount < eventBar
    && votes.retention_pass === true
    && votes.constellation_promoted !== true
  ) {
    cards.push(makeDimensionCard({
      dimension: DIMENSION_ID,
      slug: "cg-v2-rollcall-event-densify",
      title: "Densify person roll-call events past decision-constellation bar",
      rank_score: 93,
      evidence: {
        kind: "civic-graph-capability",
        ladder_version: "v2",
        capability_id: "cg-v2-rollcall-event-densify",
        observed_at: observedAt,
        eligible_event_count: eventCount,
        constellation_event_bar: eventBar,
        person_count: votes.person_count ?? null,
        row_count: votes.row_count ?? null,
        retention_rate: votes.retention_rate ?? null,
        constellation_promoted: votes.constellation_promoted ?? null,
        vote_object_status: votes.vote_object_status ?? null,
        related_cards: [
          "crol-list/mf-data-integrity-red-flag-meeting-person-votes",
        ],
        unlock: "official → votes_on → matter without corpus hedge",
      },
      verify:
        "node -e \"const v=require('./site/data/person_votes_lookup.json'); const g=v.coverage&&v.coverage.gate; if(!g||g.retention_pass!==true||g.event_count_pass!==true||g.promoted!==true) process.exit(1);\" && node --test test/person_votes.test.mjs test/official_entity_family.test.mjs",
      demo_win:
        "Person pages and meeting outcomes use decision-constellation language only after ≥30 distinct retained roll-call events at ≥95% person-id retention; vote objects are catalog-honest.",
      context: [
        "site/data/person_votes_lookup.json",
        "site/data/people_domain_observations.json",
        "tools/build_rules_meetings_domain_observations.mjs",
        "tools/build_person_votes_lookup.mjs",
        "ontology/registry.v0.json",
      ],
      lesson_class: "civic-graph-v2-vote-densify",
    }));
  }

  if (influencePromoted) {
    cards.push(makeDimensionCard({
      dimension: DIMENSION_ID,
      slug: "cg-v2-official-walk-surface",
      title: "Deep-link official influence panels into votes and matters",
      rank_score: 91,
      evidence: {
        kind: "civic-graph-capability",
        ladder_version: "v2",
        capability_id: "cg-v2-official-walk-surface",
        observed_at: observedAt,
        hub_person_count: infl.hub_person_count ?? null,
        lobby_edge_count: infl.lobby_edge_count ?? null,
        cfb_edge_count: infl.cfb_edge_count ?? null,
        demo_person_ids: ["7801", "7803"],
        depends_on_capability: [
          "cg-v2-influence-link-types",
          "cg-v2-rollcall-event-densify",
        ],
        unlock: "reader traverses lobby client → official → published vote → matter",
      },
      verify:
        "node --test test/person_hub.test.mjs test/official_influence.test.mjs test/person_votes.test.mjs test/meeting_view_readability.test.mjs",
      demo_win:
        "On #official/7801 (and influence demos), lobby and CFB edges deep-link to related published roll-call matters and City Record notices when votes densify allows — no invented edges.",
      context: [
        "site/app/entities.mjs",
        "site/official_influence_ui.mjs",
        "site/person_votes.mjs",
        "site/data/person_hub_lookup.json",
      ],
      lesson_class: "civic-graph-v2-official-walk",
    }));
  }

  // ── v3: mandate graph densify ────────────────────────────────────────
  const mand = m.mandates || {};
  const mandateCount = Number(mand.mandate_count);
  const observed = Number(mand.observed_count);
  const reportCandidates = Number(mand.report_or_study_candidate_count);
  const backlinkEdges = Number(mand.notice_backlink_edges);

  if (Number.isFinite(mandateCount) && mandateCount > 0 && observed === 0) {
    cards.push(makeDimensionCard({
      dimension: DIMENSION_ID,
      slug: "cg-v3-mandate-report-candidates",
      title: "Densify report_or_study observation candidates for report mandates",
      rank_score: 92,
      evidence: {
        kind: "civic-graph-capability",
        ladder_version: "v3",
        capability_id: "cg-v3-mandate-report-candidates",
        observed_at: observedAt,
        mandate_count: mandateCount,
        detectable_mandate_count: mand.detectable_mandate_count ?? null,
        observed_count: observed,
        report_or_study_candidate_count: Number.isFinite(reportCandidates) ? reportCandidates : null,
        unlock: "filing receipts on #mandates-reports; observed chips on conformance",
      },
      verify:
        "node -e \"const p=require('./site/data/process_conformance_lookup.json'); const s=p.summary||{}; if(!(Number(s.observed_count)>0)) process.exit(1);\" && node --test test/process_conformance.test.mjs test/mandate_reports_receipt.test.mjs",
      demo_win:
        "At least one agency shows a real City Record report filing receipt on a report mandate without false merges on the held-out sample.",
      context: [
        "site/process_conformance.mjs",
        "site/mandate_reports_receipt.mjs",
        "tools/build_process_conformance.mjs",
        "site/data/process_conformance_lookup.json",
      ],
      lesson_class: "civic-graph-v3-mandate-reports",
    }));

    cards.push(makeDimensionCard({
      dimension: DIMENSION_ID,
      slug: "cg-v3-mandate-rule-evidence-stamps",
      title: "Stamp rule body and citation keys so mandate_rule can publish",
      rank_score: 91,
      evidence: {
        kind: "civic-graph-capability",
        ladder_version: "v3",
        capability_id: "cg-v3-mandate-rule-evidence-stamps",
        observed_at: observedAt,
        observed_count: observed,
        policy: "CROSS_SPINE_RELATION_POLICIES.mandate_rule",
        unlock: "mandate → City Record rule filing observed link",
      },
      verify:
        "node tools/cross_spine_eval.mjs --check-policy && node --test test/process_conformance.test.mjs test/rule_evidence_stamps.test.mjs test/mandate_rules_bridge.test.mjs",
      demo_win:
        "Near-miss rulemaking mandates (e.g. Sanitation CWZ field cases) move to observed when body_topic_keys and citation_law_keys stamp, without relaxing held-out precision.",
      context: [
        "entity_resolution/cross_domain/edge_policy.mjs",
        "site/rule_evidence_stamps.mjs",
        "site/process_conformance.mjs",
        "tools/build_rules_meetings_domain_observations.mjs",
      ],
      lesson_class: "civic-graph-v3-mandate-rules",
    }));
  }

  if (
    Number.isFinite(backlinkEdges)
    && backlinkEdges >= 0
    && backlinkEdges < 10
    && Number.isFinite(mandateCount)
    && mandateCount > 100
  ) {
    cards.push(makeDimensionCard({
      dimension: DIMENSION_ID,
      slug: "cg-v3-mandate-contract-backlinks",
      title: "Expand mandate→contract public edges beyond the single DHS template",
      rank_score: 88,
      evidence: {
        kind: "civic-graph-capability",
        ladder_version: "v3",
        capability_id: "cg-v3-mandate-contract-backlinks",
        observed_at: observedAt,
        notice_backlink_edges: backlinkEdges,
        notice_backlink_notices: mand.notice_backlink_notices ?? null,
        template: {
          notice: "20210820102",
          mandate: "66056-006",
          relation: "implemented_by_contract",
        },
        unlock: "notice reverse card: statutory mandate this implements",
      },
      verify:
        "node -e \"const b=require('./site/data/notice_mandate_backlinks_lookup.json'); const n=Number(b.counts&&b.counts.edges); if(!(n>=5)) process.exit(1);\" && node --test test/notice_mandate_backlinks.test.mjs",
      demo_win:
        "At least five public mandate→contract reverse edges render on notice documents, expanded from the DHS Administrative Code template without title-only invent.",
      context: [
        "site/data/notice_mandate_backlinks_lookup.json",
        "tools/lib/notice_mandate_backlinks_index.mjs",
        "tools/build_notice_mandate_backlinks.mjs",
        "entity_resolution/cross_domain/edge_policy.mjs",
      ],
      lesson_class: "civic-graph-v3-mandate-contracts",
    }));
  }

  return cards;
}

/**
 * Summarize ladder metrics for dimension_metrics.
 */
export function civicGraphCapabilityMetrics(input = {}) {
  const ladder = input.civic_graph_capability_ladder;
  if (!ladder?.metrics) {
    return {
      civic_graph_ladder_loaded: false,
      civic_graph_capability_cards: 0,
    };
  }
  const cards = civicGraphCapabilityCards(input);
  const m = ladder.metrics;
  return {
    civic_graph_ladder_loaded: true,
    civic_graph_ladder_observed_at: ladder.observed_at || null,
    civic_graph_capability_cards: cards.length,
    payment_object_grounding: m.payment?.object_grounding ?? null,
    paid_under_status: m.payment?.paid_under_status ?? null,
    lobby_edge_count: m.official_influence?.lobby_edge_count ?? null,
    cfb_edge_count: m.official_influence?.cfb_edge_count ?? null,
    rollcall_event_count: m.votes?.eligible_event_count ?? null,
    constellation_promoted: m.votes?.constellation_promoted ?? null,
    mandate_observed_count: m.mandates?.observed_count ?? null,
    mandate_backlink_edges: m.mandates?.notice_backlink_edges ?? null,
  };
}
