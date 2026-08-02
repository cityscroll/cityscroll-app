/**
 * Property disposition process spine — multi-notice chain by parcel/asset.
 *
 * Reconstructs a City Record Property Disposition lifecycle for one asset
 * (hearing → auction/RFP → award/conveyance) by joining notices that share a
 * strict BBL or borough+block/lot key. Pure: no fetch, no env.
 *
 * Not the Property explorer "lifecycle rail" (propStage / PROP_STAGES) — those
 * chips are temporal list filters (proposed/soon/upcoming/past), not process
 * stages of one disposition matter.
 */

import { propertyLocationFromRow } from "../../../site/property_location.mjs";

export const PROPERTY_DISPOSITION_SPINE_SCHEMA_VERSION = 1;

/** Ordered process stages for one disposition matter. */
export const DISPOSITION_STAGES = Object.freeze([
  "hearing",
  "auction_or_rfp",
  "award_or_conveyance",
]);

export const STAGE_HEARING = "hearing";
export const STAGE_AUCTION_OR_RFP = "auction_or_rfp";
export const STAGE_AWARD_OR_CONVEYANCE = "award_or_conveyance";

const CITY_RECORD_SOURCE = "City Record Online";
const CITY_RECORD_URL = "https://a856-cityrecord.nyc.gov/RequestDetail/";

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function plainText(value) {
  return clean(String(value ?? "").replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " "));
}

function isoDate(value) {
  const s = clean(value);
  if (!s) return null;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const d = new Date(s);
  if (Number.isNaN(d.valueOf())) return null;
  return d.toISOString().slice(0, 10);
}

function slugBorough(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function agencyKey(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function bodyText(row) {
  return plainText([
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
  ].filter(Boolean).join(" "));
}

/**
 * Classify a Property Disposition notice into a process stage.
 * Returns null when the notice cannot be staged without inventing a label
 * (generic unlocated surplus, tobacco destruction, etc.).
 */
export function classifyDispositionStage(row) {
  const type = clean(row?.type_of_notice_description);
  const text = bodyText(row);
  // Award / conveyance wins over auction language when both appear.
  if (/\b(?:winning bidder|tentative winning|successful bidder|has been sold|sold for|conveyance|deed of|deed to|closing of the sale|transferred title)\b/i.test(text)) {
    return STAGE_AWARD_OR_CONVEYANCE;
  }
  if (
    type === "Sale"
    || /\b(?:request for proposals?|\brfps?\b|public auction|lease auction|online public lease auction|public sale|bid solicitation|sealed bid|notice of project availability|upset price|minimum bid|surplus assets)\b/i.test(text)
  ) {
    return STAGE_AUCTION_OR_RFP;
  }
  if (
    type === "Public Hearings"
    || type === "Meeting"
    || /\b(?:public hearing|voluntary public hearing|cancelled hearing|cancellation of public hearing)\b/i.test(text)
  ) {
    return STAGE_HEARING;
  }
  if (type === "Notice") {
    // Generic "Notice" without auction/award/hearing language is not a process stage.
    return null;
  }
  return null;
}

/**
 * Strict join keys for disposition chaining.
 * Prefer BBL; otherwise require borough + block + lot (never bare block/lot alone).
 */
export function dispositionJoinKeys(rowOrLocation, row = null) {
  const location = rowOrLocation?.scope
    ? rowOrLocation
    : (rowOrLocation?.property_location || propertyLocationFromRow(rowOrLocation || row || {}));
  const keys = new Set();
  for (const bbl of location?.bbls || []) {
    const digits = String(bbl).replace(/\D/g, "");
    if (/^\d{10}$/.test(digits)) keys.add(`bbl:${digits}`);
  }
  const boroughs = (location?.boroughs || []).map(slugBorough).filter(Boolean);
  for (const lot of location?.tax_lots || []) {
    const block = String(Number(lot?.block));
    if (!block || block === "NaN") continue;
    for (const lotNo of lot?.lots || []) {
      const n = String(Number(lotNo));
      if (!n || n === "NaN") continue;
      for (const borough of boroughs) {
        keys.add(`taxlot:${borough}:${block}/${n}`);
      }
    }
  }
  return [...keys].sort();
}

function noticeSource(row) {
  const id = clean(row?.request_id);
  return {
    id: "city-record",
    label: CITY_RECORD_SOURCE,
    url: id ? `${CITY_RECORD_URL}${id}` : "https://a856-cityrecord.nyc.gov/",
  };
}

function eventTime(row, stage) {
  // Hearings prefer the scheduled event date; sale/award stages prefer publication.
  if (stage === STAGE_HEARING) {
    const event = isoDate(row?.event_date);
    if (event) {
      return {
        value: event,
        precision: "day",
        basis: "event_date",
        certainty: "planned",
      };
    }
  }
  const published = isoDate(row?.start_date);
  if (published) {
    return {
      value: published,
      precision: "day",
      basis: "publication_date",
      certainty: "actual",
    };
  }
  return null;
}

function noticeEvent(row, stage) {
  const requestId = clean(row?.request_id) || "unknown";
  const time = eventTime(row, stage);
  if (!time) return null;
  const title = clean(row?.short_title) || `Property disposition ${stage}`;
  const cancelled = /\bcancel+ed?\b|\bcancellation\b/i.test(bodyText(row));
  return {
    id: `city-record:${requestId}:${stage}`,
    kind: `disposition_${stage}`,
    stage,
    title,
    detail: clean(row?.agency_name) || null,
    status: cancelled ? "cancelled" : "published",
    request_id: requestId,
    type_of_notice: clean(row?.type_of_notice_description) || null,
    time,
    source: noticeSource(row),
  };
}

function subjectFromKeys(keys, notices) {
  // Process identity is (agency, parcel). Two agencies on the same BBL are two spines.
  const agency = agencyKey(notices[0]?.agency_name);
  const agencyPrefix = agency ? `disposition:${agency.replace(/\s+/g, "-")}:` : "disposition:";
  const bbl = keys.find((k) => k.startsWith("bbl:"));
  if (bbl) return `${agencyPrefix}${bbl}`;
  const taxlot = keys.find((k) => k.startsWith("taxlot:"));
  if (taxlot) return `${agencyPrefix}${taxlot}`;
  const id = clean(notices[0]?.request_id);
  return id ? `notice:${id}` : null;
}

function gapForStage(stage) {
  return {
    slot: stage,
    class: "not_yet_ingested",
    taxonomy: true,
    source: CITY_RECORD_SOURCE,
  };
}

/**
 * Build one disposition spine from notices already known to share a subject.
 * Empty stages stay explicit (class-a not_yet_ingested) — never invent events.
 */
export function buildPropertyDispositionSpine(notices = [], options = {}) {
  const rows = (notices || []).filter((n) => n && clean(n.request_id));
  const joinKeys = options.join_keys
    || [...new Set(rows.flatMap((row) => dispositionJoinKeys(row.property_location || row, row)))].sort();
  const method = joinKeys.some((k) => k.startsWith("bbl:"))
    ? "exact_bbl"
    : joinKeys.some((k) => k.startsWith("taxlot:"))
      ? "exact_borough_block_lot"
      : rows.length
        ? "single_notice"
        : null;

  const events = [];
  const stageNotices = Object.fromEntries(DISPOSITION_STAGES.map((s) => [s, []]));
  for (const row of rows) {
    const stage = classifyDispositionStage(row);
    if (!stage || !DISPOSITION_STAGES.includes(stage)) continue;
    const event = noticeEvent(row, stage);
    if (!event) continue;
    events.push(event);
    stageNotices[stage].push(row);
  }
  events.sort((a, b) => a.time.value.localeCompare(b.time.value) || a.id.localeCompare(b.id));

  const stages = DISPOSITION_STAGES.map((kind) => {
    const matched = stageNotices[kind];
    const stageEvents = events.filter((e) => e.stage === kind);
    return {
      kind,
      matched: matched.length > 0,
      notice_count: matched.length,
      request_ids: matched.map((r) => clean(r.request_id)),
      events: stageEvents,
    };
  });

  const gaps = stages.filter((s) => !s.matched).map((s) => gapForStage(s.kind));
  const matchedCount = stages.filter((s) => s.matched).length;

  return {
    schema_version: PROPERTY_DISPOSITION_SPINE_SCHEMA_VERSION,
    subject_ref: subjectFromKeys(joinKeys, rows),
    join: {
      matched: rows.length > 0 && joinKeys.length > 0,
      method,
      keys: joinKeys,
      notice_count: rows.length,
      agency: clean(rows[0]?.agency_name) || null,
    },
    stages,
    events,
    gaps,
    stage_fill: stages.length ? matchedCount / stages.length : 0,
    matched_stages: matchedCount,
    total_stages: stages.length,
    full: matchedCount === stages.length,
  };
}

/**
 * Union-find grouping of Property Disposition notices into disposition spines.
 * Notices join only when they share a strict key AND the same agency.
 * Notices without join keys become singleton spines (honest single-notice chain).
 */
export function groupDispositionSpines(notices = []) {
  const rows = (notices || []).filter((n) => n && clean(n.request_id));
  if (!rows.length) return [];

  const parent = new Map();
  const find = (id) => {
    let p = parent.get(id) || id;
    while (p !== (parent.get(p) || p)) p = parent.get(p);
    parent.set(id, p);
    return p;
  };
  const unite = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const row of rows) parent.set(clean(row.request_id), clean(row.request_id));

  // key+agency → request_ids
  const byKeyAgency = new Map();
  for (const row of rows) {
    const id = clean(row.request_id);
    const agency = agencyKey(row.agency_name) || "_";
    const keys = dispositionJoinKeys(row.property_location || row, row);
    for (const key of keys) {
      const bucket = `${agency}::${key}`;
      const list = byKeyAgency.get(bucket) || [];
      list.push(id);
      byKeyAgency.set(bucket, list);
    }
  }
  for (const ids of byKeyAgency.values()) {
    for (let i = 1; i < ids.length; i++) unite(ids[0], ids[i]);
  }

  const groups = new Map();
  for (const row of rows) {
    const id = clean(row.request_id);
    const root = find(id);
    const list = groups.get(root) || [];
    list.push(row);
    groups.set(root, list);
  }

  const spines = [];
  for (const group of groups.values()) {
    group.sort((a, b) => {
      const da = isoDate(a.start_date) || "";
      const db = isoDate(b.start_date) || "";
      return da.localeCompare(db) || clean(a.request_id).localeCompare(clean(b.request_id));
    });
    spines.push(buildPropertyDispositionSpine(group));
  }
  spines.sort((a, b) => {
    const ea = a.events[0]?.time?.value || "";
    const eb = b.events[0]?.time?.value || "";
    return ea.localeCompare(eb) || String(a.subject_ref || "").localeCompare(String(b.subject_ref || ""));
  });
  return spines;
}

/**
 * Find the disposition spine containing a notice request_id.
 */
export function spineForNotice(spines, requestId) {
  const id = clean(requestId);
  if (!id) return null;
  return (spines || []).find((spine) =>
    (spine.events || []).some((e) => e.request_id === id)
    || (spine.stages || []).some((s) => (s.request_ids || []).includes(id))
  ) || null;
}

/**
 * Named product metric: property_disposition_spine_completeness_rate
 * Mean stage_fill over disposition spines with at least one join key or event.
 */
export function measurePropertyDispositionSpineCompleteness(spines = []) {
  const pool = (spines || []).filter((s) => s && (s.events?.length || s.join?.keys?.length));
  if (!pool.length) {
    return {
      metric: "property_disposition_spine_completeness_rate",
      property_disposition_spine_completeness_rate: 0,
      full_spine_rate: 0,
      spine_count: 0,
      multi_notice_spine_count: 0,
      stage_rates: Object.fromEntries(DISPOSITION_STAGES.map((s) => [s, 0])),
    };
  }
  const stageHits = Object.fromEntries(DISPOSITION_STAGES.map((s) => [s, 0]));
  let fillSum = 0;
  let full = 0;
  let multi = 0;
  for (const spine of pool) {
    fillSum += Number(spine.stage_fill) || 0;
    if (spine.full) full += 1;
    if ((spine.join?.notice_count || 0) > 1) multi += 1;
    for (const stage of spine.stages || []) {
      if (stage.matched) stageHits[stage.kind] = (stageHits[stage.kind] || 0) + 1;
    }
  }
  const n = pool.length;
  return {
    metric: "property_disposition_spine_completeness_rate",
    property_disposition_spine_completeness_rate: fillSum / n,
    full_spine_rate: full / n,
    spine_count: n,
    multi_notice_spine_count: multi,
    stage_rates: Object.fromEntries(
      DISPOSITION_STAGES.map((s) => [s, stageHits[s] / n]),
    ),
  };
}

/**
 * Attach disposition spines to a materialized property view (mutates a shallow copy).
 */
export function attachDispositionSpines(view) {
  const properties = Array.isArray(view?.properties) ? view.properties : [];
  const spines = groupDispositionSpines(properties);
  const byNotice = new Map();
  for (const spine of spines) {
    for (const event of spine.events || []) {
      byNotice.set(event.request_id, spine.subject_ref);
    }
    for (const stage of spine.stages || []) {
      for (const id of stage.request_ids || []) byNotice.set(id, spine.subject_ref);
    }
  }
  const stamped = properties.map((row) => {
    const id = clean(row.request_id);
    const subject = byNotice.get(id) || null;
    const stage = classifyDispositionStage(row);
    return {
      ...row,
      disposition_stage: stage,
      disposition_subject_ref: subject,
      disposition_join_keys: dispositionJoinKeys(row.property_location || row, row),
    };
  });
  return {
    ...view,
    properties: stamped,
    disposition_spines: spines,
    disposition_metrics: measurePropertyDispositionSpineCompleteness(spines),
  };
}
