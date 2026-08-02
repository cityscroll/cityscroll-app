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
  // Strip currency symbols and thousand separators, including spaced forms like
  // "$10, 667, 606" (comma + space after each group) that City Record bodies use.
  const normalized = String(value || "")
    .trim()
    .replace(/[$,]/g, "")
    .replace(/\s+/g, "");
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

function moneyState(raw, meta = {}) {
  const value = toAmount(raw);
  if (value === null) {
    return {
      status: UNKNOWN,
      value: null,
      currency: "USD",
      reason: meta.reason || "public money amount is not stated in this source",
      ...(meta.source ? { source: meta.source } : {}),
    };
  }
  return {
    status: "matched",
    value,
    currency: "USD",
    ...(meta.source ? { source: meta.source } : {}),
    ...(meta.field ? { field: meta.field } : {}),
  };
}

/**
 * Parse published project/development cost dollars from a City Record IDA/Build NYC
 * hearing notice body. Notices often list "Total Project Cost : $…" and/or
 * "Total Development Cost : $…" per company. Returns every hit plus a preferred
 * estimated_cost for the lifecycle money card (first Total Project Cost, else first
 * Total Development Cost).
 *
 * Pure: no fetch. The structured Build NYC feed is a separate path — when that
 * feed is bot-blocked, these notice-body figures are the honest public amounts.
 */
export function parseHearingMoneyFromBody(bodyText) {
  const text = plainText(bodyText || "");
  const costs = [];
  if (!text) {
    return {
      costs,
      total_project_cost: null,
      total_development_cost: null,
      estimated_cost: moneyState(null, {
        source: "city-record-hearing",
        reason: "no Total Project Cost or Total Development Cost in City Record hearing body",
      }),
    };
  }
  // Amount group allows optional whitespace after each thousands separator so
  // "$10, 667, 606" and "$10,667,606" both capture the full figure (not just "10").
  // Leading digits only (not [\d,]+) so the first comma-space group is not swallowed.
  const re = /Total\s+(Project|Development)\s+Cost\s*:?\s*\$?\s*(\d{1,3}(?:\s*,\s*\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/gi;
  let match;
  while ((match = re.exec(text)) !== null) {
    const value = toAmount(match[2]);
    if (value === null) continue;
    const kind = String(match[1]).toLowerCase() === "project"
      ? "total_project_cost"
      : "total_development_cost";
    costs.push({ kind, value, currency: "USD" });
  }
  const firstProject = costs.find((c) => c.kind === "total_project_cost") || null;
  const firstDevelopment = costs.find((c) => c.kind === "total_development_cost") || null;
  const preferred = firstProject || firstDevelopment;
  return {
    costs,
    total_project_cost: firstProject ? firstProject.value : null,
    total_development_cost: firstDevelopment ? firstDevelopment.value : null,
    estimated_cost: preferred
      ? moneyState(preferred.value, {
        source: "city-record-hearing",
        field: preferred.kind,
      })
      : moneyState(null, {
        source: "city-record-hearing",
        reason: "no Total Project Cost or Total Development Cost in City Record hearing body",
      }),
  };
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

/**
 * Short place hint from an IDA hearing body — never the full body dump.
 * Prefers a facility street line ("located at …" / "at 4425-4429 1st Avenue, Brooklyn"),
 * else borough names only.
 */
export function placeHintFromIdaBody(bodyText) {
  const text = plainText(bodyText || "");
  if (!text) return { address: "", location_text: "", boroughs: [] };

  const cleanAddr = (raw) => {
    let s = plainText(raw || "")
      .replace(/\s*\(the\s+.*$/i, "")
      .replace(/\s*,?\s*(New York|NY)\s*\d{0,5}\s*$/i, "")
      .replace(/\s*,?\s*$/, "")
      .trim();
    if (s.length > 120) s = s.slice(0, 120).replace(/,\s*\S*$/, "").trim();
    return s;
  };

  // "parcel of land at 69 Hinsdale Street, Brooklyn, New York" / "located at …"
  const located = text.match(
    /\b(?:located\s+at|parcel\s+of\s+land\s+at)\s+([0-9][^.()]{6,110}?)(?:\s*\(|\.|;|$)/i,
  );
  if (located) {
    const address = cleanAddr(located[1]);
    if (address.length >= 8) {
      return {
        address,
        location_text: address,
        boroughs: boroughsIn(address),
      };
    }
  }

  // "at 4425-4429 1st Avenue, Brooklyn" (Project Description style)
  const atStreet = text.match(
    /\bat\s+([0-9][-0-9]*\s+[^.()]{3,70}?\b(?:Avenue|Ave\.?|Street|St\.?|Road|Rd\.?|Boulevard|Blvd\.?|Place|Pl\.?|Drive|Dr\.?|Lane|Ln\.?|Way|Court|Ct\.?)\b[^.]{0,50}?)(?:\.|;|$)/i,
  );
  if (atStreet) {
    const address = cleanAddr(atStreet[1]);
    if (address.length >= 8) {
      return {
        address,
        location_text: address,
        boroughs: boroughsIn(address),
      };
    }
  }

  const boroughs = boroughsIn(text);
  if (boroughs.length) {
    const location_text = boroughs.join(", ");
    return { address: location_text, location_text, boroughs };
  }
  return { address: "", location_text: "", boroughs: [] };
}

function buildPlace(notice = {}, project = {}) {
  const projectAddress = plainText(project.project_address || "");
  const locationText = plainText(project.location_text || "");
  // Extraction source: structured project fields + short title. Do not join full
  // notice body into the display address (city-record hearing bodies are multi-KB).
  const extractionSource = [
    projectAddress,
    locationText,
    plainText(notice.short_title || "").slice(0, 160),
  ].filter(Boolean).join(" ");
  const bodyForHints = plainText([
    notice.additional_description_1,
    notice.additional_description_2,
    notice.additional_description_3,
    notice.other_info_1,
  ].filter(Boolean).join(" "));
  const locationHint = normalizeAddress(
    extractionSource || bodyForHints.slice(0, 240),
  );
  const extracted = propertyLocationFromRow({
    short_title: pickFirst(project.project_name, notice.short_title),
    additional_description_1: projectAddress || locationText || locationHint || bodyForHints.slice(0, 400),
  });
  const boroughHints = unique([
    ...boroughsIn(locationHint),
    ...boroughsIn(projectAddress),
    ...boroughsIn(locationText),
    ...boroughsIn(bodyForHints),
  ]);
  const explicit = splitBbls([project.bbl, ...(project.bbls || [])]);
  const inferred = unique([...extracted.bbls, ...explicit]);
  const boroughs = unique([...boroughHints, ...extracted.boroughs]);
  // Prefer the short structured address over a concatenated locationHint dump.
  const address = projectAddress
    || (extracted.addresses && extracted.addresses[0])
    || (locationText && locationText.length <= 160 ? locationText : null)
    || (boroughs.length === 1 ? boroughs[0] : boroughs.length ? boroughs.join(", ") : null)
    || null;
  const hasEvidence = !!address || !!locationHint || inferred.length
    || extracted.addresses.length || extracted.tax_lots.length || boroughs.length;
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
    // Synthetic City Record-derived rows are a fallback, never preferred over a feed match.
    if (String(project.project_id || "").startsWith("city-record:")) continue;
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

// When the Build NYC document feed is unreachable (or has no row for this hearing), derive a
// hearing-stage project from the City Record notice itself. IDA public-hearing notices are the
// public hearing stage — they list companies and applications. This is not a substitute for
// board/closing/compliance documents; those stay explicit unknowns until the feed recovers.
// Typical lag after a hearing before later Build NYC / IDA stages are public enough
// that absence is "not published" rather than "too soon". Conservative generic weeks —
// not measured publication stats. Temporal sibling of paid / verified_zero / unavailable.
export const SUBSIDY_STAGE_EXPECT_LAG_DAYS = {
  board_decision: 60, // ~one board cycle after the hearing
  closing: 180, // closing packages often land months later
  compliance: 400, // first annual compliance window
  project_record: 90, // whole-project join after hearing
};

export function daysSinceIso(iso, asOf = new Date()) {
  const start = String(iso || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return null;
  const a = Date.UTC(+start.slice(0, 4), +start.slice(5, 7) - 1, +start.slice(8, 10));
  const end = asOf instanceof Date ? asOf : new Date(asOf);
  if (Number.isNaN(end.valueOf())) return null;
  const b = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  return Math.floor((b - a) / 86400000);
}

export function lagWeeksForStage(stage) {
  const days = SUBSIDY_STAGE_EXPECT_LAG_DAYS[stage] ?? SUBSIDY_STAGE_EXPECT_LAG_DAYS.project_record;
  return Math.max(1, Math.round(days / 7));
}

// Four honest gap states for subsidy slots (when not matched):
//   too_soon          — typical publication lag has not elapsed
//   not_published     — lag elapsed after a real project-feed join; class-(b) absence
//   not_yet_ingested  — project feed never joined (or unreachable); class-(a) incomplete ingest
//   unavailable       — whole-feed operational failure with no City Record fallback
//
// feedJoined=false (City Record hearing only / feed-down): aged empties are
// not_yet_ingested — never "city does not publish" when we never fetched Build NYC.
export function subsidyGapKind({
  stage = "project_record",
  anchorDate = null,
  asOf = new Date(),
  matched = false,
  feedJoined = true,
} = {}) {
  if (matched) return null;
  const days = daysSinceIso(anchorDate, asOf);
  const agedClass = feedJoined ? "not_published" : "not_yet_ingested";
  if (days == null) return agedClass;
  const lag = SUBSIDY_STAGE_EXPECT_LAG_DAYS[stage] ?? SUBSIDY_STAGE_EXPECT_LAG_DAYS.project_record;
  if (days < lag) return "too_soon";
  return agedClass;
}

/**
 * When the Build NYC project feed is unreachable but a City Record hearing join
 * still succeeds, remapped unmatched later stages must not claim the city withholds
 * the record. Age-aware not_published only applies after a real project-feed match.
 *
 * @param {object|null} lifecycle
 * @param {{ feedNote?: string }} [opts]
 * @returns {object|null}
 */
export function stampSubsidyFeedUnavailable(lifecycle, opts = {}) {
  if (!lifecycle || typeof lifecycle !== "object") return lifecycle;
  const feedNote = opts.feedNote
    || "Build NYC document feed unreachable; hearing stage from City Record notice.";
  const timeline = Array.isArray(lifecycle.timeline)
    ? lifecycle.timeline.map((entry) => {
      if (!entry || entry.status === "matched") return entry;
      // Keep temporal too_soon; rewrite aged class-(b) to not-yet-ingested.
      if (entry.gap_kind === "too_soon") return entry;
      return { ...entry, gap_kind: "not_yet_ingested" };
    })
    : lifecycle.timeline;
  return {
    ...lifecycle,
    source_status: lifecycle.source_status || "ok",
    join: {
      ...(lifecycle.join || {}),
      feed_status: "unavailable",
      feed_note: feedNote,
    },
    timeline,
  };
}

export function subsidyAnchorDate(notice = {}, lifecycle = null) {
  const fromTimeline = (lifecycle?.timeline || []).find(
    (e) => e && e.stage === STAGE_HEARING && e.date,
  );
  return toDate(
    fromTimeline?.date
      || notice.event_date
      || notice.start_date
      || null,
  );
}

export function isIdaHearingNotice(notice = {}) {
  const agency = String(notice.agency_name || notice.agency || "");
  const title = String(notice.short_title || notice.title || "");
  const type = String(notice.type_of_notice_description || notice.notice_type || "");
  const section = String(notice.section_name || notice.source_section || "");
  const body = plainText([
    notice.additional_description_1,
    notice.additional_description_2,
    notice.additional_description_3,
    notice.other_info_1,
  ].filter(Boolean).join(" "));
  const ida = /industrial development|nycida|build nyc|economic development corporation/i.test(
    `${agency} ${title} ${body}`,
  ) || /\bIDA\b/.test(title);
  if (!ida) return false;
  const hearingType = /hearing|public hearing|meeting/i.test(`${type} ${title}`);
  const hearingSection = section === "Public Hearings and Meetings"
    || (section === "Agency Rules" && /public hearing/i.test(type));
  return hearingType || hearingSection || !!notice.event_date;
}

export function projectFromIdaNotice(notice = {}) {
  if (!isIdaHearingNotice(notice)) return null;
  const requestId = String(notice.request_id || "").trim();
  if (!requestId) return null;
  const body = plainText([
    notice.additional_description_1,
    notice.additional_description_2,
    notice.additional_description_3,
    notice.other_info_1,
    notice.other_info_2,
    notice.other_info_3,
  ].filter(Boolean).join(" "));
  const companies = unique(
    [...body.matchAll(/Company Name\s*:\s*([^,(\n]{3,100})/gi)]
      .map((match) => plainText(match[1]))
      .filter(Boolean),
  );
  const company = companies[0] || "";
  const cityRecordUrl = `https://a856-cityrecord.nyc.gov/RequestDetail/${encodeURIComponent(requestId)}`;
  const hearingDate = toDate(notice.event_date || notice.start_date);
  // Dollar amounts are often published in the hearing body even when the Build NYC
  // structured document feed is unreachable (Cloudflare bot-block). Parse them so
  // the money card is not a false "city does not publish" null.
  const hearingMoney = parseHearingMoneyFromBody(body);
  // Short address/borough only — never dump the multi-KB hearing body into place.
  const placeHint = placeHintFromIdaBody(body);
  return {
    request_id: requestId,
    project_id: `city-record:${requestId}`,
    project_name: plainText(notice.short_title || notice.title || `IDA hearing ${requestId}`),
    company,
    project_address: placeHint.address || "",
    location_text: placeHint.location_text || "",
    bbl: null,
    bbls: [],
    requested_benefit: moneyState(null, {
      source: "city-record-hearing",
      reason: "requested benefit amount is not a labeled dollar field on this City Record hearing notice",
    }),
    estimated_cost: hearingMoney.estimated_cost,
    total_project_cost: hearingMoney.total_project_cost,
    total_development_cost: hearingMoney.total_development_cost,
    hearing_costs: hearingMoney.costs,
    application: {
      date: toDate(notice.start_date),
      status: companies.length ? "filed" : "",
      url: cityRecordUrl,
    },
    hearing: {
      date: hearingDate,
      status: hearingDate ? "held" : "scheduled",
      venue: "",
      url: cityRecordUrl,
    },
    board_decision: { date: null, outcome: "", body: "", url: "" },
    closing: { date: null, status: "", amount: null, url: "" },
    compliance: { year: "", date: null, status: "", url: "" },
    _derived_from: "city-record-hearing",
  };
}

function withGapKinds(timeline, anchorDate, { feedJoined = true } = {}) {
  return (timeline || []).map((entry) => {
    if (!entry || entry.status === "matched") return entry;
    return {
      ...entry,
      gap_kind: subsidyGapKind({
        stage: entry.stage,
        anchorDate,
        matched: false,
        feedJoined,
      }),
    };
  });
}

export function assembleSubsidyLifecycle(notices = [], projects = []) {
  return (notices || []).map((notice = {}) => {
    let matched = matchProjectToNotice(notice, projects);
    if (!matched) {
      // Prefer an explicit synthetic row from the caller; otherwise derive from the notice.
      matched = (projects || []).find(
        (p) => p && p.request_id === String(notice.request_id || "").trim()
          && String(p.project_id || "").startsWith("city-record:"),
      ) || projectFromIdaNotice(notice);
    }
    const anchor = subsidyAnchorDate(notice, null);
    if (!matched) {
      const bareTimeline = STAGES.map((stage) => ({
        stage,
        status: UNKNOWN,
        date: null,
        official_action: stage === STAGE_APPLICATION ? "application_review" : stage === STAGE_HEARING ? "public_hearing" : stage === STAGE_BOARD_DECISION ? "board_decision" : stage === STAGE_CLOSING ? "closing" : "annual_compliance",
        outcome: UNKNOWN,
        source: docState(),
        detail: null,
      }));
      return {
        request_id: String(notice.request_id || "").trim() || null,
        project: null,
        stage: STAGE_APPLICATION,
        join: {
          matched: false,
          gap_kind: subsidyGapKind({ stage: "project_record", anchorDate: anchor, matched: false }),
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
        timeline: withGapKinds(bareTimeline, anchor),
      };
    }

    const place = buildPlace(notice, matched);
    const hearingAnchor = matched.hearing?.date || anchor || subsidyAnchorDate(notice, null);
    const fromCityRecord = matched._derived_from === "city-record-hearing"
      || String(matched.project_id || "").startsWith("city-record:");
    // City Record–only joins never touched the Build NYC project feed — aged empty
    // stages are not_yet_ingested (class a), not not_published (class b).
    const timeline = withGapKinds(buildTimeline(matched), hearingAnchor, {
      feedJoined: !fromCityRecord,
    });
    const current = resolveStage(matched);
    const joinSource = fromCityRecord ? "City Record" : "Build NYC";
    const joinMethod = fromCityRecord
      ? "city-record-hearing"
      : (matched.request_id ? "request_id" : "title_or_company_overlap");
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
        method: joinMethod,
        source: joinSource,
        project_reference: matched.project_id || matched.request_id || null,
        anchor_date: hearingAnchor || null,
      },
      company: {
        status: matched.company ? "matched" : UNKNOWN,
        value: matched.company || null,
        source: matched.company ? joinSource : null,
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
        // City Record hearing-derived totals (null when the feed row supplied money).
        total_project_cost: fromCityRecord ? (matched.total_project_cost ?? null) : null,
        total_development_cost: fromCityRecord ? (matched.total_development_cost ?? null) : null,
        hearing_costs: fromCityRecord && Array.isArray(matched.hearing_costs)
          ? matched.hearing_costs
          : undefined,
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
