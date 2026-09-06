// CS-11 · Scoped machine-client profiles for the tool endpoint.
//
// Covers the card's acceptance set end to end: the profile grant (A1), filtered
// discovery and enforced calls (A2, A3), profile-keyed quota (A4), credential
// containment (A5, A10), anonymous compatibility (A6), rotation (A7), content-free
// telemetry (A8), and the authority the grant must never carry (A9).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  ANONYMOUS_ADDRESS_METER,
  MACHINE_CLIENT_ERROR_CLASSES,
  MACHINE_CLIENT_EXCLUDED_AUTHORITY,
  MACHINE_CLIENT_METER,
  MACHINE_CLIENT_PROFILES,
  MACHINE_CLIENT_TELEMETRY_FIELDS,
  describeMachineClientProfile,
  filterToolsForProfile,
  machineClientMeterIdentity,
  machineClientProfileById,
  machineClientTelemetry,
  profileAllowsTool,
  resolveMachineClientProfile,
  validateMachineClientProfiles,
} from "../capabilities/machine_client_profile.mjs";
import {
  MCP_PUBLIC_CAPABILITY_TOOL_BINDINGS,
  MCP_TOOLS,
  MCP_TOOL_BINDINGS,
} from "../capabilities/mcp_tool_declarations.mjs";

const PROFILE = machineClientProfileById("public-research-read");
const PRIMARY_BINDING = "MCP_CLIENT_PUBLIC_RESEARCH_TOKEN";
const PREVIOUS_BINDING = "MCP_CLIENT_PUBLIC_RESEARCH_TOKEN_PREVIOUS";
const LIVE_SECRET = "EXAMPLE-ONLY-not-a-real-credential";
const WATCH_TOOLS = ["preview_watch", "create_watch"];

function auth(secret) {
  return `Bearer ${secret}`;
}

// ---------------------------------------------------------------- A1: the grant

test("A1 · the credential maps to a stable profile id and an exact allowlist", () => {
  assert.ok(PROFILE, "the first profile is registered under a stable id");
  assert.equal(PROFILE.id, "public-research-read");
  assert.ok(Object.isFrozen(MACHINE_CLIENT_PROFILES), "profiles are frozen declarations");

  // The allowlist is an exact literal, not a runtime filter over the registry.
  assert.ok(Array.isArray(PROFILE.allowlist));
  assert.equal(PROFILE.allowlist.length, 15);
  assert.equal(new Set(PROFILE.allowlist).size, PROFILE.allowlist.length);

  // ...and it is exactly the registered public-read set, so the literal cannot drift.
  assert.deepEqual(
    [...PROFILE.allowlist].sort(),
    MCP_PUBLIC_CAPABILITY_TOOL_BINDINGS.map((binding) => binding.name).sort(),
  );
});

test("A1 · every declared profile validates against the capability registry", () => {
  assert.deepEqual(validateMachineClientProfiles(), []);
});

test("A1 · validation rejects a grant the registry does not support", () => {
  const forged = [{
    ...PROFILE,
    id: "forged",
    secretBindings: ["FORGED_TOKEN"],
    allowlist: ["create_watch"],
  }];
  const problems = validateMachineClientProfiles(forged);
  assert.ok(problems.length > 0, "an ungranted tool must not validate");
  assert.ok(problems.some((p) => p.includes("create_watch")));
});

// ------------------------------------------------- A2/A3: discovery and calls

test("A2 · the listing returns only the tools the profile was granted", () => {
  const listed = filterToolsForProfile(MCP_TOOLS, PROFILE).map((tool) => tool.name);
  assert.deepEqual(listed, PROFILE.allowlist);

  // Discovery is authority: the withheld tools must not appear at all.
  for (const withheld of WATCH_TOOLS) {
    assert.ok(MCP_TOOLS.some((tool) => tool.name === withheld), `${withheld} exists on the endpoint`);
    assert.ok(!listed.includes(withheld), `${withheld} must not be discoverable by the profile`);
  }
});

test("A3 · an ungranted tool is refused even when the caller knows its name", () => {
  for (const withheld of WATCH_TOOLS) {
    assert.equal(profileAllowsTool(PROFILE, withheld), false);
  }
  assert.equal(profileAllowsTool(PROFILE, "get_notice"), true);
  assert.equal(profileAllowsTool(PROFILE, "no_such_tool"), false);
});

// -------------------------------------------------------------- A4: quota

test("A4 · a profile meters on its own id, not the connecting address", () => {
  const identity = machineClientMeterIdentity(PROFILE, "203.0.113.9");
  assert.equal(identity.keyedBy, "client_profile");
  assert.equal(identity.meter, MACHINE_CLIENT_METER);
  assert.equal(identity.actor, PROFILE.id);
  assert.equal(identity.limit, PROFILE.dailyRequestLimit);
  assert.notEqual(identity.actor, "203.0.113.9");
});

test("A4 · two addresses behind one profile share the profile's bucket, not an address bucket", () => {
  const a = machineClientMeterIdentity(PROFILE, "203.0.113.9");
  const b = machineClientMeterIdentity(PROFILE, "198.51.100.4");
  assert.deepEqual(a, b, "the meter key must not vary with the connecting address");
});

test("A4 · profile and anonymous quotas are isolated from each other", () => {
  const named = machineClientMeterIdentity(PROFILE, "203.0.113.9");
  const anonymous = machineClientMeterIdentity(null, "203.0.113.9");
  assert.equal(anonymous.keyedBy, "connecting_address");
  assert.equal(anonymous.meter, ANONYMOUS_ADDRESS_METER);
  assert.notEqual(named.meter, anonymous.meter, "distinct meter namespaces");
  assert.notEqual(named.actor, anonymous.actor, "distinct meter actors");
});

// --------------------------------------------- A5/A10: credential containment

test("A5 · a profile declares secret binding NAMES, never a secret value", () => {
  const serialized = JSON.stringify(MACHINE_CLIENT_PROFILES);
  assert.ok(serialized.includes(PRIMARY_BINDING), "the binding name is declared");
  assert.ok(!serialized.includes(LIVE_SECRET), "no secret value is present in the declaration");
  for (const binding of PROFILE.secretBindings) {
    assert.match(binding, /^[A-Z][A-Z0-9_]*$/, "a binding name, not a value");
  }
});

test("A5 · the receipt-safe projection carries no credential", () => {
  const described = describeMachineClientProfile(PROFILE);
  const serialized = JSON.stringify(described);
  assert.ok(!serialized.includes(LIVE_SECRET));
  assert.deepEqual(described.secret_binding_names, [...PROFILE.secretBindings]);
  assert.equal(described.quota_keyed_by, "client_profile");
  assert.deepEqual(described.granted_tools, [...PROFILE.allowlist]);
  assert.deepEqual(described.excluded_authority, [...MACHINE_CLIENT_EXCLUDED_AUTHORITY]);
});

test("A5 · resolution never returns the presented or configured credential", async () => {
  const env = { [PRIMARY_BINDING]: LIVE_SECRET };
  const resolved = await resolveMachineClientProfile(env, auth(LIVE_SECRET));
  assert.equal(resolved.resolution, "profile");
  assert.ok(!JSON.stringify(resolved).includes(LIVE_SECRET));
});

test("A10 · no committed generated-client artifact can carry the credential", () => {
  const root = new URL("../integrations/generated-client/", import.meta.url).pathname;
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(root);
  assert.ok(files.length > 0, "the generated client is present");
  for (const path of files) {
    const text = readFileSync(path, "utf8");
    assert.ok(!text.includes(LIVE_SECRET), `${path} must not contain a credential value`);
    // The generated client is handed to third parties: it must not even name the
    // binding that holds the gateway's secret.
    for (const binding of PROFILE.secretBindings) {
      assert.ok(!text.includes(binding), `${path} must not name the secret binding ${binding}`);
    }
  }
});

// ------------------------------------------------- A6: anonymous compatibility

test("A6 · with no credential configured, callers stay anonymous with the full inventory", async () => {
  const resolved = await resolveMachineClientProfile({}, null);
  assert.equal(resolved.resolution, "anonymous");
  assert.equal(resolved.profile, null);
  assert.deepEqual(filterToolsForProfile(MCP_TOOLS, resolved.profile), MCP_TOOLS);
  assert.equal(profileAllowsTool(resolved.profile, "create_watch"), true);
});

test("A6 · the endpoint-wide bearer keeps its pre-existing behavior", async () => {
  const env = { MCP_BEARER_TOKEN: "s3cret" };
  const denied = await resolveMachineClientProfile(env, null);
  assert.equal(denied.resolution, "unauthorized");

  const wrong = await resolveMachineClientProfile(env, auth("nope"));
  assert.equal(wrong.resolution, "unauthorized");

  // A correct endpoint-wide bearer authenticates WITHOUT naming a profile, so it keeps
  // the unfiltered inventory and the per-address meter exactly as before.
  const ok = await resolveMachineClientProfile(env, auth("s3cret"));
  assert.equal(ok.resolution, "anonymous");
  assert.equal(ok.profile, null);
});

test("A6 · a profile credential and the endpoint-wide bearer can run side by side", async () => {
  const env = { MCP_BEARER_TOKEN: "s3cret", [PRIMARY_BINDING]: LIVE_SECRET };
  assert.equal((await resolveMachineClientProfile(env, auth("s3cret"))).resolution, "anonymous");
  const named = await resolveMachineClientProfile(env, auth(LIVE_SECRET));
  assert.equal(named.resolution, "profile");
  assert.equal(named.profile.id, PROFILE.id);
});

// ------------------------------------------------------------- A7: rotation

test("A7 · either rotation binding authenticates the same profile with the same grant", async () => {
  const during = { [PRIMARY_BINDING]: "new-value", [PREVIOUS_BINDING]: "old-value" };
  const viaNew = await resolveMachineClientProfile(during, auth("new-value"));
  const viaOld = await resolveMachineClientProfile(during, auth("old-value"));
  assert.equal(viaNew.resolution, "profile");
  assert.equal(viaOld.resolution, "profile");
  assert.equal(viaNew.profile.id, viaOld.profile.id);
  assert.deepEqual(viaNew.profile.allowlist, viaOld.profile.allowlist);
  assert.deepEqual(
    machineClientMeterIdentity(viaNew.profile, "203.0.113.9"),
    machineClientMeterIdentity(viaOld.profile, "198.51.100.4"),
    "rotation must not move the quota key",
  );
});

test("A7 · revoking a binding stops it authenticating without downgrading to anonymous", async () => {
  const after = { [PRIMARY_BINDING]: "new-value" };
  const revoked = await resolveMachineClientProfile(after, auth("old-value"));
  assert.equal(revoked.resolution, "unauthorized", "a revoked credential must fail closed");

  const current = await resolveMachineClientProfile(after, auth("new-value"));
  assert.equal(current.resolution, "profile");
  assert.deepEqual(current.profile.allowlist, PROFILE.allowlist, "capability semantics are unchanged");
});

test("A7 · an unset binding never matches an empty or absent credential", async () => {
  const env = { [PRIMARY_BINDING]: "", [PREVIOUS_BINDING]: undefined };
  assert.equal((await resolveMachineClientProfile(env, auth(""))).resolution, "anonymous");
  assert.equal((await resolveMachineClientProfile(env, "Bearer")).resolution, "anonymous");
});

// ------------------------------------------------------------ A8: telemetry

test("A8 · a telemetry record carries exactly the declared fields", () => {
  const record = machineClientTelemetry({
    profileId: PROFILE.id,
    capabilityReference: "notice.search@1",
    availability: "complete",
    durationMs: 42.6,
    count: 3,
    errorClass: "none",
  });
  assert.deepEqual(Object.keys(record).sort(), [...MACHINE_CLIENT_TELEMETRY_FIELDS].sort());
  assert.equal(record.capability_reference, "notice.search@1");
  assert.equal(record.availability, "complete");
  assert.equal(record.duration_ms, 43);
  assert.equal(record.count, 3);
  assert.equal(record.error_class, "none");
});

test("A8 · telemetry cannot be widened with prompt or response content", () => {
  const record = machineClientTelemetry({
    profileId: PROFILE.id,
    request: "MARKER-a-resident-identifying-question",
    response: "MARKER-a-resident-identifying-answer",
    arguments: { query: "MARKER-caller-query-text" },
    bearer: LIVE_SECRET,
  });
  assert.deepEqual(Object.keys(record).sort(), [...MACHINE_CLIENT_TELEMETRY_FIELDS].sort());
  const serialized = JSON.stringify(record);
  assert.ok(!serialized.includes("MARKER-"), "no caller-supplied content survives");
  assert.ok(!serialized.includes(LIVE_SECRET));
});

test("A8 · an unrecognized error class degrades to a known class, never free text", () => {
  const record = machineClientTelemetry({ errorClass: "sql: syntax error near 'DROP'" });
  assert.ok(MACHINE_CLIENT_ERROR_CLASSES.includes(record.error_class));
  assert.equal(record.error_class, "internal");
});

// ------------------------------------------------------------- A9: authority

test("A9 · the grant carries no mutation, subscription, email or store authority", () => {
  const bindings = new Map(MCP_TOOL_BINDINGS.map((binding) => [binding.name, binding]));
  for (const name of PROFILE.allowlist) {
    const binding = bindings.get(name);
    assert.ok(binding, `${name} is a declared tool`);
    assert.equal(binding.operationClass, "read", `${name} is a read`);
    assert.equal(binding.authorityClass, "public_read", `${name} is a public read`);
    assert.equal(binding.storeAccess, "provider-only", `${name} reaches no store directly`);
    assert.ok(binding.capabilityReference, `${name} is a registered capability`);
  }
});

test("A9 · the negative rule's exclusions are declared and honored", () => {
  for (const excluded of ["watch-preview", "watch-creation", "future-mutations",
    "administrative-routes", "raw-source-or-store-access", "subscription", "email"]) {
    assert.ok(MACHINE_CLIENT_EXCLUDED_AUTHORITY.includes(excluded), `${excluded} is declared excluded`);
  }
  // A mutation cannot be granted even if a future edit lists it.
  const mutations = MCP_TOOL_BINDINGS.filter((binding) => binding.operationClass === "mutation");
  assert.ok(mutations.length > 0, "the endpoint still has mutations to exclude");
  for (const mutation of mutations) {
    assert.ok(!PROFILE.allowlist.includes(mutation.name), `${mutation.name} is not granted`);
  }
});


test("revoking the last profile binding rejects its former credential", async () => {
  for (const env of [{}, { [PRIMARY_BINDING]: "", [PREVIOUS_BINDING]: undefined }]) {
    assert.deepEqual(await resolveMachineClientProfile(env, auth(LIVE_SECRET)), {
      resolution: "unauthorized", profile: null,
    });
    assert.equal((await resolveMachineClientProfile(env, null)).resolution, "anonymous");
  }
});
