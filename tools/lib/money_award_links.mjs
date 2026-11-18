// Link each City Record solicitation to the award notices published for it.
//
// A solicitation carries the bid PIN stem (10 characters, for example 85723B0004). An award
// carries a contract PIN: the same stem, a 3-digit contract sequence, and sometimes a renewal
// suffix (85723B0004001, 85723B0004001R001). Equality on the whole PIN therefore joins about
// 1% of solicitations; joining on the stem, with the same agency and an award dated on or after
// the solicitation, joins about 80% of the 2023 stem-shaped ones. This module does that join
// once for the whole population and says, for every solicitation, which of three things is true:
// an award is linked, none is published yet, or it cannot be linked and why.
// When several awards join, linked_award is the earliest one dated after the printed response
// due date, and the others are published beside it. A missing due date stays missing.
//
// The City Record carries a vendor name as printed and no vendor identifier. Nothing here
// normalizes, merges, or ranks vendors, and nothing says why a supplier lost.
//
// Pure functions plus one bounded fetch. No DOM, no markup, no contact fields.

import { resolveAgencyIdentity } from "../../site/agency_identity.mjs";
import { CITY_RECORD_DATASET, fetchJson, sodaUrl } from "./batch_precompute_snapshots.mjs";

export const MONEY_AWARD_LINKS_SCHEMA = "cityscroll.money_award_links.v1";
export const MONEY_AWARD_LINKS_RULE_VERSION = "pin-stem-agency-v1";
export const MONEY_AWARD_LINKS_SOURCE = "city_record_award_notices";
export const MONEY_AWARD_LINKS_WINDOW_START = "2023-01-01";
export const MONEY_AWARD_LINKS_MAX_ROWS = 8000;
export const MONEY_AWARD_LINKS_MAX_AWARD_ROWS = 40000;
export const MONEY_AWARD_LINKS_MAX_BYTES = 4 * 1024 * 1024;
export const MONEY_AWARD_LINKS_MAX_AWARDS_PER_NOTICE = 25;

export const MONEY_AWARD_LINKS_SOLICITATION_FIELDS = Object.freeze([
  "request_id",
  "start_date",
  "agency_name",
  "pin",
  "due_date",
]);
export const MONEY_AWARD_LINKS_OTHER_AWARDS_LABEL = "other awards on the same contract number";
export const MONEY_AWARD_LINKS_AWARD_FIELDS = Object.freeze([
  "request_id",
  "start_date",
  "agency_name",
  "pin",
  "contract_amount",
  "vendor_name",
]);

export const MONEY_AWARD_LINKS_JOIN_RULE = [
  "A solicitation PIN of five digits, one letter and four digits (the bid stem) is joined to the",
  "award notices whose contract PIN begins with that stem and ends in nothing, a 3-digit contract",
  "sequence, or a 3-digit sequence plus a renewal suffix (R and three digits). The award must name",
  "the same agency (by the engine's canonical agency id) and be published on or after the solicitation. A solicitation PIN of any other",
  "shape is joined only when an award carries exactly the same PIN, the same agency, and a later",
  "or equal date. Agencies with no award notices in the window, solicitations with no PIN, PINs of",
  "another shape, awards that all predate the solicitation, and awards on the stem under another",
  "agency or an unrecognised tail are published as cannot be linked, with the reason. A stem with",
  "no award notice yet is published as no award published yet. When several awards join, linked_award",
  "is the earliest whose notice date is after the solicitation's printed response due date, and the",
  "others are published as other awards on the same contract number. An award dated on the due date",
  "is not after it. Dates compare as calendar days. When the City Record printed no response due",
  "date, linked_award is the earliest joined award and the due date is left empty. A single joined",
  "award is linked_award. Nothing is guessed from titles or vendor names. Award dates are City Record",
  "notice dates; amounts are the amount printed in the award notice, not payments.",
].join(" ");

// One catalogue of the words and gap classes, so a consumer does not invent its own.
// gap_class follows docs/gap-taxonomy.md: "timing" (the source may still publish it),
// "a" (a public source publishes it and the join is missing), "b" (no public joinable release known).
export const MONEY_AWARD_LINKS_REASONS = Object.freeze({
  linked_pin_stem: {
    state: "linked",
    gap_class: null,
    text: "An award notice is published on this solicitation's PIN stem for the same agency.",
  },
  linked_pin_exact: {
    state: "linked",
    gap_class: null,
    text: "An award notice is published with exactly this solicitation's PIN for the same agency.",
  },
  no_award_published_yet: {
    state: "no_award_yet",
    gap_class: "timing",
    text: "No award notice is published yet for this PIN. Awards are published some months after the solicitation, so a recent notice may simply be early.",
  },
  award_before_notice: {
    state: "cannot_link",
    gap_class: "a",
    text: "The only award notices on this PIN stem were published before this solicitation, so none is linked.",
  },
  award_other_agency: {
    state: "cannot_link",
    gap_class: "a",
    text: "Award notices exist on this PIN stem under a different agency, so none is linked.",
  },
  award_pin_tail_unrecognised: {
    state: "cannot_link",
    gap_class: "a",
    text: "Award notices exist on this PIN stem with a contract number in a shape the join does not read, so none is linked.",
  },
  pin_shape_not_joinable: {
    state: "cannot_link",
    gap_class: "a",
    text: "This agency's PINs for this kind of notice are not in the bid-stem shape, so the award cannot be matched by PIN.",
  },
  no_pin: {
    state: "cannot_link",
    gap_class: "b",
    text: "This notice published no PIN, so no award can be matched to it.",
  },
  agency_awards_not_in_city_record: {
    state: "cannot_link",
    gap_class: "b",
    text: "This agency's awards are not published in the City Record, so none can be linked from it.",
  },
});

const STATE_OF_REASON = Object.freeze(
  Object.fromEntries(Object.entries(MONEY_AWARD_LINKS_REASONS).map(([key, value]) => [key, value.state])),
);
export const MONEY_AWARD_LINKS_STATES = Object.freeze(["linked", "no_award_yet", "cannot_link"]);

const STEM_SHAPE = /^[0-9]{5}[A-Z][0-9]{4}$/;
const STEM_PREFIX = /^([0-9]{5}[A-Z][0-9]{4})(.*)$/;
const RECOGNISED_TAIL = /^(?:[0-9]{3})?(?:R[0-9]{3})?$/;

export function normalizePin(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

/**
 * The agency a notice names, as the engine's canonical agency id ("" when none). Two spellings of one
 * agency (the City Record prints some agencies two ways) compare equal; a spelling the engine has not
 * reviewed keeps its own slug, so it still matches only itself.
 */
export function normalizeAgency(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  return raw ? resolveAgencyIdentity(raw).canonical_id || "" : "";
}

function day(value) {
  const text = typeof value === "string" ? value.slice(0, 10) : "";
  return /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(text) ? text : "";
}

function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

/** The bid stem of a solicitation PIN, or null when the PIN is not stem-shaped. */
export function solicitationStem(pin) {
  const p = normalizePin(pin);
  return STEM_SHAPE.test(p) ? p : null;
}

/** Stem and tail of an award contract PIN. recognised is false for tails the rule does not read. */
export function splitAwardPin(pin) {
  const p = normalizePin(pin);
  const m = STEM_PREFIX.exec(p);
  if (!m) return { stem: null, tail: null, recognised: false };
  return { stem: m[1], tail: m[2], recognised: RECOGNISED_TAIL.test(m[2]) };
}

export function pinShape(pin) {
  const p = normalizePin(pin);
  if (!p) return "none";
  return STEM_SHAPE.test(p) ? "stem" : "other";
}

function parseAmount(printed) {
  if (typeof printed !== "string" || !printed.trim()) return null;
  const n = Number(printed.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function validNotice(row) {
  return Boolean(
    row
    && typeof row === "object"
    && /^[0-9]{11}$/.test(String(row.request_id || ""))
    && day(row.start_date),
  );
}

function awardEntry(award) {
  return {
    request_id: String(award.request_id),
    award_date: day(award.start_date),
    contract_pin: normalizePin(award.pin),
    vendor_name: typeof award.vendor_name === "string" ? award.vendor_name.trim() || null : null,
    award_amount: parseAmount(award.contract_amount),
  };
}

function compareAwards(a, b) {
  return (
    a.award_date.localeCompare(b.award_date)
    || a.contract_pin.localeCompare(b.contract_pin)
    || a.request_id.localeCompare(b.request_id)
  );
}

/**
 * Among joined awards, the earliest one after the printed due date is the link.
 * The rest stay visible. A missing due date does not invent one: the earliest
 * joined award is the link. One joined award is the link even when it is not
 * after the due date.
 */
function partitionJoinedAwards(entries, dueDay, maxAwardsPerNotice) {
  if (!entries.length) {
    return { linked_award: null, other_awards: [], other_awards_omitted: 0 };
  }
  let primaryIndex = 0;
  if (entries.length > 1 && dueDay) {
    primaryIndex = entries.findIndex((entry) => entry.award_date > dueDay);
  }
  const linked = primaryIndex >= 0 ? entries[primaryIndex] : null;
  const others = entries.filter((_, index) => index !== primaryIndex);
  const room = maxAwardsPerNotice - (linked ? 1 : 0);
  const published = others.slice(0, Math.max(0, room));
  return {
    linked_award: linked,
    other_awards: published,
    other_awards_omitted: others.length - published.length,
  };
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function pct(n, d) {
  return d > 0 ? Math.round((1000 * n) / d) / 10 : null;
}

/**
 * Join every solicitation to its award notices.
 *
 * @param {object[]} solicitations City Record rows, type Solicitation
 * @param {object[]} awards City Record rows, type Award
 * @returns {{ rows: object[], rejected: number, awardRowsRejected: number, agencyAwardRows: Map<string, number> }}
 */
export function linkSolicitationsToAwards(solicitations, awards, { maxAwardsPerNotice = MONEY_AWARD_LINKS_MAX_AWARDS_PER_NOTICE } = {}) {
  const goodAwards = (Array.isArray(awards) ? awards : []).filter(validNotice);
  const byStem = new Map();
  const byExactPin = new Map();
  const agencyAwardRows = new Map();
  for (const award of goodAwards) {
    const agency = normalizeAgency(award.agency_name);
    agencyAwardRows.set(agency, (agencyAwardRows.get(agency) || 0) + 1);
    const pin = normalizePin(award.pin);
    if (!pin) continue;
    if (!byExactPin.has(pin)) byExactPin.set(pin, []);
    byExactPin.get(pin).push(award);
    const split = splitAwardPin(pin);
    if (split.stem) {
      if (!byStem.has(split.stem)) byStem.set(split.stem, []);
      byStem.get(split.stem).push({ award, recognised: split.recognised });
    }
  }

  const good = (Array.isArray(solicitations) ? solicitations : []).filter(validNotice);
  const stemCounts = new Map();
  for (const row of good) {
    const stem = solicitationStem(row.pin);
    if (stem) stemCounts.set(stem, (stemCounts.get(stem) || 0) + 1);
  }

  const rows = good.map((sol) => {
    const date = day(sol.start_date);
    const pin = normalizePin(sol.pin);
    const agency = normalizeAgency(sol.agency_name);
    const shape = pinShape(pin);
    const stem = shape === "stem" ? pin : null;
    let reason;
    let basis = null;
    let matched = [];

    if (!agencyAwardRows.get(agency)) {
      reason = "agency_awards_not_in_city_record";
    } else if (shape === "none") {
      reason = "no_pin";
    } else if (stem) {
      const onStem = byStem.get(stem) || [];
      const readable = onStem.filter((entry) => entry.recognised).map((entry) => entry.award);
      const later = readable.filter((award) => day(award.start_date) >= date);
      matched = later.filter((award) => normalizeAgency(award.agency_name) === agency);
      if (matched.length) {
        reason = "linked_pin_stem";
        basis = "pin_stem";
      } else if (later.length) {
        reason = "award_other_agency";
      } else if (readable.length) {
        reason = "award_before_notice";
      } else if (onStem.length) {
        reason = "award_pin_tail_unrecognised";
      } else {
        reason = "no_award_published_yet";
      }
    } else {
      matched = (byExactPin.get(pin) || []).filter(
        (award) => day(award.start_date) >= date && normalizeAgency(award.agency_name) === agency,
      );
      if (matched.length) {
        reason = "linked_pin_exact";
        basis = "pin_exact";
      } else {
        reason = "pin_shape_not_joinable";
      }
    }

    const entries = matched.map(awardEntry).sort(compareAwards);
    const published = entries.slice(0, maxAwardsPerNotice);
    const due = day(sol.due_date);
    const partition = partitionJoinedAwards(entries, due, maxAwardsPerNotice);
    const state = STATE_OF_REASON[reason];
    return {
      request_id: String(sol.request_id),
      pin: pin || null,
      agency_name: typeof sol.agency_name === "string" ? sol.agency_name.trim() : null,
      agency_id: agency || null,
      cohort_year: Number(date.slice(0, 4)),
      solicitation_date: date,
      response_due_date: due || null,
      pin_shape: shape,
      stem_solicitation_count: stem ? stemCounts.get(stem) : null,
      link_state: state,
      reason,
      link_basis: basis,
      award_count: entries.length,
      first_award_lag_days: entries.length ? daysBetween(date, entries[0].award_date) : null,
      awards: published,
      linked_award: partition.linked_award,
      other_awards: partition.other_awards,
      other_awards_label: partition.other_awards.length ? MONEY_AWARD_LINKS_OTHER_AWARDS_LABEL : null,
      other_awards_omitted: partition.other_awards_omitted,
    };
  });
  rows.sort((a, b) => a.solicitation_date.localeCompare(b.solicitation_date) || a.request_id.localeCompare(b.request_id));
  return {
    rows,
    rejected: (Array.isArray(solicitations) ? solicitations.length : 0) - good.length,
    awardRowsRejected: (Array.isArray(awards) ? awards.length : 0) - goodAwards.length,
    agencyAwardRows,
  };
}

function tally(rows, asOf, medianLag) {
  const out = {
    solicitations: rows.length,
    stem_shaped: 0,
    linked: 0,
    linked_pin_stem: 0,
    linked_pin_exact: 0,
    no_award_yet: 0,
    cannot_link: 0,
    multi_award: 0,
    by_reason: Object.fromEntries(Object.keys(MONEY_AWARD_LINKS_REASONS).map((key) => [key, 0])),
  };
  const lags = [];
  const matureCutoff = medianLag == null ? null : medianLag;
  let matureStem = 0;
  let matureLinked = 0;
  for (const row of rows) {
    out.by_reason[row.reason] += 1;
    if (row.pin_shape === "stem") out.stem_shaped += 1;
    if (row.link_state === "linked") {
      out.linked += 1;
      out[row.reason] += 1;
      if (row.award_count > 1) out.multi_award += 1;
      lags.push(row.first_award_lag_days);
    } else if (row.link_state === "no_award_yet") {
      out.no_award_yet += 1;
    } else {
      out.cannot_link += 1;
    }
    if (matureCutoff != null && row.pin_shape === "stem" && daysBetween(row.solicitation_date, asOf) >= matureCutoff) {
      matureStem += 1;
      if (row.link_state === "linked") matureLinked += 1;
    }
  }
  out.linked_pct_of_all = pct(out.linked, out.solicitations);
  out.linked_pct_of_stem_shaped = pct(out.linked_pin_stem, out.stem_shaped);
  out.median_lag_days = median(lags);
  out.at_least_median_lag_old = {
    min_age_days: matureCutoff,
    stem_shaped: matureStem,
    linked: matureLinked,
    linked_pct_of_stem_shaped: pct(matureLinked, matureStem),
  };
  return out;
}

/** Coverage by cohort year and by agency, measured on the published rows. */
export function measureAwardLinkCoverage(rows, { asOf }) {
  const allLags = rows.filter((row) => row.link_state === "linked").map((row) => row.first_award_lag_days);
  const medianLag = median(allLags);
  const byYear = new Map();
  const byAgency = new Map();
  for (const row of rows) {
    if (!byYear.has(row.cohort_year)) byYear.set(row.cohort_year, []);
    byYear.get(row.cohort_year).push(row);
    const key = row.agency_name || "(no agency)";
    if (!byAgency.has(key)) byAgency.set(key, []);
    byAgency.get(key).push(row);
  }
  return {
    totals: tally(rows, asOf, medianLag),
    median_lag_days: medianLag,
    by_cohort_year: Object.fromEntries(
      [...byYear.entries()].sort((a, b) => a[0] - b[0]).map(([year, list]) => [String(year), tally(list, asOf, medianLag)]),
    ),
    by_agency: [...byAgency.entries()]
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
      .map(([agency, list]) => ({ agency_name: agency, agency_id: list[0].agency_id, ...tally(list, asOf, medianLag) })),
  };
}

export function calendarDay(now) {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Build the published artifact from the two pulls.
 *
 * @param {{ solicitations: object[], awards: object[], solicitationCount: number, awardCount: number }} input
 */
export function buildMoneyAwardLinksSnapshot(
  { solicitations, awards, solicitationCount, awardCount } = {},
  {
    now = new Date(),
    maxRows = MONEY_AWARD_LINKS_MAX_ROWS,
    maxAwardRows = MONEY_AWARD_LINKS_MAX_AWARD_ROWS,
    maxBytes = MONEY_AWARD_LINKS_MAX_BYTES,
  } = {},
) {
  if (!Array.isArray(solicitations)) throw new Error("money award links: solicitations must be an array");
  if (!Array.isArray(awards)) throw new Error("money award links: awards must be an array");
  const asOf = calendarDay(now);
  const reasons = [];
  if (solicitations.length > maxRows) reasons.push("row_cap");
  if (awards.length > maxAwardRows) reasons.push("award_row_cap");
  const joined = linkSolicitationsToAwards(solicitations.slice(0, maxRows), awards.slice(0, maxAwardRows));
  if (!reasons.includes("row_cap") && solicitations.length !== solicitationCount) reasons.push("solicitation_count_mismatch");
  if (!reasons.includes("award_row_cap") && awards.length !== awardCount) reasons.push("award_count_mismatch");
  if (joined.rejected) reasons.push("invalid_solicitation_rows");
  if (joined.awardRowsRejected) reasons.push("invalid_award_rows");
  const coverage = measureAwardLinkCoverage(joined.rows, { asOf });
  const payload = {
    schema: MONEY_AWARD_LINKS_SCHEMA,
    schema_version: 1,
    delivery_tier: "inline-at-build",
    rule_version: MONEY_AWARD_LINKS_RULE_VERSION,
    generated_at: new Date(now).toISOString(),
    as_of: asOf,
    source: {
      name: "City Record Online",
      dataset: CITY_RECORD_DATASET,
      url: `https://data.cityofnewyork.us/d/${CITY_RECORD_DATASET}`,
      record_source: MONEY_AWARD_LINKS_SOURCE,
    },
    window: {
      solicitations_from: MONEY_AWARD_LINKS_WINDOW_START,
      awards_from: MONEY_AWARD_LINKS_WINDOW_START,
    },
    join_rule: MONEY_AWARD_LINKS_JOIN_RULE,
    reasons: MONEY_AWARD_LINKS_REASONS,
    bounds: {
      max_rows: maxRows,
      max_award_rows: maxAwardRows,
      max_bytes: maxBytes,
      max_awards_per_notice: MONEY_AWARD_LINKS_MAX_AWARDS_PER_NOTICE,
    },
    population: {
      state: reasons.length ? "incomplete" : "complete",
      reasons,
      solicitation_source_count: solicitationCount,
      solicitations_published: joined.rows.length,
      award_source_count: awardCount,
      award_rows_read: awards.length,
      award_publishing_agencies: [...joined.agencyAwardRows.values()].filter((n) => n > 0).length,
    },
    coverage,
    count: joined.rows.length,
    solicitations: joined.rows,
  };
  const bytes = Buffer.byteLength(`${JSON.stringify(payload, null, 2)}\n`);
  if (bytes > maxBytes) {
    throw new Error(`money award links: ${bytes} bytes exceeds the ${maxBytes}-byte bound; last good artifact retained`);
  }
  return payload;
}

function whereFor(type) {
  return `section_name='Procurement' AND type_of_notice_description='${type}' AND start_date>='${MONEY_AWARD_LINKS_WINDOW_START}T00:00:00'`;
}

export function moneyAwardLinksQuery(type, { limit }) {
  const fields = type === "Solicitation" ? MONEY_AWARD_LINKS_SOLICITATION_FIELDS : MONEY_AWARD_LINKS_AWARD_FIELDS;
  return {
    $select: fields.join(","),
    $where: whereFor(type),
    $order: "start_date ASC, request_id ASC",
    $limit: String(limit),
  };
}

export function moneyAwardLinksCountQuery(type) {
  return { $select: "count(*) AS n", $where: whereFor(type) };
}

async function countOf(fetchImpl, type, options) {
  const body = await fetchJson(fetchImpl, sodaUrl(CITY_RECORD_DATASET, moneyAwardLinksCountQuery(type)), options);
  const n = Number(Array.isArray(body) ? body[0]?.n : Number.NaN);
  if (!Number.isInteger(n) || n < 0) throw new Error(`money award links ${type} count SODA returned no whole-number count`);
  return n;
}

/**
 * Count, then one bounded page of each notice type, through the shared retrying fetch.
 * A failed request throws, so the caller keeps the last good artifact instead of writing
 * a short list. A pull that reads zero solicitations or zero awards throws for the same reason.
 */
export async function fetchMoneyAwardLinksInputs(
  fetchImpl = fetch,
  { maxRows = MONEY_AWARD_LINKS_MAX_ROWS, maxAwardRows = MONEY_AWARD_LINKS_MAX_AWARD_ROWS, ...options } = {},
) {
  const solicitationCount = await countOf(fetchImpl, "Solicitation", options);
  const awardCount = await countOf(fetchImpl, "Award", options);
  const solicitations = await fetchJson(
    fetchImpl,
    sodaUrl(CITY_RECORD_DATASET, moneyAwardLinksQuery("Solicitation", { limit: maxRows + 1 })),
    options,
  );
  const awards = await fetchJson(
    fetchImpl,
    sodaUrl(CITY_RECORD_DATASET, moneyAwardLinksQuery("Award", { limit: maxAwardRows + 1 })),
    options,
  );
  if (!Array.isArray(solicitations) || !Array.isArray(awards)) {
    throw new Error("money award links SODA returned a non-array");
  }
  if (!solicitations.length || !awards.length) {
    throw new Error("money award links SODA returned no rows; last good artifact retained");
  }
  return { solicitations, awards, solicitationCount, awardCount };
}
