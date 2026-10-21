/**
 * Opt-in historical capability-comparison journey (bounded pilot; default off).
 *
 * Composes procurement_capability_comparison.mjs with retained public award
 * records. Never mutates pursuit notes, watches, preference-set eligibility,
 * exact lineage, or buyer-history denominators. Historical awards expose
 * source-review and preparation actions only — never an open-bid CTA.
 */

import {
  CAPABILITY_ASSESSMENT_STATE,
  CAPABILITY_SOURCE_ROLE,
  compareCapabilities,
  normalizeCapabilityProfile,
} from "./procurement_capability_comparison.mjs";

export const PROCUREMENT_CAPABILITY_JOURNEY_SCHEMA =
  "cityscroll.procurement_capability_journey.v1";

export const CAPABILITY_COMPARE_BETA_SLUG = "capability-compare";

export const DEFAULT_DRAIN_PROFILE = Object.freeze({
  name: "Drain maintenance",
  capability_keywords: Object.freeze(["drain cleaning"]),
  jet_vac_truck: false,
  landscaping: false,
});

/** sessionStorage key for the capability-compare form across Back / remount. */
export const CAPABILITY_COMPARE_PROFILE_STORAGE_KEY =
  "crol:capability-compare:profile.v1";

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function text(value) {
  const s = String(value ?? "").trim();
  return s || null;
}

function publishDate(record) {
  const raw = text(record?.start_date) || text(record?.end_date);
  return raw ? raw.slice(0, 10) : null;
}

function formatAmount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

/**
 * Build the journey view for one explicit profile against a corpus of awards.
 * loadError preserves the profile and offers retry when source load failed.
 */
export function buildCapabilityJourney({
  profile = DEFAULT_DRAIN_PROFILE,
  records = [],
  loadError = null,
} = {}) {
  const normalized = normalizeCapabilityProfile(profile);
  if (loadError) {
    return Object.freeze({
      schema: PROCUREMENT_CAPABILITY_JOURNEY_SCHEMA,
      profile: normalized,
      source_role: CAPABILITY_SOURCE_ROLE,
      load_error: String(loadError),
      retry_available: true,
      records: Object.freeze([]),
      open_bid_cta: false,
      combined_spend: null,
      pursuit_notes_mutated: false,
    });
  }

  const rows = (Array.isArray(records) ? records : []).map((record) => {
    const comparison = compareCapabilities({ profile: normalized, record });
    return Object.freeze({
      notice_id: comparison.notice_id,
      source_url: comparison.source_url,
      agency_name: text(record.agency_name),
      short_title: text(record.short_title),
      award_status: text(record.type_of_notice_description) || "Award",
      published_on: publishDate(record),
      pin: text(record.pin),
      contract_amount: formatAmount(record.contract_amount),
      source_role: CAPABILITY_SOURCE_ROLE,
      comparison,
      preparation_actions: Object.freeze([
        Object.freeze({
          kind: "source_review",
          label: "Review published notice",
          href: comparison.source_url,
        }),
        Object.freeze({
          kind: "preparation_question",
          label: "Keep a preparation note for this buyer (local only)",
          href: null,
        }),
      ]),
    });
  });

  return Object.freeze({
    schema: PROCUREMENT_CAPABILITY_JOURNEY_SCHEMA,
    profile: normalized,
    source_role: CAPABILITY_SOURCE_ROLE,
    load_error: null,
    retry_available: false,
    records: Object.freeze(rows),
    open_bid_cta: false,
    // Never sum renewal or award amounts into a combined spend claim.
    combined_spend: null,
    pursuit_notes_mutated: false,
  });
}

function stateLabel(state) {
  switch (state) {
    case CAPABILITY_ASSESSMENT_STATE.SUPPORTED_OVERLAP:
      return "Matches your capabilities";
    case CAPABILITY_ASSESSMENT_STATE.STATED_CAPABILITY_GAP:
      return "Capability to arrange";
    case CAPABILITY_ASSESSMENT_STATE.DOCUMENT_REVIEW_NEEDED:
      return "Check the requirements";
    case CAPABILITY_ASSESSMENT_STATE.UNSPECIFIED:
      return "Tell us more";
    default:
      return "Assessment";
  }
}

function renderAssessment(assessment) {
  const citation = assessment.citation || {};
  const wording = assessment.wording
    .replaceAll("jet_vac_truck=false", "that jet-vac service is unavailable")
    .replaceAll("jet_vac_truck=true", "that jet-vac service is available")
    .replaceAll("landscaping=false", "that vegetation trimming is unavailable")
    .replaceAll("landscaping=true", "that vegetation trimming is available")
    .replaceAll("jet_vac_truck", "jet-vac service")
    .replaceAll("drain_cleaning", "drain-cleaning capability")
    .replaceAll("additional_description_1", "award description")
    .replaceAll("short_title", "award title");
  return `<li class="capability-assessment" data-state="${esc(assessment.state)}" data-duty="${esc(assessment.duty_id)}">
  <p class="capability-assessment-state"><strong>${esc(stateLabel(assessment.state))}</strong>${assessment.service_gap ? ` · ${esc(assessment.service_gap)}` : ""}</p>
  <p class="capability-assessment-wording">${esc(wording)}</p>
  <details class="capability-assessment-citation"><summary>Source evidence</summary><p>“${esc(citation.passage)}” · <a href="${esc(citation.url)}">Read award notice</a></p></details>
</li>`;
}

function renderRecordCard(row) {
  const assessments = (row.comparison?.assessments || []).map(renderAssessment).join("\n");
  const actions = (row.preparation_actions || [])
    .map((action) => {
      if (action.href) {
        return `<li><a href="${esc(action.href)}" rel="noopener noreferrer">${esc(action.label)}</a></li>`;
      }
      return `<li><span>${esc(action.label)}</span></li>`;
    })
    .join("\n");
  return `<article class="capability-record" data-notice-id="${esc(row.notice_id)}" data-source-role="${esc(row.source_role)}">
  <header>
    <p class="capability-record-meta">${esc(row.award_status)} · published ${esc(row.published_on || "date not published")}</p>
    <h3>${esc(row.short_title)}</h3>
    <p>${esc(row.agency_name)}${row.pin ? ` · PIN ${esc(row.pin)}` : ""}${row.contract_amount ? ` · ${esc(row.contract_amount)}` : ""}</p>
    <p class="capability-source-role">Based on the published award description, not the full specifications.</p>
  </header>
  <ul class="capability-assessments">
${assessments || "    <li>No cited duties matched the reviewed vocabulary on this award description.</li>"}
  </ul>
  <ul class="capability-actions">
${actions}
  </ul>
</article>`;
}

function renderProfileForm(profile) {
  const jet = profile.jet_vac_truck;
  const land = profile.landscaping;
  const keywords = (profile.capability_keywords || []).join(", ");
  return `<form class="capability-profile-form" data-capability-profile-form>
  <fieldset>
    <legend>Your stated capabilities</legend>
    <p class="capability-form-help">Answers stay in this browser session for the comparison. They do not change published award facts or any pursuit note you already saved.</p>
    <label>Capability keywords
      <input name="capability_keywords" type="text" value="${esc(keywords)}" autocomplete="off">
    </label>
    <label>Jet-vac truck service available?
      <select name="jet_vac_truck">
        <option value="" ${jet == null ? "selected" : ""}>Unspecified</option>
        <option value="true" ${jet === true ? "selected" : ""}>Yes</option>
        <option value="false" ${jet === false ? "selected" : ""}>No</option>
      </select>
    </label>
    <label>Landscaping / vegetation trimming available?
      <select name="landscaping">
        <option value="" ${land == null ? "selected" : ""}>Unspecified</option>
        <option value="true" ${land === true ? "selected" : ""}>Yes</option>
        <option value="false" ${land === false ? "selected" : ""}>No</option>
      </select>
    </label>
    <button type="submit">Update comparison</button>
  </fieldset>
</form>`;
}

/**
 * Render the journey as HTML. open_bid_cta is never emitted.
 */
export function renderCapabilityJourneyHtml(journey, { headingId = "capability-compare-heading" } = {}) {
  if (!journey) return "";
  if (journey.load_error) {
    return `<section class="capability-journey" data-capability-journey data-load-error="true" aria-labelledby="${esc(headingId)}">
  <h2 id="${esc(headingId)}">Compare capabilities</h2>
  ${renderProfileForm(journey.profile)}
  <p class="capability-load-error" role="alert">Could not load the awards. Your answers are preserved.</p>
  <details><summary>Error details</summary>${esc(journey.load_error)}</details>
  <p><button type="button" data-capability-retry>Retry loading awards</button></p>
</section>`;
  }

  const cards = (journey.records || []).map(renderRecordCard).join("\n");
  return `<section class="capability-journey" data-capability-journey data-open-bid-cta="false" aria-labelledby="${esc(headingId)}">
  <h2 id="${esc(headingId)}">Compare capabilities</h2>
  <p>Compare your services with ${journey.records.length} past award${journey.records.length === 1 ? "" : "s"}. Each card cites the published award description so you can review capability overlap and gaps before pursuing related work.</p>
  ${renderProfileForm(journey.profile)}
  <div class="capability-records">
${cards}
  </div>
</section>`;
}

/**
 * Parse form values into a capability profile input object.
 */
export function profileFromFormValues(values = {}) {
  const keywordsRaw = String(values.capability_keywords ?? "").split(/[,;]/);
  const ternary = (raw) => {
    if (raw === "true" || raw === true) return true;
    if (raw === "false" || raw === false) return false;
    return null;
  };
  return {
    capability_keywords: keywordsRaw.map((kw) => kw.trim()).filter(Boolean),
    jet_vac_truck: ternary(values.jet_vac_truck),
    landscaping: ternary(values.landscaping),
  };
}

function ternaryParam(raw) {
  if (raw === "true" || raw === true) return true;
  if (raw === "false" || raw === false) return false;
  return null;
}

/**
 * Serialize a profile for sessionStorage (JSON). Omits the display name.
 */
export function serializeCapabilityProfile(profile = {}) {
  return JSON.stringify({
    capability_keywords: Array.isArray(profile.capability_keywords)
      ? profile.capability_keywords.map((kw) => String(kw).trim()).filter(Boolean)
      : [],
    jet_vac_truck: profile.jet_vac_truck == null ? null : Boolean(profile.jet_vac_truck),
    landscaping: profile.landscaping == null ? null : Boolean(profile.landscaping),
  });
}

/**
 * Parse a stored JSON profile. Returns null when the payload is missing or invalid.
 */
export function parseCapabilityProfile(raw) {
  if (raw == null || raw === "") return null;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== "object") return null;
    return profileFromFormValues({
      capability_keywords: Array.isArray(parsed.capability_keywords)
        ? parsed.capability_keywords.join(", ")
        : parsed.capability_keywords,
      jet_vac_truck: parsed.jet_vac_truck,
      landscaping: parsed.landscaping,
    });
  } catch {
    return null;
  }
}

/**
 * Read a persisted profile from a Storage-like object. Returns null when absent.
 */
export function readCapabilityProfileFromStorage(storage) {
  if (!storage || typeof storage.getItem !== "function") return null;
  try {
    return parseCapabilityProfile(storage.getItem(CAPABILITY_COMPARE_PROFILE_STORAGE_KEY));
  } catch {
    return null;
  }
}

/**
 * Write a profile to a Storage-like object. No-ops when storage is unavailable.
 */
export function writeCapabilityProfileToStorage(storage, profile) {
  if (!storage || typeof storage.setItem !== "function") return false;
  try {
    storage.setItem(CAPABILITY_COMPARE_PROFILE_STORAGE_KEY, serializeCapabilityProfile(profile));
    return true;
  } catch {
    return false;
  }
}

/** Query keys that must never carry capability-profile answers (Clarity sees the URL). */
export const CAPABILITY_PROFILE_QUERY_KEYS = Object.freeze([
  "capability_keywords",
  "jet_vac_truck",
  "landscaping",
]);

/** history.state field for the capability-compare form across Back. */
export const CAPABILITY_COMPARE_HISTORY_STATE_KEY = "capabilityCompareProfile";

/**
 * True when the search params carry at least one explicit profile field.
 */
export function searchParamsHaveCapabilityProfile(params) {
  if (!params || typeof params.get !== "function") return false;
  return CAPABILITY_PROFILE_QUERY_KEYS.some((key) => params.has(key));
}

/**
 * Build a profile from URL search params when profile fields are present.
 * Legacy bookmarks only — new writes must not put answers in the URL.
 */
export function capabilityProfileFromSearchParams(params) {
  if (!searchParamsHaveCapabilityProfile(params)) return null;
  return profileFromFormValues({
    capability_keywords: params.get("capability_keywords") ?? "",
    jet_vac_truck: ternaryParam(params.get("jet_vac_truck")),
    landscaping: ternaryParam(params.get("landscaping")),
  });
}

/**
 * Remove profile fields from URL search params (mutates and returns params).
 * Keeps non-profile params such as beta=.
 */
export function stripCapabilityProfileFromSearchParams(params) {
  if (!params || typeof params.delete !== "function") return params;
  for (const key of CAPABILITY_PROFILE_QUERY_KEYS) params.delete(key);
  return params;
}

/**
 * Copy profile fields onto URL search params (mutates and returns params).
 * Kept for regression tests that prove stripping undoes a legacy write.
 * Production boot must never call this for persistence.
 */
export function applyCapabilityProfileToSearchParams(params, profile) {
  if (!params || typeof params.set !== "function") return params;
  const keywords = Array.isArray(profile?.capability_keywords)
    ? profile.capability_keywords.join(", ")
    : "";
  if (keywords) params.set("capability_keywords", keywords);
  else params.delete("capability_keywords");

  const writeTernary = (key, value) => {
    if (value === true) params.set(key, "true");
    else if (value === false) params.set(key, "false");
    else params.delete(key);
  };
  writeTernary("jet_vac_truck", profile?.jet_vac_truck);
  writeTernary("landscaping", profile?.landscaping);
  return params;
}

/**
 * Read a profile from history.state when present.
 */
export function capabilityProfileFromHistoryState(historyState) {
  if (!historyState || typeof historyState !== "object") return null;
  return parseCapabilityProfile(historyState[CAPABILITY_COMPARE_HISTORY_STATE_KEY]);
}

/**
 * Merge a profile into a history.state object (does not touch the URL).
 */
export function applyCapabilityProfileToHistoryState(historyState, profile) {
  const base =
    historyState && typeof historyState === "object" && !Array.isArray(historyState)
      ? { ...historyState }
      : {};
  base[CAPABILITY_COMPARE_HISTORY_STATE_KEY] = {
    capability_keywords: Array.isArray(profile?.capability_keywords)
      ? profile.capability_keywords.map((kw) => String(kw).trim()).filter(Boolean)
      : [],
    jet_vac_truck: profile?.jet_vac_truck == null ? null : Boolean(profile.jet_vac_truck),
    landscaping: profile?.landscaping == null ? null : Boolean(profile.landscaping),
  };
  return base;
}

/**
 * Migrate any legacy profile query params into sessionStorage + history.state,
 * then strip them from the URL via replaceState before analytics can read them.
 * Returns true when the URL had profile fields that were stripped.
 */
export function scrubCapabilityProfileFromLocation({
  location: loc = globalThis.location,
  history: hist = globalThis.history,
  storage = null,
} = {}) {
  if (!loc || !hist || typeof hist.replaceState !== "function") return false;
  let url;
  try {
    url = new URL(loc.href);
  } catch {
    return false;
  }
  if (!searchParamsHaveCapabilityProfile(url.searchParams)) return false;
  const migrated = capabilityProfileFromSearchParams(url.searchParams);
  if (migrated) {
    writeCapabilityProfileToStorage(storage, migrated);
  }
  stripCapabilityProfileFromSearchParams(url.searchParams);
  const nextState = applyCapabilityProfileToHistoryState(
    hist.state,
    migrated || readCapabilityProfileFromStorage(storage) || DEFAULT_DRAIN_PROFILE,
  );
  const nextUrl = `${url.pathname}${url.search}${url.hash}`;
  hist.replaceState(nextState, "", nextUrl);
  return true;
}

/**
 * Resolve the initial profile: history.state, then sessionStorage, then the default.
 * Call scrubCapabilityProfileFromLocation first so legacy URL answers never stay in href.
 */
export function resolveInitialCapabilityProfile({
  historyState = null,
  storage = null,
  fallback = DEFAULT_DRAIN_PROFILE,
} = {}) {
  const fromHistory = capabilityProfileFromHistoryState(historyState);
  if (fromHistory) return fromHistory;
  const fromStorage = readCapabilityProfileFromStorage(storage);
  if (fromStorage) return fromStorage;
  return {
    ...fallback,
    capability_keywords: [...(fallback.capability_keywords || [])],
  };
}

/**
 * Persist profile to sessionStorage + history.state and ensure the URL has no
 * profile query fields. Never writes answers into location.search.
 */
export function persistCapabilityProfilePrivately({
  profile,
  storage = null,
  location: loc = globalThis.location,
  history: hist = globalThis.history,
  ensureBeta = true,
} = {}) {
  writeCapabilityProfileToStorage(storage, profile);
  if (!loc || !hist || typeof hist.replaceState !== "function") {
    return { href: loc?.href ?? null, state: hist?.state ?? null };
  }
  let url;
  try {
    url = new URL(loc.href);
  } catch {
    return { href: loc.href, state: hist.state };
  }
  stripCapabilityProfileFromSearchParams(url.searchParams);
  if (ensureBeta && !url.searchParams.get("beta")) {
    url.searchParams.set("beta", CAPABILITY_COMPARE_BETA_SLUG);
  }
  const nextState = applyCapabilityProfileToHistoryState(hist.state, profile);
  const nextUrl = `${url.pathname}${url.search}${url.hash}`;
  hist.replaceState(nextState, "", nextUrl);
  return { href: nextUrl, state: nextState };
}

/**
 * True when HTML contains no open-bid call to action.
 */
export function journeyHtmlOmitsOpenBidCta(html) {
  const textContent = String(html || "").toLowerCase();
  return !/\b(bid now|submit a bid|open bid|respond to solicitation|apply now)\b/.test(textContent);
}
