/**
 * Cited capability comparison for historical award descriptions
 * (bounded opt-in pilot; default off).
 *
 * Pure read-model projection: joins an explicit user capability profile to
 * source-backed duty passages extracted from already-normalized award
 * records. Never fetches a publisher, never ranks, never turns an award
 * description into a bid/no-bid or ownership requirement, and never mutates
 * preference-set, exact-lineage, buyer-history, or pursuit-state seams.
 *
 * Assessment states:
 *   - supported_overlap: cited duty present and the user declared the matching
 *     capability as available
 *   - stated_capability_gap: cited duty present and the user declared the
 *     matching capability as unavailable
 *   - document_review_needed: the passage does not identify a specific
 *     equipment or service duty, or the citation cannot be validated
 *   - unspecified: the matching profile field was not stated
 *
 * Every non-rejected assessment carries notice id, URL, field, and the exact
 * passage. A mutated or missing passage cannot emit a supported assessment.
 * Amount, purchase method, and awardee identity never establish eligibility;
 * overall_eligibility and ownership_required stay null from this source role.
 */

export const PROCUREMENT_CAPABILITY_COMPARISON_SCHEMA =
  "cityscroll.procurement_capability_comparison.v1";
export const PROCUREMENT_CAPABILITY_PROFILE_SCHEMA =
  "cityscroll.procurement_capability_profile.v1";
export const PROCUREMENT_CITED_DUTY_SCHEMA =
  "cityscroll.procurement_cited_duty.v1";

export const CAPABILITY_ASSESSMENT_STATE = Object.freeze({
  SUPPORTED_OVERLAP: "supported_overlap",
  STATED_CAPABILITY_GAP: "stated_capability_gap",
  DOCUMENT_REVIEW_NEEDED: "document_review_needed",
  UNSPECIFIED: "unspecified",
});

/** Source role for award-description passages — not a full RFP qualification. */
export const CAPABILITY_SOURCE_ROLE = "award_description";

/**
 * Reviewed duty vocabulary. Each entry names the capability key it joins,
 * the record field that must contain the exact passage, and the exact
 * passage text that must appear verbatim (case-insensitive match for
 * location; the assessment cites the canonical passage string).
 *
 * kind "service" means the passage names a service, not equipment ownership.
 * kind "nonspecific" means the passage cannot identify a specific duty.
 */
export const CITED_DUTY_VOCABULARY = Object.freeze([
  Object.freeze({
    duty_id: "jet_vacuum_service",
    label: "jet vacuum",
    capability_key: "jet_vac_truck",
    field: "additional_description_1",
    passage: "pump truck, jet vacuum and video camera inspectional services",
    kind: "service",
  }),
  Object.freeze({
    duty_id: "vegetation_trimming",
    label: "vegetation trimming",
    capability_key: "landscaping",
    field: "short_title",
    passage: "VEGETATION TRIMMING",
    kind: "service",
  }),
  Object.freeze({
    duty_id: "nonspecific_equipment_materials",
    label: "specific equipment",
    capability_key: null,
    field: "additional_description_1",
    passage: "all labor, equipment and materials",
    kind: "nonspecific",
  }),
  Object.freeze({
    duty_id: "drain_blockage_removal",
    label: "drain cleaning",
    capability_key: "drain_cleaning",
    field: "additional_description_1",
    passage: "remove blockages from building drain lines",
    kind: "service",
  }),
]);

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

function ternaryCapability(value) {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

/**
 * Normalize an explicit capability profile. Unknown / omitted fields stay
 * null (unspecified). Never infers a capability the user did not state.
 */
export function normalizeCapabilityProfile(input = {}) {
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

  let drainCleaning = ternaryCapability(raw.drain_cleaning ?? raw.drainCleaning);
  if (drainCleaning == null && capabilityKeywords.includes("drain cleaning")) {
    drainCleaning = true;
  }

  return Object.freeze({
    schema: PROCUREMENT_CAPABILITY_PROFILE_SCHEMA,
    name: text(raw.name) || null,
    capability_keywords: Object.freeze(capabilityKeywords),
    jet_vac_truck: ternaryCapability(raw.jet_vac_truck ?? raw.jetVacTruck),
    landscaping: ternaryCapability(raw.landscaping),
    drain_cleaning: drainCleaning,
    roof_installation_crew: ternaryCapability(
      raw.roof_installation_crew ?? raw.roofInstallationCrew,
    ),
  });
}

/**
 * Extract cited duties whose exact passage is present on the record.
 * Duties whose passage is absent are omitted (they cannot support an
 * assessment). Output order follows CITED_DUTY_VOCABULARY.
 */
export function extractCitedDuties(record = {}) {
  const id = noticeId(record);
  const url = sourceUrl(record);
  const duties = [];
  for (const vocab of CITED_DUTY_VOCABULARY) {
    const haystack = fieldText(record, vocab.field);
    if (!passagePresent(haystack, vocab.passage)) continue;
    duties.push(
      Object.freeze({
        schema: PROCUREMENT_CITED_DUTY_SCHEMA,
        duty_id: vocab.duty_id,
        label: vocab.label,
        kind: vocab.kind,
        capability_key: vocab.capability_key,
        citation: Object.freeze({
          notice_id: id,
          url,
          field: vocab.field,
          passage: vocab.passage,
          source_role: CAPABILITY_SOURCE_ROLE,
        }),
      }),
    );
  }
  return Object.freeze(duties);
}

/**
 * True only when the assessment's cited passage still appears in the named
 * field on the record. A deleted or mismatched passage fails validation and
 * cannot remain a supported assessment.
 */
export function citationMatchesRecord(citation, record = {}) {
  if (!citation || typeof citation !== "object") return false;
  const field = text(citation.field);
  const passage = text(citation.passage);
  if (!field || !passage) return false;
  return passagePresent(fieldText(record, field), passage);
}

function profileCapabilityValue(profile, capabilityKey) {
  if (!capabilityKey) return null;
  if (capabilityKey === "drain_cleaning") return profile.drain_cleaning;
  if (capabilityKey === "jet_vac_truck") return profile.jet_vac_truck;
  if (capabilityKey === "landscaping") return profile.landscaping;
  if (capabilityKey === "roof_installation_crew") return profile.roof_installation_crew;
  return null;
}

function assessDuty(duty, profile) {
  const citation = duty.citation;
  if (duty.kind === "nonspecific" || duty.capability_key == null) {
    return Object.freeze({
      duty_id: duty.duty_id,
      label: duty.label,
      state: CAPABILITY_ASSESSMENT_STATE.DOCUMENT_REVIEW_NEEDED,
      service_gap: null,
      ownership_required: null,
      overall_eligibility: null,
      citation,
      wording: `The published ${citation.field} names "${citation.passage}" without identifying a specific equipment or service duty; document review is needed.`,
    });
  }

  const stated = profileCapabilityValue(profile, duty.capability_key);
  if (stated === null) {
    return Object.freeze({
      duty_id: duty.duty_id,
      label: duty.label,
      state: CAPABILITY_ASSESSMENT_STATE.UNSPECIFIED,
      service_gap: null,
      ownership_required: null,
      overall_eligibility: null,
      citation,
      wording: `Your profile leaves ${duty.capability_key} unspecified, so the cited duty "${citation.passage}" cannot be compared yet.`,
    });
  }

  if (stated === true) {
    return Object.freeze({
      duty_id: duty.duty_id,
      label: duty.label,
      state: CAPABILITY_ASSESSMENT_STATE.SUPPORTED_OVERLAP,
      service_gap: null,
      ownership_required: null,
      overall_eligibility: null,
      citation,
      wording: `Your stated ${duty.capability_key} overlaps the cited award duty "${citation.passage}".`,
    });
  }

  // stated === false → capability gap for a service duty; never claim ownership.
  return Object.freeze({
    duty_id: duty.duty_id,
    label: duty.label,
    state: CAPABILITY_ASSESSMENT_STATE.STATED_CAPABILITY_GAP,
    service_gap: duty.label,
    ownership_required: null,
    overall_eligibility: null,
    citation,
    wording: `Your profile states ${duty.capability_key}=false while the award description cites "${citation.passage}" as a service duty. Ownership of equipment is not established by this award description.`,
  });
}

/**
 * Compare an explicit capability profile against one award record.
 * Returns inspectable assessments with stable source identity. Rejects any
 * duty whose citation no longer matches the record (mutation control).
 */
export function compareCapabilities({ profile, record } = {}) {
  const normalized = normalizeCapabilityProfile(profile);
  const id = noticeId(record);
  const url = sourceUrl(record);
  const duties = extractCitedDuties(record);
  const assessments = [];
  const rejected = [];

  for (const duty of duties) {
    if (!citationMatchesRecord(duty.citation, record)) {
      rejected.push(
        Object.freeze({
          duty_id: duty.duty_id,
          reason: "citation_passage_absent",
          citation: duty.citation,
        }),
      );
      continue;
    }
    assessments.push(assessDuty(duty, normalized));
  }

  return Object.freeze({
    schema: PROCUREMENT_CAPABILITY_COMPARISON_SCHEMA,
    notice_id: id,
    source_url: url,
    source_role: CAPABILITY_SOURCE_ROLE,
    profile: normalized,
    assessments: Object.freeze(assessments),
    rejected: Object.freeze(rejected),
    // Explicit nulls: award description alone never establishes these.
    overall_eligibility: null,
    ownership_required: null,
  });
}

/**
 * Convenience: find the assessment for a duty id, or null.
 */
export function assessmentForDuty(comparison, dutyId) {
  return (comparison?.assessments || []).find((a) => a.duty_id === dutyId) || null;
}

/**
 * True when a comparison claims a supported assessment for dutyId. Used by
 * mutation controls: after the cited passage is removed, this must be false.
 */
export function hasSupportedAssessment(comparison, dutyId) {
  const assessment = assessmentForDuty(comparison, dutyId);
  return Boolean(
    assessment && assessment.state === CAPABILITY_ASSESSMENT_STATE.SUPPORTED_OVERLAP,
  );
}
