import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchAndKeepDocument,
  handleSourceVault,
  inspectDocument,
  sourceEligibility
} from "../worker/src/source_vault.mjs";

class MockObject {
  constructor(value, options = {}) {
    this.value = value;
    this.httpEtag = "\"mock\"";
    this.body = typeof value === "string" ? new Blob([value]).stream() : new Blob([value]).stream();
    this.options = options;
  }
  async json() { return JSON.parse(typeof this.value === "string" ? this.value : new TextDecoder().decode(this.value)); }
  writeHttpMetadata(headers) { if (this.options.httpMetadata?.contentType) headers.set("content-type", this.options.httpMetadata.contentType); }
}
class MockBucket {
  constructor() { this.values = new Map(); this.puts = []; }
  async get(key) { return this.values.has(key) ? new MockObject(...this.values.get(key)) : null; }
  async put(key, value, options = {}) {
    const stored = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
    this.values.set(key, [stored, options]);
    this.puts.push({key, value: stored, options});
    return {key};
  }
}

const eligibleUrl = "https://www.nyc.gov/assets/dcas/downloads/pdf/example-public-report.pdf";
const pdf = new TextEncoder().encode("%PDF-1.7\npublic report fixture");
const fetchPdf = async () => new Response(pdf, {headers: {"content-type": "application/pdf", "content-length": String(pdf.length)}});
const enabledEnv = () => ({SOURCE_VAULT_ENABLED: "true", SOURCE_VAULT: new MockBucket()});

test("eligible public documents get an approved provenance manifest before serving", async () => {
  const env = enabledEnv();
  const result = await fetchAndKeepDocument({url: eligibleUrl, process_id: "process:test"}, env, fetchPdf,
    () => new Date("2026-07-28T12:00:00Z"));
  assert.equal(result.status, "kept");
  assert.equal(result.manifest.state, "approved");
  assert.equal(result.manifest.official_url, eligibleUrl);
  assert.equal(result.manifest.inspection.content_type, "application/pdf");
  assert.match(result.hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(env.SOURCE_VAULT.puts.map((put) => put.key), [
    `manifests/${result.hash}.json`,
    `objects/${result.hash}`,
    `manifests/${result.hash}.json`
  ]);
  assert.match(env.SOURCE_VAULT.puts[0].value, /"state":"quarantined"/);
});

test("identical content deduplicates by sha256", async () => {
  const env = enabledEnv();
  const first = await fetchAndKeepDocument({url: eligibleUrl, process_id: "process:a"}, env, fetchPdf);
  const putCount = env.SOURCE_VAULT.puts.length;
  const second = await fetchAndKeepDocument({url: eligibleUrl, process_id: "process:b"}, env, fetchPdf);
  assert.equal(second.hash, first.hash);
  assert.equal(second.deduplicated, true);
  assert.deepEqual(second.manifest.process_ids, ["process:a", "process:b"]);
  assert.equal(env.SOURCE_VAULT.puts.length, putCount + 1);
  assert.equal(env.SOURCE_VAULT.puts.at(-1).key, `manifests/${first.hash}.json`);
});

test("uncertain rights, credentials, executable content, and malware signatures are refused", async () => {
  assert.equal(sourceEligibility("https://example.com/file.pdf").reason, "rights_or_access_uncertain");
  assert.equal(inspectDocument(new TextEncoder().encode("MZ").buffer, "application/octet-stream").accepted, false);
  assert.equal(inspectDocument(new TextEncoder().encode("EICAR-STANDARD-ANTIVIRUS-TEST-FILE").buffer, "text/plain").accepted, false);
  const response = await handleSourceVault(new Request("https://api.crol-list.org/source-vault/fetch", {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({url: eligibleUrl, process_id: "process:test", credentials: "never"})
  }), enabledEnv(), fetchPdf);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "credentials_not_accepted");
});

test("disabled R2 leaves the official-link fallback available", async () => {
  const result = await fetchAndKeepDocument({url: eligibleUrl, process_id: "process:test"}, {
    SOURCE_VAULT_ENABLED: "false"
  }, fetchPdf);
  assert.deepEqual(result, {status: "disabled", official_url: eligibleUrl});
});

test("bytes cannot be served without an approved eligibility manifest", async () => {
  const env = enabledEnv();
  const hash = "a".repeat(64);
  await env.SOURCE_VAULT.put(`objects/${hash}`, pdf);
  await env.SOURCE_VAULT.put(`manifests/${hash}.json`, JSON.stringify({
    state: "quarantined",
    eligibility: {eligible: true},
    object_key: `objects/${hash}`
  }));
  const response = await handleSourceVault(new Request(`https://api.crol-list.org/source-vault/${hash}`), env);
  assert.equal(response.status, 404);
});
