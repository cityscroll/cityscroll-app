// Pure subsidy lifecycle assembly for NYCIDA/Build NYC records.
//
// Joins a City Record notice to public NYCIDA/Build NYC project records and returns a
// normalized lifecycle object with explicit unmatched/missing statements. No fetch or env.

import {
  boroughsIn,
  bblFor,
  normalizeAddress,
  plainText,
  unique,
} from "../../../site/location_extract.mjs";
import { propertyLocationFromRow } from "../../../site/property_location.mjs";

export const STAGE_APPLICATION = "application";
export const STAGE_HEARING = "hearing";
export const STAGE_BOARD_DECISION = "board_decision";
export const STAGE_CLOSING = "closing";
export const STAGE_COMPLIANCE = "compliance";
export const STAGES = [
  STAGE_APPLICATION,
  STAGE_HEARING,
  STAGE_BOARD_DECISION,
  STAGE_CLOSING,
  STAGE_COMPLIANCE,
];

const UNKNOWN = "unknown";

function toDate(value) {
  const s = String(value || "").trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.valueOf()) ? null : s.slice(0, 10);
}

function toAmount(value) {
  const normalized = String(value || "").trim().replace(/[$,]/g, "").replace(/\s+/g, "");
  if (!normalized) return null;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function normalizedTokens(value) {
  return unique(
    String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((token) => token.length > 2),
  );
}

function overlapScore(left, right) {
  const a = new Set(normalizedTokens(left));
  const b = new Set(normalizedTokens(right));
  if (!a.size || !b.size) return 0;
  const both = [...a].filter((token) => b.has(token)).length;
  return both / Math.max(a.size, b.size);
}

function docState(url) {
  if (url) return { status: "matched", url };
  return {
    status: UNKNOWN,
    url: null,
    reason: "public document is not publicly linked",
  };
}

function moneyState(raw) {
  const value = toAmount(raw);
  if (value === null) {
    return {
      status: UNKNOWN,
      value: null,
      currency: "USD",
      reason: "public money amount is not stated in this source",
    };
  }
  return { status: "matched", value, currency: "USD" };
}

function pickFirst(...values) {
  for (const value of values) {
    const text = plainText(value);
    if (text) return text;
  }
  return "";
}

function normalizeBbl(value) {
  const s = String(value || "").replace(/\D/g, "").trim();
  return /^\d{10}$/.test(s) ? s : null;
}

function splitBbls(values) {
  const out = [];
  for (const entry of values || []) {
    for (const token of String(entry).split(/[,\s;/]+/)) {
      const normalized = normalizeBbl(token);
      if (normalized) out.push(normalized);
    }
  }
  return unique(out);
}

function resolveStage(project) {
  if (project.compliance.date || project.compliance.status) return STAGE_COMPLIANCE;
  if (project.closing.date || project.closing.status || project.closing.amount !== null) return STAGE_CLOSING;
  if (project.board_decision.date || project.board_decision.outcome) return STAGE_BOARD_DECISION;
  if (project.hearing.date || project.hearing.status) return STAGE_HEARING;
  return STAGE_APPLICATION;
}

function buildPlace(notice = {}, project = {}) {
  const locationHint = normalizeAddress(
    [
      project.project_address || "",
      project.location_text || "",
      notice.short_title || "",
      notice.additional_description_1 || "",
      notice.additional_description_2 || "",
      notice.additional_description_3 || "",
      notice.other_info_1 || "",
    ].filter(Boolean).join(" "),
  );
  const extracted = propertyLocationFromRow({
    short_title: pickFirst(project.project_name, notice.short_title),
    additional_description_1: locationHint,
  });
  const boroughHints = boroughsIn(locationHint);
  const explicit = splitBbls([project.bbl, ...(project.bbls || [])]);
  const inferred = unique([...extracted.bbls, ...explicit]);
  const boroughs = unique([...boroughHints, ...extracted.boroughs]);
  const hasEvidence = !!locationHint || inferred.length || extracted.addresses.length || extracted.tax_lots.length || extracted.boroughs.length;
  const address = locationHint || null;
  if (hasEvidence) {
    return {
      status: "matched",
        boroughs,
        addresses: extracted.addresses,
        bbls: inferred,
      address,
      source: "property_location + NYCIDA address fields",
      reason: null,
    };
  }
  return {
    status: UNKNOWN,
    boroughs: [],
    addresses: [],
    bbls: [],
    address: null,
    source: null,
    reason: "no project address or BBL evidence in the public Build NYC record",
  };
}

function buildTimeline(project) {
  const stageDocs = {
    application: docState(project.application.url),
    hearing: docState(project.hearing.url),
    board_decision: docState(project.board_decision.url),
    closing: docState(project.closing.url),
    compliance: docState(project.compliance.url),
  };

  return STAGES.map((stage) => {
    if (stage === STAGE_APPLICATION) {
      return {
        stage: STAGE_APPLICATION,
        status: project.application.date || project.application.status ? "matched" : UNKNOWN,
        date: project.application.date,
        official_action: "application_review",
        outcome: project.application.status || UNKNOWN,
        source: stageDocs.application,
        detail: {
          notice_id: project.notice_id || null,
          company: project.company || null,
          request_id: project.request_id || null,
        },
      };
    }
    if (stage === STAGE_HEARING) {
      return {
        stage: STAGE_HEARING,
        status: project.hearing.date || project.hearing.status ? "matched" : UNKNOWN,
        date: project.hearing.date,
        official_action: "public_hearing",
        outcome: project.hearing.status || (project.hearing.date ? "held" : UNKNOWN),
        source: stageDocs.hearing,
        detail: { venue: project.hearing.venue || null },
      };
    }
    if (stage === STAGE_BOARD_DECISION) {
      return {
        stage: STAGE_BOARD_DECISION,
        status: project.board_decision.date || project.board_decision.outcome ? "matched" : UNKNOWN,
        date: project.board_decision.date,
        official_action: "board_decision",
        outcome: project.board_decision.outcome || UNKNOWN,
        source: stageDocs.board_decision,
        detail: { authority: project.board_decision.body || null },
      };
    }
    if (stage === STAGE_CLOSING) {
      return {
        stage: STAGE_CLOSING,
        status: project.closing.date || project.closing.amount !== null || project.closing.status ? "matched" : UNKNOWN,
        date: project.closing.date,
        official_action: "closing",
        outcome: project.closing.status || UNKNOWN,
        source: stageDocs.closing,
        detail: { amount: project.closing.amount },
      };
    }
    return {
      stage: STAGE_COMPLIANCE,
      status: project.compliance.date || project.compliance.status ? "matched" : UNKNOWN,
      date: project.compliance.date,
      official_action: "annual_compliance",
      outcome: project.compliance.status || UNKNOWN,
      source: stageDocs.compliance,
      detail: { report_year: project.compliance.year || null },
    };
  });
}

export function parseNYCIDAProjects(rawRows) {
  if (!Array.isArray(rawRows)) return [];
  return rawRows
    .map((row = {}) => ({
      request_id: plainText(row.request_id || row.notice_id || ""),
      project_id: plainText(row.project_id || row.id || ""),
      project_name: plainText(row.project_name || row.name || ""),
      company: plainText(row.company_name || row.developer_name || row.sponsor || ""),
      project_address: plainText(row.project_address || row.address || ""),
      location_text: plainText(row.location_text || row.scope || ""),
      bbl: normalizeBbl(row.bbl || row.bbls || ""),
      bbls: splitBbls(row.bbls || []),
      requested_benefit: moneyState(row.requested_benefit_amount || row.requested_benefits),
      estimated_cost: moneyState(row.estimated_public_cost || row.estimated_cost || row.public_cost),
      application: {
        date: toDate(pickFirst(row.application_date, row.applied_date)),
        status: plainText(row.application_status || row.application_result || "submitted"),
        url: row.application_url || row.application_document || "",
      },
      hearing: {
        date: toDate(row.hearing_date),
        status: plainText(row.hearing_status || row.hearing_outcome || ""),
        venue: plainText(row.hearing_venue || ""),
        url: row.hearing_notice_url || row.hearing_url || "",
      },
      board_decision: {
        date: toDate(row.board_decision_date),
        outcome: plainText(row.board_decision_outcome || row.board_outcome || ""),
        body: plainText(row.board_body || row.board || ""),
        url: row.board_decision_url || row.board_url || "",
      },
      closing: {
        date: toDate(row.closing_date),
        status: plainText(row.closing_status || ""),
        amount: toAmount(row.closing_amount || row.award_amount || ""),
        url: row.closing_notice_url || row.closing_url || "",
      },
      compliance: {
        year: plainText(row.compliance_year || ""),
        date: toDate(row.compliance_date || row.compliance_report_date || ""),
        status: plainText(row.compliance_status || ""),
        url: row.compliance_report_url || row.compliance_url || "",
      },
    }))
    .filter((project) => project.project_id || project.request_id || project.project_name);
}

export function matchProjectToNotice(notice, projects = []) {
  const noticeId = String(notice?.request_id || "").trim();
  if (!noticeId) return null;

  const direct = projects.find((project) => project.request_id && project.request_id === noticeId);
  if (direct) return direct;

  const noticeTitle = pickFirst(notice.short_title, notice.title, notice.subject);
  const noticeCompany = pickFirst(notice.vendor_name, notice.sponsor_name, notice.entity);
  let best = null;
  let bestScore = 0;

  for (const project of projects) {
    const titleScore = overlapScore(noticeTitle, project.project_name);
    const companyScore = noticeCompany && project.company
      ? overlapScore(noticeCompany, project.company) * 0.8
      : 0;
    const score = Math.max(titleScore, companyScore);
    if (score > bestScore) {
      best = project;
      bestScore = score;
    }
  }
  return bestScore >= 0.35 ? best : null;
}

export function assembleSubsidyLifecycle(notices = [], projects = []) {
  return (notices || []).map((notice = {}) => {
    const matched = matchProjectToNotice(notice, projects);
    if (!matched) {
      return {
        request_id: String(notice.request_id || "").trim() || null,
        project: null,
        stage: STAGE_APPLICATION,
        join: {
          matched: false,
          reason: "No matching NYCIDA/Build NYC project record was linked to this notice from public sources.",
        },
        company: {
          status: UNKNOWN,
          value: null,
          source: null,
          reason: "No linked Build NYC project company record.",
        },
        place: {
          status: UNKNOWN,
          reason: "No linked Build NYC place evidence.",
          boroughs: [],
          addresses: [],
          bbls: [],
        },
        money: {
          requested_benefit: moneyState(null),
          estimated_cost: moneyState(null),
        },
        documents: {
          application: docState(),
          hearing: docState(),
          board_decision: docState(),
          closing: docState(),
          compliance: docState(),
        },
        timeline: STAGES.map((stage) => ({
          stage,
          status: UNKNOWN,
          date: null,
          official_action: stage === STAGE_APPLICATION ? "application_review" : stage === STAGE_HEARING ? "public_hearing" : stage === STAGE_BOARD_DECISION ? "board_decision" : stage === STAGE_CLOSING ? "closing" : "annual_compliance",
          outcome: UNKNOWN,
          source: docState(),
          detail: null,
        })),
      };
    }

    const place = buildPlace(notice, matched);
    const timeline = buildTimeline(matched);
    const current = resolveStage(matched);
    return {
      request_id: String(notice.request_id || "").trim() || null,
      project: {
        id: matched.project_id || null,
        name: matched.project_name || null,
        company: matched.company || null,
      },
      stage: current,
      join: {
        matched: true,
        method: matched.request_id ? "request_id" : "title_or_company_overlap",
        source: "Build NYC",
        project_reference: matched.project_id || matched.request_id || null,
      },
      company: {
        status: matched.company ? "matched" : UNKNOWN,
        value: matched.company || null,
        source: matched.company ? "Build NYC" : null,
      },
      place: {
        status: place.status,
        boroughs: place.boroughs,
        addresses: place.addresses,
        bbls: place.bbls,
        address: place.address,
        source: place.source,
        reason: place.reason || null,
      },
      money: {
        requested_benefit: matched.requested_benefit,
        estimated_cost: matched.estimated_cost,
      },
      documents: {
        application: docState(matched.application.url),
        hearing: docState(matched.hearing.url),
        board_decision: docState(matched.board_decision.url),
        closing: docState(matched.closing.url),
        compliance: docState(matched.compliance.url),
      },
      timeline,
    };
  });
}
