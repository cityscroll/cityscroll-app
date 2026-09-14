import { passportPublicOfficialSource } from "../worker/src/lib/passport_parse.mjs";

const CHECKBOOK_SEARCH = "https://www.checkbooknyc.com/smart_search/citywide";
const CHECKBOOK_CONTRACT_SEARCH = "https://www.checkbooknyc.com/contract_search";
const CITY_RECORD_ORIGIN = "https://a856-cityrecord.nyc.gov/RequestDetail/";

function text(value, max = 500) {
  const result = String(value ?? "").replace(/\s+/g, " ").trim();
  return result ? result.slice(0, max) : null;
}

function rowsFor(object, observations) {
  const index = new Map((Array.isArray(observations) ? observations : [])
    .map((entry) => [entry?.source_observation_ref, entry]));
  return (object?.source_observation_refs || []).map((ref) => index.get(ref)).filter(Boolean);
}

function cityRecord(object, rows) {
  const row = rows.find((entry) => entry.source_system === "city_record");
  const snapshot = row?.snapshot || {};
  const compatibilityHref = object?.compatibility?.city_record_notice_hrefs?.[0];
  const id = text(snapshot.request_id || row?.source_system_id || object?.identity_keys?.request_ids?.[0]
    || compatibilityHref?.match(/\/notices\/([^/?#]+)/)?.[1], 80);
  if (!id) return null;
  return {
    record_href: `/notices/${encodeURIComponent(id)}`,
    official_href: text(snapshot.official_url || snapshot.official_source_url, 500) || `${CITY_RECORD_ORIGIN}${encodeURIComponent(id)}`,
    official_label: "Open official record",
  };
}

function checkbook(object, rows) {
  const snapshots = rows
    .filter((entry) => String(entry.source_system || "").startsWith("checkbook"))
    .map((entry) => entry.snapshot || {});
  const snapshot = snapshots[0] || {};
  const direct = snapshots.map((row) => text(row.official_url || row.source_url, 500)).find(Boolean);
  if (direct) return { official_href: direct, official_label: "Open official record" };
  const agid = text(snapshot.agid || snapshot.original_agreement_id, 80);
  if (/^\d+$/.test(agid || "")) {
    const contractId = text(object?.identity_keys?.contract_ids?.[0] || snapshot.id || snapshot.contract_id, 120);
    const code = contractId?.match(/^([A-Za-z]+\d)/)?.[1]?.toUpperCase() || "CT1";
    return {
      official_href: `${"https://www.checkbooknyc.com/contract_details/agid/"}${encodeURIComponent(agid)}/doctype/${encodeURIComponent(code)}`,
      official_label: "Open official record",
    };
  }
  const term = text(object?.identity_keys?.contract_ids?.[0] || snapshot.id || snapshot.contract_id || snapshot.vendor || snapshot.vendor_name, 200);
  return {
    search_href: term ? `${CHECKBOOK_SEARCH}?search_term=${encodeURIComponent(term)}` : CHECKBOOK_CONTRACT_SEARCH,
    search_label: "Search Checkbook NYC",
  };
}

function lookupReceiptHasSource(receipt, system) {
  const source = receipt?.sources?.find?.((entry) => entry?.source_system === system);
  return source?.applicability !== "not-applicable"
    && (source?.state === "corroborated" || source?.matched_analytical_row_refs?.length > 0);
}

/** The single allowlisted destination policy shared by the two renderers. */
export function procurementSourceLinkDescriptors(object = {}, observations = [], { lookupReceipt = null } = {}) {
  const rows = rowsFor(object, observations);
  const descriptors = new Map();
  const put = (system, descriptor) => descriptor && descriptors.set(system, Object.freeze({ source_system: system, ...descriptor }));
  put("city_record", cityRecord(object, rows));
  if (rows.some((entry) => entry.source_system === "passport_public_contracts")) {
    const source = passportPublicOfficialSource("contract");
    put("passport_public_contracts", { official_href: source.href, official_label: "Open PASSPort contracts portal" });
  }
  if (rows.some((entry) => entry.source_system === "passport_public_rfx")) {
    const row = rows.find((entry) => entry.source_system === "passport_public_rfx");
    const source = passportPublicOfficialSource("rfx", row?.snapshot || {});
    put("passport_public_rfx", { official_href: source.href, official_label: source.per_item ? "Open official record" : "Open PASSPort solicitations portal" });
  }
  for (const system of ["checkbook_contracts", "checkbook_spending", "checkbook_nycha_contracts"]) {
    if (!rows.some((entry) => entry.source_system === system) && !lookupReceiptHasSource(lookupReceipt, system)) continue;
    const descriptor = checkbook(object, rows);
    put(system, descriptor);
  }
  return descriptors;
}

export function procurementSourceLinkItems(object = {}, observations = [], options = {}) {
  return [...procurementSourceLinkDescriptors(object, observations, options).values()];
}
