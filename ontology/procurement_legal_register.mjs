// Procurement legal register: one cited, dated record of what CityScroll believes
// about NYC procurement law (ontology/procurement_legal_register.v1.json).
//
// Bitemporal and append-only. A change in law closes an entry (effective_to) and
// adds a successor naming `supersedes`; a corrected reading adds a higher
// record_version of the same id. Evaluation is three-valued: a missing fact, an
// unmodelled condition or an unestablished effective date yields "unknown",
// never applies / does-not-apply.
//
// PPB 3-08 dollar bands keep one numeric home: the procurement_policy_registry in
// ontology/registry.v0.json. Entries point there with `realized_by` and read
// numbers through `{registry_field: [...]}` effect values. The policy registry and
// retained source texts are injected by the caller; this module imports no other
// engine module.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const PROCUREMENT_LEGAL_REGISTER_SCHEMA = "cityscroll.procurement_legal_register.v1";
export const PROCUREMENT_LEGAL_REGISTER_RELATIVE = "ontology/procurement_legal_register.v1.json";
export const LEGAL_POLICY_REGISTRY_ID = "procurement_policy_registry";

export const LEGAL_RULE_KINDS = Object.freeze([
  "threshold", "program_scope", "eligibility", "method_definition", "timeline",
  "certification", "vocabulary_mapping", "explanatory_copy", "heuristic",
]);
export const LEGAL_JURISDICTIONS = Object.freeze(["nyc", "nys", "federal"]);
export const LEGAL_INSTRUMENTS = Object.freeze([
  "charter", "admin_code", "rcny", "state_law", "local_law", "agency_guidance", "none",
]);
export const LEGAL_REVIEW_STATUSES = Object.freeze(["unreviewed", "source_checked", "practitioner_reviewed"]);
export const LEGAL_EVALUATION_STATES = Object.freeze(["applies", "does_not_apply", "unknown"]);
export const LEGAL_DIVERGENCE_KINDS = Object.freeze(["effective_date", "value", "consumer_semantics", "vocabulary"]);

// Closed facts vocabulary. method_family values are policy-registry family ids.
export const LEGAL_FACT_VOCABULARY = Object.freeze({
  procurement_category: Object.freeze(["goods", "standard_services", "professional_services", "construction", "human_services"]),
  awardee_legal_form: Object.freeze(["for_profit", "not_for_profit"]),
  method_family: "policy_registry_family",
  amount: "usd",
  occurred_on: "date",
  funding_constraint: Object.freeze(["none", "federal_or_state_precludes_goals", "own_federal_state_mbe_requirements"]),
  procurement_basis: Object.freeze(["competitive", "emergency", "sole_source", "intergovernmental", "government_schedule"]),
});

// Closed effect vocabulary: key -> allowed literal values, or a value type.
export const LEGAL_EFFECT_KEYS = Object.freeze({
  mwbe_participation_requirement: Object.freeze(["not_applicable"]),
  agency_mwbe_outreach_duty: Object.freeze(["applies"]),
  section_6_129_industry_classification: Object.freeze(["same_as_procurement_category", "none"]),
  defines_term: Object.freeze(["human_services"]),
  term_alias: Object.freeze(["client_services_is_human_services"]),
  default_time_unit: Object.freeze(["calendar_days"]),
  ppb_source_selection_requirements: Object.freeze(["not_applicable"]),
  default_procurement_channel: Object.freeze(["hhs_accelerator_prequalified_solicitation"]),
  public_solicitation_notice: Object.freeze(["not_required"]),
  mwbe_small_purchase_method_available: Object.freeze(["no"]),
  small_purchase_limit_usd: "usd",
  mwbe_small_purchase_max_usd: "usd",
  micropurchase_max_usd_goods_and_services: "usd",
  micropurchase_max_usd_construction: "usd",
  city_record_coverage_min_usd: "usd",
  award_notice_deadline_days_after_registration: "days",
  minimum_response_calendar_days: "days",
  minimum_response_business_days: "days",
  detection_rule: Object.freeze([
    "explicit_section_6_129_citation",
    "ppb_token_implies_section_3_08",
    "exact_normalized_publisher_label",
    "any_category_band_when_category_missing",
  ]),
  consumer_duplicates_registry: Object.freeze(["amount_bands_and_effective_from"]),
  copy_claim: Object.freeze(["no_public_solicitation_required", "mwbe_award_notice_expected", "subcontract_goal_not_published"]),
  subcontract_window: Object.freeze(["candidate_for_any_award_with_resolved_prime"]),
  publisher_category_label: "label",
});

const REVIEW_RANK = Object.freeze({ unreviewed: 0, source_checked: 1, practitioner_reviewed: 2 });
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)+$/;
const SUPERSEDES_PATTERN = /^([a-z0-9][a-z0-9_.-]*)@([1-9][0-9]*)$/;
const CONDITION_PATTERN = /^[a-z][a-z0-9_]*$/;
const REQUIRED_FIELDS = Object.freeze([
  "id", "record_version", "statement", "kind", "jurisdiction", "authority", "applies_when", "effect",
  "effective_from", "effective_to", "in_force_as_of", "recorded_at", "supersedes", "review", "consumers", "notes",
]);

function fail(message) {
  throw new TypeError(`procurement legal register: ${message}`);
}

function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function sha256Hex(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

export function normalizeLegalText(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

export function loadProcurementLegalRegister(
  path = new URL("./procurement_legal_register.v1.json", import.meta.url),
) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function ref(entry) {
  return `${entry?.id}@${entry?.record_version}`;
}

function isRegistryRef(value) {
  return Boolean(value) && typeof value === "object" && Array.isArray(value.registry_field);
}

function pointersOf(entry) {
  if (entry.realized_by == null) return [];
  return Array.isArray(entry.realized_by) ? entry.realized_by : [entry.realized_by];
}

function resolvePointer(pointer, policyRegistry, where) {
  if (!pointer || typeof pointer !== "object") fail(`${where} realized_by must be an object`);
  if (pointer.registry !== LEGAL_POLICY_REGISTRY_ID) {
    fail(`${where} realized_by must name registry ${LEGAL_POLICY_REGISTRY_ID}`);
  }
  if (!policyRegistry || !Array.isArray(policyRegistry.method_families)) {
    fail(`${where} realized_by needs an injected policyRegistry`);
  }
  const family = policyRegistry.method_families.find(({ id }) => id === pointer.family);
  if (!family) fail(`${where} realized_by family ${pointer.family} does not resolve in the policy registry`);
  if (pointer.stage == null) return family;
  const stage = (family.stages || []).find(({ id }) => id === pointer.stage);
  if (!stage) fail(`${where} realized_by stage ${pointer.family}.${pointer.stage} does not resolve in the policy registry`);
  return stage;
}

function walkPath(root, path, where) {
  let node = root;
  for (const step of path) {
    if (typeof step === "string") {
      node = node?.[step];
    } else if (step && typeof step === "object" && !Array.isArray(step) && Object.keys(step).length === 1) {
      const [key, value] = Object.entries(step)[0];
      node = Array.isArray(node) ? node.find((item) => item?.[key] === value) : undefined;
    } else {
      fail(`${where} has an invalid registry_field step`);
    }
    if (node === undefined) fail(`${where} registry_field ${JSON.stringify(path)} does not resolve`);
  }
  return node;
}

function resolveRegistryValue(entry, value, policyRegistry, where) {
  const pointers = pointersOf(entry);
  if (pointers.length !== 1) fail(`${where} registry_field requires exactly one realized_by pointer`);
  return walkPath(resolvePointer(pointers[0], policyRegistry, where), value.registry_field, where);
}

function checkEffectValue(key, value, where) {
  const type = LEGAL_EFFECT_KEYS[key];
  if (type === undefined) fail(`${where} has unknown effect key ${key}`);
  if (Array.isArray(type)) {
    if (!type.includes(value)) fail(`${where} effect ${key} has unknown vocabulary value ${JSON.stringify(value)}`);
  } else if (type === "usd" || type === "days") {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      fail(`${where} effect ${key} must be a non-negative number`);
    }
    if (type === "days" && !Number.isInteger(value)) fail(`${where} effect ${key} must be whole days`);
  } else if (type === "label") {
    if (!nonEmpty(value)) fail(`${where} effect ${key} must be a non-empty label`);
  }
}

function checkCondition(fact, condition, where, familyIds) {
  const vocabulary = LEGAL_FACT_VOCABULARY[fact];
  if (vocabulary === undefined) fail(`${where} applies_when uses unknown fact ${fact}`);
  if (fact === "occurred_on") fail(`${where} applies_when must not use occurred_on; use effective_from/effective_to`);
  if (fact === "amount") {
    if (!condition || typeof condition !== "object" || Array.isArray(condition)) {
      fail(`${where} amount condition must be an object of gt/gte/lt/lte`);
    }
    for (const [op, bound] of Object.entries(condition)) {
      if (!["gt", "gte", "lt", "lte"].includes(op) || !Number.isFinite(bound)) {
        fail(`${where} amount condition has invalid ${op}`);
      }
    }
    return;
  }
  if (!Array.isArray(condition) || condition.length === 0) fail(`${where} applies_when ${fact} must be a non-empty list`);
  for (const value of condition) {
    const allowed = vocabulary === "policy_registry_family" ? familyIds : vocabulary;
    if (allowed && !allowed.includes(value)) {
      fail(`${where} applies_when ${fact} has unknown vocabulary value ${JSON.stringify(value)}`);
    }
  }
}

function checkQuote(entry, field, sources, catalog, where) {
  const quote = entry.authority[field];
  const digest = entry.authority[`${field}_sha256`];
  if (!nonEmpty(quote)) fail(`${where} source_checked requires authority.${field}`);
  if (digest !== sha256Hex(quote)) fail(`${where} authority.${field}_sha256 does not match the ${field}`);
  const file = entry.authority.source_file;
  const text = sources?.[file];
  if (typeof text !== "string") fail(`${where} source file ${file} was not supplied to the validator`);
  if (sha256Hex(text) !== catalog[file].sha256) fail(`${where} source file ${file} hash does not match the register catalog`);
  if (!normalizeLegalText(text).includes(normalizeLegalText(quote))) {
    fail(`${where} authority.${field} does not occur in source file ${file}`);
  }
}

function intervalsOverlap(a, b) {
  const aFrom = a.effective_from ?? "0000-01-01";
  const bFrom = b.effective_from ?? "0000-01-01";
  const aTo = a.effective_to ?? "9999-12-31";
  const bTo = b.effective_to ?? "9999-12-31";
  return aFrom < bTo && bFrom < aTo;
}

// Two entries describe the same subject when they set the same effect keys (and
// the same values for vocabulary keys; numbers and labels may change over time)
// under the same conditions.
function subjectKey(entry) {
  return JSON.stringify([
    Object.keys(entry.effect).sort().map((key) => (
      Array.isArray(LEGAL_EFFECT_KEYS[key]) ? `${key}=${entry.effect[key]}` : key
    )),
    Object.keys(entry.applies_when).sort().map((k) => [k, entry.applies_when[k]]),
    [...(entry.unmodelled_conditions || [])].sort(),
  ]);
}

/** Latest record_version per id. */
function latestById(entries) {
  const latest = new Map();
  for (const entry of entries) {
    const prior = latest.get(entry.id);
    if (!prior || entry.record_version > prior.record_version) latest.set(entry.id, entry);
  }
  return latest;
}

export function validateLegalRegister(register, { policyRegistry, sources } = {}) {
  if (!register || typeof register !== "object") fail("must be an object");
  if (register.schema !== PROCUREMENT_LEGAL_REGISTER_SCHEMA) fail(`expected schema ${PROCUREMENT_LEGAL_REGISTER_SCHEMA}`);
  if (!nonEmpty(register.version)) fail("requires version");
  if (!Array.isArray(register.entries) || register.entries.length === 0) fail("entries must be a non-empty array");
  const catalog = register.sources?.files;
  if (!catalog || typeof catalog !== "object") fail("sources.files catalog is required");
  if (!nonEmpty(register.sources.root)) fail("sources.root is required");
  if (!Array.isArray(register.known_divergences)) fail("known_divergences must be an array");
  const familyIds = policyRegistry?.method_families?.map(({ id }) => id) || null;

  const seen = new Set();
  for (const entry of register.entries) {
    const where = `entry ${ref(entry)}`;
    for (const field of REQUIRED_FIELDS) {
      if (!(field in (entry || {}))) fail(`${where} is missing ${field}`);
    }
    if (!ID_PATTERN.test(entry.id)) fail(`${where} id must be dotted lower-case`);
    if (!Number.isInteger(entry.record_version) || entry.record_version < 1) fail(`${where} record_version must be a positive integer`);
    const key = ref(entry);
    if (seen.has(key)) fail(`duplicate entry id+record_version ${key}`);
    seen.add(key);
    if (!nonEmpty(entry.statement)) fail(`${where} requires a statement`);
    if (!LEGAL_RULE_KINDS.includes(entry.kind)) fail(`${where} has unknown kind ${entry.kind}`);
    if (!LEGAL_JURISDICTIONS.includes(entry.jurisdiction)) fail(`${where} has unknown jurisdiction ${entry.jurisdiction}`);

    const authority = entry.authority;
    if (!authority || typeof authority !== "object") fail(`${where} requires authority`);
    if (!LEGAL_INSTRUMENTS.includes(authority.instrument)) fail(`${where} has unknown authority.instrument ${authority.instrument}`);
    if (!nonEmpty(authority.section)) fail(`${where} requires authority.section`);
    if (authority.source_file != null && !catalog[authority.source_file]) {
      fail(`${where} source_file ${authority.source_file} is not in the sources catalog`);
    }
    if (authority.source_file != null && authority.source_sha256 !== catalog[authority.source_file].sha256) {
      fail(`${where} authority.source_sha256 does not match the sources catalog`);
    }

    if (!validDate(entry.recorded_at)) fail(`${where} requires recorded_at date`);
    if (!validDate(entry.in_force_as_of)) fail(`${where} requires in_force_as_of date`);
    if (entry.effective_from !== null && !validDate(entry.effective_from)) fail(`${where} has invalid effective_from`);
    if (entry.effective_to !== null && !validDate(entry.effective_to)) fail(`${where} has invalid effective_to`);
    if (entry.effective_from === null && !nonEmpty(entry.effective_from_basis)) {
      fail(`${where} requires effective_from_basis when effective_from is null`);
    }
    if (entry.effective_from && entry.effective_to && entry.effective_to <= entry.effective_from) {
      fail(`${where} effective_to must be after effective_from`);
    }
    if ((entry.effective_from && entry.in_force_as_of < entry.effective_from)
      || (entry.effective_to && entry.in_force_as_of >= entry.effective_to)) {
      fail(`${where} in_force_as_of must fall inside its effective interval`);
    }
    if (entry.supersedes !== null && !SUPERSEDES_PATTERN.test(entry.supersedes)) fail(`${where} supersedes must be id@version or null`);

    const review = entry.review;
    if (!review || !LEGAL_REVIEW_STATUSES.includes(review.status)) fail(`${where} has unknown review.status`);
    if (review.status === "practitioner_reviewed" && (!nonEmpty(review.by) || !validDate(review.on))) {
      fail(`${where} practitioner_reviewed requires a named reviewer and review date`);
    }
    if (review.status === "source_checked") {
      if (!authority.source_file) fail(`${where} source_checked requires authority.source_file`);
      if (!nonEmpty(authority.source_sha256)) fail(`${where} source_checked requires authority.source_sha256`);
      checkQuote(entry, "quote", sources, catalog, where);
      if (authority.context_quote != null) checkQuote(entry, "context_quote", sources, catalog, where);
    }

    if (!Array.isArray(entry.consumers) || entry.consumers.some((c) => !nonEmpty(c))) {
      fail(`${where} consumers must be a list of paths`);
    }
    if (!entry.applies_when || typeof entry.applies_when !== "object" || Array.isArray(entry.applies_when)) {
      fail(`${where} applies_when must be an object`);
    }
    for (const [fact, condition] of Object.entries(entry.applies_when)) checkCondition(fact, condition, where, familyIds);
    for (const condition of entry.unmodelled_conditions || []) {
      if (!CONDITION_PATTERN.test(condition)) fail(`${where} unmodelled condition ${condition} must be snake_case`);
    }

    if (!entry.effect || typeof entry.effect !== "object" || Object.keys(entry.effect).length === 0) {
      fail(`${where} requires a non-empty effect`);
    }
    const pointers = pointersOf(entry);
    for (const pointer of pointers) resolvePointer(pointer, policyRegistry, where);
    if (authority.instrument === "rcny" && /^9 RCNY 3-08\(/.test(authority.section) && pointers.length === 0) {
      fail(`${where} PPB 3-08 entries must carry realized_by`);
    }
    for (const [effectKey, value] of Object.entries(entry.effect)) {
      const type = LEGAL_EFFECT_KEYS[effectKey];
      if (isRegistryRef(value)) {
        const resolved = resolveRegistryValue(entry, value, policyRegistry, `${where} effect ${effectKey}`);
        checkEffectValue(effectKey, resolved, `${where} (resolved)`);
      } else {
        if ((type === "usd" || type === "days") && pointers.length > 0) {
          fail(`${where} effect ${effectKey} duplicates a number owned by the policy registry; use registry_field`);
        }
        checkEffectValue(effectKey, value, where);
      }
    }

    if (entry.corresponds_to != null) {
      const { field, ...pointer } = entry.corresponds_to;
      if (!Array.isArray(field)) fail(`${where} corresponds_to requires field`);
      const family = resolvePointer({ ...pointer, stage: undefined }, policyRegistry, `${where} corresponds_to`);
      const registryValue = walkPath(family, field, `${where} corresponds_to`);
      const values = Object.values(entry.effect).filter((v) => !isRegistryRef(v));
      if (!values.includes(registryValue)) fail(`${where} corresponds_to value ${registryValue} differs from the entry effect`);
      const listed = register.known_divergences.some((d) => d.kind === "effective_date" && d.entry_ids?.includes(entry.id));
      if (family.effective_from !== entry.effective_from && !listed) {
        fail(`${where} effective_from differs from policy registry ${pointer.family} without a known_divergences item`);
      }
    }
  }

  // Record versions: contiguous, recorded in order.
  const byId = new Map();
  for (const entry of register.entries) {
    if (!byId.has(entry.id)) byId.set(entry.id, []);
    byId.get(entry.id).push(entry);
  }
  for (const [id, versions] of byId) {
    versions.sort((a, b) => a.record_version - b.record_version);
    versions.forEach((entry, index) => {
      if (entry.record_version !== index + 1) fail(`entry ${id} record_versions must be contiguous from 1`);
      if (index > 0 && entry.recorded_at < versions[index - 1].recorded_at) {
        fail(`entry ${ref(entry)} recorded_at precedes an earlier record_version`);
      }
    });
  }

  // Supersession and in-place overlap (current reading of each id).
  const latest = latestById(register.entries);
  for (const entry of latest.values()) {
    if (entry.supersedes === null) continue;
    const [, targetId, targetVersion] = SUPERSEDES_PATTERN.exec(entry.supersedes);
    if (!seen.has(`${targetId}@${targetVersion}`)) fail(`entry ${ref(entry)} supersedes unknown ${entry.supersedes}`);
    const target = latest.get(targetId);
    if (target.effective_to === null || entry.effective_from === null || target.effective_to > entry.effective_from) {
      fail(`overlapping in-force intervals: ${ref(entry)} supersedes ${ref(target)} without a closed earlier interval`);
    }
  }
  const current = [...latest.values()];
  for (let i = 0; i < current.length; i += 1) {
    for (let j = i + 1; j < current.length; j += 1) {
      if (subjectKey(current[i]) === subjectKey(current[j]) && intervalsOverlap(current[i], current[j])) {
        fail(`overlapping in-force intervals: ${ref(current[i])} and ${ref(current[j])} assert the same effect in place`);
      }
    }
  }

  for (const divergence of register.known_divergences) {
    if (!nonEmpty(divergence?.id) || !LEGAL_DIVERGENCE_KINDS.includes(divergence.kind) || !nonEmpty(divergence.statement)) {
      fail(`known divergence ${divergence?.id} requires id, kind and statement`);
    }
    for (const id of divergence.entry_ids || []) {
      if (!byId.has(id)) fail(`known divergence ${divergence.id} names unknown entry ${id}`);
    }
  }
  return true;
}

/** What the register believed on `recordedDate`: latest record_version recorded by then. */
export function registerKnownAsOf(register, recordedDate) {
  if (!validDate(recordedDate)) fail("registerKnownAsOf requires a date");
  const known = register.entries.filter((entry) => entry.recorded_at <= recordedDate);
  return { ...register, known_as_of: recordedDate, entries: [...latestById(known).values()] };
}

function temporalState(entry, asOf) {
  if (entry.effective_to !== null && asOf >= entry.effective_to) return "not_in_force";
  if (entry.effective_from !== null) return asOf >= entry.effective_from ? "in_force" : "not_in_force";
  return asOf >= entry.in_force_as_of ? "in_force" : "unknown";
}

/** Current reading of each entry, split by its legal-time state on `date`. */
export function registerAsOf(register, date) {
  if (!validDate(date)) fail("registerAsOf requires a date");
  const in_force = [];
  const indeterminate = [];
  for (const entry of latestById(register.entries).values()) {
    const state = temporalState(entry, date);
    if (state === "in_force") in_force.push(entry);
    if (state === "unknown") indeterminate.push(entry);
  }
  return { schema: register.schema, version: register.version, as_of: date, in_force, indeterminate };
}

function checkFacts(facts, policyRegistry) {
  if (!facts || typeof facts !== "object" || Array.isArray(facts)) fail("facts must be an object");
  for (const [fact, value] of Object.entries(facts)) {
    const vocabulary = LEGAL_FACT_VOCABULARY[fact];
    if (vocabulary === undefined) fail(`unknown fact ${fact}`);
    if (value == null) continue;
    if (Array.isArray(vocabulary) && !vocabulary.includes(value)) fail(`fact ${fact} has unknown vocabulary value ${JSON.stringify(value)}`);
    if (vocabulary === "usd" && !Number.isFinite(value)) fail(`fact ${fact} must be a number`);
    if (vocabulary === "date" && !validDate(value)) fail(`fact ${fact} must be a date`);
    if (vocabulary === "policy_registry_family") {
      const ids = policyRegistry?.method_families?.map(({ id }) => id);
      if (ids ? !ids.includes(value) : !CONDITION_PATTERN.test(value)) fail(`fact ${fact} has unknown vocabulary value ${JSON.stringify(value)}`);
    }
  }
}

function conditionHolds(fact, condition, value) {
  if (fact === "amount") {
    return Object.entries(condition).every(([op, bound]) => (
      op === "gt" ? value > bound : op === "gte" ? value >= bound : op === "lt" ? value < bound : value <= bound
    ));
  }
  return condition.includes(value);
}

function evaluateEntry(entry, facts, asOf) {
  const temporal = temporalState(entry, asOf);
  const missing = [];
  let failed = false;
  for (const [fact, condition] of Object.entries(entry.applies_when)) {
    if (facts[fact] == null) missing.push(fact);
    else if (!conditionHolds(fact, condition, facts[fact])) failed = true;
  }
  const base = {
    rule_id: entry.id,
    record_version: entry.record_version,
    kind: entry.kind,
    review_status: entry.review.status,
    effect: entry.effect,
    temporal,
    missing_facts: [],
  };
  if (failed) return { ...base, status: "does_not_apply" };
  const unknownBecause = [...missing, ...(entry.unmodelled_conditions || []).map((c) => `unmodelled:${c}`)];
  if (temporal === "unknown") unknownBecause.push(`effective_from_before:${entry.in_force_as_of}`);
  if (unknownBecause.length > 0) return { ...base, status: "unknown", missing_facts: unknownBecause };
  return { ...base, status: "applies" };
}

function asOfDate(facts, asOf) {
  const date = asOf ?? facts?.occurred_on ?? null;
  if (date !== null && !validDate(date)) fail("asOf must be a date");
  return date;
}

/** Evaluate every entry not out of force on the as-of date (asOf, else facts.occurred_on). */
export function resolveLegalRules(facts, { asOf, register, policyRegistry } = {}) {
  checkFacts(facts, policyRegistry);
  const date = asOfDate(facts, asOf);
  const entries = [...latestById(register.entries).values()];
  if (date === null) {
    return {
      as_of: null,
      results: entries.map((entry) => ({ ...evaluateEntry(entry, facts, "9999-12-31"), status: "unknown", temporal: "unknown", missing_facts: ["occurred_on"] })),
    };
  }
  const results = entries
    .filter((entry) => temporalState(entry, date) !== "not_in_force")
    .map((entry) => evaluateEntry(entry, facts, date));
  return { as_of: date, results };
}

function weakestReview(results) {
  if (results.length === 0) return null;
  return results.reduce((weakest, r) => (REVIEW_RANK[r.review_status] < REVIEW_RANK[weakest] ? r.review_status : weakest),
    results[0].review_status);
}

/**
 * One effect for a set of facts on a date: { value | "unknown" | null, rule_ids, ... }.
 * null means rules for this key are in force but none applies; "unknown" means a
 * fact, condition or date is missing, rules conflict, or no rule is in force.
 */
export function effectFor(facts, effectKey, { asOf, register, policyRegistry } = {}) {
  if (LEGAL_EFFECT_KEYS[effectKey] === undefined) fail(`unknown effect key ${effectKey}`);
  const { as_of, results } = resolveLegalRules(facts, { asOf, register, policyRegistry });
  const relevant = results.filter((r) => effectKey in r.effect);
  const entries = latestById(register.entries);
  const result = (fields) => ({ effect_key: effectKey, as_of, rule_ids: [], unknown_rule_ids: [], missing_facts: [], review_status: null, reason: null, ...fields });
  if (relevant.length === 0) return result({ value: "unknown", reason: "no_rule_in_force" });

  const applied = relevant.filter((r) => r.status === "applies");
  const unknown = relevant.filter((r) => r.status === "unknown");
  const unknown_rule_ids = unknown.map((r) => r.rule_id);
  const missing_facts = [...new Set(unknown.flatMap((r) => r.missing_facts))];
  if (applied.length > 0) {
    const values = applied.map((r) => {
      const raw = r.effect[effectKey];
      return isRegistryRef(raw)
        ? resolveRegistryValue(entries.get(r.rule_id), raw, policyRegistry, `entry ${r.rule_id} effect ${effectKey}`)
        : raw;
    });
    const distinct = [...new Set(values)];
    return result({
      value: distinct.length === 1 ? distinct[0] : "unknown",
      reason: distinct.length === 1 ? "rule_applies" : "conflicting_rules",
      rule_ids: applied.map((r) => r.rule_id),
      unknown_rule_ids,
      missing_facts,
      review_status: weakestReview(applied),
    });
  }
  if (unknown.length > 0) {
    return result({ value: "unknown", reason: "rule_status_unknown", unknown_rule_ids, missing_facts, review_status: weakestReview(unknown) });
  }
  return result({ value: null, reason: "no_rule_applies", review_status: weakestReview(relevant) });
}
