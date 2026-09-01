#!/usr/bin/env node

/**
 * Generic private-identifier scan.
 *
 * This module contains no private identifier. It is a term-agnostic matcher: the
 * term set is supplied at run time from an owner-controlled file or environment
 * value that lives outside this repository. Public tests exercise it with an
 * obviously synthetic sentinel codename, so the committed tree never has to carry
 * the real term in order to prove the gate works.
 *
 * Two modes:
 *
 *   public  (default)  A term set is optional. Without one the scan reports
 *                      SKIPPED and exits 0, so public CI stays credential-free.
 *   private (--private) A term set is required. Without one the scan FAILS
 *                      closed, so an owner-controlled run can never pass by
 *                      quietly having nothing to look for.
 *
 * Output discipline: a finding never echoes a term, a matched substring, or a
 * path whose own text matches. Matching paths are reported as stable per-run
 * ordinals under their parent directory. The detailed inventory is only ever
 * written to an explicit --private-inventory destination, which belongs in the
 * private evidence lane, never in this repository.
 */

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { isolatedGitEnv } from "./architecture_evidence_shards.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const RECEIPT_SCHEMA = "cityscroll.private_identifier_scan_receipt.v1";

/**
 * The supported normalization contract, versioned so a receipt states exactly
 * which decoding rules a pass was made under. Bump this when a rule is added or
 * changed; do not silently widen it.
 *
 * This is a normalization contract, not an obfuscation-defeating claim. It
 * decodes mechanical, reversible representations. It does not, and does not
 * claim to, detect encryption or arbitrary obfuscation.
 */
export const NORMALIZATION_VERSION = "private-identifier-normalization.v1";

export const NORMALIZATION_RULES = Object.freeze([
  "literal",
  "case-fold",
  "unicode-normalize",
  "json-unicode-escape",
  "braced-unicode-escape",
  "hex-escape",
  "percent-encoding",
  "html-entity-decimal",
  "html-entity-hex",
  "base64-run",
  "char-code-sequence",
  "quoted-fragment-join",
]);

const BINARY_SNIFF_BYTES = 8192;
const MIN_BASE64_RUN = 12;
const BASE64_RUN_TRIGGER = /[A-Za-z0-9+/=]{12,}/;
const QUOTE_TRIGGER = /["'`]/;
const LAYERED_DECODE_ROUNDS = 4;

const NON_ASCII = /[^\x00-\x7f]/;

function caseFold(value) {
  return value.toLowerCase();
}

function unicodeNormalize(value) {
  // NFKD then strip combining marks catches decomposed and accented lookalikes;
  // NFKC then folds compatibility forms (fullwidth, ligatures) onto ASCII.
  // Pure ASCII is already in that form, and skipping it there keeps a
  // whole-repository scan from paying Unicode normalization on every line.
  if (!NON_ASCII.test(value)) return value;
  return value.normalize("NFKD").replace(/\p{M}+/gu, "").normalize("NFKC");
}

function decodeBracedUnicodeEscapes(value) {
  return value.replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (match, hex) => {
    const code = Number.parseInt(hex, 16);
    return code > 0x10ffff ? match : String.fromCodePoint(code);
  });
}

function decodeJsonUnicodeEscapes(value) {
  return value.replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function decodeHexEscapes(value) {
  return value.replace(/\\x([0-9a-fA-F]{2})/g, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function decodePercentEncoding(value) {
  return value.replace(/%([0-9a-fA-F]{2})/g, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function decodeDecimalEntities(value) {
  return value.replace(/&#(\d{1,7});?/g, (match, digits) => {
    const code = Number.parseInt(digits, 10);
    return code > 0x10ffff ? match : String.fromCodePoint(code);
  });
}

function decodeHexEntities(value) {
  return value.replace(/&#x([0-9a-fA-F]{1,6});?/gi, (match, hex) => {
    const code = Number.parseInt(hex, 16);
    return code > 0x10ffff ? match : String.fromCodePoint(code);
  });
}

/**
 * Decode standalone base64-looking runs and append what they contain. A committed
 * digest, allowlist token, or data blob is a mechanical encoding of its plaintext,
 * so a private identifier hidden inside one is still on the public tip.
 */
function decodeBase64Runs(value) {
  const decoded = [];
  const runs = value.match(/[A-Za-z0-9+/=]{12,}/g) || [];
  for (const run of runs) {
    const trimmed = run.replace(/=+$/, "");
    if (trimmed.length < MIN_BASE64_RUN) continue;
    let text;
    try {
      text = Buffer.from(run, "base64").toString("utf8");
    } catch {
      continue;
    }
    if (!text) continue;
    // Keep only runs that decode to plausible text; random hex and binary blobs
    // decode to mojibake and would otherwise add noise without adding coverage.
    const printable = text.replace(/[^\t\n\r\x20-\x7e]/g, "");
    if (printable.length < text.length * 0.8) continue;
    decoded.push(printable);
  }
  return decoded;
}

/**
 * Decode an identifier spelled as a character-code argument list, the
 * `fromCharCode(107, 114, ...)` and `fromCodePoint(0x6b, ...)` shape. Scoped to
 * those explicit calls so ordinary numeric data is not swept in.
 */
function decodeCharCodeSequences(value) {
  const decoded = [];
  const pattern = /from(?:CharCode|CodePoint)\s*\(\s*((?:0x[0-9a-fA-F]+|\d+)(?:\s*,\s*(?:0x[0-9a-fA-F]+|\d+))*)\s*\)/g;
  let match;
  while ((match = pattern.exec(value)) !== null) {
    const codes = match[1].split(",").map((part) => {
      const token = part.trim();
      return token.startsWith("0x") || token.startsWith("0X")
        ? Number.parseInt(token.slice(2), 16)
        : Number.parseInt(token, 10);
    });
    if (codes.some((code) => !Number.isFinite(code) || code < 0 || code > 0x10ffff)) continue;
    decoded.push(String.fromCodePoint(...codes));
  }
  return decoded;
}

/**
 * Rebuild an identifier that was split across adjacent quoted string fragments.
 * Concatenating every quoted literal on a line reconstructs the common
 * `"frag" + "ment"` and `["frag", "ment"].join("")` evasions.
 */
function joinQuotedFragments(value) {
  const parts = [];
  const pattern = /"([^"\\\n]*)"|'([^'\\\n]*)'|`([^`\\\n]*)`/g;
  let match;
  while ((match = pattern.exec(value)) !== null) {
    parts.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  if (parts.length < 2) return null;
  return parts.join("");
}

/**
 * Produce every normalized view of one candidate string, each labelled with the
 * rule that produced it, so a finding can name how a match was reached without
 * quoting what was matched.
 */
export function normalizedViews(value) {
  const raw = String(value ?? "");
  const views = [];
  const seen = new Set();
  const add = (rule, text) => {
    if (!text) return;
    const key = `${rule} ${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    views.push({ rule, text });
  };

  const folded = caseFold(unicodeNormalize(raw));
  add("literal", folded);
  if (folded !== caseFold(raw)) add("unicode-normalize", folded);

  // Each decoder runs only when its own syntax is present. The trigger is a
  // plain substring test, so an ordinary line costs one scan rather than a full
  // decode pass per rule, and a line that does carry an encoding still gets
  // every applicable rule.
  const decoders = [
    ["braced-unicode-escape", "\\u{", decodeBracedUnicodeEscapes],
    ["json-unicode-escape", "\\u", decodeJsonUnicodeEscapes],
    ["hex-escape", "\\x", decodeHexEscapes],
    ["percent-encoding", "%", decodePercentEncoding],
    ["html-entity-decimal", "&#", decodeDecimalEntities],
    ["html-entity-hex", "&#x", decodeHexEntities],
  ];

  for (const [rule, trigger, decode] of decoders) {
    if (!raw.includes(trigger)) continue;
    add(rule, caseFold(unicodeNormalize(decode(raw))));
  }

  // Applying every applicable decoder repeatedly, to a fixed point, resolves a
  // layered encoding that no single rule undoes on its own and that one ordered
  // pass would miss when an outer layer only reveals an inner one after it is
  // decoded. The round cap keeps a pathological input bounded.
  let layered = raw;
  for (let round = 0; round < LAYERED_DECODE_ROUNDS; round += 1) {
    let next = layered;
    for (const [, trigger, decode] of decoders) {
      if (!next.includes(trigger)) continue;
      next = decode(next);
    }
    if (next === layered) break;
    layered = next;
  }
  if (layered !== raw) add("layered-decode", caseFold(unicodeNormalize(layered)));

  if (BASE64_RUN_TRIGGER.test(raw)) {
    for (const text of decodeBase64Runs(raw)) {
      add("base64-run", caseFold(unicodeNormalize(text)));
    }
  }

  if (raw.includes("fromCharCode") || raw.includes("fromCodePoint")) {
    for (const text of decodeCharCodeSequences(raw)) {
      add("char-code-sequence", caseFold(unicodeNormalize(text)));
    }
  }

  if (QUOTE_TRIGGER.test(layered)) {
    const joined = joinQuotedFragments(layered);
    if (joined) add("quoted-fragment-join", caseFold(unicodeNormalize(joined)));
  }

  return views;
}

function matchTerms(value, terms) {
  const hits = [];
  const views = normalizedViews(value);
  for (const [index, term] of terms.entries()) {
    for (const view of views) {
      if (view.text.includes(term)) {
        hits.push({ term_ref: `term-${String(index + 1).padStart(2, "0")}`, rule: view.rule });
        break;
      }
    }
  }
  return hits;
}

export function loadTermSet({ termsFile = null, termsValue = null, env = process.env } = {}) {
  const file = termsFile || env.PRIVATE_IDENTIFIER_TERMS_FILE || null;
  const inline = termsValue ?? env.PRIVATE_IDENTIFIER_TERMS ?? null;
  const collected = [];
  if (file) {
    const resolved = resolve(file);
    if (!existsSync(resolved)) {
      return { terms: [], source: "file", error: `term set file is not readable: ${resolved}` };
    }
    collected.push(...readFileSync(resolved, "utf8").split(/\r?\n/));
  }
  if (inline) collected.push(...String(inline).split(/[\n,]/));
  const terms = [...new Set(
    collected
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => caseFold(unicodeNormalize(line))),
  )];
  return { terms, source: file ? "file" : inline ? "inline" : "none", error: null };
}

function git(root, args, { encoding = "utf8" } = {}) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding,
    maxBuffer: 1024 * 1024 * 512,
    // A Git hook exports GIT_DIR and friends. Without clearing them, `-C root`
    // would change directory while still resolving against the host repository,
    // so a scan of one tree would silently read another.
    env: isolatedGitEnv(),
  });
  if (result.status !== 0) {
    const stderr = typeof result.stderr === "string" ? result.stderr : String(result.stderr || "");
    throw new Error(stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout;
}

function looksBinary(buffer) {
  const head = buffer.subarray(0, BINARY_SNIFF_BYTES);
  return head.includes(0);
}

/**
 * Enumerate every tracked path and its content. With no revision this reads the
 * working tree, including symlink targets. With a revision it reads the tree
 * object, so the default branch and any pull-request head can be scanned from
 * one checkout without touching the working tree.
 */
function collectSubjects({ root, rev }) {
  const subjects = [];
  if (rev) {
    const listing = git(root, ["ls-tree", "-r", "-z", rev]);
    for (const record of listing.split("\0").filter(Boolean)) {
      const tabIndex = record.indexOf("\t");
      if (tabIndex < 0) continue;
      const [mode, type, oid] = record.slice(0, tabIndex).split(/\s+/);
      const path = record.slice(tabIndex + 1);
      if (type !== "blob") continue;
      const buffer = spawnSync("git", ["-C", root, "cat-file", "blob", oid], {
        maxBuffer: 1024 * 1024 * 512,
        env: isolatedGitEnv(),
      }).stdout;
      if (mode === "120000") {
        subjects.push({ path, kind: "symlink", text: buffer.toString("utf8") });
        continue;
      }
      subjects.push({ path, kind: "file", text: buffer && !looksBinary(buffer) ? buffer.toString("utf8") : null });
    }
    return subjects;
  }
  const listing = git(root, ["ls-files", "-z"]);
  for (const path of listing.split("\0").filter(Boolean)) {
    const filePath = join(root, path);
    let stats;
    try {
      stats = lstatSync(filePath);
    } catch {
      subjects.push({ path, kind: "missing", text: null });
      continue;
    }
    if (stats.isSymbolicLink()) {
      subjects.push({ path, kind: "symlink", text: readlinkSync(filePath) });
      continue;
    }
    let buffer;
    try {
      buffer = readFileSync(filePath);
    } catch {
      subjects.push({ path, kind: "unreadable", text: null });
      continue;
    }
    subjects.push({ path, kind: "file", text: looksBinary(buffer) ? null : buffer.toString("utf8") });
  }
  return subjects;
}

/**
 * Scan tracked paths and tracked textual content for an owner-supplied term set.
 * Returns both a public-safe receipt and a private inventory; only the receipt
 * is ever printed.
 */
export function scanPrivateIdentifiers({ root = ROOT, rev = null, terms = [] } = {}) {
  const subjects = collectSubjects({ root, rev });
  const findings = [];
  const inventory = [];
  const redactedPaths = new Map();

  const pathMatches = new Map();
  for (const subject of subjects) {
    const hits = matchTerms(subject.path, terms);
    if (hits.length) pathMatches.set(subject.path, hits);
  }

  const safePath = (path) => {
    if (!pathMatches.has(path)) return path;
    if (!redactedPaths.has(path)) {
      const parent = dirname(path);
      redactedPaths.set(path, `${parent === "." ? "" : `${parent}/`}<redacted-path-${redactedPaths.size + 1}>`);
    }
    return redactedPaths.get(path);
  };

  for (const subject of subjects) {
    for (const hit of pathMatches.get(subject.path) || []) {
      findings.push({ surface: "path", path: safePath(subject.path), line: null, rule: hit.rule, term_ref: hit.term_ref });
      inventory.push({ surface: "path", path: subject.path, line: null, rule: hit.rule, term_ref: hit.term_ref, context: subject.path });
    }
    if (subject.text === null) continue;
    const surface = subject.kind === "symlink" ? "symlink-target" : "content";
    subject.text.split(/\r?\n/).forEach((line, index) => {
      for (const hit of matchTerms(line, terms)) {
        findings.push({ surface, path: safePath(subject.path), line: index + 1, rule: hit.rule, term_ref: hit.term_ref });
        inventory.push({ surface, path: subject.path, line: index + 1, rule: hit.rule, term_ref: hit.term_ref, context: line.trim().slice(0, 400) });
      }
    });
  }

  const scannedTextual = subjects.filter((subject) => subject.text !== null).length;
  return {
    status: findings.length ? "FAIL" : "PASS",
    findings,
    inventory,
    scanned_path_count: subjects.length,
    scanned_textual_path_count: scannedTextual,
    scanned_symlink_count: subjects.filter((subject) => subject.kind === "symlink").length,
  };
}

export function buildReceipt({ mode, revision, terms, result, termError }) {
  const base = {
    schema: RECEIPT_SCHEMA,
    mode,
    revision: revision || "working-tree",
    normalization_version: NORMALIZATION_VERSION,
    normalization_rules: NORMALIZATION_RULES,
    private_terms_supplied: terms.length > 0,
    private_term_count: terms.length,
    credential_free: true,
  };
  if (termError) {
    return { ...base, status: "FAIL", reason: termError, scanned_path_count: 0, match_count: 0, findings: [] };
  }
  if (!terms.length) {
    if (mode === "private") {
      return {
        ...base,
        status: "FAIL",
        reason: "private mode requires an owner-supplied private-identifier term set; refusing to report a pass with nothing to match",
        scanned_path_count: 0,
        match_count: 0,
        findings: [],
      };
    }
    return {
      ...base,
      status: "SKIPPED",
      reason: "no owner-supplied private-identifier term set; public mode scans nothing and asserts nothing",
      scanned_path_count: 0,
      match_count: 0,
      findings: [],
    };
  }
  return {
    ...base,
    status: result.status,
    reason: result.status === "PASS"
      ? "private-identifier boundary held across every tracked path and tracked textual file"
      : "private-identifier boundary violated; the detailed inventory is private",
    scanned_path_count: result.scanned_path_count,
    scanned_textual_path_count: result.scanned_textual_path_count,
    scanned_symlink_count: result.scanned_symlink_count,
    match_count: result.findings.length,
    findings: result.findings,
  };
}

function argument(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || fallback : fallback;
}

export function main(argv = process.argv.slice(2)) {
  const mode = argv.includes("--private") ? "private" : "public";
  const root = resolve(argument(argv, "--root", ROOT));
  const rev = argument(argv, "--rev", null);
  const termsFile = argument(argv, "--terms-file", null);
  const inventoryPath = argument(argv, "--private-inventory", null);
  // Scanning is read-only. Depositing the detailed inventory is a separate write
  // mode, requested explicitly by --private-inventory and never entered otherwise,
  // so a check-mode run cannot mutate anything.
  const write = Boolean(inventoryPath);
  // Validate the destination before doing any work: a run that cannot legally
  // deposit its output should refuse immediately, not after a full scan.
  const resolvedInventory = write ? resolve(inventoryPath) : null;
  if (write && resolvedInventory.startsWith(`${root}/`)) {
    console.error("private-identifier scan: refusing to write the private inventory inside the public repository");
    process.exitCode = 2;
    return null;
  }

  const loaded = loadTermSet({ termsFile });

  let result = { status: "PASS", findings: [], inventory: [], scanned_path_count: 0, scanned_textual_path_count: 0, scanned_symlink_count: 0 };
  if (loaded.terms.length && !loaded.error) {
    result = scanPrivateIdentifiers({ root, rev, terms: loaded.terms });
  }

  const receipt = buildReceipt({ mode, revision: rev, terms: loaded.terms, result, termError: loaded.error });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);

  if (write) {
    writeFileSync(resolvedInventory, `${JSON.stringify({
      schema: "cityscroll.private_identifier_scan_inventory.v1",
      revision: rev || "working-tree",
      normalization_version: NORMALIZATION_VERSION,
      matches: result.inventory,
    }, null, 2)}\n`, "utf8");
  }

  if (receipt.status === "FAIL") process.exitCode = 1;
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`private-identifier scan failed: ${error?.message || error}`);
    process.exitCode = 2;
  }
}

export { ROOT };
