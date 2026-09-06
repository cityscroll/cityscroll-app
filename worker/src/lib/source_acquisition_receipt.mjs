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

const PASSPORT_SOURCE_IDS = Object.freeze(["passport-public-contracts", "passport-public-rfx"]);

function parsePassportLastModified(value) {
  if (!value) return null;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return { raw: value }; }
  }
  return value;
}

function httpDateToIso(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) ? new Date(epoch).toISOString() : null;
}

/**
 * PASSPort health evidence is the Worker/D1 ingest-meta row, never a CI
 * attempt to fetch the publisher dump. Missing publisher Last-Modified stays
 * null; missing CityScroll-controlled attempt/success clocks keep the
 * obligation open.
 */
export function passportReceiptsFromMeta(meta = {}, options = {}) {
  const ingestedAt = validTimestamp(meta.ingested_at);
  const lastAttempt = validTimestamp(meta.last_attempt_at) || ingestedAt;
  if (!lastAttempt) return [];
  const lastOk = meta.last_ok === true || meta.last_ok === "true";
  const lastModified = parsePassportLastModified(meta.last_modified);
  const runId = options.run_id || `passport-d1:${lastAttempt}`;
  const rowCounts = {
    "passport-public-contracts": meta.contract_rows,
    "passport-public-rfx": meta.rfx_rows,
  };
  const modified = {
    "passport-public-contracts": lastModified?.contracts || lastModified?.contract || null,
    "passport-public-rfx": lastModified?.rfx || lastModified?.rfps || null,
  };
  return PASSPORT_SOURCE_IDS.map((sourceId) => {
    const publisherUpdatedAt = httpDateToIso(modified[sourceId]);
    const noChange = options.previous_ingested_at
      && ingestedAt
      && options.previous_ingested_at === ingestedAt
      && lastOk;
    return sourceAcquisitionReceipt({
      source_contract_id: sourceId,
      observed_at: lastAttempt,
      status: lastOk ? "succeeded" : "failed",
      run_id: runId,
      publisher_clock_basis: publisherUpdatedAt ? "passport_http_last_modified" : null,
      publisher_updated_at: publisherUpdatedAt,
      adapter: "worker-d1-passport-ingest-meta",
      clock_kind: noChange ? "check" : "acquisition",
      event_kind: noChange ? "successful-no-change-check" : (lastOk ? "acquisition" : "failed-check"),
      input_vintage: ingestedAt,
      population: Number(rowCounts[sourceId]) || 0,
    });
  });
}

export async function recordPassportAcquisitionFromMeta(env, meta, options = {}) {
  const receipts = passportReceiptsFromMeta(meta, options);
  const recorded = [];
  for (const receipt of receipts) {
    recorded.push(await recordSourceAcquisitionReceipt(env, receipt));
  }
  return recorded;
}

export async function listSourceAcquisitionReceipts(env, options = {}) {
  const prefix = options.prefix || "source-health:acquisition:";
  if (!env?.ALERT_STATE?.list) return [];
  const keys = [];
  let cursor;
  do {
    const page = await env.ALERT_STATE.list({ prefix, cursor });
    keys.push(...(page.keys || []));
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  const receipts = [];
  for (const key of keys) {
    try {
      const raw = await env.ALERT_STATE.get(key.name);
      if (!raw) continue;
      receipts.push(typeof raw === "string" ? JSON.parse(raw) : raw);
    } catch {
      continue;
    }
  }
  const latest = new Map();
  for (const receipt of receipts) {
    const id = receipt?.source_contract_id;
    if (!id) continue;
    const prior = latest.get(id);
    if (!prior || Date.parse(receipt.observed_at || 0) >= Date.parse(prior.observed_at || 0)) {
      latest.set(id, receipt);
    }
  }
  return [...latest.values()].sort((left, right) => left.source_contract_id.localeCompare(right.source_contract_id));
}
