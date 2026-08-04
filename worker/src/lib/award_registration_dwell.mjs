/**
 * Award → registration dwell for Human Services / Client Services awards.
 *
 * Award event: City Record Online Procurement notice with
 *   type_of_notice_description = Award and category Human Services/Client Services
 *   (publication day from start_date).
 *
 * Registration event: first joinable PASSPort Public contract registration_date
 *   for the notice PIN (strict EPIN join via passport_join), when present.
 *   Checkbook-shaped registration rows ({ pin, registration_date }) are accepted
 *   as an alternate registration side-car for fixtures and future bulk packs.
 *
 * Honesty: when registration is unfound, status is "unknown" and dwell_days is
 * null — never a zero that reads as same-day / instant registration.
 * Registration before the City Record award publication is kept as a signed
 * dwell (often legitimate; City Record can lag Checkbook/PASSPort).
 */

import {
  buildEpinIndex,
  joinPinToEpin,
  normId,
} from "./passport_join.mjs";

export const HUMAN_SERVICES_CATEGORY = "Human Services/Client Services";
export const AWARD_TYPE = "Award";
export const MODEL_NAME = "award_registration_dwell";
export const MODEL_VERSION = "1.0.0";
export const REGISTRATION_STATUS_FOUND = "found";
export const REGISTRATION_STATUS_UNKNOWN = "unknown";

const DAY_MS = 86_400_000;

/** YYYY-MM-DD from ISO / US / bare date strings; null when unparseable. */
export function isoDay(value) {
  if (value == null || value === "") return null;
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    const day = raw.slice(0, 10);
    return Number.isFinite(Date.parse(`${day}T00:00:00Z`)) ? day : null;
  }
  const us = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) {
    const mm = us[1].padStart(2, "0");
    const dd = us[2].padStart(2, "0");
    const day = `${us[3]}-${mm}-${dd}`;
    return Number.isFinite(Date.parse(`${day}T00:00:00Z`)) ? day : null;
  }
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

export function daysBetween(fromDay, toDay) {
  const a = isoDay(fromDay);
  const b = isoDay(toDay);
  if (!a || !b) return null;
  return Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS,
  );
}

export function isHumanServicesAward(row = {}) {
  const type = String(
    row.type_of_notice_description || row.type_of_notice || "",
  ).trim();
  const category = String(row.category_description || row.category || "").trim();
  if (type !== AWARD_TYPE) return false;
  // Accept exact product category and close variants seen in older dumps.
  if (category === HUMAN_SERVICES_CATEGORY) return true;
  return /human\s*services/i.test(category) && /client\s*services/i.test(category);
}

/**
 * Build a PIN → earliest registration_date map from PASSPort contract rows.
 * Prefer rows with a parseable registration_date; keep the earliest date per
 * normalized EPIN key (and strip-suffix parents are handled at join time).
 *
 * @param {Array<object>} contracts PASSPort mapContractRow-shaped objects
 * @returns {{ byEpin: Map<string, object>, index: ReturnType<typeof buildEpinIndex> }}
 */
export function buildRegistrationIndex(contracts = []) {
  const byEpin = new Map();
  const epins = [];
  for (const row of contracts || []) {
    const epin = normId(row.epin || row.epin_norm || row.pin || "");
    if (!epin) continue;
    epins.push(epin);
    const regDay = isoDay(row.registration_date || row.registered || null);
    const prev = byEpin.get(epin);
    if (!prev) {
      byEpin.set(epin, {
        epin,
        registration_date: regDay,
        contract_id: row.contract_id || null,
        status: row.status || null,
        source: row.source || "passport",
        vendor: row.vendor || row.vendor_name || null,
      });
      continue;
    }
    // Prefer a known registration_date over null; then earliest date.
    if (!prev.registration_date && regDay) {
      byEpin.set(epin, {
        epin,
        registration_date: regDay,
        contract_id: row.contract_id || null,
        status: row.status || null,
        source: row.source || prev.source || "passport",
        vendor: row.vendor || row.vendor_name || prev.vendor || null,
      });
    } else if (
      regDay
      && prev.registration_date
      && regDay < prev.registration_date
    ) {
      byEpin.set(epin, {
        epin,
        registration_date: regDay,
        contract_id: row.contract_id || null,
        status: row.status || null,
        source: row.source || prev.source || "passport",
        vendor: row.vendor || row.vendor_name || prev.vendor || null,
      });
    }
  }
  return { byEpin, index: buildEpinIndex(epins) };
}

/**
 * Optional Checkbook-shaped side-car: rows with { pin, registration_date }.
 * Merged into the same EPIN index under source "checkbook".
 */
export function mergeCheckbookRegistrations(regIndex, rows = []) {
  const byEpin = new Map(regIndex.byEpin);
  const epins = [...byEpin.keys()];
  for (const row of rows || []) {
    const epin = normId(row.pin || row.epin || "");
    if (!epin) continue;
    epins.push(epin);
    const regDay = isoDay(row.registration_date || row.registered || null);
    const prev = byEpin.get(epin);
    if (!prev) {
      byEpin.set(epin, {
        epin,
        registration_date: regDay,
        contract_id: row.contract_id || row.id || null,
        status: row.status || null,
        source: "checkbook",
        vendor: row.vendor || row.vendor_name || null,
      });
      continue;
    }
    if (!prev.registration_date && regDay) {
      byEpin.set(epin, {
        ...prev,
        registration_date: regDay,
        source: prev.source || "checkbook",
      });
    } else if (
      regDay
      && prev.registration_date
      && regDay < prev.registration_date
    ) {
      byEpin.set(epin, {
        ...prev,
        registration_date: regDay,
      });
    }
  }
  return { byEpin, index: buildEpinIndex(epins) };
}

/**
 * One observation per Human Services Award notice.
 * registration_status is "found" only when a registration_date joins;
 * otherwise "unknown" with dwell_days null (never 0 for unknown).
 */
export function observeAwardRegistrationDwell(awardRow, regIndex) {
  const requestId = String(awardRow?.request_id || "").trim();
  const pin = String(awardRow?.pin || "").trim();
  const awardDate = isoDay(awardRow?.start_date || awardRow?.award_date);
  const base = {
    request_id: requestId || null,
    pin: pin || null,
    agency_name: awardRow?.agency_name || awardRow?.agency || null,
    vendor_name: awardRow?.vendor_name || awardRow?.vendor || null,
    contract_amount:
      awardRow?.contract_amount != null && awardRow?.contract_amount !== ""
        ? Number(awardRow.contract_amount)
        : null,
    short_title: awardRow?.short_title || awardRow?.title || null,
    category_description:
      awardRow?.category_description || awardRow?.category || null,
    award_date: awardDate,
    registration_date: null,
    dwell_days: null,
    registration_status: REGISTRATION_STATUS_UNKNOWN,
    registration_source: null,
    join_method: null,
    registration_contract_id: null,
    registration_epin: null,
  };

  if (!awardDate || !pin || !regIndex?.index) {
    return base;
  }

  const hit = joinPinToEpin(pin, regIndex.index);
  if (!hit) return base;

  const reg = regIndex.byEpin.get(hit.epin) || null;
  const regDay = reg?.registration_date || null;
  if (!regDay) {
    return {
      ...base,
      join_method: hit.method,
      registration_epin: hit.epin,
      registration_source: reg?.source || null,
      registration_contract_id: reg?.contract_id || null,
      // Joined a PASSPort/Checkbook row but no registration_date → still unknown.
      registration_status: REGISTRATION_STATUS_UNKNOWN,
      dwell_days: null,
    };
  }

  const dwell = daysBetween(awardDate, regDay);
  return {
    ...base,
    registration_date: regDay,
    dwell_days: dwell,
    registration_status: REGISTRATION_STATUS_FOUND,
    registration_source: reg?.source || "passport",
    join_method: hit.method,
    registration_contract_id: reg?.contract_id || null,
    registration_epin: hit.epin,
  };
}

/**
 * @param {Array<object>} cityRecordRows full or filtered City Record rows
 * @param {object} regIndex from buildRegistrationIndex (+ optional merge)
 * @param {object} [opts]
 * @param {string} [opts.generatedAt]
 * @param {object} [opts.corpus] provenance labels for the artifact
 */
export function buildAwardRegistrationDwellReport(
  cityRecordRows = [],
  regIndex,
  opts = {},
) {
  const awards = (Array.isArray(cityRecordRows) ? cityRecordRows : [])
    .filter(isHumanServicesAward)
    .filter((r) => String(r.request_id || "").trim());

  // One row per request_id (latest publication wins if duplicates).
  const byId = new Map();
  for (const row of awards) {
    const id = String(row.request_id).trim();
    const prev = byId.get(id);
    if (!prev) {
      byId.set(id, row);
      continue;
    }
    const prevDay = isoDay(prev.start_date) || "";
    const nextDay = isoDay(row.start_date) || "";
    if (nextDay >= prevDay) byId.set(id, row);
  }

  // Per-award dwell rows derived from City Record awards (dg92-zbpx) + registration index.
  const observations = Array.from(byId.values())
    .map((row) => observeAwardRegistrationDwell(row, regIndex))
    .sort(
      (a, b) =>
        String(b.award_date || "").localeCompare(String(a.award_date || ""))
        || String(a.request_id || "").localeCompare(String(b.request_id || "")),
    );

  const stats = summarizeDwellObservations(observations);

  return {
    schema_version: 1,
    model_name: MODEL_NAME,
    model_version: MODEL_VERSION,
    generated_at: opts.generatedAt || new Date().toISOString(),
    category: HUMAN_SERVICES_CATEGORY,
    award_type: AWARD_TYPE,
    honesty: {
      unknown_never_zero: true,
      unknown_label: REGISTRATION_STATUS_UNKNOWN,
      note:
        "dwell_days is null when registration is unfound — never 0 for unknown. "
        + "A true same-day registration is status=found with dwell_days=0.",
    },
    corpus: opts.corpus || null,
    stats,
    observations,
  };
}

/** Nearest-rank empirical quantile; values must be finite numbers. */
export function empiricalQuantile(values = [], probability) {
  if (!values.length) return null;
  if (!(probability >= 0 && probability <= 1)) {
    throw new TypeError("probability must be in [0,1]");
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(probability * sorted.length));
  return sorted[Math.min(sorted.length - 1, rank - 1)];
}

export function summarizeDwellObservations(observations = []) {
  const rows = Array.isArray(observations) ? observations : [];
  const n = rows.length;
  const found = rows.filter((r) => r.registration_status === REGISTRATION_STATUS_FOUND);
  const unknown = rows.filter((r) => r.registration_status !== REGISTRATION_STATUS_FOUND);
  const dwells = found
    .map((r) => r.dwell_days)
    .filter((d) => d != null && Number.isFinite(d));
  const nonNeg = dwells.filter((d) => d >= 0);
  const prior = dwells.filter((d) => d < 0);

  const dist = (values) => {
    if (!values.length) {
      return {
        n: 0,
        min: null,
        p10: null,
        p25: null,
        p50: null,
        p75: null,
        p90: null,
        max: null,
        mean: null,
      };
    }
    const sum = values.reduce((a, b) => a + b, 0);
    return {
      n: values.length,
      min: Math.min(...values),
      p10: empiricalQuantile(values, 0.1),
      p25: empiricalQuantile(values, 0.25),
      p50: empiricalQuantile(values, 0.5),
      p75: empiricalQuantile(values, 0.75),
      p90: empiricalQuantile(values, 0.9),
      max: Math.max(...values),
      mean: Math.round((sum / values.length) * 100) / 100,
    };
  };

  const byJoin = {};
  for (const r of found) {
    const m = r.join_method || "unknown";
    byJoin[m] = (byJoin[m] || 0) + 1;
  }
  const bySource = {};
  for (const r of found) {
    const s = r.registration_source || "unknown";
    bySource[s] = (bySource[s] || 0) + 1;
  }

  return {
    n_awards: n,
    n_found: found.length,
    n_unknown: unknown.length,
    join_rate: n ? Math.round((found.length / n) * 10000) / 10000 : null,
    unknown_rate: n ? Math.round((unknown.length / n) * 10000) / 10000 : null,
    // Primary distribution: non-negative award→registration dwell (days).
    dwell_days_non_negative: dist(nonNeg),
    // Registration published before City Record award (signed, not coerced to 0).
    dwell_days_registration_prior: dist(prior.map((d) => Math.abs(d))),
    dwell_days_all_signed: dist(dwells),
    by_join_method: byJoin,
    by_registration_source: bySource,
    // Guard: unknown rows must not carry a numeric dwell (incl. 0).
    honesty_violations: rows.filter(
      (r) =>
        r.registration_status === REGISTRATION_STATUS_UNKNOWN
        && r.dwell_days != null,
    ).length,
  };
}

/**
 * Public artifact without the full observation list (for slim check/receipt).
 * Full report keeps observations for offline analysis.
 */
export function publicSummary(report) {
  if (!report) return null;
  return {
    schema_version: report.schema_version,
    model_name: report.model_name,
    model_version: report.model_version,
    generated_at: report.generated_at,
    category: report.category,
    award_type: report.award_type,
    honesty: report.honesty,
    corpus: report.corpus,
    stats: report.stats,
  };
}
