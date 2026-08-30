/**
 * Public product-update candidate projection.
 *
 * Joins changelog, checked architecture reconciliation, the frozen capability
 * registry, and the demo manifest by exact identifiers only. Prose similarity
 * never creates a pairing. Ineligible inputs stay in the artifact with a
 * specific reason and cannot enter the eligible set.
 */

import { sha256Hex } from "../entity_resolution/hash.mjs";

export const PRODUCT_UPDATES_SCHEMA = "cityscroll.product_updates.v1";
export const PRODUCT_UPDATE_CANDIDATE_SCHEMA = "cityscroll.product_update_candidate.v1";
export const PRODUCT_UPDATES_METHOD = "product_updates_source_v1";

export const CHANGELOG_PATH = "site/changelog-data.json";
export const RECONCILIATION_PATH = "architecture/generated/reconciliation.json";
export const CAPABILITY_REGISTRY_PATH = "capabilities/registry.mjs";
export const DEMO_MANIFEST_PATH = "site/demo/demo-links.json";

export const INELIGIBILITY_REASONS = Object.freeze([
  "proposed",
  "merged_but_not_public",
  "stale",
  "unregistered",
  "missing",
  "incomplete",
]);

const REASON_SET = new Set(INELIGIBILITY_REASONS);
const CLAIM_MAXIMUM = 160;
const SOURCE_KINDS = new Set(["architecture_reconciliation", "changelog"]);
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/;
const COMMIT = /^[0-9a-f]{7,40}$/i;
const PRIVATE_LEAK = /(?:\/Users\/|\/var\/folders|file:\/\/|127\.0\.0\.1|localhost|ADMIN_KEY|cityscroll-internal|desk\.cityscroll\.org|operator[_ -]?state)/i;
const MARKETING_COPY = /\b(?:best ever|game[- ]changer|unmissable|amazing|must[- ]see)\b/i;

export const PRODUCT_UPDATE_SOURCE_INPUTS = Object.freeze([
  Object.freeze({ id: "changelog", path: CHANGELOG_PATH }),
  Object.freeze({ id: "architecture_reconciliation", path: RECONCILIATION_PATH }),
  Object.freeze({ id: "capability_registry", path: CAPABILITY_REGISTRY_PATH }),
  Object.freeze({ id: "demo_manifest", path: DEMO_MANIFEST_PATH }),
]);

export const PRODUCT_UPDATE_JOINS = Object.freeze([
  Object.freeze({
    id: "search.federated@1::semantic-search-housing",
    capability_reference: "search.federated@1",
    demo_id: "semantic-search-housing",
    source: Object.freeze({ kind: "architecture_reconciliation" }),
  }),
  Object.freeze({
    id: "notice.get@1::notice-sanitation-connected-mandate",
    capability_reference: "notice.get@1",
    demo_id: "notice-sanitation-connected-mandate",
    source: Object.freeze({ kind: "architecture_reconciliation" }),
  }),
]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function clean(value, max = 500) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sorted(value[key])]),
    );
  }
  return value;
}

function validInstant(value) {
  const text = clean(value, 80);
  if (!INSTANT.test(text)) return null;
  const epoch = Date.parse(/T/.test(text) || /Z|[+-]\d{2}:?\d{2}$/.test(text) ? text : `${text}T00:00:00Z`);
  return Number.isFinite(epoch) ? text : null;
}

function validCommit(value) {
  const text = clean(value, 40);
  return COMMIT.test(text) ? text : null;
}

function joinId(join) {
  return clean(join?.id, 200)
    || `${clean(join?.capability_reference, 80)}::${clean(join?.demo_id, 80)}`;
}

function changelogEntry(changelog, pr) {
  const entries = Array.isArray(changelog?.entries) ? changelog.entries : [];
  const wanted = Number(pr);
  if (!Number.isInteger(wanted) || wanted <= 0) return null;
  return entries.find((entry) => Number(entry?.pr) === wanted) || null;
}

function demoEntry(manifest, demoId) {
  const entries = Array.isArray(manifest?.entries) ? manifest.entries : [];
  const id = clean(demoId, 80);
  if (!id) return null;
  return entries.find((entry) => entry?.id === id) || null;
}

function capabilityByReference(capabilities, reference) {
  const list = Array.isArray(capabilities) ? capabilities : [];
  const wanted = clean(reference, 80);
  if (!wanted) return null;
  return list.find((capability) => capability?.reference === wanted) || null;
}

function isPublicCapability(capability) {
  if (!capability) return false;
  if (capability.authority?.class !== "public-read") return false;
  if (!SEMVER.test(clean(capability.version, 20))) return false;
  if (!Array.isArray(capability.adapters) || capability.adapters.length < 2) return false;
  return true;
}

function publicReconciliationStatus(reconciliation) {
  if (!reconciliation || typeof reconciliation !== "object") return null;
  const status = clean(reconciliation.status, 40);
  if (status === "stale" || status === "unavailable" || status === "missing") return "stale";
  if (clean(reconciliation.schema, 80) !== "cityscroll.architecture.reconciliation.v1") return status || null;
  if (status === "healthy" || status === "drift" || status === "checked") return "checked";
  return status || null;
}

function demoRoute(entry) {
  const url = clean(entry?.url, 300);
  if (!url || url.startsWith("#")) return { url: url || null, pathname: null, complete: false };
  const pathname = clean(entry?.expectations?.pathname, 200)
    || (url.startsWith("/") ? url.split("?")[0] : `/${url}`.split("?")[0]);
  return {
    url,
    pathname: pathname || null,
    complete: Boolean(url && pathname && entry?.expectations && typeof entry.expectations === "object"),
  };
}

function boundedClaim(entry) {
  const claim = clean(entry?.description, CLAIM_MAXIMUM);
  if (claim.length < 12 || MARKETING_COPY.test(claim)) return null;
  return claim;
}

function ineligible(base, reason, detail) {
  return deepFreeze({
    ...base,
    state: "ineligible",
    eligible: false,
    reason,
    reason_detail: clean(detail, 200) || reason,
  });
}

function eligible(base) {
  return deepFreeze({
    ...base,
    state: "eligible",
    eligible: true,
    reason: null,
    reason_detail: null,
  });
}

function candidateBase(join, extras = {}) {
  return {
    schema: PRODUCT_UPDATE_CANDIDATE_SCHEMA,
    id: joinId(join),
    source_event: extras.source_event ?? null,
    capability: extras.capability ?? {
      reference: clean(join?.capability_reference, 80) || null,
      id: null,
      version: null,
    },
    observed_commit: extras.observed_commit ?? null,
    as_of: extras.as_of ?? null,
    claim: extras.claim ?? null,
    demo: extras.demo ?? {
      id: clean(join?.demo_id, 80) || null,
      url: null,
      pathname: null,
      feature: null,
    },
    provenance: extras.provenance ?? {
      changelog: { path: CHANGELOG_PATH, used: false, pr: null },
      architecture_reconciliation: { path: RECONCILIATION_PATH, schema: null, status: null, baseline: null },
      capability_registry: {
        path: CAPABILITY_REGISTRY_PATH,
        reference: clean(join?.capability_reference, 80) || null,
        version: null,
      },
      demo_manifest: { path: DEMO_MANIFEST_PATH, demo_id: clean(join?.demo_id, 80) || null },
    },
  };
}

function projectJoin(join, sources) {
  const reference = clean(join?.capability_reference, 80);
  const demoId = clean(join?.demo_id, 80);
  const sourceKind = clean(join?.source?.kind, 40);
  const publicationState = clean(join?.publication_state, 40) || "public";
  const capability = capabilityByReference(sources.capabilities, reference);
  const demo = demoEntry(sources.demoManifest, demoId);
  const reconciliation = sources.reconciliation && typeof sources.reconciliation === "object"
    ? sources.reconciliation
    : null;
  const changelog = sources.changelog && typeof sources.changelog === "object"
    ? sources.changelog
    : null;
  const route = demoRoute(demo);
  const claim = demo ? boundedClaim(demo) : null;
  const changelogPr = Number(join?.source?.pr);
  const changelogHit = sourceKind === "changelog" ? changelogEntry(changelog, changelogPr) : null;

  const reconciliationCommit = validCommit(
    reconciliation?.observed_commit || reconciliation?.commit || reconciliation?.facts?.regenerated_commit,
  );
  const observedCommit = sourceKind === "changelog"
    ? validCommit(changelogHit?.commit) || reconciliationCommit
    : reconciliationCommit;
  const asOf = validInstant(
    sourceKind === "changelog"
      ? changelogHit?.merged_at
      : reconciliation?.as_of || reconciliation?.generated_at,
  );

  const sourceEvent = sourceKind === "changelog"
    ? {
      kind: "changelog",
      path: CHANGELOG_PATH,
      pr: Number.isInteger(changelogPr) && changelogPr > 0 ? changelogPr : null,
      url: clean(changelogHit?.url, 300) || null,
      merged_at: validInstant(changelogHit?.merged_at),
      observed_commit: observedCommit,
      as_of: asOf,
    }
    : {
      kind: "architecture_reconciliation",
      path: RECONCILIATION_PATH,
      schema: clean(reconciliation?.schema, 80) || null,
      status: publicReconciliationStatus(reconciliation),
      baseline: clean(reconciliation?.baseline, 80) || null,
      observed_commit: observedCommit,
      as_of: asOf,
    };

  const provenance = {
    changelog: {
      path: CHANGELOG_PATH,
      used: sourceKind === "changelog",
      pr: sourceKind === "changelog" && Number.isInteger(changelogPr) && changelogPr > 0 ? changelogPr : null,
    },
    architecture_reconciliation: {
      path: RECONCILIATION_PATH,
      schema: clean(reconciliation?.schema, 80) || null,
      status: publicReconciliationStatus(reconciliation),
      baseline: clean(reconciliation?.baseline, 80) || null,
    },
    capability_registry: {
      path: CAPABILITY_REGISTRY_PATH,
      reference: reference || null,
      version: clean(capability?.version, 20) || null,
    },
    demo_manifest: {
      path: DEMO_MANIFEST_PATH,
      demo_id: demoId || null,
    },
  };

  const base = candidateBase(join, {
    source_event: sourceEvent,
    capability: {
      reference: reference || null,
      id: clean(capability?.id, 80) || null,
      version: clean(capability?.version, 20) || null,
    },
    observed_commit: observedCommit,
    as_of: asOf,
    claim,
    demo: {
      id: demoId || null,
      url: route.url,
      pathname: route.pathname,
      feature: clean(demo?.feature, 80) || null,
    },
    provenance,
  });

  if (!SOURCE_KINDS.has(sourceKind) || !reference || !demoId) {
    return ineligible(base, "incomplete", "join is missing an exact capability, demo, or source kind");
  }
  if (!capability) {
    return ineligible(base, "unregistered", `capability ${reference} is not in the frozen registry`);
  }
  if (publicationState === "proposed") {
    return ineligible(base, "proposed", `${reference} is proposed and not publicly shipped`);
  }
  if (!demo) {
    return ineligible(base, "missing", `demo ${demoId} is not in the public manifest`);
  }
  if (!changelog) {
    return ineligible(base, "missing", "changelog source is missing");
  }
  if (!reconciliation) {
    return ineligible(base, "missing", "checked reconciliation source is missing");
  }
  if (!isPublicCapability(capability)) {
    return ineligible(base, "merged_but_not_public", `${reference} is not a public shipped capability`);
  }
  if (sourceKind === "changelog" && !changelogHit) {
    return ineligible(base, "merged_but_not_public", `changelog entry for PR ${changelogPr} is not in the public artifact`);
  }
  if (!route.complete || !claim) {
    return ineligible(base, "incomplete", "manifest demo is missing a public route, expectations, or bounded claim");
  }
  if (sourceKind === "architecture_reconciliation" && publicReconciliationStatus(reconciliation) !== "checked") {
    return ineligible(base, "stale", "architecture reconciliation is stale or unchecked");
  }
  if (!observedCommit || !asOf || !sourceEvent.kind) {
    return ineligible(base, "incomplete", "candidate is missing a source event, observed commit, or as-of value");
  }
  if (publicationState === "merged_but_not_public") {
    return ineligible(base, "merged_but_not_public", `${reference} is merged but not yet public`);
  }

  const ready = eligible(base);
  if (!ready.claim || !ready.demo.url || !ready.demo.pathname || !ready.observed_commit || !ready.as_of) {
    return ineligible(base, "incomplete", "eligible projection dropped a required public field");
  }
  return ready;
}

export function productUpdatesEvidence(artifact) {
  const { content_hash: _hash, ...rest } = artifact || {};
  return sorted({
    schema: rest.schema ?? null,
    method: rest.method ?? null,
    as_of: rest.as_of ?? null,
    observed_commit: rest.observed_commit ?? null,
    source_inputs: rest.source_inputs ?? [],
    candidates: rest.candidates ?? [],
    eligible_ids: rest.eligible_ids ?? [],
    ineligible_ids: rest.ineligible_ids ?? [],
  });
}

export function hashProductUpdatesEvidence(artifact) {
  return sha256Hex(JSON.stringify(productUpdatesEvidence(artifact)));
}

export function serializeProductUpdatesArtifact(artifact) {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

export function eligibleProductUpdateIds(artifact) {
  return (Array.isArray(artifact?.candidates) ? artifact.candidates : [])
    .filter((candidate) => candidate?.eligible === true && candidate?.state === "eligible" && !candidate?.reason)
    .map((candidate) => candidate.id);
}

export function publicProductUpdatesLeaks(artifact) {
  const errors = [];
  const text = JSON.stringify(artifact ?? {});
  if (PRIVATE_LEAK.test(text)) {
    errors.push("public product-updates artifact contains a private path or operator state");
  }
  if (MARKETING_COPY.test(text)) {
    errors.push("public product-updates artifact contains unbounded marketing copy");
  }
  return errors;
}

function unexpectedKeys(value, allowed, path, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${path}: must be an object`);
    return;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${path}.${key}: field is not in the public allowlist`);
  }
}

export function validatePublicProductUpdatesArtifact(artifact) {
  const errors = publicProductUpdatesLeaks(artifact);
  unexpectedKeys(artifact, [
    "schema",
    "method",
    "as_of",
    "observed_commit",
    "content_hash",
    "source_inputs",
    "candidates",
    "eligible_ids",
    "ineligible_ids",
  ], "artifact", errors);
  if (artifact?.schema !== PRODUCT_UPDATES_SCHEMA) errors.push("artifact.schema: invalid schema");
  if (artifact?.method !== PRODUCT_UPDATES_METHOD) errors.push("artifact.method: invalid method");
  if (!validInstant(artifact?.as_of)) errors.push("artifact.as_of: invalid timestamp");
  if (!validCommit(artifact?.observed_commit)) errors.push("artifact.observed_commit: invalid commit");
  if (!/^[a-f0-9]{64}$/.test(clean(artifact?.content_hash, 64))) {
    errors.push("artifact.content_hash: invalid sha256");
  } else if (hashProductUpdatesEvidence(artifact) !== artifact.content_hash) {
    errors.push("artifact.content_hash: does not match canonical evidence");
  }

  if (!Array.isArray(artifact?.source_inputs)) {
    errors.push("artifact.source_inputs must be an array");
  } else {
    const expected = PRODUCT_UPDATE_SOURCE_INPUTS.map(({ id, path }) => `${id}:${path}`).join("|");
    const actual = artifact.source_inputs.map((row) => `${row?.id}:${row?.path}`).join("|");
    if (actual !== expected) errors.push("artifact.source_inputs: must name the four public sources");
  }

  if (!Array.isArray(artifact?.candidates)) {
    errors.push("artifact.candidates must be an array");
    return [...new Set(errors)].sort();
  }

  const ids = [];
  const eligibleIds = [];
  const ineligibleIds = [];
  for (const [index, candidate] of artifact.candidates.entries()) {
    const path = `artifact.candidates[${index}]`;
    unexpectedKeys(candidate, [
      "schema",
      "id",
      "state",
      "eligible",
      "reason",
      "reason_detail",
      "source_event",
      "capability",
      "observed_commit",
      "as_of",
      "claim",
      "demo",
      "provenance",
    ], path, errors);
    if (candidate?.schema !== PRODUCT_UPDATE_CANDIDATE_SCHEMA) errors.push(`${path}.schema: invalid schema`);
    if (!clean(candidate?.id, 200)) errors.push(`${path}.id: missing`);
    ids.push(candidate?.id);
    if (index > 0 && String(candidate?.id) < String(artifact.candidates[index - 1]?.id)) {
      errors.push("artifact.candidates: must be sorted by id");
    }
    if (candidate?.state === "eligible") {
      if (candidate.eligible !== true || candidate.reason != null || candidate.reason_detail != null) {
        errors.push(`${path}: eligible candidate must not carry an ineligibility reason`);
      }
      if (!candidate.claim || !candidate.demo?.id || !candidate.demo?.url || !candidate.demo?.pathname) {
        errors.push(`${path}: eligible candidate is missing a manifest-owned demo or claim`);
      }
      if (!candidate.capability?.reference || !candidate.capability?.version) {
        errors.push(`${path}: eligible candidate is missing a registered capability version`);
      }
      if (!validCommit(candidate.observed_commit) || !validInstant(candidate.as_of)) {
        errors.push(`${path}: eligible candidate is missing observed commit or as-of`);
      }
      if (!candidate.source_event?.kind || !candidate.source_event?.path) {
        errors.push(`${path}: eligible candidate is missing a source event`);
      }
      eligibleIds.push(candidate.id);
    } else if (candidate?.state === "ineligible") {
      if (candidate.eligible !== false || !REASON_SET.has(candidate.reason) || !clean(candidate.reason_detail, 200)) {
        errors.push(`${path}: ineligible candidate needs a closed reason`);
      }
      ineligibleIds.push(candidate.id);
    } else {
      errors.push(`${path}.state: must be eligible or ineligible`);
    }
  }

  const declaredEligible = Array.isArray(artifact.eligible_ids) ? artifact.eligible_ids : [];
  const declaredIneligible = Array.isArray(artifact.ineligible_ids) ? artifact.ineligible_ids : [];
  if (declaredEligible.join("|") !== eligibleIds.join("|")) {
    errors.push("artifact.eligible_ids must match eligible candidates and exclude ineligible ones");
  }
  if (declaredIneligible.join("|") !== ineligibleIds.join("|")) {
    errors.push("artifact.ineligible_ids must match ineligible candidates");
  }
  if (declaredEligible.some((id) => declaredIneligible.includes(id))) {
    errors.push("eligible and ineligible id sets must be disjoint");
  }
  if (new Set(ids).size !== ids.length) errors.push("artifact.candidates: duplicate id");
  return [...new Set(errors)].sort();
}

export function buildProductUpdatesArtifact(sources = {}) {
  const joins = Array.isArray(sources.joins) ? sources.joins : PRODUCT_UPDATE_JOINS;
  const candidates = joins
    .map((join) => projectJoin(join, sources))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const eligibleIds = candidates.filter((candidate) => candidate.eligible === true).map((candidate) => candidate.id);
  const ineligibleIds = candidates.filter((candidate) => candidate.eligible !== true).map((candidate) => candidate.id);
  const observedCommit = validCommit(sources.reconciliation?.observed_commit)
    || validCommit(sources.reconciliation?.commit)
    || (candidates.find((candidate) => candidate.eligible)?.observed_commit ?? null);
  const asOf = validInstant(sources.reconciliation?.as_of)
    || validInstant(sources.reconciliation?.generated_at)
    || (candidates.find((candidate) => candidate.eligible)?.as_of ?? null);

  const artifact = {
    schema: PRODUCT_UPDATES_SCHEMA,
    method: PRODUCT_UPDATES_METHOD,
    as_of: asOf,
    observed_commit: observedCommit,
    source_inputs: PRODUCT_UPDATE_SOURCE_INPUTS.map((input) => ({ ...input })),
    candidates,
    eligible_ids: eligibleIds,
    ineligible_ids: ineligibleIds,
  };
  artifact.content_hash = hashProductUpdatesEvidence(artifact);
  return deepFreeze(artifact);
}
