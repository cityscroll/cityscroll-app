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

const FCRC_AGENCY_RE = /^franchise and concession review committee$/i;

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/** True when hay names the FCRC / franchise-concession review path (not bare "franchise"). */
function namesFcrcPath(hay) {
  return (
    /\bFCRC\b/i.test(hay)
    || /franchise and concession review committee/i.test(hay)
    || /franchise and concession review/i.test(hay)
  );
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
 * Excludes Council zoning-and-franchises land-use hearings, standing "Board Meetings"
 * calendars that merely list FCRC in a citywide roster, and bare MOCS LL63 plan
 * notices that never name a franchise/concession matter.
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

  // Standing multi-body calendars list FCRC among many boards — not an FCRC matter.
  if (
    /^board meetings$/i.test(agency)
    || /^board meetings$/i.test(title)
    || (/\bcity planning commission\b/i.test(hay)
      && /\bcity council\b/i.test(hay)
      && /\bfranchise and concession review committee\b/i.test(hay)
      && /\bcontract awards public hearing\b/i.test(hay))
  ) {
    return false;
  }

  // Bare MOCS LL63 annual contracting-plan notices are not FCRC franchise matters.
  // Keep MOCS only when the notice actually names FCRC / franchise-concession review.
  if (/mayor'?s office of contract services/i.test(agency) && !namesFcrcPath(hay)) {
    return false;
  }

  if (FCRC_AGENCY_RE.test(agency)) return true;
  if (namesFcrcPath(hay)) return true;
  if (
    /proposed (?:information services )?franchise agreement/i.test(hay)
    || /franchise agreement between the city of new york/i.test(hay)
  ) {
    return true;
  }
  // Significant concession solicitations / awards / intent-to-award that name the FCRC path.
  if (
    /\bconcession\b/i.test(hay)
    && /\b(request for proposals?|rfp|award|awarded|intent to award|license agreement)\b/i.test(hay)
    && namesFcrcPath(hay)
  ) {
    return true;
  }
  return false;
}

/**
 * Extract join keys for multi-notice chaining.
 * Prefer counterparty stem; annual plan year; FCRC rules subject; concession id.
 * Never invent a bare monthly calendar key that would falsely merge all items.
 */
export function franchiseConcessionJoinKeys(row) {
  if (!isFranchiseConcessionEligible(row)) return [];
  const keys = new Set();
  const title = titleText(row);
  const body = bodyText(row);
  const hay = `${title} ${body}`;

  // Annual Agency Concession Plan hearing/meeting (multiple phrasings).
  const plan =
    hay.match(/agency annual\.?\s*concession plans?\s+for\s+fiscal\s+year\s+(\d{4})/i)
    || hay.match(/annual concession plans?\s+for\s+fiscal\s+year\s+(\d{4})/i)
    || hay.match(/concession plans?\s+for\s+fiscal\s+year\s+(\d{4})/i)
    || hay.match(/\bfiscal year\s+(\d{4})\b.*\bconcession plan/i)
    || hay.match(/\bconcession plans?\b.*\bfiscal year\s+(\d{4})/i)
    || hay.match(/\bFY\s*(\d{4})\b.*\b(?:annual )?concession plan/i);
  if (plan) keys.add(`plan:fy${plan[1]}`);

  // FCRC rules amendment / adoption / proposed-changes package.
  if (
    /(?:amendment of fcrc rules|fcrc rules|fcrc concession rules|concession rules of the city of new york|proposed changes to the (?:fcrc )?concession rules)/i.test(
      hay,
    )
    && /(?:notice of adoption|proposed (?:amendments?|rules|changes)|public hearing on proposed rules|what are we proposing)/i.test(
      hay,
    )
  ) {
    keys.add("rules:fcrc");
  }

  // Publisher concession id when present (stable across holdover / cancel / re-notice).
  const concessionId = hay.match(
    /concession\s+id\s*(?:no\.?|number|#)?\s*[:\s]*([A-Z0-9][A-Z0-9\s\-.]{4,40})/i,
  );
  if (concessionId) {
    const id = clean(concessionId[1])
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase();
    if (id.length >= 6) keys.add(`concession:${id}`);
  }

  // Parks / EDC solicitation number on joint concession hearings (e.g. B385-SB-2025).
  const solicitation = hay.match(
    /\bsolicitation\s*(?:#|no\.?|number)?\s*([A-Z0-9][A-Z0-9\-]{4,24})\b/i,
  );
  if (solicitation && /concession|franchise|license agreement/i.test(hay)) {
    keys.add(`solicitation:${solicitation[1].toLowerCase()}`);
  }

  // Counterparty / franchisee from title or body patterns.
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
 * Prefer explicit award / between-City / intent-to-award party phrases that
 * already produce the known party keys (e.g. OneChronos, SHI International).
 *
 * Capture class allows Latin letters beyond ASCII (Café) but push() rejects
 * verb/date filler so "to be held on January 13" never becomes a party key.
 */
export function extractCounterparties(row) {
  const title = titleText(row);
  const body = bodyText(row);
  const hay = `${title} ${body}`;
  const found = [];
  // Firm-name token: letters (incl. Latin-1), digits, common name punctuation.
  // ENTITY allows short lowercase connectors (of / and / the) so
  // "United Federal Data of New York, LLC" matches, and optional comma before
  // the legal suffix ("York, LLC" / "Café, Inc.").
  const LEGAL = String.raw`(?:LLC|L\.L\.C\.|Inc\.?|Corp\.?|LP|L\.P\.|LLP|Company|Co\.|PC|P\.C\.)`;
  // Do NOT allow '.' inside name parts — otherwise "LLC." is swallowed as a name
  // part and "X LLC. Y LLC" becomes one false party.
  // (Avoid a bare TOKEN= assignment shape that trips placeholder-env scanners.)
  const namePart = String.raw`[A-Z\u00C0-\u024F][A-Za-z\u00C0-\u024F0-9'’&/-]*`;
  const CONNECTOR = String.raw`(?:of|and|the|for|d\/?b\/?a\.?)`;
  // Prefer legal suffix as the terminator (not a mid-name word).
  const ENTITY = String.raw`((?:${namePart}(?:\s+(?:${namePart}|${CONNECTOR})){0,8}),?\s+${LEGAL})`;

  const isBlockedParty = (name) =>
    /franchise and concession review committee|\bFCRC\b|city of new york|mayor'?s office of contract services|department of parks|new york city|nyc parks|police department|economic development|small business services|office of technology|city planning|board of|public hearing|joint public hearing|license agreement|concessionaire|^licensee$|^the city$/i.test(
      name,
    );

  const hasLegalCue = (name) =>
    /(?:LLC|L\.L\.C\.|Inc\.?|Corp\.?|LP|L\.P\.|LLP|Company|Co\.|PC|P\.C\.|PLC)\b/i.test(name);

  const looksLikeDateOrVerbPhrase = (name) =>
    /^(?:be held|held on|award|intent|enter|notice|proposed|relative|following)\b/i.test(name)
    || /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(
      name,
    )
    || /\b(?:to award|concession agreement to|intent to|be held|public hearing)\b/i.test(name)
    || /^\d{1,2}[\/\-]\d{1,2}/.test(name);

  const push = (raw) => {
    let name = clean(raw)
      .replace(/\s*\((?:Licensee|Concessionaire|the (?:Licensee|Concessionaire)|License|the City)\)\s*$/i, "")
      .replace(/\s+relative to.*$/i, "")
      .replace(/\s+for the (?:provision|renovation|development|operation|maintenance|non-?exclusive).*$/i, "")
      .replace(/\s+d\/?b\/?a\b.*$/i, "")
      .replace(/\s*\([^)]{0,40}\)\s*$/g, "")
      .replace(/[.,;:'"“”]+$/g, "")
      .replace(/^['"“”]+|['"“”]+$/g, "")
      .trim();
    // Drop leading articles / role words.
    name = name.replace(/^(?:the|a|an)\s+/i, "").trim();
    if (!name || name.length < 3) return;
    if (isBlockedParty(name)) return;
    if (looksLikeDateOrVerbPhrase(name)) return;

    // If a long phrase still contains a trailing legal entity, prefer that entity.
    if (!hasLegalCue(name) || /\b(?:award|agreement|concession|intent|hearing|notice|license)\b/i.test(name)) {
      const trail = name.match(new RegExp(`${ENTITY}\\s*$`, "i"));
      if (trail && trail[1] && trail[1].length < name.length) {
        name = clean(trail[1]);
      } else if (!hasLegalCue(name) && /\b(?:award|agreement|concession|intent|hearing|notice)\b/i.test(name)) {
        return;
      }
    }
    // Split accidental double-entity captures ("X LLC. Y LLC" → keep first firm).
    const doubleEntity = name.match(
      new RegExp(String.raw`^(${ENTITY.replace(/^\(|\)$/g, "")})\.\s+${ENTITY.replace(/^\(|\)$/g, "")}$`, "i"),
    );
    if (doubleEntity) name = clean(doubleEntity[1]);
    // Simpler split: two legal cues separated by ". "
    if ((name.match(new RegExp(LEGAL, "gi")) || []).length >= 2 && /\.\s+[A-Z]/.test(name)) {
      name = clean(name.split(/\.\s+(?=[A-Z])/)[0]);
    }

    // Require a legal-entity cue or multi-word proper name (avoid single filler words).
    const words = name.split(/\s+/).filter(Boolean);
    if (!hasLegalCue(name) && words.length < 2) return;
    // Reject all-lowercase filler phrases and pure location fragments.
    if (!/[A-Z\u00C0-\u024F]/.test(name) && !hasLegalCue(name)) return;
    if (/^(?:the city|new york|manhattan|brooklyn|queens|bronx|staten island)$/i.test(name)) {
      return;
    }
    // Prefer firm names: if no legal cue, require ≥2 Capitalized words (not verbs).
    if (!hasLegalCue(name)) {
      const caps = words.filter((t) => /^[A-Z\u00C0-\u024F]/.test(t));
      if (caps.length < 2) return;
      if (/\b(?:for|with|from|into|onto|and|the|of|at|on|to)\b/i.test(name) && words.length > 5) {
        return;
      }
    }
    if (!found.some((x) => x.toLowerCase() === name.toLowerCase())) found.push(name);

    // Also retain a parenthetical DBA short name when multi-token and proper.
    const dba = clean(raw).match(/\((?:d\/?b\/?a|d\.b\.a\.?)\s+([^)]{2,60})\)/i);
    if (dba) push(dba[1]);
  };

  // Prefer explicit body parties first (most reliable).
  // "between the City of New York and X" / with parentheticals: "(the City) and X".
  // Require legal-entity ending so prose after "and" never becomes a party key.
  const betweenPatterns = [
    new RegExp(
      String.raw`between the City of New York(?:\s*\([^)]*\))?\s+and\s+${ENTITY}\b`,
      "i",
    ),
    new RegExp(
      String.raw`franchise agreement between the City of New York and\s+${ENTITY}\b`,
      "i",
    ),
    new RegExp(
      String.raw`(?:franchise|concession) agreement[^.]*?\band\s+${ENTITY}\b`,
      "i",
    ),
  ];
  for (const re of betweenPatterns) {
    const m = hay.match(re);
    if (m) push(m[1]);
  }

  // "whereby X, LLC, holder of …" (franchise assignment / sale notices).
  const whereby = hay.match(new RegExp(String.raw`whereby\s+${ENTITY}\b`, "i"));
  if (whereby) push(whereby[1]);

  // "sold … to X, LLC" / "sold in its entirety to X".
  const soldTo = hay.match(
    new RegExp(String.raw`sold(?:\s+in\s+its\s+entirety)?\s+to\s+${ENTITY}\b`, "i"),
  );
  if (soldTo) push(soldTo[1]);

  // Intent-to-award / license / concession → party (joint FCRC + Parks/EDC path).
  // Require a legal-entity ending on the capture so "to Award a Concession…" is rejected.
  const awardToPatterns = [
    new RegExp(
      String.raw`intent to award[\s\S]{0,200}?\bto\s+${ENTITY}\s*(?:\((?:Licensee|Concessionaire)\))?(?:\s+for\s+the|\s+for\s+[a-z]|\.|,|$)`,
      "i",
    ),
    new RegExp(
      String.raw`(?:license agreement|sole source license agreement|concession agreement)\s*(?:\([^)]*\))?\s+to\s+${ENTITY}\s*(?:\((?:Licensee|Concessionaire)\))?(?:\s+for\s+the|\s+for\s+[a-z]|\.|,|$)`,
      "i",
    ),
    new RegExp(
      String.raw`\bto\s+${ENTITY}\s*(?:\((?:Licensee|Concessionaire)\))?(?:\s+for\s+the|\s+for\s+[a-z])`,
      "i",
    ),
    new RegExp(
      String.raw`negotiate a[^.]*?agreement with\s+${ENTITY}\s+for\b`,
      "i",
    ),
    new RegExp(
      String.raw`award(?:ed)?(?:\s+as a concession)?[^.]*?\bto\s+${ENTITY}\b`,
      "i",
    ),
  ];
  for (const re of awardToPatterns) {
    const m = hay.match(re);
    if (m) push(m[1]);
  }

  // Title: only "… to Name LLC for …" (legal cue required — never "to be held on …").
  const titleTo = title.match(
    new RegExp(String.raw`\bto\s+${ENTITY}(?:\s+for\s+the|\s+for\s+[a-z]|;|,|\s|$)`, "i"),
  );
  if (titleTo) push(titleTo[1]);

  // Title trailing " - Name LLC" (not "Franchise and Concession…").
  const dash = title.match(
    new RegExp(String.raw`[-–—]\s*${ENTITY}\s*$`, "i"),
  );
  if (dash) push(dash[1]);

  // Title trailing entity: "… Uniti National LLC" / "… OncChronos LLC".
  const trailingEntity = title.match(new RegExp(String.raw`${ENTITY}\s*$`, "i"));
  if (trailingEntity) push(trailingEntity[1]);

  // "relative to X LLC" when X is an entity (title-only hearings with empty body).
  const relativeTo = hay.match(new RegExp(String.raw`relative to\s+${ENTITY}\b`, "i"));
  if (relativeTo) push(relativeTo[1]);

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

  const isHearing =
    type === "Public Hearings"
    || /\bpublic hearing\b/i.test(hay)
    || /\bjoint public hearing\b/i.test(hay)
    || /\bFCRC\b.*\bhearing\b/i.test(hay)
    || /\bhearing\b.*\bFCRC\b/i.test(hay);
  const isMeeting =
    type === "Meeting"
    || /\bpublic meeting\b/i.test(hay)
    || /\bFCRC\b.*\b(?:public )?meeting\b/i.test(title)
    || /\bPUBLIC MEETING\b/i.test(title);

  // Award / adoption: real awards and notice-of-adoption.
  // "Intent to award" on a Public Hearings / joint-hearing notice is the hearing
  // stage (FCRC calendar item), not a completed award.
  const isCompletedAward =
    type === "Award"
    || /\bnotice of adoption\b/i.test(hay)
    || /\b(?:has been awarded|award of (?:the )?(?:franchise|concession)|franchise has been granted|concession has been awarded)\b/i.test(
      hay,
    );
  if (isCompletedAward && (type === "Award" || !isHearing)) {
    return STAGE_AWARD;
  }

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
  const concession = keys.find((k) => k.startsWith("concession:"));
  if (concession) return `franchise:${concession}`;
  const solicitation = keys.find((k) => k.startsWith("solicitation:"));
  if (solicitation) return `franchise:${solicitation}`;
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
    : joinKeys.some((k) => k.startsWith("concession:") || k.startsWith("solicitation:"))
      ? "exact_concession_id"
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
