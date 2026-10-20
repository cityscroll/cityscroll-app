/**
 * Bounded program-capability retrieval for historical award descriptions
 * (opt-in pilot; default off).
 *
 * Joins an explicit training/placement profile to source-backed capability
 * passages on retained public awards, and groups related program history
 * without inventing exact lineage, future openings, or eligibility.
 *
 * Exact predecessor links reuse the existing related-context seam. Awards
 * that share reviewed program evidence but lack an exact identity basis are
 * marked program_related only. Amount, purchase method, and awardee identity
 * never establish eligibility or program admission alone.
 */

import { exactIdentityBasis } from "./procurement_related_context.mjs";

export const PROCUREMENT_PROGRAM_CAPABILITIES_SCHEMA =
  "cityscroll.procurement_program_capabilities.v1";
export const PROCUREMENT_PROGRAM_PROFILE_SCHEMA =
  "cityscroll.procurement_program_profile.v1";
export const PROCUREMENT_PROGRAM_MATCH_SCHEMA =
  "cityscroll.procurement_program_match.v1";
export const PROCUREMENT_PROGRAM_GROUP_SCHEMA =
  "cityscroll.procurement_program_group.v1";

export const PROGRAM_RELATION = Object.freeze({
  EXACT_PREDECESSOR_LINK: "exact_predecessor_link",
  PROGRAM_RELATED: "program_related",
});

export const PROGRAM_SOURCE_ROLE = "award_description";

/**
 * Reviewed capability vocabulary for the bounded training-program corpus.
 * Each entry requires an exact passage on a named field.
 */
export const PROGRAM_CAPABILITY_VOCABULARY = Object.freeze([
  Object.freeze({
    capability_id: "coolroofs_training_program",
    label: "cool roofs training program",
    profile_keys: Object.freeze(["job_training"]),
    field: "short_title",
    passage: "COOLROOFS TRAINING PROGRAM",
    kind: "program_identity",
  }),
  Object.freeze({
    capability_id: "coolroofs_training_program_title",
    label: "cool roofs training program administration",
    profile_keys: Object.freeze(["job_training"]),
    field: "short_title",
    passage: "CoolRoofs Training Program",
    kind: "program_identity",
  }),
  Object.freeze({
    capability_id: "jobseeker_training",
    label: "jobseeker training",
    profile_keys: Object.freeze(["job_training"]),
    field: "additional_description_1",
    passage: "paid and transitional work-based learning experience",
    kind: "service",
  }),
  Object.freeze({
    capability_id: "reflective_coating",
    label: "reflective coating",
    profile_keys: Object.freeze(["roof_installation_crew", "job_training"]),
    field: "additional_description_1",
    passage: "white, reflective coating",
    kind: "service",
  }),
  Object.freeze({
    capability_id: "consortium_delivery",
    label: "consortium delivery",
    profile_keys: Object.freeze(["job_training"]),
    field: "additional_description_1",
    passage: "consortium of qualified vendors",
    kind: "delivery_route",
  }),
  Object.freeze({
    capability_id: "coolroofs_program_admin_desc",
    label: "cool roofs program administration",
    profile_keys: Object.freeze(["job_training"]),
    field: "additional_description_1",
    passage: "COOLROOFS TRAINING PROGRAM ADMINISTRATION",
    kind: "program_identity",
  }),
]);

/** Reviewed program-identity passages that admit a record into the group. */
export const PROGRAM_IDENTITY_PASSAGES = Object.freeze([
  Object.freeze({ field: "short_title", passage: "COOLROOFS TRAINING PROGRAM" }),
  Object.freeze({ field: "short_title", passage: "CoolRoofs Training Program" }),
  Object.freeze({ field: "additional_description_1", passage: "NYC CoolRoofs" }),
  Object.freeze({
    field: "additional_description_1",
    passage: "COOLROOFS TRAINING PROGRAM ADMINISTRATION",
  }),
]);

/**
 * Reviewed buyer agencies for program-history admission in this bounded pilot.
 * Program-identity passages on a different agency do not admit the record.
 */
export const PROGRAM_BUYER_AGENCIES = Object.freeze(["Small Business Services"]);

function text(value) {
  const s = String(value ?? "").trim();
  return s || null;
}

function noticeId(record = {}) {
  return text(record.request_id ?? record.id ?? record.notice_id);
}

function sourceUrl(record = {}) {
  const explicit = text(record.source_url);
  if (explicit) return explicit;
  const id = noticeId(record);
  return id ? `https://cityscroll.org/notices/${id}/` : null;
}

function fieldText(record, field) {
  return text(record?.[field]) ?? "";
}

function passagePresent(haystack, passage) {
  if (!haystack || !passage) return false;
  return haystack.toLowerCase().includes(String(passage).toLowerCase());
}

function ternary(value) {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

export function normalizeProgramProfile(input = {}) {
  const raw = input && typeof input === "object" ? input : {};
  const keywordsRaw = Array.isArray(raw.capability_keywords)
    ? raw.capability_keywords
    : Array.isArray(raw.capabilityKeywords)
      ? raw.capabilityKeywords
      : [];
  const capabilityKeywords = [
    ...new Set(
      keywordsRaw
        .map((kw) => text(kw)?.toLowerCase())
        .filter(Boolean),
    ),
  ].sort((a, b) => a.localeCompare(b));

  let jobTraining = ternary(raw.job_training ?? raw.jobTraining);
  if (jobTraining == null && capabilityKeywords.includes("job training")) {
    jobTraining = true;
  }
  let employerPlacement = ternary(
    raw.employer_placement ?? raw.employerPlacement,
  );
  if (
    employerPlacement == null &&
    capabilityKeywords.includes("employer placement")
  ) {
    employerPlacement = true;
  }

  return Object.freeze({
    schema: PROCUREMENT_PROGRAM_PROFILE_SCHEMA,
    name: text(raw.name) || null,
    capability_keywords: Object.freeze(capabilityKeywords),
    job_training: jobTraining,
    employer_placement: employerPlacement,
    roof_installation_crew: ternary(
      raw.roof_installation_crew ?? raw.roofInstallationCrew,
    ),
  });
}

export function extractProgramCapabilities(record = {}) {
  const id = noticeId(record);
  const url = sourceUrl(record);
  const caps = [];
  for (const vocab of PROGRAM_CAPABILITY_VOCABULARY) {
    const haystack = fieldText(record, vocab.field);
    if (!passagePresent(haystack, vocab.passage)) continue;
    caps.push(
      Object.freeze({
        capability_id: vocab.capability_id,
        label: vocab.label,
        kind: vocab.kind,
        citation: Object.freeze({
          notice_id: id,
          url,
          field: vocab.field,
          passage: vocab.passage,
          source_role: PROGRAM_SOURCE_ROLE,
        }),
      }),
    );
  }
  return Object.freeze(caps);
}

export function hasProgramIdentityEvidence(record = {}) {
  for (const rule of PROGRAM_IDENTITY_PASSAGES) {
    if (passagePresent(fieldText(record, rule.field), rule.passage)) {
      return true;
    }
  }
  return false;
}

/** True when the record's agency is a reviewed buyer for this program pilot. */
export function hasReviewedProgramBuyer(record = {}) {
  const agency = text(record.agency_name);
  if (!agency) return false;
  return PROGRAM_BUYER_AGENCIES.some(
    (allowed) => allowed.toLowerCase() === agency.toLowerCase(),
  );
}

/**
 * Admit a record into related program history only when both reviewed
 * program-identity evidence and a reviewed buyer agency are present.
 * Same-vendor, amount, or purchase method alone never admit.
 */
export function admitsProgramHistory(record = {}) {
  return hasProgramIdentityEvidence(record) && hasReviewedProgramBuyer(record);
}

function profileRequestsCapability(profile, vocab) {
  for (const key of vocab.profile_keys) {
    if (profile?.[key] === true) return true;
    if (
      key === "job_training" &&
      Array.isArray(profile?.capability_keywords) &&
      profile.capability_keywords.includes("job training")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Retrieve records whose cited capabilities match the stated profile.
 * Every match carries notice id, URL, field, and exact passage.
 */
export function matchProgramRecords({ profile, records } = {}) {
  const normalized = normalizeProgramProfile(profile);
  const list = Array.isArray(records) ? records : [];
  const matches = [];
  for (const record of list) {
    const capabilities = extractProgramCapabilities(record);
    const matched = [];
    for (const cap of capabilities) {
      const vocab = PROGRAM_CAPABILITY_VOCABULARY.find(
        (v) => v.capability_id === cap.capability_id,
      );
      if (!vocab) continue;
      if (!profileRequestsCapability(normalized, vocab)) continue;
      matched.push(cap);
    }
    if (matched.length === 0) continue;
    matches.push(
      Object.freeze({
        schema: PROCUREMENT_PROGRAM_MATCH_SCHEMA,
        notice_id: noticeId(record),
        source_url: sourceUrl(record),
        category_description: text(record.category_description),
        short_title: text(record.short_title),
        capabilities: Object.freeze(matched),
        record,
      }),
    );
  }
  return Object.freeze({
    schema: PROCUREMENT_PROGRAM_CAPABILITIES_SCHEMA,
    profile: normalized,
    matches: Object.freeze(matches),
    overall_eligibility: null,
    future_opening_predicted: false,
  });
}

/**
 * Group retained awards that carry reviewed program-identity evidence and a
 * reviewed buyer agency. Exact predecessor links come only from
 * exactIdentityBasis. Same-buyer or same-vendor alone never admits a record.
 * Employer placement is never a required duty without a supporting citation
 * on that record.
 */
export function groupProgramHistory({ records } = {}) {
  const list = Array.isArray(records) ? records : [];
  const admitted = [];
  for (const record of list) {
    if (!admitsProgramHistory(record)) continue;
    const capabilities = extractProgramCapabilities(record);
    admitted.push(
      Object.freeze({
        notice_id: noticeId(record),
        source_url: sourceUrl(record),
        category_description: text(record.category_description),
        pin: text(record.pin),
        capabilities,
        record,
        employer_placement_required: false,
      }),
    );
  }

  const relations = [];
  for (let i = 0; i < admitted.length; i++) {
    for (let j = i + 1; j < admitted.length; j++) {
      const a = admitted[i];
      const b = admitted[j];
      const exact = exactIdentityBasis(a.record, b.record);
      const relation = exact
        ? PROGRAM_RELATION.EXACT_PREDECESSOR_LINK
        : PROGRAM_RELATION.PROGRAM_RELATED;
      relations.push(
        Object.freeze({
          a: a.notice_id,
          b: b.notice_id,
          relation,
          exact_basis: exact || null,
        }),
      );
    }
  }

  return Object.freeze({
    schema: PROCUREMENT_PROGRAM_GROUP_SCHEMA,
    members: Object.freeze(admitted),
    relations: Object.freeze(relations),
    future_opening_predicted: false,
    program_admission_from_awardee_alone: false,
    program_admission_requires_buyer: true,
  });
}

export function relationBetween(group, idA, idB) {
  const hit = (group?.relations || []).find(
    (r) =>
      (r.a === idA && r.b === idB) || (r.a === idB && r.b === idA),
  );
  return hit?.relation ?? null;
}
