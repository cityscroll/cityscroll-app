#!/usr/bin/env node
/**
 * Fail when a reader-facing collapsed-group label says only that rows were grouped.
 *
 * The check is lens-neutral: every JavaScript/HTML surface under site/
 * is checked. Labels may include counts and words such as "similar", but must also
 * name shared content (subject, agency, notice type, or another known fact).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { repeatedSameExceptFindings } from "../site/same_consolidation.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SOURCE_EXTENSIONS = new Set([".html", ".js", ".mjs"]);
const GROUP_KEY = /(?:cluster|collapse|collapsed|group).*(?:summary|label|title)|(?:summary|label|title).*(?:cluster|collapse|collapsed|group)/i;
const STRING_ENTRY = /\b([A-Za-z0-9_]+)\s*:\s*(["'`])([^\n]*?)\2/g;
const COUNT_MARKERS = /\{[A-Za-z0-9_]+\}|\$\{[^}]+\}|\b\d+\b/g;
const GENERIC_WORDS = new Set([
  "a", "an", "the", "and", "or", "of", "only", "other", "near", "identical",
  "nearidentical", "similar", "notice", "notices", "item", "items", "entry", "entries",
  "record", "records", "result", "results", "group", "groups", "grouped", "collapsed",
]);

export function hasCollapsedGroupDescription(label) {
  if (/\{(?:description|subject|agency|type)\}/i.test(String(label || ""))) return true;
  const withoutCounts = String(label || "").replace(COUNT_MARKERS, " ");
  // Translated catalogs use non-Latin scripts that the English generic-word
  // list cannot classify. Their visible lexical content is description enough
  // here; locale-specific copy gates own translation quality.
  if (/[^\x00-\x7F]/.test(withoutCounts.replace(/[\s\p{P}\p{S}]/gu, ""))) return true;
  const words = withoutCounts
    .replace(COUNT_MARKERS, " ")
    .toLowerCase()
    .replace(/near[- ]identical/g, "nearidentical")
    .match(/[a-z][a-z'-]*/g) || [];
  return words.some((word) => word.length >= 3 && !GENERIC_WORDS.has(word));
}

export function findCollapsedGroupLabelFindings(source, file = "<source>") {
  const findings = [];
  const lines = String(source || "").split(/\r?\n/);
  lines.forEach((line, index) => {
    STRING_ENTRY.lastIndex = 0;
    for (const match of line.matchAll(STRING_ENTRY)) {
      const [, key, , label] = match;
      if (!GROUP_KEY.test(key)) continue;
      if (hasCollapsedGroupDescription(label)) continue;
      findings.push({ file, line: index + 1, key, label });
    }

    // Catch direct visible strings/templates even when they are not stored in a
    // conventionally named catalog key.
    const direct = line.match(/(["'`])((?:\{[A-Za-z0-9_]+\}|\$\{[^}]+\}|\d+)\s+(?:near[- ]identical|similar)\s+(?:notices?|items?|records?))\1/i);
    if (direct && !hasCollapsedGroupDescription(direct[2])) {
      const duplicate = findings.some((finding) => finding.line === index + 1);
      if (!duplicate) findings.push({ file, line: index + 1, key: null, label: direct[2] });
    }
  });
  return findings;
}

function sourceFiles(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) files.push(...sourceFiles(path));
    else if (SOURCE_EXTENSIONS.has(extname(name))) files.push(path);
  }
  return files;
}

export function auditCollapsedGroupLabels(root = join(ROOT, "site")) {
  return sourceFiles(root).flatMap((path) =>
    findCollapsedGroupLabelFindings(readFileSync(path, "utf8"), relative(ROOT, path)),
  );
}

export function findUnconsolidatedSameExceptRows(rows, options) {
  return repeatedSameExceptFindings(rows, options);
}

const STAFFING_DISPLAY_FIELDS = [
  "role", "person", "agency", "effective_date", "salary", "title_code", "published_at",
];

/**
 * Census-backed wiring check for qualifying exact repeats on list surfaces.
 * Meetings and Property already enter their lifecycle/cluster view models before
 * rendering. The appointment feed is the current exact same-except-one activation.
 */
export function auditUnconsolidatedRepeatedRows(root = ROOT) {
  const require = createRequire(import.meta.url);
  const Staffing = require(join(root, "site/staffing.js"));
  const snapshot = JSON.parse(readFileSync(join(root, "site/data/staffing_default_hires.json"), "utf8"));
  const crosswalk = JSON.parse(readFileSync(join(root, "site/data/title_crosswalk.json"), "utf8"));
  const rows = Staffing.hireNotices(snapshot.notices, crosswalk);
  const repeats = findUnconsolidatedSameExceptRows(rows, {
    fields: STAFFING_DISPLAY_FIELDS,
    except: ["person"],
    threshold: 3,
  });
  if (!repeats.length) return [];

  const renderer = readFileSync(join(root, "site/app/people.mjs"), "utf8");
  const grouping = readFileSync(join(root, "site/same_consolidation.mjs"), "utf8");
  const inlineRenderer = /groupSameExcept\(items\s*,/.test(renderer)
    && /members\.map\(staffingGroupMemberHTML\)/.test(renderer);
  const lazyRenderer = /staffingAppointmentListHTML\(items\)/.test(renderer)
    && /groupSameExcept\(items\s*,/.test(grouping)
    && /members\.map\(\(member\) => staffingGroupMemberHTML\(member, ui\)\)/.test(grouping);
  if (inlineRenderer || lazyRenderer) {
    return [];
  }
  return repeats.map((finding) => ({ ...finding, lens: "people", file: "site/app/people.mjs" }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const labelFindings = auditCollapsedGroupLabels();
  const repeatFindings = auditUnconsolidatedRepeatedRows();
  if (labelFindings.length || repeatFindings.length) {
    console.error(`collapsed-group integrity: ${labelFindings.length} generic label(s), ${repeatFindings.length} unconsolidated repeated group(s)`);
    for (const finding of labelFindings) {
      console.error(`  ${finding.file}:${finding.line} ${JSON.stringify(finding.label)}`);
    }
    for (const finding of repeatFindings) {
      console.error(`  ${finding.file} ${finding.count} rows differ only by ${finding.differing_fields.join(", ")}`);
    }
    process.exitCode = 1;
  } else {
    console.log("collapsed-group integrity OK — labels describe shared content and qualifying repeated rows are consolidated.");
  }
}
