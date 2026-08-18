import { loadOntologyRegistry } from "./load.mjs";

export const PROCUREMENT_POLICY_SCHEMA = "cityscroll.procurement_publication_policy_registry.v1";
export const PUBLICATION_OBLIGATIONS = Object.freeze(["required", "not_required", "unknown"]);
export const PROCUREMENT_POLICY_STAGES = Object.freeze(["solicitation", "award"]);

function fail(message) {
  throw new TypeError(`procurement policy registry: ${message}`);
}

function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function validateCitation(citation, familyId, stageId, registryVersion) {
  if (!citation || typeof citation !== "object") fail(`${familyId}.${stageId} requires legal_citation`);
  if (citation.rule !== "PPB Rule § 3-08") fail(`${familyId}.${stageId} must cite PPB Rule § 3-08`);
  if (!/^3-08/.test(citation.section || "")) fail(`${familyId}.${stageId} requires a 3-08 section`);
  if (!/^https:\/\/codelibrary\.amlegal\.com\//.test(citation.url || "")) {
    fail(`${familyId}.${stageId} requires the official rule URL`);
  }
  if (!/^effective-/.test(citation.rule_version || "")) {
    fail(`${familyId}.${stageId} requires a versioned rule citation`);
  }
  if (citation.rule_version !== registryVersion) {
    fail(`${familyId}.${stageId} citation must match registry version ${registryVersion}`);
  }
}

export function validateProcurementPolicyRegistry(registry) {
  if (!registry || typeof registry !== "object") fail("must be an object");
  if (registry.schema !== PROCUREMENT_POLICY_SCHEMA) fail(`expected schema ${PROCUREMENT_POLICY_SCHEMA}`);
  if (!registry.version) fail("requires version");
  if (!Array.isArray(registry.access_scopes) || !registry.access_scopes.includes("unknown")) {
    fail("access_scopes must be a closed list containing unknown");
  }
  if (!Array.isArray(registry.method_families)) fail("method_families must be an array");
  if (registry.coverage_state_boundary?.absence_default_publication_obligation !== "unknown") {
    fail("source absence must default to unknown");
  }

  const familyIds = new Set();
  for (const family of registry.method_families) {
    if (!family?.id || familyIds.has(family.id)) fail(`duplicate or missing method family ${family?.id || ""}`);
    familyIds.add(family.id);
    if (family.applicability?.requires_explicit_match !== true) {
      fail(`${family.id} must require an explicit applicability match`);
    }
    if (!validDate(family.effective_from)) fail(`${family.id} requires effective_from`);
    if (family.effective_to !== null && !validDate(family.effective_to)) {
      fail(`${family.id} has invalid effective_to`);
    }

    const stageIds = new Set();
    for (const stage of family.stages || []) {
      if (!PROCUREMENT_POLICY_STAGES.includes(stage.id) || stageIds.has(stage.id)) {
        fail(`${family.id} has invalid or duplicate stage ${stage.id}`);
      }
      stageIds.add(stage.id);
      if (!PUBLICATION_OBLIGATIONS.includes(stage.publication_obligation)) {
        fail(`${family.id}.${stage.id} has invalid publication_obligation`);
      }
      if (!registry.access_scopes.includes(stage.access_scope)) {
        fail(`${family.id}.${stage.id} has invalid access_scope`);
      }
      if (!validDate(stage.effective_from)) fail(`${family.id}.${stage.id} requires effective_from`);
      if (stage.effective_to !== null && !validDate(stage.effective_to)) {
        fail(`${family.id}.${stage.id} has invalid effective_to`);
      }
      validateCitation(stage.legal_citation, family.id, stage.id, registry.version);
      if (stage.publication_obligation === "not_required"
        && family.applicability.requires_explicit_match !== true) {
        fail(`${family.id}.${stage.id} cannot assert not_required without explicit policy matching`);
      }
    }
    if (stageIds.size !== PROCUREMENT_POLICY_STAGES.length) {
      fail(`${family.id} must define solicitation and award stages`);
    }
  }
  return true;
}

function dateWithin(value, from, to) {
  return validDate(value) && value >= from && (to === null || value <= to);
}

function amountWithin(amount, band) {
  if (!Number.isFinite(amount)) return false;
  if (band.minimum !== null) {
    if (band.minimum_inclusive ? amount < band.minimum : amount <= band.minimum) return false;
  }
  if (band.maximum !== null) {
    if (band.maximum_inclusive ? amount > band.maximum : amount >= band.maximum) return false;
  }
  return true;
}

function applicabilityMatches(record, family) {
  if (!dateWithin(record.occurred_on, family.effective_from, family.effective_to)) return false;
  if (family.applicability.excluded_categories?.includes(record.procurement_category)) return false;
  const band = family.applicability.amount_bands?.find(
    ({ procurement_category }) => procurement_category === record.procurement_category,
  );
  return Boolean(band && amountWithin(record.amount, band));
}

function unknownResult(record, policyMatch = "unmatched") {
  return {
    policy_match: policyMatch,
    publication_obligation: "unknown",
    access_scope: "unknown",
    coverage_state: record?.coverage_state || "unknown",
  };
}

export function resolveProcurementPublicationPolicy(
  record,
  stageId,
  registry = loadOntologyRegistry().procurement_policy_registry,
) {
  validateProcurementPolicyRegistry(registry);
  if (!record || !PROCUREMENT_POLICY_STAGES.includes(stageId)) return unknownResult(record);

  // Publisher labels are evidence, not policy identity. A caller must first map an
  // exact method family; arbitrary source strings and source absence never select
  // a legal exemption.
  const family = registry.method_families.find(({ id }) => id === record.method_family);
  if (!family) return unknownResult(record);
  const stage = family.stages.find(({ id }) => id === stageId);
  if (family.id === "unmapped_publisher_variant") {
    return {
      ...stage,
      policy_match: "unmapped",
      method_family: family.id,
      coverage_state: record.coverage_state || "unknown",
    };
  }
  if (!applicabilityMatches(record, family)
    || !dateWithin(record.occurred_on, stage.effective_from, stage.effective_to)) {
    return unknownResult(record);
  }

  return {
    ...stage,
    policy_match: "matched",
    method_family: family.id,
    coverage_state: record.coverage_state || "unknown",
  };
}
