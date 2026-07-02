// /checkbook — CORS proxy to the Checkbook NYC API.
//
// checkbooknyc.com/api returns no Access-Control-Allow-Origin header, so a browser
// fetch() from crol-list is blocked by CORS. This makes the request server-side and
// re-emits it with CORS headers the browser accepts. No API key — pure CORS shim.
//
// Request shape (POST JSON): { "xml": "<request>...</request>" }
// Build the XML in the browser to keep this proxy schema-agnostic; it just relays.

const CHECKBOOK = "https://www.checkbooknyc.com/api";

const ALLOW = new Set([
  "https://crol-list.org",
  "https://www.crol-list.org",
  "https://crol-list.jimdc.com",
  "https://jimdc.github.io",
  "http://localhost:8888",
  "http://localhost:8000",
  "http://localhost:8787", // wrangler dev
]);

export async function handleCheckbook(req) {
  const origin = req.headers.get("origin") || "";
  const cors = corsHeaders(origin);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return text("POST only", 405, cors, "text/plain");

  let body = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const xml = typeof body.xml === "string" ? body.xml : "";
  if (!xml) return text("Provide { xml } — the Checkbook request body.", 400, cors, "text/plain");

  try {
    const r = await fetch(CHECKBOOK, {
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body: xml,
    });
    const out = await r.text();
    return text(out, r.status, cors, "application/xml");
  } catch (e) {
    return text(`Upstream error: ${String(e?.message || e)}`, 502, cors, "text/plain");
  }
}

function corsHeaders(origin) {
  const o = ALLOW.has(origin) ? origin : "https://crol-list.jimdc.com";
  return {
    "Access-Control-Allow-Origin": o,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function text(s, status, cors, type) {
  return new Response(s, { status, headers: { ...cors, "Content-Type": type } });
}
