/**
 * Source-backed rulemaking exception assertions.
 *
 * Emergency findings, immediate effectiveness, expiration, qualifying
 * extension, explicit unanticipated-in-agenda statements, hearing-waived
 * statements, and public-purpose findings attach to a rulemaking. They never
 * become ordinary lifecycle phases or event types. Absence is not
 * unanticipated, unknown is not expired, and a missing extension is not
 * proof of expiration.
 */

import {
  RULE_EVENT_TYPES,
  RULES_PHASES,
} from "./rules_phase_spine.mjs";

export const RULES_EXCEPTION_MODES_SCHEMA = "cityscroll.rules_exception_modes.v1";
export const RULES_EXCEPTION_ASSERTION_SCHEMA = "cityscroll.rules_exception_assertion.v1";
export const RULES_EXCEPTION_MODES_RECEIPT_SCHEMA = "cityscroll.rules_exception_modes_receipt.v1";
export const RULES_EXCEPTION_EXTRACTION_METHOD = "rules_exception_modes_v1";
export const RULES_EXCEPTION_EXTRACTION_VERSION = "v1";

export const EXCEPTION_MODE_IDS = Object.freeze([
  "emergency_finding",
  "emergency_effective_date",
  "emergency_expiration",
  "emergency_extension",
  "unanticipated_in_agenda",
  "hearing_waived",
  "public_purpose",
]);

export const PROCEDURE_MODES = Object.freeze(["standard", "emergency"]);

export const ASSERTION_STATES = Object.freeze([
  "established",
  "conflict",
  "unknown",
  "unsupported",
  "absent",
]);

const MODE_LABELS = Object.freeze({
  emergency_finding: "Emergency finding",
  emergency_effective_date: "Takes effect",
  emergency_expiration: "Temporary authority ends",
  emergency_extension: "Qualifying extension",
  unanticipated_in_agenda: "Not anticipated in the regulatory agenda",
  hearing_waived: "Hearing waived",
  public_purpose: "Public-purpose finding",
});

const MONTHS = Object.freeze({
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
  july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
});

const clean = (value, max = 50_000) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

function officialUrl(value) {
  const href = clean(value, 2_000);
  if (!/^https:\/\//i.test(href)) return null;
  try {
    const parsed = new URL(href);
    const host = parsed.hostname.toLowerCase();
    return host === "rules.cityofnewyork.us"
      || host === "a856-cityrecord.nyc.gov"
      || host.endsWith(".cityofnewyork.us")
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

function isoDay(value) {
  const match = clean(value, 80).match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] || null;
}

function padDay(value) {
  return String(value).padStart(2, "0");
}

function parseCalendarDate(text) {
  const source = String(text || "");
  const iso = source.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (iso) return { value: iso[1], precision: "day", raw: iso[1] };
  const long = source.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:,)?\s+(20\d{2})\b/i,
  );
  if (long) {
    const value = `${long[3]}-${MONTHS[long[1].toLowerCase()]}-${padDay(long[2])}`;
    return { value, precision: "day", raw: long[0] };
  }
  return null;
}

function sourceVintage(document) {
  const explicit = clean(document.source_vintage || document.vintage, 20);
  if (/^\d{4}-\d{2}(?:-\d{2})?$/.test(explicit)) return explicit.slice(0, 7);
  const published = isoDay(document.published_at || document.notice_date);
  return published ? published.slice(0, 7) : null;
}

function sourceSpan(text, start, end, field) {
  const boundsStart = Math.max(0, start);
  const boundsEnd = Math.min(String(text || "").length, end);
  const value = clean(String(text || "").slice(boundsStart, boundsEnd), 1_200);
  return value ? { field, start: boundsStart, end: boundsEnd, text: value } : null;
}

function capture(text, regex) {
  const match = String(text || "").match(regex);
  if (!match || match.index == null) return null;
  const end = match.index + match[0].length;
  return {
    match: match[0],
    index: match.index,
    end,
    span: sourceSpan(text, match.index, end, "document_text"),
  };
}

function windowAround(text, index, radius = 180) {
  const start = Math.max(0, index - radius);
  const end = Math.min(String(text || "").length, index + radius);
  return String(text || "").slice(start, end);
}

function normalizeDocument(document, rulemakingId) {
  const text = clean(document?.text || document?.body || document?.document_text, 50_000);
  const title = clean(document?.title || document?.source_label, 400);
  const sourceId = clean(
    document?.source_id || document?.document_id || document?.id || document?.request_id,
    300,
  ) || null;
  const url = officialUrl(document?.source_url || document?.url);
  return {
    rulemaking_id: clean(document?.rulemaking_id || rulemakingId, 700) || null,
    source_id: sourceId,
    source_system: clean(document?.source_system, 80) || (url?.includes("cityrecord") ? "city_record" : "nyc_rules"),
    source_url: url,
    source_label: clean(document?.source_label || title, 400) || null,
    source_field: clean(document?.source_field, 80) || (text ? "document_text" : null),
    source_vintage: sourceVintage(document),
    request_id: clean(document?.request_id, 80) || null,
    document_id: clean(document?.document_id || sourceId, 300) || null,
    published_at: isoDay(document?.published_at || document?.notice_date),
    title,
    text,
    version_kind: clean(document?.version_kind || document?.kind, 40).toLowerCase() || null,
  };
}

function haystack(document) {
  return `${document.title} ${document.text}`.trim();
}

function emergencyTitleHint(document) {
  return /\bemergency\s+rule\b/i.test(document.title || "")
    || document.version_kind === "emergency";
}

function extractFinding(document) {
  const text = haystack(document);
  return capture(text, /\b(?:emergency\s+finding|finds?\s+that\s+(?:an?\s+)?(?:imminent|immediate)\s+(?:threat|peril|danger|harm)\b[^.!?]{0,240}|finds?\s+that\s+immediate(?:\s+adoption|\s+effectiveness)?\s+is\s+(?:necessary|required)|imminent\s+(?:threat|peril|danger)\s+(?:to|of)[^.!?]{0,200})\b/i)
    || capture(text, /\bthis\s+emergency\s+rule\b[^.!?]{0,200}\b(?:finds?|finding|imminent)\b/i)
    || capture(text, /\bemergency\s+rule\b[^.!?]{0,240}\b(?:imminent|immediate)\s+(?:threat|peril|danger|harm|adoption|effectiveness)\b/i);
}

function extractEffective(document) {
  const text = haystack(document);
  const immediate = capture(text, /\b(?:shall\s+)?(?:be\s+)?(?:effective|take[s]?\s+effect)\s+(?:immediately|upon\s+(?:filing|publication)|on\s+filing)\b(?:\s+(?:on|as\s+of)\s+[^.!?]{0,40})?/i)
    || capture(text, /\bimmediate(?:ly)?\s+effective\b(?:\s+(?:on|as\s+of)\s+[^.!?]{0,40})?/i);
  if (!immediate) return null;
  const nearby = windowAround(text, immediate.index);
  const date = parseCalendarDate(nearby);
  const uponFiling = /upon\s+filing|on\s+filing/i.test(immediate.match);
  const uponPublication = /upon\s+publication/i.test(immediate.match);
  return {
    ...immediate,
    date: date
      ? { ...date, qualifier: "immediately" }
      : {
        value: null,
        precision: uponFiling ? "upon_filing" : uponPublication ? "upon_publication" : "immediate",
        qualifier: uponFiling ? "upon_filing" : uponPublication ? "upon_publication" : "immediately",
        raw: immediate.match,
      },
  };
}

function extractExpiration(document) {
  const text = haystack(document);
  const hit = capture(text, /\b(?:shall\s+)?expir(?:e|es|ation|ing)\b[^.!?]{0,160}/i)
    || capture(text, /\b(?:temporary\s+authority|emergency\s+(?:period|authority))\s+(?:ends?|expires?)\b[^.!?]{0,160}/i)
    || capture(text, /\b(?:for\s+)?(?:60|sixty)\s+days\b[^.!?]{0,80}\b(?:unless|after\s+(?:filing|adoption|the\s+effective\s+date))\b/i);
  if (!hit) return null;
  const date = parseCalendarDate(hit.match);
  const duration = /\b(?:60|sixty)\s+days\b/i.test(hit.match);
  return {
    ...hit,
    date: date || (duration
      ? { value: null, precision: "duration", qualifier: "60_days", raw: hit.match }
      : { value: null, precision: "unknown", qualifier: null, raw: hit.match }),
  };
}

function extractExtension(document) {
  const text = haystack(document);
  const hit = capture(text, /\b(?:is|was|has been|hereby)\s+extended\b[^.!?]{0,180}/i)
    || capture(text, /\bextend(?:s|ed|ing)\b[^.!?]{0,120}\b(?:60|sixty)\s+days\b/i)
    || capture(text, /\badditional\s+(?:60|sixty)\s+days\b[^.!?]{0,120}/i)
    || capture(text, /\bcontinue[sd]\s+(?:this\s+)?emergency(?:\s+rule)?\b[^.!?]{0,120}/i)
    || capture(text, /\bqualifying\s+(?:extension|continuation)\s+(?:is|was|has been|granted|approved)\b[^.!?]{0,120}/i);
  if (!hit) return null;
  const date = parseCalendarDate(hit.match);
  return {
    ...hit,
    date: date || {
      value: null,
      precision: /\b(?:60|sixty)\s+days\b/i.test(hit.match) ? "duration" : "unknown",
      qualifier: /\b(?:60|sixty)\s+days\b/i.test(hit.match) ? "additional_60_days" : null,
      raw: hit.match,
    },
  };
}

function extractUnanticipated(document) {
  const text = haystack(document);
  return capture(text, /\b(?:was\s+|were\s+|is\s+)?not\s+anticipated\s+in\s+(?:the\s+)?(?:agency'?s\s+)?(?:regulatory\s+)?agenda\b/i)
    || capture(text, /\bunanticipated\s+in\s+(?:the\s+)?(?:regulatory\s+)?agenda\b/i)
    || capture(text, /\bnot\s+included\s+in\s+(?:the\s+)?(?:agency'?s\s+)?regulatory\s+agenda\b/i);
}

function extractHearingWaived(document) {
  const text = haystack(document);
  return capture(text, /\b(?:the\s+)?(?:public\s+)?hearing\s+(?:is\s+|was\s+|has\s+been\s+)?waived\b/i)
    || capture(text, /\bwaiv(?:e|es|ed|ing)\s+(?:the\s+)?(?:requirement\s+for\s+(?:a\s+)?)?(?:public\s+)?hearing\b/i);
}

function extractPublicPurpose(document) {
  const text = haystack(document);
  return capture(text, /\b(?:would\s+)?serve\s+no\s+public\s+purpose\b/i)
    || capture(text, /\bno\s+public\s+purpose\s+(?:would\s+be\s+)?served\b/i)
    || capture(text, /\bpublic\s+purpose\s+finding\b/i)
    || capture(text, /\bfinds?\s+that\s+(?:a\s+)?(?:public\s+)?hearing\s+would\s+serve\s+no\s+public\s+purpose\b/i);
}

const EXTRACTORS = Object.freeze({
  emergency_finding: extractFinding,
  emergency_effective_date: extractEffective,
  emergency_expiration: extractExpiration,
  emergency_extension: extractExtension,
  unanticipated_in_agenda: extractUnanticipated,
  hearing_waived: extractHearingWaived,
  public_purpose: extractPublicPurpose,
});

function sourceRecord(document, hit) {
  const span = hit?.span || null;
  const field = span?.field || document.source_field || (document.text ? "document_text" : "title");
  return {
    system: document.source_system,
    record_id: document.request_id || document.source_id,
    document_id: document.document_id,
    url: document.source_url,
    label: document.source_label,
    vintage: document.source_vintage,
    field,
    passage: span?.text || null,
    span,
  };
}

function datePayload(hit) {
  if (!hit?.date) return { value: null, precision: "none", qualifier: null, raw: null };
  return {
    value: hit.date.value || null,
    precision: hit.date.precision || "unknown",
    qualifier: hit.date.qualifier || null,
    raw: hit.date.raw || hit.match || null,
  };
}

function candidateHits(documents, mode) {
  const extractor = EXTRACTORS[mode];
  return documents.map((document) => {
    const hit = extractor(document);
    if (!hit) return null;
    return { document, hit, source: sourceRecord(document, hit), date: datePayload(hit) };
  }).filter(Boolean);
}

function uniqueDays(hits) {
  return [...new Set(hits.map((item) => item.date?.value).filter(Boolean))].sort();
}

function assertion({
  mode,
  state,
  rulemakingId,
  hits = [],
  reason = null,
}) {
  const primary = hits[0] || null;
  const dates = uniqueDays(hits);
  const conflict = state === "conflict";
  return Object.freeze({
    schema: RULES_EXCEPTION_ASSERTION_SCHEMA,
    mode,
    state,
    label: MODE_LABELS[mode],
    rulemaking_id: rulemakingId,
    reason,
    source: primary?.source || null,
    sources: hits.map((item) => item.source),
    date: conflict
      ? { value: null, precision: "conflict", qualifier: null, raw: dates.join("|"), values: dates }
      : primary?.date || { value: null, precision: "none", qualifier: null, raw: null },
    extraction: {
      method: RULES_EXCEPTION_EXTRACTION_METHOD,
      version: RULES_EXCEPTION_EXTRACTION_VERSION,
    },
  });
}

function modeAssertion(mode, documents, rulemakingId, { emergencyEstablished = false } = {}) {
  const hits = candidateHits(documents, mode);
  if (mode === "emergency_finding") {
    if (hits.length) {
      return assertion({ mode, state: "established", rulemakingId, hits });
    }
    const weak = documents.filter((document) => emergencyTitleHint(document) || /\bemergency\s+basis\b/i.test(haystack(document)));
    if (weak.length) {
      return assertion({
        mode,
        state: "unsupported",
        rulemakingId,
        hits: weak.map((document) => ({
          document,
          source: sourceRecord(document, { span: sourceSpan(document.title || "", 0, (document.title || "").length, "title") }),
          date: { value: null, precision: "none", qualifier: null, raw: null },
        })),
        reason: "emergency label or hypothetical wording lacks an exact published finding passage",
      });
    }
    return assertion({ mode, state: "absent", rulemakingId, reason: "no emergency finding passage" });
  }

  if (mode === "emergency_effective_date" || mode === "emergency_expiration" || mode === "emergency_extension") {
    if (hits.length) {
      const days = uniqueDays(hits);
      if (days.length > 1) {
        return assertion({ mode, state: "conflict", rulemakingId, hits, reason: "retained sources state more than one calendar date" });
      }
      const exact = hits.filter((item) => item.source?.passage);
      if (!exact.length) {
        return assertion({
          mode,
          state: "unsupported",
          rulemakingId,
          hits,
          reason: "candidate lacks an exact source passage",
        });
      }
      return assertion({ mode, state: "established", rulemakingId, hits: exact });
    }
    if (emergencyEstablished) {
      return assertion({
        mode,
        state: "unknown",
        rulemakingId,
        reason: mode === "emergency_expiration"
          ? "unknown_is_not_expired"
          : mode === "emergency_extension"
            ? "missing_extension_is_not_expiration"
            : "immediate_effectiveness_not_stated",
      });
    }
    return assertion({ mode, state: "absent", rulemakingId, reason: `no ${mode} passage` });
  }

  if (mode === "unanticipated_in_agenda") {
    if (hits.length) return assertion({ mode, state: "established", rulemakingId, hits });
    return assertion({
      mode,
      state: "absent",
      rulemakingId,
      reason: "absent_is_not_unanticipated",
    });
  }

  if (hits.length) return assertion({ mode, state: "established", rulemakingId, hits });
  return assertion({ mode, state: "absent", rulemakingId, reason: `no ${mode} passage` });
}

function ordinaryEvents(events) {
  return (Array.isArray(events) ? events : [])
    .filter((event) => RULE_EVENT_TYPES.includes(event?.event_type))
    .map((event) => Object.freeze({ ...event }));
}

function coverageFromAssertions(assertions, { ordinarySpine = false } = {}) {
  const byMode = Object.fromEntries(EXCEPTION_MODE_IDS.map((mode) => [mode, {
    established: 0,
    conflict: 0,
    unknown: 0,
    unsupported: 0,
    absent: 0,
    exact_passage: 0,
    date_supported: 0,
    date_precision: {
      day: 0,
      immediate: 0,
      upon_filing: 0,
      upon_publication: 0,
      duration: 0,
      conflict: 0,
      unknown: 0,
      none: 0,
    },
    source_vintage_present: 0,
    source_vintage_unknown: 0,
    unresolved_or_conflicting: 0,
  }]));
  for (const item of assertions) {
    const row = byMode[item.mode];
    if (!row) continue;
    row[item.state] += 1;
    if (item.source?.passage) row.exact_passage += 1;
    const precision = item.date?.precision || "none";
    if (Object.hasOwn(row.date_precision, precision)) row.date_precision[precision] += 1;
    if (item.date?.value || item.date?.precision === "immediate" || item.date?.precision === "upon_filing" || item.date?.precision === "duration") {
      row.date_supported += 1;
    }
    if (item.source?.vintage) row.source_vintage_present += 1;
    else if (item.state !== "absent") row.source_vintage_unknown += 1;
    if (item.state === "conflict" || item.state === "unknown" || item.state === "unsupported") {
      row.unresolved_or_conflicting += 1;
    }
  }
  const finding = assertions.find((item) => item.mode === "emergency_finding");
  return {
    per_mode: byMode,
    procedure_projection: {
      ordinary_spine: ordinarySpine ? 1 : 0,
      emergency_branches: finding?.state === "established" || finding?.state === "conflict" ? 1 : 0,
      unsupported_exception_candidates: assertions.filter((item) => item.state === "unsupported").length,
    },
  };
}

export function buildRulesExceptionModesProjection(input = {}) {
  const rulemakingId = clean(input.rulemaking_id, 700) || null;
  const documents = (Array.isArray(input.documents) ? input.documents : [])
    .map((document) => normalizeDocument(document, rulemakingId))
    .filter((document) => document.rulemaking_id && (document.text || document.title));
  const events = ordinaryEvents(input.events);
  const finding = modeAssertion("emergency_finding", documents, rulemakingId);
  const emergencyEstablished = finding.state === "established" || finding.state === "conflict";
  const assertions = EXCEPTION_MODE_IDS.map((mode) => (
    mode === "emergency_finding"
      ? finding
      : modeAssertion(mode, documents, rulemakingId, { emergencyEstablished })
  ));
  const procedureMode = emergencyEstablished ? "emergency" : "standard";
  const established = assertions.filter((item) => item.state === "established" || item.state === "conflict");
  const coverage = coverageFromAssertions(assertions, { ordinarySpine: events.length > 0 || procedureMode === "standard" });
  return Object.freeze({
    schema: RULES_EXCEPTION_MODES_SCHEMA,
    rulemaking_id: rulemakingId,
    procedure_mode: procedureMode,
    ordinary_phases: [...RULES_PHASES],
    ordinary_event_types: [...RULE_EVENT_TYPES],
    ordinary_events: events,
    fabricated_phases: [],
    fabricated_events: [],
    assertions,
    established_assertions: established,
    coverage,
    extraction: {
      method: RULES_EXCEPTION_EXTRACTION_METHOD,
      version: RULES_EXCEPTION_EXTRACTION_VERSION,
    },
    invariants: Object.freeze({
      unknown_is_not_expired: true,
      absent_is_not_unanticipated: true,
      missing_extension_is_not_expiration: true,
      exception_is_not_lifecycle_stage: true,
    }),
  });
}

export function measureExceptionModeCoverage(cases = []) {
  const projections = cases.map((item) => buildRulesExceptionModesProjection(item));
  const empty = coverageFromAssertions([]);
  const perMode = empty.per_mode;
  const procedure = {
    ordinary_spine: 0,
    emergency_branches: 0,
    unsupported_exception_candidates: 0,
  };
  for (const projection of projections) {
    for (const mode of EXCEPTION_MODE_IDS) {
      const src = projection.coverage.per_mode[mode];
      const dest = perMode[mode];
      for (const key of ["established", "conflict", "unknown", "unsupported", "absent", "exact_passage", "date_supported", "source_vintage_present", "source_vintage_unknown", "unresolved_or_conflicting"]) {
        dest[key] += src[key];
      }
      for (const precision of Object.keys(dest.date_precision)) {
        dest.date_precision[precision] += src.date_precision[precision];
      }
    }
    procedure.ordinary_spine += projection.coverage.procedure_projection.ordinary_spine;
    procedure.emergency_branches += projection.coverage.procedure_projection.emergency_branches;
    procedure.unsupported_exception_candidates += projection.coverage.procedure_projection.unsupported_exception_candidates;
  }
  return {
    schema: RULES_EXCEPTION_MODES_RECEIPT_SCHEMA,
    generated_at: "2026-08-31T00:00:00Z",
    extraction: {
      method: RULES_EXCEPTION_EXTRACTION_METHOD,
      version: RULES_EXCEPTION_EXTRACTION_VERSION,
    },
    case_count: cases.length,
    per_mode: perMode,
    procedure_projection: procedure,
    date_evidence: {
      unknown_is_not_expired: true,
      absent_is_not_unanticipated: true,
      missing_extension_is_not_expiration: true,
      exception_is_not_lifecycle_stage: true,
    },
    blended_exception_rate: null,
  };
}

function sourceLink(source) {
  if (!source?.url) return source?.label ? esc(source.label) : "Retained source";
  const label = source.label || "Open source document";
  return `<a class="ui-official-source-link" href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">${esc(label)}<span aria-hidden="true">↗</span></a>`;
}

function prettyDate(value) {
  const day = isoDay(value);
  if (!day) return null;
  const parsed = new Date(`${day}T12:00:00Z`);
  return Number.isNaN(parsed.getTime())
    ? day
    : parsed.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function dateCopy(assertion) {
  const date = assertion.date || {};
  if (assertion.state === "conflict") {
    const labels = (date.values || []).map(prettyDate).filter(Boolean);
    return labels.length
      ? `Retained sources state more than one date (${labels.join("; ")}).`
      : "Retained sources state more than one date.";
  }
  if (assertion.state === "unknown") {
    if (assertion.mode === "emergency_expiration") return "The retained source does not state when this emergency authority ends.";
    if (assertion.mode === "emergency_extension") return "No qualifying extension is stated in the retained source.";
    if (assertion.mode === "emergency_effective_date") return "The retained source does not state when this emergency rule takes effect.";
    return "The retained source does not state this date.";
  }
  if (date.precision === "immediate" || date.qualifier === "immediately") {
    return date.value ? `Effective immediately: ${prettyDate(date.value)}` : "Effective immediately";
  }
  if (date.precision === "upon_filing") return "Effective upon filing";
  if (date.precision === "upon_publication") return "Effective upon publication";
  if (date.precision === "duration" && date.qualifier === "60_days") {
    return "Stated as a 60-day period; no calendar expiration date is retained.";
  }
  if (date.precision === "duration" && date.qualifier === "additional_60_days") {
    return "Stated as an additional 60-day continuation; no calendar end date is retained.";
  }
  if (date.value) return prettyDate(date.value);
  return null;
}

function assertionMarkup(assertion) {
  if (assertion.state === "absent" || assertion.state === "unsupported") return "";
  const date = dateCopy(assertion);
  const passage = assertion.source?.passage
    ? `<blockquote class="rule-exception-passage">${esc(assertion.source.passage)}</blockquote>`
    : "";
  const vintage = assertion.source?.vintage
    ? `<span class="muted">Source vintage ${esc(assertion.source.vintage)}</span>`
    : "";
  return `<article class="rule-exception-assertion" data-exception-mode="${esc(assertion.mode)}" data-exception-state="${esc(assertion.state)}" data-date-precision="${esc(assertion.date?.precision || "none")}">
    <h3>${esc(assertion.label)}</h3>
    ${date ? `<p class="rule-exception-date">${esc(date)}</p>` : ""}
    ${passage}
    <p class="rule-exception-source">${sourceLink(assertion.source)}${vintage ? ` · ${vintage}` : ""}</p>
  </article>`;
}

function ordinaryBranchMarkup(projection) {
  const events = projection.ordinary_events || [];
  if (!events.length) return "";
  const items = events.map((event) => {
    const when = prettyDate(event.valid_at || event.published_at) || "Date not stated";
    const label = {
      proposal_published: "Proposal published",
      public_hearing: "Public hearing",
      comment_close: "Comments close",
      adoption: "Adoption",
      effective: "Ordinary effective date",
    }[event.event_type] || "Rulemaking event";
    return `<li data-ordinary-event-type="${esc(event.event_type)}">${esc(label)} · ${esc(when)}</li>`;
  }).join("");
  return `<div class="rule-exception-ordinary" data-ordinary-branch="1">
    <h3>Ordinary rulemaking</h3>
    <p>The ordinary proposal, public process, adoption, and effective events remain on the existing lifecycle. This exception does not add another stage.</p>
    <ul>${items}</ul>
  </div>`;
}

export function renderRulesExceptionModes(projection) {
  if (!projection || projection.schema !== RULES_EXCEPTION_MODES_SCHEMA) return "";
  const visible = (projection.assertions || []).map(assertionMarkup).filter(Boolean);
  if (!visible.length) return "";
  const heading = projection.procedure_mode === "emergency"
    ? "Emergency procedure"
    : "Exception procedure";
  return `<div class="rule-exception-modes" data-procedure-mode="${esc(projection.procedure_mode)}" data-exception-count="${visible.length}">
    <h2>${esc(heading)}</h2>
    <p class="rule-exception-lede">These facts are attached to the case file. They are not extra dots on the ordinary Rules lifecycle.</p>
    ${visible.join("")}
    ${ordinaryBranchMarkup(projection)}
  </div>`;
}

export { MODE_LABELS };
