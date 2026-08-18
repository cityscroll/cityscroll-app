import {
  gateNodePageRender,
  renderCivicDocumentAssets,
  renderCivicDocumentMast,
  renderNodeBack,
  renderNodeFooter,
  renderNodeProvenance,
  renderNodeSection,
} from "./civic_document_chrome.mjs";
import { procurementCanonicalHref } from "./procurement_object_contract.mjs";

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
  const rows = (object?.source_observation_refs || []).map((ref) => index.get(ref)?.snapshot).filter(Boolean);
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
  };
}

function stageList(object) {
  const stages = Array.isArray(object?.stages) ? object.stages : [];
  return stages.length
    ? `<ol class="node-fact-list">${stages.map((entry) => `<li><strong>${esc(clean(entry.stage).replaceAll("_", " "))}</strong></li>`).join("")}</ol>`
    : "";
}

export function renderProcurementDocument(object = {}, observations = [], { currentHref = "" } = {}) {
  const id = clean(object?.procurement_id, 320);
  if (!id.startsWith("procurement:")) return null;
  const facts = factsFor(object, observations);
  const factRows = [
    ["Agency", facts.agency], ["Vendor", facts.vendor], ["Amount", facts.amount], ["Method", facts.method],
    ["Contract ID", object?.identity_keys?.contract_ids?.[0]], ["PIN / EPIN", object?.identity_keys?.epins?.[0]],
  ].filter(([, value]) => value).map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join("");
  const noticeLinks = (object?.compatibility?.city_record_notice_hrefs || []).map((href) => ({
    href, label: "City Record notice",
  }));
  const canonical = procurementCanonicalHref(object);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(facts.title)} · CityScroll</title><link rel="canonical" href="https://cityscroll.org${esc(canonical)}">${renderCivicDocumentAssets("/")}</head>
<body>${renderCivicDocumentMast({ current: "browse" })}<main class="node-document" data-civic-object-kind="procurement" data-procurement-id="${esc(id)}">
${renderNodeBack({ href: "/browse/contracts/?mode=award", label: "Back to contracts", currentHref })}
<header class="node-hero"><p class="ftype">Procurement</p><h1>${esc(facts.title)}</h1></header>
${renderNodeSection({ heading: "Contract facts", body: factRows ? `<dl class="node-facts">${factRows}</dl>` : "" })}
${renderNodeSection({ heading: "Observed stages", body: stageList(object) })}
${renderNodeProvenance({ heading: noticeLinks.length ? "Official records" : "", sourceItems: noticeLinks })}
</main>${renderNodeFooter({})}</body></html>`;
  return gateNodePageRender(html);
}
