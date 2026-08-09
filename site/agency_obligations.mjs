/**
 * Agency statutory mandates (first iteration).
 *
 * Materializes enacted-law duties as an agency-scoped read model:
 * agency → duty → deadline → recurrence. Certification is automatic
 * (quote-verify + schema); there is no public human-review gate.
 * Product surfaces state duty/deadline facts; machine observation fields
 * stay out of reader-facing copy.
 *
 * Seams for later workstreams:
 * - Evidence-Bearing Civic Graph: agency_match method / confidence
 * - Process Conformance: expected-vs-observed lives in site/process_conformance.mjs
 *   (lookup site/data/process_conformance_lookup.json). Row-level observation
 *   here stays a neutral placeholder; the public mandates surface owns labels.
 */

import { resolveAgencyIdentity } from "./agency_identity.mjs";
import { followingUrlFromWatch } from "./following_view.mjs";
import { officialSourceLink } from "./affordance_grammar.mjs";

export const AGENCY_OBLIGATIONS_SCHEMA = "cityscroll.agency_obligations.v1";
export const AGENCY_OBLIGATIONS_METHOD = "enacted_law_mandate_extract_v1";
export const AGENCY_OBLIGATIONS_CERTIFICATION = "auto_certified_quote_verify_v1";
export const AGENCY_OBLIGATIONS_ER_BASIS = "agency_canonical_v1+statute_actor_alias_v1";
export const AGENCY_OBLIGATIONS_TEMPORAL_ANCHOR_METHOD = "law_envelope_strict_iso_v1";

/** Light statute-actor aliases that are not already City Record spellings. */
export const STATUTE_ACTOR_ALIASES = Object.freeze({
  HPD: "Housing Preservation and Development",
  DPR: "Parks and Recreation",
  DOT: "Transportation",
  DEP: "Environmental Protection",
  DOB: "Buildings",
  DOHMH: "Health and Mental Hygiene",
  DOH: "Health and Mental Hygiene",
  DOE: "Education",
  DOC: "Correction",
  DOF: "Finance",
  DOS: "Sanitation",
  DSS: "Human Resources Administration",
  HRA: "Human Resources Administration",
  NYPD: "Police Department",
  FDNY: "Fire Department",
  TLC: "Taxi and Limousine Commission",
  SBS: "Small Business Services",
  DCWP: "Consumer and Worker Protection",
  DCA: "Consumer and Worker Protection",
  ACS: "Administration for Children's Services",
  DFTA: "Aging",
  DYCD: "Youth and Community Development",
  "H+H": "NYC Health and Hospitals Corporation",
  HHC: "NYC Health and Hospitals Corporation",
  OTI: "Information Technology and Telecommunications",
  DoITT: "Information Technology and Telecommunications",
  LPC: "Landmarks Preservation Commission",
  LPCS: "Landmarks Preservation Commission",
  CFB: "Campaign Finance Board",
  BOE: "Board of Elections",
  BOC: "Board of Correction",
  CCRB: "Civilian Complaint Review Board",
  CORE: "Commission on Racial Equity",
  CCHR: "Commission on Human Rights",
  MOCS: "Mayor's Office of Contract Services",
  OMB: "Management and Budget",
  "THE MAYOR": "Office of the Mayor",
  MAYOR: "Office of the Mayor",
  NYCHA: "Housing Authority",
  "NEW YORK CITY HOUSING AUTHORITY": "Housing Authority",
  "HOUSING AUTHORITY": "Housing Authority",
  "DEPARTMENT OF SOCIAL SERVICES": "Human Resources Administration",
  "SOCIAL SERVICES": "Human Resources Administration",
  "FIRE DEPARTMENT OF THE CITY OF NEW YORK": "Fire Department",
  "BOARD OF STANDARDS AND APPEALS": "Board of Standards and Appeals",
  "CONFLICTS OF INTEREST BOARD": "Conflicts of Interest Board",
  "CORPORATION COUNSEL": "Law Department",
  "LAW DEPARTMENT": "Law Department",
  "THE COMMISSIONER": null, // unresolved title alone
  COMMISSIONER: null,
  "THE DEPARTMENT": null,
  DEPARTMENT: null,
  "EACH AGENCY": null,
  "CITY OF NEW YORK": null,
});

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

const esc = (value) => String(value ?? "").replace(/[<>&"']/g, (char) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
}[char]));

function validDate(value) {
  const date = clean(value, 20);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date ? null : date;
}

/**
 * Resolve a statute actor string to a CityScroll agency identity.
 * Prefer exact City Record groups; fall back to acronym table and soft strips.
 */
export function resolveStatuteActorAgency(rawAgency) {
  const raw = clean(rawAgency, 200);
  if (!raw) {
    return {
      agency_id: null,
      agency_name: null,
      agency_raw: raw || null,
      matched: false,
      method: "empty",
      confidence: null,
    };
  }

  const key = raw.toUpperCase().replace(/[./]/g, " ").replace(/\s+/g, " ").trim();
  if (Object.prototype.hasOwnProperty.call(STATUTE_ACTOR_ALIASES, key)) {
    const alias = STATUTE_ACTOR_ALIASES[key];
    if (!alias) {
      return {
        agency_id: null,
        agency_name: null,
        agency_raw: raw,
        matched: false,
        method: "unspecified_actor",
        confidence: null,
      };
    }
    const identity = resolveAgencyIdentity(alias);
    return {
      agency_id: identity.matched ? identity.canonical_id : null,
      agency_name: identity.matched ? identity.canonical_name : alias,
      agency_raw: raw,
      matched: !!identity.matched,
      method: "statute_actor_alias_v1",
      confidence: identity.matched ? "strong" : "tentative",
    };
  }

  const identity = resolveAgencyIdentity(raw);
  if (identity.matched) {
    return {
      agency_id: identity.canonical_id,
      agency_name: identity.canonical_name,
      agency_raw: raw,
      matched: true,
      method: "agency_canonical_v1",
      confidence: "strong",
    };
  }

  // Soft strip common statute prefixes and dual-name separators.
  const candidates = [
    raw,
    raw.replace(/^(?:the\s+)?(?:New York City|NYC)\s+/i, ""),
    raw.replace(/\s+of the City of New York$/i, ""),
    raw.replace(/^Commissioner of (?:the )?(?:New York City )?/i, "Department of "),
    raw.replace(/^Mayor'?s Office of /i, "Mayor's Office of "),
    raw.replace(/\/.*$/, ""), // "DSS/HRA" dual labels → first segment
    raw.replace(/^.*\//, ""), // dual labels → second segment
  ];
  for (const candidate of candidates) {
    if (!candidate || candidate === raw && candidate === candidates[0]) {
      // already tried exact path above when candidate === raw on first loop after identity miss
    }
    const again = resolveAgencyIdentity(candidate);
    if (again.matched) {
      return {
        agency_id: again.canonical_id,
        agency_name: again.canonical_name,
        agency_raw: raw,
        matched: true,
        method: candidate === raw ? "agency_canonical_v1" : "statute_actor_soft_strip_v1",
        confidence: candidate === raw ? "strong" : "tentative",
      };
    }
    const aliasKey = candidate.toUpperCase().replace(/[./]/g, " ").replace(/\s+/g, " ").trim();
    if (Object.prototype.hasOwnProperty.call(STATUTE_ACTOR_ALIASES, aliasKey) && STATUTE_ACTOR_ALIASES[aliasKey]) {
      const aliasIdentity = resolveAgencyIdentity(STATUTE_ACTOR_ALIASES[aliasKey]);
      if (aliasIdentity.matched) {
        return {
          agency_id: aliasIdentity.canonical_id,
          agency_name: aliasIdentity.canonical_name,
          agency_raw: raw,
          matched: true,
          method: "statute_actor_alias_v1",
          confidence: "tentative",
        };
      }
    }
  }

  return {
    agency_id: null,
    agency_name: null,
    agency_raw: raw,
    matched: false,
    method: "unresolved",
    confidence: null,
  };
}

/**
 * Public source-law URL for an enacted-law matter id from the mandate backfill.
 *
 * These ids are Gateway Matter keys, not LegislationDetail row ids. A bare
 * `LegislationDetail.aspx?ID=<matterId>&G=S` returns "Invalid parameters!".
 * Match meeting outcomes: `Gateway.aspx?M=L&ID=` resolves to the live detail
 * page (correct row id + GUID). See `matterDetailUrl` in worker/src/lib/legistar_join.mjs.
 *
 * When a real LegislationDetail row id + MatterGuid pair is known, that form is
 * preferred; never invent a GUID, and never treat matter_id alone as a detail id.
 */
export function legistarMatterUrl(matterId, { matterGuid = null, detailId = null } = {}) {
  const id = clean(matterId, 40);
  if (!id || !/^\d+$/.test(id)) return null;
  const guid = clean(matterGuid, 80);
  const detail = clean(detailId, 40);
  if (guid && detail && /^\d+$/.test(detail) && /^[0-9a-fA-F-]{30,}$/.test(guid)) {
    return `https://nyc.legistar.com/LegislationDetail.aspx?ID=${encodeURIComponent(detail)}&GUID=${encodeURIComponent(guid)}`;
  }
  return `https://nyc.legistar.com/Gateway.aspx?M=L&ID=${encodeURIComponent(id)}`;
}

function normalizeDeadline(raw = {}) {
  const kind = clean(raw.kind || raw.deadline_kind || "none", 40) || "none";
  const computed = validDate(raw.computed_date || raw.deadline_date || raw.fixed_date);
  const text = clean(raw.text || raw.deadline_text, 240) || null;
  return {
    kind,
    computed_date: computed,
    text,
    // Public honesty: a date is a statutory timed event, never a compliance flag.
    is_compliance_verdict: false,
  };
}

function certificationForRow(row) {
  const quoteVerified = row.quote_verified === true;
  return {
    status: quoteVerified ? "auto_certified" : "auto_candidate",
    basis: AGENCY_OBLIGATIONS_CERTIFICATION,
    quote_verified: quoteVerified,
    // Extraction confidence only — not a human clerk verdict and not compliance.
    note: quoteVerified
      ? "Auto-certified: contiguous statute quote verified against fetched law text."
      : "Auto-candidate: extracted duty retained; quote not mechanically verified in source text.",
  };
}

/**
 * Normalize one backfill mandate into the public obligation row.
 * @param {object} raw
 * @param {{ lawMeta?: object }} [opts]
 */
export function normalizeObligationRow(raw = {}, opts = {}) {
  const lawMeta = opts.lawMeta || {};
  const matterId = clean(raw.matter_id, 40);
  const mandateId = clean(raw.mandate_id || raw.obligation_id, 80)
    || (matterId ? `${matterId}-001` : null);
  if (!mandateId || !matterId) return null;

  const actor = resolveStatuteActorAgency(raw.agency || raw.agency_raw || raw.actor_resolved);
  const deadline = normalizeDeadline(raw.deadline || {
    kind: raw.deadline_kind,
    computed_date: raw.deadline_date,
    text: raw.deadline_text,
  });
  const deliverable = clean(raw.deliverable_type, 80) || "other";
  const recurrence = clean(raw.recurrence, 80) || "one-time";
  const duty = clean(raw.duty_text || raw.action_summary, 500);
  if (!duty) return null;

  const matterGuid = clean(lawMeta.matter_guid || raw.matter_guid, 80) || null;
  const detailId = clean(lawMeta.legistar_detail_id || raw.legistar_detail_id, 40) || null;
  const sourceUrl = clean(
    lawMeta.source_url || raw.source_url || lawMeta?.source?.url || raw?.source?.url,
    1000,
  ) || null;
  const legistarUrl = legistarMatterUrl(matterId, { matterGuid, detailId });
  const citation = clean(raw.citation, 240) || null;
  const fileNumber = clean(raw.file_number || raw.matter_file || lawMeta.file_number || lawMeta.matter_file, 80) || null;
  const lawNumber = clean(raw.law_number_display || lawMeta.enactment_number || lawMeta.law_number_display, 80) || null;
  const certification = certificationForRow(raw);
  const hasTemporalAnchors = lawMeta.temporal_anchors_present === true
    || hasOwn(raw, "enactment_date")
    || hasOwn(raw, "effective_date");
  const enactmentDate = validDate(lawMeta.enactment_date ?? raw.enactment_date);
  const effectiveDate = validDate(lawMeta.effective_date ?? raw.effective_date);

  return {
    obligation_id: mandateId,
    matter_id: matterId,
    agency_id: actor.agency_id,
    agency_name: actor.agency_name,
    agency_raw: actor.agency_raw,
    agency_match: {
      matched: actor.matched,
      method: actor.method,
      confidence: actor.confidence,
    },
    duty_text: duty,
    deliverable_type: deliverable,
    deadline,
    recurrence,
    citation,
    file_number: fileNumber,
    law_number_display: lawNumber,
    ...(hasTemporalAnchors ? {
      // Machine provenance for temporal joins; reader-facing copy does not
      // treat either publisher date as a deadline or compliance verdict.
      enactment_date: enactmentDate,
      effective_date: effectiveDate,
      temporal_anchor_method: AGENCY_OBLIGATIONS_TEMPORAL_ANCHOR_METHOD,
    } : {}),
    source: {
      matter_id: matterId,
      legistar_url: legistarUrl,
      law_text_url: sourceUrl,
      citation,
      file_number: fileNumber,
      law_number_display: lawNumber,
    },
    certification,
    // Process-conformance seam (machine only): observation status is not a product claim.
    observation: {
      status: "not_adjudicated",
      expected_event: deliverable,
    },
    // Digest identity for approaching-deadline watches (world-state, not document match).
    alert_id: deadline.computed_date
      ? `obligation:${mandateId}:${deadline.computed_date}`
      : `obligation:${mandateId}:${recurrence || "standing"}`,
  };
}

/**
 * Build the full public lookup envelope from a backfill payload (our.json shape).
 */
export function buildAgencyObligationsLookup(payload = {}, { generatedAt = null, asOf = null } = {}) {
  const mandates = Array.isArray(payload.mandates) ? payload.mandates
    : Array.isArray(payload.obligations) ? payload.obligations
      : [];
  const laws = Array.isArray(payload.laws) ? payload.laws : [];
  const lawByMatter = new Map();
  for (const law of laws) {
    const id = clean(law?.matter_id, 40);
    if (!id) continue;
    lawByMatter.set(id, {
      matter_guid: law.matter_guid || null,
      legistar_detail_id: law.legistar_detail_id || law.detail_id || null,
      file_number: law.file_number || law.matter_file || null,
      enactment_number: law.enactment_number || null,
      source_url: law?.source?.url || law.source_url || null,
      law_number_display: law.law_number_display || null,
      enactment_date: law.enactment_date ?? null,
      effective_date: law.effective_date ?? null,
      temporal_anchors_present: hasOwn(law, "enactment_date") || hasOwn(law, "effective_date"),
    });
  }

  const byAgency = Object.create(null);
  const unmatched = [];
  let certified = 0;
  let candidate = 0;
  let withDeadline = 0;

  for (const raw of mandates) {
    const row = normalizeObligationRow(raw, {
      lawMeta: lawByMatter.get(clean(raw?.matter_id, 40)) || {},
    });
    if (!row) continue;
    if (row.certification.status === "auto_certified") certified += 1;
    else candidate += 1;
    if (row.deadline.computed_date || row.deadline.text) withDeadline += 1;

    if (!row.agency_id) {
      unmatched.push({
        obligation_id: row.obligation_id,
        agency_raw: row.agency_raw,
        method: row.agency_match.method,
      });
      continue;
    }
    if (!byAgency[row.agency_id]) {
      byAgency[row.agency_id] = {
        agency_id: row.agency_id,
        agency_name: row.agency_name,
        count: 0,
        with_computed_deadline: 0,
        auto_certified_count: 0,
        obligations: [],
      };
    }
    const bucket = byAgency[row.agency_id];
    bucket.count += 1;
    if (row.deadline.computed_date) bucket.with_computed_deadline += 1;
    if (row.certification.status === "auto_certified") bucket.auto_certified_count += 1;
    bucket.obligations.push(row);
  }

  for (const bucket of Object.values(byAgency)) {
    bucket.obligations.sort((left, right) => {
      const leftDate = left.deadline.computed_date || "9999";
      const rightDate = right.deadline.computed_date || "9999";
      if (leftDate !== rightDate) return leftDate.localeCompare(rightDate);
      return String(left.obligation_id).localeCompare(String(right.obligation_id));
    });
  }

  const matchedAgencies = Object.keys(byAgency).sort();
  return {
    schema: AGENCY_OBLIGATIONS_SCHEMA,
    method: AGENCY_OBLIGATIONS_METHOD,
    certification_basis: AGENCY_OBLIGATIONS_CERTIFICATION,
    er_match_basis: AGENCY_OBLIGATIONS_ER_BASIS,
    generated_at: generatedAt || payload.generated_at || new Date().toISOString(),
    as_of: asOf || validDate(payload.generated_at?.slice(0, 10)) || null,
    iteration: "v1",
    // Machine policy (not user-facing copy): surface standable duty/deadline facts only.
    honesty: {
      surface: "duty_deadline_recurrence",
      certification: "auto_certified_quote_verify_v1",
    },
    source_receipt: {
      schema_version: payload.schema_version || null,
      model: payload.model || null,
      prompt_version: payload.prompt_version || null,
      law_count: Number(payload.receipt?.law_count) || laws.length || null,
      mandate_count: mandates.length,
      extraction: "independent_enacted_law_backfill",
    },
    summary: {
      obligation_count: mandates.length,
      matched_obligation_count: Object.values(byAgency).reduce((sum, row) => sum + row.count, 0),
      unmatched_obligation_count: unmatched.length,
      agency_count: matchedAgencies.length,
      auto_certified_count: certified,
      auto_candidate_count: candidate,
      with_deadline_signal_count: withDeadline,
      preferred_agency_match_rate: mandates.length
        ? Object.values(byAgency).reduce((sum, row) => sum + row.count, 0) / mandates.length
        : 0,
    },
    by_agency: byAgency,
    // Compact unmatched sample for diagnostics (not a public review queue).
    unmatched_sample: unmatched.slice(0, 25),
  };
}

/** Agency obligations for constellation / document rendering. */
export function buildAgencyObligationsView(agencyIdOrName, lookup, { limit = 12, asOf = null } = {}) {
  const identity = resolveAgencyIdentity(agencyIdOrName);
  if (!identity?.canonical_id) return null;
  const bucket = lookup?.by_agency?.[identity.canonical_id] || null;
  const obligations = Array.isArray(bucket?.obligations) ? bucket.obligations : [];
  const today = validDate(asOf) || new Date().toISOString().slice(0, 10);
  const items = obligations.slice(0, limit).map((row) => publicObligationItem(row, today));
  return {
    agency_id: identity.canonical_id,
    agency_name: identity.canonical_name || bucket?.agency_name || identity.canonical_id,
    subject_ref: `agency:id:${identity.canonical_id}`,
    status: obligations.length ? "matched" : "empty",
    count: Number(bucket?.count) || obligations.length,
    with_computed_deadline: Number(bucket?.with_computed_deadline) || 0,
    auto_certified_count: Number(bucket?.auto_certified_count) || 0,
    items,
    method: AGENCY_OBLIGATIONS_METHOD,
    certification_basis: AGENCY_OBLIGATIONS_CERTIFICATION,
    er_match_basis: AGENCY_OBLIGATIONS_ER_BASIS,
    follow_href: agencyObligationsFollowHref(identity.canonical_id),
    honesty: lookup?.honesty || null,
    note: obligations.length
      ? null
      : "No statutory mandates are linked to this agency in the current materialization.",
  };
}

function publicObligationItem(row, today) {
  const deadlineDate = row.deadline?.computed_date || null;
  let deadlineBand = null;
  if (deadlineDate) {
    const days = Math.round(
      (Date.parse(`${deadlineDate}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86400000,
    );
    if (Number.isFinite(days)) {
      if (days < 0) deadlineBand = "past_date";
      else if (days <= 30) deadlineBand = "within_30_days";
      else if (days <= 90) deadlineBand = "within_90_days";
      else deadlineBand = "later";
    }
  }
  return {
    id: row.obligation_id,
    obligation_id: row.obligation_id,
    duty_text: row.duty_text,
    deliverable_type: row.deliverable_type,
    deadline_date: deadlineDate,
    deadline_text: row.deadline?.text || null,
    deadline_band: deadlineBand,
    recurrence: row.recurrence,
    citation: row.citation,
    certification_status: row.certification?.status || "auto_candidate",
    quote_verified: row.certification?.quote_verified === true,
    observation_status: row.observation?.status || "not_adjudicated",
    source: row.source,
    href: row.source?.legistar_url || null,
    alert_id: row.alert_id,
  };
}

/**
 * World-state rows for digest compile: approaching / recent mandate deadlines for one agency.
 * Never invents compliance; past dates stay labeled as past statutory dates.
 * Optional deliverableType / windowDays refine the free-watch scope.
 */
export function obligationDigestRowsForAgency(lookup, agencyId, {
  todayISO,
  windowDays = 90,
  pastDays = 30,
  deliverableType = null,
} = {}) {
  const identity = resolveAgencyIdentity(agencyId);
  const id = identity?.canonical_id || clean(agencyId, 120);
  const bucket = lookup?.by_agency?.[id];
  if (!bucket) return [];
  const today = validDate(todayISO) || new Date().toISOString().slice(0, 10);
  const todayMs = Date.parse(`${today}T12:00:00Z`);
  const window = Number.isFinite(Number(windowDays))
    ? Math.max(1, Math.min(365, Math.round(Number(windowDays))))
    : 90;
  const past = Number.isFinite(Number(pastDays))
    ? Math.max(0, Math.min(3650, Math.round(Number(pastDays))))
    : 30;
  const typeFilter = clean(deliverableType, 40).toLowerCase() || null;
  const rows = [];
  for (const row of bucket.obligations || []) {
    if (typeFilter && clean(row.deliverable_type, 40).toLowerCase() !== typeFilter) continue;
    const date = row.deadline?.computed_date;
    if (!date) {
      // Standing / undated mandates surface once as watchable world-state, not a document match.
      if (row.recurrence && row.recurrence !== "one-time") {
        rows.push(digestRowFromObligation(row, { band: "standing", today }));
      }
      continue;
    }
    const days = Math.round((Date.parse(`${date}T12:00:00Z`) - todayMs) / 86400000);
    if (!Number.isFinite(days)) continue;
    if (days > window || days < -past) continue;
    const band = days < 0 ? "past_date" : days <= 30 ? "within_30_days" : "within_window";
    rows.push(digestRowFromObligation(row, { band, today, days }));
  }
  return rows.sort((left, right) => {
    const leftDate = left.deadline_date || "9999";
    const rightDate = right.deadline_date || "9999";
    return leftDate.localeCompare(rightDate);
  });
}

function digestRowFromObligation(row, { band, today, days = null } = {}) {
  return {
    alert_id: row.alert_id,
    obligation_id: row.obligation_id,
    matter_id: row.matter_id,
    agency_id: row.agency_id,
    agency_name: row.agency_name,
    short_title: row.duty_text,
    duty_text: row.duty_text,
    deliverable_type: row.deliverable_type,
    recurrence: row.recurrence,
    deadline_date: row.deadline?.computed_date || null,
    deadline_text: row.deadline?.text || null,
    deadline_band: band,
    days_to_deadline: days,
    as_of: today,
    citation: row.citation,
    legistar_url: row.source?.legistar_url || null,
    certification_status: row.certification?.status || "auto_candidate",
    observation_status: "not_adjudicated",
    compliance_verdict: null,
    start_date: row.deadline?.computed_date || today,
  };
}

/**
 * Free-watch scope URL for an agency's mandates (world-state digest path).
 * Optional deliverableType (report|rulemaking|program|data publication|other)
 * and windowDays (1–365) refine the shareable scope; omit for the full agency watch.
 */
export function agencyObligationsFollowHref(agencyIdOrName, {
  frequency = "weekly",
  deliverableType = null,
  windowDays = null,
} = {}) {
  const identity = resolveAgencyIdentity(agencyIdOrName);
  if (!identity?.canonical_id) return "/following/";
  const filter = {
    agency_id: identity.canonical_id,
    agency: identity.canonical_name,
  };
  const type = clean(deliverableType, 40).toLowerCase();
  if (type && ["report", "rulemaking", "program", "data publication", "other"].includes(type)) {
    filter.deliverable_type = type;
  }
  const window = Number(windowDays);
  if (Number.isFinite(window)) {
    const days = Math.round(window);
    if (days >= 1 && days <= 365) filter.windowDays = days;
  }
  return followingUrlFromWatch({
    lens: "mandates",
    filter,
  }, { frequency });
}

/** Compact HTML list fragment for constellation embedding. */
export function renderAgencyObligationsSection(view) {
  if (!view) return "";
  const status = view.status === "matched"
    ? `${view.count} mandates`
    : "none in this materialization";
  const list = view.items?.length
    ? `<ul class="node-record-list">${view.items.map((item) => {
      const duty = esc(item.duty_text);
      const meta = [
        item.deliverable_type,
        item.deadline_date ? `deadline ${item.deadline_date}` : (item.deadline_text ? `deadline: ${item.deadline_text}` : "no computed deadline"),
        item.recurrence,
      ].filter(Boolean).map(esc).join(" · ");
      const source = item.href
        ? officialSourceLink({ href: item.href, label: "Source law", className: "agency-source-link", escape: esc })
        : "Source law unavailable";
      const citation = item.citation ? ` · ${esc(item.citation)}` : "";
      return `<li class="node-record" data-obligation-id="${esc(item.obligation_id)}">
        <div class="node-record-main">${duty}</div>
        <span class="muted node-muted">${meta}${citation} · ${source}</span>
      </li>`;
    }).join("")}</ul>`
    : `<p class="node-muted">${esc(view.note || "No statutory mandates are linked to this agency in the current materialization.")}</p>`;

  const actions = [
    view.follow_href
      ? `<a class="node-action civic-object-action" href="${esc(view.follow_href)}">Watch mandates and deadlines</a>`
      : "",
  ].filter(Boolean).join("");

  return `<section class="node-section node-card civic-object-section" data-agency-constellation-category="obligations" data-status="${esc(view.status)}" data-export-class="object_members" data-certification-basis="${esc(view.certification_basis || AGENCY_OBLIGATIONS_CERTIFICATION)}">
    <h2>Mandates <span class="muted node-muted">(${esc(status)})</span></h2>
    <p class="node-muted muted">Agency → duty → deadline → recurrence from enacted local law.</p>
    ${list}
    ${actions ? `<p class="node-inline-actions civic-object-inline-actions">${actions}</p>` : ""}
  </section>`;
}
