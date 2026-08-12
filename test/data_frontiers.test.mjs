// Data-frontiers per-entry store + generated markdown projection.
//
//   node --test test/data_frontiers.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  parseMarkdownTable,
  tableRowToEntry,
  renderRankedTable,
  renderFrontiersMarkdown,
  splitFrontiersMarkdown,
  loadFrontierEntries,
  writeFrontierEntries,
  gapIdFromCell,
  frontierEntryFilename,
  buildFrontiersProjection,
  FRONTIER_ENTRY_SCHEMA,
} from "../tools/lib/data_frontiers.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECTION = join(ROOT, "docs/data-frontiers-2026-08.md");
const ENTRIES = join(ROOT, "docs/data-frontiers/2026-08/entries");

test("gapIdFromCell prefers backtick inventory tokens", () => {
  assert.equal(
    gapIdFromCell("**RC-1** `procurement-planning-budget` — planning budget"),
    "procurement-planning-budget",
  );
  assert.equal(
    gapIdFromCell("`money-location-residual` **(new)** — 212 awards"),
    "money-location-residual",
  );
});

test("parse + render table is a pure projection of entries", () => {
  const sample = `| Rank | Gap inventory row | Source and access mechanics | Join feasibility | Reader value | Effort | Disposition |
|---:|---|---|---|---|---|---|
| 1 | **RC-1** \`procurement-planning-budget\` — plan | Source A | **Measured:** 0/1 | **5** — Money | **Scrape** | **Ready to card.** |
| 2 | \`other-gap\` — tail | Source B | **Blocked.** | **2** | **API pull** | Monitor only. |
`;
  const rows = parseMarkdownTable(sample);
  assert.equal(rows.length, 2);
  const entries = rows.map((r, i) => tableRowToEntry(r, i));
  assert.equal(entries[0].id, "procurement-planning-budget");
  assert.equal(entries[0].rc, "RC-1");
  assert.equal(entries[0].schema, FRONTIER_ENTRY_SCHEMA);
  const rendered = renderRankedTable(entries);
  const again = parseMarkdownTable(rendered).map((r, i) => tableRowToEntry(r, i));
  assert.deepEqual(
    again.map((e) => ({
      id: e.id,
      rank: e.rank,
      disposition: e.disposition,
      gap_inventory_row: e.gap_inventory_row,
    })),
    entries.map((e) => ({
      id: e.id,
      rank: e.rank,
      disposition: e.disposition,
      gap_inventory_row: e.gap_inventory_row,
    })),
  );
});

test("repo projection matches entries (pure projection check)", () => {
  assert.ok(existsSync(ENTRIES), "per-entry frontier records must exist");
  const entries = loadFrontierEntries(ENTRIES);
  assert.equal(entries.length, 33);
  const result = buildFrontiersProjection(ROOT, "2026-08", { check: true });
  assert.equal(result.checked, true);
  assert.equal(result.entries.length, 33);
  // Table section alone is a pure projection of entries
  const md = readFileSync(PROJECTION, "utf8");
  const { tableMarkdown } = splitFrontiersMarkdown(md);
  assert.equal(tableMarkdown, renderRankedTable(entries));
});

test("two entry updates touch different files (merge-parallel safe)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cs-frontiers-"));
  const entriesDir = join(dir, "entries");
  const entries = [
    {
      schema: FRONTIER_ENTRY_SCHEMA,
      id: "gap-alpha",
      rank: 1,
      gap_inventory_row: "`gap-alpha` — a",
      source_and_access: "A",
      join_feasibility: "Measured",
      reader_value: "5",
      effort: "API pull",
      disposition: "Open",
    },
    {
      schema: FRONTIER_ENTRY_SCHEMA,
      id: "gap-beta",
      rank: 2,
      gap_inventory_row: "`gap-beta` — b",
      source_and_access: "B",
      join_feasibility: "Blocked",
      reader_value: "3",
      effort: "Scrape",
      disposition: "Open",
    },
  ];
  writeFrontierEntries(entriesDir, entries);
  const alpha = frontierEntryFilename(entries[0]);
  const beta = frontierEntryFilename(entries[1]);
  const alphaBefore = readFileSync(join(entriesDir, alpha));
  const betaBefore = readFileSync(join(entriesDir, beta));

  // Crank A updates alpha disposition only
  const aDir = join(dir, "a/entries");
  mkdirSync(aDir, { recursive: true });
  for (const name of readdirSync(entriesDir)) {
    writeFileSync(join(aDir, name), readFileSync(join(entriesDir, name)));
  }
  const aEntries = loadFrontierEntries(aDir);
  aEntries[0].disposition = "Landed";
  writeFileSync(join(aDir, alpha), `${JSON.stringify(aEntries[0], null, 2)}\n`);

  // Crank B updates beta disposition only
  const bDir = join(dir, "b/entries");
  mkdirSync(bDir, { recursive: true });
  for (const name of readdirSync(entriesDir)) {
    writeFileSync(join(bDir, name), readFileSync(join(entriesDir, name)));
  }
  const bEntries = loadFrontierEntries(bDir);
  bEntries[1].disposition = "Stopped";
  writeFileSync(join(bDir, beta), `${JSON.stringify(bEntries[1], null, 2)}\n`);

  assert.notEqual(readFileSync(join(aDir, alpha)).toString(), alphaBefore.toString());
  assert.equal(readFileSync(join(aDir, beta)).toString(), betaBefore.toString());
  assert.equal(readFileSync(join(bDir, alpha)).toString(), alphaBefore.toString());
  assert.notEqual(readFileSync(join(bDir, beta)).toString(), betaBefore.toString());

  // Merge both entry files into one dir and rebuild markdown — no conflict surface
  const mergedDir = join(dir, "merged/entries");
  mkdirSync(mergedDir, { recursive: true });
  writeFileSync(join(mergedDir, alpha), readFileSync(join(aDir, alpha)));
  writeFileSync(join(mergedDir, beta), readFileSync(join(bDir, beta)));
  const merged = loadFrontierEntries(mergedDir);
  assert.equal(merged.find((e) => e.id === "gap-alpha").disposition, "Landed");
  assert.equal(merged.find((e) => e.id === "gap-beta").disposition, "Stopped");
  const md = renderFrontiersMarkdown(
    { before: "# Frontiers\n\n## Ranked frontier table\n\n", after: "\n## Done\n" },
    merged,
  );
  assert.match(md, /Landed/);
  assert.match(md, /Stopped/);
});

test("build_data_frontiers --check passes in the repo", () => {
  const result = spawnSync(
    process.execPath,
    [join(ROOT, "tools/build_data_frontiers.mjs"), "--check"],
    { encoding: "utf8", cwd: ROOT },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
