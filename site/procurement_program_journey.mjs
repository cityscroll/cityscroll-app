/**
 * Opt-in program-history journey for retained public awards (default off).
 *
 * Composes program-capability retrieval with a session-local profile form.
 * Shows distinct award events, cited training and coating duties, and a
 * sourced consortium route. Never forecasts a future opening, never sums
 * award spend, never mutates pursuit notes, and never offers an open-bid CTA.
 */

import {
  PROGRAM_SOURCE_ROLE,
  PROGRAM_RELATION,
  normalizeProgramProfile,
  extractProgramCapabilities,
  matchProgramRecords,
  groupProgramHistory,
  relationBetween,
} from "./procurement_program_capabilities.mjs";

export const PROCUREMENT_PROGRAM_JOURNEY_SCHEMA =
  "cityscroll.procurement_program_journey.v1";

export const PROGRAM_HISTORY_BETA_SLUG = "program-history";

/** Retained corpus notices always offered when the live corpus cannot load. */
export const PROGRAM_HISTORY_SOURCE_LINKS = Object.freeze([
  Object.freeze({
    notice_id: "20220719104",
    href: "https://cityscroll.org/notices/20220719104/",
  }),
  Object.freeze({
    notice_id: "20240417107",
    href: "https://cityscroll.org/notices/20240417107/",
  }),
  Object.freeze({
    notice_id: "20260708004",
    href: "https://cityscroll.org/notices/20260708004/",
  }),
]);

export const DEFAULT_TRAINING_PROFILE = Object.freeze({
  name: "Workforce training nonprofit",
  capability_keywords: Object.freeze(["job training", "employer placement"]),
  job_training: true,
  employer_placement: true,
  roof_installation_crew: false,
});

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function text(value) {
  const s = String(value ?? "").trim();
  return s || null;
}

function publishDate(record) {
  const raw = text(record?.start_date) || text(record?.published_on);
  if (!raw) return null;
  return raw.slice(0, 10);
}

function assessCapabilities(profile, capabilities) {
  const assessments = [];
  for (const cap of capabilities) {
    let state = "document_review_needed";
    let wording = `Review the cited ${cap.label} passage in the published notice.`;
    let service_gap = null;

    if (cap.capability_id === "consortium_delivery") {
      state = "document_review_needed";
      wording =
        "A consortium delivery route is cited on this award. Lead eligibility and staffing requirements stay document-review questions.";
    } else if (
      cap.kind === "program_identity" ||
      cap.capability_id === "jobseeker_training"
    ) {
      if (profile.job_training === true) {
        state = "supported_overlap";
        wording = `Your stated job-training capability overlaps the cited ${cap.label} passage.`;
      } else if (profile.job_training === false) {
        state = "stated_capability_gap";
        service_gap = cap.label;
        wording = `You marked job training unavailable; this award cites ${cap.label}.`;
      } else {
        state = "unspecified";
        wording = `Job training is unspecified for the cited ${cap.label} passage.`;
      }
    } else if (cap.capability_id === "reflective_coating") {
      if (profile.roof_installation_crew === true) {
        state = "supported_overlap";
        wording =
          "Your stated roof-installation capability overlaps the cited reflective coating passage.";
      } else if (profile.roof_installation_crew === false) {
        state = "stated_capability_gap";
        service_gap = "physical roof coating delivery";
        wording =
          "You marked roof-installation crew unavailable; this award cites white, reflective coating delivery.";
      } else {
        state = "unspecified";
        wording =
          "Roof-installation capability is unspecified for the cited coating passage.";
      }
    }

    assessments.push(
      Object.freeze({
        capability_id: cap.capability_id,
        label: cap.label,
        state,
        service_gap,
        wording,
        citation: cap.citation,
        ownership_required: null,
        overall_eligibility: null,
      }),
    );
  }
  return Object.freeze(assessments);
}

export function buildProgramJourney({
  profile = DEFAULT_TRAINING_PROFILE,
  records = [],
  loadError = null,
} = {}) {
  const normalized = normalizeProgramProfile(profile);
  if (loadError) {
    return Object.freeze({
      schema: PROCUREMENT_PROGRAM_JOURNEY_SCHEMA,
      profile: normalized,
      source_role: PROGRAM_SOURCE_ROLE,
      load_error: String(loadError),
      retry_available: true,
      source_links: PROGRAM_HISTORY_SOURCE_LINKS,
      records: Object.freeze([]),
      relations: Object.freeze([]),
      open_bid_cta: false,
      combined_spend: null,
      future_opening_predicted: false,
      automatic_qualification: false,
      pursuit_notes_mutated: false,
    });
  }

  const match = matchProgramRecords({ profile: normalized, records });
  const group = groupProgramHistory({ records });
  const byId = Object.fromEntries(
    (group.members || []).map((m) => [m.notice_id, m]),
  );

  const rows = (match.matches || []).map((m) => {
    const member = byId[m.notice_id];
    const record = m.record;
    const capabilities = member?.capabilities || extractProgramCapabilities(record);
    return Object.freeze({
      notice_id: m.notice_id,
      source_url: m.source_url,
      agency_name: text(record.agency_name),
      short_title: text(record.short_title),
      award_status: text(record.type_of_notice_description) || "Award",
      published_on: publishDate(record),
      category_description: text(record.category_description),
      pin: text(record.pin),
      source_role: PROGRAM_SOURCE_ROLE,
      assessments: assessCapabilities(normalized, capabilities),
      preparation_actions: Object.freeze([
        Object.freeze({
          kind: "source_review",
          label: "Review published notice",
          href: m.source_url,
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
    schema: PROCUREMENT_PROGRAM_JOURNEY_SCHEMA,
    profile: normalized,
    source_role: PROGRAM_SOURCE_ROLE,
    load_error: null,
    retry_available: false,
    records: Object.freeze(rows),
    relations: group.relations,
    open_bid_cta: false,
    combined_spend: null,
    future_opening_predicted: false,
    automatic_qualification: false,
    pursuit_notes_mutated: false,
  });
}

function stateLabel(state) {
  switch (state) {
    case "supported_overlap":
      return "Matches your capabilities";
    case "stated_capability_gap":
      return "Capability to arrange";
    case "document_review_needed":
      return "Check the requirements";
    case "unspecified":
      return "Tell us more";
    default:
      return "Assessment";
  }
}

// Group only equivalent training assessments within one award and state.
// Every distinct source passage remains available in the evidence disclosure.
function presentationAssessments(assessments) {
  const training = new Set(["coolroofs_training_program", "coolroofs_training_program_title", "jobseeker_training", "coolroofs_program_admin_desc"]);
  const groups = new Map();
  for (const assessment of assessments) {
    const isTraining = training.has(assessment.capability_id);
    const key = `${isTraining ? "training" : assessment.capability_id}:${assessment.state}`;
    if (!groups.has(key)) {
      const wording = isTraining ? ({
        supported_overlap: "Your job-training capability matches the training work described in this award.",
        stated_capability_gap: "This award includes job training, which you marked as unavailable.",
        unspecified: "Tell us whether you provide job training to compare this part of the work.",
      }[assessment.state] || assessment.wording) : assessment.wording;
      groups.set(key, { ...assessment, capability_id: isTraining ? "training" : assessment.capability_id, wording, citations: [] });
    }
    const citations = groups.get(key).citations;
    if (!citations.some(c => c.field === assessment.citation.field && c.passage === assessment.citation.passage && c.url === assessment.citation.url)) citations.push(assessment.citation);
  }
  return [...groups.values()];
}

function renderAssessment(assessment) {
  const citations = assessment.citations || [assessment.citation];
  const evidence = citations.map(c => `<li>“${esc(c.passage)}” <a href="${esc(c.url)}">Read award notice</a></li>`).join("\n");
  return `<li class="program-assessment" data-state="${esc(assessment.state)}" data-capability="${esc(assessment.capability_id)}">
  <p class="program-assessment-state"><strong>${esc(stateLabel(assessment.state))}</strong>${assessment.service_gap ? ` · ${esc(assessment.service_gap)}` : ""}</p>
  <p class="program-assessment-wording">${esc(assessment.wording)}</p>
  <details class="program-assessment-citation"><summary>Source evidence${citations.length > 1 ? ` · ${citations.length} passages` : ""}</summary><ul>${evidence}</ul></details>
</li>`;
}

function renderRecordCard(row) {
  const assessments = presentationAssessments(row.assessments || []).map(renderAssessment).join("\n");
  const actions = (row.preparation_actions || [])
    .map((action) => {
      if (action.href) {
        return `<li><a href="${esc(action.href)}" rel="noopener noreferrer">${esc(action.label)}</a></li>`;
      }
      return `<li><span>${esc(action.label)}</span></li>`;
    })
    .join("\n");
  return `<article class="program-record" data-notice-id="${esc(row.notice_id)}" data-source-role="${esc(row.source_role)}">
  <header>
    <p class="program-record-meta">${esc(row.award_status)} · ${esc(row.category_description || "category not published")} · published ${esc(row.published_on || "date not published")}</p>
    <h3>${esc(row.short_title)}</h3>
    <p class="program-record-pin">PIN ${esc(row.pin || "not published")}</p>
  </header>
  <ul class="program-assessments">
${assessments}
  </ul>
  <ul class="program-actions">
${actions}
  </ul>
</article>`;
}

function renderProfileForm(profile) {
  const keywords = (profile.capability_keywords || []).join(", ");
  const yn = (value, name) => {
    const yes = value === true ? "checked" : "";
    const no = value === false ? "checked" : "";
    return `<fieldset class="program-yn">
  <legend>${esc(({job_training: "Do you provide job training?", employer_placement: "Do you help people find jobs?", roof_installation_crew: "Do you have a roof-installation crew?"}[name] || "Capability"))}</legend>
  <label><input type="radio" name="${esc(name)}" value="true" ${yes}> Yes</label>
  <label><input type="radio" name="${esc(name)}" value="false" ${no}> No</label>
</fieldset>`;
  };
  return `<form class="program-profile-form" data-program-profile-form>
  <h2 id="program-history-heading">Program history comparison</h2>
  <p class="program-form-help">Answers stay in this browser session. They do not change published award facts, predict a future opening, or alter any pursuit note you already saved.</p>
  <label>Capability keywords
    <input name="capability_keywords" value="${esc(keywords)}" />
  </label>
  ${yn(profile.job_training, "job_training")}
  ${yn(profile.employer_placement, "employer_placement")}
  ${yn(profile.roof_installation_crew, "roof_installation_crew")}
  <button type="submit">Update comparison</button>
</form>`;
}

function renderSourceLinks(links = PROGRAM_HISTORY_SOURCE_LINKS) {
  const items = (links || [])
    .map(
      (link) =>
        `<li><a href="${esc(link.href)}" rel="noopener noreferrer">${esc(link.notice_id)}</a></li>`,
    )
    .join("\n");
  return `<div class="program-source-links" data-program-source-links>
  <p>You can still review the published award notices:</p>
  <ul>
${items}
  </ul>
</div>`;
}

export function renderProgramJourneyHtml(journey, { headingId = "program-history-heading" } = {}) {
  if (journey.load_error) {
    return `<section class="program-journey" data-program-journey data-open-bid-cta="false" data-load-error="true" aria-labelledby="${esc(headingId)}">
  ${renderProfileForm(journey.profile)}
  <p role="alert">Could not load the awards. Your answers are preserved.</p>
  <details><summary>Error details</summary>${esc(journey.load_error)}</details>
  <p><button type="button" data-program-retry>Retry</button></p>
  ${renderSourceLinks(journey.source_links || PROGRAM_HISTORY_SOURCE_LINKS)}
  <p><a href="/browse/contracts/">Back to Contracts Browse</a></p>
</section>`;
  }
  const cards = (journey.records || []).map(renderRecordCard).join("\n");
  const rowsById = new Map((journey.records || []).map(row => [row.notice_id, row]));
  const awardLabel = id => {
    const date = rowsById.get(id)?.published_on;
    return date ? `${date.slice(0, 4)} award` : "Award (date not published)";
  };
  const relationBits = (journey.relations || []).map(r => {
    const label = r.relation === PROGRAM_RELATION.EXACT_PREDECESSOR_LINK
      ? `${awardLabel(r.a)} and ${awardLabel(r.b)}: Connected by a renewal.`
      : r.relation === PROGRAM_RELATION.PROGRAM_RELATED
        ? `${awardLabel(r.a)} and ${awardLabel(r.b)}: Related program awards; not an established renewal link.`
        : "Relationship not established.";
    return `<li data-relation="${esc(r.relation)}">${esc(label)}</li>`;
  }).join("\n");
  return `<section class="program-journey" data-program-journey data-open-bid-cta="false" data-future-opening="false" aria-labelledby="${esc(headingId)}">
  ${renderProfileForm(journey.profile)}
  <details class="program-history-links"><summary>How these awards are connected</summary>
  <ul class="program-relations" aria-label="Program relations">
${relationBits}
  </ul></details>
  <div class="program-records">
${cards}
  </div>
  <p><a href="/browse/contracts/">Back to Contracts Browse</a></p>
</section>`;
}

export function profileFromFormValues(values = {}) {
  const parseYn = (v) => {
    if (v === true || v === "true") return true;
    if (v === false || v === "false") return false;
    return null;
  };
  const keywords = String(values.capability_keywords || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return normalizeProgramProfile({
    capability_keywords: keywords,
    job_training: parseYn(values.job_training),
    employer_placement: parseYn(values.employer_placement),
    roof_installation_crew: parseYn(values.roof_installation_crew),
  });
}

/** sessionStorage key for the program-history form across Back / remount. */
export const PROGRAM_HISTORY_PROFILE_STORAGE_KEY = "crol:program-history:profile.v1";

/** history.state field for the program-history form across Back. */
export const PROGRAM_HISTORY_HISTORY_STATE_KEY = "programHistoryProfile";

/** Query keys that must never carry program-history answers (Clarity sees the URL). */
export const PROGRAM_HISTORY_PROFILE_QUERY_KEYS = Object.freeze([
  "capability_keywords",
  "job_training",
  "employer_placement",
  "roof_installation_crew",
]);

function ternaryParam(raw) {
  if (raw === "true" || raw === true) return true;
  if (raw === "false" || raw === false) return false;
  return null;
}

/**
 * Serialize a profile for sessionStorage (JSON). Omits the display name.
 */
export function serializeProgramProfile(profile = {}) {
  return JSON.stringify({
    capability_keywords: Array.isArray(profile.capability_keywords)
      ? profile.capability_keywords.map((kw) => String(kw).trim()).filter(Boolean)
      : [],
    job_training: profile.job_training == null ? null : Boolean(profile.job_training),
    employer_placement:
      profile.employer_placement == null ? null : Boolean(profile.employer_placement),
    roof_installation_crew:
      profile.roof_installation_crew == null ? null : Boolean(profile.roof_installation_crew),
  });
}

/**
 * Parse a stored JSON profile. Returns null when the payload is missing or invalid.
 */
export function parseProgramProfile(raw) {
  if (raw == null || raw === "") return null;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== "object") return null;
    return profileFromFormValues({
      capability_keywords: Array.isArray(parsed.capability_keywords)
        ? parsed.capability_keywords.join(", ")
        : parsed.capability_keywords,
      job_training: parsed.job_training,
      employer_placement: parsed.employer_placement,
      roof_installation_crew: parsed.roof_installation_crew,
    });
  } catch {
    return null;
  }
}

export function readProgramProfileFromStorage(storage) {
  if (!storage || typeof storage.getItem !== "function") return null;
  try {
    return parseProgramProfile(storage.getItem(PROGRAM_HISTORY_PROFILE_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function writeProgramProfileToStorage(storage, profile) {
  if (!storage || typeof storage.setItem !== "function") return false;
  try {
    storage.setItem(PROGRAM_HISTORY_PROFILE_STORAGE_KEY, serializeProgramProfile(profile));
    return true;
  } catch {
    return false;
  }
}

export function searchParamsHaveProgramProfile(params) {
  if (!params || typeof params.get !== "function") return false;
  return PROGRAM_HISTORY_PROFILE_QUERY_KEYS.some((key) => params.has(key));
}

export function programProfileFromSearchParams(params) {
  if (!searchParamsHaveProgramProfile(params)) return null;
  return profileFromFormValues({
    capability_keywords: params.get("capability_keywords") ?? "",
    job_training: ternaryParam(params.get("job_training")),
    employer_placement: ternaryParam(params.get("employer_placement")),
    roof_installation_crew: ternaryParam(params.get("roof_installation_crew")),
  });
}

export function stripProgramProfileFromSearchParams(params) {
  if (!params || typeof params.delete !== "function") return params;
  for (const key of PROGRAM_HISTORY_PROFILE_QUERY_KEYS) params.delete(key);
  return params;
}

export function programProfileFromHistoryState(historyState) {
  if (!historyState || typeof historyState !== "object") return null;
  return parseProgramProfile(historyState[PROGRAM_HISTORY_HISTORY_STATE_KEY]);
}

export function applyProgramProfileToHistoryState(historyState, profile) {
  const base =
    historyState && typeof historyState === "object" && !Array.isArray(historyState)
      ? { ...historyState }
      : {};
  base[PROGRAM_HISTORY_HISTORY_STATE_KEY] = {
    capability_keywords: Array.isArray(profile?.capability_keywords)
      ? profile.capability_keywords.map((kw) => String(kw).trim()).filter(Boolean)
      : [],
    job_training: profile?.job_training == null ? null : Boolean(profile.job_training),
    employer_placement:
      profile?.employer_placement == null ? null : Boolean(profile.employer_placement),
    roof_installation_crew:
      profile?.roof_installation_crew == null ? null : Boolean(profile.roof_installation_crew),
  };
  return base;
}

/**
 * Migrate any legacy profile query params into sessionStorage + history.state,
 * then strip them from the URL via replaceState before analytics can read them.
 */
export function scrubProgramProfileFromLocation({
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
  if (!searchParamsHaveProgramProfile(url.searchParams)) return false;
  const migrated = programProfileFromSearchParams(url.searchParams);
  if (migrated) writeProgramProfileToStorage(storage, migrated);
  stripProgramProfileFromSearchParams(url.searchParams);
  const nextState = applyProgramProfileToHistoryState(
    hist.state,
    migrated || readProgramProfileFromStorage(storage) || DEFAULT_TRAINING_PROFILE,
  );
  hist.replaceState(nextState, "", `${url.pathname}${url.search}${url.hash}`);
  return true;
}

/**
 * Resolve the initial profile: history.state, then sessionStorage, then the default.
 */
export function resolveInitialProgramProfile({
  historyState = null,
  storage = null,
  fallback = DEFAULT_TRAINING_PROFILE,
} = {}) {
  const fromHistory = programProfileFromHistoryState(historyState);
  if (fromHistory) return fromHistory;
  const fromStorage = readProgramProfileFromStorage(storage);
  if (fromStorage) return fromStorage;
  return {
    ...fallback,
    capability_keywords: [...(fallback.capability_keywords || [])],
  };
}

/**
 * Persist profile to sessionStorage + history.state. Never writes answers into the URL.
 */
export function persistProgramProfilePrivately({
  profile,
  storage = null,
  location: loc = globalThis.location,
  history: hist = globalThis.history,
  ensureBeta = true,
} = {}) {
  writeProgramProfileToStorage(storage, profile);
  if (!loc || !hist || typeof hist.replaceState !== "function") {
    return { href: loc?.href ?? null, state: hist?.state ?? null };
  }
  let url;
  try {
    url = new URL(loc.href);
  } catch {
    return { href: loc.href, state: hist.state };
  }
  stripProgramProfileFromSearchParams(url.searchParams);
  if (ensureBeta && !url.searchParams.get("beta")) {
    url.searchParams.set("beta", PROGRAM_HISTORY_BETA_SLUG);
  }
  const nextState = applyProgramProfileToHistoryState(hist.state, profile);
  const nextUrl = `${url.pathname}${url.search}${url.hash}`;
  hist.replaceState(nextState, "", nextUrl);
  return { href: nextUrl, state: nextState };
}

export function journeyHtmlOmitsOpenBidCta(html) {
  const s = String(html || "").toLowerCase();
  if (s.includes("open bid") || s.includes("submit a bid") || s.includes("bid now")) {
    return false;
  }
  return true;
}

export { relationBetween, PROGRAM_RELATION };
