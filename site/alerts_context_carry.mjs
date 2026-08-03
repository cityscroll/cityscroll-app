/**
 * Context-carrying alert entry (hash params + natural scope).
 *
 * Pure helpers so notice/lens "Watch" and header "Want email updates?" CTAs
 * land on #alerts pre-scoped the same way back-navigation carries referrer
 * context — no parallel machinery.
 *
 * Hash shape (extends the existing saved-search health fix path):
 *   #alerts?lens=<lens>&filter=<json>&freq=<daily|weekly>&notice=<id>&project=<id>
 *
 * - lens + filter: standing watch scope (worker compileSub / prefillAlertFromLink)
 * - notice / project: seed for the real digItemHTML email-template preview
 */

export const SECTION_TO_LENS = Object.freeze({
  Procurement: "money",
  "Public Hearings and Meetings": "meetings",
  "Agency Rules": "rules",
  "Property Disposition": "property",
  "Changes in Personnel": "entity",
});

export const CONTENT_LENSES = Object.freeze([
  "money", "land", "property", "rules", "meetings", "entity", "award",
]);

/** Dig-preview kind for digItemHTML / digest_item_awareness. */
export function digKindForNotice(row) {
  if (!row || typeof row !== "object") return "notice";
  const section = String(row.section_name || "");
  const type = String(row.type_of_notice_description || "");
  if (section === "Agency Rules") return "rules";
  if (section === "Property Disposition") return "property";
  if (
    section === "Public Hearings and Meetings"
    || /hearing|meeting/i.test(type)
  ) return "meetings";
  if (type === "Solicitation") return "rfp";
  if (/Award|Intent to Negotiate|Vendor List/i.test(type)) return "award";
  return "notice";
}

function cleanAgency(value) {
  const s = String(value || "").trim();
  return s || null;
}

function cleanId(value) {
  const s = String(value || "").trim();
  return /^[A-Za-z0-9_-]{4,40}$/.test(s) ? s : null;
}

function keywordBits(text, maxWords = 3) {
  const raw = String(text || "")
    .replace(/(rezoning|demapping|rezone|special permit|special district|text amendment|mapping actions?|modification|disposition|non-?ulurp|public hearing).*/i, "")
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .trim();
  if (!raw) return [];
  const words = raw.split(/\s+/).filter(Boolean).slice(0, maxWords);
  return words.length ? [words.join(" ").toLowerCase()] : [];
}

/**
 * Natural standing-watch scope for a City Record notice row (or action-matter shape).
 * @returns {{ lens: string, filter: object, digKind: string, noticeId: string|null, projectId: string|null }}
 */
export function alertScopeFromNotice(row) {
  const r = row || {};
  const section = String(r.section_name || "");
  const type = String(r.type_of_notice_description || "");
  const kind = String(r.kind || "").toLowerCase();
  const agency = cleanAgency(r.agency_name);
  const noticeId = cleanId(r.request_id);
  const projectId = cleanId(r.project_id) || null;

  // Zoning / land project matter (action rail on #ldetail).
  if (kind === "zoning" || projectId) {
    const place = keywordBits(r.project_name || r.title || r.borough || "");
    return {
      lens: "land",
      filter: {
        keywords: place,
        status: "all",
        ...(r.borough ? { boro: r.borough } : {}),
      },
      digKind: "rezone",
      noticeId,
      projectId,
    };
  }

  let lens = SECTION_TO_LENS[section] || null;
  if (!lens) {
    if (kind === "hearing") lens = "meetings";
    else if (kind === "rule") lens = "rules";
    else if (kind === "property" || kind === "franchise") lens = kind === "property" ? "property" : "meetings";
    else if (kind === "solicitation" || kind === "award") lens = "money";
    else if (kind === "notice") lens = "money";
    else lens = "money";
  }

  if (lens === "entity") {
    return {
      lens: "entity",
      filter: { kind: "agency", name: agency },
      digKind: digKindForNotice(r),
      noticeId,
      projectId: null,
    };
  }

  if (lens === "money") {
    const filter = { keywords: [], agency };
    if (type === "Solicitation" || kind === "solicitation") filter.noticeType = "solicitation";
    else if (/Award/i.test(type) || kind === "award") filter.noticeType = "award";
    return {
      lens: "money",
      filter,
      digKind: digKindForNotice(r),
      noticeId,
      projectId: null,
    };
  }

  if (lens === "meetings") {
    const filter = { keywords: [], agency };
    // Declarative geography only when the row already carries it (never invent).
    const boro = r.borough || r.boro || null;
    if (boro) filter.borough = boro;
    if (r.neighborhood) filter.neighborhood = String(r.neighborhood).trim().slice(0, 80);
    if (r.locationScope === "citywide-unlocated") filter.locationScope = "citywide-unlocated";
    return {
      lens: "meetings",
      filter,
      digKind: "meetings",
      noticeId,
      projectId: null,
    };
  }

  if (lens === "land") {
    return {
      lens: "land",
      filter: { keywords: keywordBits(r.short_title || r.title || ""), status: "all" },
      digKind: "rezone",
      noticeId,
      projectId,
    };
  }

  // property: prefer commercial organize fields when stamped on the notice.
  if (lens === "property") {
    const filter = { keywords: [], agency };
    const commercial = r.commercial || null;
    const category = commercial?.item?.category || null;
    if (category && category !== "other") filter.asset = category;
    const method = commercial?.sale_method?.method || commercial?.glance?.sale_method || null;
    if (method) filter.saleMethod = method;
    const boro = r.borough || r.boro || (r._location?.boroughs && r._location.boroughs[0]) || null;
    if (boro) filter.borough = boro;
    return {
      lens: "property",
      filter,
      digKind: "property",
      noticeId,
      projectId: null,
    };
  }

  // rules (and similar section watches)
  return {
    lens,
    filter: { keywords: [], agency },
    digKind: digKindForNotice(r),
    noticeId,
    projectId: null,
  };
}

/**
 * Scope from a land / ZAP project row (list or detail).
 */
export function alertScopeFromLandProject(row) {
  const r = row || {};
  const projectId = cleanId(r.project_id);
  const place = keywordBits(r.project_name || r.borough || "");
  return {
    lens: "land",
    filter: {
      keywords: place,
      status: "all",
      ...(r.borough ? { boro: r.borough } : {}),
    },
    digKind: "rezone",
    noticeId: null,
    projectId,
  };
}

/**
 * Scope from an active lens list filter state (header CTA on list views).
 * @param {string} lens money|land|property|rules|meetings
 * @param {object} state field bag from the open tab
 */
export function alertScopeFromLensState(lens, state) {
  const s = state || {};
  const L = String(lens || "").toLowerCase();
  if (L === "money") {
    const filter = {
      keywords: s.keywords || (s.q ? [String(s.q).toLowerCase().trim()].filter(Boolean) : []),
      agency: cleanAgency(s.agency),
    };
    if (s.minAmount != null && Number(s.minAmount) >= 1000) filter.minAmount = Number(s.minAmount);
    if (s.noticeType === "award" || s.noticeType === "solicitation") filter.noticeType = s.noticeType;
    if (s.mode === "award" && !filter.noticeType) filter.noticeType = "award";
    return { lens: "money", filter, digKind: filter.noticeType === "award" ? "award" : "rfp", noticeId: null, projectId: null };
  }
  if (L === "land") {
    const kw = s.keywords || (s.q ? [String(s.q).toLowerCase().trim()].filter(Boolean) : []);
    return {
      lens: "land",
      filter: {
        keywords: kw,
        status: s.status === "all" ? "all" : "active",
        ...(s.boro ? { boro: s.boro } : {}),
      },
      digKind: "rezone",
      noticeId: null,
      projectId: null,
    };
  }
  if (L === "meetings") {
    const filter = {
      keywords: s.keywords || (s.q ? [String(s.q).toLowerCase().trim()].filter(Boolean) : []),
      agency: cleanAgency(s.agency),
    };
    if (s.borough) filter.borough = s.borough;
    if (s.neighborhood) filter.neighborhood = s.neighborhood;
    if (s.locationScope === "citywide-unlocated") filter.locationScope = "citywide-unlocated";
    if (s.dateWindow || s.when) {
      filter.dateWindow = s.dateWindow || s.when;
      filter.when = s.when || s.dateWindow;
    }
    return { lens: "meetings", filter, digKind: "meetings", noticeId: null, projectId: null };
  }
  if (L === "property") {
    const filter = {
      keywords: s.keywords || (s.q ? [String(s.q).toLowerCase().trim()].filter(Boolean) : []),
      agency: cleanAgency(s.agency),
    };
    // Commercial organize fields (asset / method / price / sort / stage / place).
    const asset = s.asset && s.asset !== "all" ? String(s.asset) : null;
    if (asset) filter.asset = asset;
    const saleMethod = (s.saleMethod || s.method) && (s.saleMethod || s.method) !== "all"
      ? String(s.saleMethod || s.method)
      : null;
    if (saleMethod) filter.saleMethod = saleMethod;
    const priceBand = (s.priceBand || s.price) && (s.priceBand || s.price) !== "all"
      ? String(s.priceBand || s.price)
      : null;
    if (priceBand) filter.priceBand = priceBand;
    if (s.sort && s.sort !== "closing_soon") filter.sort = String(s.sort);
    if (s.process && s.process !== "all") filter.process = String(s.process);
    if (s.stage && s.stage !== "all") filter.stage = String(s.stage);
    if (s.borough) filter.borough = s.borough;
    if (s.neighborhood) filter.neighborhood = String(s.neighborhood).trim().slice(0, 80);
    return {
      lens: "property",
      filter,
      digKind: "property",
      noticeId: null,
      projectId: null,
    };
  }
  if (L === "rules") {
    return {
      lens: "rules",
      filter: {
        keywords: s.keywords || (s.q ? [String(s.q).toLowerCase().trim()].filter(Boolean) : []),
        agency: cleanAgency(s.agency),
      },
      digKind: "rules",
      noticeId: null,
      projectId: null,
    };
  }
  return null;
}

/**
 * Build #alerts?... hash from a scope object. Omits empty filter keys.
 * Neutral / empty scope → bare #alerts.
 */
export function alertsHref(scope, opts) {
  const o = opts || {};
  if (!scope || !scope.lens) return "#alerts";
  const lens = String(scope.lens);
  if (!CONTENT_LENSES.includes(lens) && lens !== "people") {
    // Fail soft: only known product lenses get prefilled params.
    if (!SECTION_TO_LENS[lens] && !["money", "land", "entity", "award"].includes(lens)) {
      return "#alerts";
    }
  }
  const filter = compactFilter(scope.filter || {});
  const params = new URLSearchParams();
  params.set("lens", lens);
  params.set("filter", JSON.stringify(filter));
  const freq = o.freq || scope.freq;
  if (freq === "weekly" || freq === "daily") params.set("freq", freq);
  const noticeId = cleanId(o.noticeId || scope.noticeId);
  if (noticeId) params.set("notice", noticeId);
  const projectId = cleanId(o.projectId || scope.projectId);
  if (projectId) params.set("project", projectId);
  return `#alerts?${params.toString()}`;
}

function compactFilter(filter) {
  const out = {};
  for (const [k, v] of Object.entries(filter || {})) {
    if (v == null || v === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Parse alerts entry params from a hash or querystring (after ?).
 * @param {string} hashOrQuery e.g. "#alerts?lens=meetings&filter=..." or "lens=..."
 */
export function parseAlertsEntryParams(hashOrQuery) {
  let qs = String(hashOrQuery || "");
  if (qs.startsWith("#")) qs = qs.slice(1);
  const qi = qs.indexOf("?");
  if (qi >= 0) qs = qs.slice(qi + 1);
  else if (qs.startsWith("alerts")) return { lens: null, filter: {}, freq: null, noticeId: null, projectId: null };
  const q = new URLSearchParams(qs);
  let filter = {};
  try { filter = JSON.parse(q.get("filter") || "{}") || {}; } catch (_e) { filter = {}; }
  if (typeof filter !== "object" || Array.isArray(filter)) filter = {};
  return {
    lens: q.get("lens") || null,
    filter,
    freq: q.get("freq") || null,
    noticeId: cleanId(q.get("notice")),
    projectId: cleanId(q.get("project")),
  };
}

/**
 * Plain-language scope label keys (resolved by caller with t()).
 * Returns a descriptor object, not localized strings — keeps this module pure.
 */
export function alertScopeDescriptor(scope, seed) {
  const s = scope || {};
  const filter = s.filter || {};
  const lens = s.lens || "money";
  const agency = filter.agency || filter.name || null;
  const keywords = Array.isArray(filter.keywords) ? filter.keywords.filter(Boolean) : [];
  const place = keywords[0] || filter.boro || filter.borough || null;
  const seedTitle = seed && (seed.short_title || seed.project_name || seed.title) || null;
  return {
    lens,
    agency,
    keywords,
    place,
    noticeType: filter.noticeType || null,
    asset: filter.asset || null,
    saleMethod: filter.saleMethod || null,
    priceBand: filter.priceBand || null,
    seedTitle: seedTitle ? String(seedTitle).trim().slice(0, 160) : null,
    digKind: s.digKind || (seed ? digKindForNotice(seed) : null),
  };
}

/**
 * Whether a hash is a prefilled alerts entry (not bare #alerts / rollup-only).
 */
export function isContextAlertsHash(hash) {
  const p = parseAlertsEntryParams(hash);
  return !!(p.lens || p.noticeId || p.projectId);
}
