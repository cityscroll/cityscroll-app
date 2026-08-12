import { reconcileAgencyIdentity } from "./agency_identity.mjs";
import { entityHref, entityRouteRef } from "./entity_pivot.mjs";

export const AGENCY_VENDOR_ROLLUP_SCHEMA = "cityscroll.agency_vendor_rollup.v1";
export const AGENCY_VENDOR_ROLLUP_METHOD = "agency_vendor_awards_12mo_v1";
export const MONEY_HONESTY_CAP = 10_000_000_000;

const DAY_MS = 86_400_000;

function day(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toISOString().slice(0, 10);
}

function amount(value) {
  if (value == null || value === "") return null;
  const parsed = Number(String(value).replace(/[$,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function defaultAsOf(rows) {
  const latest = (Array.isArray(rows) ? rows : [])
    .map((row) => day(row?.start_date))
    .filter(Boolean)
    .sort()
    .at(-1);
  return latest || new Date().toISOString().slice(0, 10);
}

function subtractDays(asOf, days) {
  const parsed = new Date(`${asOf}T00:00:00Z`);
  return new Date(parsed.getTime() - days * DAY_MS).toISOString().slice(0, 10);
}

/** Build the bounded, static agency → vendor award rollup used by constellation pages. */
export function buildAgencyVendorRollups(rows = [], options = {}) {
  const windowDays = Number.isInteger(options.windowDays) && options.windowDays > 0
    ? options.windowDays
    : 365;
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 8;
  const asOf = day(options.asOf) || defaultAsOf(rows);
  const windowStart = subtractDays(asOf, windowDays);
  const publisherRows = Array.isArray(options.publisherRows) ? options.publisherRows : [];
  const byAgency = new Map();

  for (const row of Array.isArray(rows) ? rows : []) {
    if (String(row?.type_of_notice_description || "").trim() !== "Award") continue;
    const startDate = day(row?.start_date);
    if (!startDate || startDate <= windowStart || startDate > asOf) continue;
    const total = amount(row?.contract_amount);
    if (total == null || total <= 0 || total >= MONEY_HONESTY_CAP) continue;
    const vendorName = String(row?.vendor_name || "").replace(/\s+/g, " ").trim();
    if (!vendorName) continue;

    const identity = reconcileAgencyIdentity(row?.agency_name, publisherRows);
    if (!identity?.matched || !identity.canonical_id) continue;
    const subjectRef = entityRouteRef("vendor", vendorName);
    if (!subjectRef) continue;

    if (!byAgency.has(identity.canonical_id)) byAgency.set(identity.canonical_id, new Map());
    const byVendor = byAgency.get(identity.canonical_id);
    const current = byVendor.get(subjectRef) || {
      subject_ref: subjectRef,
      label: vendorName,
      award_count: 0,
      award_total: 0,
      _labelAmount: 0,
    };
    current.award_count += 1;
    current.award_total += total;
    if (total > current._labelAmount
      || (total === current._labelAmount && vendorName.localeCompare(current.label) < 0)) {
      current.label = vendorName;
      current._labelAmount = total;
    }
    byVendor.set(subjectRef, current);
  }

  const byId = {};
  for (const [agencyId, vendors] of byAgency.entries()) {
    byId[agencyId] = [...vendors.values()]
      .sort((left, right) => right.award_total - left.award_total
        || right.award_count - left.award_count
        || left.label.localeCompare(right.label))
      .slice(0, limit)
      .map(({ _labelAmount, ...vendor }) => ({
        ...vendor,
        href: entityHref({ ref: vendor.subject_ref, label: vendor.label }),
      }));
  }

  return {
    schema: AGENCY_VENDOR_ROLLUP_SCHEMA,
    method: AGENCY_VENDOR_ROLLUP_METHOD,
    as_of: asOf,
    window_start: windowStart,
    window_days: windowDays,
    limit,
    by_id: byId,
  };
}
