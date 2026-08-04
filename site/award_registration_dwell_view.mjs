/**
 * Client view model for Human Services award → registration dwell strip.
 *
 * Consumes the precomputed lookup at
 * site/data/award_registration_dwell_lookup.json (built from
 * award_registration_dwell_observations.json). No live join at render.
 *
 * Honesty (mirrors worker/src/lib/award_registration_dwell.mjs):
 *   - found + dwell_days:0  → same-day registration (allowed)
 *   - unknown               → dwell_days is null; never render as 0 / instant
 *   - negative dwell        → registration before City Record award notice
 *   - not in corpus         → clean absence (no strip)
 */

export const AWARD_REGISTRATION_DWELL_LOOKUP_PATH =
  "data/award_registration_dwell_lookup.json";

export const HUMAN_SERVICES_CATEGORY = "Human Services/Client Services";
export const AWARD_TYPE = "Award";

export const REGISTRATION_STATUS_FOUND = "found";
export const REGISTRATION_STATUS_UNKNOWN = "unknown";

/**
 * Eligibility: City Record Award + Human Services / Client Services.
 * Same gate as the materialization population.
 * @param {object} row
 */
export function isHumanServicesAwardNotice(row = {}) {
  const type = String(
    row.type_of_notice_description || row.type_of_notice || "",
  ).trim();
  const category = String(
    row.category_description || row.category || "",
  ).trim();
  if (type !== AWARD_TYPE) return false;
  if (category === HUMAN_SERVICES_CATEGORY) return true;
  return /human\s*services/i.test(category) && /client\s*services/i.test(category);
}

/**
 * Normalize a compact lookup row or a full observation into a stable shape.
 * @param {object|Array|null} raw
 * @param {string} [requestId]
 * @returns {{
 *   request_id: string|null,
 *   registration_status: 'found'|'unknown',
 *   dwell_days: number|null,
 *   award_date: string|null,
 *   registration_date: string|null,
 * }|null}
 */
export function normalizeDwellObservation(raw, requestId = null) {
  if (raw == null) return null;

  // Compact unknown marker: 1 / true (must run before typeof-object gate).
  if (raw === 1 || raw === true) {
    return {
      request_id: requestId || null,
      registration_status: REGISTRATION_STATUS_UNKNOWN,
      dwell_days: null,
      award_date: null,
      registration_date: null,
    };
  }

  // Compact found tuple: [dwell_days, award_date, registration_date]
  if (Array.isArray(raw)) {
    const dwell = raw[0];
    if (dwell == null || !Number.isFinite(Number(dwell))) return null;
    return {
      request_id: requestId || null,
      registration_status: REGISTRATION_STATUS_FOUND,
      dwell_days: Number(dwell),
      award_date: raw[1] || null,
      registration_date: raw[2] || null,
    };
  }
  if (typeof raw !== "object") return null;

  const statusRaw = String(
    raw.registration_status || raw.s || raw.status || "",
  ).toLowerCase();
  if (statusRaw === REGISTRATION_STATUS_UNKNOWN || statusRaw === "u") {
    // Coerce any poisoned dwell on unknown → null (never surface as instant).
    return {
      request_id: requestId || raw.request_id || null,
      registration_status: REGISTRATION_STATUS_UNKNOWN,
      dwell_days: null,
      award_date: raw.award_date || raw.a || null,
      registration_date: null,
    };
  }

  const dwell =
    raw.dwell_days != null
      ? Number(raw.dwell_days)
      : raw.d != null
        ? Number(raw.d)
        : null;
  if (dwell == null || !Number.isFinite(dwell)) return null;
  return {
    request_id: requestId || raw.request_id || null,
    registration_status: REGISTRATION_STATUS_FOUND,
    dwell_days: dwell,
    award_date: raw.award_date || raw.a || null,
    registration_date: raw.registration_date || raw.r || null,
  };
}

/**
 * Look up one notice in the compact lookup document.
 * @param {object|null} lookup
 * @param {string} requestId
 */
export function lookupAwardRegistrationDwell(lookup, requestId) {
  const id = String(requestId || "").trim();
  if (!id || !lookup) return null;

  // Prefer compact found/unknown maps written by the build.
  if (lookup.found && Object.prototype.hasOwnProperty.call(lookup.found, id)) {
    return normalizeDwellObservation(lookup.found[id], id);
  }
  if (lookup.unknown) {
    if (Array.isArray(lookup.unknown)) {
      if (lookup.unknown.includes(id)) {
        return normalizeDwellObservation({ registration_status: "unknown" }, id);
      }
    } else if (Object.prototype.hasOwnProperty.call(lookup.unknown, id)) {
      return normalizeDwellObservation(lookup.unknown[id], id);
    }
  }

  // by_id map variant
  if (lookup.by_id && Object.prototype.hasOwnProperty.call(lookup.by_id, id)) {
    return normalizeDwellObservation(lookup.by_id[id], id);
  }

  // Full observations document (found[] / unknown[] arrays)
  if (Array.isArray(lookup.found)) {
    const hit = lookup.found.find((r) => r && String(r.request_id) === id);
    if (hit) return normalizeDwellObservation(hit, id);
  }
  if (Array.isArray(lookup.unknown)) {
    const hit = lookup.unknown.find((r) => r && String(r.request_id) === id);
    if (hit) {
      return normalizeDwellObservation(
        { ...hit, registration_status: "unknown" },
        id,
      );
    }
  }
  return null;
}

/**
 * Build the notice-strip view model.
 * Returns null for clean absence (not HS award, or not in corpus).
 *
 * @param {object} notice City Record notice row
 * @param {object|null} lookup precomputed lookup
 * @param {object} [opts]
 * @param {object|null} [opts.observation] pre-resolved observation (tests)
 * @returns {{
 *   status: 'found'|'unknown',
 *   dwell_days: number|null,
 *   award_date: string|null,
 *   registration_date: string|null,
 *   request_id: string|null,
 *   line_key: string,
 *   line_params: object,
 *   honesty_frame_key: string|null,
 *   render: 'line'|'quiet',
 * }|null}
 */
export function buildAwardRegistrationDwellStrip(notice, lookup, opts = {}) {
  if (!isHumanServicesAwardNotice(notice) && !opts.observation) return null;

  const id = String(notice?.request_id || opts.observation?.request_id || "").trim();
  const obs =
    opts.observation
      ? normalizeDwellObservation(opts.observation, id)
      : lookupAwardRegistrationDwell(lookup, id);

  if (!obs) return null; // not in corpus → clean absence

  if (obs.registration_status === REGISTRATION_STATUS_UNKNOWN) {
    // Honesty: never invent dwell_days (esp. 0) for unknown.
    if (obs.dwell_days != null) {
      // Treat honesty violation as quiet absence rather than a false instant.
      return null;
    }
    return {
      status: REGISTRATION_STATUS_UNKNOWN,
      dwell_days: null,
      award_date: obs.award_date,
      registration_date: null,
      request_id: obs.request_id || id || null,
      line_key: "award_reg_dwell_unknown_html",
      line_params: {},
      honesty_frame_key: null,
      render: "quiet",
    };
  }

  const days = obs.dwell_days;
  if (days == null || !Number.isFinite(days)) return null;

  let line_key;
  let line_params;
  if (days === 0) {
    line_key = "award_reg_dwell_same_day_html";
    line_params = {
      award: obs.award_date || "",
      registration: obs.registration_date || "",
    };
  } else if (days > 0) {
    line_key = "award_reg_dwell_after_html";
    line_params = {
      days: String(Math.abs(days)),
      award: obs.award_date || "",
      registration: obs.registration_date || "",
    };
  } else {
    // Registration prior to City Record award publication (signed dwell).
    line_key = "award_reg_dwell_before_html";
    line_params = {
      days: String(Math.abs(days)),
      award: obs.award_date || "",
      registration: obs.registration_date || "",
    };
  }

  return {
    status: REGISTRATION_STATUS_FOUND,
    dwell_days: days,
    award_date: obs.award_date,
    registration_date: obs.registration_date,
    request_id: obs.request_id || id || null,
    line_key,
    line_params,
    // Ties to payment-honesty: registration starts the payment clock.
    honesty_frame_key: "award_reg_dwell_payment_frame_html",
    render: "line",
  };
}

/**
 * Resolve i18n keys on a strip view into display strings.
 * @param {ReturnType<typeof buildAwardRegistrationDwellStrip>} strip
 * @param {(key: string, params?: object) => string} t
 */
export function formatAwardRegistrationDwellStrip(strip, t) {
  if (!strip || typeof t !== "function") return null;
  const line = t(strip.line_key, strip.line_params || {});
  const frame = strip.honesty_frame_key
    ? t(strip.honesty_frame_key)
    : null;
  return {
    status: strip.status,
    dwell_days: strip.dwell_days,
    line,
    frame,
    render: strip.render,
    request_id: strip.request_id,
    award_date: strip.award_date,
    registration_date: strip.registration_date,
  };
}

/**
 * Build compact lookup document from a full observations artifact
 * (found[] / unknown[] arrays) for client fetch.
 * @param {object} observationsDoc
 */
export function buildCompactDwellLookup(observationsDoc) {
  const found = {};
  const unknown = {};
  for (const o of observationsDoc?.found || []) {
    const id = String(o?.request_id || "").trim();
    if (!id) continue;
    if (o.dwell_days == null || !Number.isFinite(Number(o.dwell_days))) continue;
    found[id] = [
      Number(o.dwell_days),
      o.award_date || null,
      o.registration_date || null,
    ];
  }
  for (const o of observationsDoc?.unknown || []) {
    const id = String(o?.request_id || "").trim();
    if (!id) continue;
    // Honesty: skip any unknown row that incorrectly carries a dwell.
    if (o.dwell_days != null) continue;
    unknown[id] = 1;
  }
  return {
    schema_version: 1,
    model_name: observationsDoc?.model_name || "award_registration_dwell",
    model_version: observationsDoc?.model_version || "1.0.0",
    generated_at: observationsDoc?.generated_at || null,
    n_found: Object.keys(found).length,
    n_unknown: Object.keys(unknown).length,
    honesty: { unknown_never_zero: true },
    found,
    unknown,
  };
}
