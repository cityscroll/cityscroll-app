#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "2c310bcff9b71c3704493801ef23182375c5357d";
const OUTPUT = resolve(ROOT, "docs/repository-control-plane/evidence-placement.v1.json");
const PRIVATE_MARKER = ["backstage", "://", "cityscroll-evidence/"].join("");
const CARD = "cityscroll-repository-control-plane/rcp-03";

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fromBase(path) {
  return execFileSync("git", ["show", `${BASE}:${path}`], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 });
}

function tracked(ref = null) {
  const args = ref ? ["ls-tree", "-r", "--name-only", ref] : ["ls-files"];
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim().split("\n").filter(Boolean);
}

function occurrences(value) {
  return value.toString("utf8").split(PRIVATE_MARKER).length - 1;
}

function treeDigest(prefixes) {
  const listing = execFileSync("git", ["ls-tree", "-r", BASE, "--", ...prefixes], { cwd: ROOT, encoding: "utf8" });
  const rows = listing.trim().split("\n").filter(Boolean).map((line) => {
    const match = line.match(/^\d+ blob ([0-9a-f]+)\t(.+)$/);
    if (!match) throw new Error(`unexpected git tree row: ${line}`);
    return `${match[2]}\0${match[1]}\n`;
  });
  return { file_count: rows.length, sha256: sha(rows.join("")) };
}

function buildReceipt() {
  const classification = JSON.parse(fromBase("docs/repository-control-plane/classification.v1.json"));
  const classified = classification.entries.filter((entry) => entry.canonical_owner === CARD && entry.id.startsWith("private-uri:"));
  const evidencePaths = classified.map((entry) => entry.path);
  evidencePaths.push("docs/performance/content-parity/notice-context-critical-path/reports/index.html");
  const documentRows = [...new Set(evidencePaths)].sort().map((path) => {
    const bytes = fromBase(path);
    const refs = bytes.toString("utf8").split(/\s+/).filter((token) => token.includes(PRIVATE_MARKER));
    return {
      path,
      source_sha256: sha(bytes),
      private_reference_count: occurrences(bytes),
      private_reference_set_sha256: sha([...new Set(refs)].sort().join("\n")),
      classification: "owner-only-evidence-reference",
      disposition: `register:${CARD}#private-evidence`,
      maintainer_resolution: `register:${CARD}#authorized-maintainer-access`
    };
  });

  const scrim = fromBase("docs/repository-scrim-review.md").toString("utf8");
  const rows = [...scrim.matchAll(/^\| (PB-\d{4}) \|.*?\| ([^|]+) \| ([^|]+) \|/gm)];
  const byScope = Object.create(null);
  const byVerdict = Object.create(null);
  for (const row of rows) {
    const scope = row[2].trim();
    const verdict = row[3].trim();
    byScope[scope] = (byScope[scope] || 0) + 1;
    byVerdict[verdict] = (byVerdict[verdict] || 0) + 1;
  }

  const served = treeDigest(["site", "worker"]);
  return {
    schema: "cityscroll.repository_evidence_placement.v1",
    card: CARD,
    inspected_main_commit: BASE,
    generated_at: "2026-08-31T00:00:00.000Z",
    privacy_model: "placement-not-deletion",
    private_inventory: {
      scrim_review: {
        source_path_at_inspected_commit: "docs/repository-scrim-review.md",
        source_sha256: sha(Buffer.from(scrim)),
        row_count: rows.length,
        first_id: rows.at(0)?.[1],
        last_id: rows.at(-1)?.[1],
        row_ids_sha256: sha(rows.map((row) => row[1]).join("\n")),
        by_scope: byScope,
        by_verdict: byVerdict,
        classification: "private-generated-review-inventory",
        disposition: `register:${CARD}#scrim-inventory`,
        maintainer_resolution: `register:${CARD}#authorized-maintainer-access`
      },
      private_reference_documents: documentRows,
      document_count: documentRows.length,
      reference_count: documentRows.reduce((sum, row) => sum + row.private_reference_count, 0),
      unresolved_research_owner: `register:${CARD}#private-research`
    },
    public_result: {
      reviewed_at: "2026-08-04",
      conclusion: "The review classified 1,144 occurrences: 1,143 were intentional public or non-published local material, one obsolete tip entry was removed, and none required credential rotation or history rewriting.",
      raw_inventory_rows_retained: 0,
      private_reference_occurrences_retained_in_public_content: 0
    },
    bibliography_mapping: [
      { former_private_id: "699", public_citation: "Edward R. Tufte, The Visual Display of Quantitative Information, 2nd ed. (Graphics Press, 2001)." },
      { former_private_id: "851", public_citation: "Alan Cooper et al., About Face: The Essentials of Interaction Design, 4th ed. (Wiley, 2014)." },
      { former_private_id: "853", public_citation: "Don Norman, The Design of Everyday Things, rev. ed. (Basic Books, 2013)." },
      { former_private_id: "854", public_citation: "Steve Krug, Don't Make Me Think, Revisited, 3rd ed. (New Riders, 2014)." },
      { former_private_id: "1183", public_citation: "Richard T. Snodgrass, Developing Time-Oriented Database Applications in SQL (Morgan Kaufmann, 1999)." },
      { former_private_id: "1182", public_citation: null, disposition: `register:${CARD}#private-research`, reason: "The retained note did not establish enough bibliographic detail for a public citation." }
    ],
    preservation: {
      architecture: ["ARCHITECTURE.md", "docs/architecture.md", "docs/adr/"],
      runbooks: ["docs/*runbook*.md"],
      source_contracts: ["ontology/", "site/**/*.schema.json"],
      tests: ["test/", "worker/test/"],
      fixtures: ["test/fixtures/"],
      generators: ["tools/build_*.mjs"],
      receipts: ["docs/evidence/", "warehouse/receipts/proof/"],
      mt7_evidence: ["architecture/evidence.d/cityscroll-merge-throughput--mt-7-architecture-evidence-shards.json", "architecture/evidence.d/"]
    },
    served_artifact_baseline: { paths: ["site/", "worker/"], ...served, expected_after_sha256: served.sha256 },
    history_treatment: "none; this is a tip-level placement change"
  };
}

function verifyCurrent(receipt) {
  const errors = [];
  const publicExtensions = new Set([".md", ".json", ".html"]);
  for (const path of tracked()) {
    if (!publicExtensions.has(extname(path)) || !existsSync(resolve(ROOT, path))) continue;
    const content = readFileSync(resolve(ROOT, path), "utf8");
    if (content.includes(PRIVATE_MARKER)) errors.push(`${path}: private evidence scheme remains`);
  }
  const scrim = readFileSync(resolve(ROOT, "docs/repository-scrim-review.md"), "utf8");
  if (/^\| PB-\d{4} \|/m.test(scrim)) errors.push("raw scrim inventory rows remain");
  if (receipt.private_inventory.scrim_review.row_count !== 1144) errors.push("scrim receipt does not cover 1,144 rows");
  if (receipt.private_inventory.document_count !== 51) errors.push("private-reference document inventory is incomplete");
  if (receipt.private_inventory.reference_count !== 2644) errors.push("private-reference occurrence inventory is incomplete");
  for (const path of ["ARCHITECTURE.md", "docs/architecture.md", "tools/architecture_evidence_shards.mjs", "architecture/evidence.d/cityscroll-merge-throughput--mt-7-architecture-evidence-shards.json"]) {
    if (!existsSync(resolve(ROOT, path))) errors.push(`${path}: retained proof missing`);
  }
  const currentRows = tracked().filter((path) => path.startsWith("site/") || path.startsWith("worker/")).map((path) => {
    const oid = execFileSync("git", ["hash-object", "--", path], { cwd: ROOT, encoding: "utf8" }).trim();
    return `${path}\0${oid}\n`;
  });
  if (sha(currentRows.join("")) !== receipt.served_artifact_baseline.expected_after_sha256) errors.push("served site/worker artifacts changed");
  if (errors.length) throw new Error(errors.join("\n"));
}

const expected = buildReceipt();
if (process.argv.includes("--write")) writeFileSync(OUTPUT, `${JSON.stringify(expected, null, 2)}\n`);
if (!existsSync(OUTPUT)) throw new Error("missing evidence placement receipt; run with --write");
const actual = JSON.parse(readFileSync(OUTPUT, "utf8"));
if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("evidence placement receipt is stale; run with --write");
verifyCurrent(actual);
console.log(`RCP-03 evidence placement verified: ${actual.private_inventory.scrim_review.row_count} review rows, ${actual.private_inventory.reference_count} private references, served artifacts unchanged`);
