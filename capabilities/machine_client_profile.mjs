// CS-11 · Scoped machine-client profiles for the tool endpoint.
//
// A machine-client profile is a NAMED integration identity: a stable profile id, an
// exact allowlist of registered public-read capability tools, and its own quota meter.
// It replaces "one endpoint-wide secret + per-address quota" for authenticated
// integrations, without changing anything for anonymous callers.
//
// Three invariants this module exists to hold:
//
//   Discovery is authority. A tool an integration can SEE is a tool it will eventually
//   try, so `tools/list` is filtered by the authenticated profile — rejecting the call
//   alone would leave the grant dishonest about its own shape.
//
//   The credential is never data. Profiles name the deployment-secret BINDINGS they
//   accept (`secretBindings`), never a secret value. Nothing here reads a value into a
//   returned object, a telemetry record, or a receipt; `describeMachineClientProfile()`
//   is the only projection intended to leave the Worker and it carries binding names,
//   not bindings' contents.
//
//   Authentication grants reads, not authority. A profile's allowlist is validated
//   against the capability registry's own `authorityClass` / `storeAccess` facts, so a
//   future tool cannot join a profile by being added to a list — it has to be a
//   registered public read with provider-only store access first.
//
// Rotation (A7): a profile accepts more than one secret binding at a time. Rotating
// means changing WHICH binding holds the live value; the profile id, its allowlist and
// its meter key are unchanged, so capability semantics survive a rotation or a
// revocation untouched.

import { MCP_PUBLIC_CAPABILITY_TOOL_BINDINGS, MCP_TOOL_BINDINGS } from "./mcp_tool_declarations.mjs";

/** Meter name for profile-keyed quota. Distinct from the anonymous per-address meter. */
export const MACHINE_CLIENT_METER = "mcpclient";

/** Meter name the endpoint uses for anonymous callers (unchanged pre-existing behavior). */
export const ANONYMOUS_ADDRESS_METER = "mcpip";

/** Resolution states returned by `resolveMachineClientProfile`. */
export const MACHINE_CLIENT_RESOLUTIONS = Object.freeze([
  "anonymous",
  "profile",
  "unauthorized",
]);

/**
 * Authority the negative rule excludes from every profile. These are asserted against
 * the registry, not merely documented: `validateMachineClientProfiles()` fails if any
 * allowlisted tool is a mutation, is unregistered, or reaches a store directly.
 */
export const MACHINE_CLIENT_EXCLUDED_AUTHORITY = Object.freeze([
  "watch-preview",
  "watch-creation",
  "future-mutations",
  "administrative-routes",
  "raw-source-or-store-access",
  "subscription",
  "email",
]);

/** Telemetry field set. Deliberately closed — see `machineClientTelemetry`. */
export const MACHINE_CLIENT_TELEMETRY_FIELDS = Object.freeze([
  "profile_id",
  "capability_reference",
  "availability",
  "duration_ms",
  "count",
  "error_class",
]);

/** Error classes telemetry may record. Small closed enumeration, never free text. */
export const MACHINE_CLIENT_ERROR_CLASSES = Object.freeze([
  "none",
  "not_granted",
  "unknown_tool",
  "invalid_input",
  "quota_exhausted",
  "unauthorized",
  "provider_unavailable",
  "internal",
]);

const PUBLIC_READ_TOOL_NAMES = new Set(MCP_PUBLIC_CAPABILITY_TOOL_BINDINGS.map((binding) => binding.name));
const TOOL_BINDINGS_BY_NAME = new Map(MCP_TOOL_BINDINGS.map((binding) => [binding.name, binding]));

/**
 * The first (and, at this card, only) profile.
 *
 * The allowlist is written out EXACTLY rather than derived from the registry at
 * runtime: a grant that recomputes itself silently widens the day a new public read is
 * registered. `validateMachineClientProfiles()` then checks this literal list against
 * the registry, so the two can never drift apart unnoticed — adding a capability to the
 * endpoint is a deliberate edit here, and removing one from the registry fails a test.
 */
export const MACHINE_CLIENT_PROFILES = Object.freeze([
  Object.freeze({
    id: "public-research-read",
    label: "Public civic-research reads",
    description:
      "Registered public-read capabilities only. Grants no watch preview, no watch creation, "
      + "no mutation, no administrative route, and no raw source, database, key-value or "
      + "object-store access.",
    secretBindings: Object.freeze([
      "MCP_CLIENT_PUBLIC_RESEARCH_TOKEN",
      "MCP_CLIENT_PUBLIC_RESEARCH_TOKEN_PREVIOUS",
    ]),
    dailyRequestLimit: 5000,
    allowlist: Object.freeze([
      "search_federated",
      "search_notices",
      "get_notice",
      "get_entity_dossier",
      "get_entity_relationships",
      "retrieve_cited_passages",
      "get_contract",
      "browse_contracts",
      "analyze_contracts",
      "get_person_or_organization",
      "browse_organizations",
      "get_meeting",
      "get_land_project",
      "browse_land_projects",
      "get_land_decision_path",
    ]),
  }),
]);

const PROFILES_BY_ID = new Map(MACHINE_CLIENT_PROFILES.map((profile) => [profile.id, profile]));

export function machineClientProfileById(id) {
  return PROFILES_BY_ID.get(String(id || "")) || null;
}

/**
 * Re-derives every claim a profile makes against the capability registry. Returns the
 * list of problems; empty means the declared grants are exactly what the registry says
 * they are. Called by the contract test, and by the endpoint's own startup-free checks.
 */
export function validateMachineClientProfiles(profiles = MACHINE_CLIENT_PROFILES) {
  const problems = [];
  const seenIds = new Set();
  const seenBindings = new Set();

  for (const profile of profiles) {
    const at = `profile ${profile?.id || "(unnamed)"}`;
    if (!profile?.id || typeof profile.id !== "string") {
      problems.push(`${at}: missing a stable string id`);
      continue;
    }
    if (seenIds.has(profile.id)) problems.push(`${at}: duplicate profile id`);
    seenIds.add(profile.id);

    if (!Array.isArray(profile.secretBindings) || profile.secretBindings.length === 0) {
      problems.push(`${at}: must name at least one deployment-secret binding`);
    } else {
      for (const binding of profile.secretBindings) {
        if (typeof binding !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(binding)) {
          problems.push(`${at}: secret binding ${JSON.stringify(binding)} is not a binding name`);
        }
        if (seenBindings.has(binding)) problems.push(`${at}: secret binding ${binding} is shared with another profile`);
        seenBindings.add(binding);
      }
    }

    if (!Number.isInteger(profile.dailyRequestLimit) || profile.dailyRequestLimit <= 0) {
      problems.push(`${at}: dailyRequestLimit must be a positive integer`);
    }

    if (!Array.isArray(profile.allowlist) || profile.allowlist.length === 0) {
      problems.push(`${at}: allowlist must name at least one tool`);
      continue;
    }
    if (new Set(profile.allowlist).size !== profile.allowlist.length) {
      problems.push(`${at}: allowlist repeats a tool name`);
    }

    for (const name of profile.allowlist) {
      const binding = TOOL_BINDINGS_BY_NAME.get(name);
      if (!binding) {
        problems.push(`${at}: ${name} is not a declared tool`);
        continue;
      }
      if (!PUBLIC_READ_TOOL_NAMES.has(name)) {
        problems.push(`${at}: ${name} is not a registered public-read capability`);
      }
      if (binding.operationClass !== "read") {
        problems.push(`${at}: ${name} has operationClass ${binding.operationClass}, not read`);
      }
      if (binding.authorityClass !== "public_read") {
        problems.push(`${at}: ${name} has authorityClass ${binding.authorityClass || "(none)"}, not public_read`);
      }
      if (binding.storeAccess !== "provider-only") {
        problems.push(`${at}: ${name} has storeAccess ${binding.storeAccess || "(none)"}, not provider-only`);
      }
      if (!binding.capabilityReference) {
        problems.push(`${at}: ${name} has no registered capability reference`);
      }
    }
  }

  return problems;
}

export function profileAllowsTool(profile, name) {
  if (!profile) return true; // Anonymous callers keep the pre-existing full inventory.
  return profile.allowlist.includes(String(name || ""));
}

/**
 * Filters a tool listing to a profile's grant. Anonymous callers (`profile === null`)
 * receive the listing unchanged, which is what keeps the endpoint backward compatible.
 */
export function filterToolsForProfile(tools, profile) {
  if (!profile) return tools;
  return tools.filter((tool) => profileAllowsTool(profile, tool?.name));
}

/**
 * Length-independent string comparison. Compares digests of the two values so a timing
 * observer learns nothing about the secret's length or its matching prefix.
 */
async function secretEquals(candidate, expected) {
  if (typeof candidate !== "string" || typeof expected !== "string") return false;
  if (candidate.length === 0 || expected.length === 0) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(candidate)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

function presentedBearer(authorizationHeader) {
  const header = String(authorizationHeader || "");
  const match = /^Bearer (.+)$/.exec(header);
  return match ? match[1] : "";
}

/**
 * Resolves the caller's machine-client identity from the request's Authorization header.
 *
 * Returns one of:
 *   { resolution: "anonymous",    profile: null }  — no credential presented, and none required
 *   { resolution: "profile",      profile }        — a profile secret matched
 *   { resolution: "unauthorized", profile: null }  — a credential is required and did not match
 *
 * The endpoint-wide `MCP_BEARER_TOKEN` keeps working exactly as before: it authenticates
 * a caller without naming a profile, and such a caller keeps the unfiltered inventory
 * and the per-address meter. A profile credential is checked FIRST so deployments can
 * run both at once during a migration.
 *
 * Never returns, logs, or embeds the presented or configured secret.
 */
export async function resolveMachineClientProfile(env, authorizationHeader, profiles = MACHINE_CLIENT_PROFILES) {
  const presented = presentedBearer(authorizationHeader);

  if (presented) {
    for (const profile of profiles) {
      for (const binding of profile.secretBindings) {
        const configured = env?.[binding];
        // An unset binding is a revoked binding: it must never match a presented value.
        if (!configured) continue;
        if (await secretEquals(presented, configured)) {
          return { resolution: "profile", profile };
        }
      }
    }
  }

  if (env?.MCP_BEARER_TOKEN) {
    const ok = presented ? await secretEquals(presented, env.MCP_BEARER_TOKEN) : false;
    return ok
      ? { resolution: "anonymous", profile: null }
      : { resolution: "unauthorized", profile: null };
  }

  // A presented-but-unmatched credential always fails closed, including after the
  // final profile secret is removed. Only callers without a bearer are anonymous.
  if (presented) {
    return { resolution: "unauthorized", profile: null };
  }

  return { resolution: "anonymous", profile: null };
}

export function anyProfileSecretConfigured(env, profiles = MACHINE_CLIENT_PROFILES) {
  return profiles.some((profile) => profile.secretBindings.some((binding) => Boolean(env?.[binding])));
}

/**
 * The quota identity for a request. A profile meters by its own stable id, so a gateway
 * that collapses many users onto one address no longer shares one address bucket; an
 * anonymous caller keeps the pre-existing per-address meter.
 */
export function machineClientMeterIdentity(profile, connectingAddress) {
  if (profile) {
    return { meter: MACHINE_CLIENT_METER, actor: profile.id, limit: profile.dailyRequestLimit, keyedBy: "client_profile" };
  }
  return { meter: ANONYMOUS_ADDRESS_METER, actor: String(connectingAddress || ""), limit: null, keyedBy: "connecting_address" };
}

function boundedInteger(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n);
}

/**
 * Builds one content-free telemetry record.
 *
 * The returned object's key set is exactly MACHINE_CLIENT_TELEMETRY_FIELDS. There is no
 * field for request arguments, response bodies, prompt text, resident query strings,
 * entity names, addresses or credentials, and unknown inputs are dropped rather than
 * passed through — a caller cannot widen the record by handing it more.
 */
export function machineClientTelemetry({
  profileId = null,
  capabilityReference = null,
  availability = null,
  durationMs = 0,
  count = 0,
  errorClass = "none",
} = {}) {
  const cls = MACHINE_CLIENT_ERROR_CLASSES.includes(errorClass) ? errorClass : "internal";
  return Object.freeze({
    profile_id: profileId === null ? null : String(profileId),
    capability_reference: capabilityReference === null ? null : String(capabilityReference),
    availability: availability === null ? null : String(availability),
    duration_ms: boundedInteger(durationMs),
    count: boundedInteger(count),
    error_class: cls,
  });
}

/**
 * The receipt-safe projection of a profile: what it is and what it may reach, with the
 * NAMES of its secret bindings but never their values. This is the only shape intended
 * for evidence artifacts, generated clients or operator documentation.
 */
export function describeMachineClientProfile(profile) {
  return Object.freeze({
    id: profile.id,
    label: profile.label,
    description: profile.description,
    granted_tools: [...profile.allowlist],
    granted_tool_count: profile.allowlist.length,
    daily_request_limit: profile.dailyRequestLimit,
    quota_keyed_by: "client_profile",
    secret_binding_names: [...profile.secretBindings],
    excluded_authority: [...MACHINE_CLIENT_EXCLUDED_AUTHORITY],
  });
}
