/**
 * Build-time index of public mandate → notice backlinks.
 * Node-only: pulls mandate bridges (and their entity_resolution imports).
 * Never load this from the SPA browser graph.
 */

import {
  NOTICE_MANDATE_BACKLINKS_METHOD,
  NOTICE_MANDATE_BACKLINKS_SCHEMA,
  compactMandateBacklink,
  isPublicBacklinkTier,
  noticeIdFromSubject,
} from "../../site/notice_mandate_backlinks.mjs";
import {
  MANDATE_CONTRACT_EDGE_TYPE,
  buildMandateContractsBridgeView,
} from "../../site/mandate_contracts_bridge.mjs";
import {
  MANDATE_LAND_USE_EDGE_TYPE,
  buildMandateLandUseView,
} from "../../site/mandate_land_use_bridge.mjs";
import {
  MANDATE_MEETING_EDGE_TYPE,
  buildMandateMeetingsView,
} from "../../site/mandate_meetings_bridge.mjs";
import { buildMandateRulesBridgeView } from "../../site/mandate_rules_bridge.mjs";
import { buildMandateReportsReceiptView } from "../../site/mandate_reports_receipt.mjs";
import {
  MANDATE_RULE_PUBLICATION_TIER,
  OBSERVATION_STATUS,
} from "../../site/process_conformance.mjs";

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

function pushBacklink(byNotice, noticeId, row) {
  const id = noticeIdFromSubject(noticeId);
  const compact = compactMandateBacklink(row);
  if (!id || !compact) return;
  const list = byNotice.get(id) || [];
  const dedupe = `${compact.duty_text}|${compact.relation || ""}|${compact.agency_id || ""}|${compact.citation || ""}|${compact.mandate_id || ""}`;
  if (list.some((item) => item._dedupe === dedupe)) return;
  // Persist only public fields; watch_href is derived at render time from mandate_id.
  const { watch_href: _watch, ...persistable } = compact;
  if (!persistable.mandate_id) delete persistable.mandate_id;
  list.push({ ...persistable, _dedupe: dedupe });
  byNotice.set(id, list);
}

/** Extract a canonical bare mandate id from a bridge edge / mandate bag. */
function mandateIdFromEdge(edge) {
  return edge?.mandate_id
    || edge?.mandate?.mandate_id
    || edge?.mandate?.obligation_id
    || edge?.mandate?.subject_ref
    || edge?.obligation_id
    || null;
}

function agencyFields(view) {
  return {
    agency_id: clean(view?.agency_id, 120) || null,
    agency_name: clean(view?.agency_name, 200) || null,
  };
}

function temporalFields(mandate = {}) {
  return {
    deadline: mandate.deadline || null,
    deadline_date: mandate.deadline_date || null,
    deadline_text: mandate.deadline_text || null,
    trigger: mandate.trigger || mandate.trigger_text || null,
    recurrence: mandate.recurrence || null,
  };
}

/** Collect public contract → notice backlinks. */
export function collectFromContractView(view, byNotice = new Map()) {
  if (!view || !Array.isArray(view.edges)) return byNotice;
  const agency = agencyFields(view);
  for (const edge of view.edges) {
    const tier = edge?.edge_policy?.tier;
    if (!isPublicBacklinkTier(tier)) continue;
    const noticeId = edge?.procurement_record?.request_id
      || noticeIdFromSubject(edge?.procurement_record?.subject_ref);
    pushBacklink(byNotice, noticeId, {
      ...agency,
      mandate_id: mandateIdFromEdge(edge),
      ...temporalFields(edge?.mandate),
      duty_text: edge?.mandate?.duty_text,
      citation: edge?.mandate?.citation,
      source_href: edge?.mandate?.source_href,
      relation: edge?.edge?.type || edge?.relation || MANDATE_CONTRACT_EDGE_TYPE,
      publication_tier: tier,
    });
  }
  return byNotice;
}

/** Collect public meeting → notice backlinks. */
export function collectFromMeetingsView(view, byNotice = new Map()) {
  if (!view || !Array.isArray(view.edges)) return byNotice;
  const agency = agencyFields(view);
  for (const edge of view.edges) {
    const tier = edge?.edge_policy?.tier;
    if (!isPublicBacklinkTier(tier)) continue;
    const noticeId = edge?.meeting?.request_id
      || noticeIdFromSubject(edge?.meeting?.subject_ref);
    pushBacklink(byNotice, noticeId, {
      ...agency,
      mandate_id: mandateIdFromEdge(edge),
      ...temporalFields(edge?.mandate),
      duty_text: edge?.mandate?.duty_text,
      citation: edge?.mandate?.citation,
      source_href: edge?.mandate?.source_href,
      relation: edge?.relation || MANDATE_MEETING_EDGE_TYPE,
      publication_tier: tier,
    });
  }
  return byNotice;
}

/**
 * Collect public rules-filing → notice backlinks.
 * Rules bridge stores public matches as observed_record with publication tier.
 */
export function collectFromRulesView(view, byNotice = new Map()) {
  if (!view || !Array.isArray(view.mandates)) return byNotice;
  const agency = agencyFields(view);
  for (const mandate of view.mandates) {
    const observed = mandate?.observed_record;
    if (!observed) continue;
    const publication = clean(observed.publication, 40);
    if (publication && publication !== MANDATE_RULE_PUBLICATION_TIER
      && !isPublicBacklinkTier(publication)) {
      continue;
    }
    const noticeId = observed.request_id
      || noticeIdFromSubject(observed.subject_ref || observed.href);
    pushBacklink(byNotice, noticeId, {
      ...agency,
      mandate_id: mandate.mandate_id || mandate.obligation_id || mandate.subject_ref,
      ...temporalFields(mandate),
      duty_text: mandate.duty_text,
      citation: mandate.citation,
      source_href: mandate.source_href,
      relation: "mandate_rule_filing",
      publication_tier: publication || MANDATE_RULE_PUBLICATION_TIER,
    });
  }
  return byNotice;
}

/**
 * Collect public report filing-receipt → notice backlinks.
 * Only standable process-conformance observations (status=observed).
 */
export function collectFromReportsView(view, byNotice = new Map()) {
  if (!view || !Array.isArray(view.mandates)) return byNotice;
  const agency = agencyFields(view);
  for (const mandate of view.mandates) {
    const receipt = mandate?.filing_receipt || mandate?.observed_record;
    if (!receipt?.request_id && !receipt?.href) continue;
    if (mandate?.observation_status && mandate.observation_status !== OBSERVATION_STATUS.OBSERVED) {
      continue;
    }
    const noticeId = receipt.request_id
      || noticeIdFromSubject(receipt.subject_ref || receipt.href);
    pushBacklink(byNotice, noticeId, {
      ...agency,
      mandate_id: mandate.mandate_id || mandate.obligation_id || mandate.subject_ref,
      ...temporalFields(mandate),
      duty_text: mandate.duty_text,
      citation: mandate.citation,
      source_href: mandate.source_href,
      relation: "mandate_report_filing",
      publication_tier: MANDATE_RULE_PUBLICATION_TIER,
    });
  }
  return byNotice;
}

/** Build report-bridge conformance items from the process-conformance lookup. */
function reportsConformanceItems(agencyId, processConformance) {
  const observations = processConformance?.by_agency?.[agencyId]?.observations || {};
  return Object.entries(observations).map(([mandate_id, observation]) => ({
    mandate_id,
    observation,
  }));
}

/**
 * Land-use edges target ZAP projects, not City Record notices, in v1.
 * If a public edge still carries a notice request_id, index it.
 */
export function collectFromLandUseView(view, byNotice = new Map()) {
  if (!view || !Array.isArray(view.edges)) return byNotice;
  const agency = agencyFields(view);
  for (const edge of view.edges) {
    const tier = edge?.edge_policy?.tier;
    if (!isPublicBacklinkTier(tier)) continue;
    const noticeId = edge?.land_action?.request_id
      || noticeIdFromSubject(edge?.land_action?.notice_subject_ref)
      || noticeIdFromSubject(edge?.notice?.request_id);
    if (!noticeId) continue;
    pushBacklink(byNotice, noticeId, {
      ...agency,
      mandate_id: mandateIdFromEdge(edge),
      ...temporalFields(edge?.mandate),
      duty_text: edge?.mandate?.duty_text,
      citation: edge?.mandate?.citation,
      source_href: edge?.mandate?.source_href,
      relation: edge?.relation || MANDATE_LAND_USE_EDGE_TYPE,
      publication_tier: tier,
    });
  }
  return byNotice;
}

function rulesConformanceItems(agencyId, processConformance) {
  const observations = processConformance?.by_agency?.[agencyId]?.observations || {};
  return Object.entries(observations).map(([mandate_id, observation]) => ({
    mandate_id,
    observation,
  }));
}

/**
 * Walk agency mandate bridges and build a compact by_notice index.
 * Only public tiers are retained.
 */
export function buildNoticeMandateBacklinksLookup(sources = {}) {
  const obligations = sources.obligationsLookup || sources.obligations || { by_agency: {} };
  const agencyIds = Object.keys(obligations.by_agency || {}).sort();
  const byNotice = new Map();
  const common = {
    obligationsLookup: obligations,
    crossSpineGate: sources.crossSpineGate || sources.gate || null,
  };

  for (const id of agencyIds) {
    const dossier = sources.intelligence?.by_ref?.[`agency:id:${id}`]
      || sources.intelligenceDossiers?.[id]
      || null;

    const contracts = buildMandateContractsBridgeView(id, {
      ...common,
      intelligenceDossier: dossier,
      procurementAwards: sources.procurementAwards || sources.procurement_awards || null,
    });
    collectFromContractView(contracts, byNotice);

    const meetings = buildMandateMeetingsView(id, {
      ...common,
      meetingsDomain: sources.meetingsDomain || sources.meetings || null,
    });
    collectFromMeetingsView(meetings, byNotice);

    const rules = buildMandateRulesBridgeView(id, {
      obligationsLookup: obligations,
      rulesItems: sources.rulesDomain?.rows || sources.rules?.rows || [],
      rulesCount: sources.rulesDomain?.row_count || sources.rules?.row_count,
      conformanceItems: rulesConformanceItems(id, sources.processConformance),
    });
    collectFromRulesView(rules, byNotice);

    const reports = buildMandateReportsReceiptView(id, {
      obligationsLookup: obligations,
      conformanceItems: reportsConformanceItems(id, sources.processConformance),
    });
    collectFromReportsView(reports, byNotice);

    const land = buildMandateLandUseView(id, {
      ...common,
      entityIntelligence: sources.intelligence || null,
      landProjects: sources.landProjects || sources.land || null,
    });
    collectFromLandUseView(land, byNotice);
  }

  const by_notice = {};
  const relationCounts = {};
  let edgeCount = 0;
  for (const [noticeId, rows] of [...byNotice.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const cleaned = rows.map(({ _dedupe, ...row }) => row);
    by_notice[noticeId] = cleaned;
    edgeCount += cleaned.length;
    for (const row of cleaned) {
      const key = row.relation || "unknown";
      relationCounts[key] = (relationCounts[key] || 0) + 1;
    }
  }

  return {
    schema: NOTICE_MANDATE_BACKLINKS_SCHEMA,
    method: NOTICE_MANDATE_BACKLINKS_METHOD,
    generated_at: clean(sources.generatedAt, 40) || new Date().toISOString(),
    counts: {
      notices: Object.keys(by_notice).length,
      edges: edgeCount,
      by_relation: relationCounts,
    },
    by_notice,
  };
}
