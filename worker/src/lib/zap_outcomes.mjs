// Pure ZAP outcome parse + join helpers.
//
// Open Data hgx4-8ukb publishes project status; final decision documents, action
// statuses, disposition votes, and board recommendations live on the Planning Labs
// ZAP API (same machine path the public portal uses):
//   https://zap-api-production.herokuapp.com/projects/{project_id}
//
// Measured 2026-07-30 (see site/data/zap_outcome_sources/ and source_contracts
// join_measurement for zap-api-outcomes):
//   ULURP completed sample (n=50): useful outcome 100%, any documents 100%,
//     disposition votes 90%, approved actions 68%.
//   Mixed active+completed sample (n=60): project_id exact join 100%,
//     any documents 66.7%.
//   Complete sample BBL→DOB NOW any filing: 56% (14/25); 63.6% of projects with BBL.
//
// Accepted join strategies (strict only):
//   exact_project_id — Open Data project_id equals ZAP API project id (case-sensitive
//                      after trim; IDs are alphanumeric with optional leading P).
//   exact_bbl        — tax-lot BBL from zap-bbl equals DOB NOW bbl (digits only).
//
// Rejected as weak:
//   title-only project match
//   partial ULURP number containment without exact project_id
//   BBL prefix / borough+block without full lot
//
// Verdict: above usefulness threshold (≥30%) on decision-document outcomes.
// Ship edge materialization via GET /zap-outcomes (precompute-first for the browser).

import { extractUlurpKeys } from "./ulurp_recommendations_join.mjs";
import { extractZapHearingLogistics } from "./zap_hearing_logistics.mjs";

export const ZAP_API_BASE = "https://zap-api-production.herokuapp.com";
export const ZAP_PORTAL_PROJECT = "https://zap.planning.nyc.gov/projects";
export const ZAP_SODA_PROJECTS = "hgx4-8ukb";
export const ZAP_SODA_BBL = "2iga-a6mk";
export const DOB_NOW_DATASET = "w9ak-ipjd";
export const ZAP_OUTCOMES_SOURCE = "zap-api-outcomes";
export const ZAP_OUTCOMES_KV_PREFIX = "zap-outcome:v1:";
export const ZAP_OUTCOMES_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const APPROVED_STATUSES = new Set(["approved", "adopted", "certified"]);
const CITY_RECORD_DETAIL = "https://a856-cityrecord.nyc.gov/RequestDetail";

/** Normalize a ZAP project_id for exact join. */
export function normProjectId(value) {
  const s = String(value || "").trim();
  if (!s) return "";
  // Product IDs are like 2022M0258 or P2018X0210 — keep case of the letter borough code.
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Digits-only BBL (borough+block+lot). */
export function normBbl(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(0, 10) : digits;
}

/**
 * Strict Open Data project_id → ZAP API project id join.
 * @returns {{ method: string, project_id: string } | null}
 */
export function joinProjectId(openDataProjectId, apiProjectId) {
  const a = normProjectId(openDataProjectId);
  const b = normProjectId(apiProjectId);
  if (!a || !b) return null;
  if (a === b) return { method: "exact_project_id", project_id: a };
  return null;
}

/**
 * Build public document proxy URL used by the ZAP portal.
 * kind: disposition | artifact | package | projectaction
 */
export function documentProxyUrl(kind, serverRelativeUrl) {
  const k = String(kind || "").toLowerCase().replace(/[^a-z]/g, "");
  if (!k) return null;
  const id = String(serverRelativeUrl || "").replace(/^\/+/, "").trim();
  if (!id || !/^[A-Za-z0-9_-]{8,128}$/.test(id)) return null;
  return `${ZAP_API_BASE}/document/${k}/${id}`;
}

function isoDate(value) {
  if (!value) return null;
  const s = String(value);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

/** Full ISO datetime when the CRM field includes a non-midnight clock time. */
function isoDateTime(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return isoDate(s);
  // Pure date stamped as midnight UTC → keep date-only precision.
  if (/T00:00:00(?:\.0+)?Z$/i.test(s)) return isoDate(s);
  return new Date(t).toISOString();
}

function clean(value) {
  if (value == null) return null;
  const s = String(value).replace(/\s+/g, " ").trim();
  return s || null;
}

function eventTime(value, basis, certainty = "actual") {
  const date = isoDate(value);
  return date ? { value: date, precision: "day", basis, certainty } : null;
}

function parseMilestone(item) {
  const a = item?.attributes || {};
  const actualEnd = eventTime(a["dcp-actualenddate"], "actual_end");
  const reviewMeeting = eventTime(a["dcp-reviewmeetingdate"], "review_meeting");
  const reviewMeetingAt = reviewMeeting
    ? isoDateTime(a["dcp-reviewmeetingdate"])
    : null;
  const actualStart = eventTime(a["dcp-actualstartdate"], "actual_start");
  const plannedEnd = eventTime(a["dcp-plannedcompletiondate"], "planned_completion", "planned");
  // A published meeting date is the event itself; actual-end is the workflow close date.
  const time = reviewMeeting || actualEnd || actualStart || plannedEnd;
  if (!time) return null;
  const sourceTitle = clean(a.milestonename) || clean(a["dcp-name"]);
  const sourceTitleField = clean(a.milestonename)
    ? "milestonename"
    : clean(a["dcp-name"])
      ? "dcp-name"
      : null;
  return {
    id: item?.id || null,
    title: clean(a["display-name"]) || clean(a.milestonename) || clean(a["dcp-name"]) || "ZAP milestone",
    source_title: sourceTitle,
    source_title_field: sourceTitleField,
    review_meeting_at: reviewMeetingAt,
    description: clean(a["display-description"]),
    status: clean(a.statuscode),
    outcome: clean(a.outcome),
    sequence: Number.isFinite(Number(a["dcp-milestonesequence"]))
      ? Number(a["dcp-milestonesequence"])
      : null,
    time,
  };
}

function collectDocs(kind, attributes) {
  const docs = [];
  const list = attributes?.documents;
  if (!Array.isArray(list)) return docs;
  for (const d of list) {
    const name = clean(d?.name);
    const url = documentProxyUrl(kind, d?.serverRelativeUrl);
    if (!name && !url) continue;
    docs.push({
      kind,
      name: name || "Document",
      url,
      time_created: d?.timeCreated || null,
    });
  }
  return docs;
}

function actionCodeFromDispositionName(name) {
  const match = String(name || "").match(/(?:^|_)(ZM|ZR|ZA|ZC|ZS|HA|PC|PQ|HG|LD|MM)(?:_|$)/i);
  return match ? match[1].toUpperCase() : null;
}

function dispositionGroupKey(disposition) {
  return [
    disposition.representing,
    disposition.vote_date,
    disposition.hearing_date,
    disposition.hearing_location,
    disposition.community_board,
    disposition.borough_president,
    disposition.borough_board,
    disposition.votes_for,
    disposition.votes_against,
    disposition.votes_abstain,
  ].map((value) => value == null ? "" : String(value).trim().toLowerCase()).join("|");
}

/** Collapse ZM/ZR (and similar) rows that repeat one body's vote. */
export function groupZapDispositions(dispositions) {
  const groups = new Map();
  for (const disposition of dispositions || []) {
    const key = dispositionGroupKey(disposition);
    const existing = groups.get(key);
    const code = actionCodeFromDispositionName(disposition.name);
    if (!existing) {
      groups.set(key, {
        ...disposition,
        action_codes: code ? [code] : [],
        source_ids: disposition.id ? [disposition.id] : [],
      });
      continue;
    }
    if (code && !existing.action_codes.includes(code)) existing.action_codes.push(code);
    if (disposition.id && !existing.source_ids.includes(disposition.id)) existing.source_ids.push(disposition.id);
    existing.n_documents += disposition.n_documents || 0;
  }
  return [...groups.values()].map((group) => ({
    ...group,
    action_codes: [...new Set(group.action_codes)].sort(),
    n_source_rows: group.source_ids.length,
  }));
}

function dedupeDocumentsByName(documents) {
  const seen = new Set();
  return (documents || []).filter((document) => {
    const key = String(document.name || "").trim().toLocaleLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Parse a ZAP API project payload into a product outcome record.
 * Pure — no fetch.
 */
export function parseZapApiProject(payload) {
  const data = payload?.data;
  if (!data || data.type !== "projects") {
    return {
      join: { matched: false, method: null, reason: "ZAP API payload missing project data." },
      project_id: null,
      useful: false,
    };
  }
  const attrs = data.attributes || {};
  // Public ZAP project codes look like 2022M0258 / P2018X0210. CRM GUIDs live on
  // attributes.dcp-projectid; JSON:API data.id and dcp-name carry the public code.
  const candidates = [
    data.id,
    attrs["dcp-name"],
    attrs["dcp-projectid"],
    attrs.dcp_projectid,
  ];
  let projectId = null;
  for (const cand of candidates) {
    const c = clean(cand);
    if (!c) continue;
    if (/^[A-Z]?\d{4}[A-Z]\d{4}$/i.test(c) || /^P\d{4}[A-Z]\d{4}$/i.test(c)) {
      projectId = c.toUpperCase().replace(/[^A-Z0-9]/g, "");
      break;
    }
  }
  if (!projectId) projectId = clean(data.id) || clean(attrs["dcp-name"]);
  const included = Array.isArray(payload.included) ? payload.included : [];

  const actions = [];
  const milestones = [];
  const dispositions = [];
  const documents = [];

  for (const item of included) {
    const type = item?.type;
    const a = item?.attributes || {};
    if (type === "actions") {
      const status = clean(a.statuscode);
      const statusLower = (status || "").toLowerCase();
      actions.push({
        id: item.id || null,
        action: clean(a["dcp-action-value"]),
        ulurp_number: clean(a["dcp-ulurpnumber"]),
        status,
        approved: APPROVED_STATUSES.has(statusLower),
        cc_resolution: clean(a["dcp-ccresolutionnumber"]),
        sharepoint_url: clean(a["dcp-spabsoluteurl"]),
      });
    } else if (type === "milestones") {
      const milestone = parseMilestone(item);
      if (milestone) milestones.push(milestone);
    } else if (type === "dispositions") {
      const docs = collectDocs("disposition", a);
      documents.push(...docs);
      dispositions.push({
        id: item.id || null,
        name: clean(a["dcp-name"]),
        status: clean(a.statuscode),
        representing: clean(a["dcp-representing"]),
        vote_date: isoDate(a["dcp-dateofvote"]),
        hearing_date: isoDate(a["dcp-dateofpublichearing"]),
        // Full clock when present (e.g. 2026-07-02T13:30:00.000Z → 9:30 AM ET).
        hearing_at: isoDateTime(a["dcp-dateofpublichearing"]),
        // Free-text logistics — often "In person at … or livestreamed at …".
        hearing_location: clean(a["dcp-publichearinglocation"]),
        vote_location: clean(a["dcp-votelocation"]),
        community_board: clean(a["dcp-communityboardrecommendation"]),
        borough_president: clean(a["dcp-boroughpresidentrecommendation"]),
        borough_board: clean(a["dcp-boroughboardrecommendation"]),
        votes_for: a["dcp-votinginfavorrecommendation"] ?? null,
        votes_against: a["dcp-votingagainstrecommendation"] ?? null,
        votes_abstain: a["dcp-votingabstainingonrecommendation"] ?? null,
        n_documents: docs.length,
      });
    } else if (type === "artifacts") {
      documents.push(...collectDocs("artifact", a));
    } else if (type === "packages") {
      documents.push(...collectDocs("package", a));
    }
  }

  const groupedDispositions = groupZapDispositions(dispositions);
  const uniqueDocs = dedupeDocumentsByName(documents);

  const approvedActions = actions.filter((a) => a.approved);
  const useful =
    uniqueDocs.length > 0
    || approvedActions.length > 0
    || groupedDispositions.some((d) => d.vote_date || d.community_board)
    || Boolean(attrs["dcp-projectcompleted"] || attrs["dcp-publicstatus"]);

  const portalUrl = projectId ? `${ZAP_PORTAL_PROJECT}/${encodeURIComponent(projectId)}` : null;
  const shell = {
    join: {
      matched: true,
      method: "exact_project_id",
      reason: null,
    },
    project_id: projectId,
    project_name: clean(attrs["dcp-projectname"]),
    public_status: clean(attrs["dcp-publicstatus"]),
    project_brief: clean(attrs["dcp-projectbrief"]),
    completed_date: isoDate(attrs["dcp-projectcompleted"]),
    certified_referred: isoDate(attrs["dcp-certifiedreferred"]),
    last_milestone_date: isoDate(attrs["dcp-lastmilestonedate"]),
    portal_url: portalUrl,
    actions,
    milestones: milestones.sort((a, b) => (
      String(a.time?.value || "").localeCompare(String(b.time?.value || ""))
      || (a.sequence ?? 0) - (b.sequence ?? 0)
    )),
    approved_actions: approvedActions,
    dispositions: groupedDispositions,
    documents: uniqueDocs.slice(0, 40),
    n_documents: uniqueDocs.length,
    n_dispositions: groupedDispositions.length,
    n_approved_actions: approvedActions.length,
    useful,
    source: ZAP_OUTCOMES_SOURCE,
    api_base: ZAP_API_BASE,
  };
  // Precompute hearing logistics (venue + livestream + datetime) from disposition
  // free text — never invent when the fragment cannot be parsed confidently.
  const hearingLogistics = extractZapHearingLogistics(shell, {
    project_id: projectId,
    portal_url: portalUrl,
    borough: clean(attrs["dcp-borough"]),
  });
  // Honest absence is a first-class state on the individual-project read model.
  // An empty array looks like a completed collection with zero rows; null means
  // the publisher supplied no qualifying disposition hearing evidence.
  shell.hearing_logistics = hearingLogistics.length ? hearingLogistics : null;
  return shell;
}

function cityRecordBlob(row) {
  return [
    row?.short_title,
    row?.additional_description_1,
    row?.additional_description_2,
    row?.additional_description_3,
    row?.other_info_1,
    row?.other_info_2,
    row?.other_info_3,
    row?.printout_1,
    row?.printout_2,
    row?.printout_3,
  ].filter(Boolean).join(" ").replace(/<[^>]*>/g, " ");
}

/** Strictly join City Record candidate rows by normalized ULURP application token. */
export function joinCityRecordLandNotices(rows, ulurpNumbers) {
  const projectKeys = extractUlurpKeys(ulurpNumbers);
  if (!projectKeys.size) return [];
  const joined = [];
  const seen = new Set();
  for (const row of rows || []) {
    const requestId = clean(row?.request_id);
    if (!requestId || seen.has(requestId)) continue;
    const noticeKeys = extractUlurpKeys(cityRecordBlob(row));
    const keys = [...projectKeys].filter((key) => noticeKeys.has(key)).sort();
    if (!keys.length) continue;
    seen.add(requestId);
    joined.push({
      ...row,
      join: { method: "exact_ulurp_token", keys },
    });
  }
  return joined.sort((a, b) => String(a.start_date || "").localeCompare(String(b.start_date || "")));
}

function source(id, label, url) {
  return { id, label, url };
}

function milestoneEvent(milestone, record) {
  return {
    id: `zap-milestone:${milestone.id || milestone.sequence || milestone.time.value}`,
    kind: "zap_milestone",
    title: milestone.title,
    detail: milestone.outcome || milestone.status || null,
    status: milestone.status,
    outcome: milestone.outcome,
    time: milestone.time,
    source: source("zap-project-api", "Zoning Application Portal", record.portal_url),
  };
}

function dispositionEvent(disposition, index, record) {
  const time = eventTime(disposition.vote_date, "vote_date")
    || eventTime(disposition.hearing_date, "hearing_date");
  if (!time) return null;
  const recommendation = disposition.community_board
    || disposition.borough_president
    || disposition.borough_board
    || disposition.status;
  return {
    id: `zap-disposition:${disposition.source_ids?.join("+") || disposition.id || index}`,
    kind: "zap_disposition",
    title: clean(disposition.representing) || "Land-use disposition",
    detail: clean(recommendation),
    status: disposition.status,
    outcome: clean(recommendation),
    time,
    source: source("zap-project-api", "Zoning Application Portal", record.portal_url),
  };
}

function noticeEvents(notice) {
  const requestId = clean(notice.request_id);
  const url = `${CITY_RECORD_DETAIL}/${encodeURIComponent(requestId)}`;
  const src = source("city-record", "City Record", url);
  const title = clean(notice.short_title) || clean(notice.type_of_notice_description) || "Land-use notice";
  const events = [];
  const published = eventTime(notice.start_date, "publication_date");
  if (published) {
    events.push({
      id: `city-record:${requestId}:published`,
      kind: "city_record_notice_published",
      title,
      detail: clean(notice.agency_name),
      status: "published",
      outcome: null,
      time: published,
      source: src,
      join: notice.join,
    });
  }
  const hearing = eventTime(notice.event_date, "event_date");
  if (hearing) {
    events.push({
      id: `city-record:${requestId}:hearing`,
      kind: "city_record_hearing",
      title,
      detail: clean(notice.agency_name),
      status: "scheduled",
      outcome: null,
      time: hearing,
      source: src,
      join: notice.join,
    });
  }
  return events;
}

function openDataPortalLag(record) {
  const openDate = isoDate(record?.open_data?.current_milestone_date);
  const portalDate = isoDate(record?.last_milestone_date);
  if (!openDate || !portalDate) {
    return { status: "unknown", days: null, open_data_date: openDate, portal_date: portalDate };
  }
  const days = Math.max(0, Math.round((Date.parse(portalDate) - Date.parse(openDate)) / 86400000));
  return {
    status: portalDate > openDate ? "behind" : "aligned",
    days,
    open_data_date: openDate,
    portal_date: portalDate,
  };
}

/**
 * Combine ZAP portal milestones/outcomes and strictly joined City Record notices
 * into one source-linked, date-normalized rail. Empty slots remain explicit.
 */
export function buildLandEventSpine(
  record,
  { cityRecordNotices = [], noticeLookupStatus = "ok" } = {},
) {
  const events = [];
  for (const milestone of record?.milestones || []) events.push(milestoneEvent(milestone, record));
  for (const [index, disposition] of (record?.dispositions || []).entries()) {
    const event = dispositionEvent(disposition, index, record);
    if (event) events.push(event);
  }
  for (const notice of cityRecordNotices || []) events.push(...noticeEvents(notice));
  events.sort((a, b) => a.time.value.localeCompare(b.time.value) || a.id.localeCompare(b.id));

  const gaps = [];
  if (!(record?.milestones || []).length) {
    gaps.push({
      slot: "zap_milestones",
      class: "not_yet_ingested",
      taxonomy: true,
      source: "Zoning Application Portal",
    });
  }
  if (!(cityRecordNotices || []).length) {
    gaps.push(noticeLookupStatus === "unavailable"
      ? {
          slot: "city_record_notices",
          class: "source_unavailable",
          taxonomy: false,
          source: "City Record Online",
        }
      : {
          slot: "city_record_notices",
          class: "not_published",
          taxonomy: true,
          source: "City Record Online",
        });
  }

  return {
    schema_version: 1,
    project_id: record?.project_id || record?.open_data?.project_id || null,
    join: {
      zap: record?.join || null,
      city_record: cityRecordNotices.length
        ? { matched: true, method: "exact_ulurp_token", count: cityRecordNotices.length }
        : { matched: false, method: "exact_ulurp_token", count: 0 },
    },
    events,
    gaps,
    lag: { open_data_vs_portal: openDataPortalLag(record) },
  };
}

/**
 * Join an Open Data project row to a parsed ZAP API outcome.
 */
export function joinOpenDataToZapOutcome(openDataRow, apiPayload) {
  const odId = openDataRow?.project_id;
  const parsed = parseZapApiProject(apiPayload);
  if (!parsed.join.matched) {
    return {
      ...parsed,
      open_data: openDataRow || null,
      join: {
        matched: false,
        method: null,
        reason: parsed.join.reason || "ZAP API project detail not available.",
      },
    };
  }
  const hit = joinProjectId(odId, parsed.project_id);
  if (!hit) {
    return {
      join: {
        matched: false,
        method: null,
        reason: "Open Data project_id does not match ZAP API project id.",
      },
      project_id: odId || null,
      open_data: openDataRow || null,
      useful: false,
    };
  }
  return {
    ...parsed,
    join: { matched: true, method: hit.method, reason: null },
    open_data: openDataRow || null,
  };
}

/**
 * Normalize a DOB NOW filing row for land outcome side-car.
 */
export function normalizeDobFiling(row) {
  const r = row || {};
  return {
    job_filing_number: clean(r.job_filing_number),
    filing_status: clean(r.filing_status),
    job_type: clean(r.job_type),
    filing_date: isoDate(r.filing_date),
    house_no: clean(r.house_no),
    street_name: clean(r.street_name),
    bbl: normBbl(r.bbl),
    bin: clean(r.bin),
  };
}

/**
 * Strict BBL join: return filings whose BBL is in the project BBL set.
 */
export function joinDobFilingsToBbls(filings, bbls) {
  const set = new Set((bbls || []).map(normBbl).filter((b) => b.length >= 10));
  if (!set.size) {
    return { matched: false, method: null, filings: [], reason: "No validated tax lots for this project." };
  }
  const hits = [];
  for (const raw of filings || []) {
    const f = normalizeDobFiling(raw);
    if (f.bbl && set.has(f.bbl)) hits.push(f);
  }
  if (!hits.length) {
    return {
      matched: false,
      method: "exact_bbl",
      filings: [],
      reason: "No DOB NOW filings on the project tax lots in the current window.",
    };
  }
  // Prefer recent filings; cap for UI
  hits.sort((a, b) => String(b.filing_date || "").localeCompare(String(a.filing_date || "")));
  return {
    matched: true,
    method: "exact_bbl",
    filings: hits.slice(0, 8),
    reason: null,
  };
}

/**
 * Whether an outcome record should render as a filled slot (vs class-(a) gap copy).
 */
export function outcomeIsFilled(record) {
  if (!record?.join?.matched) return false;
  return Boolean(
    record.useful
    && (
      (record.n_documents || 0) > 0
      || (record.n_approved_actions || 0) > 0
      || (record.dispositions || []).some((d) => d.vote_date || d.community_board)
    ),
  );
}
