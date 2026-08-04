// Pure reader for receipt-gated NYS Authorities Budget Office award edges.
// Candidate rows never reach this module: the collector publishes matches only after the
// fixed-sample batch clears both its usefulness and precision gates.

export const ABO_AWARD_PAYLOAD_SCHEMA = "cityscroll.abo_award_residual.v1";

function text(value) {
  const out = String(value ?? "").replace(/\s+/g, " ").trim();
  return out || null;
}

function isoDate(value) {
  const raw = text(value);
  if (!raw || !Number.isFinite(Date.parse(raw))) return null;
  return new Date(raw).toISOString().slice(0, 10);
}

function amount(value) {
  const normalized = String(value ?? "").replace(/[$,\s]/g, "");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function releasedAboAward(payload, requestId) {
  if (!payload || payload.schema !== ABO_AWARD_PAYLOAD_SCHEMA) return null;
  const bridge = payload.bridge || {};
  if (bridge.status !== "accepted") return null;
  const floor = Number(bridge.fuzzy_precision_floor);
  const precision = Number(bridge.fuzzy_precision);
  if (!Number.isFinite(floor) || !Number.isFinite(precision) || precision < floor) return null;

  const key = text(requestId);
  const edge = key && payload.matches_by_request_id?.[key];
  if (!edge || text(edge.request_id) !== key) return null;
  const sourceKey = text(edge.source_key);
  const method = text(edge.method);
  const confidence = Number(edge.confidence);
  if (!sourceKey || !["exact_identifier_date", "vendor_amount_date", "title_date_fuzzy"].includes(method)
      || !Number.isFinite(confidence) || confidence < floor) return null;
  const award = edge.award || {};
  const dataset = text(award.dataset || award.__dataset);
  const authority = text(award.authority_name || award.authority);
  const vendor = text(award.vendor_name || award.vendor);
  const awardDate = isoDate(award.award_date || award.date);
  const awardAmount = amount(award.contract_amount ?? award.amount);
  if (!/^[a-z0-9]{4}-[a-z0-9]{4}$/i.test(dataset || "")
      || !authority || !vendor || !awardDate || awardAmount == null) return null;

  return {
    request_id: key,
    source_key: sourceKey,
    method,
    confidence,
    dataset,
    authority,
    vendor,
    amount: awardAmount,
    award_date: awardDate,
    description: text(award.procurement_description || award.description),
  };
}

function sodaQuote(value) {
  return String(value).replaceAll("'", "''");
}

export function aboAwardSourceUrl(match) {
  if (!match || !/^[a-z0-9]{4}-[a-z0-9]{4}$/i.test(match.dataset || "")) return null;
  if (!match.authority || !match.vendor || !match.award_date) return null;
  const predicates = [
    `authority_name='${sodaQuote(match.authority)}'`,
    `vendor_name='${sodaQuote(match.vendor)}'`,
    `award_date='${sodaQuote(match.award_date)}T00:00:00.000'`,
  ];
  if (match.description) {
    predicates.push(`procurement_description='${sodaQuote(match.description)}'`);
  }
  const query = new URLSearchParams({
    "$where": predicates.join(" AND "),
    "$limit": "10",
  });
  return `https://data.ny.gov/resource/${match.dataset}.json?${query}`;
}
