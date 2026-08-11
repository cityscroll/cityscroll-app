#!/usr/bin/env node
/**
 * Densify rule_evidence stamps from City Record GetFile PDF attachments when
 * SODA body fields are empty (modern Agency Rules common case).
 *
 * Re-stamps body_topic_keys + citation_keys only; never commits PDF prose.
 *
 *   node tools/densify_rule_evidence_attachments.mjs --ids 20260708002,20260605008
 *   node tools/densify_rule_evidence_attachments.mjs --from-fixture
 *   node tools/densify_rule_evidence_attachments.mjs --limit 12
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

import {
  extractRuleEvidenceStamp,
  RULE_EVIDENCE_STAMP_SCHEMA,
} from "../site/rule_evidence_stamps.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RULES = join(ROOT, "site/data/rules_domain_observations.json");
const FIXTURE = join(ROOT, "test/fixtures/rule_attachment_text.json");
const RECEIPT = join(
  ROOT,
  "docs/evidence/mandate-rule-attachment-densify/receipt.json",
);
const CITY_RECORD = "https://a856-cityrecord.nyc.gov";
const UA = "CityScrollBot/1.0 (+https://cityscroll.org; rule-evidence densify)";

function parseArgs(argv) {
  const out = {
    fromFixture: false,
    ids: null,
    limit: 16,
    delayMs: 1200,
    dryRun: false,
    force: false,
  };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--from-fixture") out.fromFixture = true;
    else if (argv[i] === "--dry-run") out.dryRun = true;
    else if (argv[i] === "--force") out.force = true;
    else if (argv[i] === "--limit") out.limit = Number(argv[++i]) || 16;
    else if (argv[i] === "--delay-ms") out.delayMs = Number(argv[++i]) || 1200;
    else if (argv[i] === "--ids") {
      out.ids = String(argv[++i] || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function needsDensify(stamp) {
  if (!stamp || stamp.schema !== RULE_EVIDENCE_STAMP_SCHEMA) return true;
  const bodyEmpty = !Array.isArray(stamp.body_topic_keys) || stamp.body_topic_keys.length === 0;
  const citeEmpty = !Array.isArray(stamp.citation_keys) || stamp.citation_keys.length === 0;
  return bodyEmpty || citeEmpty;
}

function mergeStamp(previous, next) {
  // Prefer densified body/citation; keep title topic keys when densify adds little.
  const topic = [...new Set([
    ...(Array.isArray(next?.topic_keys) ? next.topic_keys : []),
    ...(Array.isArray(previous?.topic_keys) ? previous.topic_keys : []),
  ])].slice(0, 32);
  return {
    schema: RULE_EVIDENCE_STAMP_SCHEMA,
    topic_keys: topic,
    body_topic_keys: (next?.body_topic_keys?.length ? next.body_topic_keys : previous?.body_topic_keys) || [],
    citation_keys: (next?.citation_keys?.length ? next.citation_keys : previous?.citation_keys) || [],
    lifecycle_status: next?.lifecycle_status || previous?.lifecycle_status || "unknown",
    effective_date: next?.effective_date ?? previous?.effective_date ?? null,
    adoption_date: next?.adoption_date ?? previous?.adoption_date ?? null,
    negative_evidence: (next?.negative_evidence?.length
      ? next.negative_evidence
      : previous?.negative_evidence) || [],
  };
}

async function extractGetFileDocumentId(requestId) {
  const res = await fetch(`${CITY_RECORD}/RequestDetail/${encodeURIComponent(requestId)}`, {
    headers: { "User-Agent": UA, Accept: "text/html" },
  });
  if (!res.ok) throw new Error(`RequestDetail HTTP ${res.status} for ${requestId}`);
  const html = await res.text();
  const match = html.match(/GetFile\?([^"'>\s]+)/i);
  if (!match) return null;
  const params = new URLSearchParams(match[1].replace(/&amp;/g, "&"));
  return {
    documentId: params.get("documentId"),
    sectionId: params.get("sectionId") || "4",
    requestStatus: params.get("requestStatus") || "Archived",
  };
}

async function fetchPdfBytes(requestId, meta) {
  const url = `${CITY_RECORD}/Search/GetFile?sectionId=${encodeURIComponent(meta.sectionId)}`
    + `&requestId=${encodeURIComponent(requestId)}`
    + `&requestStatus=${encodeURIComponent(meta.requestStatus)}`
    + `&documentId=${encodeURIComponent(meta.documentId)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/pdf,*/*" },
  });
  if (!res.ok) throw new Error(`GetFile HTTP ${res.status} for ${requestId}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 5 || buf.subarray(0, 4).toString("utf8") !== "%PDF") {
    throw new Error(`GetFile did not return a PDF for ${requestId}`);
  }
  return buf;
}

function pdfToText(bytes, requestId) {
  const path = join(tmpdir(), `crol-rule-${requestId}-${process.pid}.pdf`);
  writeFileSync(path, bytes);
  try {
    return execFileSync("pdftotext", [path, "-"], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
  } finally {
    try { unlinkSync(path); } catch { /* ignore */ }
  }
}

export function densifyRulesFromAttachmentText(rulesDoc, textById = {}, { force = false } = {}) {
  const rows = Array.isArray(rulesDoc?.rows) ? rulesDoc.rows : [];
  let densified = 0;
  const nextRows = rows.map((row) => {
    const id = String(row.request_id || "");
    const text = textById[id];
    if (!text) return row;
    if (!force && !needsDensify(row.rule_evidence)) return row;
    const stamped = extractRuleEvidenceStamp({
      short_title: row.short_title,
      type_of_notice_description: row.type_of_notice_description,
      additional_description_1: text.slice(0, 40_000),
    });
    densified += 1;
    return {
      ...row,
      rule_evidence: force ? stamped : mergeStamp(row.rule_evidence, stamped),
      rule_evidence_densify: {
        method: "city_record_getfile_pdf_v1",
        source: "attachment_text",
      },
    };
  });
  return {
    doc: {
      ...rulesDoc,
      rows: nextRows,
      rule_evidence_attachment_densified_at: new Date().toISOString(),
    },
    densified,
  };
}

async function densifyLive(rulesDoc, { ids, limit, delayMs, force = false }) {
  const targets = (rulesDoc.rows || [])
    .filter((row) => (!ids || ids.includes(String(row.request_id)))
      && (force || needsDensify(row.rule_evidence)))
    .slice(0, limit);
  const textById = Object.create(null);
  const failures = [];
  for (const row of targets) {
    const id = String(row.request_id);
    try {
      const meta = await extractGetFileDocumentId(id);
      if (!meta?.documentId) {
        failures.push({ request_id: id, error: "no_getfile_document" });
        await sleep(delayMs);
        continue;
      }
      const pdf = await fetchPdfBytes(id, meta);
      const text = pdfToText(pdf, id);
      if (text && text.trim().length > 40) textById[id] = text;
      else failures.push({ request_id: id, error: "empty_pdf_text" });
    } catch (err) {
      failures.push({ request_id: id, error: String(err?.message || err) });
    }
    await sleep(delayMs);
  }
  return { textById, failures, attempted: targets.map((r) => r.request_id) };
}

async function main() {
  const args = parseArgs(process.argv);
  if (!existsSync(RULES)) throw new Error(`missing ${RULES}`);
  const rulesDoc = JSON.parse(readFileSync(RULES, "utf8"));
  let textById = Object.create(null);
  let failures = [];
  let attempted = [];

  if (args.fromFixture) {
    if (!existsSync(FIXTURE)) throw new Error(`missing ${FIXTURE}`);
    textById = JSON.parse(readFileSync(FIXTURE, "utf8"));
    attempted = Object.keys(textById);
  } else {
    const live = await densifyLive(rulesDoc, args);
    textById = live.textById;
    failures = live.failures;
    attempted = live.attempted;
  }

  const { doc, densified } = densifyRulesFromAttachmentText(rulesDoc, textById, {
    force: args.force,
  });
  if (!args.dryRun && densified > 0) {
    writeFileSync(RULES, `${JSON.stringify(doc, null, 2)}\n`);
  }
  mkdirSync(dirname(RECEIPT), { recursive: true });
  const receipt = {
    schema: "cityscroll.mandate_rule_attachment_densify.v1",
    built_at: new Date().toISOString(),
    method: args.fromFixture ? "fixture" : "city_record_getfile_pdf_v1",
    attempted_count: attempted.length,
    densified_count: densified,
    densified_ids: Object.keys(textById).sort(),
    failures,
  };
  writeFileSync(RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(
    `${args.dryRun ? "dry-run" : "wrote"} rules densify densified=${densified} attempted=${attempted.length} failures=${failures.length}`,
  );
  console.log(`receipt ${RECEIPT}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
