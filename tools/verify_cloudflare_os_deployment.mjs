#!/usr/bin/env node

/**
 * CS-12 · Re-validates the committed Cloudflare OS deployment receipt.
 *
 * The receipt is produced by a deploy in the private deployment repository and
 * copied here sanitized. This verifier is the public check that it still says
 * what it is allowed to say: it re-derives the maximum class the receipt's own
 * facts prove and re-applies the deployment contract, so a receipt cannot be
 * edited into a stronger claim after the fact.
 *
 * It deliberately performs no network call and imports no Worker module. It
 * proves nothing about the deployment on its own — the receipt's provider-issued
 * facts do that — it only prevents the record from drifting.
 *
 * Verify: node tools/verify_cloudflare_os_deployment.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { deriveMaximumProvableClass } from "../capabilities/evidence_classification.mjs";
import { assertOsDeploymentReceipt } from "../capabilities/os_deployment_receipt.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RECEIPT = resolve(ROOT, "artifacts/capability-spine/cs-12-cloudflare-os-deployment.json");

export function verifyCloudflareOsDeployment(path = RECEIPT) {
  const receipt = JSON.parse(readFileSync(path, "utf8"));
  // Throws unless the receipt satisfies the deployment contract; declaring more
  // than the facts prove is exactly what it rejects.
  const { evidenceClass } = assertOsDeploymentReceipt(receipt);
  const { maxClass } = deriveMaximumProvableClass(receipt);
  return { declaredClass: evidenceClass, maxProvableClass: maxClass, receipt: path };
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked === resolve(fileURLToPath(import.meta.url))) {
  const { declaredClass, maxProvableClass } = verifyCloudflareOsDeployment();
  process.stdout.write(
    `cloudflare os deployment receipt is valid: declared ${declaredClass}, `
    + `facts prove ${maxProvableClass}\n`,
  );
}
