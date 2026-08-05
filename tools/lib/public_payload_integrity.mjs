import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const FIX_ID = /(?:^|[:/#_-])FIX[A-Z0-9_-]{2,}(?=$|[^A-Z0-9_-])/;
const FIXTURE_KEY = /(?:^|[:/#_-])FIXTURE[-_:][A-Z0-9_-]+(?=$|[^A-Z0-9_-])/i;
const SYNTHETIC_KEY = /(?:^|[:/#_-])SYNTHETIC[-_:][A-Z0-9_-]+(?=$|[^A-Z0-9_-])/i;
const TEST_DISPLAY = /\b(?:synthetic\s+(?:fixture|row|record|award|project|vendor|applicant|payment|test)|fixture\s+(?:row|vendor|applicant|project|payment|street|record|award|test|one|two|three|four|five|six|seven|eight|nine|\d+)|acme\s+widgets)\b/i;
const DISPLAY_KEY = /(?:^|_)(?:title|name|label|description|summary|display|text|note)(?:_|$)/i;
const ID_KEY = /(?:^|_)(?:id|ref|key|pin|contract|notice|project)(?:_|$)/i;
const PHONE_KEY = /(?:^|_)(?:phone|telephone)(?:_|$)/i;
const PUBLIC_LOOKUP = /(?:^|\/)\w+_warehouse_lookup\.json$/;

function pathText(parts) {
  return parts.map(String).join(".");
}

function finding(source, parts, kind, value) {
  return {
    source,
    path: pathText(parts),
    kind,
    value: String(value).slice(0, 180),
  };
}

/** Findings that identify test-only records in a public JSON document. */
export function publicPayloadFindings(value, { source = "document" } = {}) {
  const findings = [];

  function walk(node, parts = []) {
    if (Array.isArray(node)) {
      node.forEach((entry, index) => walk(entry, [...parts, index]));
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, entry] of Object.entries(node)) walk(entry, [...parts, key]);
      return;
    }
    if (typeof node !== "string") return;

    const key = String(parts.at(-1) ?? "");
    if (FIX_ID.test(node) || (ID_KEY.test(key) && (FIXTURE_KEY.test(node) || SYNTHETIC_KEY.test(node)))) {
      findings.push(finding(source, parts, "test identifier", node));
      return;
    }
    if (DISPLAY_KEY.test(key) && TEST_DISPLAY.test(node)) {
      findings.push(finding(source, parts, "test display text", node));
      return;
    }
    if (PHONE_KEY.test(key) && /^555\d{4,}$/.test(node.replace(/\D/g, ""))) {
      findings.push(finding(source, parts, "reserved test phone", node));
      return;
    }
    if (key === "mode" && PUBLIC_LOOKUP.test(source) && /^fixture(?:_|$)/i.test(node)) {
      findings.push(finding(source, parts, "test build mode", node));
    }
  }

  walk(value);
  return findings;
}

export function recordIsPublic(record, source = "record") {
  return publicPayloadFindings(record, { source }).length === 0;
}

export function publicRecords(records, source = "records") {
  return (records || []).filter((record) => recordIsPublic(record, source));
}

function jsonFiles(root) {
  if (!statSync(root).isDirectory()) return [root];
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...jsonFiles(target));
    else if (entry.isFile() && entry.name.endsWith(".json")) out.push(target);
  }
  return out;
}

/** Check every shipped JSON payload under the supplied roots. */
export function publicPayloadTreeFindings(roots, { repoRoot = process.cwd() } = {}) {
  const findings = [];
  for (const root of roots) {
    for (const file of jsonFiles(root)) {
      const source = path.relative(repoRoot, file);
      const value = JSON.parse(readFileSync(file, "utf8"));
      findings.push(...publicPayloadFindings(value, { source }));
    }
  }
  return findings;
}

/** Reader-facing literal text uses the same low-noise marker vocabulary. */
export function publicTextFindings(text, { source = "surface" } = {}) {
  const findings = [];
  const lines = String(text).split(/\r?\n/);
  lines.forEach((line, index) => {
    if (FIX_ID.test(line) || TEST_DISPLAY.test(line)) {
      findings.push(finding(source, [index + 1], "test display text", line.trim()));
    }
  });
  return findings;
}
