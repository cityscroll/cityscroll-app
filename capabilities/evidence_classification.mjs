// CS-09 · Cloudflare OS evidence classification.
//
// Five mechanically distinct evidence classes describe how far a piece of
// Cloudflare OS / MCP integration evidence actually reaches. A receipt's
// self-declared `evidence_class` is never trusted on its own: this module
// re-derives the maximum class the receipt's own facts can prove and rejects
// any receipt that claims more than its facts support. Higher classes can
// never be inferred from identifier shape, URL shape, or the mere presence of
// lower-class evidence — each class has its own required, positively-checked
// facts.

export const EVIDENCE_CLASSES = Object.freeze([
  "local_contract",
  "local_protocol_interop",
  "external_live_endpoint",
  "cloudflare_os_deployed",
  "cloudflare_os_agent_exercised",
]);

export const EXECUTION_ENVIRONMENTS = Object.freeze([
  "node-in-process-fixture",
  "node-intercepted-transport-fixture",
  "external-network-observed",
  "cloudflare-os-deployment",
]);

const EVIDENCE_CLASS_RANK = new Map(EVIDENCE_CLASSES.map((name, index) => [name, index]));

const WORKERS_DEV_SHAPED_URL = /^https:\/\/[a-z0-9-]+\.workers\.dev\/?/i;
const PLAUSIBLE_DEPLOYMENT_ID_SHAPE = /^[a-z0-9][a-z0-9-]{3,63}$/i;
const PROVIDER_VERSION_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isEvidenceClass(value) {
  return EVIDENCE_CLASSES.includes(value);
}

export function isExecutionEnvironment(value) {
  return EXECUTION_ENVIRONMENTS.includes(value);
}

export function evidenceClassRank(evidenceClass) {
  return EVIDENCE_CLASS_RANK.get(evidenceClass) ?? -1;
}

/**
 * Recursively scans a receipt for self-disqualifying flags. Any of these,
 * found anywhere in the receipt, makes it impossible for the receipt to
 * prove a deployed or live class regardless of what it otherwise claims.
 */
export function findDisqualifyingFlags(value, path = "$") {
  const found = [];
  const visit = (node, at) => {
    if (Array.isArray(node)) {
      node.forEach((child, index) => visit(child, `${at}[${index}]`));
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      const here = `${at}.${key}`;
      if (key === "mode" && child === "isolated-rehearsal") found.push({ path: here, reason: "mode: isolated-rehearsal" });
      if (key === "live" && child === false) found.push({ path: here, reason: "live: false" });
      if (key === "dynamic_worker_loader" && child === false) found.push({ path: here, reason: "dynamic_worker_loader: false" });
      if (key === "executor" && typeof child === "string" && /rehearsal/i.test(child)) {
        found.push({ path: here, reason: `executor: ${child}` });
      }
      if (key === "transport_intercepted" && child === true) found.push({ path: here, reason: "transport_intercepted: true" });
      if (key === "handle_mcp_imported" && child === true) found.push({ path: here, reason: "handle_mcp_imported: true" });
      visit(child, here);
    }
  };
  visit(value, path);
  return found;
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

/**
 * A workers.dev-shaped URL or a plausible-looking deployment id is, by
 * itself, indistinguishable from a fabricated one. Live/deployed classes
 * must never accept these alone; they must be paired with a provider-issued
 * identifier the network_observation/provider_receipt object separately
 * evidences (see requireProviderIssuedIdentifier below).
 */
export function isMerelyShapedIdentifier(candidate) {
  if (typeof candidate !== "string") return false;
  return WORKERS_DEV_SHAPED_URL.test(candidate) || PLAUSIBLE_DEPLOYMENT_ID_SHAPE.test(candidate);
}

function requireProviderIssuedIdentifier(receipt, errors) {
  const identifier = receipt.provider_issued_identifier;
  if (!identifier || typeof identifier !== "object") {
    errors.push("missing provider_issued_identifier: a URL or deployment id string alone cannot satisfy live/deployed evidence");
    return false;
  }
  const { kind, value, verified_by: verifiedBy, verification_method: verificationMethod } = identifier;
  if (kind !== "worker_version" && kind !== "deployment_id") {
    errors.push("provider_issued_identifier.kind must be worker_version or deployment_id");
    return false;
  }
  if (typeof value !== "string" || !value) {
    errors.push("provider_issued_identifier.value is missing");
    return false;
  }
  // The identifier's own shape is never sufficient (A6): a workers.dev URL or
  // a plausible id string is exactly the fabricable case this class forbids.
  // Provider issuance must be attested independently.
  if (verifiedBy !== "cloudflare_api" && verifiedBy !== "cloudflare_deploy_output") {
    errors.push("provider_issued_identifier.verified_by must name the Cloudflare control-plane source that issued it");
    return false;
  }
  if (!verificationMethod || typeof verificationMethod !== "string") {
    errors.push("provider_issued_identifier.verification_method is missing");
    return false;
  }
  if (!PROVIDER_VERSION_ID_SHAPE.test(value) && kind === "worker_version") {
    errors.push("provider_issued_identifier.value does not match a Cloudflare Worker version id shape");
    return false;
  }
  return true;
}

function requireNetworkObservation(receipt, errors) {
  const observation = receipt.network_observation;
  if (!observation || typeof observation !== "object") {
    errors.push("missing network_observation: live evidence requires an externally observed response");
    return false;
  }
  if (observation.transport !== "public-internet") {
    errors.push("network_observation.transport must be public-internet");
    return false;
  }
  if (observation.dns_resolved !== true) {
    errors.push("network_observation.dns_resolved must be true");
    return false;
  }
  if (!Number.isInteger(observation.response_status)) {
    errors.push("network_observation.response_status is missing");
    return false;
  }
  if (observation.fetch_override === true || observation.transport_intercepted === true) {
    errors.push("network_observation reports an intercepted or overridden transport");
    return false;
  }
  return true;
}

function sourceImportsHandleMcp(sourceText) {
  return scanSourceForHandleMcpImport(sourceText).imports;
}

/**
 * Static scan of a verifier/build-script's own source text for a direct
 * handleMcp() import. A receipt produced by a script that imports handleMcp
 * dispatched the request in-process and can never prove external_live_endpoint,
 * no matter what the receipt's fields claim (A9).
 */
export function scanSourceForHandleMcpImport(sourceText) {
  if (typeof sourceText !== "string") return { imports: false, matches: [] };
  const pattern = /import\s*\{[^}]*\bhandleMcp\b[^}]*\}\s*from\s*["'][^"']*mcp\.mjs["']/g;
  const matches = [...sourceText.matchAll(pattern)].map((match) => match[0]);
  return { imports: matches.length > 0, matches };
}

/**
 * Derives the maximum evidence class a receipt's own mechanical facts can
 * prove, independent of what it self-declares. Returns "unknown" when the
 * receipt does not carry enough structured fact to prove even local_contract
 * — missing/unknown proof stays unknown rather than defaulting anywhere.
 */
export function deriveMaximumProvableClass(receipt, { sourceText } = {}) {
  if (!receipt || typeof receipt !== "object") {
    return { maxClass: "unknown", errors: ["receipt is not an object"] };
  }

  const disqualifying = findDisqualifyingFlags(receipt);
  const importsHandleMcp = sourceImportsHandleMcp(sourceText);

  const hasContractFacts = Boolean(receipt.schema) && Boolean(receipt.card);
  if (!hasContractFacts) {
    return { maxClass: "unknown", errors: ["receipt lacks schema/card contract identity"], disqualifying };
  }

  // local_protocol_interop: a real MCP client/transport object exchanged
  // messages with a handler, even if that handler was reached in-process.
  const hasProtocolFacts = Boolean(receipt.protocol?.transport) || Boolean(receipt.protocol?.negotiated_version);
  if (!hasProtocolFacts) {
    return { maxClass: "local_contract", errors: [], disqualifying };
  }

  // external_live_endpoint requires network observation AND a provider-issued
  // identifier AND the producing script must not itself import handleMcp.
  const liveErrors = [];
  const hasNetworkObservation = requireNetworkObservation(receipt, liveErrors);
  const hasProviderIdentifier = requireProviderIssuedIdentifier(receipt, liveErrors);
  const canBeLive = hasNetworkObservation
    && hasProviderIdentifier
    && disqualifying.length === 0
    && !importsHandleMcp;
  if (importsHandleMcp) liveErrors.push("producing source imports handleMcp(): dispatch is local, not external");
  if (disqualifying.length) liveErrors.push(...disqualifying.map(({ reason }) => `disqualifying flag present: ${reason}`));

  if (!canBeLive) {
    return { maxClass: "local_protocol_interop", errors: liveErrors, disqualifying };
  }

  // cloudflare_os_deployed requires everything external_live_endpoint requires
  // PLUS a Cloudflare-OS-specific deployment attestation beyond identifier shape.
  const deployedErrors = [];
  const deployment = receipt.cloudflare_os_deployment;
  const hasDeploymentAttestation = deployment
    && typeof deployment === "object"
    && deployment.control_plane_response === true
    && isSha256(deployment.provider_receipt_sha256 || "");
  if (!hasDeploymentAttestation) {
    deployedErrors.push("missing cloudflare_os_deployment.control_plane_response / provider_receipt_sha256 attestation");
    return { maxClass: "external_live_endpoint", errors: deployedErrors, disqualifying };
  }

  // cloudflare_os_agent_exercised requires deployment proof PLUS an
  // OS-issued agent/session record distinct from the deployment identifier.
  const agentSession = receipt.cloudflare_os_agent_session;
  const hasAgentSession = agentSession
    && typeof agentSession === "object"
    && agentSession.provider_issued === true
    && typeof agentSession.session_id === "string"
    && agentSession.session_id.length > 0;
  if (!hasAgentSession) {
    return { maxClass: "cloudflare_os_deployed", errors: ["missing cloudflare_os_agent_session.provider_issued session"], disqualifying };
  }

  return { maxClass: "cloudflare_os_agent_exercised", errors: [], disqualifying };
}

/**
 * Validates that a receipt's self-declared evidence_class and
 * execution_environment are both well-formed and mechanically provable.
 * Throws with a descriptive message on any violation.
 */
export function assertReceiptEvidenceClass(receipt, { sourceText } = {}) {
  if (!receipt || typeof receipt !== "object") {
    throw new Error("evidence classification: receipt must be an object");
  }
  const { evidence_class: declaredClass, execution_environment: declaredEnvironment } = receipt;
  if (!isEvidenceClass(declaredClass)) {
    throw new Error(`evidence classification: evidence_class is missing or invalid: ${JSON.stringify(declaredClass)}`);
  }
  if (!isExecutionEnvironment(declaredEnvironment)) {
    throw new Error(`evidence classification: execution_environment is missing or invalid: ${JSON.stringify(declaredEnvironment)}`);
  }
  const { maxClass, errors } = deriveMaximumProvableClass(receipt, { sourceText });
  if (maxClass === "unknown") {
    throw new Error(`evidence classification: receipt does not carry enough fact to prove any class (${errors.join("; ")})`);
  }
  if (evidenceClassRank(declaredClass) > evidenceClassRank(maxClass)) {
    throw new Error(
      `evidence classification: receipt declares "${declaredClass}" but its own facts only prove "${maxClass}" `
      + `(${errors.join("; ") || "no further facts present"})`,
    );
  }
  return { declaredClass, maxProvableClass: maxClass };
}
