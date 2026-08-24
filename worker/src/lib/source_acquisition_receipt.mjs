// Runtime producer adapter for the shared source-acquisition receipt contract.
// This module stays Worker-compatible: it has no Node or build-time imports.

export const SOURCE_ACQUISITION_RECEIPT_SCHEMA = "cityscroll.source_acquisition_receipt.v1";
const STATUSES = new Set(["succeeded", "failed", "partial", "held"]);

function validTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) return null;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).getUTCFullYear() > 1970
    ? new Date(epoch).toISOString()
    : null;
}

export function sourceAcquisitionReceipt({
  source_contract_id,
  observed_at,
  status,
  run_id,
  publisher_clock_basis = null,
  publisher_updated_at = null,
  ...detail
}) {
  const receipt = {
    schema: SOURCE_ACQUISITION_RECEIPT_SCHEMA,
    source_contract_id,
    observed_at: validTimestamp(observed_at),
    status,
    run_id,
    publisher_clock_basis,
    publisher_updated_at: publisher_updated_at == null ? null : validTimestamp(publisher_updated_at),
    ...detail,
  };
  const errors = [];
  if (typeof receipt.source_contract_id !== "string" || !receipt.source_contract_id.trim()) errors.push("source_contract_id");
  if (!receipt.observed_at) errors.push("observed_at");
  if (!STATUSES.has(receipt.status)) errors.push("status");
  if (typeof receipt.run_id !== "string" || !receipt.run_id.trim()) errors.push("run_id");
  if (receipt.publisher_updated_at == null && publisher_updated_at != null) errors.push("publisher_updated_at");
  if (errors.length) throw new Error(`invalid source acquisition receipt: ${errors.join(", ")}`);
  return receipt;
}

export async function recordSourceAcquisitionReceipt(env, input) {
  const receipt = sourceAcquisitionReceipt(input);
  const key = `source-health:acquisition:${receipt.source_contract_id}:${receipt.run_id}`;
  if (env?.ALERT_STATE?.put) {
    await env.ALERT_STATE.put(key, JSON.stringify(receipt));
  }
  console.log("source acquisition receipt:", JSON.stringify(receipt));
  return receipt;
}
