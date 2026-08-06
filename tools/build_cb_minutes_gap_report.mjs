#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseSourceIndex } from "../warehouse/lib/non_council_outcomes.mjs";

const ROOT = join(import.meta.dirname, "..");
const REGISTRY_PATH = join(ROOT, "site/data/non_council_outcome_sources/source_registry.json");
const RECEIPT_PATH = join(ROOT, "site/data/non_council_outcome_sources/verification_receipts/cb_minutes_publication_probes.json");
const REPORT_PATH = join(ROOT, "site/data/non_council_outcome_sources/cb_minutes_gap_report.json");
const AUDIT_URL = "https://comptroller.nyc.gov/reports/audit-report-on-the-twelve-manhattan-community-boards-compliance-with-new-york-city-charter-and-new-york-city-administrative-code-requirements-for-public-meetings-and-hearings-and-for-web/";
const RECEIPT_SCHEMA = "cityscroll.cb_minutes_publication_probe_receipt.v1";
const REPORT_SCHEMA = "cityscroll.cb_minutes_gap_report.v1";
const TRAILING_MONTHS = 12;

function readJson(path) { return JSON.parse(readFileSync(path, "utf8")); }
function writeJson(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function dateOnly(value) { return String(value || "").slice(0, 10); }
function subtractMonths(isoDate, months) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() - months);
  return date.toISOString().slice(0, 10);
}
function communityBoards(registry) {
  return registry.sources.filter((row) => row.body_type === "community_board");
}
function assertRegistry(registry) {
  const boards = communityBoards(registry);
  if (boards.length !== 59) throw new Error(`expected 59 community boards, found ${boards.length}`);
  if (new Set(boards.map((row) => row.body_id)).size !== boards.length) throw new Error("community board body_id values must be unique");
}
function emptyProbe(source, reason = "no_known_url") {
  return {
    body_id: source.body_id,
    url: null,
    fetched_at: null,
    http_status: null,
    content_sha256: null,
    observations: [],
    status: "empty",
    reason,
  };
}
async function fetchProbe(source, fetchedAt = new Date().toISOString()) {
  if (!source.source_url) return emptyProbe(source);
  const response = await fetch(source.source_url, { headers: { "User-Agent": "CityScroll publication probe (+https://cityscroll.org/)" } });
  const body = await response.text();
  const observedAt = fetchedAt;
  const documents = response.ok ? parseSourceIndex(body, source, { observedAt }) : [];
  return {
    body_id: source.body_id,
    url: source.source_url,
    fetched_at: fetchedAt,
    http_status: response.status,
    content_sha256: sha256(body),
    observations: documents.map(({ meeting_date, document_url, title }) => ({ meeting_date, document_url, title })),
    status: response.ok ? "ok" : "http_error",
    ...(response.ok ? {} : { reason: `HTTP ${response.status}` }),
  };
}
function validateReceipt(registry, receipt) {
  if (receipt.schema !== RECEIPT_SCHEMA) throw new Error(`unexpected probe receipt schema: ${receipt.schema}`);
  const boards = communityBoards(registry);
  const byId = new Map((receipt.probes || []).map((probe) => [probe.body_id, probe]));
  if (byId.size !== boards.length) throw new Error(`probe receipt must contain one row for all ${boards.length} boards`);
  for (const source of boards) {
    const probe = byId.get(source.body_id);
    if (!probe) throw new Error(`probe receipt missing ${source.body_id}`);
    if (source.status === "collect" && !source.source_url && !probe.url) {
      throw new Error(`${source.body_id}: collect source lost its URL without a receipt-backed URL`);
    }
    if (probe.url && !/^https:\/\//.test(probe.url)) throw new Error(`${source.body_id}: probe URL must be HTTPS`);
    for (const observation of probe.observations || []) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(observation.meeting_date) || !observation.document_url) {
        throw new Error(`${source.body_id}: malformed publication observation`);
      }
    }
  }
  return byId;
}
function classify(source, probe, windowStart) {
  const observations = (probe.observations || []).filter((row) => row.meeting_date).sort((a, b) => b.meeting_date.localeCompare(a.meeting_date));
  const lastSeen = observations[0]?.meeting_date || null;
  const inWindow = observations.some((row) => row.meeting_date >= windowStart);
  const hasKnownPublicationHome = Boolean(source.source_url || probe.url);
  const gapClass = hasKnownPublicationHome ? "a" : "b";
  const taxonomyClass = hasKnownPublicationHome ? "not_yet_ingested" : "not_published";
  const severity = inWindow ? "none" : lastSeen ? "high" : "unknown";
  return {
    body_id: source.body_id,
    name: source.name,
    borough: source.borough,
    source_url: source.source_url || probe.url || null,
    expected_deliverable: "minutes",
    expected_window_start: windowStart,
    expected_window_months: TRAILING_MONTHS,
    gap_class: gapClass,
    taxonomy_class: taxonomyClass,
    severity,
    last_minutes_observed_at: lastSeen,
    last_seen: lastSeen,
    observed_in_trailing_window: inWindow,
    observation_count: observations.length,
    receipt_status: probe.status,
  };
}
function buildReport(registry, receipt) {
  assertRegistry(registry);
  const byId = validateReceipt(registry, receipt);
  const asOf = dateOnly(receipt.as_of);
  if (!asOf) throw new Error("probe receipt requires an as_of date");
  const windowStart = subtractMonths(asOf, TRAILING_MONTHS);
  const rows = communityBoards(registry).map((source) => classify(source, byId.get(source.body_id), windowStart));
  return {
    schema: REPORT_SCHEMA,
    generated_at: receipt.generated_at,
    as_of: asOf,
    expected_set: { body_type: "community_board", count: 59, deliverable: "minutes", trailing_months: TRAILING_MONTHS, window_start: windowStart, mandate_source: AUDIT_URL },
    provenance: { registry: "site/data/non_council_outcome_sources/source_registry.json", probes: "site/data/non_council_outcome_sources/verification_receipts/cb_minutes_publication_probes.json" },
    rows,
    summary: {
      boards: rows.length,
      covered: rows.filter((row) => row.observed_in_trailing_window).length,
      gaps: rows.filter((row) => !row.observed_in_trailing_window).length,
      class_a: rows.filter((row) => row.gap_class === "a").length,
      class_b: rows.filter((row) => row.gap_class === "b").length,
    },
  };
}
async function main() {
  const mode = process.argv[2] || "--check";
  const registry = readJson(REGISTRY_PATH);
  assertRegistry(registry);
  if (mode === "--probe") {
    const asOf = process.argv[3] || new Date().toISOString().slice(0, 10);
    const generatedAt = new Date().toISOString();
    const probes = [];
    for (const source of communityBoards(registry)) {
      probes.push(source.source_url ? await fetchProbe(source, generatedAt) : emptyProbe(source));
    }
    writeJson(RECEIPT_PATH, { schema: RECEIPT_SCHEMA, generated_at: generatedAt, as_of: asOf, expected_window: "trailing_12_months", mandate_source: AUDIT_URL, probes });
  }
  const receipt = readJson(RECEIPT_PATH);
  const report = buildReport(registry, receipt);
  if (mode === "--check") {
    const committed = readJson(REPORT_PATH);
    if (JSON.stringify(committed) !== JSON.stringify(report)) throw new Error("gap report is stale; run the detector to rebuild it");
    console.log(`ok: ${report.rows.length} boards, ${report.summary.gaps} trailing-12-month gaps`);
    return;
  }
  if (mode === "--probe") { writeJson(REPORT_PATH, report); console.log(`wrote ${RECEIPT_PATH} and ${REPORT_PATH}`); return; }
  throw new Error(`usage: ${process.argv[1]} --probe [YYYY-MM-DD] | --check`);
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
