#!/usr/bin/env node

/**
 * CS-09 · Generates the capability-spine readiness state.
 *
 * Reports capability-ready, live-MCP-verified, OS-deployed,
 * Gatekeeper-connected, and agent-proven as five SEPARATE, mechanically
 * derived states — never a single collapsed "integrated" flag. Each state's
 * `satisfied` value comes only from re-deriving the maximum evidence class a
 * named receipt's own facts can prove (capabilities/evidence_classification.mjs),
 * never from the receipt's self-declared label alone and never by inference
 * from names, URLs, or identifiers.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CAPABILITY_REGISTRY } from "../capabilities/registry.mjs";
import {
  deriveMaximumProvableClass,
  evidenceClassRank,
} from "../capabilities/evidence_classification.mjs";
import { assertOsDeploymentReceipt } from "../capabilities/os_deployment_receipt.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = resolve(ROOT, "artifacts/capability-spine/state.json");
const REPORT_OUT = resolve(ROOT, "docs/capability-spine/report.html");

function readReceipt(relativePath) {
  const path = resolve(ROOT, relativePath);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function readSource(relativePath) {
  const path = resolve(ROOT, relativePath);
  if (!existsSync(path)) return undefined;
  return readFileSync(path, "utf8");
}

/**
 * `contract` is an optional card-specific assertion applied on top of the
 * evidence-class floor. Clearing the floor says a receipt reaches a class;
 * a contract says the receipt carries the particular facts that card
 * requires, so a state stays unproven when either one fails.
 */
function proves(receiptPath, sourcePath, requiredClass, { contract } = {}) {
  const receipt = readReceipt(receiptPath);
  if (!receipt) {
    return { satisfied: false, state: "not_yet_proven", reason: `no receipt at ${receiptPath}`, receipt: receiptPath };
  }
  const sourceText = readSource(sourcePath);
  const { maxClass, errors } = deriveMaximumProvableClass(receipt, { sourceText });
  const clearsFloor = maxClass !== "unknown" && evidenceClassRank(maxClass) >= evidenceClassRank(requiredClass);

  let contractFailure = null;
  if (clearsFloor && contract) {
    try {
      contract(receipt, { sourceText });
    } catch (error) {
      contractFailure = error.message;
    }
  }

  const satisfied = clearsFloor && !contractFailure;
  return {
    satisfied,
    state: satisfied ? "proven" : "not_yet_proven",
    max_provable_class: maxClass,
    required_class: requiredClass,
    receipt: receiptPath,
    reason: satisfied
      ? null
      : (contractFailure || errors[0] || `receipt only proves ${maxClass}, not ${requiredClass}`),
  };
}

export function buildCapabilitySpineState() {
  const capabilityReady = {
    satisfied: CAPABILITY_REGISTRY.length > 0,
    state: CAPABILITY_REGISTRY.length > 0 ? "proven" : "not_yet_proven",
    registered_public_capabilities: CAPABILITY_REGISTRY.length,
    reason: CAPABILITY_REGISTRY.length > 0
      ? null
      : "no capabilities registered",
  };

  // CS-06 (local protocol interop) demonstrates the adapter contract, but
  // "live" requires CS-10's separately evidenced external_live_endpoint
  // receipt, which does not exist yet.
  const liveMcpVerified = proves(
    "artifacts/capability-spine/cs-10-live-remote-mcp-canary.json",
    "tools/verify_live_remote_mcp_canary.mjs",
    "external_live_endpoint",
  );

  // CS-12 adds a deployment contract on top of the class floor: the six Worker
  // roles with provider-issued versions, one publicly routed Worker, observed
  // access control, a fail-closed spend ceiling, a rehearsed rollback, and a
  // receipt carrying neither administrator identifiers nor a connection claim.
  const osDeployed = proves(
    "artifacts/capability-spine/cs-12-cloudflare-os-deployment.json",
    "tools/verify_cloudflare_os_deployment.mjs",
    "cloudflare_os_deployed",
    { contract: assertOsDeploymentReceipt },
  );

  const gatekeeperConnected = proves(
    "artifacts/capability-spine/cs-13-gatekeeper-session.json",
    "tools/verify_gatekeeper_session.mjs",
    "cloudflare_os_deployed",
  );

  const agentProven = proves(
    "artifacts/capability-spine/cs-14-agent-evaluation.json",
    "tools/verify_agent_evaluation.mjs",
    "cloudflare_os_agent_exercised",
  );

  return {
    schema: "cityscroll.capability_spine_state.v1",
    card: "cs-09-os-evidence-truth-reset",
    generated_at: "2026-09-04T00:00:00.000Z",
    states: {
      capability_ready: capabilityReady,
      live_mcp_verified: liveMcpVerified,
      os_deployed: osDeployed,
      gatekeeper_connected: gatekeeperConnected,
      agent_proven: agentProven,
    },
    // Rehearsal evidence is preserved and honestly labeled — not discarded —
    // but it never counts toward any of the five states above.
    preserved_local_rehearsal_evidence: [
      "artifacts/capability-spine/cs-06-remote-mcp.json",
      "artifacts/capability-spine/cs-07-cloudflare-os-proof.json",
      "artifacts/capability-spine/cs-08-code-mode.json",
    ],
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function renderReport(state) {
  const rows = Object.entries(state.states).map(([key, value]) => {
    const badgeClass = value.satisfied ? "pass" : "pending";
    const badgeText = value.satisfied ? "PROVEN" : "NOT YET PROVEN";
    return `<tr><th scope="row">${escapeHtml(key)}</th><td class="${badgeClass}">${badgeText}</td>`
      + `<td>${escapeHtml(value.max_provable_class || value.required_class || "—")}</td>`
      + `<td>${escapeHtml(value.reason || "—")}</td></tr>`;
  }).join("");
  const preserved = state.preserved_local_rehearsal_evidence
    .map((path) => `<li><code>${escapeHtml(path)}</code></li>`)
    .join("");
  return `<!doctype html>
<meta charset="utf-8">
<title>Capability-spine evidence state</title>
<style>
  body{font:16px system-ui;max-width:900px;margin:2rem auto;padding:0 1rem}
  table{border-collapse:collapse;width:100%;margin-top:1rem}
  th,td{border:1px solid #ccc;padding:.55rem;text-align:left;vertical-align:top}
  .pass{color:#075e2f;font-weight:600}
  .pending{color:#8a4b00;font-weight:600}
  code{font:13px ui-monospace,Menlo,monospace}
</style>
<h1>Capability-spine evidence state</h1>
<p>Generated ${escapeHtml(state.generated_at)} from <code>capabilities/evidence_classification.mjs</code> and the receipts it names. Each state below is derived independently; none is inferred from another.</p>
<table>
<thead><tr><th>State</th><th>Status</th><th>Max provable evidence class</th><th>Reason</th></tr></thead>
<tbody>${rows}</tbody>
</table>
<h2>Preserved local rehearsal evidence</h2>
<p>Useful, honestly classified local contract and protocol-interop rehearsals. None of these count toward a live, deployed, or agent-exercised state above.</p>
<ul>${preserved}</ul>
`;
}

export function writeCapabilitySpineState({ out = DEFAULT_OUT, reportOut = REPORT_OUT, check = false } = {}) {
  const state = buildCapabilitySpineState();
  const serialized = `${JSON.stringify(state, null, 2)}\n`;
  const report = renderReport(state);
  if (check) {
    const errors = [];
    if (!existsSync(out) || readFileSync(out, "utf8") !== serialized) {
      errors.push(`${out} is stale; rebuild the capability-spine state`);
    }
    if (!existsSync(reportOut) || readFileSync(reportOut, "utf8") !== report) {
      errors.push(`${reportOut} is stale; rebuild the capability-spine report`);
    }
    if (errors.length) throw new Error(errors.join("; "));
    process.stdout.write(`capability-spine state is current: ${out}\n`);
    return state;
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, serialized, "utf8");
  mkdirSync(dirname(reportOut), { recursive: true });
  writeFileSync(reportOut, report, "utf8");
  process.stdout.write(`wrote capability-spine state: ${out}\n`);
  process.stdout.write(`wrote capability-spine report: ${reportOut}\n`);
  return state;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    writeCapabilitySpineState({ check: process.argv.includes("--check") });
  } catch (error) {
    console.error(String(error?.message || error));
    process.exitCode = 1;
  }
}
