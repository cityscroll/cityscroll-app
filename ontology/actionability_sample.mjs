// Destination-class actionability sample for the intelligence flywheel.
//
// Counts ACTION_TYPES (or treating every registered type as "actionable") is
// vacuous: rate is always 1 when the enum is non-empty. Real actionability is
// whether the primary kinetic handoff is a deep item URL, not a search page,
// landing, or unavailable placeholder.
//
// Destination classes (ops-ontology audit):
//   deep           — URL resolves to the specific item/session
//   scoped_search  — pre-filled search results for an id/name
//   search_page    — generic search/list the reader must re-hunt
//   landing        — agency section home / registration guide
//   unavailable    — no outbound destination (honest dead-end)
//   local          — in-product action (watch / calendar), not an official handoff
//   unknown        — HTTPS URL that does not match a known pattern

export const DESTINATION_CLASSES = Object.freeze([
  "deep",
  "scoped_search",
  "search_page",
  "landing",
  "unavailable",
  "local",
  "unknown",
]);

/** Primary kinetic types that represent “what can I do next” official paths. */
export const KINETIC_ACTION_TYPES = Object.freeze([
  "official_application",
  "comment",
  "attend",
  "document",
  "rsvp",
  "bid_checklist",
  "contact",
]);

/** Classes that count as deep-link actionable for the named rate. */
export const DEEP_CLASSES = Object.freeze(["deep"]);

/**
 * Classify a single destination URL into a destination class.
 * @param {string|null|undefined} url
 * @param {{ guide?: object|null }} [hints]
 * @returns {typeof DESTINATION_CLASSES[number]}
 */
export function classifyDestinationUrl(url, hints = {}) {
  const raw = String(url || "").trim();
  if (!raw) return "unavailable";

  // In-product local targets (hash routes, same-origin relative) are not
  // official handoffs — classify before URL parsing (hash is not absolute).
  if (raw.startsWith("#") || (raw.startsWith("/") && !raw.startsWith("//"))) {
    return "local";
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return "unavailable";
  }
  if (parsed.protocol !== "https:") return "unavailable";

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname || "/";
  const search = parsed.search || "";
  const href = parsed.href;

  // Guide-aware: solicitation handoff modes already encode search vs named portal.
  const guide = hints.guide || null;
  if (guide && typeof guide === "object") {
    const mode = String(guide.mode || "");
    const system = String(guide.system || "");
    if (system === "passport" || mode === "search_only" || mode === "matched") {
      // Matched RFx with rfp_id uses process_manage_extranet (publisher deep path).
      if (
        host.includes("passport.cityofnewyork.us")
        && /process_manage_extranet\/\d+/i.test(path)
      ) {
        return "deep";
      }
      // Public browse remains a search recipe when no rfp_id is available.
      if (host.includes("passport")) return "search_page";
    }
    if (system === "nycha_isupplier") return "landing";
    if (system === "oasys") {
      return mode === "deep" ? "deep" : "landing";
    }
    if (system === "notice_portal" || mode === "notice_named") {
      // Allowlisted OpenGov/Bonfire/BidNet item URLs are deep when host evidence exists.
      if (
        host.includes("opengov.com")
        || host.includes("bonfirehub.com")
        || host.includes("bidnetdirect.com")
      ) {
        return "deep";
      }
    }
  }

  // City Record
  if (host.includes("a856-cityrecord.nyc.gov") || host.includes("cityrecord.nyc.gov")) {
    if (/\/RequestDetail\/[^/]+/i.test(path)) return "deep";
    if (/\/Search\/GetFile/i.test(path)) {
      if (/[?&]DocumentID=/i.test(search) && /[?&]RequestID=/i.test(search)) return "deep";
      if (/[?&]RequestID=/i.test(search)) return "scoped_search";
      return "search_page";
    }
    if (/\/Search\/Advanced/i.test(path)) return "search_page";
    return "landing";
  }

  // PASSPort: authenticated extranet item is deep; public browse is search-page.
  if (
    host.includes("passportpublic.nyc.gov")
    || host.includes("passport.cityofnewyork.us")
    || host.includes("passport.nyc.gov")
  ) {
    if (/process_manage_extranet\/\d+/i.test(path)) return "deep";
    return "search_page";
  }

  // Checkbook NYC
  if (host.includes("checkbooknyc.com")) {
    if (/\/nycha_contract_details\//i.test(path) && /\/contract\//i.test(path)) return "deep";
    if (/\/contract_details\/agid\/\d+/i.test(path)) return "deep";
    if (/\/smart_search\//i.test(path)) {
      return /[?&]search_term=/i.test(search) ? "scoped_search" : "search_page";
    }
    if (/contract_search|spending_search/i.test(path + search)) return "search_page";
    return "search_page";
  }

  // ZAP
  if (host.includes("zap.planning.nyc.gov") && /\/projects\/[^/]+/i.test(path)) return "deep";

  // Parcel tools
  if (host.includes("zola.planning.nyc.gov") && /\/l\/lot\//i.test(path)) return "deep";
  if (host.includes("a836-acris.nyc.gov") && /bbl/i.test(path + search)) return "deep";
  if (host.includes("whoownswhat.justfixnyc.org") && /\/bbl\//i.test(path)) return "deep";

  // NYC Rules
  if (host.includes("rules.cityofnewyork.us")) {
    if (path === "/" || path === "") return "landing";
    if (/\/rule\//i.test(path)) return "deep";
    return "deep";
  }

  // OASys: per-exam NOE page is deep; examsforjobs / OASys home / exams list are landings.
  if (
    host.includes("a856-exams.nyc.gov")
    || /examsforjobs/i.test(href)
    || (host.includes("nyc.gov") && /\/examsforjobs\/?$/i.test(path))
  ) {
    if (/\/noe$/i.test(path.replace(/\/+$/, "")) && /[?&]examId=\d+/i.test(search)) {
      return "deep";
    }
    if (/\/noe\/[^/]+\.pdf$/i.test(path)) return "deep";
    return "landing";
  }

  // NYCHA iSupplier registration guide
  if (/isupplier-vendor-registration/i.test(path) || /isupplier/i.test(path) && host.includes("nycha")) {
    return "landing";
  }

  // Notice-named procurement portals
  if (
    host.includes("opengov.com")
    || host.includes("bonfirehub.com")
    || host.includes("bidnetdirect.com")
  ) {
    if (/\/projects?\/|\/portal\//i.test(path)) return "deep";
    return "scoped_search";
  }

  // Meeting join
  if (
    host.includes("zoom.us")
    || host.includes("webex.com")
    || host.includes("teams.microsoft.com")
    || host.includes("gotomeeting.com")
  ) {
    return "deep";
  }

  // Legistar / Granicus InSite
  if (host.includes("legistar.com") || host.includes("nyc.legistar.com")) {
    if (/MatterDetail|LegislationDetail|MeetingDetail|Attachment/i.test(path + search)) {
      return "deep";
    }
    return "scoped_search";
  }

  // Open Data dataset catalog pages
  if (host.includes("data.cityofnewyork.us") && /\/d\/|\/dataset\//i.test(path)) {
    return "landing";
  }

  // Generic nyc.gov section pages without item id depth
  if (host.endsWith("nyc.gov") || host.endsWith("cityofnewyork.us")) {
    const segs = path.split("/").filter(Boolean);
    if (segs.length <= 2) return "landing";
    // Deeper paths with an id-like segment are treated as deep when present
    if (segs.some((s) => /\d{5,}|[0-9a-f]{8}-[0-9a-f-]{27}/i.test(s))) return "deep";
    return "landing";
  }

  // Non-empty path on other HTTPS hosts: unknown until cataloged
  if (path !== "/" && path !== "") return "unknown";
  return "landing";
}

/**
 * Classify a compiled action object (delivery + destination + optional guide).
 * @param {object|null|undefined} action
 * @returns {typeof DESTINATION_CLASSES[number]}
 */
export function classifyActionDestination(action) {
  if (!action || typeof action !== "object") return "unavailable";
  const delivery = String(action.delivery || "");
  if (delivery === "local") return "local";
  if (delivery === "unavailable") return "unavailable";
  return classifyDestinationUrl(action.destination, { guide: action.guide || null });
}

/**
 * Pick the primary kinetic action from a compiled rail (first non-local kinetic).
 * Falls back to the first action.
 */
export function primaryKineticAction(actions) {
  const list = Array.isArray(actions) ? actions : [];
  const kinetic = list.find(
    (a) => a
      && KINETIC_ACTION_TYPES.includes(a.type)
      && a.delivery !== "local",
  );
  return kinetic || list[0] || null;
}

function emptyByClass() {
  const out = {};
  for (const c of DESTINATION_CLASSES) out[c] = 0;
  return out;
}

/**
 * Measure deep-link actionability over a sample of notice matters + optional
 * static handoff URLs (lifecycle builders that never go through compileActionRail).
 *
 * @param {object} opts
 * @param {object[]} [opts.matters] — notice/matter rows for compileActionRail
 * @param {function} [opts.compileActionRail] — action rail compiler
 * @param {string} [opts.today]
 * @param {Array<{id?:string,url:string,guide?:object,label?:string}>} [opts.static_handoffs]
 * @returns {{
 *   sample_size: number,
 *   actionable: number,
 *   rate: number,
 *   by_class: Record<string, number>,
 *   deep: number,
 *   rows: object[],
 *   basis: string,
 * }}
 */
export function measureActionabilitySample(opts = {}) {
  const matters = Array.isArray(opts.matters) ? opts.matters : [];
  const staticHandoffs = Array.isArray(opts.static_handoffs) ? opts.static_handoffs : [];
  const today = String(opts.today || "2026-08-01").slice(0, 10);
  const compile = typeof opts.compileActionRail === "function"
    ? opts.compileActionRail
    : null;

  const by_class = emptyByClass();
  const rows = [];

  for (let i = 0; i < matters.length; i++) {
    const matter = matters[i] || {};
    const id = matter.sample_id || matter.id || matter.request_id || `matter-${i}`;
    if (!compile) {
      rows.push({
        id,
        kind: "matter",
        class: "unknown",
        reason: "compileActionRail_missing",
      });
      by_class.unknown += 1;
      continue;
    }
    let actions;
    try {
      actions = compile(matter, { today });
    } catch (err) {
      rows.push({
        id,
        kind: "matter",
        class: "unknown",
        reason: `compile_error:${err?.message || err}`,
      });
      by_class.unknown += 1;
      continue;
    }
    const primary = primaryKineticAction(actions);
    const destClass = classifyActionDestination(primary);
    by_class[destClass] = (by_class[destClass] || 0) + 1;
    rows.push({
      id,
      kind: "matter",
      matter_kind: matter.kind || null,
      action_type: primary?.type || null,
      delivery: primary?.delivery || null,
      destination: primary?.destination || null,
      guide_system: primary?.guide?.system || null,
      guide_mode: primary?.guide?.mode || null,
      class: destClass,
    });
  }

  for (let i = 0; i < staticHandoffs.length; i++) {
    const handoff = staticHandoffs[i] || {};
    const id = handoff.id || handoff.label || `static-${i}`;
    const destClass = classifyDestinationUrl(handoff.url, { guide: handoff.guide || null });
    by_class[destClass] = (by_class[destClass] || 0) + 1;
    rows.push({
      id,
      kind: "static_handoff",
      label: handoff.label || null,
      destination: handoff.url || null,
      class: destClass,
    });
  }

  const sample_size = rows.length;
  const deep = DEEP_CLASSES.reduce((n, c) => n + (by_class[c] || 0), 0);
  const rate = sample_size > 0 ? Number((deep / sample_size).toFixed(4)) : 0;

  return {
    sample_size,
    actionable: deep,
    deep,
    rate,
    by_class,
    rows,
    basis:
      "Primary kinetic handoff per sample matter (compileActionRail) plus static lifecycle "
      + "handoff URLs, scored by destination class. rate = deep / sample_size. "
      + "ACTION_TYPES enum length is not a valid actionability sample.",
  };
}

/**
 * Build the flywheel `actionability` input object from a measured sample.
 */
export function actionabilityInputFromSample(sample) {
  const measured = sample || measureActionabilitySample({});
  return {
    sample_size: measured.sample_size,
    actionable: measured.actionable,
    rate: measured.rate,
    deep: measured.deep,
    by_class: measured.by_class,
    basis: measured.basis,
    // Compact evidence for cards (ids of non-deep kinetic rows)
    non_deep: (measured.rows || [])
      .filter((r) => r.class && !DEEP_CLASSES.includes(r.class))
      .map((r) => ({ id: r.id, class: r.class, destination: r.destination || null })),
  };
}
