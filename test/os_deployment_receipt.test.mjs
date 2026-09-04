// CS-12 · Contract tests for the Cloudflare OS deployment receipt.
//
// These tests are deliberately fixture-driven and offline. The deployment they
// describe lives in a separate private repository along with the receipts a
// real deploy produces; what this repository owns is the contract those
// receipts must satisfy, so the checks here run against constructed receipts
// rather than against a deployment.
//
// The base fixture below is a *schema example*, not evidence. It is defined in
// this file and never written to artifacts/, because a receipt that no deploy
// produced is exactly the fabricated evidence CS-09 exists to prevent.
//
// Card: cityscroll-capability-spine/cs-12-os-deployment-foundation
// Verify: node --test test/os_deployment_receipt.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import { deriveMaximumProvableClass } from "../capabilities/evidence_classification.mjs";
import {
  ALLOWED_OPERATIONAL_LOG_FIELDS,
  CLOUDFLARE_OS_REPOSITORY,
  NON_UPSTREAM_PACKAGE_REFERENCES,
  PUBLICLY_ROUTED_ROLE,
  REQUIRED_WORKER_ROLES,
  STARTER_REPOSITORY,
  assertOsDeploymentReceipt,
  findConnectionClaims,
  findUnsanitizedValues,
} from "../capabilities/os_deployment_receipt.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const UPSTREAM_REFERENCE_PATH = "integrations/cloudflare-os-starter/upstream-reference.json";

const VERSION_IDS = {
  router: "6f2a1c04-9d3b-4e57-8a10-2b7c9d4e51f0",
  workshop: "1b8e3d72-40af-4c19-9e63-7d5a0c28b4e1",
  context: "c4d9027e-51ba-4f38-8c72-9a1e6b30df45",
  scheduler: "9e51a3b6-7c24-4d80-b1f9-3e08a7c62d5b",
  customGatekeeper: "23f7c86d-0b41-49ea-97c5-6d2b8fa10e34",
  errorReporter: "afd2650b-3e97-4c12-88b6-05a9c7e41d20",
};
const PRIOR_VERSION_IDS = {
  router: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  workshop: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  context: "2a3b4c5d-6e7f-4a8b-8c0d-1e2f3a4b5c6d",
  scheduler: "3a4b5c6d-7e8f-4a9b-8c1d-2e3f4a5b6c7d",
  customGatekeeper: "4a5b6c7d-8e9f-4a0b-8c2d-3e4f5a6b7c8d",
  errorReporter: "5a6b7c8d-9e0f-4a1b-8c3d-4e5f6a7b8c9d",
};

function backendWorker(role) {
  return {
    name: `os-eval-${role.toLowerCase()}`,
    version_id: VERSION_IDS[role],
    verified_by: "cloudflare_api",
    public_route: null,
    workers_dev: false,
    service_binding: role.toUpperCase(),
    reachable_from_router: true,
  };
}

/** A receipt shaped the way a real deploy's receipt must be shaped. */
function baseReceipt() {
  return {
    schema: "cityscroll.cloudflare_os_deployment_receipt.v1",
    card: "cityscroll-capability-spine/cs-12-os-deployment-foundation",
    evidence_class: "cloudflare_os_deployed",
    execution_environment: "cloudflare-os-deployment",
    upstream: {
      starter: {
        repository: STARTER_REPOSITORY,
        commit: "3d211477ad009e13a98d863d843e5c12a29ad02b",
        check: { command: "pnpm check", passed: true, exit_code: 0 },
      },
      cloudflare_os: {
        repository: CLOUDFLARE_OS_REPOSITORY,
        submodule_commit: "6478a1448a11524e2f7c2575ad66fab0bc47c433",
      },
    },
    workers: {
      router: {
        name: "os-eval-router",
        version_id: VERSION_IDS.router,
        verified_by: "cloudflare_deploy_output",
        public_route: "https://lab.example.org/",
        workers_dev: false,
      },
      workshop: backendWorker("workshop"),
      context: backendWorker("context"),
      scheduler: backendWorker("scheduler"),
      customGatekeeper: backendWorker("customGatekeeper"),
      errorReporter: backendWorker("errorReporter"),
    },
    access: {
      mode: "cloudflare_access",
      application_id: "7c1d9e42-3b58-4a06-9f21-8d40b6e57c93",
      audience_tag: "2f8b1d47c30e9a56b84f27d13e0a95c6f41b78d29e35a067c1b4d982e70a3f65",
      public_signup_enabled: false,
      allowlist_size: 1,
      administrator_identifiers_redacted: true,
      unauthenticated_request: { admitted: false, response_status: 302 },
      approved_evaluator_request: { admitted: true, response_status: 200 },
    },
    agent_turn: { interface_opened: true, started: true, model_call_live: true },
    spend_governance: {
      provider: "cloudflare",
      external_provider_credentials: [],
      ceiling_usd: 25,
      enforcement: "fail_closed",
      on_exceeded_status: 429,
      governed_by_rule_id: "b7e40a92-1c58-4d63-8f07-25a9c3e61b48",
      enforced_controls: [
        { mechanism: "ai_gateway_spend_limit", limit_usd: 5, scope: "sliding_day", enforcement: "fail_closed", deployed: true },
        { mechanism: "ai_gateway_spend_limit", limit_usd: 25, scope: "evaluation_total", enforcement: "fail_closed", deployed: true },
      ],
    },
    bindings: [
      { binding: "BLUEPRINTS_KV", type: "kv_namespace", resource_id: "kv-os-eval-blueprints", isolated_from_production: true },
      { binding: "BLUEPRINT_CONTENT", type: "r2_bucket", resource_id: "r2-os-eval-blueprints", isolated_from_production: true },
    ],
    rollback_rehearsal: {
      performed: true,
      verified_by: "cloudflare_api",
      workers: Object.fromEntries(
        REQUIRED_WORKER_ROLES.map((role) => [
          role,
          { prior_version_id: PRIOR_VERSION_IDS[role], restored_version_id: VERSION_IDS[role] },
        ]),
      ),
    },
    retention: {
      operational_metadata_only: true,
      retention_days: 7,
      workspace_deletion_due_days: 30,
      fields: [...ALLOWED_OPERATIONAL_LOG_FIELDS],
    },
    protocol: { transport: "https", negotiated_version: "2025-06-18" },
    network_observation: {
      transport: "public-internet",
      dns_resolved: true,
      response_status: 200,
      fetch_override: false,
      transport_intercepted: false,
    },
    provider_issued_identifier: {
      kind: "worker_version",
      value: VERSION_IDS.router,
      verified_by: "cloudflare_api",
      verification_method: "GET /accounts/:account_id/workers/scripts/:name/versions",
    },
    cloudflare_os_deployment: {
      control_plane_response: true,
      provider_receipt_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    },
  };
}

function assertRejects(receipt, pattern) {
  assert.throws(() => assertOsDeploymentReceipt(receipt), pattern);
}

test("the schema example satisfies the deployment contract", () => {
  const result = assertOsDeploymentReceipt(baseReceipt());
  assert.equal(result.evidenceClass, "cloudflare_os_deployed");
});

test("A1: the receipt must pin the real starter repository and a full commit", () => {
  const missingCommit = baseReceipt();
  missingCommit.upstream.starter.commit = "3d21147";
  assertRejects(missingCommit, /upstream\.starter\.commit must be a full 40-character commit id/);

  const wrongRepository = baseReceipt();
  wrongRepository.upstream.starter.repository = "https://github.com/example/cloudflare-os-starter";
  assertRejects(wrongRepository, /upstream\.starter\.repository must be/);

  const missingSubmodule = baseReceipt();
  delete missingSubmodule.upstream.cloudflare_os.submodule_commit;
  assertRejects(missingSubmodule, /upstream\.cloudflare_os\.submodule_commit must be a full 40-character commit id/);
});

test("A1: a receipt naming a package the pinned starter does not contain is rejected", () => {
  // The rehearsal manifests already in this repository name this package. A
  // real pin paired with the invented package shape is the exact overstatement
  // CS-09 corrected, so it is refused rather than tolerated.
  const fictional = baseReceipt();
  fictional.upstream.gatekeeper = { package: NON_UPSTREAM_PACKAGE_REFERENCES[0], mode: "named-tools" };
  assertRejects(fictional, /packages\/gatekeeper-mcp, which is not part of the pinned starter/);
});

test("A2: the pinned revision's own check command must be recorded as passing", () => {
  const noCheck = baseReceipt();
  delete noCheck.upstream.starter.check;
  assertRejects(noCheck, /the pinned revision's own check command must be recorded/);

  const failedCheck = baseReceipt();
  failedCheck.upstream.starter.check.passed = false;
  failedCheck.upstream.starter.check.exit_code = 1;
  assertRejects(failedCheck, /upstream\.starter\.check\.passed must be true/);
});

test("A3: all six Workers must be recorded with provider-issued version identifiers", () => {
  for (const role of REQUIRED_WORKER_ROLES) {
    const missing = baseReceipt();
    delete missing.workers[role];
    assertRejects(missing, new RegExp(`workers\\.${role} is missing`));
  }

  const shapedOnly = baseReceipt();
  shapedOnly.workers.context.version_id = "context-worker-v3";
  assertRejects(shapedOnly, /workers\.context\.version_id must be a Cloudflare-issued Worker version id/);

  const unattributed = baseReceipt();
  unattributed.workers.workshop.verified_by = "deployment_notes";
  assertRejects(unattributed, /workers\.workshop\.verified_by must name the Cloudflare control-plane source/);
});

test("A3: every backend Worker must be reachable from the router over a service binding", () => {
  const unbound = baseReceipt();
  delete unbound.workers.scheduler.service_binding;
  assertRejects(unbound, /workers\.scheduler\.service_binding is missing/);

  const unreachable = baseReceipt();
  unreachable.workers.errorReporter.reachable_from_router = false;
  assertRejects(unreachable, /workers\.errorReporter\.reachable_from_router must be true/);
});

test("A4: only the router may carry a public route", () => {
  const exposedBackend = baseReceipt();
  exposedBackend.workers.workshop.public_route = "https://lab.example.org/api";
  assertRejects(exposedBackend, /workers\.workshop\.public_route must be null/);

  const exposedViaWorkersDev = baseReceipt();
  exposedViaWorkersDev.workers.customGatekeeper.workers_dev = true;
  assertRejects(exposedViaWorkersDev, /workers\.customGatekeeper\.workers_dev must be false/);

  const unroutedRouter = baseReceipt();
  unroutedRouter.workers.router.public_route = null;
  assertRejects(unroutedRouter, /workers\.router\.public_route is missing/);
});

test("A4: exactly one Worker is publicly routed and it is the router", () => {
  const twoRoutes = baseReceipt();
  twoRoutes.workers.context.public_route = "https://lab.example.org/context";
  assert.throws(
    () => assertOsDeploymentReceipt(twoRoutes),
    new RegExp(`exactly one Worker may carry a public route and it must be the ${PUBLICLY_ROUTED_ROLE}`),
  );
});

test("A5: access control must be observed rejecting and admitting, not merely configured", () => {
  const noObservation = baseReceipt();
  delete noObservation.access.unauthenticated_request;
  assertRejects(noObservation, /rejection must be observed, not assumed/);

  const admittedAnonymously = baseReceipt();
  admittedAnonymously.access.unauthenticated_request.admitted = true;
  assertRejects(admittedAnonymously, /access\.unauthenticated_request\.admitted must be false/);

  const evaluatorRejected = baseReceipt();
  evaluatorRejected.access.approved_evaluator_request.admitted = false;
  assertRejects(evaluatorRejected, /access\.approved_evaluator_request\.admitted must be true/);
});

test("A5: the access application must record its audience and keep signup closed", () => {
  const noAudience = baseReceipt();
  delete noAudience.access.audience_tag;
  assertRejects(noAudience, /access\.audience_tag is missing/);

  const openSignup = baseReceipt();
  openSignup.access.public_signup_enabled = true;
  assertRejects(openSignup, /access\.public_signup_enabled must be false/);
});

test("A6: the receipt must record an opened interface and a started turn", () => {
  const noTurn = baseReceipt();
  delete noTurn.agent_turn;
  assertRejects(noTurn, /the evaluator must have opened the interface and started a turn/);

  const notStarted = baseReceipt();
  notStarted.agent_turn.started = false;
  assertRejects(notStarted, /agent_turn\.started must be true/);
});

test("A7: the live model call must be governed by a fail-closed ceiling", () => {
  const noCeiling = baseReceipt();
  delete noCeiling.spend_governance.ceiling_usd;
  assertRejects(noCeiling, /spend_governance\.ceiling_usd must be a positive dollar ceiling/);

  // Falling back to a cheaper model keeps spending; for a fixed evaluation
  // budget the only acceptable behavior at the limit is to stop.
  const degrades = baseReceipt();
  degrades.spend_governance.enforcement = "fallback_model";
  assertRejects(degrades, /spend_governance\.enforcement must be fail_closed/);

  const untraceable = baseReceipt();
  delete untraceable.spend_governance.governed_by_rule_id;
  assertRejects(untraceable, /the live call must name the rule that governed it/);
});

test("A7: a ceiling that is not deployed in the request path enforces nothing", () => {
  // The exact gap this contract exists to catch: a cumulative ceiling written
  // into the receipt while the thing that would enforce it sits outside the
  // request path.
  const notDeployed = baseReceipt();
  notDeployed.spend_governance.enforced_controls[1].deployed = false;
  assertRejects(notDeployed, /deployed must be true: a control outside the request path enforces nothing/);

  const declaredButAbsent = baseReceipt();
  declaredButAbsent.spend_governance.enforced_controls =
    [{ mechanism: "ai_gateway_spend_limit", limit_usd: 5, scope: "sliding_day", enforcement: "fail_closed", deployed: true }];
  assertRejects(declaredButAbsent, /is not among the deployed enforced controls/);

  const none = baseReceipt();
  delete none.spend_governance.enforced_controls;
  assertRejects(none, /must list the controls actually enforcing in the request path/);
});

test("A7: the evaluation adds no external provider credentials", () => {
  const external = baseReceipt();
  external.spend_governance.external_provider_credentials = ["openai"];
  assertRejects(external, /spend_governance\.external_provider_credentials must be empty/);

  const otherProvider = baseReceipt();
  otherProvider.spend_governance.provider = "anthropic";
  assertRejects(otherProvider, /spend_governance\.provider must be cloudflare/);
});

test("A8: resource bindings must be recorded and isolated from production", () => {
  const noBindings = baseReceipt();
  delete noBindings.bindings;
  assertRejects(noBindings, /provisioned resources must be recorded/);

  const sharedWithProduction = baseReceipt();
  sharedWithProduction.bindings[0].isolated_from_production = false;
  assertRejects(sharedWithProduction, /bindings\[0\]\.isolated_from_production must be true/);
});

test("A10: rollback must be rehearsed with provider-issued prior and restored versions", () => {
  const described = baseReceipt();
  described.rollback_rehearsal.performed = false;
  assertRejects(described, /rollback_rehearsal\.performed must be true/);

  const missingRole = baseReceipt();
  delete missingRole.rollback_rehearsal.workers.context;
  assertRejects(missingRole, /rollback_rehearsal\.workers\.context is missing/);

  const shapedPrior = baseReceipt();
  shapedPrior.rollback_rehearsal.workers.router.prior_version_id = "previous";
  assertRejects(shapedPrior, /rollback_rehearsal\.workers\.router\.prior_version_id must be a Cloudflare-issued Worker version id/);
});

test("A9: administrator identifiers and credentials are refused anywhere in the receipt", () => {
  const withEmail = baseReceipt();
  withEmail.access.administrator = "evaluator@example.org";
  assertRejects(withEmail, /email address present/);

  const withToken = baseReceipt();
  withToken.access.service_token = "abcdefghijklmnopqrstuvwxyz0123456789";
  assertRejects(withToken, /credential-shaped field name: service_token/);

  const withHeader = baseReceipt();
  withHeader.network_observation.authorization = "Bearer aabbccddeeff";
  assertRejects(withHeader, /bearer credential present/);
});

test("A9: local machine paths never reach a sanitized receipt", () => {
  const withPath = baseReceipt();
  // Assembled rather than written literally: the repository rejects absolute
  // home paths in tracked source, which is the rule this scan enforces at run time.
  withPath.upstream.starter.workspace = ["", "Users", "evaluator", "os-eval"].join("/");
  assertRejects(withPath, /local machine path present/);
});

test("A9: the sanitization scan reports the field it objected to", () => {
  const receipt = baseReceipt();
  receipt.access.administrator = "evaluator@example.org";
  const found = findUnsanitizedValues(receipt);
  assert.equal(found.length, 1);
  assert.equal(found[0].path, "$.access.administrator");
});

test("A9: an ordinary receipt has nothing to sanitize", () => {
  assert.deepEqual(findUnsanitizedValues(baseReceipt()), []);
});

test("A9: provider identifiers on admission evidence are not mistaken for secrets", () => {
  // Access evidence carries a ray id, an application uid and an identity
  // digest. All three are long and opaque by nature; flagging them would push
  // authors to drop exactly the identifiers that make an admission auditable.
  const receipt = baseReceipt();
  receipt.access.approved_evaluator_request = {
    admitted: true,
    evidence_source: "cloudflare_access_authentication_log",
    event_at: "2026-09-04T20:56:02Z",
    ray_id: "a35fe6074f39437f",
    app_uid: "27ff5e35-cbc7-4474-b8a4-a17eccae33f7",
    identity_digest_sha256_prefix: "a17c00b69ea8339d",
    identity_matches_policy_allowlist: true,
  };
  assert.deepEqual(findUnsanitizedValues(receipt), []);
  assert.doesNotThrow(() => assertOsDeploymentReceipt(receipt));

  // The digest stands in for the identity precisely so the address never
  // appears; an address alongside it is still refused.
  const withAddress = baseReceipt();
  withAddress.access.approved_evaluator_request = {
    admitted: true,
    ray_id: "a35fe6074f39437f",
    identity: "evaluator@example.org",
  };
  assertRejects(withAddress, /email address present/);
});

test("A11: the receipt is classified as a deployment and nothing higher", () => {
  const understated = baseReceipt();
  understated.evidence_class = "external_live_endpoint";
  assertRejects(understated, /evidence_class must be cloudflare_os_deployed/);

  // An OS-issued agent session is a later card's evidence. Carrying one here
  // would mean the receipt is describing more than a deployment.
  const withAgentSession = baseReceipt();
  withAgentSession.cloudflare_os_agent_session = { provider_issued: true, session_id: "sess-01" };
  assertRejects(withAgentSession, /prove "cloudflare_os_agent_exercised" rather than exactly "cloudflare_os_deployed"/);
});

test("A11: a receipt without control-plane attestation cannot claim a deployment", () => {
  const noAttestation = baseReceipt();
  delete noAttestation.cloudflare_os_deployment;
  assertRejects(noAttestation, /declares "cloudflare_os_deployed" but its own facts only prove "external_live_endpoint"/);

  const noProviderIdentifier = baseReceipt();
  delete noProviderIdentifier.provider_issued_identifier;
  assertRejects(noProviderIdentifier, /missing provider_issued_identifier/);
});

test("A11: a rehearsal flag anywhere in the receipt disqualifies the deployment class", () => {
  const rehearsal = baseReceipt();
  rehearsal.agent_turn.executor = "isolated-in-process-rehearsal";
  assertRejects(rehearsal, /executor: isolated-in-process-rehearsal/);
});

test("A12: a deployment receipt may not claim CityScroll is connected", () => {
  const claimsKey = baseReceipt();
  claimsKey.cityscroll_connected = true;
  assertRejects(claimsKey, /asserts cityscroll_connected/);

  const claimsProse = baseReceipt();
  claimsProse.summary = "CityScroll is now connected to the deployment.";
  assertRejects(claimsProse, /prose asserts a CityScroll connection/);

  const claimsGrant = baseReceipt();
  claimsGrant.capability_grant = ["notice.search@1"];
  assertRejects(claimsGrant, /asserts capability_grant/);
});

test("A12: an explicit negative connection field is allowed", () => {
  const explicit = baseReceipt();
  explicit.cityscroll_connected = false;
  assert.deepEqual(findConnectionClaims(explicit), []);
  assert.doesNotThrow(() => assertOsDeploymentReceipt(explicit));
});

test("retention is limited to structured operational metadata", () => {
  const overRetained = baseReceipt();
  overRetained.retention.fields = [...ALLOWED_OPERATIONAL_LOG_FIELDS, "prompt"];
  assertRejects(overRetained, /retention\.fields includes prompt, which is not operational metadata/);

  const unbounded = baseReceipt();
  delete unbounded.retention.retention_days;
  assertRejects(unbounded, /retention\.retention_days must be a positive number of days/);

  const noDeletionDate = baseReceipt();
  delete noDeletionDate.retention.workspace_deletion_due_days;
  assertRejects(noDeletionDate, /retention\.workspace_deletion_due_days must be a positive number of days/);
});

test("every violation is reported in one pass rather than one at a time", () => {
  const broken = baseReceipt();
  delete broken.workers.context;
  delete broken.access.audience_tag;
  broken.retention.operational_metadata_only = false;
  try {
    assertOsDeploymentReceipt(broken);
    assert.fail("expected the receipt to be rejected");
  } catch (error) {
    assert.match(error.message, /3 violation\(s\)/);
    assert.match(error.message, /workers\.context is missing/);
    assert.match(error.message, /access\.audience_tag is missing/);
    assert.match(error.message, /retention\.operational_metadata_only must be true/);
  }
});

test("the contract gates a receipt that clears the evidence-class floor", () => {
  // The two layers are independent on purpose. CS-09 asks how far a receipt's
  // facts reach; this contract asks whether the deployment facts this card
  // needs are present. A receipt can clear the first and still fail the
  // second, and the readiness state must stay unproven when it does.
  const floorOnly = baseReceipt();
  delete floorOnly.rollback_rehearsal;
  delete floorOnly.access;

  const { maxClass } = deriveMaximumProvableClass(floorOnly);
  assert.equal(maxClass, "cloudflare_os_deployed", "the receipt still clears the evidence-class floor");
  assertRejects(floorOnly, /rollback must be rehearsed, not described/);
});

test("the deployment's shape matches the pinned starter reference", () => {
  const reference = JSON.parse(readFileSync(resolve(ROOT, UPSTREAM_REFERENCE_PATH), "utf8"));
  assert.equal(reference.starter.repository, STARTER_REPOSITORY);
  assert.equal(reference.cloudflare_os.repository, CLOUDFLARE_OS_REPOSITORY);
  assert.deepEqual(reference.starter.worker_roles, [...REQUIRED_WORKER_ROLES]);
  assert.equal(reference.starter.publicly_routed_role, PUBLICLY_ROUTED_ROLE);

  // The reference exists to correct the rehearsal manifests, so the package
  // path they invented must not reappear in it.
  for (const invented of NON_UPSTREAM_PACKAGE_REFERENCES) {
    assert.equal(reference.starter.packages.includes(invented), false);
  }

  // A reference document is not deployment evidence and must never be read as
  // any evidence class.
  assert.equal(reference.provides_deployment_evidence, false);
  assert.equal("evidence_class" in reference, false);
});

test("this repository publishes the contract, not a deployment receipt", () => {
  // The public half of the split is the schema and these tests. A receipt that
  // no deploy produced must never be committed here as evidence, so the
  // example above stays inside this file.
  const contractSource = readFileSync(resolve(ROOT, "capabilities/os_deployment_receipt.mjs"), "utf8");
  assert.doesNotMatch(contractSource, /\bcloudflare_os_deployment_receipt\.v1\b/, "the contract module must not embed an example receipt");

  // The needle is assembled at run time so this assertion does not match its
  // own source text.
  const artifactPath = ["artifacts", "capability-spine", "cs-12"].join("/");
  const testSource = readFileSync(import.meta.filename, "utf8");
  assert.equal(testSource.includes(artifactPath), false, "the example receipt must never be written under artifacts/");
  assert.equal(/\bwriteFileSync\b/.test(testSource.replace(/"[^"]*"/g, '""')), false, "these tests must not write files");
});
