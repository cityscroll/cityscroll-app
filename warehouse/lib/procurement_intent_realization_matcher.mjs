/**
 * Historical bridge from a source-backed stated intent to later solicitations.
 *
 * This is reconciliation, not prediction.  It only compares structured intent
 * fields that existed at assertion time with a later publisher observation;
 * the result is either an explicit public edge or an internal review lead.
 */

export const REALIZATION_MATCH_SCHEMA = "cityscroll.procurement_intent_radar.realization_match.v0";
export const REALIZATION_MATCHER_VERSION = "pir-realization-matcher.v1";
export const REALIZATION_HORIZON_MONTHS = 18;
export const AUTO_LINK_MIN_SCORE = 7;
export const PROSPECTIVE_EVENT_KIND = "procurement.notice_published";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/u;
const GENERIC_TOKENS = new Set([
  "A", "AN", "AND", "AS", "AT", "BY", "FOR", "FROM", "IN", "OF", "ON", "OR", "THE", "TO",
  "ADDITIONAL", "COMPETITIVE", "CONTRACT", "ISSUE", "ISSUED", "PROGRAM", "PROGRAMS", "PROCURE",
  "PROCUREMENT", "PROPOSAL", "PROPOSALS", "PUBLISH", "PUBLISHED", "RELEASE", "RELEASED", "REQUEST",
  "RFP", "RFQ", "RFX", "SERVICES", "SOLICIT", "SOLICITATION", "SOLICITATIONS",
]);
const METHOD_TOKENS = new Set(["RFP", "RFQ", "RFX", "SOLICITATION", "REQUEST FOR PROPOSALS"]);
const HINDSIGHT_FIELDS = new Set([
  "epin", "pin", "procurement_id", "vendor", "vendor_ref", "vendor_name", "later_title",
  "realized_at", "realized_by", "realization", "solicitation_id", "published_at", "publication_date",
]);
const TEXT_FIELDS = Object.freeze([
  "title", "short_title", "procurement_name", "main_commodity", "industry", "description",
  "additional_description_1", "object_text", "service", "program_name", "population", "geography",
]);

function text(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function surface(value) {
  return text(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[’']/gu, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function tokens(value, { keepGeneric = false } = {}) {
  return [...new Set(surface(value).split(" ").filter((tokenValue) => tokenValue
    && (keepGeneric || !GENERIC_TOKENS.has(tokenValue))))];
}

function validIsoDay(value) {
  if (!ISO_DAY.test(text(value))) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function dateOnly(value) {
  const match = text(value).match(/^(\d{4}-\d{2}-\d{2})/u);
  return match && validIsoDay(match[1]) ? match[1] : null;
}

function dayDifference(start, end) {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
}

function addMonths(day, months) {
  const [year, month, date] = day.split("-").map(Number);
  const targetMonth = month - 1 + months;
  const targetYear = year + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, normalizedMonth, Math.min(date, lastDay))).toISOString().slice(0, 10);
}

function flattenKnownValues(value, fields) {
  const values = [];
  if (!value || typeof value !== "object") return values;
  for (const field of fields) {
    const candidate = value[field];
    if (Array.isArray(candidate)) values.push(...candidate.filter((item) => typeof item === "string"));
    else if (typeof candidate === "string") values.push(candidate);
  }
  return values;
}

function snapshotValues(realization) {
  const values = [realization];
  for (const field of ["attrs", "snapshot", "normalized_snapshot", "raw_snapshot"]) {
    const raw = realization?.[field];
    if (raw && typeof raw === "object" && !Array.isArray(raw)) values.push(raw);
    else if (typeof raw === "string" && raw.trim()) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) values.push(parsed);
      } catch {
        // An unreadable snapshot cannot contribute match evidence.
      }
    }
  }
  return values;
}

function realizationText(realization) {
  return snapshotValues(realization)
    .flatMap((row) => flattenKnownValues(row, TEXT_FIELDS))
    .map(surface)
    .filter(Boolean)
    .join(" ");
}

function agencyFamily(value) {
  const candidate = surface(value).replace(/^AGENCY ID /u, "");
  if (!candidate) return null;
  if (candidate.includes("DYCD") || candidate.includes("YOUTH AND COMMUNITY DEVELOPMENT")) return "dycd";
  if (candidate.includes("ACS") || candidate.includes("CHILDREN S SERVICES") || candidate.includes("CHILDRENS SERVICES")
      || candidate.includes("CHILDREN AND FAMILY SERVICES")) return "acs";
  if (candidate.includes("HRA") || candidate.includes("HUMAN RESOURCES ADMINISTRATION")
      || candidate.includes("DSS") || candidate.includes("DEPARTMENT OF SOCIAL SERVICES")
      || candidate.includes("HOMELESS SERVICES")) return "dss";
  return candidate.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "") || null;
}

function intentAgency(intent) {
  return agencyFamily(intent?.responsible_agency_ref || intent?.responsible_agency || "");
}

function realizationAgency(realization) {
  for (const row of snapshotValues(realization)) {
    const value = row.agency || row.agency_name || row.responsible_agency_ref || row.responsible_agency;
    if (text(value)) return agencyFamily(value);
  }
  return null;
}

function expectedPublicationDate(realization) {
  for (const row of snapshotValues(realization)) {
    for (const field of ["published_at", "release_date", "publication_date", "notice_date", "date"]) {
      const value = dateOnly(row[field]);
      if (value) return value;
    }
  }
  return null;
}

function realizationRef(realization) {
  const supplied = text(realization?.realization_ref);
  if (supplied) return supplied;
  const procurementId = text(realization?.procurement_id);
  if (procurementId.startsWith("procurement:")) return procurementId;
  if (procurementId) return `procurement:publisher:${procurementId}`;
  const system = text(realization?.source_system || realization?.sourceSystem).toLowerCase();
  const nativeId = text(realization?.source_system_id || realization?.sourceSystemId || realization?.epin || realization?.pin);
  if (system && nativeId) return `procurement:${system}:${nativeId}`;
  return null;
}

function processRefFor(input) {
  return text(input?.process_ref || input?.subject_ref || input?.stated_intent?.process_ref);
}

function intentFor(input) {
  return input?.stated_intent || input?.intent || input;
}

function assertNoHindsightFields(intent) {
  const found = [];
  function visit(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (HINDSIGHT_FIELDS.has(key)) found.push(key);
      if (key !== "source_record") visit(child);
    }
  }
  visit(intent);
  if (found.length) throw new TypeError(`stated intent contains hindsight-only field ${[...new Set(found)].join(", ")}`);
}

/** Validate the historical side of the bridge without consulting later rows. */
export function assertHistoricalIntent(input = {}) {
  const intent = intentFor(input);
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) throw new TypeError("stated intent must be an object");
  assertNoHindsightFields(intent);
  if (!validIsoDay(text(intent.observed_at))) throw new TypeError("stated intent observed_at must be an ISO date");
  if (intent.action_kind && intent.action_kind !== "procurement.solicitation_publish") {
    throw new TypeError("stated intent action_kind must be procurement.solicitation_publish");
  }
  if (!intentAgency(intent)) throw new TypeError("stated intent responsible agency is required");
  return intent;
}

function textMatchesTokens(searchText, values) {
  const searchable = new Set(tokens(searchText, { keepGeneric: true }));
  return [...new Set(values.flatMap((value) => tokens(value)))].filter((value) => searchable.has(value));
}

function phraseMatch(searchText, value) {
  const phrase = surface(value);
  return Boolean(phrase && surface(searchText).includes(phrase));
}

function programLabels(intent) {
  return (Array.isArray(intent.program_refs) ? intent.program_refs : [])
    .map((value) => text(value).replace(/^program:[^:]+:/iu, "").replace(/[-_]+/gu, " "))
    .filter(Boolean);
}

function numberValues(values) {
  return values.flatMap((value) => [...text(value).matchAll(/\b\d+(?:\.\d+)?\b/gu)].map((match) => Number(match[0])))
    .filter((value) => Number.isFinite(value));
}

function intentQuantities(intent) {
  return (Array.isArray(intent.quantity_assertions) ? intent.quantity_assertions : [])
    .flatMap((assertion) => [assertion?.value, assertion?.raw_text])
    .filter((value) => value !== null && value !== undefined)
    .flatMap((value) => typeof value === "number" ? [value] : numberValues([value]));
}

function intentMoney(intent) {
  return (Array.isArray(intent.money_assertions) ? intent.money_assertions : [])
    .flatMap((assertion) => [assertion?.value, assertion?.amount, assertion?.raw_text])
    .filter((value) => value !== null && value !== undefined)
    .flatMap((value) => typeof value === "number" ? [value] : numberValues([value]));
}

function projectLike(objectText) {
  return text(objectText).split(/\s+/u).filter((value) => {
    const cleaned = value.replace(/[^A-Z0-9-]/gu, "");
    return /^[A-Z][A-Z0-9-]{2,}$/u.test(cleaned) && !GENERIC_TOKENS.has(cleaned);
  });
}

function methodMatch(intent, searchText) {
  const requested = surface(intent.procurement_type || "");
  const methodText = surface(searchText);
  return Boolean((requested && METHOD_TOKENS.has(requested) && methodText.includes(requested))
    || (requested === "RFP" && /\b(?:RFP|RFQ|RFX|REQUEST FOR PROPOSALS|SOLICITATION)\b/u.test(methodText)));
}

function evidenceRow(kind, field, matchedTerms, realizationFields) {
  return {
    kind,
    field,
    matched_terms: [...new Set(matchedTerms)].sort(),
    realization_fields: realizationFields,
  };
}

/**
 * Extract match evidence. The returned feature object intentionally omits
 * publisher identifiers and vendor fields; those are never similarity inputs.
 */
export function extractRealizationFeatures(input = {}, realization = {}) {
  const intent = assertHistoricalIntent(input);
  const intentAgencyFamily = intentAgency(intent);
  const observedAgencyFamily = realizationAgency(realization);
  const searchText = realizationText(realization);
  const evidence = [];
  const strong = {};
  const medium = {};

  const labels = programLabels(intent);
  const programTerms = textMatchesTokens(searchText, labels);
  const programMatched = labels.filter((label) => phraseMatch(searchText, label)
    || tokens(label).every((tokenValue) => tokens(searchText, { keepGeneric: true }).includes(tokenValue)));
  if (programMatched.length) {
    strong.program = { matched: true, terms: programMatched };
    evidence.push(evidenceRow("strong", "program_refs", programMatched, TEXT_FIELDS));
  } else strong.program = { matched: false, terms: programTerms };

  const projectTerms = projectLike(intent.object_text);
  const projectMatched = projectTerms.filter((term) => tokens(searchText, { keepGeneric: true }).includes(surface(term)));
  if (projectMatched.length) {
    strong.project = { matched: true, terms: projectMatched };
    evidence.push(evidenceRow("strong", "object_text", projectMatched, TEXT_FIELDS));
  } else strong.project = { matched: false, terms: [] };

  const quantityValues = intentQuantities(intent);
  const realizationNumbers = numberValues(snapshotValues(realization).flatMap((row) => flattenKnownValues(row, TEXT_FIELDS)));
  const quantityMatched = quantityValues.filter((value) => realizationNumbers.includes(value));
  if (quantityMatched.length) {
    strong.quantity = { matched: true, values: quantityMatched };
    evidence.push(evidenceRow("strong", "quantity_assertions", quantityMatched.map(String), TEXT_FIELDS));
  } else strong.quantity = { matched: false, values: [] };

  const populations = Array.isArray(intent.population_terms) ? intent.population_terms.filter(Boolean) : [];
  const populationMatched = populations.filter((value) => phraseMatch(searchText, value)
    || textMatchesTokens(searchText, [value]).length >= Math.min(2, tokens(value).length));
  if (populationMatched.length) {
    strong.population = { matched: true, terms: populationMatched };
    evidence.push(evidenceRow("strong", "population_terms", populationMatched, TEXT_FIELDS));
  } else strong.population = { matched: false, terms: [] };

  const objectTerms = tokens(intent.object_text);
  const objectMatched = textMatchesTokens(searchText, [intent.object_text]);
  if (objectMatched.length) {
    medium.service = { matched: true, terms: objectMatched };
    evidence.push(evidenceRow("medium", "object_text", objectMatched, TEXT_FIELDS));
  } else medium.service = { matched: false, terms: [] };

  medium.agency = {
    matched: Boolean(intentAgencyFamily && observedAgencyFamily && intentAgencyFamily === observedAgencyFamily),
    intent_family: intentAgencyFamily,
    realization_family: observedAgencyFamily,
  };
  if (medium.agency.matched) evidence.push(evidenceRow("medium", "responsible_agency_ref", [intentAgencyFamily], ["agency", "agency_name"]));

  const geographies = Array.isArray(intent.geography_refs) ? intent.geography_refs : [];
  const geographyMatched = textMatchesTokens(searchText, geographies);
  medium.geography = { matched: geographyMatched.length > 0, terms: geographyMatched };
  if (geographyMatched.length) evidence.push(evidenceRow("medium", "geography_refs", geographyMatched, TEXT_FIELDS));

  const moneyValues = intentMoney(intent);
  const moneyMatched = moneyValues.filter((value) => realizationNumbers.includes(value));
  medium.money = { matched: moneyMatched.length > 0, values: moneyMatched };
  if (moneyMatched.length) evidence.push(evidenceRow("medium", "money_assertions", moneyMatched.map(String), TEXT_FIELDS));

  medium.method = { matched: methodMatch(intent, searchText), requested: text(intent.procurement_type) || null };
  if (medium.method.matched) evidence.push(evidenceRow("medium", "procurement_type", [text(intent.procurement_type)], TEXT_FIELDS));

  const strongCount = [strong.program, strong.project, strong.quantity, strong.population].filter((row) => row.matched).length;
  const score = (strong.program.matched ? 5 : 0)
    + (strong.project.matched ? 4 : 0)
    + (strong.quantity.matched ? 5 : 0)
    + (strong.population.matched ? 4 : 0)
    + (medium.agency.matched ? 2 : 0)
    + (medium.service.matched ? 2 : 0)
    + (medium.geography.matched ? 1 : 0)
    + (medium.money.matched ? 2 : 0)
    + (medium.method.matched ? 1 : 0);
  const autoLink = medium.agency.matched && strongCount > 0 && score >= AUTO_LINK_MIN_SCORE;
  const matchConfidence = autoLink
    ? (strong.quantity.matched || strong.project.matched || strong.population.matched ? "extremely_high" : "high")
    : (score > 0 ? "ambiguous" : "unmatched");

  return {
    features_version: REALIZATION_MATCHER_VERSION,
    strong,
    medium,
    score,
    strong_evidence_count: strongCount,
    match_confidence: matchConfidence,
    decision: autoLink ? "auto_link" : "review",
    evidence,
    // This assertion is machine-readable proof that the feature set is not a
    // hindsight channel. It does not claim the source or realization is true.
    temporal_integrity: {
      feature_clock: "intent_fields_as_observed_at_only",
      excluded_fields: ["epin", "pin", "procurement_id", "vendor", "published_at"],
    },
    // Keep the variable intentionally used above: object terms are evidence
    // context, but generic overlap alone never auto-links a pair.
    object_term_count: objectTerms.length,
  };
}

function candidateFor(input, realization) {
  const intent = assertHistoricalIntent(input);
  const processRef = processRefFor(input);
  const ref = realizationRef(realization);
  const publishedAt = expectedPublicationDate(realization);
  if (!processRef) throw new TypeError("prospective process_ref is required");
  if (!ref || !publishedAt) return null;
  const from = text(intent.observed_at);
  const through = addMonths(from, REALIZATION_HORIZON_MONTHS);
  if (publishedAt < from || publishedAt > through) return null;
  const features = extractRealizationFeatures(input, realization);
  if (!features.medium.agency.matched) return null;
  return {
    candidate_id: `pir-realization-candidate:${processRef}::${ref}`,
    process_ref: processRef,
    realization_ref: ref,
    published_at: publishedAt,
    horizon: { from, through, months: REALIZATION_HORIZON_MONTHS },
    features,
    realization: {
      source_system: text(realization.source_system || realization.sourceSystem) || null,
      title: text(realization.title || realization.short_title || realization.procurement_name) || null,
      agency: text(realization.agency || realization.agency_name) || null,
      citation_url: text(realization.citation_url || realization.source_url || realization.url) || null,
    },
  };
}

/** Generate only same-agency, dated candidates in the bounded horizon. */
export function generateRealizationCandidates(input = {}, realizations = []) {
  const candidates = (Array.isArray(realizations) ? realizations : [])
    .map((realization) => candidateFor(input, realization))
    .filter(Boolean)
    .sort((a, b) => b.features.score - a.features.score
      || a.published_at.localeCompare(b.published_at)
      || a.realization_ref.localeCompare(b.realization_ref));
  return candidates;
}

function buildEvent(candidate) {
  return {
    event_id: candidate.realization_ref,
    subject_ref: candidate.process_ref,
    event_kind: PROSPECTIVE_EVENT_KIND,
    published_at: candidate.published_at,
  };
}

function buildEdge(candidate) {
  return {
    relation: "realized_by",
    from: candidate.process_ref,
    to: candidate.realization_ref,
    target_type: "procurement",
    status: "accepted",
    basis: "historical_realization_match",
    match_confidence: candidate.features.match_confidence,
    evidence: candidate.features.evidence,
  };
}

function timingOutcome(intent, firstDate) {
  const window = intent.expected_window;
  if (!window || (!window.earliest && !window.latest)) return "not_scored";
  return (!window.earliest || firstDate >= window.earliest)
      && (!window.latest || firstDate <= window.latest) ? "hit" : "miss";
}

function outcome(intent, acceptedCandidates, allCandidates, publicEdges) {
  const first = [...acceptedCandidates].sort((a, b) => a.published_at.localeCompare(b.published_at))[0];
  if (!first) {
    const hasReview = allCandidates.length > 0;
    return {
      status: hasReview ? "review" : "unmatched",
      occurrence: hasReview ? "unresolved" : "unmatched",
      timing: hasReview ? "unresolved" : "unmatched",
      lead_days: null,
      match_confidence: hasReview ? "ambiguous" : "unmatched",
      cardinality: { intent_count: 1, realized_count: 0, relation: "none" },
    };
  }
  return {
    status: "matched",
    occurrence: "hit",
    timing: timingOutcome(intent, first.published_at),
    lead_days: dayDifference(intent.observed_at, first.published_at),
    match_confidence: publicEdges.every((edge) => edge.match_confidence === "extremely_high")
      ? "extremely_high" : "high",
    cardinality: {
      intent_count: 1,
      realized_count: publicEdges.length,
      relation: publicEdges.length > 1 ? "one_to_many" : "one_to_one",
    },
  };
}

/** Match one PIR-2 process; ambiguous candidates never become public edges. */
export function matchHistoricalIntent(input = {}, realizations = []) {
  const intent = assertHistoricalIntent(input);
  const candidates = generateRealizationCandidates(input, realizations);
  const accepted = candidates.filter((candidate) => candidate.features.decision === "auto_link");
  const reviewCandidates = candidates.filter((candidate) => candidate.features.decision !== "auto_link");
  const publicEdges = accepted.map(buildEdge);
  return {
    schema: REALIZATION_MATCH_SCHEMA,
    matcher_version: REALIZATION_MATCHER_VERSION,
    process_ref: processRefFor(input),
    assertion_id: text(intent.assertion_id) || null,
    source_record_id: text(intent.source_record_id) || null,
    source_event_id: text(intent.source_event_id) || null,
    horizon: {
      from: intent.observed_at,
      through: addMonths(intent.observed_at, REALIZATION_HORIZON_MONTHS),
      months: REALIZATION_HORIZON_MONTHS,
      agency_family: intentAgency(intent),
    },
    candidates,
    review_candidates: reviewCandidates,
    realized_by: publicEdges,
    resolution_events: accepted.map(buildEvent),
    outcome: outcome(intent, accepted, candidates, publicEdges),
  };
}

/** Match all supplied processes without selecting between unrelated intents. */
export function matchHistoricalIntents(processes = [], realizations = []) {
  return (Array.isArray(processes) ? processes : []).map((process) => matchHistoricalIntent(process, realizations));
}
