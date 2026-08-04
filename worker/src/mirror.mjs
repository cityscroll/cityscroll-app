// /mirror — serves the canonical cityscroll.org and www.cityscroll.org hosts by
// reverse-proxying the static site from crol-list.org, its GitHub Pages origin.
// Origin redirects are handled manually so a redirect back to this Worker cannot
// become a recursive subrequest loop. If the direct-visitor redirect catches the
// subrequest, the stamped Cloudflare Pages production artifact is the site failover
// seam (not raw GitHub source, which keeps unsubstituted build tokens).
//
// GitHub Pages virtual-hosts by the Host header, so the request to the origin must NOT
// carry the incoming Host (cityscroll.org) — that would 404 on a domain GitHub doesn't
// know about. Only a small, safe header allowlist is forwarded; everything else is dropped.

const ORIGIN = "https://crol-list.org";
// Built, cache-stamped site (parallel Pages host). Source trees keep __I18N_ASSET_VERSION__
// merge-stable; only the deploy artifact substitutes it. Field case 2026-07-30: raw
// GitHub fallback served the unsubstituted placeholder on the live homepage.
const SITE_FALLBACK_ORIGIN = "https://cityscroll.pages.dev/";
const REPOSITORY_FALLBACK_ORIGIN = "https://raw.githubusercontent.com/cityscroll/crol-list/main/";
const FORWARD_REQUEST_HEADERS = ["accept", "accept-language", "if-none-match", "if-modified-since", "user-agent"];
const MIRROR_HOSTS = new Set([
  "cityscroll.org",
  "www.cityscroll.org",
  "crol-list.org",
]);
const ROOT_DOCUMENTS = new Set(["/README.md"]);
const FALLBACK_CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "application/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "application/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".webm", "video/webm"],
  [".webmanifest", "application/manifest+json"],
  [".xml", "application/xml; charset=utf-8"],
]);

function redirectedToMirror(response) {
  if (response.status < 300 || response.status >= 400) return null;
  const location = response.headers.get("location");
  if (!location) return null;
  try {
    const target = new URL(location, ORIGIN);
    return MIRROR_HOSTS.has(target.hostname) ? target : null;
  } catch {
    return null;
  }
}

function fallbackUrl(target) {
  let pathname = target.pathname;
  // Directory indexes need an explicit file on the raw-docs seam; the stamped site
  // host pretty-redirects /index.html → / and *.html → clean paths, so leave bare
  // "/" alone and follow same-origin redirects in fetchFallback().
  if (pathname.endsWith("/") && pathname !== "/") pathname += "index.html";
  const fallbackOrigin = pathname.startsWith("/docs/") || ROOT_DOCUMENTS.has(pathname)
    ? REPOSITORY_FALLBACK_ORIGIN
    : SITE_FALLBACK_ORIGIN;
  const url = new URL(pathname.replace(/^\/+/, "") || ".", fallbackOrigin);
  // new URL(".", base) keeps a trailing slash; normalize bare site root to "/"
  if (pathname === "/" || pathname === "") {
    url.pathname = "/";
  }
  url.search = target.search;
  return url;
}

function fallbackContentType(pathname) {
  if (!pathname || pathname === "/") return "text/html; charset=utf-8";
  const dot = pathname.lastIndexOf(".");
  if (dot === -1) {
    // Cloudflare Pages clean paths (/about, /stats) serve HTML without an extension.
    return "text/html; charset=utf-8";
  }
  return FALLBACK_CONTENT_TYPES.get(pathname.slice(dot).toLowerCase()) || null;
}

function relay(response, fallbackPathname = null) {
  if (fallbackPathname === null) return new Response(response.body, response);

  const headers = new Headers(response.headers);
  const contentType = fallbackContentType(fallbackPathname);
  if (contentType) headers.set("Content-Type", contentType);
  if (contentType?.startsWith("text/html")) {
    // raw.githubusercontent.com marks source files as sandboxed plain text.
    headers.delete("Content-Security-Policy");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Fetch the stamped fallback host, following redirects that stay on the same origin.
 * Cloudflare Pages pretty-URL 308s (e.g. /about.html → /about) must not be relayed to
 * the visitor as a loop back into this Worker.
 */
async function fetchFallback(startUrl, fetchOptions, maxHops = 5) {
  let current = new URL(startUrl.toString());
  let response = await fetch(current.toString(), fetchOptions);
  for (let hop = 0; hop < maxHops; hop++) {
    if (response.status < 300 || response.status >= 400) {
      return { response, pathname: current.pathname };
    }
    const location = response.headers.get("location");
    if (!location) return { response, pathname: current.pathname };
    const next = new URL(location, current);
    if (next.origin !== current.origin) {
      return { response, pathname: current.pathname };
    }
    current = next;
    response = await fetch(current.toString(), fetchOptions);
  }
  return { response, pathname: current.pathname };
}

export async function handleMirror(request) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { "Content-Type": "text/plain", "Allow": "GET, HEAD" } });
  }

  const incoming = new URL(request.url);
  const originUrl = new URL(incoming.pathname + incoming.search, ORIGIN);

  const headers = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }

  const fetchOptions = { method: request.method, headers, redirect: "manual" };
  const originResponse = await fetch(originUrl.toString(), fetchOptions);
  const mirrorRedirect = redirectedToMirror(originResponse);
  if (!mirrorRedirect) return relay(originResponse);

  const fallback = fallbackUrl(mirrorRedirect);
  const { response: fallbackResponse, pathname } = await fetchFallback(fallback, fetchOptions);
  return relay(fallbackResponse, pathname);
}
