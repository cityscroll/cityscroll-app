/**
 * Non-Council hearing outcomes process spine.
 *
 * Reconstructs notice → hearing → outcome → minutes for one non-Council hearing
 * body (borough president, community board, agency board, etc.) from a City
 * Record hearing notice. Pure: no fetch, no env.
 *
 * Gap honesty (hard):
 * - notice_published / hearing fill from City Record columns when present.
 * - outcome and minutes stay class-(b) `not_published` — there is no citywide
 *   machine-readable vote/minutes feed for non-Council bodies (gap taxonomy
 *   meeting-community-board-votes). Never invent votes.
 * - "Where" landings are real HTTPS URLs (BP when agency-mapped + CB directory),
 *   never a text-only "look somewhere" claim.
 *
 * Not the Council Legistar path (agenda→matter→action→vote→attachment) and not
 * a fake multi-source join against HTML minutes pages.
 */

export const NON_COUNCIL_HEARING_SPINE_SCHEMA_VERSION = 1;

/** Ordered process stages for one non-Council hearing. */
export const NON_COUNCIL_HEARING_STAGES = Object.freeze([
  "notice_published",
  "hearing",
  "outcome",
  "minutes",
]);

export const STAGE_NOTICE_PUBLISHED = "notice_published";
export const STAGE_HEARING = "hearing";
export const STAGE_OUTCOME = "outcome";
export const STAGE_MINUTES = "minutes";

const CITY_RECORD_SOURCE = "City Record Online";
const CITY_RECORD_URL = "https://a856-cityrecord.nyc.gov/RequestDetail/";
const CB_URL = "https://www.nyc.gov/site/cau/community-boards/community-boards.page";

const BP_LINKS = Object.freeze([
  { re: /\bmanhattan\b/i, url: "https://www.manhattanbp.nyc.gov/", label: "Manhattan Borough President" },
  { re: /\bbrooklyn\b/i, url: "https://www.brooklynbp.nyc.gov/", label: "Brooklyn Borough President" },
  { re: /\bbronx\b/i, url: "https://bronxboropres.nyc.gov/", label: "Bronx Borough President" },
  { re: /\bqueens\b/i, url: "https://queensbp.nyc.gov/", label: "Queens Borough President" },
  { re: /\bstaten island\b|\brichmond\b/i, url: "https://www.statenislandusa.com/", label: "Staten Island Borough President" },
]);

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

function dayTime(value, { basis = "publication_date", certainty = "actual" } = {}) {
  const day = isoDate(value);
  if (!day) return null;
  return {
    value: day,
    precision: "day",
    basis,
    certainty,
  };
}

/**
 * True when a notice is a non-Council hearing/meeting body (not City Council).
 * Council notices use the Legistar meeting-outcomes path instead.
 */
export function isNonCouncilHearingEligible(row) {
  if (!row || !clean(row.request_id)) return false;
  const agency = clean(row.agency_name);
  if (/\bcity council\b/i.test(agency)) return false;
  const section = clean(row.section_name);
  const type = clean(row.type_of_notice_description);
  if (section === "Public Hearings and Meetings") return true;
  if (section === "Agency Rules" && type === "Public Hearings") return true;
  // Hearing-shaped types outside the main section (e.g. some board calendars).
  if (
    /public hearings?/i.test(type)
    || /\bmeeting\b/i.test(type)
  ) {
    return true;
  }
  return false;
}

/**
 * Map agency text to ≥1 outbound HTTPS landing for minutes/votes "where".
 * Prefer an agency-mapped borough president site; always include the CB directory.
 */
export function nonCouncilBodyLinks(notice) {
  const agency = clean(notice?.agency_name);
  const links = [];
  for (const row of BP_LINKS) {
    if (row.re.test(agency)) {
      links.push({ url: row.url, label: row.label });
      break;
    }
  }
  links.push({ url: CB_URL, label: "NYC community boards" });
  // When no borough BP mapped, include one verified BP home so "borough president
  // websites" is not a text-only claim with zero outbound.
  if (links.length === 1) {
    links.unshift({
      url: "https://bronxboropres.nyc.gov/",
      label: "Borough president websites",
    });
  }
  return links;
}

function noticeSource(row) {
  const id = clean(row?.request_id);
  return {
    id: "city-record",
    label: CITY_RECORD_SOURCE,
    url: id ? `${CITY_RECORD_URL}${id}` : "https://a856-cityrecord.nyc.gov/",
  };
}

function classBGap(slot, whereLinks) {
  return {
    slot,
    class: "not_published",
    taxonomy: true,
    source: "borough president websites and community board minutes pages",
    where_links: whereLinks,
  };
}

/**
 * Build one notice → hearing → outcome → minutes spine from a City Record row.
 * Outcome and minutes never invent events; they stay class-(b) with real landings.
 *
 * @param {object} notice - City Record notice row
 */
export function buildNonCouncilHearingSpine(notice = {}) {
  const requestId = clean(notice?.request_id) || null;
  const title = plainText(notice?.short_title) || null;
  const agency = clean(notice?.agency_name) || null;
  const pubTime = dayTime(notice?.start_date, {
    basis: "publication_date",
    certainty: "actual",
  });
  const hearingTime = dayTime(notice?.event_date, {
    basis: "event_date",
    certainty: "planned",
  });
  const whereLinks = nonCouncilBodyLinks(notice);
  const source = noticeSource(notice);
  const events = [];

  const stagePayload = Object.fromEntries(
    NON_COUNCIL_HEARING_STAGES.map((kind) => [kind, { matched: false, events: [], detail: null }]),
  );

  // --- notice published (City Record start_date) ---
  if (pubTime) {
    const event = {
      id: `notice:${requestId || "unknown"}:notice_published`,
      kind: "non_council_notice_published",
      stage: STAGE_NOTICE_PUBLISHED,
      title: title || "Hearing notice published",
      detail: "City Record publication",
      status: "published",
      request_id: requestId,
      agency,
      time: pubTime,
      source,
    };
    events.push(event);
    stagePayload[STAGE_NOTICE_PUBLISHED] = {
      matched: true,
      events: [event],
      detail: { request_id: requestId, published_on: pubTime.value },
    };
  }

  // --- hearing (event_date when present) ---
  if (hearingTime) {
    const event = {
      id: `notice:${requestId || "unknown"}:hearing`,
      kind: "non_council_hearing",
      stage: STAGE_HEARING,
      title: title || "Public hearing",
      detail: agency ? `Hearing body: ${agency}` : "Scheduled hearing",
      status: "scheduled",
      request_id: requestId,
      agency,
      time: hearingTime,
      source,
    };
    events.push(event);
    stagePayload[STAGE_HEARING] = {
      matched: true,
      events: [event],
      detail: { request_id: requestId, event_date: hearingTime.value },
    };
  }

  // --- outcome + minutes: structural class-(b); never invent votes or minutes ---
  stagePayload[STAGE_OUTCOME] = {
    matched: false,
    events: [],
    detail: { where_links: whereLinks },
  };
  stagePayload[STAGE_MINUTES] = {
    matched: false,
    events: [],
    detail: { where_links: whereLinks },
  };

  const stages = NON_COUNCIL_HEARING_STAGES.map((kind) => {
    const payload = stagePayload[kind];
    return {
      kind,
      matched: Boolean(payload.matched),
      notice_count: payload.matched ? 1 : 0,
      request_ids: payload.matched && requestId ? [requestId] : [],
      events: payload.events,
      detail: payload.detail,
      gap_class:
        kind === STAGE_OUTCOME || kind === STAGE_MINUTES
          ? "not_published"
          : payload.matched
            ? null
            : "not_yet_ingested",
    };
  });

  const gaps = [];
  for (const stage of stages) {
    if (stage.matched) continue;
    if (stage.kind === STAGE_OUTCOME || stage.kind === STAGE_MINUTES) {
      gaps.push(classBGap(stage.kind, whereLinks));
    } else {
      gaps.push({
        slot: stage.kind,
        class: "not_yet_ingested",
        taxonomy: true,
        source: CITY_RECORD_SOURCE,
      });
    }
  }

  const matchedCount = stages.filter((s) => s.matched).length;
  // Fillable stages are those City Record can supply (notice + hearing).
  // Outcome/minutes are structural not_published — excluded from fillable_rate.
  const fillable = stages.filter(
    (s) => s.kind === STAGE_NOTICE_PUBLISHED || s.kind === STAGE_HEARING,
  );
  const fillableMatched = fillable.filter((s) => s.matched).length;
  const fillableRate = fillable.length ? fillableMatched / fillable.length : 0;

  const subjectParts = [];
  if (agency) {
    subjectParts.push(
      agency
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48),
    );
  }
  if (requestId) subjectParts.push(requestId);
  const subject_ref = subjectParts.length
    ? `hearing:non_council:${subjectParts.join(":")}`
    : "hearing:non_council:unknown";

  return {
    schema_version: NON_COUNCIL_HEARING_SPINE_SCHEMA_VERSION,
    subject_ref,
    request_id: requestId,
    title,
    agency,
    join: {
      matched: Boolean(requestId),
      method: "single_notice",
      keys: requestId ? [`notice:${requestId}`] : [],
      notice_count: requestId ? 1 : 0,
      council: false,
    },
    stages,
    events,
    gaps,
    where_links: whereLinks,
    stage_fill: stages.length ? matchedCount / stages.length : 0,
    fillable_rate: fillableRate,
    matched_stages: matchedCount,
    total_stages: stages.length,
    // full is never true until the city publishes joinable outcome/minutes feeds
    full: false,
    provenance: {
      source: CITY_RECORD_SOURCE,
      outcome_class: "not_published",
    },
  };
}

/**
 * Build spines for every eligible non-Council hearing notice.
 */
export function buildNonCouncilHearingSpines(notices = []) {
  return (notices || [])
    .filter((n) => isNonCouncilHearingEligible(n))
    .map((n) => buildNonCouncilHearingSpine(n))
    .sort((a, b) => {
      const da = a.events[0]?.time?.value || "";
      const db = b.events[0]?.time?.value || "";
      return (
        da.localeCompare(db)
        || String(a.request_id || "").localeCompare(String(b.request_id || ""))
      );
    });
}

/**
 * Find the spine for a notice request_id.
 */
export function spineForNotice(spines, requestId) {
  const id = clean(requestId);
  if (!id) return null;
  return (spines || []).find((spine) => clean(spine.request_id) === id) || null;
}

/**
 * Named product metric: non_council_hearing_spine_completeness_rate
 *
 * Mean **fillable_rate** (notice_published + hearing only) over eligible spines.
 * Outcome/minutes are structural class-(b) and never count as incomplete ingest.
 */
export function measureNonCouncilHearingSpineCompleteness(spines = []) {
  const pool = (spines || []).filter((s) => s && s.join?.matched);
  if (!pool.length) {
    return {
      metric: "non_council_hearing_spine_completeness_rate",
      non_council_hearing_spine_completeness_rate: 0,
      fillable_rate: 0,
      full_spine_rate: 0,
      spine_count: 0,
      structural_not_published_rate: 0,
      stage_rates: Object.fromEntries(NON_COUNCIL_HEARING_STAGES.map((s) => [s, 0])),
    };
  }
  const stageHits = Object.fromEntries(NON_COUNCIL_HEARING_STAGES.map((s) => [s, 0]));
  let fillableSum = 0;
  let structuralB = 0;
  for (const spine of pool) {
    fillableSum += Number(spine.fillable_rate) || 0;
    const bGaps = (spine.gaps || []).filter((g) => g.class === "not_published");
    if (bGaps.length >= 2) structuralB += 1;
    for (const stage of spine.stages || []) {
      if (stage.matched) stageHits[stage.kind] = (stageHits[stage.kind] || 0) + 1;
    }
  }
  const n = pool.length;
  return {
    metric: "non_council_hearing_spine_completeness_rate",
    non_council_hearing_spine_completeness_rate: fillableSum / n,
    fillable_rate: fillableSum / n,
    full_spine_rate: 0, // outcome+minutes never matched under current sources
    spine_count: n,
    structural_not_published_rate: structuralB / n,
    stage_rates: Object.fromEntries(
      NON_COUNCIL_HEARING_STAGES.map((s) => [s, stageHits[s] / n]),
    ),
  };
}
