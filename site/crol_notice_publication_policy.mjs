/**
 * City Record notice publication eligibility reused for CROL-negative
 * PASSPort / Checkbook procurement rows.
 *
 * Live CROL Award objects are admitted by the same two predicates the Money
 * lens already uses: a valid contract amount below the honesty cap, and a
 * start/registration day inside the rolling 365-day window. There is no
 * separate numeric row cap.
 *
 * Anchors:
 *   - amount: worker/src/ingest.mjs AMOUNT_CAP / site MONEY_HONESTY_CAP
 *     (`0 < amount < $10B`)
 *   - recency: tools/lib/batch_precompute_snapshots.mjs yearAgoISO and
 *     site/app yearCut (`start_date` within 365 days)
 */

export const CROL_AWARD_PUBLICATION_POLICY = "crol_notice_award_publication_v1";
export const CROL_NOTICE_VALID_AMOUNT_MAX = 10_000_000_000;
export const CROL_AWARD_PUBLICATION_LOOKBACK_DAYS = 365;

const DAY_MS = 86_400_000;

function text(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function parsePublisherDay(value) {
  const raw = text(value);
  if (!raw) return null;
  const iso = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const us = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) {
    return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

export function crolAwardPublicationAsOf(now = new Date()) {
  if (now instanceof Date) {
    if (Number.isNaN(now.getTime())) return null;
    return now.toISOString().slice(0, 10);
  }
  return parsePublisherDay(now);
}

export function crolAwardPublicationFloor(now = new Date()) {
  const instant = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(instant.getTime())) return null;
  return new Date(instant.getTime() - CROL_AWARD_PUBLICATION_LOOKBACK_DAYS * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

export function crolNoticeAmountIsValid(value) {
  if (value == null || value === "") return false;
  const amount = Number(String(value).replace(/[$,]/g, "").trim());
  return Number.isFinite(amount) && amount > 0 && amount < CROL_NOTICE_VALID_AMOUNT_MAX;
}

export function publisherAmount(row = {}) {
  for (const field of [
    "contract_amount",
    "current_amount",
    "award_amount",
    "current",
    "original",
    "amount",
  ]) {
    if (crolNoticeAmountIsValid(row?.[field])) return Number(String(row[field]).replace(/[$,]/g, "").trim());
  }
  return null;
}

export function publisherAwardDay(row = {}) {
  for (const field of [
    "start_date",
    "registration_date",
    "registered",
    "start",
    "received",
  ]) {
    const day = parsePublisherDay(row?.[field]);
    if (day) return day;
  }
  return null;
}

export function isCrolAwardPublicationDay(day, { now = new Date() } = {}) {
  const asOf = crolAwardPublicationAsOf(now);
  const floor = crolAwardPublicationFloor(now);
  return Boolean(day && asOf && floor && day >= floor && day <= asOf);
}

/**
 * True when a City Record Award notice, or a CROL-negative contract row
 * standing in for one, would be admitted to the live served set.
 */
export function matchesCrolAwardPublication(row = {}, { now = new Date() } = {}) {
  const amount = publisherAmount(row);
  const day = publisherAwardDay(row);
  return amount != null && isCrolAwardPublicationDay(day, { now });
}

export function describeCrolAwardPublication({ now = new Date(), selected = null, census = null } = {}) {
  const asOf = crolAwardPublicationAsOf(now);
  return {
    policy: CROL_AWARD_PUBLICATION_POLICY,
    lookback_days: CROL_AWARD_PUBLICATION_LOOKBACK_DAYS,
    amount_min_exclusive: 0,
    amount_max_exclusive: CROL_NOTICE_VALID_AMOUNT_MAX,
    as_of: asOf,
    floor: crolAwardPublicationFloor(now),
    row_cap: null,
    coverage: "City Record Award window (valid amount, last 365 days); not a citywide inventory",
    selected_rows: selected,
    census_rows: census,
  };
}
