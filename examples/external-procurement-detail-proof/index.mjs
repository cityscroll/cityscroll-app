#!/usr/bin/env node

// Independent consumer of the documented public detail HTTP routes. This file
// imports only Node platform modules; it must not import the CityScroll app.
import { pathToFileURL } from "node:url";

export const DEFAULT_ORIGIN = "https://api.cityscroll.org";
const NOTICE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const CONTRACT_ID = /^procurement:[A-Za-z0-9:_-]{1,308}$/;
const PRIVATE_KEYS = new Set([
  "raw_snapshot", "normalized_snapshot", "content_hash", "evidence_json",
  "resolution_run_id", "review_status",
]);

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function noPrivateKeys(value, path = "response") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (PRIVATE_KEYS.has(key)) throw new Error(`private field in ${path}.${key}`);
    noPrivateKeys(child, `${path}.${key}`);
  }
}

function validId(kind, id) {
  if (kind === "notice" && NOTICE_ID.test(id)) return true;
  if (kind === "contract" && CONTRACT_ID.test(id) && id.length <= 320) return true;
  return false;
}

function citationLink(value, origin, path) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === origin && url.pathname === path
      && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function unobserved(kind, id, state, status) {
  return { kind, id, state, http_status: status, fact: null };
}

export function summarizePublicDetail({ kind, id, status, body }) {
  if (!validId(kind, id)) throw new Error(`invalid ${kind} identity`);
  object(body, "public response");
  noPrivateKeys(body);
  if (kind === "notice") {
    if (status === 404 && body.ok === false && body.reason === "not-found") {
      return unobserved(kind, id, "not_yet_public", status);
    }
    if (status === 503 && body.ok === false && body.reason === "unavailable") {
      return unobserved(kind, id, "unavailable", status);
    }
    if (status !== 200 || body.ok !== true) throw new Error(`unexpected notice HTTP ${status}`);
    const row = object(body.row, "notice row");
    const citation = object(body.citation, "notice citation");
    if (row.request_id !== id || citation.request_id !== id
      || citation.schema !== "cityscroll.notice_get.citation.v1"
      || citation.publisher !== "NYC City Record"
      || !citationLink(citation.official_url, "https://a856-cityrecord.nyc.gov", `/RequestDetail/${id}`)
      || !citationLink(citation.cityscroll_url, "https://cityscroll.org", `/notices/${id}/`)
      || !["materialized", "public-source-fallback"].includes(body.source)
      || ![true, false, null].includes(body.stale)) {
      throw new Error("notice identity, citation, or freshness does not match the public contract");
    }
    return {
      kind, id, state: "available", http_status: status,
      fact: {
        title: row.short_title ?? null,
        agency: row.agency_name ?? null,
        notice_type: row.type_of_notice_description ?? null,
        due_date: row.due_date ?? null,
        source: body.source,
        generated_at: body.generated_at ?? null,
        stale: body.stale,
        citation,
      },
    };
  }
  if (body.capability_reference !== "contract.get@1") {
    throw new Error("contract response is not the documented capability");
  }
  if (status === 404 && body.availability === "not_yet_public") {
    return unobserved(kind, id, "not_yet_public", status);
  }
  if (status === 503 && body.availability === "unavailable") {
    return unobserved(kind, id, "unavailable", status);
  }
  if (status !== 200 || body.availability !== "available") {
    throw new Error(`unexpected contract HTTP ${status}`);
  }
  const contract = object(body.contract, "contract");
  const provenance = object(contract.provenance, "contract provenance");
  const coverage = object(contract.coverage, "contract coverage");
  const freshness = object(contract.freshness, "contract freshness");
  if (contract.procurement_id !== id || provenance.identity?.exact !== true
    || !Array.isArray(provenance.source_observations)
    || !provenance.source_observations.every((row) => typeof row.source_observation_ref === "string" && row.source_observation_ref)) {
    throw new Error("contract identity or source observations are incomplete");
  }
  return {
    kind, id, state: "available", http_status: status,
    fact: {
      title: contract.fields?.title ?? null,
      agency: contract.fields?.agency ?? null,
      stage: contract.fields?.primary_stage ?? null,
      amount: contract.amount ?? null,
      coverage: { state: coverage.state, source_envelopes: coverage.source_envelopes ?? null },
      as_of: freshness.as_of ?? null,
      source_observation_refs: provenance.source_observations.map((row) => row.source_observation_ref),
      official_url: contract.fields?.official_url ?? null,
      lifecycle: contract.lifecycle ?? null,
    },
  };
}

export async function fetchPublicDetail({ kind, id, origin = DEFAULT_ORIGIN, fetchImpl = globalThis.fetch }) {
  if (!validId(kind, id)) throw new Error(`invalid ${kind} identity`);
  if (typeof fetchImpl !== "function") throw new Error("fetch is required");
  const url = new URL(kind === "notice" ? "/notice" : "/contract", origin);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error("HTTP origin is required");
  url.searchParams.set("id", id);
  const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
  const body = await response.json();
  return { request: url.toString(), ...summarizePublicDetail({ kind, id, status: response.status, body }) };
}

function cliArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!["--kind", "--id", "--base-url"].includes(key) || !argv[i + 1]) {
      throw new Error("usage: --kind notice|contract --id EXACT_ID [--base-url URL]");
    }
    args[key.slice(2)] = argv[++i];
  }
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = cliArgs(process.argv.slice(2));
  fetchPublicDetail({ kind: args.kind, id: args.id, origin: args["base-url"] || DEFAULT_ORIGIN })
    .then((value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`))
    .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
