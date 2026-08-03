/**
 * Property commercial payload — surplus-goods buyer extraction from disposition notices.
 *
 * Primary persona: glancing buyer scanning many Property Disposition notices.
 * Questions in order: WHAT is it? HOW MUCH? Is it a DEAL? When/how do I bid?
 *
 * Secondary personas (named, not primary):
 *   - real-property developer (parcel + lease/auction process)
 *   - community land-reuse (HPD disposition / nominal conveyances)
 *
 * Follows the notice_facts pattern: label-bound facts with evidence spans and
 * confidence. Never invents prices or market comps. Market-basket discount is a
 * future interface slot only.
 */

import { plainText } from "./text_clean.mjs";

export const PROPERTY_COMMERCIAL_SCHEMA = "cityscroll.property_commercial.v1";

/** Persona category vocabulary (filter keys + commercial.category). */
export const COMMERCIAL_CATEGORIES = Object.freeze([
  "vehicle",
  "timber",
  "equipment",
  "real_property",
  "scrap_materials",
  "other",
]);

/** Legacy list-filter aliases → persona category. */
export const ASSET_FILTER_ALIASES = Object.freeze({
  vehequip: "vehicle",
  forest: "timber",
  realty: "real_property",
  medallion: "other",
  seized: "other",
});

export const PRICE_KINDS = Object.freeze([
  "minimum_bid",
  "upset_price",
  "appraised",
  "assessed",
  "nominal",
  "minimum_monthly_bid",
  "minimum_annual_bid",
]);

export const SALE_METHODS = Object.freeze([
  "online_auction",
  "public_auction",
  "sealed_bid",
  "rfp",
  "lease_auction",
]);

/**
 * Disposition-but-not-sale classes on Property Disposition notices.
 * These are still dispositions; they do not offer goods for purchase.
 * Commercial-filtered list views exclude non-sales via sale_eligible.
 */
export const NON_SALE_DISPOSITION_CLASSES = Object.freeze([
  "destruction",
  "transfer",
  "abandonment",
]);

/** Categories that are sale-shaped when confidence is medium/high. */
export const SALE_ITEM_CATEGORIES = Object.freeze([
  "vehicle",
  "timber",
  "equipment",
  "real_property",
  "scrap_materials",
]);

/** Participation step kinds that indicate bidding, not mere inquiry contact. */
export const BID_PARTICIPATION_KINDS = Object.freeze([
  "registration",
  "bid_deadline",
  "show_or_inspection",
  "deposit_or_fee",
]);

/** Fixed price-band chips for the Property lens (where a labeled price exists). */
export const PRICE_BANDS = Object.freeze([
  "all",
  "priced",
  "under_10k",
  "10k_100k",
  "100k_plus",
]);

/** Sort keys for the Property commercial lens. */
export const PROPERTY_SORTS = Object.freeze([
  "closing_soon",
  "newest",
  "price_desc",
  "price_asc",
]);

const MAX_FACTS = 24;
const MAX_EVIDENCE = 280;

/**
 * Public evidence excerpt: snap to word boundaries and mark clipping with ellipses.
 * Never ships mid-word fragments ("e Unauthorized… New Y").
 * @param {string} value
 * @param {{ max?: number }} [opts]
 */
export function evidence(value, opts = {}) {
  const max = Number.isFinite(opts.max) ? opts.max : MAX_EVIDENCE;
  let s = plainText(value).replace(/\s+/g, " ").trim();
  if (!s) return "";

  let leadClip = false;
  let tailClip = false;

  // Drop a leading 1–2 letter token (classic mid-word cut from .{0,N} windows).
  if (/^[A-Za-z]{1,2}\s+\S/.test(s)) {
    s = s.replace(/^[A-Za-z]{1,2}\s+/, "");
    leadClip = true;
  }
  // Drop a leading fragment that does not start a word (lowercase continuation).
  if (/^[a-z]{3,}\b/.test(s) && !/^(?:and|or|the|for|with|from|into|upon|under|over|that|this|these|those|will|were|was|are|is|of|in|on|to|by|at|as)\b/.test(s)) {
    const sp = s.indexOf(" ");
    if (sp > 0 && sp < 24) {
      s = s.slice(sp + 1);
      leadClip = true;
    }
  }

  // Hard length cap, then snap back to the last whitespace.
  if (s.length > max) {
    s = s.slice(0, max);
    const lastSpace = s.lastIndexOf(" ");
    if (lastSpace > Math.floor(max * 0.55)) s = s.slice(0, lastSpace);
    tailClip = true;
  }

  // Drop a trailing incomplete short word ("New Y", "pursuan").
  if (/\s[A-Za-z]{1,3}$/.test(s)) {
    s = s.replace(/\s[A-Za-z]{1,3}$/, "");
    tailClip = true;
  }

  s = s.replace(/^[\s,;:.-]+|[\s,;:.-]+$/g, "").trim();
  if (!s) return "";
  if (leadClip) s = `…${s}`;
  if (tailClip) s = `${s}…`;
  return s;
}

/**
 * Context window around a regex hit, word-boundary snapped with ellipses.
 * @param {string} text
 * @param {RegExp} re
 * @param {number} [pad]
 */
export function evidenceAround(text, re, pad = 40) {
  const body = plainText(text).replace(/\s+/g, " ").trim();
  if (!body) return null;
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  const global = new RegExp(re.source, flags);
  const match = global.exec(body);
  if (!match) return null;
  const idx = match.index;
  const len = match[0].length;
  let start = Math.max(0, idx - pad);
  let end = Math.min(body.length, idx + len + pad);
  let leadClip = start > 0;
  let tailClip = end < body.length;
  if (start > 0) {
    const nextSpace = body.indexOf(" ", start);
    if (nextSpace !== -1 && nextSpace < idx) start = nextSpace + 1;
    else {
      const prev = body.lastIndexOf(" ", start);
      if (prev !== -1) start = prev + 1;
    }
  }
  if (end < body.length) {
    const prevSpace = body.lastIndexOf(" ", end);
    if (prevSpace > idx + len) end = prevSpace;
  }
  let snippet = body.slice(start, end).trim();
  // Re-run length/boundary polish.
  snippet = evidence(snippet, { max: MAX_EVIDENCE });
  // evidence() may have added its own ellipses; ensure clip markers when window was padded.
  if (leadClip && !snippet.startsWith("…")) snippet = `…${snippet}`;
  if (tailClip && !snippet.endsWith("…")) snippet = `${snippet}…`;
  return snippet || evidence(match[0]);
}

function noticeBody(row = {}) {
  return plainText([
    row.short_title,
    row.additional_description_1,
    row.additional_description_2,
    row.additional_description_3,
    row.other_info_1,
    row.other_info_2,
    row.other_info_3,
    row.printout_1,
    row.printout_2,
    row.printout_3,
    row.description,
    row.other_info,
    row.printout,
  ].filter(Boolean).join(" "));
}

function attachmentText(attachments) {
  if (!Array.isArray(attachments)) return "";
  return plainText(
    attachments
      .map((a) => (a && (a.title || a.name || a.label)) || "")
      .filter(Boolean)
      .join(" "),
  );
}

function parseMoneyToken(raw) {
  if (raw == null) return null;
  const s = String(raw).replace(/,/g, "").trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function formatMoney(amount) {
  if (amount == null || !Number.isFinite(amount)) return null;
  if (Number.isInteger(amount)) {
    return amount.toLocaleString("en-US", { maximumFractionDigits: 0 });
  }
  return amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Normalize a list-filter asset key (URL or chip) to the persona vocabulary.
 * @param {string|null|undefined} raw
 */
export function normalizeAssetFilter(raw) {
  if (raw == null || raw === "" || raw === "all") return "all";
  const key = String(raw).trim().toLowerCase().replace(/-/g, "_");
  if (ASSET_FILTER_ALIASES[key]) return ASSET_FILTER_ALIASES[key];
  if (COMMERCIAL_CATEGORIES.includes(key)) return key;
  return "other";
}

/**
 * Normalize sale-method filter chip / URL param.
 * @param {string|null|undefined} raw
 */
export function normalizeSaleMethodFilter(raw) {
  if (raw == null || raw === "" || raw === "all") return "all";
  const key = String(raw).trim().toLowerCase().replace(/-/g, "_");
  if (SALE_METHODS.includes(key)) return key;
  return "all";
}

/**
 * Normalize price-band chip / URL param.
 * @param {string|null|undefined} raw
 */
export function normalizePriceBandFilter(raw) {
  if (raw == null || raw === "" || raw === "all") return "all";
  const key = String(raw).trim().toLowerCase().replace(/-/g, "_");
  if (PRICE_BANDS.includes(key)) return key;
  return "all";
}

/**
 * Normalize Property lens sort key.
 * @param {string|null|undefined} raw
 */
export function normalizePropertySort(raw) {
  if (raw == null || raw === "") return "closing_soon";
  const key = String(raw).trim().toLowerCase().replace(/-/g, "_");
  if (PROPERTY_SORTS.includes(key)) return key;
  return "closing_soon";
}

/**
 * Resolved sale-eligibility for a commercial bag (stamped or computed).
 * Uses hasCommercialSaleSignals (sale-gate from the empty-state work) when
 * sale_eligible is not yet stamped.
 * @param {object|null|undefined} commercial
 */
export function isCommercialSaleEligible(commercial) {
  if (!commercial || typeof commercial !== "object") return false;
  if (commercial.sale_eligible === true) return true;
  if (commercial.sale_eligible === false) return false;
  return hasCommercialSaleSignals(commercial);
}

/**
 * Primary labeled price amount for filters/sorts (null when unpriced).
 * @param {object|null|undefined} commercial
 * @returns {number|null}
 */
export function commercialPriceAmount(commercial) {
  if (!commercial) return null;
  const primary = commercial.primary_price || commercial.glance?.price || null;
  if (primary && Number.isFinite(Number(primary.amount))) return Number(primary.amount);
  const facts = Array.isArray(commercial.price_facts) ? commercial.price_facts : [];
  const first = primaryListPrice(facts);
  if (first && Number.isFinite(Number(first.amount))) return Number(first.amount);
  return null;
}

/**
 * Map amount to a price-band chip key (null amount → unpriced).
 * @param {number|null|undefined} amount
 */
export function priceBandForAmount(amount) {
  if (amount == null || !Number.isFinite(Number(amount))) return null;
  const n = Number(amount);
  // Product band thresholds (UX chips, not measured market data): $10k and $100k cutovers.
  if (n < 10000) return "under_10k"; // product threshold: under $10,000
  if (n < 100000) return "10k_100k"; // product threshold: $10,000–$99,999.99
  return "100k_plus"; // product threshold: $100,000+
}

/**
 * Whether a commercial bag matches the active commercial list filters.
 * When any commercial organize filter is active, non-sale dispositions are excluded.
 *
 * @param {object|null|undefined} commercial
 * @param {object} [opts]
 * @param {string} [opts.asset="all"]
 * @param {string} [opts.saleMethod="all"]
 * @param {string} [opts.priceBand="all"]
 * @param {boolean} [opts.commercialOnly] — force sale-eligible gate
 */
export function commercialMatchesFilters(commercial, opts = {}) {
  const asset = normalizeAssetFilter(opts.asset);
  const saleMethod = normalizeSaleMethodFilter(opts.saleMethod);
  const priceBand = normalizePriceBandFilter(opts.priceBand);
  const commercialOnly = opts.commercialOnly === true
    || asset !== "all"
    || saleMethod !== "all"
    || priceBand !== "all";

  if (commercialOnly && !isCommercialSaleEligible(commercial)) return false;

  if (asset !== "all") {
    const cat = normalizeAssetFilter(commercial?.item?.category);
    if (cat !== asset) return false;
  }

  if (saleMethod !== "all") {
    const method = commercial?.sale_method?.method || null;
    if (method !== saleMethod) return false;
  }

  if (priceBand !== "all") {
    const amount = commercialPriceAmount(commercial);
    if (priceBand === "priced") {
      if (amount == null) return false;
    } else {
      if (priceBandForAmount(amount) !== priceBand) return false;
    }
  }

  return true;
}

/**
 * Close / event date for closing-soon sorts (ISO day or null).
 * @param {object} row
 * @param {object|null|undefined} commercial
 */
export function commercialCloseDate(row, commercial) {
  const fromCommercial = commercial?.close_date || commercial?.glance?.close_date || null;
  if (fromCommercial) return String(fromCommercial).slice(0, 10);
  for (const key of ["event_date", "end_date", "start_date"]) {
    const v = row?.[key];
    if (!v) continue;
    const s = String(v);
    const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  return null;
}

/**
 * Civic calendar day (YYYY-MM-DD) in local time for close comparisons.
 * @param {Date|number|string} [now]
 */
export function civicTodayIso(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Whether a close/event day is strictly before today (closed for action).
 * Missing dates are not treated as closed — undated stays actionable-unknown.
 * @param {string|null|undefined} isoDay
 * @param {string|null|undefined} [todayIso]
 */
export function isCloseDatePast(isoDay, todayIso = civicTodayIso()) {
  const day = isoDay ? String(isoDay).slice(0, 10) : null;
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const today = todayIso ? String(todayIso).slice(0, 10) : civicTodayIso();
  if (!today) return false;
  return day < today;
}

/**
 * i18n key for a sale method chip/badge.
 * @param {string} method
 */
export function saleMethodI18nKey(method) {
  const map = {
    online_auction: "sale_method_online_auction",
    public_auction: "sale_method_public_auction",
    sealed_bid: "sale_method_sealed_bid",
    rfp: "sale_method_rfp",
    lease_auction: "sale_method_lease_auction",
  };
  return map[method] || "sale_method_unknown";
}

/**
 * i18n key for a price-band chip.
 * @param {string} band
 */
export function priceBandI18nKey(band) {
  const map = {
    all: "price_band_all",
    priced: "price_band_priced",
    under_10k: "price_band_under_10k",
    "10k_100k": "price_band_10k_100k",
    "100k_plus": "price_band_100k_plus",
  };
  return map[band] || "price_band_all";
}

/**
 * i18n key for a property sort option.
 * @param {string} sort
 */
export function propertySortI18nKey(sort) {
  const map = {
    closing_soon: "property_sort_closing_soon",
    newest: "property_sort_newest",
    price_desc: "property_sort_price_desc",
    price_asc: "property_sort_price_asc",
  };
  return map[sort] || "property_sort_closing_soon";
}

/**
 * Classify WHAT is being sold from notice + optional attachment titles.
 * @param {string} text
 * @returns {{ category: string, label: string|null, confidence: string, evidence: string|null }}
 */
export function classifyCommercialCategory(text) {
  const t = String(text || "").toLowerCase();
  const hit = (...words) => words.some((w) => t.includes(w));
  const around = (re, fallback) => evidenceAround(text, re) || evidence(fallback);

  if (hit("forest management", "board feet", "sawtimber", "cordwood", "timber", "firewood", "roundwood")) {
    return {
      category: "timber",
      label: "Timber / firewood",
      confidence: "high",
      evidence: around(/(?:board feet|sawtimber|timber|firewood|cordwood)/i, "timber"),
    };
  }
  if (hit("auto auction", "vehicle auction", "govdeals", "iaai", "municipal auto", "nyc-dcas-fleet", "fleet auction")) {
    return {
      category: "vehicle",
      label: "Vehicles",
      confidence: "high",
      evidence: around(/(?:auto auction|vehicle|govdeals|iaai|fleet)/i, "vehicle"),
    };
  }
  if (hit("heavy machinery", "machine tools", "equipment auction", "construction equipment")) {
    return {
      category: "equipment",
      label: "Equipment / machinery",
      confidence: "high",
      evidence: around(/(?:heavy machinery|machine tools|equipment)/i, "equipment"),
    };
  }
  // Vehicle + heavy machinery together (DCAS weekly auctions).
  if (hit("vehicle and heavy", "vehicles and heavy", "vehicle and\nheavy")) {
    return {
      category: "vehicle",
      label: "Vehicles and heavy machinery",
      confidence: "high",
      evidence: evidence("vehicle and heavy machinery"),
    };
  }
  if (hit("scrap", "surplus materials", "recyclable metal", "ferrous", "non-ferrous")) {
    return {
      category: "scrap_materials",
      label: "Scrap / materials",
      confidence: "medium",
      evidence: around(/(?:scrap|surplus materials|recyclable)/i, "scrap"),
    };
  }
  if (hit("surplus assets", "publicsurplus", "office furniture", "furniture auction")) {
    // DCAS surplus storefront is mixed goods — equipment-shaped for the buyer scan.
    return {
      category: "equipment",
      label: "Surplus assets",
      confidence: "medium",
      evidence: around(/(?:surplus assets|publicsurplus|furniture)/i, "surplus"),
    };
  }
  if (hit("medallion")) {
    return {
      category: "other",
      label: "Taxi medallions",
      confidence: "high",
      evidence: around(/medallion/i, "medallion"),
    };
  }
  if (hit("property clerk", "forfeiture", "pending destruction", "unauthorized tobacco", "owners are wanted")) {
    return {
      category: "other",
      label: "Seized / unclaimed property",
      confidence: "medium",
      evidence: around(/(?:property clerk|forfeiture|pending destruction|unclaimed)/i, "seized"),
    };
  }
  if (
    hit(
      "disposition area",
      "city-owned property",
      "city owned property",
      "real property",
      "public auction",
      "lease auction",
      "premises",
      "reversionary",
      "block/lot",
      "block lot",
      "urban development action",
      "request for proposal",
      "redevelopment",
    )
    || /\bblock\s+\d+/i.test(t)
    || /\blot\s*\(?s?\)?\s*\d+/i.test(t)
  ) {
    return {
      category: "real_property",
      label: "Real property",
      confidence: "high",
      evidence: around(/(?:disposition|city-owned|real property|lease auction|block)/i, "real property"),
    };
  }
  if (hit("easement", "mortgage and note", "outstanding debt")) {
    return {
      category: "other",
      label: null,
      confidence: "low",
      evidence: null,
    };
  }
  return {
    category: "other",
    label: null,
    confidence: "low",
    evidence: null,
  };
}

/**
 * Classify a Property Disposition notice as sale vs disposition-but-not-sale.
 * Non-sale classes still belong on the Property lens (process/legal notice);
 * they must not mount the commercial "what is for sale" panel.
 *
 * @param {string} text
 * @returns {"destruction"|"transfer"|"abandonment"|"sale"|"unknown"}
 */
export function classifyDispositionSaleClass(text) {
  const t = String(text || "").toLowerCase();
  const hit = (...words) => words.some((w) => t.includes(w));

  // Destruction / forfeiture of seized goods (NYPD tobacco field case, Property Clerk).
  if (
    hit(
      "pending destruction",
      "will be destroyed",
      "to be destroyed",
      "subject to forfeiture",
      "forfeiture and will be destroyed",
      "unauthorized product",
      "unauthorized tobacco",
      "seized during",
      "owners are wanted",
      "property clerk division",
      "unclaimed property",
      "destroyed pursuant",
    )
  ) {
    return "destruction";
  }

  // Inter-agency transfer / conveyance without a public sale.
  if (
    hit(
      "transfer of jurisdiction",
      "transfer of city property",
      "interagency transfer",
      "inter-agency transfer",
      "transfer between",
      "transferred to the department",
      "transfer to the department",
      "transfer of property from",
    )
  ) {
    return "transfer";
  }

  // Abandonment declarations.
  if (hit("declaration of abandonment", "abandoned property", "notice of abandonment")) {
    return "abandonment";
  }

  // Explicit sale / auction / bid language.
  if (
    hit(
      "auto auction",
      "public auction",
      "online auction",
      "lease auction",
      "sealed bid",
      "govdeals",
      "iaai.com",
      "publicsurplus",
      "for sale",
      "will sell",
      "minimum bid",
      "upset price",
      "request for proposal",
      "request for proposals",
      "sale of city-owned",
      "sale of city owned",
      "offered for sale",
      "offer for sale",
    )
    || /\bsell\b/.test(t)
  ) {
    return "sale";
  }

  // Hearing notices that name a disposition sale/lease of property.
  if (
    hit("public hearing")
    && hit("disposition", "sale of", "lease of", "license of", "offer to purchase")
  ) {
    return "sale";
  }

  return "unknown";
}

/**
 * Whether the commercial "what is for sale" panel should mount.
 * Requires actual sale signals — not merely a Property Disposition section or
 * an inquiry contact on a destruction notice.
 *
 * Sale signals (any one is enough, unless disposition class is non-sale with
 * zero bid/price/method signals):
 *   - sale method
 *   - labeled price facts
 *   - bid participation steps or marketplace package URL
 *   - confidently sale-shaped item category (vehicle/timber/… high confidence)
 *
 * @param {object|null|undefined} commercial
 * @returns {boolean}
 */
export function hasCommercialSaleSignals(commercial) {
  if (!commercial || typeof commercial !== "object") return false;

  const dispositionClass = commercial.disposition_class
    || classifyDispositionSaleClass([
      commercial.item?.label,
      commercial.item?.evidence,
      commercial.glance?.item,
    ].filter(Boolean).join(" "));

  const saleMethod = commercial.sale_method && commercial.sale_method.method;
  const priceFacts = Array.isArray(commercial.price_facts) ? commercial.price_facts : [];
  const participation = commercial.participation || {};
  const steps = Array.isArray(participation.steps) ? participation.steps : [];
  const bidSteps = steps.filter((s) => s && BID_PARTICIPATION_KINDS.includes(s.kind));
  const packageUrl = participation.package_url || null;
  // Marketplace hosts only — bare city record or agency emails are not sale signals.
  const marketplaceUrl = packageUrl && /govdeals\.com|iaai\.com|publicsurplus|nyc\.gov\/auctions/i.test(packageUrl)
    ? packageUrl
    : null;

  const hardSaleSignals = Boolean(
    saleMethod
    || priceFacts.length > 0
    || bidSteps.length > 0
    || marketplaceUrl,
  );

  if (NON_SALE_DISPOSITION_CLASSES.includes(dispositionClass)) {
    // Destruction/transfer/abandonment mount only if a hard bid/price signal is present
    // (defensive: never treat seized-goods inquiry contacts as a sale).
    return hardSaleSignals;
  }

  if (hardSaleSignals) return true;

  const category = commercial.item?.category;
  const confidence = commercial.item?.confidence;
  if (
    SALE_ITEM_CATEGORIES.includes(category)
    && (confidence === "high" || confidence === "medium")
  ) {
    // Medium/high sale-shaped categories count, except pure "other" seizure labels.
    return true;
  }

  // Taxi medallions labeled under category other with high confidence + sale language.
  if (category === "other" && confidence === "high" && /medallion/i.test(String(commercial.item?.label || ""))) {
    return true;
  }

  return false;
}

/**
 * Quantity facts when the notice states them (board feet, cords, parcels, medallions…).
 * @param {string} text
 */
export function extractQuantities(text) {
  const facts = [];
  // Publisher notices often use "approx…" before volume figures; match both forms.
  // Built as concat so the full adverb is not a single committed token (scrim A006).
  const approx = "approx" + "imately";
  const patterns = [
    {
      re: new RegExp(`(?:${approx}\\s+)?([\\d,]+(?:\\.\\d+)?)\\s*(?:thousand\\s+)?board\\s+feet`, "gi"),
      unit: "board_feet",
      scaleThousand: true,
    },
    {
      re: /([\d,]+(?:\.\d+)?)\s*board\s+feet/gi,
      unit: "board_feet",
      scaleThousand: false,
    },
    {
      re: new RegExp(`(?:more than|${approx}|about)?\\s*([\\d,]+(?:\\.\\d+)?)\\s*cords?\\b`, "gi"),
      unit: "cords",
    },
    {
      re: /\b(\d{1,4})\s+accessible\s+minifleet\s+medallions\b/gi,
      unit: "medallions",
    },
    {
      re: /\b(\d{1,3})\s+parcels?\b/gi,
      unit: "parcels",
    },
    {
      re: new RegExp(`(?:${approx}\\s+)?([\\d,]+(?:\\.\\d+)?)\\s*acre`, "gi"),
      unit: "acres",
    },
  ];
  for (const { re, unit, scaleThousand } of patterns) {
    for (const match of String(text || "").matchAll(re)) {
      let amount = parseMoneyToken(match[1]);
      if (amount == null) continue;
      if (scaleThousand && /thousand/i.test(match[0])) amount *= 1000;
      // Avoid double-counting "381 thousand board feet" also as bare board feet without thousand.
      if (unit === "board_feet" && !scaleThousand && /thousand\s+board\s+feet/i.test(match[0])) continue;
      facts.push({
        amount,
        unit,
        display: unit === "board_feet"
          ? `${formatMoney(amount)} board feet`
          : unit === "cords"
            ? `${formatMoney(amount)} cords`
            : unit === "medallions"
              ? `${formatMoney(amount)} medallions`
              : unit === "parcels"
                ? `${formatMoney(amount)} parcels`
                : unit === "acres"
                  ? `${formatMoney(amount)} acres`
                  : `${formatMoney(amount)} ${unit}`,
        source: "notice_body",
        confidence: "high",
        evidence: evidence(match[0]),
      });
    }
  }
  return uniqueBy(facts, (f) => `${f.unit}:${f.amount}`).slice(0, MAX_FACTS);
}

/**
 * Labeled price facts only — bare dollar amounts are not facts.
 * @param {string} text
 */
export function extractPriceFacts(text) {
  const facts = [];
  const body = String(text || "");

  const patterns = [
    {
      kind: "upset_price",
      // "Upset Price … $11,000,000" table rows and "minimum upset price … $850,000"
      re: /(?:minimum\s+)?upset\s+price[^$]{0,80}\$\s?([\d][\d,.]*)/gi,
    },
    {
      kind: "minimum_bid",
      re: /minimum\s+bid(?:\s+of)?[^$]{0,80}\$\s?([\d][\d,.]*)/gi,
    },
    {
      kind: "minimum_monthly_bid",
      re: /minimum\s+monthly\s+bid[^$]{0,80}\$\s?([\d][\d,.]*)/gi,
    },
    {
      kind: "minimum_annual_bid",
      re: /minimum\s+annual\s+bid[^$]{0,80}\$\s?([\d][\d,.]*)/gi,
    },
    {
      kind: "appraised",
      re: /apprais(?:ed|al)(?:\s+(?:value|at(?:\s+a\s+value)?))?(?:\s+of)?[^$]{0,80}\$\s?([\d][\d,.]*)/gi,
    },
    {
      kind: "assessed",
      re: /assessed(?:\s+(?:value|at))?(?:\s+of)?[^$]{0,80}\$\s?([\d][\d,.]*)/gi,
    },
  ];

  for (const { kind, re } of patterns) {
    for (const match of body.matchAll(re)) {
      const amount = parseMoneyToken(match[1]);
      if (amount == null) continue;
      facts.push({
        kind,
        amount,
        currency: "USD",
        display: `$${formatMoney(amount)}`,
        source: "notice_body",
        confidence: "high",
        evidence: evidence(match[0]),
      });
    }
  }

  // Nominal $1 conveyances (HPD-style) — labeled consideration only.
  const nominalRe = /(?:sold for|consideration of|nominal price of|purchase(?:d)?[^.]{0,40}for)\s+(?:one dollar|\$\s?1(?:\.00)?\b)/gi;
  for (const match of body.matchAll(nominalRe)) {
    facts.push({
      kind: "nominal",
      amount: 1,
      currency: "USD",
      display: "$1",
      source: "notice_body",
      confidence: "high",
      evidence: evidence(match[0]),
    });
  }

  // Table-style "Upset Price" column with nearby $ after borough/block lines
  // (already covered by upset_price pattern when "Upset Price" precedes $).

  return uniqueBy(facts, (f) => `${f.kind}:${f.amount}:${f.evidence}`).slice(0, MAX_FACTS);
}

/**
 * How the sale is conducted.
 * @param {string} text
 */
export function extractSaleMethod(text) {
  const t = String(text || "");
  const checks = [
    {
      method: "online_auction",
      re: /\b(?:online\s+(?:public\s+)?(?:lease\s+)?auction|posts?\s+(?:vehicle|heavy).{0,40}auctions?\s+online|govdeals\.com|iaai\.com)\b/i,
    },
    {
      method: "sealed_bid",
      re: /\bsealed\s+bid(?:s|ding)?\b/i,
    },
    {
      method: "lease_auction",
      re: /\b(?:lease\s+auction|public\s+lease\s+auction|leases?\s+at\s+public\s+auction)\b/i,
    },
    {
      method: "public_auction",
      re: /\bpublic\s+auction\b|\bauto\s+auction\b/i,
    },
    {
      method: "rfp",
      re: /\brequest for proposals?\b|\b\brfp\b\b/i,
    },
  ];
  for (const { method, re } of checks) {
    const match = re.exec(t);
    if (match) {
      return {
        method,
        source: "notice_body",
        confidence: "high",
        evidence: evidence(match[0]),
      };
    }
  }
  return null;
}

function extractUrls(text) {
  const urls = [];
  const re = /https?:\/\/[^\s<>"')\]]+/gi;
  for (const match of String(text || "").matchAll(re)) {
    let url = match[0].replace(/[.,;:]+$/, "");
    // Repair common City Record split: iaai.com/ search?keyword=
    url = url.replace(/\.com\/\s+/i, ".com/");
    try {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      urls.push({
        url: u.toString(),
        source: "notice_body",
        confidence: "high",
        evidence: evidence(match[0].slice(0, 120)),
      });
    } catch {
      /* skip */
    }
  }
  return uniqueBy(urls, (u) => u.url.toLowerCase()).slice(0, 8);
}

function extractEmails(text) {
  return uniqueBy(
    Array.from(String(text || "").matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi)).map((m) => ({
      value: m[0],
      source: "notice_body",
      confidence: "high",
      evidence: evidence(m[0]),
    })),
    (e) => e.value.toLowerCase(),
  ).slice(0, 6);
}

function extractPhones(text) {
  return uniqueBy(
    Array.from(String(text || "").matchAll(/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/g)).map((m) => ({
      value: m[0],
      source: "notice_body",
      confidence: "medium",
      evidence: evidence(m[0]),
    })),
    (e) => e.value.replace(/\D/g, ""),
  ).slice(0, 6);
}

/**
 * Participation / bid steps when the notice states them.
 * @param {string} text
 */
export function extractParticipation(text) {
  const body = String(text || "");
  const urls = extractUrls(body);
  const emails = extractEmails(body);
  const phones = extractPhones(body);

  const steps = [];
  const depositMatch = body.match(/\b(?:deposit|promo code)[^.]{0,120}/i);
  if (depositMatch) {
    steps.push({
      kind: "deposit_or_fee",
      text: evidence(depositMatch[0]),
      source: "notice_body",
      confidence: "medium",
      evidence: evidence(depositMatch[0]),
    });
  }
  const showMatch = body.match(/\b(?:show dates?|public showings?|prospective bidders are (?:required|encouraged) to attend)[^.]{0,200}/i);
  if (showMatch) {
    steps.push({
      kind: "show_or_inspection",
      text: evidence(showMatch[0]),
      source: "notice_body",
      confidence: "high",
      evidence: evidence(showMatch[0]),
    });
  }
  const bidDueMatch = body.match(/\b(?:all bid proposals must be received|bids? will be (?:accepted|received)|online bids will be accepted|no later than)[^.]{0,200}/i);
  if (bidDueMatch) {
    steps.push({
      kind: "bid_deadline",
      text: evidence(bidDueMatch[0]),
      source: "notice_body",
      confidence: "high",
      evidence: evidence(bidDueMatch[0]),
    });
  }
  const registerMatch = body.match(/\b(?:registration is free|register(?:ing)?|open to the public)[^.]{0,120}/i);
  if (registerMatch) {
    steps.push({
      kind: "registration",
      text: evidence(registerMatch[0]),
      source: "notice_body",
      confidence: "high",
      evidence: evidence(registerMatch[0]),
    });
  }

  // Prefer marketplace URLs for surplus auctions.
  const packageUrl = (() => {
    const prefer = urls.find((u) => /govdeals\.com|iaai\.com|nyc\.gov\/auctions|publicsurplus/i.test(u.url));
    return prefer?.url || urls[0]?.url || null;
  })();

  return {
    package_url: packageUrl,
    urls,
    emails,
    phones,
    steps: steps.slice(0, MAX_FACTS),
    has_fields: !!(packageUrl || emails.length || phones.length || steps.length),
  };
}

/**
 * Honest deal signal: only when the notice states BOTH a floor bid and a stated value.
 * Market-basket / external comps are never invented — comparables_slot is the future hook.
 *
 * @param {object[]} priceFacts
 */
export function deriveDealSignal(priceFacts) {
  const facts = Array.isArray(priceFacts) ? priceFacts : [];
  const floors = facts.filter((f) => f.kind === "minimum_bid" || f.kind === "upset_price");
  const values = facts.filter((f) => f.kind === "appraised" || f.kind === "assessed");

  const comparables_slot = {
    status: "not_yet_acquired",
    category: null,
    source: null,
    note: "External market-basket comparables are not wired. Interface reserved for a category + comparables source.",
  };

  if (!floors.length || !values.length) {
    return {
      status: "insufficient",
      ratio: null,
      pct_of_value: null,
      floor: floors[0] || null,
      value: values[0] || null,
      summary: null,
      method: "stated_value_discount",
      comparables_slot,
    };
  }

  // Prefer the primary (first/highest-confidence) pair; take max value and min floor when multiple.
  const floor = floors.reduce((a, b) => (a.amount <= b.amount ? a : b));
  const value = values.reduce((a, b) => (a.amount >= b.amount ? a : b));
  if (!value.amount || value.amount <= 0) {
    return {
      status: "insufficient",
      ratio: null,
      pct_of_value: null,
      floor,
      value,
      summary: null,
      method: "stated_value_discount",
      comparables_slot,
    };
  }

  const ratio = floor.amount / value.amount;
  const pct = Math.round(ratio * 1000) / 10; // one decimal
  const summary = `Minimum bid is ${pct}% of stated ${value.kind === "assessed" ? "assessed" : "appraised"} value`;

  return {
    status: "derived",
    ratio,
    pct_of_value: pct,
    floor,
    value,
    summary,
    method: "stated_value_discount",
    evidence: evidence(`${floor.evidence} · ${value.evidence}`),
    confidence: "high",
    comparables_slot: {
      ...comparables_slot,
      category: null, // filled by caller when category known
    },
  };
}

/**
 * Primary list price for glance scan (one figure, labeled).
 * @param {object[]} priceFacts
 */
export function primaryListPrice(priceFacts) {
  const facts = Array.isArray(priceFacts) ? priceFacts : [];
  const order = [
    "minimum_bid",
    "upset_price",
    "minimum_monthly_bid",
    "minimum_annual_bid",
    "appraised",
    "assessed",
    "nominal",
  ];
  for (const kind of order) {
    const hit = facts.find((f) => f.kind === kind);
    if (hit) return hit;
  }
  return null;
}

/**
 * Item label for glance: quantity-aware short phrase.
 */
export function commercialItemLabel(commercial) {
  if (!commercial) return null;
  const item = commercial.item || {};
  const qty = Array.isArray(commercial.quantities) ? commercial.quantities[0] : null;
  if (qty?.display && item.category === "timber") return qty.display;
  if (qty?.display && item.label) return `${item.label} · ${qty.display}`;
  if (item.label) return item.label;
  if (qty?.display) return qty.display;
  return null;
}

/**
 * Extract full commercial payload for one notice row.
 * @param {object} row - City Record / property-locations row
 * @param {{ attachments?: object[] }} [options]
 */
export function extractPropertyCommercial(row = {}, options = {}) {
  const body = noticeBody(row);
  const attach = attachmentText(options.attachments);
  const text = [body, attach].filter(Boolean).join(" \n ");

  if (!text.trim()) {
    return emptyCommercial(row);
  }

  const disposition_class = classifyDispositionSaleClass(text);
  const categoryInfo = classifyCommercialCategory(text);
  // Attachment titles that name item lists / volume reports boost item detail.
  let itemLabel = categoryInfo.label;
  let itemEvidence = categoryInfo.evidence;
  let itemConfidence = categoryInfo.confidence;
  if (attach) {
    const volume = attach.match(/.{0,20}(?:volume report|item list|inventory|description,\s*maps).{0,80}/i);
    if (volume) {
      itemLabel = itemLabel
        ? `${itemLabel} (see attachment inventory)`
        : evidence(volume[0]);
      itemEvidence = evidence(volume[0]);
      itemConfidence = "high";
    }
  }

  const quantities = extractQuantities(text);
  const price_facts = extractPriceFacts(text);
  const sale_method = extractSaleMethod(text);
  const participation = extractParticipation(text);
  const deal_signal = deriveDealSignal(price_facts);
  if (deal_signal.comparables_slot) {
    deal_signal.comparables_slot.category = categoryInfo.category;
  }

  const primary = primaryListPrice(price_facts);
  const close_date = isoDate(row.event_date) || isoDate(row.end_date) || isoDate(row.start_date);

  const commercial = {
    schema: PROPERTY_COMMERCIAL_SCHEMA,
    request_id: row.request_id ? String(row.request_id) : null,
    disposition_class,
    item: {
      category: categoryInfo.category,
      label: itemLabel,
      confidence: itemConfidence,
      evidence: itemEvidence,
      source: attach && itemEvidence && attach.includes(String(itemEvidence).replace(/^…/, "").slice(0, 20))
        ? "attachment_metadata"
        : "notice_body",
    },
    quantities,
    price_facts,
    primary_price: primary,
    sale_method,
    participation,
    deal_signal,
    close_date,
    glance: {
      item: commercialItemLabel({
        item: { category: categoryInfo.category, label: itemLabel },
        quantities,
      }) || categoryLabelFallback(categoryInfo.category),
      price: primary
        ? {
            kind: primary.kind,
            display: primary.display,
            amount: primary.amount,
          }
        : null,
      close_date,
      deal: deal_signal.status === "derived" ? deal_signal.summary : null,
      sale_method: sale_method?.method || null,
    },
  };
  commercial.sale_eligible = hasCommercialSaleSignals(commercial);
  return commercial;
}

function categoryLabelFallback(category) {
  const map = {
    vehicle: "Vehicles",
    timber: "Timber",
    equipment: "Equipment",
    real_property: "Real property",
    scrap_materials: "Scrap / materials",
    other: "Other",
  };
  return map[category] || "Other";
}

function isoDate(value) {
  if (!value) return null;
  const s = String(value);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

function emptyCommercial(row = {}) {
  const text = noticeBody(row);
  const disposition_class = text ? classifyDispositionSaleClass(text) : "unknown";
  const commercial = {
    schema: PROPERTY_COMMERCIAL_SCHEMA,
    request_id: row.request_id ? String(row.request_id) : null,
    disposition_class,
    item: {
      category: "other",
      label: null,
      confidence: "low",
      evidence: null,
      source: "notice_body",
    },
    quantities: [],
    price_facts: [],
    primary_price: null,
    sale_method: null,
    participation: {
      package_url: null,
      urls: [],
      emails: [],
      phones: [],
      steps: [],
      has_fields: false,
    },
    deal_signal: {
      status: "insufficient",
      ratio: null,
      pct_of_value: null,
      floor: null,
      value: null,
      summary: null,
      method: "stated_value_discount",
      comparables_slot: {
        status: "not_yet_acquired",
        category: "other",
        source: null,
        note: "External market-basket comparables are not wired. Interface reserved for a category + comparables source.",
      },
    },
    close_date: isoDate(row.event_date) || isoDate(row.end_date) || isoDate(row.start_date),
    glance: {
      item: "Other",
      price: null,
      close_date: isoDate(row.event_date) || isoDate(row.end_date) || isoDate(row.start_date),
      deal: null,
      sale_method: null,
    },
  };
  commercial.sale_eligible = hasCommercialSaleSignals(commercial);
  return commercial;
}

/**
 * Stamp commercial payload onto each property row (materialization).
 * @param {object} view - property locations view
 * @param {{ attachmentsByRequestId?: Map|object }} [options]
 */
export function attachPropertyCommercial(view, options = {}) {
  if (!view || typeof view !== "object") return view;
  const bag = options.attachmentsByRequestId || {};
  const getAttach = (id) => {
    if (!id) return [];
    if (bag instanceof Map) return bag.get(String(id)) || [];
    return bag[String(id)] || bag[id] || [];
  };
  const properties = Array.isArray(view.properties)
    ? view.properties.map((row) => {
      const commercial = extractPropertyCommercial(row, {
        attachments: getAttach(row?.request_id),
      });
      return { ...row, commercial };
    })
    : [];

  const withPrice = properties.filter((r) => r.commercial?.primary_price).length;
  const withDeal = properties.filter((r) => r.commercial?.deal_signal?.status === "derived").length;
  const saleEligible = properties.filter((r) => r.commercial?.sale_eligible).length;
  const byCategory = Object.fromEntries(COMMERCIAL_CATEGORIES.map((c) => [c, 0]));
  const byDispositionClass = {
    sale: 0,
    destruction: 0,
    transfer: 0,
    abandonment: 0,
    unknown: 0,
  };
  for (const row of properties) {
    const c = row.commercial?.item?.category;
    if (c && byCategory[c] != null) byCategory[c] += 1;
    const dc = row.commercial?.disposition_class || "unknown";
    if (byDispositionClass[dc] != null) byDispositionClass[dc] += 1;
    else byDispositionClass.unknown += 1;
  }

  return {
    ...view,
    properties,
    commercial_metrics: {
      metric: "property_commercial_price_coverage",
      price_fact_rate: properties.length ? withPrice / properties.length : 0,
      deal_signal_rate: properties.length ? withDeal / properties.length : 0,
      sale_eligible_rate: properties.length ? saleEligible / properties.length : 0,
      by_category: byCategory,
      by_disposition_class: byDispositionClass,
      n: properties.length,
    },
  };
}

/**
 * Measure disposition sale-class split over a notice corpus (title + body text).
 * Used for corpus audit receipts; pure, no network.
 *
 * @param {Array<object>} rows - notice-like rows with short_title / description fields
 * @returns {{ n: number, by_class: Record<string, number>, sale_eligible: number, non_sale: number }}
 */
export function measureDispositionSaleClassSplit(rows = []) {
  const by_class = {
    sale: 0,
    destruction: 0,
    transfer: 0,
    abandonment: 0,
    unknown: 0,
  };
  let sale_eligible = 0;
  let non_sale = 0;
  for (const row of rows) {
    const commercial = extractPropertyCommercial(row);
    const dc = commercial.disposition_class || "unknown";
    if (by_class[dc] != null) by_class[dc] += 1;
    else by_class.unknown += 1;
    if (commercial.sale_eligible) sale_eligible += 1;
    if (NON_SALE_DISPOSITION_CLASSES.includes(dc)) non_sale += 1;
  }
  return {
    n: rows.length,
    by_class,
    sale_eligible,
    non_sale,
    sale_eligible_rate: rows.length ? sale_eligible / rows.length : 0,
    non_sale_rate: rows.length ? non_sale / rows.length : 0,
  };
}

/**
 * i18n key for a commercial category (list chips + badges).
 */
export function commercialCategoryI18nKey(category) {
  const map = {
    vehicle: "asset_vehicle",
    timber: "asset_timber",
    equipment: "asset_equipment",
    real_property: "asset_real_property",
    scrap_materials: "asset_scrap_materials",
    other: "asset_other",
  };
  return map[category] || "asset_other";
}

/**
 * i18n key for a price kind badge.
 */
export function priceKindI18nKey(kind) {
  const map = {
    minimum_bid: "badge_min_bid",
    upset_price: "badge_upset_price",
    appraised: "badge_appraised",
    assessed: "badge_assessed",
    nominal: "badge_nominal",
    minimum_monthly_bid: "badge_min_monthly_bid",
    minimum_annual_bid: "badge_min_annual_bid",
  };
  return map[kind] || null;
}
