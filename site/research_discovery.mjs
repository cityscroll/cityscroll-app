/**
 * Contextual discovery projection for existing research utilities.
 *
 * This is not a second capability registry. Each family's presence is tied to a
 * real handler and source state; missing optional data yields omission, never an
 * empty panel or fabricated success. Optional utilities render inside the shared
 * More tools disclosure so quiet notice tools can compose the same region.
 */

import { GUIDE_HELP, renderGuideHelpLink } from "./guide_contextual_links.mjs";
import { analyticalDrillThroughHref } from "./analytical_projection.mjs";
import { asOfHref } from "./civic_time_ledger.mjs";
import { AFFORDANCE_ACTION_ROLES, affordanceActionRole } from "./affordance_grammar.mjs";

export const MORE_TOOLS_LABEL_KEY = "more_tools_label";
export const MORE_TOOLS_LABEL = "More tools";
export const MORE_TOOLS_REGION_ATTR = "data-more-tools-region";
export const RESEARCH_TASK_ENTRANCES_ID = "research-task-entrances";

/** Capability families this projection can place beside an eligible record. */
export const RESEARCH_CAPABILITY_FAMILIES = Object.freeze({
  evidence: Object.freeze({
    id: "evidence",
    label: "Check connection evidence",
    handler: "site/graph_edge_provenance.mjs",
    guideTopic: "connection",
    role: AFFORDANCE_ACTION_ROLES.inspect,
  }),
  asOf: Object.freeze({
    id: "asOf",
    label: "Look at records as of a day",
    handler: "site/civic_time_ledger.mjs",
    guideTopic: "asOf",
    role: AFFORDANCE_ACTION_ROLES.navigate,
  }),
  comparative: Object.freeze({
    id: "comparative",
    label: "Compare related contracts",
    handler: "capabilities/contracts_analysis.mjs",
    guideTopic: null,
    role: AFFORDANCE_ACTION_ROLES.navigate,
  }),
  share: Object.freeze({
    id: "share",
    label: "Share or copy this link",
    handler: "site/app/search-share.mjs",
    guideTopic: null,
    role: AFFORDANCE_ACTION_ROLES.inspect,
  }),
  saveSearch: Object.freeze({
    id: "saveSearch",
    label: "Save this search",
    handler: "site/app/search-share.mjs",
    guideTopic: null,
    role: AFFORDANCE_ACTION_ROLES.inspect,
  }),
  collection: Object.freeze({
    id: "collection",
    label: "Collect and export records",
    handler: "site/app/workspace.mjs",
    guideTopic: "emptyCollection",
    role: AFFORDANCE_ACTION_ROLES.inspect,
  }),
  export: Object.freeze({
    id: "export",
    label: "Export a spreadsheet",
    handler: "site/app/search-share.mjs",
    guideTopic: null,
    role: AFFORDANCE_ACTION_ROLES.inspect,
  }),
  print: Object.freeze({
    id: "print",
    label: "Print or save as PDF",
    handler: "site/app/search-share.mjs",
    guideTopic: null,
    role: AFFORDANCE_ACTION_ROLES.inspect,
  }),
});

const FAMILY_ORDER = Object.freeze([
  "evidence",
  "asOf",
  "comparative",
  "share",
  "saveSearch",
  "collection",
  "export",
  "print",
]);

function esc(value) {
  return String(value ?? "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function clean(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function translate(key, fallback, translateFn) {
  if (typeof translateFn === "function") {
    try {
      const label = translateFn(key);
      if (label) return label;
    } catch {
      /* keep fallback */
    }
  }
  return fallback;
}

/**
 * Exact comparative-analysis entrance. Preserves agency and optional fiscal-year /
 * measure filters already represented by the caller; invents nothing from absence.
 */
export function comparativeAnalysisHref({
  agency = null,
  primeVendor = null,
  fiscalYear = null,
  measure = null,
  industry = null,
  awardMethod = null,
  amountBand = null,
} = {}) {
  const buyer = clean(agency);
  const vendor = clean(primeVendor);
  // Comparative analysis needs at least one population dimension the contracts
  // projection can honor. Do not invent a buyer or vendor from absence.
  if (!buyer && !vendor) return null;
  const href = analyticalDrillThroughHref({
    agency: buyer || undefined,
    prime_vendor: vendor || undefined,
    registration_fiscal_year: fiscalYear == null || fiscalYear === "" ? undefined : fiscalYear,
    industry: clean(industry) || undefined,
    award_method: clean(awardMethod) || undefined,
    contract_amount_band: clean(amountBand) || undefined,
  });
  if (!href) return null;
  if (!clean(measure)) return href;
  const url = new URL(href, "https://cityscroll.org");
  url.searchParams.set("ap_measure", clean(measure));
  return `${url.pathname}${url.search}`;
}

/** Evidence inspector entrance that keeps relation identity in the claim query. */
export function evidenceContextHref({ path = null, claimId = null } = {}) {
  const base = clean(path);
  const claim = clean(claimId);
  if (!base) return null;
  if (!claim) {
    return base.includes("#") ? base : `${base}#edge-provenance`;
  }
  const url = new URL(base, "https://cityscroll.org");
  url.searchParams.set("claim", claim);
  url.hash = `claim-${encodeURIComponent(claim)}`;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** As-of entrance that only emits a day the caller already supports. */
export function asOfContextHref({ path = null, asOfDay = null } = {}) {
  const base = clean(path);
  if (!base) return null;
  const day = clean(asOfDay);
  if (!day) return asOfHref(base, null);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  return asOfHref(base, day);
}

/**
 * Project which research families a surface may offer.
 *
 * `context` fields are caller-supplied facts about handlers and source state:
 * - surface: notice | matter | agency | vendor | institution | search | guide | api
 * - hasShareHandler, hasSaveSearchHandler, hasCollectionHandler, hasExportHandler, hasPrintHandler
 * - evidencePath / evidenceClaimId
 * - asOfPath / asOfDay / asOfSupported
 * - comparativeAgency / comparativeVendor / comparativeFiscalYear / comparativeMeasure
 */
export function projectResearchTools(context = {}) {
  const surface = clean(context.surface) || "record";
  const available = [];

  const evidenceHref = evidenceContextHref({
    path: context.evidencePath,
    claimId: context.evidenceClaimId,
  });
  if (evidenceHref) {
    available.push({
      ...RESEARCH_CAPABILITY_FAMILIES.evidence,
      href: evidenceHref,
      eligible: true,
    });
  } else if (context.requireEvidence === true) {
    available.push({ ...RESEARCH_CAPABILITY_FAMILIES.evidence, href: null, eligible: false });
  }

  const asOfSupported = context.asOfSupported === true;
  const asOfHrefValue = asOfSupported
    ? asOfContextHref({ path: context.asOfPath, asOfDay: context.asOfDay })
    : null;
  if (asOfHrefValue) {
    available.push({
      ...RESEARCH_CAPABILITY_FAMILIES.asOf,
      href: asOfHrefValue,
      eligible: true,
    });
  } else if (context.requireAsOf === true) {
    available.push({ ...RESEARCH_CAPABILITY_FAMILIES.asOf, href: null, eligible: false });
  }

  const comparativeHref = comparativeAnalysisHref({
    agency: context.comparativeAgency,
    primeVendor: context.comparativeVendor,
    fiscalYear: context.comparativeFiscalYear,
    measure: context.comparativeMeasure,
    industry: context.comparativeIndustry,
    awardMethod: context.comparativeAwardMethod,
    amountBand: context.comparativeAmountBand,
  });
  if (comparativeHref) {
    available.push({
      ...RESEARCH_CAPABILITY_FAMILIES.comparative,
      href: comparativeHref,
      eligible: true,
    });
  } else if (context.requireComparative === true) {
    available.push({ ...RESEARCH_CAPABILITY_FAMILIES.comparative, href: null, eligible: false });
  }

  const handlerFamilies = [
    ["share", context.hasShareHandler],
    ["saveSearch", context.hasSaveSearchHandler],
    ["collection", context.hasCollectionHandler],
    ["export", context.hasExportHandler],
    ["print", context.hasPrintHandler],
  ];
  for (const [id, present] of handlerFamilies) {
    if (present === true) {
      available.push({ ...RESEARCH_CAPABILITY_FAMILIES[id], href: null, eligible: true });
    } else if (present === false && context[`require${id[0].toUpperCase()}${id.slice(1)}`] === true) {
      available.push({ ...RESEARCH_CAPABILITY_FAMILIES[id], href: null, eligible: false });
    }
  }

  const byId = new Map(available.map((item) => [item.id, item]));
  const ordered = FAMILY_ORDER.map((id) => byId.get(id)).filter(Boolean);
  return Object.freeze({
    surface,
    tools: Object.freeze(ordered),
    eligible: Object.freeze(ordered.filter((item) => item.eligible)),
    ineligible: Object.freeze(ordered.filter((item) => item.eligible === false)),
  });
}

/**
 * Native, initially closed More tools disclosure. Callers supply already-built
 * control HTML so existing IDs and handlers stay intact. Empty content omits
 * the region entirely — no empty panel.
 */
export function renderMoreToolsRegion({
  content = "",
  label = MORE_TOOLS_LABEL,
  labelKey = MORE_TOOLS_LABEL_KEY,
  open = false,
  extraClass = "",
  id = null,
  translate: translateFn = globalThis.window?.t,
} = {}) {
  const body = String(content ?? "").trim();
  if (!body) return "";
  const text = translate(labelKey, label, translateFn);
  const classes = ["utility-overflow", "more-tools", extraClass].filter(Boolean).join(" ");
  const openAttr = open ? " open" : "";
  const idAttr = id ? ` id="${esc(id)}"` : "";
  return `<details class="${esc(classes)}" ${MORE_TOOLS_REGION_ATTR}="1"${idAttr}${openAttr}>` +
    `<summary class="act mini more-tools-summary" data-i18n="${esc(labelKey)}">${esc(text)}</summary>` +
    `<div class="utility-overflow-content more-tools-content">${body}</div>` +
    `</details>`;
}

/**
 * Navigation links for eligible contextual research destinations. Omits
 * ineligible families so absence never becomes an empty heading.
 */
export function renderResearchNavigation(projection, {
  translate: translateFn = globalThis.window?.t,
  extraClass = "",
} = {}) {
  const links = (projection?.eligible || []).filter((tool) => tool.href);
  if (!links.length) return "";
  const items = links.map((tool) => {
    const role = affordanceActionRole({ href: tool.href }) || tool.role;
    const label = translate(`research_tool_${tool.id}`, tool.label, translateFn);
    return `<a class="act research-tool-link" data-research-tool="${esc(tool.id)}" data-affordance-role="${esc(role)}" href="${esc(tool.href)}">${esc(label)}</a>`;
  }).join("");
  const classes = ["research-tool-links", extraClass].filter(Boolean).join(" ");
  return `<div class="${esc(classes)}" data-research-navigation="1">${items}</div>`;
}

/**
 * Direct Guide / API task entrances for research utilities — not an inventory of
 * every capability, only the named how-to destinations readers already have.
 */
export function renderResearchTaskEntrances({
  translate: translateFn = globalThis.window?.t,
  includeApi = false,
} = {}) {
  const tasks = [
    { topic: "connection", family: "evidence" },
    { topic: "asOf", family: "asOf" },
    { topic: "emptyCollection", family: "collection" },
  ];
  const items = tasks.map(({ topic, family }) => {
    const help = GUIDE_HELP[topic];
    const label = translate(help.key, help.label, translateFn);
    return `<li data-research-task="${esc(family)}"><a href="${esc(help.href)}" data-i18n="${esc(help.key)}">${esc(label)}</a></li>`;
  });
  if (includeApi) {
    items.push(`<li data-research-task="comparative"><a href="/browse/contracts/?mode=award">Compare registered contracts</a></li>`);
    items.push(`<li data-research-task="api-analysis"><a href="/api.html#research-read-scope">Contracts analysis API</a></li>`);
  }
  return `<section class="research-task-entrances" id="${RESEARCH_TASK_ENTRANCES_ID}" aria-labelledby="${RESEARCH_TASK_ENTRANCES_ID}-heading">` +
    `<h2 id="${RESEARCH_TASK_ENTRANCES_ID}-heading">Research tools in context</h2>` +
    `<p>These guides open the existing evidence, history, collection and comparison tools beside the record you are already reading.</p>` +
    `<ul>${items.join("")}</ul>` +
    `${renderGuideHelpLink("connection", { extraClass: "research-task-guide" })}` +
    `</section>`;
}

/**
 * Compose primary civic actions with optional utilities inside More tools.
 * Primary markup stays outside the disclosure; optional markup is omitted when empty.
 */
export function renderRecordActionRegions({
  primaryHtml = "",
  moreToolsHtml = "",
  researchHtml = "",
  moreToolsId = null,
  translate: translateFn = globalThis.window?.t,
} = {}) {
  const primary = String(primaryHtml ?? "").trim();
  const more = renderMoreToolsRegion({
    content: moreToolsHtml,
    id: moreToolsId,
    translate: translateFn,
  });
  const research = String(researchHtml ?? "").trim();
  if (!primary && !more && !research) return "";
  return `<div class="actions record-action-regions" data-record-action-regions="1">` +
    `${primary}${more}${research}` +
    `</div>`;
}

export function researchFamilyIds() {
  return FAMILY_ORDER.slice();
}
