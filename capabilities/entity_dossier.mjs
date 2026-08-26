// Transport-neutral contract for one bounded public entity dossier lookup.
// The existing public serializer remains the redaction/provenance authority;
// delivery adapters own HTTP status, cache headers, and representation bytes.

export const ENTITY_DOSSIER_CAPABILITY_ID = "entity.dossier.get";
export const ENTITY_DOSSIER_CAPABILITY_VERSION = "1.0.0";
export const ENTITY_DOSSIER_CAPABILITY_REFERENCE = "entity.dossier.get@1";
export const ENTITY_DOSSIER_PROVIDER_ID = "worker-d1.entity-dossier";
export const ENTITY_DOSSIER_PUBLIC_SCHEMA_VERSION = "public_entity_dossier_v1";
export const ENTITY_DOSSIER_LIMITS = Object.freeze({
  entityIdMaximumLength: 300,
  recordLimit: 250,
});
export const ENTITY_DOSSIER_AVAILABILITY = Object.freeze([
  "available",
  "not_yet_public",
  "unavailable",
]);
export const ENTITY_DOSSIER_REPRESENTATIONS = Object.freeze([
  Object.freeze({
    id: "json",
    mediaType: "application/json",
    projection: "public dossier object",
  }),
  Object.freeze({
    id: "html",
    mediaType: "text/html",
    projection: "existing attributed dossier document",
  }),
]);

const PRIVATE_FIELD_NAMES = new Set([
  "raw_snapshot",
  "normalized_snapshot",
  "content_hash",
  "source_record_id",
  "link_confidence_score",
  "matcher_version",
  "evidence_json",
  "resolution_run_id",
  "review_status",
]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const ENTITY_DOSSIER_CAPABILITY = deepFreeze({
  id: ENTITY_DOSSIER_CAPABILITY_ID,
  version: ENTITY_DOSSIER_CAPABILITY_VERSION,
  reference: ENTITY_DOSSIER_CAPABILITY_REFERENCE,
  owner: "entity-resolution",
  operation: "read",
  authority: {
    class: "public-read",
    sideEffect: "none",
    approval: "none",
    redaction: "public dossier serializer allowlist",
  },
  cost: {
    class: "bounded-d1-read",
    machineFanOut: "low",
  },
  bounds: {
    input: ENTITY_DOSSIER_LIMITS,
    output: { maximumLinkedRecords: ENTITY_DOSSIER_LIMITS.recordLimit },
  },
  input: {
    schema: "cityscroll.capability.entity_dossier_get.input.v1",
    identity: "exact canonical entity id",
    limits: ENTITY_DOSSIER_LIMITS,
  },
  output: {
    schema: "cityscroll.capability.entity_dossier_get.output.v1",
    dossierSchema: ENTITY_DOSSIER_PUBLIC_SCHEMA_VERSION,
    fields: ["capability_reference", "availability", "dossier", "error"],
    availability: ENTITY_DOSSIER_AVAILABILITY,
    representations: ENTITY_DOSSIER_REPRESENTATIONS,
    privateFieldsForbidden: [...PRIVATE_FIELD_NAMES],
  },
  provenance: {
    entityIdentity: "entity.id",
    sourceIdentity: "linked_records[].source + assertions[].provenance.source",
    observationClock: "scope.observed_from + scope.observed_through",
    disagreementsPreserved: true,
  },
  freshness: {
    owner: "D1 entity-resolution read model",
    projection: "public serializer and adapter-owned representation",
  },
  examples: [
    {
      input: { entityId: "vendor:stem:ACME CONSTRUCTION" },
      output: { availability: "available", maximumLinkedRecords: ENTITY_DOSSIER_LIMITS.recordLimit },
    },
    {
      input: { entityId: "vendor:unknown" },
      output: { availability: "not_yet_public", error: "not-found" },
    },
  ],
  provider: {
    id: ENTITY_DOSSIER_PROVIDER_ID,
    module: "worker/src/entity_dossier.mjs",
    export: "workerD1EntityDossier",
    store: "Cloudflare D1",
    readModel: "canonical entities plus accepted source-record links",
  },
  adapters: [
    {
      id: "worker-http.entity-dossier@1",
      module: "worker/src/entity_dossier.mjs",
      kind: "http-route",
      route: "GET /entity-dossier",
      surface: "Entity dossier",
      representations: ENTITY_DOSSIER_REPRESENTATIONS,
    },
    {
      id: "mcp.get_entity_dossier@1",
      module: "worker/src/mcp.mjs",
      kind: "mcp-tool",
      tool: "get_entity_dossier",
      route: "POST /mcp",
      surface: "MCP",
    },
  ],
});

function assertNoPrivateFields(value, path = "output") {
  if (!value || typeof value !== "object") return;
  for (const [field, child] of Object.entries(value)) {
    if (PRIVATE_FIELD_NAMES.has(field)) {
      throw new TypeError(`entity.dossier output exposes private field: ${path}.${field}`);
    }
    assertNoPrivateFields(child, `${path}.${field}`);
  }
}

export function validateEntityDossierInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("entity.dossier.get input must be an object");
  }
  const fields = Object.keys(input);
  if (fields.length !== 1 || fields[0] !== "entityId") {
    throw new TypeError("entity.dossier.get accepts only entityId");
  }
  if (
    typeof input.entityId !== "string"
    || !input.entityId.trim()
    || input.entityId.length > ENTITY_DOSSIER_LIMITS.entityIdMaximumLength
  ) {
    throw new TypeError("entityId must be a non-empty bounded string");
  }
  return input;
}

function validatePublicDossier(dossier, entityId) {
  if (!dossier || typeof dossier !== "object" || Array.isArray(dossier)) {
    throw new TypeError("available entity.dossier output requires a dossier");
  }
  if (dossier.version !== ENTITY_DOSSIER_PUBLIC_SCHEMA_VERSION) {
    throw new TypeError("entity.dossier public schema version drifted");
  }
  if (dossier.entity?.id !== entityId || !dossier.entity?.type || !dossier.entity?.name) {
    throw new TypeError("entity.dossier identity must match the exact requested entity");
  }
  if (!dossier.scope || dossier.scope.record_limit !== ENTITY_DOSSIER_LIMITS.recordLimit) {
    throw new TypeError("entity.dossier record limit drifted");
  }
  if (!Array.isArray(dossier.linked_records)
      || dossier.linked_records.length > ENTITY_DOSSIER_LIMITS.recordLimit) {
    throw new TypeError("entity.dossier linked records exceed the declared bound");
  }
  if (!Array.isArray(dossier.assertions) || !Array.isArray(dossier.derived_assertions)) {
    throw new TypeError("entity.dossier assertions are required");
  }
  for (const record of dossier.linked_records) {
    if (record?.entity_id !== entityId || !record?.source?.system || !record?.source?.id) {
      throw new TypeError("entity.dossier linked-record provenance is incomplete");
    }
  }
  for (const group of dossier.assertions) {
    if (!group?.fact || !Array.isArray(group.assertions)) {
      throw new TypeError("entity.dossier assertion groups are malformed");
    }
    for (const assertion of group.assertions) {
      if (!assertion?.provenance?.source?.system || !assertion.provenance.source.id) {
        throw new TypeError("entity.dossier assertion provenance is incomplete");
      }
    }
  }
  assertNoPrivateFields(dossier);
  return dossier;
}

export function validateEntityDossierOutput(result, input) {
  validateEntityDossierInput(input);
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new TypeError("entity.dossier provider must return an object");
  }
  if (result.capability_reference !== ENTITY_DOSSIER_CAPABILITY_REFERENCE) {
    throw new TypeError("entity.dossier capability reference drifted");
  }
  if (!ENTITY_DOSSIER_AVAILABILITY.includes(result.availability)) {
    throw new TypeError("entity.dossier availability is invalid");
  }
  if (result.availability === "available") {
    validatePublicDossier(result.dossier, input.entityId.trim());
    if (result.error !== null) throw new TypeError("available entity.dossier output cannot carry an error");
  } else {
    if (result.dossier !== null) throw new TypeError("unavailable entity.dossier output cannot carry a dossier");
    if (typeof result.error !== "string" || !result.error) {
      throw new TypeError("non-available entity.dossier output requires an error code");
    }
    if (result.availability === "not_yet_public" && result.error !== "not-found") {
      throw new TypeError("not_yet_public entity.dossier output requires not-found");
    }
    if (result.availability === "unavailable"
        && !["no-store", "dossier-unavailable"].includes(result.error)) {
      throw new TypeError("unavailable entity.dossier output has an invalid error code");
    }
  }
  assertNoPrivateFields(result);
  return result;
}

/** Execute one explicit provider. This is deliberately not a service locator. */
export async function executeEntityDossier(provider, input) {
  validateEntityDossierInput(input);
  if (
    !provider
    || provider.capabilityReference !== ENTITY_DOSSIER_CAPABILITY_REFERENCE
    || provider.providerId !== ENTITY_DOSSIER_PROVIDER_ID
    || typeof provider.execute !== "function"
  ) {
    throw new TypeError("entity.dossier.get requires the registered explicit provider");
  }
  const result = await provider.execute(input);
  return validateEntityDossierOutput(result, input);
}
