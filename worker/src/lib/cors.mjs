// Frontend-origin contract shared by browser-facing Worker routes.
//
// Production keeps its stable, mirror, legacy, and local-development origin set.

const STABLE_ORIGINS = new Set([
  "https://cityscroll.org",
  "https://www.cityscroll.org",
  "https://crol-list.org",
  "https://www.crol-list.org",
  // Parallel Cloudflare Pages host (Phase 1); API calls from pages.dev during soak.
  "https://cityscroll.pages.dev",
  "https://crol-list.jimdc.com", // GitHub Pages CNAME, not a Worker route
  "https://jimdc.github.io",
]);
const LOCAL_DEVELOPMENT_PORTS = new Set(["8000", "8787", "8888"]);

function isLocalDevelopmentOrigin(origin) {
  try {
    const url = new URL(origin);
    return (
      url.protocol === "http:"
      && url.hostname === "localhost"
      && LOCAL_DEVELOPMENT_PORTS.has(url.port)
    );
  } catch {
    return false;
  }
}

export function isAllowedRequestOrigin(origin, _env = {}) {
  if (!origin) return true;
  if (STABLE_ORIGINS.has(origin)) return true;
  return isLocalDevelopmentOrigin(origin);
}

export function corsHeaders(
  origin,
  env = {},
  {
    methods = "POST, OPTIONS",
    headers = "Content-Type",
    maxAge,
    cacheControl,
    // Credentialed routes (session cookie / pin sync) must echo a specific Origin
    // and set Access-Control-Allow-Credentials — never "*".
    credentials = false,
  } = {},
) {
  const allowed = isAllowedRequestOrigin(origin, env);
  const result = {
    "Access-Control-Allow-Origin": allowed
      ? (origin || "https://cityscroll.org")
      : "https://cityscroll.org",
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Allow-Headers": headers,
    "Vary": "Origin",
  };
  if (maxAge) result["Access-Control-Max-Age"] = maxAge;
  if (cacheControl) result["Cache-Control"] = cacheControl;
  if (credentials && allowed && origin) {
    result["Access-Control-Allow-Credentials"] = "true";
    // Credentialed responses must not fall back to a foreign default origin.
    result["Access-Control-Allow-Origin"] = origin;
  }
  return result;
}
