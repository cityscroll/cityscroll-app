// CS-12 · Public contract for a Cloudflare OS deployment receipt.
//
// CS-09 established the five evidence classes and the mechanical floor every
// receipt must clear to claim one. This module is the layer above that floor:
// it states what a *deployment* receipt for the Cloudflare OS evaluation
// instance must additionally carry before it may be published as
// `cloudflare_os_deployed` evidence.
//
// The repository boundary matters here. The deployment itself — the pinned
// starter, the account, Worker names, Access configuration and the receipts
// produced by a real deploy — lives in the private deployment repository. What
// belongs in this public repository is the *contract*: the schema a receipt
// must satisfy and the tests that enforce it. That split is what lets the
// semantic contract stay public while deployment detail stays private, and it
// is why this module reads receipts but never produces one.
//
// Nothing here can manufacture deployment evidence. Every required fact is a
// provider-issued identifier, an observed response, or a recorded control-plane
// attestation; a receipt that lacks them is rejected rather than downgraded.
//
// Card: cityscroll-capability-spine/cs-12-os-deployment-foundation

import { assertReceiptEvidenceClass, deriveMaximumProvableClass } from "./evidence_classification.mjs";

/**
 * The deployment is six Workers. A router owns the public route and serves the
 * frontend, proxying to the Workshop backend and to whichever Gatekeeper the
 * binding name matches; the rest sit behind it with no route of their own.
 * These role keys are the starter's own, not names invented here.
 */
export const REQUIRED_WORKER_ROLES = Object.freeze([
  "router",
  "workshop",
  "context",
  "scheduler",
  "customGatekeeper",
  "errorReporter",
]);

/** The one role permitted to carry a public route. */
export const PUBLICLY_ROUTED_ROLE = "router";

export const STARTER_REPOSITORY = "https://github.com/cloudflare/cloudflare-os-starter";
export const CLOUDFLARE_OS_REPOSITORY = "https://github.com/cloudflare/cloudflare-os";

/**
 * Package paths that appear in this repository's earlier rehearsal manifests
 * but do not exist in the upstream starter. A receipt naming one of these is
 * describing the rehearsal's invented shape rather than the deployed release.
 */
export const NON_UPSTREAM_PACKAGE_REFERENCES = Object.freeze(["packages/gatekeeper-mcp"]);

/**
 * The only operational fields an evaluation deployment retains. Anything
 * outside this set — prompt text, model output, source documents, user
 * content, administrator identity — is out of scope for retention and
 * therefore out of scope for a receipt that describes retention.
 */
export const ALLOWED_OPERATIONAL_LOG_FIELDS = Object.freeze([
  "service",
  "operation",
  "capability",
  "availability",
  "status",
  "latency_ms",
  "token_count",
  "cost_usd",
  "error_class",
  "release",
  "correlation_id",
]);

const PROVIDER_VERSION_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GIT_COMMIT_SHAPE = /^[0-9a-f]{40}$/;
const PROVIDER_ATTESTATION_SOURCES = Object.freeze(["cloudflare_api", "cloudflare_deploy_output"]);

/**
 * Keys whose values are commit-, digest- or version-shaped by design. The
 * sanitization scan below flags long opaque strings as possible secrets, so
 * the fields that are *supposed* to hold one are named explicitly rather than
 * inferred from the value's shape.
 */
const OPAQUE_VALUE_ALLOWLIST = Object.freeze([
  "name",
  "binding",
  "service_binding",
  "commit",
  "submodule_commit",
  "version_id",
  "prior_version_id",
  "restored_version_id",
  "provider_receipt_sha256",
  "application_id",
  "audience_tag",
  "account_id_sha256",
  "correlation_id",
  "gateway_id",
  "resource_id",
  "rule_id",
  "governed_by_rule_id",
  // Provider-issued identifiers and enum-like labels carried by access and
  // observation evidence. Long, opaque-looking, and structurally never secret.
  "app_uid",
  "ray_id",
  "evidence_source",
  "identity_digest_sha256_prefix",
  // Container fields whose members are identifiers rather than free text.
  "provider_issued_identifier",
  "cloudflare_os_deployment",
  "approved_evaluator_request",
]);

/**
 * Field names that read as credential-shaped but hold a list of provider
 * names, not credentials. Naming them keeps the scan strict everywhere else.
 */
const NON_CREDENTIAL_FIELD_NAMES = Object.freeze(["external_provider_credentials"]);

const EMAIL_SHAPE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const BEARER_SHAPE = /\bBearer\s+\S+/i;
const HOME_PATH_SHAPE = /(^|[\s"'(])(\/Users\/|\/home\/|\/var\/folders\/)/;
const LONG_OPAQUE_SHAPE = /^[A-Za-z0-9_-]{32,}$/;

const SECRET_KEY_SHAPE = /(secret|token|password|api[_-]?key|credential|private[_-]?key)/i;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function walk(value, visit, path = "$") {
  visit(value, path);
  if (Array.isArray(value)) {
    value.forEach((child, index) => walk(child, visit, `${path}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) walk(child, visit, `${path}.${key}`);
}

/**
 * Scans a receipt for anything that must never reach the public repository or
 * a sanitized receipt: administrator email addresses, credential-shaped keys,
 * bearer headers, local machine paths, and long opaque strings outside the
 * fields that legitimately hold a commit, digest or provider identifier.
 *
 * This is a positive scan over the receipt's own text rather than a promise
 * about how the receipt was produced (A9).
 */
export function findUnsanitizedValues(receipt) {
  const found = [];
  const visit = (node, path) => {
    if (isPlainObject(node)) {
      for (const key of Object.keys(node)) {
        if (SECRET_KEY_SHAPE.test(key) && !NON_CREDENTIAL_FIELD_NAMES.includes(key)) {
          found.push({ path: `${path}.${key}`, reason: `credential-shaped field name: ${key}` });
        }
      }
      return;
    }
    if (typeof node !== "string") return;
    // Both the field and its immediate container are consulted, so a value
    // held inside a named identifier object is not mistaken for a secret.
    const segments = path.split(".").map((segment) => segment.replace(/\[\d+\]$/, ""));
    const key = segments.at(-1);
    const parentKey = segments.at(-2);
    if (EMAIL_SHAPE.test(node)) found.push({ path, reason: "email address present" });
    if (BEARER_SHAPE.test(node)) found.push({ path, reason: "bearer credential present" });
    if (HOME_PATH_SHAPE.test(node)) found.push({ path, reason: "local machine path present" });
    const inIdentifierField = OPAQUE_VALUE_ALLOWLIST.includes(key) || OPAQUE_VALUE_ALLOWLIST.includes(parentKey);
    if (LONG_OPAQUE_SHAPE.test(node) && !inIdentifierField) {
      found.push({ path, reason: "long opaque value outside an identifier field" });
    }
  };
  walk(receipt, visit);
  return found;
}

/**
 * Phrases that would turn a deployment receipt into an integration claim. A
 * deployment proves that Cloudflare OS is running; it says nothing about
 * whether CityScroll is reachable from it, which is a separate card with its
 * own evidence (A12).
 */
const CONNECTION_CLAIM_SHAPE = /\b(cityscroll)\b[^.]{0,40}\b(connected|integrated|wired|reachable from cloudflare os)\b/i;
const CONNECTION_CLAIM_KEYS = Object.freeze([
  "cityscroll_connected",
  "gatekeeper_connected",
  "cityscroll_integration",
  "capability_grant",
]);

export function findConnectionClaims(receipt) {
  const found = [];
  const visit = (node, path) => {
    if (isPlainObject(node)) {
      for (const [key, child] of Object.entries(node)) {
        if (CONNECTION_CLAIM_KEYS.includes(key) && child !== false && child !== null) {
          found.push({ path: `${path}.${key}`, reason: `asserts ${key}` });
        }
      }
      return;
    }
    if (typeof node === "string" && CONNECTION_CLAIM_SHAPE.test(node)) {
      found.push({ path, reason: "prose asserts a CityScroll connection" });
    }
  };
  walk(receipt, visit);
  return found;
}

function requireUpstreamPins(receipt, errors) {
  const upstream = receipt.upstream;
  if (!isPlainObject(upstream)) {
    errors.push("missing upstream: a deployment receipt must pin the starter it deployed");
    return;
  }
  const starter = upstream.starter;
  if (!isPlainObject(starter)) {
    errors.push("missing upstream.starter");
  } else {
    if (starter.repository !== STARTER_REPOSITORY) {
      errors.push(`upstream.starter.repository must be ${STARTER_REPOSITORY}`);
    }
    if (!GIT_COMMIT_SHAPE.test(starter.commit || "")) {
      errors.push("upstream.starter.commit must be a full 40-character commit id");
    }
    const check = starter.check;
    if (!isPlainObject(check)) {
      errors.push("missing upstream.starter.check: the pinned revision's own check command must be recorded");
    } else {
      if (typeof check.command !== "string" || !check.command) errors.push("upstream.starter.check.command is missing");
      if (check.passed !== true) errors.push("upstream.starter.check.passed must be true");
      if (check.exit_code !== 0) errors.push("upstream.starter.check.exit_code must be 0");
    }
  }

  const os = upstream.cloudflare_os;
  if (!isPlainObject(os)) {
    errors.push("missing upstream.cloudflare_os");
  } else {
    if (os.repository !== CLOUDFLARE_OS_REPOSITORY) {
      errors.push(`upstream.cloudflare_os.repository must be ${CLOUDFLARE_OS_REPOSITORY}`);
    }
    if (!GIT_COMMIT_SHAPE.test(os.submodule_commit || "")) {
      errors.push("upstream.cloudflare_os.submodule_commit must be a full 40-character commit id");
    }
  }

  // The rehearsal manifests in this repository name a Gatekeeper package that
  // the upstream starter does not contain. Pinning a real revision and then
  // describing the invented package shape would reintroduce exactly the
  // overstatement CS-09 corrected.
  walk(upstream, (node, path) => {
    if (typeof node !== "string") return;
    for (const reference of NON_UPSTREAM_PACKAGE_REFERENCES) {
      if (node.includes(reference)) errors.push(`${path} names ${reference}, which is not part of the pinned starter`);
    }
  });
}

function requireWorkers(receipt, errors) {
  const workers = receipt.workers;
  if (!isPlainObject(workers)) {
    errors.push("missing workers: all six deployed Workers must be recorded");
    return;
  }
  const roles = Object.keys(workers);
  for (const role of REQUIRED_WORKER_ROLES) {
    if (!roles.includes(role)) errors.push(`workers.${role} is missing`);
  }
  for (const role of roles) {
    if (!REQUIRED_WORKER_ROLES.includes(role)) errors.push(`workers.${role} is not a role this deployment defines`);
  }

  for (const [role, worker] of Object.entries(workers)) {
    if (!isPlainObject(worker)) {
      errors.push(`workers.${role} is not an object`);
      continue;
    }
    if (typeof worker.name !== "string" || !worker.name) errors.push(`workers.${role}.name is missing`);
    // A Worker name and a plausible id prove nothing on their own; the version
    // must be one Cloudflare issued, attributed to the control-plane surface
    // that issued it (A8).
    if (!PROVIDER_VERSION_ID_SHAPE.test(worker.version_id || "")) {
      errors.push(`workers.${role}.version_id must be a Cloudflare-issued Worker version id`);
    }
    if (!PROVIDER_ATTESTATION_SOURCES.includes(worker.verified_by)) {
      errors.push(`workers.${role}.verified_by must name the Cloudflare control-plane source that issued the version`);
    }

    if (role === PUBLICLY_ROUTED_ROLE) {
      if (typeof worker.public_route !== "string" || !worker.public_route) {
        errors.push("workers.router.public_route is missing: the router owns the deployment's public route");
      }
    } else {
      // Only the router is reachable from outside; every other Worker is bound
      // to it and must carry no route of its own (A4).
      if (worker.public_route != null) errors.push(`workers.${role}.public_route must be null: only the router is publicly routed`);
      if (worker.workers_dev === true) errors.push(`workers.${role}.workers_dev must be false: only the router is publicly routed`);
      if (typeof worker.service_binding !== "string" || !worker.service_binding) {
        errors.push(`workers.${role}.service_binding is missing: the router reaches it over a service binding`);
      }
      if (worker.reachable_from_router !== true) {
        errors.push(`workers.${role}.reachable_from_router must be true`);
      }
    }
  }

  const publiclyRouted = Object.entries(workers)
    .filter(([, worker]) => isPlainObject(worker) && worker.public_route != null)
    .map(([role]) => role);
  if (publiclyRouted.length !== 1 || publiclyRouted[0] !== PUBLICLY_ROUTED_ROLE) {
    errors.push(`exactly one Worker may carry a public route and it must be the ${PUBLICLY_ROUTED_ROLE}; found: ${publiclyRouted.join(", ") || "none"}`);
  }
}

function requireAccess(receipt, errors) {
  const access = receipt.access;
  if (!isPlainObject(access)) {
    errors.push("missing access: the public route must sit behind access control");
    return;
  }
  if (access.mode !== "cloudflare_access") errors.push("access.mode must be cloudflare_access");
  if (typeof access.application_id !== "string" || !access.application_id) errors.push("access.application_id is missing");
  if (typeof access.audience_tag !== "string" || !access.audience_tag) errors.push("access.audience_tag is missing");
  if (access.public_signup_enabled !== false) errors.push("access.public_signup_enabled must be false");
  // The evaluator's identity is configuration, not evidence. The receipt
  // records that the allowlist has exactly one entry, never who it is (A9).
  if (access.allowlist_size !== 1) errors.push("access.allowlist_size must be 1");
  if (access.administrator_identifiers_redacted !== true) {
    errors.push("access.administrator_identifiers_redacted must be true");
  }

  const unauthenticated = access.unauthenticated_request;
  if (!isPlainObject(unauthenticated)) {
    errors.push("missing access.unauthenticated_request: rejection must be observed, not assumed");
  } else if (unauthenticated.admitted !== false) {
    errors.push("access.unauthenticated_request.admitted must be false");
  } else if (!Number.isInteger(unauthenticated.response_status)) {
    errors.push("access.unauthenticated_request.response_status is missing");
  }

  const evaluator = access.approved_evaluator_request;
  if (!isPlainObject(evaluator)) {
    errors.push("missing access.approved_evaluator_request: admission must be observed, not assumed");
  } else if (evaluator.admitted !== true) {
    errors.push("access.approved_evaluator_request.admitted must be true");
  }
}

function requireAgentTurn(receipt, errors) {
  const turn = receipt.agent_turn;
  if (!isPlainObject(turn)) {
    errors.push("missing agent_turn: the evaluator must have opened the interface and started a turn");
    return;
  }
  if (turn.interface_opened !== true) errors.push("agent_turn.interface_opened must be true");
  if (turn.started !== true) errors.push("agent_turn.started must be true");
  if (turn.model_call_live !== true) errors.push("agent_turn.model_call_live must be true");
}

function requireSpendGovernance(receipt, errors) {
  const spend = receipt.spend_governance;
  if (!isPlainObject(spend)) {
    errors.push("missing spend_governance: a live model call must be governed by a declared ceiling");
    return;
  }
  if (spend.provider !== "cloudflare") errors.push("spend_governance.provider must be cloudflare (Workers AI through AI Gateway)");
  if (!Array.isArray(spend.external_provider_credentials) || spend.external_provider_credentials.length !== 0) {
    errors.push("spend_governance.external_provider_credentials must be empty");
  }
  if (!Number.isFinite(spend.ceiling_usd) || spend.ceiling_usd <= 0) {
    errors.push("spend_governance.ceiling_usd must be a positive dollar ceiling");
  }

  // A ceiling that is configured somewhere but not in the request path governs
  // nothing. Each control must say what enforces it and that it is deployed,
  // and the declared ceiling must be one of the controls actually enforcing —
  // otherwise the receipt is describing an intention, not a boundary.
  const controls = spend.enforced_controls;
  if (!Array.isArray(controls) || controls.length === 0) {
    errors.push("spend_governance.enforced_controls must list the controls actually enforcing in the request path");
  } else {
    controls.forEach((control, index) => {
      const at = `spend_governance.enforced_controls[${index}]`;
      if (!isPlainObject(control)) {
        errors.push(`${at} is not an object`);
        return;
      }
      if (typeof control.mechanism !== "string" || !control.mechanism) errors.push(`${at}.mechanism is missing`);
      if (!Number.isFinite(control.limit_usd) || control.limit_usd <= 0) errors.push(`${at}.limit_usd must be a positive dollar ceiling`);
      if (control.deployed !== true) errors.push(`${at}.deployed must be true: a control outside the request path enforces nothing`);
      if (control.enforcement !== "fail_closed") errors.push(`${at}.enforcement must be fail_closed`);
    });
    const enforcedLimits = controls
      .filter((control) => isPlainObject(control) && control.deployed === true)
      .map((control) => control.limit_usd);
    if (Number.isFinite(spend.ceiling_usd) && !enforcedLimits.includes(spend.ceiling_usd)) {
      errors.push(
        `spend_governance.ceiling_usd (${spend.ceiling_usd}) is not among the deployed enforced controls `
        + `(${enforcedLimits.join(", ") || "none"}): the declared ceiling must be one that actually enforces`,
      );
    }
  }
  // A ceiling that degrades to a cheaper model instead of stopping is not a
  // ceiling for an evaluation with a fixed budget (A7).
  if (spend.enforcement !== "fail_closed") errors.push("spend_governance.enforcement must be fail_closed");
  if (spend.on_exceeded_status !== 429) errors.push("spend_governance.on_exceeded_status must be 429");
  if (typeof spend.governed_by_rule_id !== "string" || !spend.governed_by_rule_id) {
    errors.push("spend_governance.governed_by_rule_id is missing: the live call must name the rule that governed it");
  }
}

function requireBindings(receipt, errors) {
  const bindings = receipt.bindings;
  if (!Array.isArray(bindings) || bindings.length === 0) {
    errors.push("missing bindings: provisioned resources must be recorded");
    return;
  }
  bindings.forEach((binding, index) => {
    const at = `bindings[${index}]`;
    if (!isPlainObject(binding)) {
      errors.push(`${at} is not an object`);
      return;
    }
    if (typeof binding.binding !== "string" || !binding.binding) errors.push(`${at}.binding is missing`);
    if (typeof binding.type !== "string" || !binding.type) errors.push(`${at}.type is missing`);
    if (typeof binding.resource_id !== "string" || !binding.resource_id) errors.push(`${at}.resource_id is missing`);
    // The evaluation provisions its own resources. Binding a production store
    // would make the evaluation's blast radius the production blast radius.
    if (binding.isolated_from_production !== true) {
      errors.push(`${at}.isolated_from_production must be true`);
    }
  });
}

function requireRollbackRehearsal(receipt, errors) {
  const rollback = receipt.rollback_rehearsal;
  if (!isPlainObject(rollback)) {
    errors.push("missing rollback_rehearsal: rollback must be rehearsed, not described");
    return;
  }
  if (rollback.performed !== true) errors.push("rollback_rehearsal.performed must be true");
  if (!PROVIDER_ATTESTATION_SOURCES.includes(rollback.verified_by)) {
    errors.push("rollback_rehearsal.verified_by must name the Cloudflare control-plane source");
  }
  const steps = rollback.workers;
  if (!isPlainObject(steps)) {
    errors.push("missing rollback_rehearsal.workers");
    return;
  }
  for (const role of REQUIRED_WORKER_ROLES) {
    const step = steps[role];
    if (!isPlainObject(step)) {
      errors.push(`rollback_rehearsal.workers.${role} is missing`);
      continue;
    }
    if (!PROVIDER_VERSION_ID_SHAPE.test(step.prior_version_id || "")) {
      errors.push(`rollback_rehearsal.workers.${role}.prior_version_id must be a Cloudflare-issued Worker version id`);
    }
    if (!PROVIDER_VERSION_ID_SHAPE.test(step.restored_version_id || "")) {
      errors.push(`rollback_rehearsal.workers.${role}.restored_version_id must be a Cloudflare-issued Worker version id`);
    }
  }
}

function requireRetention(receipt, errors) {
  const retention = receipt.retention;
  if (!isPlainObject(retention)) {
    errors.push("missing retention: the deployment's logging and retention choice must be recorded");
    return;
  }
  if (retention.operational_metadata_only !== true) errors.push("retention.operational_metadata_only must be true");
  if (!Number.isInteger(retention.retention_days) || retention.retention_days <= 0) {
    errors.push("retention.retention_days must be a positive number of days");
  }
  if (!Number.isInteger(retention.workspace_deletion_due_days) || retention.workspace_deletion_due_days <= 0) {
    errors.push("retention.workspace_deletion_due_days must be a positive number of days");
  }
  if (!Array.isArray(retention.fields) || retention.fields.length === 0) {
    errors.push("retention.fields must list the operational fields retained");
    return;
  }
  for (const field of retention.fields) {
    if (!ALLOWED_OPERATIONAL_LOG_FIELDS.includes(field)) {
      errors.push(`retention.fields includes ${field}, which is not operational metadata`);
    }
  }
}

/**
 * Validates a Cloudflare OS deployment receipt against both the CS-09 evidence
 * floor and this card's deployment contract.
 *
 * The declared class must be exactly `cloudflare_os_deployed`: a receipt whose
 * facts prove less is overstating, and one whose facts prove more is carrying
 * agent-session evidence that belongs to a later card, not to a deployment.
 *
 * Throws with every violation collected, so a receipt is fixed in one pass
 * rather than one error at a time.
 */
export function assertOsDeploymentReceipt(receipt, { sourceText } = {}) {
  if (!isPlainObject(receipt)) {
    throw new Error("os deployment receipt: receipt must be an object");
  }

  const errors = [];

  if (receipt.card !== "cityscroll-capability-spine/cs-12-os-deployment-foundation") {
    errors.push("card must be cityscroll-capability-spine/cs-12-os-deployment-foundation");
  }
  if (receipt.evidence_class !== "cloudflare_os_deployed") {
    errors.push(`evidence_class must be cloudflare_os_deployed, got ${JSON.stringify(receipt.evidence_class)}`);
  }
  if (receipt.execution_environment !== "cloudflare-os-deployment") {
    errors.push(`execution_environment must be cloudflare-os-deployment, got ${JSON.stringify(receipt.execution_environment)}`);
  }

  requireUpstreamPins(receipt, errors);
  requireWorkers(receipt, errors);
  requireAccess(receipt, errors);
  requireAgentTurn(receipt, errors);
  requireSpendGovernance(receipt, errors);
  requireBindings(receipt, errors);
  requireRollbackRehearsal(receipt, errors);
  requireRetention(receipt, errors);

  for (const { path, reason } of findUnsanitizedValues(receipt)) {
    errors.push(`unsanitized value at ${path}: ${reason}`);
  }
  for (const { path, reason } of findConnectionClaims(receipt)) {
    errors.push(`connection claim at ${path}: ${reason} — a deployment does not establish integration`);
  }

  // The CS-09 floor runs last so its message is not buried, and its result is
  // reported alongside this card's own violations rather than instead of them.
  let maxProvableClass = null;
  try {
    ({ maxProvableClass } = assertReceiptEvidenceClass(receipt, { sourceText }));
  } catch (error) {
    errors.push(error.message);
  }
  if (maxProvableClass && maxProvableClass !== "cloudflare_os_deployed") {
    const { errors: derivationErrors } = deriveMaximumProvableClass(receipt, { sourceText });
    errors.push(
      `receipt's facts prove "${maxProvableClass}" rather than exactly "cloudflare_os_deployed"`
      + (derivationErrors.length ? ` (${derivationErrors.join("; ")})` : ""),
    );
  }

  if (errors.length) {
    throw new Error(`os deployment receipt: ${errors.length} violation(s):\n- ${errors.join("\n- ")}`);
  }
  return { card: receipt.card, evidenceClass: receipt.evidence_class };
}
