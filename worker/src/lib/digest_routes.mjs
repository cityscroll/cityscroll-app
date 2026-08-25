// The route contract shared by digest link composition and the /r resolver.
// Keep the redirect target fixed to cityscroll.org; ids are data, never URLs.

const CONTROL_OR_WHITESPACE = /[\s\x00-\x1f\x7f]/;
const CITY_RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,39}$/;
const MEETING_ID = /^meeting:[^\s\x00-\x1f\x7f]+$/;

const CITY_RECORD_SHAPE = Object.freeze({
  name: "city-record-id",
  maxLength: 40,
});

const MEETING_SHAPE = Object.freeze({
  name: "city-record-or-composite-meeting-id",
  maxLength: 2048,
});

const noticeRoute = Object.freeze({
  permalinkPathPrefix: "/notices/",
  idShape: CITY_RECORD_SHAPE,
});

// These are the redirect kinds emitted by the digest or retained for existing /r links.
// A new digest redirect kind must be added here before the link builder will accept it.
export const DIGEST_ROUTE_CONTRACT = Object.freeze({
  rfp: noticeRoute,
  award: noticeRoute,
  rules: noticeRoute,
  money: noticeRoute,
  property: noticeRoute,
  entity: noticeRoute,
  meetings: Object.freeze({
    permalinkPathPrefix: "/meetings/",
    idShape: MEETING_SHAPE,
  }),
});

export const DIGEST_ROUTE_KINDS = Object.freeze(Object.keys(DIGEST_ROUTE_CONTRACT));

function routeFor(kind, contract = DIGEST_ROUTE_CONTRACT) {
  return typeof kind === "string" ? contract[kind] || null : null;
}

function idMatchesShape(id, shape) {
  if (typeof id !== "string" || !id || id.length > shape.maxLength || CONTROL_OR_WHITESPACE.test(id)) {
    return false;
  }
  if (shape === CITY_RECORD_SHAPE) return CITY_RECORD_ID.test(id);
  if (shape === MEETING_SHAPE) return CITY_RECORD_ID.test(id) || MEETING_ID.test(id);
  return false;
}

export function digestRoute(kind) {
  return routeFor(kind);
}

export function normalizeDigestId(kind, id) {
  const route = routeFor(kind);
  return route && idMatchesShape(id, route.idShape) ? id : null;
}

export function digestPermalinkUrl(kind, id, w = null) {
  const route = routeFor(kind);
  const normalizedId = normalizeDigestId(kind, id);
  if (!route || normalizedId === null) throw new Error(`invalid digest route id for ${kind}`);
  const base = `https://cityscroll.org${route.permalinkPathPrefix}${encodeURIComponent(normalizedId)}`;
  return w ? `${base}?w=${encodeURIComponent(w)}` : base;
}

export function digestRedirectUrl(
  base,
  kind,
  id,
  { sessionToken = null, watchParam = null } = {},
) {
  if (!routeFor(kind) || normalizeDigestId(kind, id) === null) {
    throw new Error(`invalid digest redirect id for ${kind}`);
  }
  const qs = [];
  if (sessionToken) qs.push(`s=${encodeURIComponent(sessionToken)}`);
  if (watchParam) qs.push(`w=${watchParam}`);
  const origin = String(base || "https://api.cityscroll.org").replace(/\/+$/, "");
  return `${origin}/r/${encodeURIComponent(kind)}/${encodeURIComponent(id)}${qs.length ? `?${qs.join("&")}` : ""}`;
}

// Used by tests and startup-independent callers to make contract drift explicit.
export function assertDigestRouteContract(contract = DIGEST_ROUTE_CONTRACT, expected = null) {
  for (const kind of Object.keys(contract || {})) {
    const route = contract[kind];
    if (!route || typeof route.permalinkPathPrefix !== "string" || !route.permalinkPathPrefix.startsWith("/")) {
      throw new Error(`invalid digest route contract for ${kind}`);
    }
    if (!route.idShape || typeof route.idShape.name !== "string" || !Number.isInteger(route.idShape.maxLength)) {
      throw new Error(`invalid digest id shape for ${kind}`);
    }
  }
  if (expected) {
    const actualKinds = Object.keys(contract).sort();
    const expectedKinds = Object.keys(expected).sort();
    if (JSON.stringify(actualKinds) !== JSON.stringify(expectedKinds)) {
      throw new Error("digest route kind set drifted");
    }
    for (const kind of expectedKinds) {
      const actual = contract[kind];
      const wanted = expected[kind];
      if (actual.permalinkPathPrefix !== wanted.permalinkPathPrefix || actual.idShape.name !== wanted.idShape) {
        throw new Error(`digest route contract drifted for ${kind}`);
      }
    }
  }
  return true;
}

assertDigestRouteContract();
