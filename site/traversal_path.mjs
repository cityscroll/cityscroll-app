import { normalizeScope as normalizeScopeV0, scopeFromRouteHash } from "./scope_v0.mjs";
import { entityPivotRouteStatus } from "./edge_summary.mjs";

export const TRAVERSAL_SCHEMA = "cityscroll.traversal.v1";
export const TRAVERSAL_QUERY_KEY = "walk";
export const MAX_TRAVERSAL_HOPS = 8;
export const MAX_TRAVERSAL_TOKEN_LENGTH = 6000;

const ROUTE_HASHES = new Set([
  "money", "people", "land", "property", "rules", "meetings", "map", "now",
]);

function clean(value, max = 240) {
  if (value == null) return "";
  return String(value).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function escapeHTML(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function base64UrlEncode(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 = typeof btoa === "function"
    ? btoa(binary)
    : Buffer.from(bytes).toString("base64");
  return base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(value) {
  const base64 = String(value).replaceAll("-", "+").replaceAll("_", "/")
    .padEnd(Math.ceil(String(value).length / 4) * 4, "=");
  const binary = typeof atob === "function"
    ? atob(base64)
    : Buffer.from(base64, "base64").toString("binary");
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function routeWithoutWalk(href) {
  const raw = clean(href, 2000);
  if (!raw) return "";
  if (raw.startsWith("#")) {
    const queryAt = raw.indexOf("?");
    if (queryAt < 0) return raw;
    const params = new URLSearchParams(raw.slice(queryAt + 1));
    params.delete(TRAVERSAL_QUERY_KEY);
    const query = params.toString();
    return `${raw.slice(0, queryAt)}${query ? `?${query}` : ""}`;
  }
  try {
    const url = new URL(raw, "https://cityscroll.org");
    url.searchParams.delete(TRAVERSAL_QUERY_KEY);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return raw;
  }
}

export function stripTraversalPath(href) {
  return routeWithoutWalk(href);
}

function routeSupportsTraversal(href) {
  const route = routeWithoutWalk(href);
  if (!route) return false;
  if (route.startsWith("#")) {
    const fragment = route.slice(1).split("?", 1)[0];
    return ROUTE_HASHES.has(fragment)
      || /^(?:notice|official|agency|vendor|land)\/[A-Za-z0-9_%~-]+$/.test(fragment);
  }
  return entityPivotRouteStatus(route).verified
    || /^\/(?:notices|officials|agencies|vendors|browse|near-you|parcels|districts|packs)(?:\/[^?#]*)?\/?(?:\?.*)?(?:#.*)?$/.test(route);
}

function normalizeScope(scope) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return null;
  try {
    return normalizeScopeV0(scope, { language: scope.language || "en" });
  } catch {
    return null;
  }
}

function normalizeNode(node = {}, fallbackHref = "") {
  const raw = node && typeof node === "object" ? node : {};
  const href = routeWithoutWalk(raw.href || fallbackHref);
  return {
    kind: clean(raw.kind, 80) || "record",
    id: clean(raw.id, 240) || null,
    name: clean(raw.name, 240) || clean(raw.label, 240) || clean(raw.id, 240) || "Current record",
    href: href || null,
  };
}

function normalizeHop(hop = {}) {
  const source = normalizeNode(hop.source);
  const destination = normalizeNode(hop.destination || hop.target);
  return {
    source,
    relation: clean(hop.relation || hop.relation_label, 180) || "related records",
    destination,
    scope: normalizeScope(hop.scope),
  };
}

function emptyState() {
  return { schema: TRAVERSAL_SCHEMA, version: 1, status: "empty", hops: [] };
}

export function emptyTraversalPath() {
  return emptyState();
}

function heldState(reason, current = null, hops = [], origin = null) {
  return {
    schema: TRAVERSAL_SCHEMA,
    version: 1,
    status: "held",
    reason: clean(reason, 160) || "Path could not be read",
    current: current ? normalizeNode(current) : null,
    origin: origin ? normalizeNode(origin) : null,
    hops: hops.map(normalizeHop),
  };
}

export function normalizeTraversalPath(input = {}) {
  const raw = input && typeof input === "object" ? input : {};
  const rawHops = Array.isArray(raw.hops) ? raw.hops : [];
  if (raw.status === "held") return heldState(raw.reason, raw.current, rawHops, raw.origin);
  if (rawHops.length > MAX_TRAVERSAL_HOPS) {
    const hops = rawHops.slice(0, MAX_TRAVERSAL_HOPS).map(normalizeHop);
    return heldState("Path is too long to save", hops.at(-1)?.destination || null, hops, hops[0]?.source);
  }
  const hops = [];
  for (const rawHop of rawHops) {
    const hop = normalizeHop(rawHop);
    if (!hop.source.href || !hop.destination.href) {
      return heldState("A step has no shareable route", hop.destination, hops, hops[0]?.source);
    }
    if (!routeSupportsTraversal(hop.source.href) || !routeSupportsTraversal(hop.destination.href)) {
      return heldState("A step has an unsupported route", hop.destination, hops, hops[0]?.source);
    }
    hops.push(hop);
  }
  return { schema: TRAVERSAL_SCHEMA, version: 1, status: "active", hops };
}

export function encodeTraversalPath(input = {}) {
  const state = normalizeTraversalPath(input);
  const token = base64UrlEncode(JSON.stringify(state));
  return token.length <= MAX_TRAVERSAL_TOKEN_LENGTH ? token : null;
}

export function decodeTraversalPath(token) {
  if (!token) return emptyState();
  if (String(token).length > MAX_TRAVERSAL_TOKEN_LENGTH) {
    return heldState("Path is too long to read");
  }
  try {
    const parsed = JSON.parse(base64UrlDecode(token));
    if (parsed?.schema !== TRAVERSAL_SCHEMA || parsed?.version !== 1) {
      return heldState("Path version is not supported");
    }
    return normalizeTraversalPath(parsed);
  } catch {
    return heldState("Path could not be read");
  }
}

function walkTokenFromHref(href) {
  const raw = clean(href, 4000);
  if (!raw) return "";
  if (raw.startsWith("#")) {
    const queryAt = raw.indexOf("?");
    return queryAt < 0 ? "" : new URLSearchParams(raw.slice(queryAt + 1)).get(TRAVERSAL_QUERY_KEY) || "";
  }
  try { return new URL(raw, "https://cityscroll.org").searchParams.get(TRAVERSAL_QUERY_KEY) || ""; } catch { return ""; }
}

export function traversalFromHref(href) {
  return decodeTraversalPath(walkTokenFromHref(href));
}

export function withTraversalPath(href, state) {
  const token = encodeTraversalPath(state);
  if (!token) return null;
  const raw = clean(href, 2000);
  if (!raw) return null;
  if (raw.startsWith("#")) {
    const queryAt = raw.indexOf("?");
    const fragment = queryAt < 0 ? raw : raw.slice(0, queryAt);
    const params = new URLSearchParams(queryAt < 0 ? "" : raw.slice(queryAt + 1));
    params.set(TRAVERSAL_QUERY_KEY, token);
    return `${fragment}?${params}`;
  }
  try {
    const url = new URL(raw, "https://cityscroll.org");
    url.searchParams.set(TRAVERSAL_QUERY_KEY, token);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return null; }
}

export function scopeFromTraversalHref(href, language = "en") {
  const raw = clean(href, 4000);
  if (!raw) return null;
  try {
    if (raw.startsWith("#")) return scopeFromRouteHash(raw, { language });
    const url = new URL(raw, "https://cityscroll.org");
    if (/^\/near-you(?:\/|$)/.test(url.pathname)) {
      const parts = url.pathname.split("/").filter(Boolean);
      const pathLens = ["land", "property", "rules", "money"].find((lens) => parts.includes(lens));
      const lens = url.searchParams.get("lens") || pathLens || "meetings";
      return scopeFromRouteHash(`#${lens}?${url.searchParams}`, { language });
    }
    const match = url.pathname.match(/^\/browse\/([^/]+)\/?$/);
    const surface = match?.[1] === "contracts" ? "money"
      : ({ staffing: "people", zoning: "land", property: "property", rules: "rules", meetings: "meetings" })[match?.[1]];
    return surface ? scopeFromRouteHash(`#${surface}${url.search}`, { language }) : null;
  } catch { return null; }
}

export function appendTraversalHop(href, hop, existing = emptyState()) {
  const normalizedHop = normalizeHop({ ...hop, scope: hop.scope || scopeFromTraversalHref(hop.source?.href) });
  const current = normalizeTraversalPath(existing);
  const candidate = { hops: [...(current.status === "active" ? current.hops : []), normalizedHop] };
  const normalized = normalizeTraversalPath(candidate);
  if (normalized.status === "held") {
    const held = heldState(normalized.reason, normalizedHop.destination, current.hops, current.hops[0]?.source || normalizedHop.source);
    const heldHref = withTraversalPath(href, held);
    return { href: heldHref, state: held };
  }
  const next = withTraversalPath(href, normalized);
  if (next) return { href: next, state: normalized };
  const held = heldState("Path is too long to save", normalizedHop.destination, current.hops, current.hops[0]?.source || normalizedHop.source);
  return { href: withTraversalPath(href, held), state: held };
}

export function traversalBackHref(state, fallbackHref = "") {
  const normalized = normalizeTraversalPath(state);
  if (!normalized.hops.length) return routeWithoutWalk(fallbackHref);
  const prior = normalized.hops.slice(0, -1);
  const destination = prior.at(-1)?.destination || normalized.hops[0].source;
  return prior.length
    ? (withTraversalPath(destination.href, { hops: prior }) || routeWithoutWalk(destination.href))
    : routeWithoutWalk(destination.href);
}

export function traversalRestartHref(state, fallbackHref = "") {
  const normalized = normalizeTraversalPath(state);
  const origin = normalized.hops[0]?.source?.href || normalized.origin?.href || normalized.current?.href || fallbackHref;
  return routeWithoutWalk(origin);
}

function nodeLabel(node) {
  return clean(node?.name || node?.id || "Current record", 180);
}

export function renderTraversalPath(input = {}, { currentHref = "" } = {}) {
  const state = normalizeTraversalPath(input);
  if (state.status === "empty") return "";
  const currentRoute = routeWithoutWalk(currentHref);
  const restartHref = traversalRestartHref(state, currentRoute);
  if (state.status === "held") {
    const current = state.current || state.hops.at(-1)?.destination || { name: "Current record", href: currentRoute };
    return `<aside class="traversal-path traversal-path-held" data-traversal-status="held" aria-labelledby="traversal-path-heading"><div class="traversal-path-head"><div><p class="traversal-path-kicker">Navigation path</p><h2 id="traversal-path-heading">Current node: ${escapeHTML(nodeLabel(current))}</h2></div><a class="traversal-path-restart" href="${escapeHTML(restartHref)}">Restart at origin</a></div><p class="traversal-path-status" role="status">${escapeHTML(state.reason)}. This path was not changed.</p><p class="traversal-path-note">Path only. This is navigation context, not a new fact.</p></aside>`;
  }
  const first = state.hops[0]?.source;
  const nodes = first ? [first, ...state.hops.map((hop) => hop.destination)] : [];
  const items = nodes.map((node, index) => {
    const active = index === nodes.length - 1;
    const label = nodeLabel(node);
    const link = node.href && !active
      ? `<a href="${escapeHTML(node.href)}">${escapeHTML(label)}</a>`
      : `<span${active ? ' aria-current="page"' : ""}>${escapeHTML(label)}</span>`;
    const relation = index > 0 ? `<span class="traversal-path-relation" aria-hidden="true">${escapeHTML(state.hops[index - 1].relation)} →</span>` : "";
    return `<li>${relation}${link}</li>`;
  }).join("");
  return `<aside class="traversal-path" data-traversal-status="active" data-traversal-hop-count="${state.hops.length}" aria-labelledby="traversal-path-heading"><div class="traversal-path-head"><div><p class="traversal-path-kicker">Navigation path</p><h2 id="traversal-path-heading">Where you came from</h2></div><div class="traversal-path-actions"><a href="${escapeHTML(traversalBackHref(state, currentRoute))}">Back one step</a><a class="traversal-path-restart" href="${escapeHTML(restartHref)}">Restart at origin</a></div></div><ol>${items}</ol><p class="traversal-path-note">Path only. This is navigation context, not a new fact.</p></aside>`;
}
