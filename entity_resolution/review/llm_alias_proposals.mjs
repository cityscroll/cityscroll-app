// Human-gated LLM alias proposals.
//
// The model is a proposal generator only. It cannot write an accepted alias,
// create an entity link, or influence policy decisions. A clerk must call
// reviewAliasProposal() before a proposal can become an accepted registry
// entry.

import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const ALIAS_PROPOSAL_VERSION = "llm_alias_proposal_v1";
export const ALIAS_PROPOSAL_PROMPT_VERSION = ALIAS_PROPOSAL_VERSION;
export const ALIAS_PROPOSAL_STATUS = "PROPOSED";
export const ALIAS_ACCEPTED_STATUS = "ACCEPTED";
export const ALIAS_REJECTED_STATUS = "REJECTED";
export const DEFAULT_ALIAS_REGISTRY_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "alias_registry.json",
);

const ACCEPTED_LABELS = new Set(["verified_alias", "successor"]);
const DECISIONS = new Map([
  ["accept", ALIAS_ACCEPTED_STATUS],
  ["accepted", ALIAS_ACCEPTED_STATUS],
  ["approve", ALIAS_ACCEPTED_STATUS],
  ["approved", ALIAS_ACCEPTED_STATUS],
  ["reject", ALIAS_REJECTED_STATUS],
  ["rejected", ALIAS_REJECTED_STATUS],
]);

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function asObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function entityId(entity) {
  return clean(entity?.id ?? entity?.entity_id ?? entity?.source_record_id);
}

function entityName(entity) {
  return clean(entity?.display_name ?? entity?.vendor_name ?? entity?.name);
}

function entityType(entity) {
  return clean(entity?.entity_type ?? entity?.entityType ?? "vendor").toLowerCase();
}

function normalizedEntities(entities) {
  if (!Array.isArray(entities)) throw new TypeError("entities must be an array");
  const seen = new Set();
  return entities.map((entity) => {
    asObject(entity, "entity");
    const id = entityId(entity);
    const displayName = entityName(entity);
    if (!id || !displayName) throw new Error("every entity needs an id and display_name");
    if (seen.has(id)) throw new Error(`duplicate entity id: ${id}`);
    seen.add(id);
    return {
      id,
      entity_type: entityType(entity),
      display_name: displayName,
      source_system: clean(entity.source_system ?? entity.source),
      source_record_id: clean(entity.source_record_id),
      native_key: clean(entity.native_key ?? entity.source_system_id),
    };
  });
}

/**
 * Build the bounded, auditable prompt sent to an injected model adapter.
 * Keeping the adapter outside this module avoids provider credentials and
 * makes the proposal run deterministic in tests.
 */
export function buildAliasProposalPrompt(entities, { maxProposals = 50 } = {}) {
  const normalized = normalizedEntities(entities);
  const limit = Math.max(1, Math.min(200, Number(maxProposals) || 50));
  return [
    `Prompt version: ${ALIAS_PROPOSAL_PROMPT_VERSION}`,
    "You propose possible aliases between entities in the supplied entity set.",
    "Return JSON only: {proposals:[...]}.",
    "Use only supplied entity ids; never invent an entity or evidence.",
    "Every proposal needs a concise rationale and supporting evidence.",
    "These are PROPOSED review items only: never auto-link, never assert identity,",
    "and never treat a proposal as accepted.",
    JSON.stringify({
      task: "Find plausible vendor alias or successor pairs for human review.",
      output: {
        proposals: [
          {
            left_entity_id: "entity id from input",
            right_entity_id: "different entity id from input",
            label: "verified_alias or successor",
            rationale: "why a clerk should inspect this pair",
            evidence: [{ source: "source system", detail: "observable support" }],
          },
        ],
        max_proposals: limit,
      },
      entities: normalized,
    }),
  ].join("\n\n");
}

function modelPayload(response) {
  if (typeof response === "string") {
    const stripped = response.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    return JSON.parse(stripped);
  }
  if (response && typeof response === "object") {
    if (typeof response.output_text === "string") return modelPayload(response.output_text);
    if (typeof response.text === "string") return modelPayload(response.text);
    if (Array.isArray(response.content) && response.content.length === 1
      && typeof response.content[0]?.text === "string") {
      return modelPayload(response.content[0].text);
    }
    return response;
  }
  throw new TypeError("LLM response must be JSON or a JSON string");
}

function proposalSide(candidate, side) {
  const nested = candidate?.[side];
  return clean(
    candidate?.[`${side}_entity_id`]
      ?? candidate?.[`${side}EntityId`]
      ?? (typeof nested === "string" ? nested : nested?.id ?? nested?.entity_id),
  );
}

function normalizeLabel(value) {
  const label = clean(value).toLowerCase();
  if (label === "alias" || label === "verified alias") return "verified_alias";
  if (label === "rebrand" || label === "successor relationship") return "successor";
  return label;
}

function hasEvidence(value) {
  if (typeof value === "string") return Boolean(clean(value));
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value && typeof value === "object" && Object.keys(value).length > 0);
}

function proposalEvidence(candidate) {
  const raw = candidate.evidence ?? candidate.rationale;
  if (!hasEvidence(raw)) return null;
  if (typeof raw === "string") return { rationale: clean(raw) };
  return raw;
}

function entityRef(entity) {
  return {
    id: entity.id,
    display_name: entity.display_name,
    ...(entity.source_system ? { source_system: entity.source_system } : {}),
    ...(entity.source_record_id ? { source_record_id: entity.source_record_id } : {}),
    ...(entity.native_key ? { native_key: entity.native_key } : {}),
  };
}

function proposalIdentity(left, right, label) {
  return [left.id, right.id].sort().concat(label).join("\0");
}

function proposalId(left, right, label) {
  return `alias-proposed-${sha256(proposalIdentity(left, right, label)).slice(0, 16)}`;
}

/** Parse and validate model output against the supplied entity set. */
export function parseAliasProposalResponse(response, entities, {
  model = "unspecified",
  promptVersion = ALIAS_PROPOSAL_VERSION,
  inputSha256 = null,
  generatedAt = new Date().toISOString(),
  runId = null,
  maxProposals = 50,
} = {}) {
  const normalized = normalizedEntities(entities);
  const byId = new Map(normalized.map((entity) => [entity.id, entity]));
  const byName = new Map();
  for (const entity of normalized) {
    const key = entity.display_name.toLowerCase();
    const prior = byName.get(key) || [];
    prior.push(entity);
    byName.set(key, prior);
  }
  const payload = modelPayload(response);
  const candidates = Array.isArray(payload) ? payload : payload?.proposals;
  if (!Array.isArray(candidates)) throw new Error("LLM response must contain a proposals array");

  const proposals = [];
  const rejected = [];
  const seen = new Set();
  for (const [index, candidate] of candidates.entries()) {
    try {
      asObject(candidate, `proposal ${index}`);
      let leftId = proposalSide(candidate, "left");
      let rightId = proposalSide(candidate, "right");
      if (!leftId && typeof candidate.left_name === "string") {
        const matches = byName.get(clean(candidate.left_name).toLowerCase()) || [];
        if (matches.length === 1) leftId = matches[0].id;
      }
      if (!rightId && typeof candidate.right_name === "string") {
        const matches = byName.get(clean(candidate.right_name).toLowerCase()) || [];
        if (matches.length === 1) rightId = matches[0].id;
      }
      const left = byId.get(leftId);
      const right = byId.get(rightId);
      if (!left || !right) throw new Error("both entity ids must be present in the entity set");
      if (left.id === right.id) throw new Error("a proposal must contain two different entities");
      if (left.entity_type !== "vendor" || right.entity_type !== "vendor") {
        throw new Error("alias proposals currently support vendor entities only");
      }
      const label = normalizeLabel(candidate.label || "verified_alias");
      if (!ACCEPTED_LABELS.has(label)) throw new Error(`unsupported alias label: ${label}`);
      const evidence = proposalEvidence(candidate);
      if (!evidence) throw new Error("proposal must include evidence or rationale");
      const identity = proposalIdentity(left, right, label);
      if (seen.has(identity)) continue;
      seen.add(identity);
      const confidence = Number(candidate.confidence);
      proposals.push({
        id: proposalId(left, right, label),
        status: ALIAS_PROPOSAL_STATUS,
        label,
        left: entityRef(left),
        right: entityRef(right),
        evidence,
        proposal: {
          version: ALIAS_PROPOSAL_VERSION,
          model: clean(model) || "unspecified",
          prompt_version: clean(promptVersion) || ALIAS_PROPOSAL_VERSION,
          input_sha256: inputSha256,
          run_id: clean(runId) || null,
          generated_at: generatedAt,
        },
        ...(Number.isFinite(confidence) ? {
          model_confidence: Math.max(0, Math.min(1, confidence)),
        } : {}),
        proposed_at: generatedAt,
      });
      if (proposals.length >= Math.max(1, Math.min(200, Number(maxProposals) || 50))) break;
    } catch (error) {
      rejected.push({ index, reason: String(error?.message || error) });
    }
  }
  return { proposals, rejected };
}

function readRegistry(registryPath = DEFAULT_ALIAS_REGISTRY_PATH) {
  if (!existsSync(registryPath)) {
    return { _meta: { registry_version: "v1" }, entries: [] };
  }
  const parsed = JSON.parse(readFileSync(registryPath, "utf8"));
  asObject(parsed, "alias registry");
  if (!Array.isArray(parsed.entries)) throw new Error("alias registry entries must be an array");
  return parsed;
}

function registryIdentity(entry) {
  const left = clean(entry?.left?.id ?? entry?.left?.display_name).toLowerCase();
  const right = clean(entry?.right?.id ?? entry?.right?.display_name).toLowerCase();
  return [left, right].sort().concat(normalizeLabel(entry?.label || "verified_alias")).join("\0");
}

function writeRegistry(registryPath, registry) {
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
}

/** Append only PROPOSED entries. This function cannot create an accepted entry. */
export function appendProposedAliases({
  registryPath = DEFAULT_ALIAS_REGISTRY_PATH,
  proposals = [],
  run = {},
} = {}) {
  const registry = readRegistry(registryPath);
  const existing = new Set(registry.entries.map(registryIdentity));
  const added = [];
  const skipped = [];
  for (const proposal of proposals) {
    asObject(proposal, "proposal");
    if (proposal.status !== ALIAS_PROPOSAL_STATUS) {
      throw new Error("appendProposedAliases accepts PROPOSED entries only");
    }
    if (!proposal.left?.display_name || !proposal.right?.display_name || !hasEvidence(proposal.evidence)) {
      throw new Error("a proposed alias needs both sides and evidence");
    }
    const key = registryIdentity(proposal);
    if (existing.has(key)) {
      skipped.push(proposal.id || key);
      continue;
    }
    existing.add(key);
    added.push({ ...proposal });
  }
  if (added.length) {
    registry.entries.push(...added);
    registry._meta = {
      ...(registry._meta || {}),
      registry_version: registry._meta?.registry_version || "v1",
      last_proposal_run: {
        version: ALIAS_PROPOSAL_VERSION,
        run_id: clean(run.runId ?? run.run_id) || null,
        model: clean(run.model) || "unspecified",
        generated_at: run.generatedAt ?? run.generated_at ?? new Date().toISOString(),
        added: added.length,
      },
    };
    writeRegistry(registryPath, registry);
  }
  return { registry, added, skipped };
}

/**
 * Run an injected LLM adapter and persist only validated PROPOSED entries.
 * `complete` may return a JSON object or JSON text; it is never allowed to
 * call policy routing or write links.
 */
export async function generateAliasProposals({
  entities,
  invokeModel,
  complete,
  llm,
  registryPath = DEFAULT_ALIAS_REGISTRY_PATH,
  model = "unspecified",
  promptVersion = ALIAS_PROPOSAL_VERSION,
  runId = null,
  generatedAt = new Date().toISOString(),
  maxProposals = 50,
} = {}) {
  const adapter = invokeModel || complete || llm?.complete || llm;
  if (typeof adapter !== "function") throw new TypeError("an injected LLM complete function is required");
  const prompt = buildAliasProposalPrompt(entities, { maxProposals });
  const inputSha256 = sha256(prompt);
  const response = invokeModel
    ? await adapter({ model, prompt, entities })
    : await adapter(prompt);
  const parsed = parseAliasProposalResponse(response, entities, {
    model,
    promptVersion,
    inputSha256,
    generatedAt,
    runId,
    maxProposals,
  });
  const persisted = appendProposedAliases({
    registryPath,
    proposals: parsed.proposals,
    run: { model, runId, generatedAt },
  });
  return {
    ...parsed,
    ...persisted,
    prompt_version: promptVersion,
    input_sha256: inputSha256,
  };
}

function reviewOptions(registryPathOrOptions, proposalIdOrReview, review) {
  if (registryPathOrOptions && typeof registryPathOrOptions === "object") {
    return registryPathOrOptions;
  }
  return {
    ...(review || {}),
    registryPath: registryPathOrOptions,
    proposalId: proposalIdOrReview,
  };
}

/** Apply one explicit clerk decision to one PROPOSED entry. */
export function reviewAliasProposal(registryPathOrOptions, proposalIdOrReview, review) {
  const options = reviewOptions(registryPathOrOptions, proposalIdOrReview, review);
  const registryPath = options.registryPath || DEFAULT_ALIAS_REGISTRY_PATH;
  const proposalIdValue = clean(options.proposalId);
  const reviewer = clean(options.reviewer);
  const status = DECISIONS.get(clean(options.decision || options.status).toLowerCase());
  if (!proposalIdValue) throw new Error("proposalId is required");
  if (!reviewer) throw new Error("reviewer is required for alias review");
  if (!status) throw new Error("decision must be accepted or rejected");
  if (status === ALIAS_REJECTED_STATUS && !clean(options.note || options.reason)) {
    throw new Error("rejected proposals require a review note");
  }
  const registry = readRegistry(registryPath);
  const index = registry.entries.findIndex((entry) => entry.id === proposalIdValue);
  if (index < 0) throw new Error(`unknown alias proposal: ${proposalIdValue}`);
  const current = registry.entries[index];
  if (current.status !== ALIAS_PROPOSAL_STATUS) {
    throw new Error(`alias proposal ${proposalIdValue} is not PROPOSED`);
  }
  const label = normalizeLabel(options.label || current.label);
  if (status === ALIAS_ACCEPTED_STATUS && !ACCEPTED_LABELS.has(label)) {
    throw new Error(`unsupported accepted alias label: ${label}`);
  }
  const reviewedAt = options.reviewedAt || options.reviewed_date || new Date().toISOString();
  registry.entries[index] = {
    ...current,
    ...(status === ALIAS_ACCEPTED_STATUS ? { label } : {}),
    status,
    reviewer,
    reviewed_date: reviewedAt,
    review: {
      decision: status,
      reviewer,
      reviewed_at: reviewedAt,
      ...(clean(options.note || options.reason)
        ? { note: clean(options.note || options.reason) }
        : {}),
    },
  };
  writeRegistry(registryPath, registry);
  return registry.entries[index];
}

/** Naming convenience for the only path that can promote a proposal. */
export function promoteAliasProposal(registryPathOrOptions, proposalIdOrReview, review) {
  const options = reviewOptions(registryPathOrOptions, proposalIdOrReview, review);
  return reviewAliasProposal({ ...options, decision: "accepted" });
}

export { readRegistry as readAliasRegistry };
