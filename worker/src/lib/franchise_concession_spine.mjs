/**
 * Franchise / concession review process spine — multi-notice FCRC chain.
 *
 * Reconstructs a City Record Franchise and Concession Review Committee (FCRC)
 * lifecycle for one agreement or plan (solicitation → public hearing →
 * committee meeting → award) by joining notices that share a strict
 * counterparty stem, annual-plan year, or rules subject. Pure: no fetch, no env.
 *
 * Gap honesty (hard): empty stages use class-(a) `not_yet_ingested` naming
 * City Record Online. Never re-label empties as class-(b) "city does not publish"
 * — FCRC calendars, hearing notices, and awards are published; missing stages
 * mean incomplete join or notices outside the materialization window.
 *
 * Not the Council "Subcommittee on Zoning and Franchises" (land use) and not
 * generic Parks concession marketing pages without a City Record notice.
 */

import { vendorStem } from "../../../entity_resolution/normalizers/vendor_stem.mjs";

export const FRANCHISE_CONCESSION_SPINE_SCHEMA_VERSION = 1;

/** Ordered process stages for one franchise/concession review matter. */
export const FRANCHISE_CONCESSION_STAGES = Object.freeze([
  "solicitation",
  "public_hearing",
  "committee_meeting",
  "award",
]);

export const STAGE_SOLICITATION = "solicitation";
export const STAGE_PUBLIC_HEARING = "public_hearing";
export const STAGE_COMMITTEE_MEETING = "committee_meeting";
export const STAGE_AWARD = "award";

const CITY_RECORD_SOURCE = "City Record Online";
const CITY_RECORD_URL = "https://a856-cityrecord.nyc.gov/RequestDetail/";
const MOCS_FCRC_URL =
  "https://www.nyc.gov/site/mocs/opportunities/franchises-concessions.page";

const FCRC_AGENCY_RE =
  /^(?:franchise and concession review committee|mayor'?s office of contract services)$/i;

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

function bodyText(row) {
  return plainText(
    [
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
      row?.vendor_name,
    ]
      .filter(Boolean)
      .join(" "),
  );
}

function titleText(row) {
  return plainText(row?.short_title || "");
}

/**
 * True when a City Record row belongs on the franchise/concession review spine.
 * Excludes Council zoning-and-franchises land-use hearings.
 */
export function isFranchiseConcessionEligible(row) {
  if (!row || !clean(row.request_id)) return false;
  const agency = clean(row.agency_name);
  const title = titleText(row);
  const body = bodyText(row);
  const hay = `${title} ${body}`;

  // Wrong universe: City Council land-use subcommittee (not FCRC).
  if (
    /city council/i.test(agency)
    && /subcommittee on zoning and franchises|zoning and franchises/i.test(hay)
  ) {
    return false;
  }

  if (FCRC_AGENCY_RE.test(agency)) return true;
  if (/\bFCRC\b/i.test(hay)) return true;
  if (/franchise and concession review committee/i.test(hay)) return true;
  if (
    /proposed (?:information services )?franchise agreement/i.test(hay)
    || /franchise agreement between the city of new york/i.test(hay)
  ) {
    return true;
  }
  // Significant concession solicitations / awards that name the FCRC path.
  if (
    /\bconcession\b/i.test(hay)
    && /\b(request for proposals?|rfp|award|awarded|intent to award)\b/i.test(hay)
    && (/\bFCRC\b/i.test(hay) || /franchise and concession/i.test(hay))
  ) {
    return true;
  }
  return false;
}

/**
 * Extract join keys for multi-notice chaining.
 * Prefer counterparty stem; annual plan year; FCRC rules subject.
 * Never invent a bare monthly calendar key that would falsely merge all items.
 */
export function franchiseConcessionJoinKeys(row) {
  if (!isFranchiseConcessionEligible(row)) return [];
  const keys = new Set();
  const title = titleText(row);
  const body = bodyText(row);
  const hay = `${title} ${body}`;

  // Annual Agency Concession Plan hearing/meeting.
  const plan =
    hay.match(/agency annual concession plans?\s+for\s+fiscal\s+year\s+(\d{4})/i)
    || hay.match(/concession plans?\s+for\s+fiscal\s+year\s+(\d{4})/i)
    || hay.match(/\bfiscal year\s+(\d{4})\b.*\bconcession plan/i);
  if (plan) keys.add(`plan:fy${plan[1]}`);

  // FCRC rules amendment / adoption package.
  if (
    /amendment of fcrc rules|fcrc rules|concession rules of the city of new york/i.test(hay)
    && /(?:notice of adoption|proposed (?:amendments?|rules)|public hearing on proposed rules)/i.test(
      hay,
    )
  ) {
    keys.add("rules:fcrc");
  }

  // Counterparty / franchisee from title or "between the City … and X".
  const parties = extractCounterparties(row);
  for (const party of parties) {
    const stem = vendorStem(party);
    if (stem && stem.length >= 3) {
      keys.add(`party:${stem.toLowerCase().replace(/\s+/g, "-")}`);
    }
  }

  return [...keys].sort();
}

/**
 * Pull counterparty names from title and body without guessing bare surnames.
 * Never treats "Franchise and Concession Review Committee" as a party.
 */
export function extractCounterparties(row) {
  const title = titleText(row);
  const body = bodyText(row);
  const found = [];
  const isBlockedParty = (name) =>
    /franchise and concession review committee|\bFCRC\b|city of new york|mayor'?s office of contract services/i.test(
      name,
    );

  const push = (raw) => {
    let name = clean(raw)
      .replace(/\s+relative to.*$/i, "")
      .replace(/\s+for the provision.*$/i, "")
      .replace(/[.,;:]+$/g, "")
      .trim();
    if (!name || name.length < 3) return;
    if (isBlockedParty(name)) return;
    // Require a legal-entity cue or multi-token proper name (avoid single filler words).
    if (
      !/(?:LLC|L\.L\.C\.|Inc\.?|Corp\.?|LP|L\.P\.|Company|Co\.)\b/i.test(name)
      && name.split(/\s+/).length < 2
    ) {
      return;
    }
    if (!found.some((x) => x.toLowerCase() === name.toLowerCase())) found.push(name);
  };

  // Prefer explicit body parties first (most reliable).
  const between = body.match(
    /between the City of New York and\s+([A-Z][\w .,'&-]{2,100}?)(?:\.|,|\s+The\s|\s+for\s|\s+to\s)/i,
  );
  if (between) push(between[1]);

  const agreement = body.match(
    /(?:franchise|concession) agreement[^.]*?\band\s+([A-Z][\w .,'&-]{2,80}(?:LLC|L\.L\.C\.|Inc\.?|Corp\.?|LP|Company))/i,
  );
  if (agreement) push(agreement[1]);

  // Title trailing " - Name LLC" (not "Franchise and Concession…").
  const dash = title.match(
    /[-–—]\s*([A-Z][A-Za-z0-9 .,'&-]{1,80}(?:LLC|L\.L\.C\.|Inc\.?|Corp\.?|LP|Company))\s*$/i,
  );
  if (dash) push(dash[1]);

  // Award / franchise titles ending in an entity name.
  const trailingEntity = title.match(
    /\b((?:[A-Z][\w'.&-]+(?:\s+[A-Z][\w'.&-]+){0,6})\s+(?:LLC|L\.L\.C\.|Inc\.?|Corp\.?|LP|Company))\s*$/,
  );
  if (trailingEntity) push(trailingEntity[1]);

  const vendor = clean(row?.vendor_name);
  if (vendor) push(vendor);

  return found;
}

/**
 * Classify a franchise/concession notice into a process stage.
 * Returns null when the notice is eligible for the universe but not a process stage
 * (e.g. pure accessibility boilerplate without hearing/meeting/award language).
 */
export function classifyFranchiseConcessionStage(row) {
  if (!isFranchiseConcessionEligible(row)) return null;
  const type = clean(row?.type_of_notice_description);
  const title = titleText(row);
  const body = bodyText(row);
  const hay = `${title} ${body}`;

  // Award / adoption wins when both award and hearing language appear.
  if (
    type === "Award"
    || /\bnotice of adoption\b/i.test(hay)
    || /\b(?:has been awarded|award of (?:the )?(?:franchise|concession)|franchise has been granted|concession has been awarded|intent to award)\b/i.test(
      hay,
    )
  ) {
    return STAGE_AWARD;
  }

  // Solicitation / RFP before hearing language wins only when no hearing/meeting.
  const isHearing =
    type === "Public Hearings"
    || /\bpublic hearing\b/i.test(hay)
    || /\bFCRC\b.*\bhearing\b/i.test(hay)
    || /\bhearing\b.*\bFCRC\b/i.test(hay);
  const isMeeting =
    type === "Meeting"
    || /\bpublic meeting\b/i.test(hay)
    || /\bFCRC\b.*\b(?:public )?meeting\b/i.test(title)
    || /\bPUBLIC MEETING\b/i.test(title);

  if (
    !isHearing
    && !isMeeting
    && (type === "Solicitation"
      || /\b(?:request for proposals?|\brfps?\b|solicitation|invitation for bids?|request for expressions of interest|\brfei\b)\b/i.test(
        hay,
      ))
  ) {
    return STAGE_SOLICITATION;
  }

  // Public hearing before meeting when both appear (common in combined notices).
  if (isHearing && !/\bpublic meeting\b/i.test(title) && type !== "Meeting") {
    return STAGE_PUBLIC_HEARING;
  }
  if (isMeeting) return STAGE_COMMITTEE_MEETING;
  if (isHearing) return STAGE_PUBLIC_HEARING;

  return null;
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
  if (stage === STAGE_PUBLIC_HEARING || stage === STAGE_COMMITTEE_MEETING) {
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
  const title = clean(row?.short_title) || `Franchise/concession ${stage}`;
  const cancelled = /\bcancel+ed?\b|\bcancellation\b/i.test(`${titleText(row)} ${bodyText(row)}`);
  return {
    id: `city-record:${requestId}:${stage}`,
    kind: `franchise_${stage}`,
    stage,
    title,
    detail: clean(row?.agency_name) || null,
    status: cancelled ? "cancelled" : "published",
    request_id: requestId,
    type_of_notice: clean(row?.type_of_notice_description) || null,
    counterparties: extractCounterparties(row),
    time,
    source: noticeSource(row),
  };
}

function subjectFromKeys(keys, notices) {
  const party = keys.find((k) => k.startsWith("party:"));
  if (party) return `franchise:${party}`;
  const plan = keys.find((k) => k.startsWith("plan:"));
  if (plan) return `franchise:${plan}`;
  const rules = keys.find((k) => k.startsWith("rules:"));
  if (rules) return `franchise:${rules}`;
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
 * Build one franchise/concession spine from notices already known to share a subject.
 * Empty stages stay explicit (class-a not_yet_ingested) — never invent events.
 */
export function buildFranchiseConcessionSpine(notices = [], options = {}) {
  const rows = (notices || []).filter((n) => n && clean(n.request_id) && isFranchiseConcessionEligible(n));
  const joinKeys =
    options.join_keys
    || [...new Set(rows.flatMap((row) => franchiseConcessionJoinKeys(row)))].sort();

  const method = joinKeys.some((k) => k.startsWith("party:"))
    ? "exact_party"
    : joinKeys.some((k) => k.startsWith("plan:"))
      ? "exact_plan_year"
      : joinKeys.some((k) => k.startsWith("rules:"))
        ? "exact_rules_subject"
        : rows.length
          ? "single_notice"
          : null;

  const events = [];
  const stageNotices = Object.fromEntries(FRANCHISE_CONCESSION_STAGES.map((s) => [s, []]));
  for (const row of rows) {
    const stage = classifyFranchiseConcessionStage(row);
    if (!stage || !FRANCHISE_CONCESSION_STAGES.includes(stage)) continue;
    const event = noticeEvent(row, stage);
    if (!event) continue;
    events.push(event);
    stageNotices[stage].push(row);
  }
  events.sort(
    (a, b) => a.time.value.localeCompare(b.time.value) || a.id.localeCompare(b.id),
  );

  const stages = FRANCHISE_CONCESSION_STAGES.map((kind) => {
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
  // Never surface a false class-(b) for empty FCRC stages.
  for (const g of gaps) {
    if (g.class === "not_published") g.class = "not_yet_ingested";
  }

  const matchedCount = stages.filter((s) => s.matched).length;

  return {
    schema_version: FRANCHISE_CONCESSION_SPINE_SCHEMA_VERSION,
    subject_ref: subjectFromKeys(joinKeys, rows),
    join: {
      matched: rows.length > 0,
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
    provenance: {
      source: CITY_RECORD_SOURCE,
      mocs_url: MOCS_FCRC_URL,
    },
  };
}

/**
 * Union-find grouping of eligible notices into franchise/concession spines.
 * Notices join only when they share a strict join key.
 * Notices without join keys become singleton spines (honest single-notice chain).
 */
export function groupFranchiseConcessionSpines(notices = []) {
  const rows = (notices || []).filter(
    (n) => n && clean(n.request_id) && isFranchiseConcessionEligible(n),
  );
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

  const byKey = new Map();
  for (const row of rows) {
    const id = clean(row.request_id);
    const keys = franchiseConcessionJoinKeys(row);
    for (const key of keys) {
      const list = byKey.get(key) || [];
      list.push(id);
      byKey.set(key, list);
    }
  }
  for (const ids of byKey.values()) {
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
    spines.push(buildFranchiseConcessionSpine(group));
  }
  spines.sort((a, b) => {
    const ea = a.events[0]?.time?.value || "";
    const eb = b.events[0]?.time?.value || "";
    return (
      ea.localeCompare(eb)
      || String(a.subject_ref || "").localeCompare(String(b.subject_ref || ""))
    );
  });
  return spines;
}

/**
 * Find the franchise/concession spine containing a notice request_id.
 */
export function spineForNotice(spines, requestId) {
  const id = clean(requestId);
  if (!id) return null;
  return (
    (spines || []).find(
      (spine) =>
        (spine.events || []).some((e) => e.request_id === id)
        || (spine.stages || []).some((s) => (s.request_ids || []).includes(id)),
    ) || null
  );
}

/**
 * Named product metric: franchise_concession_spine_completeness_rate
 * Mean stage_fill over spines with at least one event or join key.
 */
export function measureFranchiseConcessionSpineCompleteness(spines = []) {
  const pool = (spines || []).filter(
    (s) => s && (s.events?.length || s.join?.keys?.length || s.join?.notice_count),
  );
  if (!pool.length) {
    return {
      metric: "franchise_concession_spine_completeness_rate",
      franchise_concession_spine_completeness_rate: 0,
      full_spine_rate: 0,
      spine_count: 0,
      multi_notice_spine_count: 0,
      stage_rates: Object.fromEntries(FRANCHISE_CONCESSION_STAGES.map((s) => [s, 0])),
    };
  }
  const stageHits = Object.fromEntries(FRANCHISE_CONCESSION_STAGES.map((s) => [s, 0]));
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
    metric: "franchise_concession_spine_completeness_rate",
    franchise_concession_spine_completeness_rate: fillSum / n,
    full_spine_rate: full / n,
    spine_count: n,
    multi_notice_spine_count: multi,
    stage_rates: Object.fromEntries(
      FRANCHISE_CONCESSION_STAGES.map((s) => [s, stageHits[s] / n]),
    ),
  };
}

/**
 * Attach franchise/concession spines to a materialized view (mutates a shallow copy).
 */
export function attachFranchiseConcessionSpines(view) {
  const notices = Array.isArray(view?.notices)
    ? view.notices
    : Array.isArray(view?.properties)
      ? view.properties
      : [];
  const spines = groupFranchiseConcessionSpines(notices);
  const byNotice = new Map();
  for (const spine of spines) {
    for (const event of spine.events || []) {
      byNotice.set(event.request_id, spine.subject_ref);
    }
    for (const stage of spine.stages || []) {
      for (const id of stage.request_ids || []) byNotice.set(id, spine.subject_ref);
    }
  }
  const stamped = notices.map((row) => {
    const id = clean(row.request_id);
    const subject = byNotice.get(id) || null;
    const stage = classifyFranchiseConcessionStage(row);
    return {
      ...row,
      franchise_stage: stage,
      franchise_subject_ref: subject,
      franchise_join_keys: franchiseConcessionJoinKeys(row),
    };
  });
  const baseKey = Array.isArray(view?.notices)
    ? "notices"
    : Array.isArray(view?.properties)
      ? "properties"
      : "notices";
  return {
    ...view,
    [baseKey]: stamped,
    franchise_spines: spines,
    franchise_metrics: measureFranchiseConcessionSpineCompleteness(spines),
  };
}
