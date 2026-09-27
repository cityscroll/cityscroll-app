/**
 * Finite public hash grammar owned by the topic SPA router.
 *
 * The root ingress and the router both consume this registry. Keeping the
 * matcher here means a new hash family cannot become routable without also
 * becoming visible to the root-deep-link browser census.
 */
export const SPA_HASH_ROUTE_PATTERNS = Object.freeze([
  { id: "browse", pattern: "^browse$" },
  { id: "money", pattern: "^money(?:\\?.*)?$" },
  { id: "staffing", pattern: "^staffing(?:\\?.*)?$" },
  { id: "exams", pattern: "^exams(?:\\?.*)?$" },
  { id: "land", pattern: "^land(?:\\?.*)?$" },
  { id: "property", pattern: "^property(?:\\?.*)?$" },
  { id: "rules", pattern: "^rules(?:\\?.*)?$" },
  { id: "meetings", pattern: "^meetings(?:\\?.*)?$" },
  { id: "now", pattern: "^now(?:\\?.*)?$" },
  { id: "map", pattern: "^map(?:\\?.*)?$" },
  { id: "alerts", pattern: "^alerts(?:\\?.*)?$" },
  { id: "notice-item", pattern: "^notice/[^/?#]+(?:\\?.*)?$" },
  { id: "land-item", pattern: "^land/[A-Za-z0-9_-]{1,80}$" },
  { id: "exam-item", pattern: "^exam/\\d{4}$" },
  { id: "vendor", pattern: "^vendor/[^/?#]+(?:\\?.*)?$" },
  { id: "agency", pattern: "^agency/[^/?#]+(?:\\?.*)?$" },
  { id: "official", pattern: "^official/[^/?#]+(?:\\?.*)?$" },
  { id: "matter", pattern: "^matter/[^/?#]+$" },
  { id: "investigation-signal", pattern: "^investigation/signal/[^/?#]+$" },
  { id: "investigation-shared", pattern: "^investigation/shared/[^/?#]+$" },
  { id: "task", pattern: "^task/(?:can-i-bid|what-will-change)(?:/[^/?#]+)?$" },
  { id: "investigation", pattern: "^investigation$" },
  { id: "notice-collection", pattern: "^notice/?$" },
  { id: "exam-collection", pattern: "^exam/?$" },
  { id: "vendor-collection", pattern: "^vendor/?$" },
  { id: "agency-collection", pattern: "^agency/?$" },
  { id: "matter-collection", pattern: "^matter/?$" },
  { id: "investigation-shared-collection", pattern: "^investigation/shared/?$" },
  { id: "task-collection", pattern: "^task/?$" },
]);

const COMPILED_PATTERNS = SPA_HASH_ROUTE_PATTERNS.map((route) => ({
  ...route,
  expression: new RegExp(route.pattern),
}));

function rawHashRoute(value) {
  const raw = String(value || "").replace(/^#/, "");
  const slash = raw.indexOf("/");
  return slash >= 0 && raw.slice(0, slash) === "alerts" ? "alerts" : raw;
}

/** Return the registered route family for a public SPA hash, or null. */
export function matchSpaHashRoute(value) {
  const raw = rawHashRoute(value);
  return COMPILED_PATTERNS.find((route) => route.expression.test(raw)) || null;
}
