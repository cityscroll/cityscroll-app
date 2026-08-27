import {
  gateNodePageRender,
  renderCivicDocumentAssets,
  renderCivicDocumentMast,
  renderNodeActions,
  renderNodeBack,
  renderNodeFooter,
  renderNodeProvenance,
  renderNodeSection,
} from "./civic_document_chrome.mjs";
import {
  buildContractReportTarget,
  buildContractVendorRelationshipReportTarget,
  reportIssueAction,
} from "./report_issue.mjs";
import { followingUrlFromWatch } from "./following_view.mjs";
import { procurementCanonicalHref } from "./procurement_object_contract.mjs";
import { renderProcurementObjectCoverageHtml } from "./procurement_coverage_labels.mjs";
import { passportPublicOfficialSource } from "../worker/src/lib/passport_parse.mjs";
import { snapshotsForPublicAmount } from "./checkbook_passport_corroboration.mjs";

const CHECKBOOK_SMART_SEARCH = "https://www.checkbooknyc.com/smart_search/citywide";
const CHECKBOOK_CONTRACT_SEARCH = "https://www.checkbooknyc.com/contract_search";

function esc(value) {
  return String(value ?? "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function clean(value, max = 500) {
  return String(value ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function factsFor(object, observations) {
  const index = new Map((Array.isArray(observations) ? observations : [])
    .map((entry) => [entry?.source_observation_ref, entry]));
  const observed = (object?.source_observation_refs || []).map((ref) => index.get(ref)).filter(Boolean);
  const rows = snapshotsForPublicAmount(object, observed);
  const first = (...fields) => {
    for (const row of rows) for (const field of fields) {
      const value = clean(row?.[field]);
      if (value) return value;
    }
    return null;
  };
  return {
    title: first("short_title", "title", "description")
      || `Contract ${object?.identity_keys?.contract_ids?.[0] || object?.identity_keys?.epins?.[0] || "record"}`,
    agency: first("agency_name", "agency"),
    vendor: first("vendor_name", "vendor", "prime_vendor", "payee_name"),
    amount: first("contract_amount", "award_amount", "current_amount", "current", "amount", "check_amount"),
    method: first("selection_method_description", "procurement_method"),
    program: first("program"),
    industry: first("industry"),
  };
}

export function procurementContractWatchHref(procurementId) {
  const id = clean(procurementId, 320);
  if (!id.startsWith("procurement:")) return null;
  return followingUrlFromWatch({
    lens: "money",
    filter: { procurement_id: id, noticeType: "award" },
    freq: "daily",
  }, { base: "/following" });
}

export function procurementVendorFollowHref(vendor) {
  const name = clean(vendor, 120);
  if (!name) return null;
  return followingUrlFromWatch({
    lens: "entity",
    filter: { kind: "vendor", name },
    freq: "daily",
  }, { base: "/following" });
}

function procurementActions(object, facts) {
  const watchHref = procurementContractWatchHref(object?.procurement_id);
  const vendorHref = procurementVendorFollowHref(facts.vendor);
  const items = [];
  if (watchHref) {
    items.push({
      kind: "link",
      label: "Watch this contract",
      href: watchHref,
      primary: true,
      className: "civic-object-action",
      attrs: { "data-procurement-watch": object.procurement_id },
    });
  }
  if (vendorHref) {
    items.push({
      kind: "link",
      label: "Follow this vendor",
      href: vendorHref,
      className: "civic-object-action",
      attrs: { "data-follow": "vendor", "data-name": facts.vendor },
    });
  }
  const reportTarget = buildContractVendorRelationshipReportTarget(object, facts)
    || buildContractReportTarget(object, facts);
  items.push(reportIssueAction(reportTarget));
  return items.length ? renderNodeActions(items, { ariaLabel: "Document actions", extraClass: "civic-object-actions" }) : "";
}

function stageList(object) {
  const stages = Array.isArray(object?.stages) ? object.stages : [];
  return stages.length
    ? `<ol class="node-fact-list">${stages.map((entry) => `<li><strong>${esc(clean(entry.stage).replaceAll("_", " "))}</strong></li>`).join("")}</ol>`
    : "";
}

function observationRows(object, observations) {
  const index = new Map((Array.isArray(observations) ? observations : [])
    .map((entry) => [entry?.source_observation_ref, entry]));
  return (object?.source_observation_refs || []).map((ref) => index.get(ref)).filter(Boolean);
}

function checkbookOfficialSource(object, rows) {
  const snapshots = rows.map((entry) => entry?.snapshot).filter(Boolean);
  const first = (...fields) => {
    for (const row of snapshots) for (const field of fields) {
      const value = clean(row?.[field], 80);
      if (value) return value;
    }
    return null;
  };
  const agid = first("agid", "original_agreement_id");
  const contractId = object?.identity_keys?.contract_ids?.[0] || first("id", "contract_id", "contractId", "prime_contract_id");
  const vendor = first("vendor", "vendor_name", "prime_vendor", "payee_name");
  if (/^\d+$/.test(agid || "")) {
    const codeMatch = String(contractId || "").trim().match(/^([A-Za-z]+)(\d)/);
    const code = codeMatch ? `${codeMatch[1]}${codeMatch[2]}`.toUpperCase() : "CT1";
    return {
      href: `https://www.checkbooknyc.com/contract_details/agid/${encodeURIComponent(agid)}/doctype/${encodeURIComponent(code)}`,
      label: "Checkbook NYC",
    };
  }
  const term = contractId || vendor;
  if (term) {
    return {
      href: `${CHECKBOOK_SMART_SEARCH}?search_term=${encodeURIComponent(term)}`,
      label: "Search Checkbook NYC",
    };
  }
  return { href: CHECKBOOK_CONTRACT_SEARCH, label: "Checkbook NYC" };
}

/**
 * Resident official-source links for a procurement object.
 * PASSPort Public has no per-contract page; the contracts browse portal is
 * the public source. Checkbook search is labeled as search unless a
 * contract-detail agid is present.
 */
export function procurementOfficialSourceItems(object = {}, observations = []) {
  const rows = observationRows(object, observations);
  const systems = new Set(rows.map((entry) => String(entry.source_system || "").toLowerCase()));
  for (const ref of object?.source_observation_refs || []) {
    const system = String(ref).split(":")[0]?.toLowerCase();
    if (system) systems.add(system);
  }
  const items = [];
  const seen = new Set();
  const add = (item) => {
    const href = clean(item?.href, 500);
    const label = clean(item?.label, 80);
    if (!href || !label) return;
    const key = `${href}\0${label}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ href, label });
  };

  for (const href of object?.compatibility?.city_record_notice_hrefs || []) {
    add({ href, label: "City Record notice" });
  }
  if (systems.has("passport_public_contracts")) {
    add(passportPublicOfficialSource("contract"));
  }
  if (systems.has("passport_public_rfx")) {
    const rfx = rows.find((entry) => entry.source_system === "passport_public_rfx");
    add(passportPublicOfficialSource("rfx", rfx?.snapshot || {}));
  }
  if (systems.has("checkbook_contracts") || systems.has("checkbook_spending")) {
    add(checkbookOfficialSource(object, rows.filter((entry) =>
      entry.source_system === "checkbook_contracts" || entry.source_system === "checkbook_spending")));
  }
  return items;
}

export function renderProcurementDocument(object = {}, observations = [], { currentHref = "" } = {}) {
  const id = clean(object?.procurement_id, 320);
  if (!id.startsWith("procurement:")) return null;
  const facts = factsFor(object, observations);
  const factRows = [
    ["Agency", facts.agency], ["Vendor", facts.vendor], ["Amount", facts.amount], ["Method", facts.method],
    ["Program", facts.program], ["Industry", facts.industry],
    ["Contract ID", object?.identity_keys?.contract_ids?.[0]], ["PIN / EPIN", object?.identity_keys?.epins?.[0]],
  ].filter(([, value]) => value).map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join("");
  const sourceItems = procurementOfficialSourceItems(object, observations);
  const canonical = procurementCanonicalHref(object);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(facts.title)} · CityScroll</title><link rel="canonical" href="https://cityscroll.org${esc(canonical)}">${renderCivicDocumentAssets("/")}<script type="module" src="/report_issue.mjs"></script></head>
<body>${renderCivicDocumentMast({ current: "browse" })}<main class="node-document" data-civic-object-kind="procurement" data-procurement-id="${esc(id)}">
${renderNodeBack({ href: "/browse/contracts/?mode=award", label: "Back to contracts", currentHref })}
<header class="node-hero"><p class="ftype">Procurement</p><h1>${esc(facts.title)}</h1></header>
${procurementActions(object, facts)}
${renderNodeSection({ heading: "Contract facts", body: factRows ? `<dl class="node-facts">${factRows}</dl>` : "" })}
${renderProcurementObjectCoverageHtml(object, observations)}
${renderNodeSection({ heading: "Observed stages", body: stageList(object) })}
${renderNodeProvenance({ heading: sourceItems.length ? "Official records" : "", sourceItems })}
</main>${renderNodeFooter({})}</body></html>`;
  return gateNodePageRender(html);
}
