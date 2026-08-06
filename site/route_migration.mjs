import { entityHref, entityRouteRef } from "./entity_pivot.mjs";

export const CANONICAL_ORIGIN = "https://cityscroll.org";

export const SELECTABLE_LANGS = Object.freeze([
  "en", "es", "zh-Hans", "ru", "bn", "ht", "ko", "fr", "pl", "ar", "ur",
]);

export const LEGACY_LENS_FACETS = Object.freeze({
  money: "contracts",
  people: "staffing",
  staffing: "staffing",
  land: "zoning",
  property: "property",
  rules: "rules",
  meetings: "meetings",
});

const COMMON_FILTERS = [
  "agency", "q", "boro", "cd", "council", "neighborhood", "scope", "when",
  "months", "action", "facet",
];

/** Normalize the legacy human-readable agency query into the typed scope facet.
 *
 * Browse documents accept both forms, but publish one address-bar representation.
 */
export function canonicalizeBrowseUrl(value, { origin = CANONICAL_ORIGIN } = {}) {
  const url = safeUrl(value, origin);
  const match = url.pathname.match(/^\/browse\/(contracts|staffing|zoning|property|rules|meetings)\/?$/);
  if (!match) return `${url.pathname}${url.search}`;
  const agency = String(url.searchParams.get("agency") || "").trim();
  if (!agency) return `${url.pathname}${url.search}`;
  const facet = url.searchParams.get("facet");
  let values = {};
  if (facet && facet.length <= 2000) {
    try {
      const parsed = JSON.parse(facet);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) values = { ...parsed };
    } catch {}
  }
  const ref = entityRouteRef("agency", agency);
  if (ref) {
    const refs = Array.isArray(values.entity_refs_all) ? values.entity_refs_all : [];
    values.entity_refs_all = [...new Set([ref, ...refs])];
    url.searchParams.delete("agency");
    url.searchParams.set("facet", JSON.stringify(values));
  }
  return `${url.pathname}${url.search}`;
}

export const LEGACY_ROUTE_PARAMETERS = Object.freeze({
  money: new Set([...COMMON_FILTERS, "mode", "sort", "min", "max", "category", "standard", "closing", "m", "basis", "actionBasis"]),
  people: new Set([...COMMON_FILTERS, "type", "mode", "role", "view", "interest", "eligibility", "window", "format", "salary", "fee", "experience"]),
  staffing: new Set([...COMMON_FILTERS, "type", "mode", "role", "view", "interest", "eligibility", "window", "format", "salary", "fee", "experience"]),
  land: new Set([...COMMON_FILTERS, "status", "attendance"]),
  property: new Set([...COMMON_FILTERS, "asset", "method", "price", "sort", "process", "stage", "view"]),
  rules: new Set([...COMMON_FILTERS, "process"]),
  meetings: new Set([...COMMON_FILTERS, "process", "group"]),
  now: new Set(["lens", ...COMMON_FILTERS]),
  map: new Set(["level", "id", "parent", "lens", "basis", ...COMMON_FILTERS]),
  alerts: new Set(["lens", "view", "from", "notice", ...COMMON_FILTERS]),
});

const NOTICE_PARAMETERS = new Set(["w", "focus"]);

function safeUrl(value, origin) {
  const raw = String(value || "").trim();
  if (!raw) return new URL("/", origin);
  if (/^https?:\/\//i.test(raw)) return new URL(raw);
  if (raw.startsWith("#")) return new URL(`/${raw}`, origin);
  return new URL(raw.startsWith("/") ? raw : `/${raw}`, origin);
}

function safeLanguage(value) {
  return SELECTABLE_LANGS.includes(value) ? value : null;
}

function splitFragment(fragment) {
  const raw = String(fragment || "").replace(/^#/, "");
  const queryAt = raw.indexOf("?");
  return {
    route: queryAt < 0 ? raw : raw.slice(0, queryAt),
    params: new URLSearchParams(queryAt < 0 ? "" : raw.slice(queryAt + 1)),
  };
}

function targetUrl(path, sourceUrl, fragmentParams, allowed) {
  const params = new URLSearchParams();
  const language = safeLanguage(fragmentParams.get("lang")) || safeLanguage(sourceUrl.searchParams.get("lang"));
  if (language && language !== "en") params.set("lang", language);

  const unsupported = [];
  for (const [key, value] of fragmentParams) {
    if (key === "lang") continue;
    if (allowed.has(key)) params.append(key, value);
    else unsupported.push(key);
  }
  if (unsupported.length) params.set("legacy", "unsupported-filter");
  const query = params.toString();
  return {
    target: `${path}${query ? `?${query}` : ""}`,
    unsupported: [...new Set(unsupported)].sort(),
  };
}

function retained(url, reason = "This route is outside the Increment 5 cutover.") {
  return {
    linkClass: "retained legacy route",
    target: `${url.pathname === "/" ? "/" : url.pathname}${url.search}${url.hash}`,
    parameterRule: "Parameters and fragment remain unchanged.",
    forwardingBehavior: reason,
    migrated: false,
    unsupported: [],
  };
}

export function migrateLegacyUrl(value, { origin = CANONICAL_ORIGIN } = {}) {
  const url = safeUrl(value, origin);
  if (!url.hash) return retained(url, "Already a document route; no forwarding is required.");

  const { route, params } = splitFragment(url.hash);

  const entity = route.match(/^(agency|vendor|official)\/(.+)$/);
  if (entity) {
    let value = "";
    try { value = decodeURIComponent(entity[2]); } catch { value = ""; }
    const ref = entityRouteRef(entity[1], value);
    const target = ref ? entityHref({ ref, label: value }, {
      tab: params.get("tab"),
      eventId: params.get("event"),
      noticeId: params.get("notice"),
    }) : "";
    if (target) {
      const targetUrl = new URL(target, origin);
      const language = safeLanguage(params.get("lang")) || safeLanguage(url.searchParams.get("lang"));
      if (language && language !== "en") targetUrl.searchParams.set("lang", language);
      return {
        linkClass: `${entity[1]} profile`,
        target: `${targetUrl.pathname}${targetUrl.search}`,
        parameterRule: "Resolve the entity identity handle, preserve supported profile context, and move a validated language into the document query.",
        forwardingBehavior: "The legacy root shim calls location.replace() with the canonical entity document URL.",
        migrated: true,
        unsupported: [],
      };
    }
  }

  const notice = route.match(/^notice\/([A-Za-z0-9_-]{1,80})$/);
  if (notice) {
    const mapped = targetUrl(`/notices/${encodeURIComponent(notice[1])}`, url, params, NOTICE_PARAMETERS);
    return {
      linkClass: safeLanguage(params.get("lang")) || safeLanguage(url.searchParams.get("lang"))
        ? "translated notice permalink" : "notice permalink",
      ...mapped,
      parameterRule: "Preserve a validated lang value plus bounded watch (w) and focus parameters; discard every other fragment parameter.",
      forwardingBehavior: "The legacy root shim calls location.replace() with the canonical notice document URL.",
      migrated: true,
    };
  }

  const exam = route.match(/^exam\/(\d{4})$/);
  if (exam) {
    const mapped = targetUrl(`/exams/${exam[1]}/`, url, params, new Set());
    return {
      linkClass: "exam permalink",
      ...mapped,
      parameterRule: "Preserve validated language only.",
      forwardingBehavior: "Forward to the canonical exam document.",
      migrated: true,
    };
  }

  if (Object.hasOwn(LEGACY_LENS_FACETS, route)) {
    const facet = LEGACY_LENS_FACETS[route];
    const mapped = targetUrl(`/browse/${facet}/`, url, params, LEGACY_ROUTE_PARAMETERS[route]);
    return {
      linkClass: "lens view",
      ...mapped,
      target: canonicalizeBrowseUrl(mapped.target),
      parameterRule: "Forward the lens allowlist byte-for-byte, move a validated lang value into the document query, and mark obsolete keys with legacy=unsupported-filter.",
      forwardingBehavior: "The legacy root shim calls location.replace(); obsolete filters open the disclosed Browse fallback.",
      migrated: true,
    };
  }

  const taskFirst = {
    now: ["/now/", "Now view"],
    map: ["/near-you/", "Near-you view"],
    alerts: ["/following/", "Following view"],
  }[route];
  if (taskFirst) {
    const mapped = targetUrl(taskFirst[0], url, params, LEGACY_ROUTE_PARAMETERS[route]);
    return {
      linkClass: "task-first view",
      ...mapped,
      parameterRule: "Forward supported scope and view parameters; preserve a validated lang value and disclose obsolete keys.",
      forwardingBehavior: `The legacy root shim calls location.replace() with the ${taskFirst[1]} document URL.`,
      migrated: true,
    };
  }

  return retained(url);
}

export function absoluteCityScrollUrl(value, origin = CANONICAL_ORIGIN) {
  return new URL(value, `${origin}/`).href;
}
