const MAX_BYTES = 10 * 1024 * 1024;
const HASH_RE = /^[a-f0-9]{64}$/;
const ELIGIBLE_SOURCES = [
  {host: "data.cityofnewyork.us", path: /^\/api\/views\//, source_class: "nyc_open_data_export"},
  {host: "www.nyc.gov", path: /^\/assets\/[^/]+\/downloads\//, source_class: "nyc_agency_publication"},
  {host: "comptroller.nyc.gov", path: /^\/wp-content\/uploads\//, source_class: "comptroller_publication"}
];
const ALLOWED_TYPES = new Set(["application/pdf", "text/plain", "text/csv", "application/json"]);

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: {"cache-control": "no-store", "access-control-allow-origin": "https://crol-list.org"}
  });
}

export function sourceEligibility(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return {eligible: false, reason: "invalid_url"};
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    return {eligible: false, reason: "public_https_required"};
  }
  const policy = ELIGIBLE_SOURCES.find((candidate) =>
    candidate.host === url.hostname.toLowerCase() && candidate.path.test(url.pathname)
  );
  if (!policy) return {eligible: false, reason: "rights_or_access_uncertain"};
  return {eligible: true, source_class: policy.source_class, normalized_url: url.href};
}

function bytesStartWith(bytes, text) {
  const prefix = new TextEncoder().encode(text);
  return prefix.every((byte, index) => bytes[index] === byte);
}

export function inspectDocument(bytes, contentType) {
  const type = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED_TYPES.has(type)) return {accepted: false, reason: "content_type_not_allowed"};
  if (bytes.byteLength > MAX_BYTES) return {accepted: false, reason: "size_limit_exceeded"};
  const view = new Uint8Array(bytes);
  if (bytesStartWith(view, "MZ") || bytesStartWith(view, "\u007fELF")) {
    return {accepted: false, reason: "executable_signature"};
  }
  const sample = new TextDecoder().decode(view.slice(0, Math.min(view.length, 4096)));
  if (sample.includes("EICAR-STANDARD-ANTIVIRUS-TEST-FILE")) {
    return {accepted: false, reason: "malware_signature"};
  }
  if (type === "application/pdf" && !bytesStartWith(view, "%PDF-")) {
    return {accepted: false, reason: "type_signature_mismatch"};
  }
  return {
    accepted: true,
    content_type: type,
    size: bytes.byteLength,
    checks: ["bounded_size", "declared_type", "file_signature", "malware_signature_blocklist_v1"]
  };
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function disabled(env) {
  return env.SOURCE_VAULT_ENABLED !== "true" || !env.SOURCE_VAULT;
}

async function approvedManifest(bucket, hash) {
  const object = await bucket.get(`manifests/${hash}.json`);
  if (!object) return null;
  const manifest = await object.json();
  return manifest.state === "approved" && manifest.eligibility?.eligible ? manifest : null;
}

export async function fetchAndKeepDocument({url, process_id}, env, fetchImpl = fetch, now = () => new Date()) {
  if (disabled(env)) return {status: "disabled", official_url: url};
  if (!process_id || typeof process_id !== "string") return {status: "refused", reason: "process_id_required", official_url: url};
  const eligibility = sourceEligibility(url);
  if (!eligibility.eligible) return {status: "official_link_only", reason: eligibility.reason, official_url: url};

  const response = await fetchImpl(eligibility.normalized_url, {
    method: "GET",
    redirect: "error",
    headers: {"accept": "application/pdf,text/plain,text/csv,application/json"}
  });
  if (!response.ok) return {status: "official_link_only", reason: `source_http_${response.status}`, official_url: url};
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BYTES) {
    return {status: "official_link_only", reason: "size_limit_exceeded", official_url: url};
  }
  const bytes = await response.arrayBuffer();
  const inspection = inspectDocument(bytes, response.headers.get("content-type"));
  if (!inspection.accepted) return {status: "official_link_only", reason: inspection.reason, official_url: url};
  const hash = await sha256Hex(bytes);
  const existing = await approvedManifest(env.SOURCE_VAULT, hash);
  if (existing) {
    const manifest = {
      ...existing,
      process_ids: [...new Set([...(existing.process_ids || []), process_id])]
    };
    await env.SOURCE_VAULT.put(`manifests/${hash}.json`, JSON.stringify(manifest), {
      httpMetadata: {contentType: "application/json"}
    });
    return {status: "kept", deduplicated: true, hash, manifest};
  }

  const fetchedAt = now().toISOString();
  const base = {
    schema_version: "1.0.0",
    hash,
    process_ids: [process_id],
    official_url: eligibility.normalized_url,
    fetched_at: fetchedAt,
    eligibility,
    inspection,
    retention: {policy: "while_source_public_and_eligible", removal_state: "retained"},
    object_key: `objects/${hash}`
  };
  await env.SOURCE_VAULT.put(`manifests/${hash}.json`, JSON.stringify({...base, state: "quarantined"}), {
    httpMetadata: {contentType: "application/json"}
  });
  await env.SOURCE_VAULT.put(base.object_key, bytes, {
    httpMetadata: {contentType: inspection.content_type},
    customMetadata: {sha256: hash, sourceClass: eligibility.source_class},
    sha256: hash
  });
  const manifest = {...base, state: "approved"};
  await env.SOURCE_VAULT.put(`manifests/${hash}.json`, JSON.stringify(manifest), {
    httpMetadata: {contentType: "application/json"}
  });
  return {status: "kept", deduplicated: false, hash, manifest};
}

export async function handleSourceVault(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/source-vault/fetch") {
    if (disabled(env)) return json({status: "disabled", message: "Source storage is unavailable; use the official link."}, 503);
    if (Number(request.headers.get("content-length") || 0) > 2048) return json({error: "request_too_large"}, 413);
    let body;
    try {
      body = await request.json();
    } catch {
      return json({error: "invalid_json"}, 400);
    }
    if (body.credentials || body.authorization || body.cookie) return json({error: "credentials_not_accepted"}, 400);
    const result = await fetchAndKeepDocument(body, env, fetchImpl);
    return json(result, result.status === "kept" ? 200 : 422);
  }
  const match = url.pathname.match(/^\/source-vault\/([a-f0-9]{64})$/);
  if (request.method === "GET" && match && HASH_RE.test(match[1])) {
    if (disabled(env)) return json({status: "disabled"}, 503);
    const hash = match[1];
    const manifest = await approvedManifest(env.SOURCE_VAULT, hash);
    if (!manifest) return json({error: "not_found"}, 404);
    const object = await env.SOURCE_VAULT.get(manifest.object_key);
    if (!object?.body) return json({error: "not_found"}, 404);
    const headers = new Headers();
    object.writeHttpMetadata?.(headers);
    headers.set("etag", object.httpEtag || `"${hash}"`);
    headers.set("x-content-sha256", hash);
    headers.set("x-source-url", manifest.official_url);
    headers.set("cache-control", "private, max-age=300");
    return new Response(object.body, {headers});
  }
  return json({error: "not_found"}, 404);
}

export const SOURCE_VAULT_MAX_BYTES = MAX_BYTES;
